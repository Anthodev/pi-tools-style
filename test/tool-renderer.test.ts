import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initTheme, type Theme, type ToolInfo, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { BashExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createToolRendererResolver,
	getToolPresentationCatalog,
	initializeToolRendererEnabled,
	isToolRendererEnabled,
	invalidateToolPresentations,
	setToolRendererEnabled,
	setToolRendererImplementation,
	type ToolRendererImplementation,
	type ToolChildBounds,
} from "../src/tool-renderer.ts";
import type { ToolContext, ToolSnapshot, ToolView } from "../src/tool-presentation.ts";
import { isWebSearchTool } from "../src/web-search-presentation.ts";
import { installToolsStyle } from "../index.ts";
import { uninstallShellRenderer } from "../src/render-decorator.ts";
import { ExtensionRunner } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { loadSettings, saveSettings } from "../src/settings.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const result = { content: [{ type: "text" as const, text: "RESULT_ONLY_MARKER" }], details: {} };
function context(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		args: { value: "arg" }, toolCallId: "same-id", state: {}, lastComponent: undefined,
		invalidate: vi.fn(), cwd: process.cwd(), executionStarted: false, argsComplete: true,
		isPartial: true, expanded: false, showImages: true, isError: false, durationMs: undefined,
		outputPad: 1, ...overrides,
	};
}
function info(name: string, path: string, source = "builtin"): ToolInfo {
	return { name, sourceInfo: { path, source }, namespace: { name: "mcp__docs" } } as ToolInfo;
}
function resolve(name: string, downstream?: ToolRenderers, tools: ToolInfo[] = []) {
	const next = vi.fn(() => downstream);
	const renderers = createToolRendererResolver({ getAllTools: () => tools })(name, next)!;
	expect(next).toHaveBeenCalledOnce();
	return renderers;
}
function fragments(renderers: ToolRenderers, ctx = context()) {
	const call = renderers.renderCall!(ctx.args, theme, ctx);
	const final = { ...ctx, isPartial: false };
	const output = renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, final);
	return { call, output, ctx };
}
const mouse = (width: number, height: number, x = 1, y = 0): TuiMouseEvent => ({
	type: "press", button: "left", x, y, screenX: 20 + x, screenY: 30 + y,
	width, height, shift: false, alt: false, ctrl: false,
});


let configDirectory: string;
let configPath: string;
beforeEach(async () => {
	configDirectory = await mkdtemp(join(tmpdir(), "tools-style-renderer-"));
	configPath = join(configDirectory, "settings.json");
	await loadSettings(configPath);
});
afterEach(async () => {
	await loadSettings(join(configDirectory, "missing.json"));
	await rm(configDirectory, { recursive: true, force: true });
});
beforeEach(() => { initTheme("dark", false); setToolRendererImplementation(undefined); setToolRendererEnabled(true); });
afterEach(() => { setToolRendererImplementation(undefined); setToolRendererEnabled(true); });

describe("public renderer facades", () => {
	it("keeps unknown facades stable even when installed OFF", () => {
		setToolRendererEnabled(false);
		const renderer = resolve("unknown");
		expect(renderer.renderShell).toBe("self");
		const { call, output, ctx } = fragments(renderer);
		expect(renderer.renderCall!(ctx.args, theme, ctx)).toBe(call);
		expect(renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx)).toBe(output);
		setToolRendererEnabled(true);
		expect(output.render(80).join("\n")).toContain("RESULT_ONLY_MARKER");
	});

	it("does not mistake tool names for native provenance or touch third-party self renderers", () => {
		const self = { renderShell: "self" as const, renderCall: () => new Text("SELF", 0, 0) };
		expect(resolve("read", self, [info("read", "/extension.ts", "extension")])).toBe(self);
		expect(resolve("mcp__docs__read", self, [info("mcp__docs__read", "/extension.ts", "extension")])).toBe(self);
		expect(resolve("mcp__docs__read", self)).toBe(self);
		expect(resolve("read_mcp_resource", self)).toBe(self);
		expect(resolve("read", self, [info("read", "builtin:read")])).not.toBe(self);
		expect(resolve("web_search", self, [info("web_search", "/extension.ts", "extension")])).not.toBe(self);
	});

	it("keys persistent fragments by state, not by toolCallId", () => {
		const renderer = resolve("unknown");
		const first = context();
		const second = context();
		expect(renderer.renderCall!(first.args, theme, first)).not.toBe(renderer.renderCall!(second.args, theme, second));
		expect(renderer.renderCall!(first.args, theme, first)).toBe(renderer.renderCall!(first.args, theme, first));
	});
});

