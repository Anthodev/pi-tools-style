import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BashExecutionComponent, ToolExecutionComponent, initTheme, type ToolInfo, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installToolsStyle } from "../index.ts";
import { uninstallShellRenderer } from "../src/render-decorator.ts";
import { createToolRendererResolver, invalidateToolPresentations, setToolRendererEnabled, setToolRendererImplementation, type ToolLayout } from "../src/tool-renderer.ts";
import { loadSettings, saveSettings, setIconMode } from "../src/settings.ts";
import { clearToolSpinners } from "../src/tool-spinner.ts";
import { setThemeProvider } from "../src/tool-category.js";
import { createToolView, type ToolResult } from "../src/tool-presentation.ts";
import type { WebResponse } from "../src/web-search-presentation.ts";
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
// Tests intentionally use Pi's pinned renderer implementation; production imports only package roots.
import { editRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/edit.js";
import { layoutToolView } from "../src/frame.ts";

const ui = () => ({ requestRender: vi.fn() });
function nativeInfo(name: string): ToolInfo {
	return {
		name, description: "Local rendering fixture", parameters: { type: "object", properties: {} },
		exposure: "direct", sourceInfo: { source: "builtin", path: `builtin:${name}`, scope: "temporary", origin: "top-level" },
	} as ToolInfo;
}
function facade(name: string, downstream: ToolRenderers | undefined, tools: ToolInfo[] = []) {
	return createToolRendererResolver({ getAllTools: () => tools })(name, () => downstream)!;
}
function tool(name: string, renderers: ToolRenderers | undefined, args: unknown = { value: "arg" }, outputPad = 1, targetUi = ui()) {
	return new ToolExecutionComponent(name, "same-row", args, { outputPad }, renderers, targetUi as never, process.cwd());
}
function finish(component: ToolExecutionComponent, text = "RESULT_MARKER", isError = false, partial = false) {
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text }], details: { diff: "  1 before\n- 2 removed\n+ 2 added", firstChangedLine: 2 }, isError, durationMs: 1250 }, partial);
}
const plain = (component: Component, width = 80) => component.render(width).map(stripTerminalSequences);

let configDirectory: string;
let configPath: string;
beforeEach(async () => {
	configDirectory = await mkdtemp(join(tmpdir(), "tools-style-components-"));
	configPath = join(configDirectory, "settings.json");
	await loadSettings(configPath);
});
afterEach(async () => {
	await loadSettings(join(configDirectory, "missing.json"));
	await rm(configDirectory, { recursive: true, force: true });
});

beforeEach(() => {
	vi.useFakeTimers(); initTheme("dark", false); clearToolSpinners(); setIconMode("ascii");
	setToolRendererImplementation(undefined); setToolRendererEnabled(true);
	installToolsStyle({ registerToolRenderer: vi.fn(), getAllTools: () => [] } as never);
	setToolRendererImplementation(undefined);
});
afterEach(() => {
	clearToolSpinners(); setThemeProvider(undefined); setToolRendererImplementation(undefined); setToolRendererEnabled(true); setIconMode("ascii"); vi.useRealTimers();
});

