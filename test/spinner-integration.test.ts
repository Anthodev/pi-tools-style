import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createToolRendererResolver, invalidateToolPresentations, ToolRendererSession, setToolRendererEnabled, setToolRendererImplementation, type ToolLayout } from "../src/tool-renderer.ts";
// Pinned native implementation is a test reference, never a production dependency.
import { createShellRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/bash.js";
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createToolView, type ToolContext } from "../src/tool-presentation.ts";
import { layoutToolView } from "../src/frame.ts";
import { clearToolSpinners } from "../src/tool-spinner.ts";
import { loadSettings, saveSettings, setIconMode } from "../src/settings.ts";
import { Text, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";


let configDirectory: string;
let configPath: string;
beforeEach(async () => {
	configDirectory = await mkdtemp(join(tmpdir(), "tools-style-spinners-"));
	configPath = join(configDirectory, "settings.json");
	await loadSettings(configPath);
});
afterEach(async () => {
	await loadSettings(join(configDirectory, "missing.json"));
	await rm(configDirectory, { recursive: true, force: true });
});
beforeEach(() => { vi.useFakeTimers(); initTheme("dark", false); clearToolSpinners(); setToolRendererImplementation(undefined); setToolRendererEnabled(true); setIconMode("nerd-font"); });
afterEach(() => { setToolRendererImplementation(undefined); setToolRendererEnabled(true); clearToolSpinners(); setIconMode("ascii"); vi.clearAllTimers(); vi.useRealTimers(); });

describe("native animation ownership through public middleware", () => {
	it("keeps downstream public invalidation live and forwards completion while native rows are hidden", () => {
		const ui = { requestRender: vi.fn() };
		const downstream = createShellRenderers("$");
		const renderer = createToolRendererResolver({ getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } } as ToolInfo] })("bash", () => downstream)!;
		const component = new ToolExecutionComponent("bash", "animated", { command: "printf result" }, {}, renderer, ui as never, process.cwd());
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "PROGRESS" }], isError: false }, true);
		expect(vi.getTimerCount()).toBe(0);
		component.render(80);
		expect(vi.getTimerCount()).toBe(1);
		ui.requestRender.mockClear(); vi.advanceTimersByTime(1000);
		expect(ui.requestRender).toHaveBeenCalled();
		setToolRendererImplementation({
			createToolView: (_name, snapshot) => ({ layout: "inline", head: { title: "SEMANTIC", target: "", meta: [], status: snapshot.context.isPartial ? "running" : "done" }, sections: [], expanded: false }),
			layoutToolView: () => ({ callRows: ["SEMANTIC"], resultRows: [], callChildBounds: [], resultChildBounds: [], callOffset: 0, resultOffset: 1 }),
		});
		expect(component.render(80)).toContain("SEMANTIC");
		component.updateResult({ content: [{ type: "text", text: "FINAL" }], isError: false, durationMs: 1500 }, false);
		expect(vi.getTimerCount()).toBe(0);
		ui.requestRender.mockClear(); vi.advanceTimersByTime(1000);
		expect(ui.requestRender).not.toHaveBeenCalled();
		setToolRendererEnabled(false);
		expect(component.render(80).join("\n")).toContain("FINAL");
	});

	it("does not start native animation for a completed replay before its first render", () => {
		const downstream = createShellRenderers("$");
		const renderer = createToolRendererResolver({ getAllTools: () => [] })("bash", () => downstream)!;
		const component = new ToolExecutionComponent("bash", "replay", { command: "true" }, {}, renderer, { requestRender: vi.fn() } as never, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "REPLAY" }], isError: false, durationMs: 1500 }, false);
		component.render(80);
		expect(vi.getTimerCount()).toBe(0);
	});
});