describe("public middleware registration order", () => {
	const sessions: Array<{ shutdown(): void }> = [];
	afterEach(() => {
		for (const session of sessions) session.shutdown();
		sessions.length = 0;
		uninstallShellRenderer(BashExecutionComponent);
	});
	function plugin(toolName: string) {
		const registered: ToolRendererResolver[] = [];
		const getAllTools = vi.fn(() => [info(toolName, "/fixture-provider.ts", "extension")]);
		const installation = installToolsStyle({
			registerToolRenderer: (resolver: ToolRendererResolver) => registered.push(resolver),
			getAllTools,
		} as never);
		sessions.push(installation.session);
		expect(registered).toHaveLength(1);
		return { resolver: registered[0]!, getAllTools };
	}
	function ordered(toolName: string, resolvers: readonly ToolRendererResolver[], base: () => ToolRenderers | undefined) {
		// Execute the pinned SDK's actual load-order algorithm, not a second chain implementation.
		const runner = { extensions: resolvers.map((resolver) => ({ toolRenderers: [resolver] })) };
		return ExtensionRunner.prototype.resolveToolRenderers.call(runner as never, toolName, base)!;
	}
	function renderResolved(renderer: ToolRenderers) {
		const ctx = context({ args: { query: "ORDER_QUERY" }, isPartial: false });
		const call = renderer.renderCall!(ctx.args, piTheme, ctx);
		const output = renderer.renderResult!(
			{ content: [{ type: "text", text: "ORDER_WEB_RESPONSE" }], details: {} },
			{ expanded: false, isPartial: false }, piTheme, ctx,
		);
		return { call, output, rows: () => call.render(100).concat(output.render(100)) };
	}
	it("keeps an authoritative non-web middleware before the plugin untouched", () => {
		const installed = plugin("custom_non_web");
		const authoritative: ToolRenderers = {
			renderShell: "self",
			renderCall: () => new Text("AUTHORITATIVE_NONWEB_CALL", 0, 0),
			renderResult: () => new Text("AUTHORITATIVE_NONWEB_RESULT", 0, 0),
		};
		const before = vi.fn<ToolRendererResolver>(() => authoritative);
		const base = vi.fn(() => undefined);
		const resolved = ordered("custom_non_web", [before, installed.resolver], base);
		expect(resolved).toBe(authoritative);
		expect(installed.getAllTools).not.toHaveBeenCalled();
		expect(base).not.toHaveBeenCalled();
		const rendered = renderResolved(resolved).rows().join("\n");
		expect(rendered).toContain("AUTHORITATIVE_NONWEB_CALL");
		expect(rendered).toContain("AUTHORITATIVE_NONWEB_RESULT");
		expect(rendered).not.toContain("╭");
	});
	it("lets the web exception override an opaque self renderer after the plugin", () => {
		const installed = plugin("web_search");
		const provider: ToolRenderers = {
			renderShell: "self",
			renderCall: vi.fn(() => new Text("OPAQUE_WEB_CALL", 0, 0)),
			renderResult: vi.fn(() => new Text("OPAQUE_WEB_RESULT", 0, 0)),
		};
		const after = vi.fn<ToolRendererResolver>(() => provider);
		const base = vi.fn(() => undefined);
		const resolved = ordered("web_search", [installed.resolver, after], base);
		expect(after).toHaveBeenCalledOnce();
		expect(base).not.toHaveBeenCalled();
		expect(resolved).not.toBe(provider);
		const rendered = renderResolved(resolved);
		expect(rendered.rows().join("\n")).toContain("Web Search");
		expect(rendered.rows().join("\n")).toContain("ORDER_WEB_RESPONSE");
		expect(rendered.rows().join("\n")).not.toContain("OPAQUE_WEB");
		expect(provider.renderCall).not.toHaveBeenCalled();
		expect(provider.renderResult).not.toHaveBeenCalled();
		setToolRendererEnabled(false);
		expect(rendered.rows().join("\n")).toContain("OPAQUE_WEB_CALL");
		expect(rendered.rows().join("\n")).toContain("OPAQUE_WEB_RESULT");
	});
	it("produces the same web result when an earlier web middleware cooperates by returning next()", () => {
		const installed = plugin("web_search");
		const provider: ToolRenderers = {
			renderShell: "self",
			renderCall: () => new Text("DELEGATED_WEB_CALL", 0, 0),
			renderResult: () => new Text("DELEGATED_WEB_RESULT", 0, 0),
		};
		const before = vi.fn<ToolRendererResolver>((_toolName, next) => next() ?? provider);
		const base = vi.fn(() => provider);
		const resolved = ordered("web_search", [before, installed.resolver], base);
		expect(before).toHaveBeenCalledOnce();
		expect(base).toHaveBeenCalledOnce();
		expect(resolved).not.toBe(provider);
		const rendered = renderResolved(resolved);
		const webRows = rendered.rows();
		expect(webRows.join("\n")).toContain("Web Search");
		expect(webRows.join("\n")).toContain("ORDER_WEB_RESPONSE");
		expect(webRows.join("\n")).not.toContain("DELEGATED_WEB");
		const after = (_toolName: string, _next: () => ToolRenderers | undefined) => provider;
		const afterResolved = ordered("web_search", [installed.resolver, after], () => undefined);
		expect(renderResolved(afterResolved).rows()).toEqual(webRows);
		setToolRendererEnabled(false);
		expect(rendered.rows().join("\n")).toContain("DELEGATED_WEB_CALL");
		expect(rendered.rows().join("\n")).toContain("DELEGATED_WEB_RESULT");
	});
});