describe("exact native restoration on real Pi components", () => {
	for (const width of [24, 80, 120]) for (const outputPad of [0, 1, 2]) {
		it(`restores default Box slots exactly at width=${width}, padding=${outputPad}`, () => {
			const downstream: ToolRenderers = {
				renderCall: () => new Text("CUSTOM_CALL 漢 e\u0301\nCALL_2", 0, 0),
				renderResult: (_result, options) => new Text(`CUSTOM_RESULT\n${options.expanded ? "EXPANDED" : "COLLAPSED"}\nRESULT_2`, 0, 0),
			};
			const decorated = tool("custom", facade("custom", downstream), { value: "arg" }, outputPad);
			const native = tool("custom", downstream, { value: "arg" }, outputPad);
			for (const partial of [true, false]) for (const isError of [false, true]) {
				finish(decorated, "not-the-renderer-content", isError, partial); finish(native, "not-the-renderer-content", isError, partial);
				setToolRendererEnabled(false);
				expect(decorated.render(width)).toEqual(native.render(width));
				setToolRendererEnabled(true);
				expect(decorated.render(width)).toEqual(native.render(width));
			}
			decorated.setExpanded(true); native.setExpanded(true); setToolRendererEnabled(false);
			expect(decorated.render(width)).toEqual(native.render(width));
			expect(plain(decorated, width).join("\n")).toContain("EXPANDED");
		});
	}

	it("restores supported self slots without a Box, including stock edit", () => {
		for (const downstream of [{ renderShell: "self" as const, renderCall: () => new Text("SELF_CALL", 0, 0), renderResult: () => new Text("SELF_RESULT", 0, 0) }, editRenderers]) {
			const args = { path: "/tmp/example.ts", edits: [{ oldText: "before", newText: "after" }] };
			const decorated = tool("edit", facade("edit", downstream, [nativeInfo("edit")]), args, 2);
			const native = tool("edit", downstream, args, 2);
			finish(decorated); finish(native);
			for (const expanded of [false, true]) for (const enabled of [true, false, true]) {
				decorated.setExpanded(expanded); native.setExpanded(expanded); setToolRendererEnabled(enabled);
				expect(decorated.render(80)).toEqual(native.render(80));
			}
		}
	});

	it("switches finalized default and stock-edit self rows ON → exact OFF → ON without reconstruction", () => {
		const defaultRenderer = { renderCall: () => new Text("NATIVE_CALL", 0, 0), renderResult: () => new Text("NATIVE_RESULT", 0, 0) };
		for (const downstream of [defaultRenderer, editRenderers]) {
			const args = { path: "/tmp/example.ts", edits: [{ oldText: "before", newText: "after" }] };
			const decorated = tool("edit", facade("edit", downstream, [nativeInfo("edit")]), args, 2);
			const native = tool("edit", downstream, args, 2);
			finish(decorated); finish(native);
			setToolRendererImplementation({
				createToolView: (_name, snapshot) => ({
					layout: "inline", head: { title: "STYLED_CALL", target: "", meta: [], status: "done" },
					sections: [], expanded: snapshot.context.expanded,
				}),
				layoutToolView: (view, snapshot) => ({
					callRows: [view.head.title],
					resultRows: snapshot.result ? ["STYLED_RESULT"] : [],
					callChildBounds: [], resultChildBounds: [], callOffset: 0, resultOffset: 1,
				}),
			});
			setToolRendererEnabled(true);
			expect(plain(decorated).join("\n")).toContain("STYLED_RESULT");
			setToolRendererEnabled(false);
			expect(decorated.render(80)).toEqual(native.render(80));
			setToolRendererEnabled(true);
			expect(plain(decorated).join("\n")).toContain("STYLED_CALL");
			expect(plain(decorated).join("\n")).toContain("STYLED_RESULT");
			expect(plain(decorated).join("\n")).not.toContain("NATIVE_RESULT");
			setToolRendererImplementation(undefined);
		}
	});

	it("restores fully undefined native Text with complete long args and output", () => {
		const args = { long: "x".repeat(180), tabs: "a\tb\rc" };
		const output = Array.from({ length: 15 }, (_, index) => `L${String(index + 1).padStart(2, "0")} \x1b[31mCOLOR\x1b[0m\r`).join("\n");
		for (const width of [24, 80, 120]) for (const outputPad of [0, 1, 2]) {
			const decorated = tool("unknown", facade("unknown", undefined), args, outputPad);
			const native = tool("unknown", undefined, args, outputPad);
			setToolRendererEnabled(false);
			expect(decorated.render(width)).toEqual(native.render(width));
			finish(decorated, output); finish(native, output);
			for (const expanded of [false, true]) {
				decorated.setExpanded(expanded); native.setExpanded(expanded);
				expect(decorated.render(width)).toEqual(native.render(width));
				expect(plain(decorated, width).join("\n")).toContain("L15");
				expect(plain(decorated, width).join("\n")).not.toContain("more lines");
			}
		}
	});

	for (const shell of ["default", "self"] as const) for (const slot of ["call", "result", "both"] as const) for (const throws of [false, true]) {
		it(`matches native missing/throwing slot fallback: shell=${shell}, slot=${slot}, throws=${throws}`, () => {
			const downstream: ToolRenderers = { renderShell: shell,
				...(slot === "result" ? { renderCall: () => new Text("PRESERVED_CALL", 0, 0) } : throws ? { renderCall: () => { throw Error("call"); } } : {}),
				...(slot === "call" ? { renderResult: () => new Text("PRESERVED_RESULT", 0, 0) } : throws ? { renderResult: () => { throw Error("result"); } } : {}),
			};
			const args = { long: "v".repeat(150), multi: "one\ntwo\tthree" };
			const output = Array.from({ length: 14 }, (_, index) => `OUTPUT_${index + 1}`).join("\n");
			const decorated = tool("edit", facade("edit", downstream, [nativeInfo("edit")]), args);
			const native = tool("edit", downstream, args);
			finish(decorated, output); finish(native, output);
			setToolRendererEnabled(false);
			for (const expanded of [false, true]) {
				decorated.setExpanded(expanded); native.setExpanded(expanded);
				expect(decorated.render(80)).toEqual(native.render(80));
			}
		});
	}

	it("preserves a third-party self renderer unchanged instead of decorating it", () => {
		const downstream = { renderShell: "self" as const, renderCall: () => new Text("CUSTOM_SELF", 0, 0) };
		const renderer = facade("read", downstream, [{ name: "read", sourceInfo: { source: "extension", path: "/custom.ts" } } as ToolInfo]);
		expect(renderer).toBe(downstream);
	});

	it("keeps Pi image fallback handling intact across showImages, resize and toggle", () => {
		const image = { type: "image" as const, data: "", mimeType: "image/png" };
		const decorated = tool("unknown", facade("unknown", undefined));
		const native = tool("unknown", undefined);
		for (const component of [decorated, native]) component.updateResult({ content: [{ type: "text", text: "IMAGE_TEXT" }, image], isError: false }, false);
		for (const show of [false, true]) for (const width of [24, 80]) for (const enabled of [true, false]) {
			decorated.setShowImages(show); native.setShowImages(show); decorated.setImageWidthCells(width / 2); native.setImageWidthCells(width / 2); setToolRendererEnabled(enabled);
			expect(decorated.render(width)).toEqual(native.render(width));
		}
	});
});