function semanticRead(session: ToolRendererSession, id: string) {
	const info = { name: "read", description: "Fixture", exposure: "direct", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin", path: "builtin:read", scope: "temporary", origin: "top-level" } } as ToolInfo;
	const renderer = createToolRendererResolver({ getAllTools: () => [info] }, session)("read", () => undefined)!;
	const ui = { requestRender: vi.fn() };
	const component = new ToolExecutionComponent("read", id, { path: "/tmp/fixture.txt" }, {}, renderer, ui as never, process.cwd());
	return { component, ui };
}

describe("event-gated semantic clock through real Pi components", () => {
	it("starts only after a public execution event, shares one 80ms timer, and stops on final result", () => {
		setToolRendererImplementation({ createToolView, layoutToolView });
		const session = new ToolRendererSession();
		const first = semanticRead(session, "first");
		first.component.markExecutionStarted();
		expect(first.component.render(80).map(stripTerminalSequences).join("\n")).toContain("⠋");
		expect(vi.getTimerCount()).toBe(0);
		session.executionStarted("first");
		expect(vi.getTimerCount()).toBe(1);
		first.ui.requestRender.mockClear(); vi.advanceTimersByTime(80);
		expect(first.ui.requestRender).toHaveBeenCalledOnce();
		expect(first.component.render(80).map(stripTerminalSequences).join("\n")).toContain("⠙");
		const second = semanticRead(session, "second"); second.component.markExecutionStarted(); session.executionStarted("second");
		expect(vi.getTimerCount()).toBe(1);
		first.component.updateResult({ content: [{ type: "text", text: "FINAL_FIRST" }], isError: false }, false);
		expect(vi.getTimerCount()).toBe(1);
		second.component.updateResult({ content: [{ type: "text", text: "FINAL_SECOND" }], isError: true }, false);
		expect(vi.getTimerCount()).toBe(0);
		first.ui.requestRender.mockClear(); second.ui.requestRender.mockClear(); vi.advanceTimersByTime(800);
		expect(first.ui.requestRender).not.toHaveBeenCalled(); expect(second.ui.requestRender).not.toHaveBeenCalled();
	});

	it("never enrolls an export/replay state that shares an already-live call ID", () => {
		setToolRendererImplementation({ createToolView, layoutToolView });
		const session = new ToolRendererSession();
		const live = semanticRead(session, "shared"); live.component.markExecutionStarted(); session.executionStarted("shared");
		const exported = semanticRead(session, "shared"); exported.component.markExecutionStarted();
		exported.component.render(80);
		live.ui.requestRender.mockClear(); exported.ui.requestRender.mockClear(); vi.advanceTimersByTime(80);
		expect(live.ui.requestRender).toHaveBeenCalledOnce();
		expect(exported.ui.requestRender).not.toHaveBeenCalled();
		exported.component.updateResult({ content: [{ type: "text", text: "EXPORTED_RESULT" }], isError: false }, false);
		expect(vi.getTimerCount()).toBe(1);
		session.executionEnded("shared");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cannot let an HTML export during the start event preempt a subsequently constructed live row", () => {
		setToolRendererImplementation({ createToolView, layoutToolView });
		const session = new ToolRendererSession();
		const info = { name: "read", description: "Fixture", exposure: "direct", parameters: { type: "object", properties: {} }, sourceInfo: { source: "builtin", path: "builtin:read", scope: "temporary", origin: "top-level" } } as ToolInfo;
		const renderer = createToolRendererResolver({ getAllTools: () => [info] }, session)("read", () => undefined)!;
		const exported = createToolHtmlRenderer({ getToolRenderers: () => renderer, theme, cwd: process.cwd(), width: 80 });
		expect(exported.renderCall("during-start", "read", { path: "/tmp/fixture.txt" })).toBeTruthy();
		session.executionStarted("during-start");
		expect(exported.renderCall("during-start", "read", { path: "/tmp/fixture.txt" })).toBeTruthy();
		expect(vi.getTimerCount()).toBe(0);

		// Pi forwards extension start events before constructing/marking a missing TUI row.
		const live = semanticRead(session, "during-start");
		expect(vi.getTimerCount()).toBe(0);
		live.component.markExecutionStarted();
		expect(vi.getTimerCount()).toBe(1);
		live.ui.requestRender.mockClear(); vi.advanceTimersByTime(80);
		expect(live.ui.requestRender).toHaveBeenCalledOnce();
		expect(exported.renderCall("during-start", "read", { path: "/tmp/fixture.txt" })).toBeTruthy();
		expect(vi.getTimerCount()).toBe(1);

		live.component.updateResult({ content: [{ type: "text", text: "FINAL_LIVE" }], isError: false }, false);
		expect(vi.getTimerCount()).toBe(0);
		session.executionEnded("during-start");
		live.ui.requestRender.mockClear(); vi.advanceTimersByTime(80);
		expect(live.ui.requestRender).not.toHaveBeenCalled();

		session.executionStarted("shutdown-live");
		const stopped = semanticRead(session, "shutdown-live"); stopped.component.markExecutionStarted();
		expect(vi.getTimerCount()).toBe(1);
		session.shutdown(); expect(vi.getTimerCount()).toBe(0);
		stopped.ui.requestRender.mockClear(); invalidateToolPresentations(); vi.advanceTimersByTime(800);
		expect(stopped.ui.requestRender).not.toHaveBeenCalled();
	});

	it("stops and resumes an existing active row across style toggles, invalidates icons, and releases shutdown references", () => {
		setToolRendererImplementation({ createToolView, layoutToolView });
		const session = new ToolRendererSession();
		const live = semanticRead(session, "live"); live.component.markExecutionStarted(); session.executionStarted("live");
		expect(vi.getTimerCount()).toBe(1);
		setToolRendererEnabled(false); expect(vi.getTimerCount()).toBe(0);
		setToolRendererEnabled(true); expect(vi.getTimerCount()).toBe(1);
		setIconMode("ascii"); live.ui.requestRender.mockClear(); invalidateToolPresentations();
		expect(live.ui.requestRender).toHaveBeenCalled();
		expect(live.component.render(80).map(stripTerminalSequences).join("\n")).not.toContain("⠋");
		session.shutdown(); expect(vi.getTimerCount()).toBe(0);
		live.ui.requestRender.mockClear(); invalidateToolPresentations(); vi.advanceTimersByTime(800);
		expect(live.ui.requestRender).not.toHaveBeenCalled();
	});

	it("resets live animation claims and cannot re-enroll them through render flags or style toggles", () => {
		setToolRendererImplementation({ createToolView, layoutToolView });
		const session = new ToolRendererSession();
		const live = semanticRead(session, "reset-live");
		live.component.markExecutionStarted(); session.executionStarted("reset-live");
		live.component.render(80);
		expect(vi.getTimerCount()).toBe(1);
		session.reset();
		expect(vi.getTimerCount()).toBe(0);
		live.ui.requestRender.mockClear();
		vi.advanceTimersByTime(400);
		expect(live.ui.requestRender).not.toHaveBeenCalled();
		setToolRendererEnabled(false); setToolRendererEnabled(true);
		live.component.render(80);
		expect(vi.getTimerCount()).toBe(0);
		session.executionStarted("reset-live");
		expect(vi.getTimerCount()).toBe(1);
		session.shutdown();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("shutdown releases only its own rows while another session's live target keeps the single ticker", () => {
		setToolRendererImplementation({ createToolView, layoutToolView });
		const firstSession = new ToolRendererSession(); const nextSession = new ToolRendererSession();
		const first = semanticRead(firstSession, "first-session");
		const next = semanticRead(nextSession, "next-session");
		first.component.markExecutionStarted(); next.component.markExecutionStarted();
		firstSession.executionStarted("first-session"); nextSession.executionStarted("next-session");
		expect(vi.getTimerCount()).toBe(1);
		firstSession.shutdown();
		expect(vi.getTimerCount()).toBe(1);
		first.ui.requestRender.mockClear(); next.ui.requestRender.mockClear();
		invalidateToolPresentations(); vi.advanceTimersByTime(240);
		expect(first.ui.requestRender).not.toHaveBeenCalled();
		expect(next.ui.requestRender).toHaveBeenCalled();
		nextSession.shutdown();
		expect(vi.getTimerCount()).toBe(0);
		first.ui.requestRender.mockClear(); next.ui.requestRender.mockClear();
		invalidateToolPresentations(); vi.advanceTimersByTime(240);
		expect(first.ui.requestRender).not.toHaveBeenCalled();
		expect(next.ui.requestRender).not.toHaveBeenCalled();
	});

	it("does not animate completed replay rows or ordinary render-context execution flags without public events", () => {
		setToolRendererImplementation({ createToolView, layoutToolView });
		const session = new ToolRendererSession();
		const replay = semanticRead(session, "replay");
		replay.component.markExecutionStarted(); replay.component.render(80);
		expect(vi.getTimerCount()).toBe(0);
		replay.component.updateResult({ content: [{ type: "text", text: "REPLAY" }], isError: false }, false);
		replay.component.render(80); vi.advanceTimersByTime(800);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("prepared owned bodies through the real synchronous SDK invalidation", () => {
	const sessions: ToolRendererSession[] = [];
	function trackedSession() {
		const session = new ToolRendererSession();
		sessions.push(session);
		return session;
	}
	afterEach(() => {
		for (const session of sessions) session.shutdown();
		sessions.length = 0;
	});

	it("invalidates only the chosen name and preserves another live row's prepared body and ticker target", async () => {
		const children: MockInstance[] = [];
		const factory = vi.fn((...args: Parameters<typeof createToolView>) => {
			const view = createToolView(...args);
			if (args[0] === "bash") for (const section of view.sections) children.push(vi.spyOn(section.component, "render"));
			return view;
		});
		const layouts: ToolLayout[] = [];
		const layout = vi.fn((...args: Parameters<typeof layoutToolView>) => {
			const prepared = layoutToolView(...args);
			if (args[1].presentation === "builtin" && "command" in (args[1].args as object)) layouts.push(prepared);
			return prepared;
		});
		setToolRendererImplementation({ createToolView: factory, layoutToolView: layout });
		const session = trackedSession();
		const selected = semanticRead(session, "selected-read");
		selected.component.markExecutionStarted(); session.executionStarted("selected-read");
		selected.component.render(80);
		const metadata = { name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } } as ToolInfo;
		const renderer = createToolRendererResolver({ getAllTools: () => [metadata] }, session)("bash", () => undefined)!;
		const targetUi = { requestRender: vi.fn() };
		const untouched = new ToolExecutionComponent("bash", "unrelated-bash", { command: "printf UNTOUCHED" }, {}, renderer, targetUi as never, process.cwd());
		untouched.markExecutionStarted();
		untouched.updateResult({ content: [{ type: "text", text: Array.from({ length: 2000 }, (_, i) => `UNCHANGED_BODY_${i}`).join("\n") }], isError: false }, true);
		untouched.setExpanded(true); session.executionStarted("unrelated-bash");
		const before = untouched.render(80);
		const prepared = layouts.at(-1)!;
		const body = prepared.resultRows;
		const factoryCount = factory.mock.calls.filter(([name]) => name === "bash").length;
		const layoutCount = layouts.length;
		const childCounts = children.map((spy) => spy.mock.calls.length);
		targetUi.requestRender.mockClear();
		await saveSettings({ tools: { read: false } }, configPath);
		invalidateToolPresentations("read");
		expect(targetUi.requestRender).not.toHaveBeenCalled();
		expect(untouched.render(80)).toEqual(before);
		expect(layouts.at(-1)).toBe(prepared); expect(prepared.resultRows).toBe(body);
		expect(factory.mock.calls.filter(([name]) => name === "bash")).toHaveLength(factoryCount);
		expect(layouts).toHaveLength(layoutCount);
		expect(children.map((spy) => spy.mock.calls.length)).toEqual(childCounts);
		selected.ui.requestRender.mockClear(); targetUi.requestRender.mockClear();
		vi.advanceTimersByTime(80);
		expect(selected.ui.requestRender).not.toHaveBeenCalled();
		expect(targetUi.requestRender).toHaveBeenCalledOnce();
		untouched.render(80);
		expect(prepared.resultRows).toBe(body);
		expect(factory.mock.calls.filter(([name]) => name === "bash")).toHaveLength(factoryCount);
		expect(layouts).toHaveLength(layoutCount);
		expect(children.map((spy) => spy.mock.calls.length)).toEqual(childCounts);
		await saveSettings({ tools: { read: true } }, configPath); invalidateToolPresentations("read");
		selected.component.render(80);
		selected.ui.requestRender.mockClear(); targetUi.requestRender.mockClear();
		vi.advanceTimersByTime(80);
		expect(selected.ui.requestRender).toHaveBeenCalledOnce();
		expect(targetUi.requestRender).toHaveBeenCalledOnce();
		session.shutdown();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps native state and lastComponent after selective OFF and stops a hidden native loader on completion", async () => {
		const native = createShellRenderers("$");
		const calls: ToolContext[] = []; const results: ToolContext[] = [];
		let nativeResult: Component | undefined;
		const downstream: ToolRenderers = {
			...native,
			renderCall: (args, currentTheme, ctx) => { calls.push(ctx); return native.renderCall!(args, currentTheme, ctx); },
			renderResult: (result, options, currentTheme, ctx) => {
				results.push(ctx);
				nativeResult = native.renderResult!(result, options, currentTheme, ctx);
				return nativeResult;
			},
		};
		setToolRendererImplementation({ createToolView, layoutToolView });
		const session = trackedSession();
		const renderer = createToolRendererResolver({ getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } } as ToolInfo] }, session)("bash", () => downstream)!;
		const component = new ToolExecutionComponent("bash", "selective-hidden", { command: "printf CURRENT" }, {}, renderer, { requestRender: vi.fn() } as never, process.cwd());
		component.markExecutionStarted(); session.executionStarted("selective-hidden");
		component.updateResult({ content: [{ type: "text", text: "PARTIAL" }], isError: false }, true);
		component.render(80);
		expect(calls).toHaveLength(0);
		await saveSettings({ tools: { bash: false } }, configPath); invalidateToolPresentations("bash");
		expect(component.render(80).map(stripTerminalSequences).join("\n")).toContain("PARTIAL");
		const state = calls.at(-1)!.state;
		const resultChild = nativeResult;
		expect(vi.getTimerCount()).toBe(1);
		await saveSettings({ tools: { bash: true } }, configPath); invalidateToolPresentations("bash");
		component.render(80);
		const callCount = calls.length; const resultCount = results.length;
		vi.advanceTimersByTime(80); component.render(80);
		expect(calls).toHaveLength(callCount); expect(results).toHaveLength(resultCount);
		component.updateResult({ content: [{ type: "text", text: "HIDDEN_FINAL" }], isError: false }, false);
		expect(results.at(-1)!.isPartial).toBe(false);
		expect(calls.at(-1)!.state).toBe(state); expect(results.at(-1)!.state).toBe(state);
		expect(results.at(-1)!.lastComponent).toBe(resultChild);
		expect(vi.getTimerCount()).toBe(0);
		await saveSettings({ tools: { bash: false } }, configPath); invalidateToolPresentations("bash");
		expect(component.render(80).map(stripTerminalSequences).join("\n")).toContain("HIDDEN_FINAL");
		session.shutdown();
	});

	for (const name of ["bash", "read", "write"] as const) it(`rotates ${name}'s live header without preparing, rendering or copying its long body again`, () => {
		const childRenders: MockInstance[] = [];
		const factory = vi.fn((...args: Parameters<typeof createToolView>) => {
			const view = createToolView(...args);
			for (const section of view.sections) childRenders.push(vi.spyOn(section.component, "render"));
			return view;
		});
		const layouts: ToolLayout[] = [];
		const layout = vi.fn((...args: Parameters<typeof layoutToolView>) => {
			const prepared = layoutToolView(...args);
			layouts.push(prepared);
			return prepared;
		});
		setToolRendererImplementation({ createToolView: factory, layoutToolView: layout });
		const session = trackedSession();
		const info = { name, sourceInfo: { source: "builtin", path: `builtin:${name}` } } as ToolInfo;
		const renderer = createToolRendererResolver({ getAllTools: () => [info] }, session)(name, () => undefined)!;
		const source = Array.from({ length: 2000 }, (_, i) => `BODY_${i} 漢 e\u0301`).join("\n");
		const args: { command?: string; path?: string; content?: string } = name === "bash" ? { command: "printf BODY | sed -n 1p" } : { path: name === "read" ? "/tmp/body.ts" : "/tmp/body.txt", content: source };
		const targetUi = { requestRender: vi.fn() };
		const component = new ToolExecutionComponent(name, `long-${name}`, args, {}, renderer, targetUi as never, process.cwd());
		component.markExecutionStarted();
		const result = { content: [{ type: "text" as const, text: source }], details: { truncation: { truncated: false }, fullOutputPath: "/tmp/first.log" }, isError: false };
		if (name !== "write") component.updateResult(result, true);
		component.setExpanded(true);
		session.executionStarted(`long-${name}`);
		const before = component.render(80).map(stripTerminalSequences);
		expect(before.join("\n")).toContain("BODY_0");
		expect(before.join("\n")).toContain("BODY_1999");
		const prepared = layouts.at(-1)!;
		const callRows = prepared.callRows;
		const resultRows = prepared.resultRows;
		const callBounds = prepared.callChildBounds;
		const resultBounds = prepared.resultChildBounds;
		const initialBody = callRows.slice(1).concat(resultRows);
		const renderCounts = childRenders.map((spy) => spy.mock.calls.length);
		const factoryCount = factory.mock.calls.length;
		const layoutCount = layout.mock.calls.length;
		let header = callRows[0];
		for (let i = 0; i < 3; i++) {
			targetUi.requestRender.mockClear();
			vi.advanceTimersByTime(80);
			expect(targetUi.requestRender).toHaveBeenCalledOnce();
			const after = component.render(80).map(stripTerminalSequences);
			expect(after[1]).not.toBe(before[1]);
			expect(after.slice(2)).toEqual(before.slice(2));
			expect(callRows[0]).not.toBe(header);
			header = callRows[0];
			expect(layouts.at(-1)).toBe(prepared);
			expect(prepared.callRows).toBe(callRows);
			expect(prepared.resultRows).toBe(resultRows);
			expect(prepared.callChildBounds).toBe(callBounds);
			expect(prepared.resultChildBounds).toBe(resultBounds);
			expect(callRows.slice(1).concat(resultRows)).toEqual(initialBody);
			expect(factory).toHaveBeenCalledTimes(factoryCount);
			expect(layout).toHaveBeenCalledTimes(layoutCount);
			expect(childRenders.map((spy) => spy.mock.calls.length)).toEqual(renderCounts);
		}
		// A true callback must read in-place mutations even immediately after a clock-only refresh.
		if (name === "write") {
			args.path = "/tmp/changed-body.txt";
			args.content = "ORDINARY_CHANGED_WRITE";
			component.updateArgs(args);
			const changed = component.render(80).map(stripTerminalSequences).join("\n");
			expect(changed).toContain("changed-body.txt");
			expect(changed).toContain("ORDINARY_CHANGED_WRITE");
			expect(changed).not.toContain("BODY_1999");
		} else {
			result.content[0]!.text = "ORDINARY_CHANGED_RESULT";
			result.details.truncation.truncated = true;
			result.details.fullOutputPath = "/tmp/changed-output.log";
			component.updateResult(result, true);
			const changed = component.render(80).map(stripTerminalSequences).join("\n");
			expect(changed).toContain("ORDINARY_CHANGED_RESULT");
			expect(changed).toContain("Truncated");
			if (name === "bash") expect(changed).toContain("changed-output.log");
			expect(changed).not.toContain("BODY_1999");
		}
		expect(factory.mock.calls.length).toBeGreaterThan(factoryCount);
		session.shutdown();
	});

	it("does not suppress hidden native invalidation or completion outside its own clock transaction", () => {
		const nativeCall = new Text("NATIVE_CALL", 0, 0);
		const nativeResult = new Text("NATIVE_RESULT", 0, 0);
		const contexts: ToolContext[] = [];
		const downstream: ToolRenderers = {
			renderCall: vi.fn((_args, _theme, ctx) => { contexts.push(ctx); ctx.state.nativeSeen = true; return nativeCall; }),
			renderResult: vi.fn((_result, _options, _theme, ctx) => { contexts.push(ctx); expect(ctx.state.nativeSeen).toBe(true); return nativeResult; }),
		};
		const session = trackedSession();
		const renderer = createToolRendererResolver({ getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } } as ToolInfo] }, session)("bash", () => downstream)!;
		const component = new ToolExecutionComponent("bash", "hidden-native", { command: "true" }, {}, renderer, { requestRender: vi.fn() } as never, process.cwd());
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "OWNED_PROGRESS" }], isError: false }, true);
		component.render(80);
		const nativeState = contexts.at(-1)!.state;
		setToolRendererImplementation({ createToolView, layoutToolView });
		session.executionStarted("hidden-native");
		component.render(80);
		const callCount = vi.mocked(downstream.renderCall!).mock.calls.length;
		const resultCount = vi.mocked(downstream.renderResult!).mock.calls.length;
		vi.advanceTimersByTime(80);
		expect(component.render(80).map(stripTerminalSequences).join("\n")).toContain("OWNED_PROGRESS");
		expect(downstream.renderCall).toHaveBeenCalledTimes(callCount);
		expect(downstream.renderResult).toHaveBeenCalledTimes(resultCount);
		contexts.at(-1)!.invalidate();
		expect(vi.mocked(downstream.renderCall!).mock.calls.length).toBeGreaterThan(callCount);
		expect(vi.mocked(downstream.renderResult!).mock.calls.length).toBeGreaterThan(resultCount);
		expect(contexts.at(-1)!.state).toBe(nativeState);
		expect(contexts.at(-1)!.lastComponent).toBe(nativeResult);
		component.updateResult({ content: [{ type: "text", text: "FINAL_OWNED" }], isError: false }, false);
		expect(contexts.at(-1)!.isPartial).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		setToolRendererEnabled(false);
		expect(component.render(80).join("\n")).toContain("NATIVE_RESULT");
		session.shutdown();
	});

	it("clears the animation transaction after a detached UI throws, so later ordinary mutations stay visible", () => {
		setToolRendererImplementation({ createToolView, layoutToolView });
		const session = trackedSession();
		const live = semanticRead(session, "throwing-clock");
		live.component.markExecutionStarted();
		const result = { content: [{ type: "text" as const, text: "BEFORE_THROW" }], details: {}, isError: false };
		live.component.updateResult(result, true);
		session.executionStarted("throwing-clock");
		live.component.render(80);
		live.ui.requestRender.mockImplementationOnce(() => { throw new Error("detached"); });
		vi.advanceTimersByTime(80);
		expect(vi.getTimerCount()).toBe(0);
		result.content[0]!.text = "AFTER_THROW_MUTATION";
		live.component.updateResult(result, true);
		const after = live.component.render(80).map(stripTerminalSequences).join("\n");
		expect(after).toContain("AFTER_THROW_MUTATION");
		expect(after).not.toContain("BEFORE_THROW");
		session.shutdown();
	});

	it("treats extra callbacks in a custom invalidation as ordinary source updates", () => {
		const factory = vi.fn(createToolView);
		setToolRendererImplementation({ createToolView: factory, layoutToolView });
		const session = trackedSession();
		const info = { name: "write", sourceInfo: { source: "builtin", path: "builtin:write" } } as ToolInfo;
		const renderer = createToolRendererResolver({ getAllTools: () => [info] }, session)("write", () => undefined)!;
		const args = { path: "/tmp/reentrant.txt", content: "BEFORE_REENTRY" };
		let extra = false;
		let call: Component;
		const ctx: ToolContext = { args, state: {}, toolCallId: "reentrant", cwd: process.cwd(), lastComponent: undefined,
			executionStarted: false, argsComplete: true, isPartial: true, expanded: true, showImages: false, isError: false, durationMs: undefined, outputPad: 1,
			invalidate: () => {
				call.invalidate();
				call = renderer.renderCall!(args, theme, { ...ctx, lastComponent: call });
				if (extra) {
					args.content = "EXTRA_CALLBACK_CHANGED_BODY";
					call = renderer.renderCall!(args, theme, { ...ctx, lastComponent: call });
				}
			},
		};
		call = renderer.renderCall!(args, theme, ctx);
		ctx.executionStarted = true;
		session.executionStarted("reentrant");
		expect(call.render(80).map(stripTerminalSequences).join("\n")).toContain("BEFORE_REENTRY");
		const count = factory.mock.calls.length;
		vi.advanceTimersByTime(80);
		call.render(80);
		expect(factory).toHaveBeenCalledTimes(count);
		extra = true;
		vi.advanceTimersByTime(80);
		expect(call.render(80).map(stripTerminalSequences).join("\n")).toContain("EXTRA_CALLBACK_CHANGED_BODY");
		expect(factory).toHaveBeenCalledTimes(count + 1);
		session.shutdown();
	});

	for (const kind of ["generic", "interactive"] as const) it(`keeps ${kind} callbacks and time-sensitive child invalidation on the ordinary path`, () => {
		const child: Component = {
			render: () => [`OPAQUE_TIME_${Date.now()}`],
			invalidate: vi.fn(),
			...(kind === "interactive" ? { handleInput: vi.fn() } : {}),
		};
		const factory = vi.fn((...args: Parameters<typeof createToolView>) => {
			const view = createToolView(...args);
			return kind === "interactive" ? { ...view, sections: [{ component: child, slot: "result" as const }] } : view;
		});
		setToolRendererImplementation({ createToolView: factory, layoutToolView });
		const name = kind === "generic" ? "opaque" : "read";
		const downstream = { renderCall: vi.fn(() => child) };
		const info = { name, sourceInfo: { source: kind === "generic" ? "extension" : "builtin", path: kind === "generic" ? "/opaque.ts" : "builtin:read" } } as ToolInfo;
		const session = trackedSession();
		const renderer = createToolRendererResolver({ getAllTools: () => [info] }, session)(name, () => downstream)!;
		const component = new ToolExecutionComponent(name, `live-${kind}`, { path: "/tmp/opaque.txt" }, {}, renderer, { requestRender: vi.fn() } as never, process.cwd());
		component.markExecutionStarted();
		session.executionStarted(`live-${kind}`);
		const before = component.render(80).map(stripTerminalSequences).join("\n");
		expect(before).toContain(`OPAQUE_TIME_${Date.now()}`);
		const factoryCount = factory.mock.calls.length;
		const callbackCount = downstream.renderCall.mock.calls.length;
		vi.advanceTimersByTime(80);
		const after = component.render(80).map(stripTerminalSequences).join("\n");
		expect(after).toContain(`OPAQUE_TIME_${Date.now()}`);
		expect(after).not.toBe(before);
		expect(factory.mock.calls.length).toBeGreaterThan(factoryCount);
		if (kind === "generic") {
			expect(child.invalidate).toHaveBeenCalled();
			expect(downstream.renderCall.mock.calls.length).toBeGreaterThan(callbackCount);
		}
		session.shutdown();
	});
});