describe("native callback ownership", () => {
	it("captures downstream callbacks and invokes them without a receiver, just like Pi", () => {
		const downstream: ToolRenderers = {
			renderCall: function (this: unknown) { expect(this).toBeUndefined(); return new Text("ORIGINAL_CALL", 0, 0); },
			renderResult: function (this: unknown) { expect(this).toBeUndefined(); return new Text("ORIGINAL_RESULT", 0, 0); },
		};
		const renderer = resolve("third", downstream);
		downstream.renderCall = () => new Text("REPLACEMENT_CALL", 0, 0);
		downstream.renderResult = () => new Text("REPLACEMENT_RESULT", 0, 0);
		const { call, output } = fragments(renderer);
		expect(call.render(80).join("\n")).toContain("ORIGINAL_CALL");
		expect(output.render(80).join("\n")).toContain("ORIGINAL_RESULT");
	});

	it("keeps an empty native Box empty instead of adding padding or fictitious result content", () => {
		const empty = { render: vi.fn(() => []), invalidate: vi.fn() };
		const { call, output } = fragments(resolve("third", { renderCall: () => empty, renderResult: () => empty }));
		expect(call.render(80)).toEqual([]);
		expect(output.render(80)).toEqual([]);
	});

	it("renders the full undefined native result independently, including long arguments and all output", () => {
		const renderer = resolve("unknown");
		const ctx = context({ args: { long: "x".repeat(150) }, isPartial: false });
		const output = renderer.renderResult!({ content: [{ type: "text", text: Array.from({ length: 15 }, (_, i) => `L${i}`).join("\n") }], details: {} }, { expanded: false, isPartial: false }, theme, ctx);
		expect(output.render(80).join("\n")).toContain("L14");
		expect(output.render(80).join("\n")).toContain("long");
		expect(output.render(80).join("\n")).not.toContain("more lines");
		expect(renderer.renderCall!(ctx.args, theme, ctx).render(80)).toEqual([]);
	});

	it("constructs callbacks lazily and renders each child once for both fragments", () => {
		const callChild = { render: vi.fn(() => ["CALL"]), invalidate: vi.fn() };
		const resultChild = { render: vi.fn(() => ["RESULT"]), invalidate: vi.fn() };
		const renderCall = vi.fn(() => callChild);
		const renderResult = vi.fn(() => resultChild);
		const { call, output } = fragments(resolve("third", { renderCall, renderResult }));
		expect(renderCall).not.toHaveBeenCalled();
		expect(renderResult).not.toHaveBeenCalled();
		expect(output.render(80).join("\n")).toContain("RESULT");
		expect(output.render(80).join("\n")).not.toContain("CALL");
		expect(call.render(80).join("\n")).toContain("CALL");
		call.render(80);
		expect(callChild.render).toHaveBeenCalledExactlyOnceWith(78);
		expect(resultChild.render).toHaveBeenCalledExactlyOnceWith(78);
	});

	it("renders a single shared call/result child once and reuses its rows for both fragments", () => {
		const shared = { render: vi.fn(() => ["SHARED_CHILD"]), invalidate: vi.fn() };
		const renderCall = vi.fn(() => shared);
		const renderResult = vi.fn(() => shared);
		const { call, output } = fragments(resolve("third", { renderCall, renderResult }));
		const callRows = call.render(80);
		const resultRows = output.render(80);
		expect(shared.render).toHaveBeenCalledExactlyOnceWith(78);
		expect(callRows.join("\n")).toContain("SHARED_CHILD");
		expect(resultRows.join("\n")).toContain("SHARED_CHILD");
	});

	it("retains a separate native state and native lastComponent identities across updates", () => {
		const seenCall: ToolContext[] = [];
		const seenResult: ToolContext[] = [];
		const nativeCall = new Text("CALL", 0, 0);
		const nativeResult = new Text("RESULT", 0, 0);
		const renderer = resolve("third", {
			renderCall: (_args, _theme, ctx) => { seenCall.push(ctx); ctx.state.callSeen = true; return nativeCall; },
			renderResult: (_result, _options, _theme, ctx) => { seenResult.push(ctx); expect(ctx.state.callSeen).toBe(true); return nativeResult; },
		});
		const { call, output, ctx } = fragments(renderer);
		call.render(80); output.render(80);
		renderer.renderCall!({ updated: true }, theme, { ...ctx, args: { updated: true }, lastComponent: call });
		renderer.renderResult!(result, { expanded: true, isPartial: false }, theme, { ...ctx, expanded: true, lastComponent: output });
		call.render(80);
		expect(seenCall[0]!.state).not.toBe(ctx.state);
		expect(seenCall[0]!.state).toBe(seenResult[0]!.state);
		expect(seenCall.at(-1)!.lastComponent).toBe(nativeCall);
		expect(seenResult.at(-1)!.lastComponent).toBe(nativeResult);
		expect(seenResult.at(-1)!.expanded).toBe(true);
	});

	it("forwards native invalidation and rebuilds dirty slots without changing facade identity", () => {
		let nativeContext: ToolContext;
		const renderCall = vi.fn((_args, _theme, ctx: ToolContext) => { nativeContext = ctx; return new Text("CALL", 0, 0); });
		const renderer = resolve("third", { renderCall });
		const ctx = context();
		const call = renderer.renderCall!(ctx.args, theme, ctx);
		call.render(80);
		nativeContext!.invalidate();
		expect(ctx.invalidate).toHaveBeenCalledOnce();
		call.render(80);
		expect(renderCall).toHaveBeenCalledTimes(2);
		expect(renderer.renderCall!(ctx.args, theme, ctx)).toBe(call);
	});

	it("falls back independently after a callback throws, resetting only that lastComponent", () => {
		let fail = false;
		const contexts: ToolContext[] = [];
		const resultContexts: ToolContext[] = [];
		const nativeCall = new Text("CUSTOM_CALL", 0, 0);
		const nativeResult = new Text("CUSTOM_RESULT", 0, 0);
		const renderer = resolve("third", {
			renderCall: (_args, _theme, ctx) => { contexts.push(ctx); if (fail) throw Error("slot"); return nativeCall; },
			renderResult: (_result, _options, _theme, ctx) => { resultContexts.push(ctx); return nativeResult; },
		});
		const { call, output, ctx } = fragments(renderer);
		call.render(80); fail = true;
		renderer.renderCall!(ctx.args, theme, ctx);
		renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx);
		expect(call.render(80).join("\n")).toContain('third value="arg"');
		expect(output.render(80).join("\n")).toContain("CUSTOM_RESULT");
		fail = false;
		renderer.renderCall!(ctx.args, theme, ctx); call.render(80);
		expect(contexts.at(-1)!.lastComponent).toBeUndefined();
		expect(resultContexts.at(-1)!.lastComponent).toBe(nativeResult);
	});

	it("preserves direct terminal-image sequences without a second render or added padding", () => {
		for (const sequence of ["\x1b_GIMAGE\x1b\\", "\x1b]1337;File=IMAGE\x07", "\x1bPqIMAGE\x1b\\"]) {
			const child = { render: vi.fn(() => [sequence]), invalidate: vi.fn() };
			const renderer = resolve("third", { renderCall: () => child });
			const ctx = context();
			const call = renderer.renderCall!(ctx.args, theme, ctx);
			expect(call.render(80)).toEqual([sequence]);
			expect(child.render).toHaveBeenCalledTimes(1);
		}
	});
});