describe("selective native terminal-image fallback", () => {
	it("restores the native Box/image policy for a disabled name while global presentation remains ON", async () => {
		const image = "\x1b_GIMAGE\x1b\\";
		const downstream: ToolRenderers = {
			renderCall: () => ({ render: () => [image], invalidate: () => {} }),
			renderResult: () => new Text("NATIVE_IMAGE_RESULT", 0, 0),
		};
		setToolRendererImplementation({
			createToolView: () => { throw new Error("semantic fallback"); },
			layoutToolView,
		});
		const decorated = tool("edit", facade("edit", downstream, [nativeInfo("edit")]), {}, 2);
		const native = tool("edit", downstream, {}, 2);
		finish(decorated); finish(native);
		await saveSettings({ tools: { edit: false } }, configPath); invalidateToolPresentations("edit");
		for (const width of [24, 80, 120]) expect(decorated.render(width)).toEqual(native.render(width));
	});
});
describe("exact-name choices on existing real Pi components", () => {
	const defaultSlots: ToolRenderers = {
		renderCall: () => new Text("DOWNSTREAM_CALL", 0, 0),
		renderResult: () => new Text("DOWNSTREAM_RESULT", 0, 0),
	};
	for (const variant of ["undefined", "default", "edit-self", "mcp", "web-self", "generic"] as const) {
		it(`restores ${variant} exactly on the same ON → per-tool OFF → ON instance`, async () => {
			useSemanticPresentation();
			const name = variant === "mcp" ? "mcp__docs__lookup" : variant === "web-self" ? "web_search"
				: variant === "generic" ? "custom_selective" : "edit";
			const metadata = variant === "mcp" ? { ...nativeInfo(name), sourceInfo: { source: "builtin", path: "builtin:mcp" } } as ToolInfo
				: variant === "web-self" || variant === "generic" ? { ...nativeInfo(name), sourceInfo: { source: "extension", path: "/provider.ts" } } as ToolInfo
					: nativeInfo(name);
			const downstream = variant === "undefined" ? undefined : variant === "edit-self" ? editRenderers
				: variant === "web-self" ? { ...defaultSlots, renderShell: "self" as const } : defaultSlots;
			const args = { path: "/tmp/selective.ts", edits: [{ oldText: "before", newText: "after" }], query: "SELECTIVE_QUERY" };
			const decorated = tool(name, facade(name, downstream, [metadata]), args, 2);
			const native = tool(name, downstream, args, 2);
			finish(decorated); finish(native);
			const styled = decorated.render(80);
			expect(styled).not.toEqual(native.render(80));
			await saveSettings({ tools: { [name]: false } }, configPath);
			invalidateToolPresentations(name);
			for (const expanded of [false, true]) {
				decorated.setExpanded(expanded); native.setExpanded(expanded);
				for (const width of [24, 80, 120]) expect(decorated.render(width)).toEqual(native.render(width));
			}
			// OFF still receives current args, output and failure state rather than an old styled snapshot.
			decorated.updateArgs({ ...args, query: "UPDATED_WHILE_OFF" });
			native.updateArgs({ ...args, query: "UPDATED_WHILE_OFF" });
			finish(decorated, "OFF_FINAL_CONTENT", true); finish(native, "OFF_FINAL_CONTENT", true);
			expect(decorated.render(80)).toEqual(native.render(80));
			await saveSettings({ tools: { [name]: true } }, configPath);
			invalidateToolPresentations(name);
			const restored = plain(decorated).join("\n");
			expect(decorated.render(80)).not.toEqual(native.render(80));
			if (variant === "web-self") expect(restored).toContain("UPDATED_WHILE_OFF");
			if (variant === "mcp" || variant === "undefined") expect(restored).toContain("OFF_FINAL_CONTENT");
		});
	}

	for (const excluded of [false, true]) it(`separates model Bash from direct ${excluded ? "!!" : "!"} Shell preferences`, async () => {
		uninstallShellRenderer(BashExecutionComponent);
		const nativeShell = BashExecutionComponent.prototype.render;
		const shell = new BashExecutionComponent("printf DIRECT_SHELL", ui() as never, excluded);
		shell.appendOutput("SHELL_BEFORE\n"); shell.setComplete(0, false);
		useSemanticPresentation(); setThemeProvider(() => theme);
		const bash = tool("bash", facade("bash", undefined, [nativeInfo("bash")]), { command: "printf MODEL_BASH" });
		const nativeBash = tool("bash", undefined, { command: "printf MODEL_BASH" });
		finish(bash); finish(nativeBash);
		await saveSettings({ tools: { bash: false } }, configPath); invalidateToolPresentations("bash");
		expect(bash.render(80)).toEqual(nativeBash.render(80));
		expect(plain(shell).join("\n")).toContain("Shell");
		await saveSettings({ tools: { bash: true }, shellEnabled: false }, configPath); invalidateToolPresentations("bash");
		expect(plain(bash).join("\n")).toContain("MODEL_BASH");
		expect(shell.render(80)).toEqual(nativeShell.call(shell, 80));
		shell.appendOutput("SHELL_CHANGED_WHILE_OFF\n");
		await saveSettings({ shellEnabled: true }, configPath);
		expect(plain(shell).join("\n")).toContain("SHELL_CHANGED_WHILE_OFF");
		expect(plain(bash).join("\n")).toContain("MODEL_BASH");
	});
});

describe("public interactive routing", () => {
	for (const shell of ["default", "self"] as const) for (const width of [24, 80, 120]) {
		it(`preserves real child focus/capture and result bounds: shell=${shell}, width=${width}`, () => {
			const events: TuiMouseEvent[] = [];
			const child: Component = {
				render: () => ["RESULT_INTERACTIVE"], invalidate: vi.fn(), handleInput: vi.fn(),
				handleMouse: (event) => { events.push(event); return { handled: true, capture: true, focus: true }; },
			};
			const downstream = { renderShell: shell, renderCall: () => new Text("CALL\nCALL_2", 0, 0), renderResult: () => child };
			const component = tool("edit", facade("edit", downstream, [nativeInfo("edit")]), {}, 2);
			finish(component);
			setToolRendererEnabled(false);
			const rows = plain(component, width);
			const y = rows.findIndex((row) => row.includes("RESULT_INTERACTIVE"));
			const x = shell === "default" ? 2 : 0;
			const event: TuiMouseEvent = { type: "press", button: "left", x, y, screenX: 40 + x, screenY: 60 + y, width, height: rows.length, shift: false, alt: false, ctrl: false };
			const dispatch = component.handleMouse(event) as { target: { component: Component; originX: number; originY: number }; focusTarget: Component; capture: boolean };
			expect(dispatch.target.component).toBe(child); expect(dispatch.focusTarget).toBe(child); expect(dispatch.capture).toBe(true);
			expect(events[0]).toEqual({ ...event, x: 0, y: 0, width: width - (shell === "default" ? 4 : 0), height: 1 });
			dispatch.focusTarget.handleInput!("key"); expect(child.handleInput).toHaveBeenCalledWith("key");
			const click = { ...event, type: "click" as const };
			component.handleMouse(click);
			expect(events).toHaveLength(2);
			expect(dispatch.target.originX).toBe(event.screenX);
			expect(dispatch.target.originY).toBe(event.screenY);
			dispatch.target.component.handleMouse!({ ...events[0]!, type: "drag", x: 1, screenX: event.screenX + 1 });
			dispatch.target.component.handleMouse!({ ...events[0]!, type: "release", x: 1, screenX: event.screenX + 1 });
			expect(events.map((received) => received.type)).toEqual(["press", "click", "drag", "release"]);
			// A handled click never reaches Pi's expansion fallback.
			expect(plain(component, width)).toEqual(rows);
		});
	}

	it("lets Pi expand an unconsumed result click on the same row", () => {
		const downstream = { renderCall: () => new Text("CALL", 0, 0), renderResult: (_result: unknown, options: { expanded: boolean }) => new Text(options.expanded ? "OPEN_RESULT" : "CLOSED_RESULT", 0, 0) };
		const component = tool("custom", facade("custom", downstream)); finish(component);
		const rows = plain(component);
		const y = rows.findIndex((row) => row.includes("CLOSED_RESULT"));
		component.handleMouse({ type: "click", button: "left", x: 1, y, screenX: 1, screenY: y, width: 80, height: rows.length, shift: false, alt: false, ctrl: false });
		expect(plain(component).join("\n")).toContain("OPEN_RESULT");
	});
});