function semanticImplementation(snapshots: ToolSnapshot[], child?: Component): ToolRendererImplementation {
	return {
		createToolView: (_name, snapshot) => {
			snapshots.push(snapshot);
			return { layout: "inline", head: { title: snapshot.presentation, target: "", meta: [], status: "done" }, expanded: snapshot.context.expanded,
				sections: child ? [{ component: child, slot: "result" }] : [] };
		},
		layoutToolView: (view, _snapshot, _theme, width) => {
			const callRows = [view.head.title];
			const resultRows: string[] = [];
			const callChildBounds: ToolChildBounds[] = [];
			const resultChildBounds: ToolChildBounds[] = [];
			for (const section of view.sections) {
				const rows = section.component.render(width);
				const targetRows = section.slot === "call" ? callRows : resultRows;
				const bounds = { component: section.component, x: 0, y: targetRows.length, width, height: rows.length };
				(section.slot === "call" ? callChildBounds : resultChildBounds).push(bounds);
				targetRows.push(...rows);
			}
			return { callRows, resultRows, callChildBounds, resultChildBounds, callOffset: 0, resultOffset: callRows.length };
		},
	};
}

describe("semantic integration boundary", () => {
	it("retains first confirmed provenance and promotes hashed MCP web rows permanently", () => {
		const tools = [info("mcp__hashed", "builtin:mcp")];
		const snapshots: ToolSnapshot[] = [];
		const recognize = vi.fn((name: string, metadata: ToolInfo | undefined, details: unknown) => isWebSearchTool(name, metadata, details, []));
		setToolRendererImplementation({ ...semanticImplementation(snapshots), isWebSearchTool: recognize });
		const renderer = resolve("mcp__hashed", { renderCall: () => new Text("NATIVE", 0, 0) }, tools);
		const ctx = context();
		const call = renderer.renderCall!(ctx.args, theme, ctx);
		expect(call.render(80)[0]).toBe("mcp");
		tools[0] = info("mcp__hashed", "/new-extension.ts", "extension");
		renderer.renderResult!({ ...result, details: { server: "docs", tool: "web_search" } }, { expanded: false, isPartial: false }, theme, ctx);
		expect(call.render(80)[0]).toBe("web");
		recognize.mockClear();
		renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx);
		expect(call.render(80)[0]).toBe("web");
		expect(recognize).toHaveBeenCalledOnce();
		expect(recognize.mock.calls[0]![2]).toBe(result.details);
		renderer.renderCall!(ctx.args, theme, ctx);
		expect(recognize).toHaveBeenCalledTimes(2);
		expect(recognize.mock.calls[1]![1]!.sourceInfo.path).toBe("builtin:mcp");
		expect(call.render(80)[0]).toBe("web");
		expect(snapshots.at(-1)!.toolInfo!.sourceInfo.path).toBe("builtin:mcp");
		setToolRendererEnabled(false);
		expect(call.render(80).join("\n")).toContain("NATIVE");
	});

	it("enriches unresolved MCP at callbacks but never makes an extension definition native", () => {
		const tools: ToolInfo[] = [];
		const snapshots: ToolSnapshot[] = [];
		setToolRendererImplementation(semanticImplementation(snapshots));
		const renderer = resolve("mcp__docs__lookup", {}, tools);
		const ctx = context();
		const call = renderer.renderCall!(ctx.args, theme, ctx);
		expect(call.render(80)[0]).toBe("mcp-unresolved");
		tools.push(info("mcp__docs__lookup", "/extension.ts", "extension"));
		renderer.renderCall!(ctx.args, theme, ctx);
		expect(call.render(80)[0]).toBe("generic");
	});

	it("confirms an unresolved historical MCP row once metadata arrives at its result callback", () => {
		const tools: ToolInfo[] = [];
		const snapshots: ToolSnapshot[] = [];
		setToolRendererImplementation(semanticImplementation(snapshots));
		const renderer = resolve("mcp__docs__lookup", undefined, tools);
		const ctx = context();
		const call = renderer.renderCall!(ctx.args, theme, ctx);
		expect(call.render(80)[0]).toBe("mcp-unresolved");
		tools.push(info("mcp__docs__lookup", "builtin:mcp"));
		renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx);
		expect(call.render(80)[0]).toBe("mcp");
		expect(snapshots.at(-1)!.toolInfo!.sourceInfo.path).toBe("builtin:mcp");
	});

	for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
		it(`classifies confirmed resource ${name} as MCP, never as web`, () => {
			setToolRendererImplementation(semanticImplementation([]));
			const renderer = resolve(name, {}, [info(name, "builtin:mcp")]);
			const { call } = fragments(renderer);
			expect(call.render(80)[0]).toBe("mcp");
		});
	}

	it("updates previously activated native renderers while hidden so final callbacks can stop animations", () => {
		let running = false;
		const renderer = resolve("read", { renderCall: (_args, _theme, ctx) => { running = ctx.isPartial; return new Text("NATIVE", 0, 0); } }, [info("read", "builtin:read")]);
		const ctx = context();
		const call = renderer.renderCall!(ctx.args, theme, ctx);
		call.render(80); expect(running).toBe(true);
		setToolRendererImplementation(semanticImplementation([]));
		expect(call.render(80)[0]).toBe("builtin");
		renderer.renderCall!(ctx.args, theme, { ...ctx, isPartial: false });
		expect(running).toBe(false);
	});

	it("retains the semantic view across width changes but evicts derived preparation for real fragment invalidation", () => {
		const preparations = new WeakMap<object, Component>();
		let environmentRevision = 0;
		const factory = vi.fn((_name: string, snapshot: ToolSnapshot): ToolView => {
			let child = preparations.get(snapshot.context.state);
			if (!child) {
				child = new Text(`PREPARED_ENV_${environmentRevision} ${"wide ".repeat(12)}`, 0, 0);
				preparations.set(snapshot.context.state, child);
			}
			return { layout: "inline", head: { title: "READ", target: "", meta: [], status: "done" }, sections: [{ component: child, slot: "result" }], expanded: false };
		});
		const evict = vi.fn((state: object) => { preparations.delete(state); });
		const implementation = semanticImplementation([]);
		setToolRendererImplementation({ ...implementation, createToolView: factory, invalidateToolView: evict });
		const { call, output, ctx } = fragments(resolve("read", {}, [info("read", "builtin:read")]));
		expect(output.render(80).join("\n")).toContain("PREPARED_ENV_0");
		call.render(80);
		expect(factory).toHaveBeenCalledOnce();
		const narrow = output.render(24);
		expect(narrow.join("\n")).toContain("PREPARED_ENV_0");
		expect(narrow.length).toBeGreaterThan(output.render(80).length);
		expect(factory).toHaveBeenCalledOnce();
		environmentRevision = 1;
		output.invalidate();
		expect(evict).toHaveBeenCalledWith(ctx.state);
		expect(output.render(80).join("\n")).toContain("PREPARED_ENV_1");
		expect(output.render(80).join("\n")).not.toContain("PREPARED_ENV_0");
		call.render(80);
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it("routes result-fragment coordinates through public MouseRegion to the real child", () => {
		const handleMouse = vi.fn(() => ({ handled: true, focus: true, capture: true }));
		const child = { render: () => ["INTERACTIVE"], invalidate: vi.fn(), handleMouse, handleInput: vi.fn() };
		setToolRendererImplementation(semanticImplementation([], child));
		const { call, output } = fragments(resolve("read", {}, [info("read", "builtin:read")]));
		call.render(80); const rows = output.render(80);
		const dispatch = output.handleMouse!(mouse(80, rows.length)) as { target: { component: Component }; focusTarget: Component };
		expect(dispatch.target.component).toBe(child);
		expect(dispatch.focusTarget).toBe(child);
		expect(handleMouse).toHaveBeenCalledWith(mouse(80, 1));
		expect("handleInput" in output).toBe(false);
	});

	it("reverts to native for failed semantic construction/layout and too-narrow frames", () => {
		const render = vi.fn(() => ["NATIVE"]);
		const renderer = resolve("read", { renderCall: () => ({ render, invalidate() {} }) }, [info("read", "builtin:read")]);
		const ctx = context();
		const call = renderer.renderCall!(ctx.args, theme, ctx);
		const implementation = semanticImplementation([]);
		setToolRendererImplementation({ ...implementation, createToolView: () => { throw Error("view"); } });
		expect(call.render(80).join("\n")).toContain("NATIVE");
		setToolRendererImplementation({ ...implementation, layoutToolView: () => { throw Error("layout"); } });
		expect(call.render(80).join("\n")).toContain("NATIVE");
		const layoutToolView = vi.fn(implementation.layoutToolView);
		setToolRendererImplementation({ ...implementation, createToolView: (...args) => ({ ...implementation.createToolView(...args), layout: "framed" }), layoutToolView });
		call.render(4);
		expect(layoutToolView).not.toHaveBeenCalled();
		expect(render).toHaveBeenLastCalledWith(2);
	});
});