describe("isolated semantic shell adaptation", () => {
	for (const exclude of [false, true]) it(`uses the shared Shell card and restores exact native output, excluded=${exclude}`, () => {
		uninstallShellRenderer(BashExecutionComponent);
		const shell = new BashExecutionComponent("printf SHELL_COMMAND", ui() as never, exclude);
		shell.appendOutput("SHELL_RESULT\n"); shell.setComplete(0, false);
		const original = shell.render(100);
		const getCommand = BashExecutionComponent.prototype.getCommand;
		const getOutput = BashExecutionComponent.prototype.getOutput;
		installToolsStyle({ registerToolRenderer: vi.fn(), getAllTools: () => [] } as never);
		setThemeProvider(() => theme);
		const rows = plain(shell, 100);
		expect(rows.join("\n")).toContain("Shell");
		expect(rows.join("\n")).toContain("SHELL_COMMAND");
		expect(rows.join("\n")).toContain("SHELL_RESULT");
		expect(rows.filter((row) => row.startsWith("╭"))).toHaveLength(1);
		expect(rows.every((row) => visibleWidth(row) <= 100)).toBe(true);
		if (exclude) expect(rows.join("\n")).toContain("excluded from context");
		setToolRendererEnabled(false);
		expect(shell.render(100)).toEqual(original);
		setToolRendererEnabled(true);
		installToolsStyle({ registerToolRenderer: vi.fn(), getAllTools: () => [] } as never);
		expect(plain(shell, 100).filter((row) => row.startsWith("╭"))).toHaveLength(1);
		expect(BashExecutionComponent.prototype.getCommand).toBe(getCommand);
		expect(BashExecutionComponent.prototype.getOutput).toBe(getOutput);
		expect(shell.getOutput()).toBe("SHELL_RESULT\n");
	});
	for (const status of ["running", "complete", "error", "cancelled"] as const) it(`preserves actual methods/tree/output and native OFF for ${status}`, () => {
		uninstallShellRenderer(BashExecutionComponent);
		const originalRender = BashExecutionComponent.prototype.render;
		const methods = ["appendOutput", "setComplete", "updateDisplay", "setExpanded", "getCommand", "getOutput", "invalidate"];
		const originals = methods.map((name) => Reflect.get(BashExecutionComponent.prototype, name));
		const shell = new BashExecutionComponent("printf SHELL_STATE", ui() as never);
		shell.appendOutput("CHUNK_ONE"); shell.appendOutput("_CONTINUED\nCHUNK_TWO\n");
		if (status !== "running") shell.setComplete(status === "error" ? 23 : 0, status === "cancelled");
		const children = shell.children;
		const originalOutput = shell.getOutput();
		const timerCount = vi.getTimerCount();
		installToolsStyle({ registerToolRenderer: vi.fn(), getAllTools: () => [] } as never);
		setThemeProvider(() => theme);
		const on = plain(shell, 120).join("\n");
		expect(on).toContain("Shell"); expect(on).toContain("CHUNK_ONE_CONTINUED"); expect(on).toContain("CHUNK_TWO");
		if (status === "running") expect(on).toContain("Running...");
		if (status === "error") expect(on).toContain("exit 23");
		if (status === "cancelled") expect(on).toContain("cancelled");
		expect(vi.getTimerCount()).toBe(timerCount);
		expect(shell.children).toBe(children);
		expect(shell.getOutput()).toBe(originalOutput);
		for (const width of [24, 80, 120]) {
			setToolRendererEnabled(false);
			expect(shell.render(width)).toEqual(originalRender.call(shell, width));
			setToolRendererEnabled(true);
			expect(shell.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		methods.forEach((name, i) => expect(Reflect.get(BashExecutionComponent.prototype, name)).toBe(originals[i]));
		if (status === "running") shell.setComplete(0, false);
	});
	it("uses the real Loader clock to patch one shell header while preserving the prepared long output array", () => {
		vi.setSystemTime(0);
		uninstallShellRenderer(BashExecutionComponent);
		const targetUi = ui();
		const shell = new BashExecutionComponent("printf LONG_NATIVE_LOADER", targetUi as never);
		shell.appendOutput(Array.from({ length: 2000 }, (_, i) => `SHELL_BODY_${i}`).join("\n"));
		shell.setExpanded(true);
		installToolsStyle({ registerToolRenderer: vi.fn(), getAllTools: () => [] } as never);
		setThemeProvider(() => theme);
		const factory = vi.fn(createToolView);
		const layouts: ToolLayout[] = [];
		const layout = vi.fn((...args: Parameters<typeof layoutToolView>) => {
			const prepared = layoutToolView(...args);
			layouts.push(prepared);
			return prepared;
		});
		setToolRendererImplementation({ createToolView: factory, layoutToolView: layout });
		const timers = vi.getTimerCount();
		expect(timers).toBe(1);
		const before = shell.render(80);
		const body = before.slice(1);
		expect(body.map(stripTerminalSequences).join("\n")).toContain("SHELL_BODY_1999");
		const prepared = layouts.at(-1)!;
		const callRows = prepared.callRows;
		const resultRows = prepared.resultRows;
		let header = before[0];
		for (let i = 0; i < 3; i++) {
			targetUi.requestRender.mockClear();
			vi.advanceTimersByTime(80);
			expect(targetUi.requestRender).toHaveBeenCalled();
			const after = shell.render(80);
			expect(after).toBe(before);
			expect(after[0]).not.toBe(header);
			header = after[0];
			expect(after.slice(1)).toEqual(body);
			expect(layouts.at(-1)).toBe(prepared);
			expect(prepared.callRows).toBe(callRows);
			expect(prepared.resultRows).toBe(resultRows);
			expect(factory).toHaveBeenCalledOnce();
			expect(layout).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(timers);
		}
		const resized = shell.render(120);
		expect(resized).not.toBe(before);
		expect(resized.map(stripTerminalSequences).join("\n")).toContain("SHELL_BODY_1999");
		expect(factory).toHaveBeenCalledOnce();
		expect(layout).toHaveBeenCalledTimes(2);
		shell.appendOutput("\nORDINARY_NEW_SHELL_OUTPUT");
		expect(plain(shell, 120).join("\n")).toContain("ORDINARY_NEW_SHELL_OUTPUT");
		shell.setComplete(0, false);
		expect(vi.getTimerCount()).toBe(0);
	});
});

function useSemanticPresentation(): void {
	installToolsStyle({ registerToolRenderer: vi.fn(), getAllTools: () => [] } as never);
	setToolRendererEnabled(true);
}
const semanticLines = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`).join("\n");

interface WebResultFixture extends ToolResult {
	details: { response: WebResponse; server?: string; tool?: string };
	isError: boolean;
	durationMs: number;
}
function webResultFixture(): WebResultFixture {
	return {
		content: [{ type: "text", text: "RAW_TEXT_WITHOUT_SOURCE_TITLES" }],
		details: { response: {
			provider: "exa", answer: "ANSWER_MARKER", searchQueries: ["RESULT_QUERY_MARKER"],
			sources: Array.from({ length: 10 }, (_, index) => ({ url: `https://example.org/source-${index + 1}`, title: `SOURCE_${String(index + 1).padStart(2, "0")}` })),
			usage: { inputTokens: 0, totalTokens: 42 },
		} },
		isError: false, durationMs: 1250,
	};
}

describe("semantic views through real Pi components", () => {
	it("renders Bash tail10, one command, recorded duration, and all output after expansion", () => {
		useSemanticPresentation();
		const args = { command: "printf semantic-bash-command" };
		const component = tool("bash", facade("bash", undefined, [nativeInfo("bash")]), args);
		finish(component, semanticLines("B", 12));
		const collapsed = plain(component).join("\n");
		expect(collapsed).toContain("B03"); expect(collapsed).toContain("B12");
		expect(collapsed).not.toContain("B01"); expect(collapsed).not.toContain("B02");
		expect(collapsed.match(/semantic-bash-command/g)).toHaveLength(1);
		expect(collapsed).toContain("1.3s");
		component.setExpanded(true);
		expect(plain(component).join("\n")).toContain("B01");
	});

	it("renders Read head10 inline and Find five logical entries before expansion", () => {
		useSemanticPresentation();
		const read = tool("read", facade("read", undefined, [nativeInfo("read")]), { path: "/tmp/example.txt" });
		finish(read, semanticLines("R", 12));
		const readRows = plain(read);
		expect(readRows.some((row) => row.startsWith("╭"))).toBe(false);
		expect(readRows.join("\n")).toContain("R01"); expect(readRows.join("\n")).toContain("R10");
		expect(readRows.join("\n")).not.toContain("R11");
		read.setExpanded(true); expect(plain(read).join("\n")).toContain("R12");
		const find = tool("find", facade("find", undefined, [nativeInfo("find")]), { pattern: "*.ts" });
		finish(find, semanticLines("F", 7));
		expect(plain(find).join("\n")).toContain("F05");
		expect(plain(find).join("\n")).not.toContain("F06");
		expect(plain(find).join("\n")).toContain("2 more entries");
		find.setExpanded(true); expect(plain(find).join("\n")).toContain("F07");
	});

	it("keeps Write active content open, then clamps to eight lines at completion", () => {
		useSemanticPresentation();
		const component = tool("write", facade("write", undefined, [nativeInfo("write")]), { path: "/tmp/example.txt", content: semanticLines("W", 12) });
		expect(plain(component).join("\n")).toContain("W12");
		component.markExecutionStarted();
		expect(plain(component).join("\n")).toContain("W12");
		finish(component, "Successfully wrote fixture content");
		expect(plain(component).join("\n")).toContain("W08");
		expect(plain(component).join("\n")).not.toContain("W09");
		component.setExpanded(true); expect(plain(component).join("\n")).toContain("W12");
	});

	it("honors active Write local collapse followed by global expand/collapse on the same instance", () => {
		useSemanticPresentation();
		const component = tool("write", facade("write", undefined, [nativeInfo("write")]), { path: "/tmp/example.txt", content: semanticLines("W", 12) });
		let rows = plain(component);
		const y = rows.findIndex((row) => row.startsWith("╭"));
		expect(y).toBeGreaterThanOrEqual(0);
		component.handleMouse({ type: "click", button: "left", x: 1, y, screenX: 1, screenY: y, width: 80, height: rows.length, shift: false, alt: false, ctrl: false });
		expect(plain(component).join("\n")).not.toContain("W12");
		component.markExecutionStarted();
		expect(plain(component).join("\n")).not.toContain("W12");
		component.setExpanded(true);
		expect(plain(component).join("\n")).toContain("W12");
		component.setExpanded(false);
		rows = plain(component);
		expect(rows.join("\n")).not.toContain("W12");
	});

	it("replaces active Edit preview with the real final diff and retains one target", () => {
		useSemanticPresentation();
		const component = tool("edit", facade("edit", editRenderers, [nativeInfo("edit")]), { path: "/tmp/edit-fixture.txt", edits: [{ oldText: "PREVIEW_OLD", newText: "PREVIEW_NEW" }] });
		expect(plain(component).join("\n")).toContain("PREVIEW_NEW");
		component.updateResult({ content: [{ type: "text", text: "Edited fixture" }], details: { diff: "- 1 DIFF_OLD\n+ 1 DIFF_NEW", firstChangedLine: 1 }, isError: false, durationMs: 1250 }, false);
		const rendered = plain(component).join("\n");
		expect(rendered).toContain("DIFF_NEW"); expect(rendered).not.toContain("PREVIEW_NEW");
		expect(rendered.match(/edit-fixture\.txt/g)).toHaveLength(1);
	});

	it("renders confirmed MCP head5 with original identity and warnings outside preview", () => {
		useSemanticPresentation();
		const metadata = nativeInfo("mcp__docs__lookup");
		metadata.sourceInfo.path = "builtin:mcp";
		metadata.namespace = { name: "mcp__docs" } as NonNullable<ToolInfo["namespace"]>;
		const component = tool(metadata.name, facade(metadata.name, undefined, [metadata]), { query: "needle" });
		component.updateResult({ content: [{ type: "text", text: semanticLines("M", 8) }], details: { server: "my-docs", tool: "lookup", fullOutputPath: "/tmp/mcp-full.txt" }, isError: false, durationMs: 1250 }, false);
		const rendered = plain(component).join("\n");
		expect(rendered).toContain("my-docs/lookup"); expect(rendered).toContain("M05");
		expect(rendered).not.toContain("M06"); expect(rendered).toContain("/tmp/mcp-full.txt");
		component.setExpanded(true); expect(plain(component).join("\n")).toContain("M08");
	});

	it("replaces web self call/result markers only ON and restores their exact native output OFF", () => {
		useSemanticPresentation();
		const renderCall = vi.fn(() => new Text("WEB_PROVIDER_CALL", 0, 0));
		const renderResult = vi.fn(() => new Text("WEB_PROVIDER_RESULT", 0, 0));
		const downstream = { renderShell: "self" as const, renderCall, renderResult };
		const args = { query: "Pi 1.1" };
		const result = webResultFixture();
		const component = tool("web_search", facade("web_search", downstream), args);
		component.markExecutionStarted(); component.updateResult(result, false);
		const collapsed = plain(component).join("\n");
		expect(collapsed).toContain("Web Search"); expect(collapsed.match(/Pi 1\.1/g)).toHaveLength(1);
		expect(collapsed).toContain("Sources · 10"); expect(collapsed).toContain("SOURCE_08"); expect(collapsed).toContain("… 2 more sources");
		expect(collapsed).not.toContain("SOURCE_09"); expect(collapsed).not.toContain("WEB_PROVIDER");
		expect(collapsed).toContain("in 0"); expect(collapsed).toContain("total 42");
		expect(renderCall).not.toHaveBeenCalled(); expect(renderResult).not.toHaveBeenCalled();
		component.setExpanded(true); expect(plain(component).join("\n")).toContain("SOURCE_10");
		const native = tool("web_search", downstream, args); native.markExecutionStarted(); native.updateResult(result, false); native.setExpanded(true);
		setToolRendererEnabled(false);
		for (const width of [24, 80, 120]) expect(component.render(width)).toEqual(native.render(width));
		expect(plain(component).join("\n")).toContain("WEB_PROVIDER_CALL"); expect(plain(component).join("\n")).toContain("WEB_PROVIDER_RESULT");
		setToolRendererEnabled(true);
		expect(plain(component).join("\n")).toContain("SOURCE_10"); expect(plain(component).join("\n")).not.toContain("WEB_PROVIDER");
	});

	for (const width of [24, 80, 120]) for (const enabled of [true, false]) {
		it(`routes framed/native original children with exact public focus/capture bounds: width=${width}, enabled=${enabled}`, () => {
			useSemanticPresentation(); setToolRendererEnabled(enabled);
			const events: TuiMouseEvent[] = [];
			const text = new Text("CHILD_INTERACTIVE", 0, 0);
			const child = { render: (childWidth: number) => text.render(childWidth), invalidate: () => text.invalidate(), handleInput: vi.fn(), handleMouse: (event: TuiMouseEvent) => { events.push(event); return { handled: true, capture: true, focus: true }; } };
			const downstream = { renderCall: () => new Text("CUSTOM_CALL", 0, 0), renderResult: () => child };
			const component = tool("custom", facade("custom", downstream), {}, 2); finish(component);
			const rows = plain(component, width);
			const y = rows.findIndex((row) => row.includes("CHILD_INTERACTIVE"));
			const x = enabled ? 3 : 2;
			const event: TuiMouseEvent = { type: "press", button: "left", x, y, screenX: 40 + x, screenY: 60 + y, width, height: rows.length, shift: false, alt: false, ctrl: false };
			const dispatched = component.handleMouse(event) as { target: { component: Component; originX: number; originY: number }; focusTarget: Component };
			expect(dispatched.target.component).toBe(child); expect(dispatched.focusTarget).toBe(child);
			expect(events[0]).toEqual({ ...event, x: 0, y: 0, width: width - (enabled ? 6 : 4), height: 1 });
			dispatched.focusTarget.handleInput!("key"); expect(child.handleInput).toHaveBeenCalledWith("key");
			dispatched.target.component.handleMouse!({ ...events[0]!, type: "drag" });
			dispatched.target.component.handleMouse!({ ...events[0]!, type: "release" });
			expect(events.map((received) => received.type)).toEqual(["press", "drag", "release"]);
		});
	}
});