describe("active native Edit/Write expansion", () => {
	for (const name of ["edit", "write"]) {
		it(`${name} starts open, honors local clicks and subsequent global transitions, then follows final public state`, () => {
			const snapshots: ToolSnapshot[] = [];
			setToolRendererImplementation(semanticImplementation(snapshots));
			const renderer = resolve(name, {}, [info(name, `builtin:${name}`)]);
			const ctx = context();
			const call = renderer.renderCall!(ctx.args, theme, ctx);
			call.render(80);
			expect(snapshots.at(-1)!.context.expanded).toBe(true);
			const click = { ...mouse(80, 1), type: "click" as const };
			expect(call.handleMouse!(click)).toEqual({ handled: true });
			call.render(80);
			expect(snapshots.at(-1)!.context.expanded).toBe(false);
			const active = { ...ctx, executionStarted: true };
			renderer.renderCall!(ctx.args, theme, active);
			renderer.renderResult!(result, { expanded: false, isPartial: true }, theme, active);
			call.render(80);
			expect(snapshots.at(-1)!.context.expanded).toBe(false);
			renderer.renderCall!(ctx.args, theme, { ...active, expanded: true });
			call.render(80);
			expect(snapshots.at(-1)!.context.expanded).toBe(true);
			renderer.renderCall!(ctx.args, theme, { ...active, expanded: false });
			call.render(80);
			expect(snapshots.at(-1)!.context.expanded).toBe(false);
			renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, { ...active, isPartial: false });
			call.render(80);
			expect(snapshots.at(-1)!.context.expanded).toBe(false);
			expect(call.handleMouse!(click)).toBeUndefined();
			renderer.renderResult!(result, { expanded: true, isPartial: false }, theme, { ...active, expanded: true, isPartial: false });
			call.render(80);
			expect(snapshots.at(-1)!.context.expanded).toBe(true);
		});
	}

	it("keeps original native OFF context values despite semantic auto-opening", () => {
		const nativeContexts: ToolContext[] = [];
		const renderer = resolve("edit", { renderCall: (_args, _theme, ctx) => { nativeContexts.push(ctx); return new Text("NATIVE", 0, 0); } }, [info("edit", "builtin:edit")]);
		const ctx = context();
		const call = renderer.renderCall!(ctx.args, theme, ctx);
		setToolRendererEnabled(false);
		call.render(80);
		expect(nativeContexts.at(-1)!.expanded).toBe(false);
		const snapshots: ToolSnapshot[] = [];
		setToolRendererImplementation(semanticImplementation(snapshots));
		setToolRendererEnabled(true);
		call.render(80);
		expect(snapshots.at(-1)!.context.expanded).toBe(true);
		expect(nativeContexts.at(-1)!.expanded).toBe(false);
	});

	it("lets a real child consume a click before auto-expanded card handling", () => {
		const snapshots: ToolSnapshot[] = [];
		const child = { render: () => ["CHILD"], invalidate() {}, handleMouse: vi.fn(() => ({ handled: true })) };
		setToolRendererImplementation(semanticImplementation(snapshots, child));
		const renderer = resolve("write", {}, [info("write", "builtin:write")]);
		const ctx = context({ executionStarted: true });
		const call = renderer.renderCall!(ctx.args, theme, ctx);
		const output = renderer.renderResult!(result, { expanded: false, isPartial: true }, theme, ctx);
		call.render(80); output.render(80);
		const dispatch = output.handleMouse!({ ...mouse(80, 1), type: "click" }) as { target: { component: Component } };
		expect(dispatch.target.component).toBe(child);
		expect(snapshots.at(-1)!.context.expanded).toBe(true);
	});

	it("does not auto-open extension definitions named edit or write", () => {
		const snapshots: ToolSnapshot[] = [];
		setToolRendererImplementation(semanticImplementation(snapshots));
		const renderer = resolve("edit", {}, [info("edit", "/extension.ts", "extension")]);
		const ctx = context();
		renderer.renderCall!(ctx.args, theme, ctx).render(80);
		expect(snapshots.at(-1)!.context.expanded).toBe(false);
	});
});