describe("sticky web promotion and independent actual HTML rendering", () => {
	it("promotes the same hashed MCP row from retained provenance and stays web after result/call callbacks lose identity", () => {
		useSemanticPresentation();
		const name = "mcp__opaque_7e1";
		const metadata = nativeInfo(name); metadata.sourceInfo.path = "builtin:mcp";
		metadata.namespace = { name: "mcp__original" } as NonNullable<ToolInfo["namespace"]>;
		const downstream: ToolRenderers = { renderShell: "self", renderCall: () => new Text("HASHED_NATIVE_CALL", 0, 0), renderResult: () => new Text("HASHED_NATIVE_RESULT", 0, 0) };
		const component = tool(name, facade(name, downstream, [metadata]), { query: "HASH_QUERY_MARKER" });
		const initial = plain(component).join("\n");
		expect(initial).toContain("MCP"); expect(initial).not.toContain("Web Search");
		metadata.sourceInfo.path = "/changed-after-capture.ts";
		const promoted = webResultFixture(); promoted.details.server = "original-web"; promoted.details.tool = "web_search";
		component.updateResult(promoted, false);
		expect(plain(component).join("\n")).toContain("Web Search"); expect(plain(component).join("\n")).toContain("SOURCE_08");
		const later = webResultFixture();
		component.updateResult(later, false); component.updateArgs({ query: "LATER_QUERY_MARKER" });
		const sticky = plain(component).join("\n");
		expect(sticky).toContain("Web Search"); expect(sticky).toContain("LATER_QUERY_MARKER"); expect(sticky).not.toContain("HASHED_NATIVE");
		const native = tool(name, downstream, { query: "LATER_QUERY_MARKER" }); native.updateResult(later, false);
		setToolRendererEnabled(false);
		for (const width of [24, 80, 120]) expect(component.render(width)).toEqual(native.render(width));
		expect(plain(component).join("\n")).toContain("HASHED_NATIVE_CALL"); expect(plain(component).join("\n")).toContain("HASHED_NATIVE_RESULT");
		setToolRendererEnabled(true); expect(plain(component).join("\n")).toContain("Web Search");
	});

	it("serializes Query and structured Sources from an independent actual HTML result fragment", () => {
		useSemanticPresentation();
		const downstream: ToolRenderers = { renderShell: "self", renderCall: () => new Text("HTML_PROVIDER_CALL", 0, 0), renderResult: () => new Text("HTML_PROVIDER_RESULT", 0, 0) };
		const renderer = facade("web_search", downstream);
		const html = createToolHtmlRenderer({ getToolRenderers: () => renderer, theme, cwd: process.cwd(), width: 100 });
		const result = webResultFixture();
		const exported = html.renderResult("result-only", "web_search", result.content, result.details, false);
		expect(exported?.collapsed).toContain("Query"); expect(exported?.collapsed).toContain("RESULT_QUERY_MARKER");
		expect(exported?.collapsed).toContain("Sources · 10"); expect(exported?.collapsed).toContain("SOURCE_08");
		expect(exported?.collapsed).toContain("2 more sources"); expect(exported?.collapsed).not.toContain("SOURCE_09");
		expect(exported?.expanded).toContain("SOURCE_10"); expect(exported?.expanded).toContain("RESULT_QUERY_MARKER");
		expect(exported?.expanded).not.toContain("HTML_PROVIDER"); expect(exported?.expanded).not.toContain("RAW_TEXT_WITHOUT_SOURCE_TITLES");
		expect(vi.getTimerCount()).toBe(0);
		setToolRendererEnabled(false);
		const native = html.renderResult("result-only", "web_search", result.content, result.details, false);
		const untouched = createToolHtmlRenderer({ getToolRenderers: () => downstream, theme, cwd: process.cwd(), width: 100 });
		const expectedNative = untouched.renderResult("result-only", "web_search", result.content, result.details, false);
		expect(native).toEqual(expectedNative);
		expect(native?.expanded).toContain("HTML_PROVIDER_RESULT");
	});
});