describe("first initialization and established session choices", () => {
	const key = Symbol.for("pi-tools-style:runtime");
	let previous: unknown;
	beforeEach(() => { previous = Reflect.get(globalThis, key); Reflect.deleteProperty(globalThis, key); });
	afterEach(() => { Reflect.set(globalThis, key, previous); vi.unstubAllEnvs(); });

	it("starts disabled from saved global false and does not reload over the process choice", () => {
		vi.stubEnv("PI_TOOLS_STYLE", "");
		initializeToolRendererEnabled(false);
		expect(isToolRendererEnabled()).toBe(false);
		initializeToolRendererEnabled(true);
		expect(isToolRendererEnabled()).toBe(false);
	});
	it("gives initial env-0 priority but an explicit same-value OFF establishes the reload choice", () => {
		vi.stubEnv("PI_TOOLS_STYLE", "0");
		expect(isToolRendererEnabled()).toBe(false);
		setToolRendererEnabled(false);
		vi.stubEnv("PI_TOOLS_STYLE", "");
		initializeToolRendererEnabled(true);
		expect(isToolRendererEnabled()).toBe(false);
	});
	it("preserves an explicit ON under env-0, including after a later OFF-valued load", () => {
		vi.stubEnv("PI_TOOLS_STYLE", "0");
		initializeToolRendererEnabled(true);
		expect(isToolRendererEnabled()).toBe(false);
		setToolRendererEnabled(true);
		initializeToolRendererEnabled(false);
		expect(isToolRendererEnabled()).toBe(true);
	});
	it("does not reevaluate a changed environment after runtime creation", () => {
		vi.stubEnv("PI_TOOLS_STYLE", "");
		expect(isToolRendererEnabled()).toBe(true);
		vi.stubEnv("PI_TOOLS_STYLE", "0");
		initializeToolRendererEnabled(true);
		expect(isToolRendererEnabled()).toBe(true);
	});
	it("treats an existing pre-feature runtime as already initialized on hot upgrade", () => {
		Reflect.set(globalThis, key, { enabled: false, revision: 0, implementation: undefined, presentations: [], shellCompatibility: undefined });
		initializeToolRendererEnabled(true);
		expect(isToolRendererEnabled()).toBe(false);
	});
});

describe("public presentation catalog without tool execution", () => {
	const key = Symbol.for("pi-tools-style:runtime");
	let previous: unknown;
	beforeEach(() => { previous = Reflect.get(globalThis, key); Reflect.deleteProperty(globalThis, key); });
	afterEach(() => { Reflect.set(globalThis, key, previous); });

	it("uses public provenance and availability without claiming generic, masked-native or hidden self support", async () => {
		const hidden = { ...info("hidden_only", "/hidden.ts", "extension"), exposure: "hidden" } as ToolInfo;
		const savedHidden = { ...info("saved_hidden", "/hidden.ts", "extension"), exposure: "hidden" } as ToolInfo;
		await saveSettings({ tools: JSON.parse('{"offline":false,"saved_hidden":false,"__proto__":false,"constructor":true,"tool:colon":true}') }, configPath);
		const catalog = getToolPresentationCatalog([
			info("bash", "builtin:bash"), info("read", "/override.ts", "extension"),
			info("mcp__docs__lookup", "builtin:mcp"), info("web_search", "/web.ts", "extension"),
			info("unobserved_self", "/self.ts", "extension"), hidden, savedHidden,
		]);
		const entry = (name: string) => catalog.find((item) => item.name === name);
		expect(catalog.slice(0, 8).map(({ name }) => name)).toEqual(["bash", "powershell", "read", "edit", "write", "find", "grep", "ls"]);
		expect(entry("bash")).toEqual({ name: "bash", presentation: "builtin", available: true, support: "confirmed" });
		expect(entry("read")).toEqual({ name: "read", presentation: "generic", available: true, support: "conditional" });
		expect(entry("edit")).toEqual({ name: "edit", presentation: "generic", available: false, support: "conditional" });
		expect(entry("mcp__docs__lookup")?.support).toBe("confirmed");
		expect(entry("web_search")?.presentation).toBe("web");
		expect(entry("web_search")?.support).toBe("confirmed");
		expect(entry("unobserved_self")?.support).toBe("conditional");
		expect(entry("hidden_only")).toBeUndefined();
		expect(entry("saved_hidden")).toEqual({ name: "saved_hidden", presentation: "generic", available: false, support: "conditional" });
		for (const name of ["offline", "__proto__", "constructor", "tool:colon"]) {
			expect(entry(name)?.available).toBe(false);
			expect(entry(name)?.support).toBe("conditional");
		}
	});

	it("unions configured offline names and sticky observed web/generic support while public exposure controls availability", async () => {
		const name = "mcp__opaque_catalog";
		const metadata = info(name, "builtin:mcp");
		setToolRendererImplementation(semanticImplementation([]));
		const web = fragments(resolve(name, { renderCall: () => new Text("OPAQUE", 0, 0) }, [metadata]));
		const webRenderer = resolve(name, undefined, [metadata]);
		const ctx = context();
		webRenderer.renderCall!(ctx.args, theme, ctx);
		webRenderer.renderResult!({ ...result, details: { server: "docs", tool: "web_search" } }, { expanded: false, isPartial: false }, theme, ctx);
		webRenderer.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx);
		const owned = fragments(resolve("owned_generic", { renderCall: () => new Text("OWNED", 0, 0) }, [info("owned_generic", "/generic.ts", "extension")]));
		owned.call.render(80); web.call.render(80);
		await saveSettings({ webSearchTools: ["offline_exact_web"] }, configPath);
		const catalog = getToolPresentationCatalog([{ ...info("owned_generic", "/generic.ts", "extension"), exposure: "hidden" } as ToolInfo]);
		expect(catalog.find((entry) => entry.name === name)).toEqual({ name, presentation: "web", available: false, support: "confirmed" });
		expect(catalog.find((entry) => entry.name === "owned_generic")).toEqual({ name: "owned_generic", presentation: "generic", available: false, support: "confirmed" });
		expect(catalog.find((entry) => entry.name === "offline_exact_web")?.support).toBe("conditional");
		expect(catalog.filter((entry) => entry.name === name)).toHaveLength(1);
	});

	it("keeps an opaque third-party self renderer untouched even with an explicit enabled preference", async () => {
		const self: ToolRenderers = { renderShell: "self", renderCall: () => new Text("SELF_UNCHANGED", 0, 0) };
		await saveSettings({ tools: { read: true } }, configPath);
		const metadata = info("read", "/third-party.ts", "extension");
		expect(resolve("read", self, [metadata])).toBe(self);
		invalidateToolPresentations("read");
		expect(getToolPresentationCatalog([metadata]).find(({ name }) => name === "read")?.support).toBe("conditional");
	});
});
