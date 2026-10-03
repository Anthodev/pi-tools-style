import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, hyperlink, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type * as TuiModule from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { layoutToolView } from "../src/frame.js";
import { setIconMode } from "../src/settings.js";
import { clearToolSpinners, getToolSpinnerFrame, setToolSpinnerActive, toolSpinnerFrame } from "../src/tool-spinner.js";
import type { ToolSnapshot, ToolView } from "../src/tool-presentation.js";
import type { ToolLayout } from "../src/tool-renderer.js";

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof TuiModule>();
	return {
		...actual,
		visibleWidth: vi.fn(actual.visibleWidth),
		wrapTextWithAnsi: vi.fn(actual.wrapTextWithAnsi),
	};
});


const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	getBgAnsi: () => "",
} as unknown as Theme;

function snapshot(hasResult = true, padding = 1): ToolSnapshot {
	return {
		args: {},
		...(hasResult ? { result: { content: [], details: undefined } } : {}),
		context: {
			args: {},
			toolCallId: "frame-layout-fixture",
			state: {},
			lastComponent: undefined,
			invalidate: vi.fn(),
			cwd: process.cwd(),
			executionStarted: false,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: true,
			isError: false,
			durationMs: undefined,
			outputPad: padding,
		},
		presentation: "builtin",
	};
}

function view(overrides: Partial<ToolView> = {}): ToolView {
	return {
		layout: "framed",
		head: { title: "Bash", target: "$ pwd", meta: [], status: "done" },
		sections: [],
		expanded: false,
		...overrides,
	};
}

function rows(layout: ToolLayout): string[] {
	return [...layout.callRows, ...layout.resultRows].map(stripTerminalSequences);
}

beforeEach(() => {
	initTheme("dark", false);
});

afterEach(() => {
	setIconMode("ascii");
	vi.restoreAllMocks();
});

describe("layoutToolView", () => {
	it("preserves a target summary when long metadata competes for header space", () => {
		const header = rows(layoutToolView(view({
			head: { title: "Read", target: "PATH-marker-long", meta: ["metadata".repeat(10)], status: "done" },
		}), snapshot(), plainTheme, 40))[0]!;
		expect(header).toContain("PATH");
		expect(header).toContain("ok");
		expect(visibleWidth(header)).toBe(40);
	});

	it("preserves generic downstream whitespace and rules rather than trimming them", () => {
		const component = { render: () => ["", "────", "  BODY  ", ""], invalidate() {} };
		const layout = layoutToolView(view({ sections: [{ slot: "result", component }] }), { ...snapshot(), presentation: "generic" }, plainTheme, 30);
		expect(layout.resultChildBounds[0]?.height).toBe(4);
		expect(stripTerminalSequences(layout.resultRows[1]!)).toContain("────");
		expect(stripTerminalSequences(layout.resultRows[2]!)).toContain("  BODY  ");
		expect(layout.resultRows).toHaveLength(5);
	});

	it("renders a repeated original child once while recording each fragment origin", () => {
		const component = { render: vi.fn(() => ["CHILD"]), invalidate() {} };
		const layout = layoutToolView(view({
			sections: [{ slot: "call", component }, { slot: "result", component }],
		}), snapshot(), plainTheme, 30);
		expect(component.render).toHaveBeenCalledExactlyOnceWith(26);
		expect(layout.callChildBounds[0]?.y).toBe(1);
		expect(layout.resultChildBounds[0]?.y).toBe(0);
		expect(layout.callChildBounds[0]?.component).toBe(component);
		expect(layout.resultChildBounds[0]?.component).toBe(component);
	});

	it("restores all preview rows on expansion without changing component ownership", () => {
		const component = new Text("L01\nL02\nL03\nL04", 0, 0);
		const sections: ToolView["sections"] = [{ slot: "result", component }];
		const preview: ToolView["preview"] = { edge: "tail", count: 2, unit: "visual-lines" };
		const collapsed = layoutToolView(view({ sections, preview }), snapshot(), plainTheme, 40);
		expect(collapsed.resultRows.join("\n")).not.toContain("L01");
		expect(collapsed.resultRows.join("\n")).toContain("L03");
		expect(collapsed.resultRows.join("\n")).toContain("2 more lines");
		const expanded = layoutToolView(view({ sections, preview, expanded: true }), snapshot(), plainTheme, 40);
		expect(expanded.resultRows.join("\n")).toContain("L01");
		expect(expanded.resultRows.join("\n")).not.toContain("more lines");
		expect(expanded.resultChildBounds[0]?.component).toBe(component);
		expect(expanded.resultChildBounds[0]?.height).toBe(4);
	});

	it.each([
		["pending", undefined, "accent", "toolPendingBg"],
		["running", undefined, "accent", "toolPendingBg"],
		["done", undefined, "borderMuted", "toolSuccessBg"],
		["error", undefined, "error", "toolErrorBg"],
		["cancelled", undefined, "warning", "toolSuccessBg"],
		["done", "warning", "warning", "toolSuccessBg"],
		["done", "error", "error", "toolErrorBg"],
	] as const)("uses the %s state and %s tone for border/background", (status, tone, border, background) => {
		const fg = vi.fn((_color: string, text: string) => text);
		const getBgAnsi = vi.fn(() => "");
		const theme = { ...plainTheme, fg, getBgAnsi } as unknown as Theme;
		layoutToolView(view({ ...(tone ? { tone } : {}), head: { title: "Read", target: "", meta: [], status } }), snapshot(), theme, 40);
		expect(fg).toHaveBeenCalledWith(border, "╭───");
		expect(getBgAnsi).toHaveBeenCalledWith(background);
	});

	it("groups intact children into call/result slots with a single result-owned closure", () => {
		const call = new Text("CALL", 0, 0);
		const result = new Text("RESULT", 0, 0);
		const callRender = vi.spyOn(call, "render");
		const resultRender = vi.spyOn(result, "render");
		const layout = layoutToolView(view({
			sections: [
				{ slot: "result", label: "Output", component: result },
				{ slot: "call", label: "Arguments", component: call },
			],
		}), snapshot(), plainTheme, 40);
		expect(layout.callRows.join("\n")).toContain("CALL");
		expect(layout.callRows.join("\n")).not.toContain("RESULT");
		expect(layout.resultRows.join("\n")).toContain("RESULT");
		expect(layout.resultRows.at(-1)).toMatch(/^╰/u);
		expect(rows(layout).filter((line) => line.startsWith("╰"))).toHaveLength(1);
		expect(layout.resultOffset).toBe(layout.callRows.length);
		expect(layout.callChildBounds).toEqual([{ component: call, x: 2, y: 2, width: 36, height: 1 }]);
		expect(layout.resultChildBounds).toEqual([{ component: result, x: 2, y: 1, width: 36, height: 1 }]);
		expect(callRender).toHaveBeenCalledExactlyOnceWith(36);
		expect(resultRender).toHaveBeenCalledExactlyOnceWith(36);
	});

	it("keeps the complete pre-result card in call and empty sections do not add output", () => {
		const empty = new Text("", 0, 0);
		const layout = layoutToolView(view({ sections: [{ slot: "call", label: "Nothing", component: empty }] }), snapshot(false), plainTheme, 30);
		expect(layout.resultRows).toEqual([]);
		expect(layout.callRows).toHaveLength(2);
		expect(rows(layout).join("\n")).not.toContain("Nothing");
		expect(layout.callChildBounds).toEqual([]);
		const completed = layoutToolView(view(), snapshot(), plainTheme, 30);
		expect(completed.resultRows).toHaveLength(1);
		expect(completed.resultRows[0]).toMatch(/^╰/u);
	});

	it.each(["Bash", "Shell", "Read"])("moves the expanded multiline %s target into call exactly once", (title) => {
		const target = "first-target-marker\nsecond-target-marker";
		const layout = layoutToolView(view({ expanded: true, head: { title, target, meta: [], status: "done" } }), snapshot(), plainTheme, 40);
		const rendered = rows(layout);
		expect(rendered[0]).not.toContain("first-target-marker");
		expect(rendered.join("\n").match(/first-target-marker/gu)).toHaveLength(1);
		expect(rendered.join("\n")).toContain(title === "Read" ? "Target" : "Command");
		expect(layout.resultRows.join("\n")).not.toContain("second-target-marker");
	});

	it("summarizes long targets while collapsed and reveals them on expansion", () => {
		const target = "TARGET_" + "x".repeat(70);
		const head = { title: "Read", target, meta: [], status: "done" as const };
		const collapsed = rows(layoutToolView(view({ head }), snapshot(), plainTheme, 30));
		expect(collapsed).toHaveLength(2);
		expect(collapsed[0]).toContain("TARGET");
		expect(collapsed[0]).toContain("…");
		const expanded = rows(layoutToolView(view({ head, expanded: true }), snapshot(), plainTheme, 30));
		expect(expanded[0]).not.toContain("TARGET");
		expect(expanded.join("\n")).toContain("Target");
		const unfolded = expanded.join("").replace(/[│\s]/gu, "");
		expect(unfolded.split(target)).toHaveLength(2);
	});

	it.each(["head", "tail"] as const)("clamps visual previews at the %s after wrapping without clamping warnings", (edge) => {
		const component = { render: () => ["abcdefghijklmnop", "LAST"], invalidate() {} };
		const layout = layoutToolView(view({
			head: { title: "Bash", target: "", meta: [], status: "done" },
			preview: { edge, count: 2, unit: "visual-lines" },
			sections: [
				{ slot: "result", component },
				{ slot: "result", label: "Warning", component: new Text("WARNING_ALWAYS", 0, 0), preview: false },
			],
		}), snapshot(), plainTheme, 12);
		const rendered = rows(layout).join("\n");
		expect(rendered).toContain(edge === "head" ? "abcdefgh" : "ijklmnop");
		expect(rendered.includes("LAST")).toBe(edge === "tail");
		expect(rendered).toContain("more");
		expect(rendered).toContain("lines");
		expect(rendered).toContain("WARNING_");
	});

	it("selects complete logical entries before wrapping and counts hidden entries", () => {
		const entryLines = Array.from({ length: 7 }, (_, i) => `file-${i + 1}-long-path`);
		const component = { entryLines, render: vi.fn(() => entryLines), invalidate() {} };
		const layout = layoutToolView(view({
			layout: "inline",
			preview: { edge: "head", count: 5, unit: "entries" },
			sections: [{ slot: "result", component }],
		}), snapshot(), plainTheme, 12);
		const rendered = rows(layout).join("\n");
		expect(rendered).toContain("file-5-");
		expect(rendered).not.toContain("file-6-");
		expect(rendered).toContain("entries");
		expect(rendered).toContain("2 more");
		expect(component.render).toHaveBeenCalledOnce();
	});

	it("does not slice interactive children or add a generic preview", () => {
		const interactive: Component = {
			render: vi.fn(() => ["A", "B", "C", "D"]),
			handleMouse: () => ({ handled: true }),
			invalidate() {},
		};
		const layout = layoutToolView(view({
			preview: { edge: "tail", count: 1, unit: "visual-lines" },
			sections: [{ slot: "result", component: interactive }],
		}), snapshot(), plainTheme, 30);
		expect(layout.resultChildBounds[0]?.height).toBe(4);
		expect(rows(layout).join("\n")).toContain("A");
		expect(rows(layout).join("\n")).not.toContain("more lines");
		const generic = layoutToolView(view({
			sections: [{ slot: "result", component: new Text("A\nB\nC\nD", 0, 0) }],
		}), { ...snapshot(), presentation: "generic" }, plainTheme, 30);
		expect(generic.resultChildBounds[0]?.height).toBe(4);
	});

	it.each([0, 1, 2])("preserves Unicode/ANSI/link widths and child origins at padding %s", (padding) => {
		const component = new Text(`\u001b[31m界é\u001b[0m ${hyperlink("LINK", "https://example.org")}\nsecond`, 0, 0);
		const layout = layoutToolView(view({ sections: [{ slot: "result", component }] }), snapshot(true, padding), plainTheme, 24);
		expect(rows(layout).every((line) => visibleWidth(line) === 24)).toBe(true);
		expect(layout.resultChildBounds[0]?.x).toBe(1 + padding);
		expect(layout.resultChildBounds[0]?.width).toBe(22 - 2 * padding);
		expect(layout.resultRows.join("\n")).toContain("\u001b]8;;https://example.org\u001b\\");
		expect(rows(layout).join("\n")).toContain("LINK");
	});

	it("keeps inline child origins local and adds no frame", () => {
		const component = new Text("BODY", 0, 0);
		const layout = layoutToolView(view({ layout: "inline", sections: [{ slot: "result", label: "Output", component }] }), snapshot(true, 2), plainTheme, 30);
		expect(rows(layout).join("\n")).not.toMatch(/[╭│╰]/u);
		expect(layout.resultChildBounds).toEqual([{ component, x: 2, y: 1, width: 26, height: 1 }]);
		expect(layout.resultOffset).toBe(1);
	});

	it("styles state border independently and reapplies backgrounds after reset and 49", () => {
		const colors: string[] = [];
		const theme = {
			fg: (color: string, text: string) => { colors.push(color); return `\u001b[31m${text}\u001b[39m`; },
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
			getBgAnsi: () => "\u001b[44m",
		} as unknown as Theme;
		const layout = layoutToolView(view({
			tone: "error",
			sections: [{ slot: "result", component: { render: () => ["a\u001b[0mb\u001b[49mc"], invalidate() {} } }],
		}), snapshot(), theme, 30);
		expect(colors).toContain("error");
		expect(colors).toContain("toolTitle");
		expect(colors).toContain("toolOutput");
		const body = layout.resultRows[0]!;
		expect(body).toContain("\u001b[0m\u001b[44m");
		expect(body).toContain("\u001b[49m\u001b[44m");
		expect(body.startsWith("\u001b[44m")).toBe(true);
	});

	it.each(["ascii", "nerd-font", "off"] as const)("keeps status understandable in %s icon mode and formats only final finite durations", (mode) => {
		setIconMode(mode);
		for (const status of ["pending", "running", "done", "error", "cancelled"] as const) {
			const layout = layoutToolView(view({ head: { title: "Read", target: "", meta: ["meta"], status, durationMs: 1250 } }), snapshot(), plainTheme, 80);
			const header = rows(layout)[0]!;
			const statusSymbols = {
				pending: mode === "nerd-font" ? "○" : "?",
				running: mode === "nerd-font" ? "⠋" : "|",
				done: mode === "nerd-font" ? "✓" : "ok",
				error: mode === "nerd-font" ? "✗" : "!",
				cancelled: mode === "nerd-font" ? "⊘" : "-",
			};
			if (status !== "running" || mode === "off") {
				expect(header).toContain(mode === "off" ? status : statusSymbols[status]);
			} else {
				expect(header).toMatch(mode === "nerd-font" ? /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u : /[|/\\-]/u);
			}
			expect(header.includes("1.3s")).toBe(status === "done" || status === "error" || status === "cancelled");
		}
		for (const durationMs of [undefined, NaN, Infinity, -1]) {
			const header = rows(layoutToolView(view({ head: { title: "Read", target: "", meta: [], status: "done", ...(durationMs === undefined ? {} : { durationMs }) } }), snapshot(), plainTheme, 80))[0]!;
			expect(header).not.toMatch(/\d(?:ms|s)/u);
		}
		expect(rows(layoutToolView(view({ head: { title: "Read", target: "", meta: [], status: "done", durationMs: 42 } }), snapshot(), plainTheme, 80))[0]).toContain("42ms");
	});

	it.each([
		"\u001b_Ga=T;DATA\u001b\\",
		"\u001b]1337;File=x:DATA\u0007",
		"\u001bPqDATA\u001b\\",
		"\u0090qDATA\u009c",
		"\u001bP0;1;0qDATA\u001b\\",
		"\u00900;1;0qDATA\u009c",
	])("preserves terminal images intact without framing, trimming or rendering twice", (image) => {
		const call = { render: vi.fn(() => ["", "CALL", ""]), invalidate() {} };
		const result = { render: vi.fn(() => ["", image, ""]), invalidate() {} };
		const layout = layoutToolView(view({ preview: { edge: "head", count: 1, unit: "visual-lines" }, sections: [{ slot: "call", component: call }, { slot: "result", component: result }] }), snapshot(), plainTheme, 30);
		expect(layout.callRows).toEqual(["", "CALL", ""]);
		expect(layout.resultRows).toEqual(["", image, ""]);
		expect(layout.callChildBounds).toEqual([{ component: call, x: 0, y: 0, width: 26, height: 3 }]);
		expect(layout.resultOffset).toBe(3);
		expect(layout.resultChildBounds).toEqual([{ component: result, x: 0, y: 0, width: 26, height: 3 }]);
		expect(call.render).toHaveBeenCalledOnce();
		expect(result.render).toHaveBeenCalledOnce();
	});
});

describe("running header spinner isolation", () => {
	it("keeps an unenrolled running header static while an enrolled target ticks", () => {
		vi.useFakeTimers();
		clearToolSpinners();
		setIconMode("nerd-font");
		try {
			const liveState = {};
			setToolSpinnerActive({ state: liveState, invalidate: vi.fn() }, true);
			const replayState = {};
			const running = view({ head: { title: "Bash", target: "$ sleep 1", meta: [], status: "running" } });
			const headerOf = (state: object): string => {
				const base = snapshot();
				const layout = layoutToolView(running, { ...base, context: { ...base.context, state } }, plainTheme, 80);
				return stripTerminalSequences(layout.callRows[0]!);
			};
			const replayBefore = headerOf(replayState);
			const liveBefore = headerOf(liveState);
			expect(replayBefore).toContain(toolSpinnerFrame(replayState, "nerd-font"));
			vi.advanceTimersByTime(80);
			expect(headerOf(replayState)).toBe(replayBefore);
			expect(headerOf(liveState)).not.toBe(liveBefore);
		} finally {
			clearToolSpinners();
			setIconMode("ascii");
			vi.useRealTimers();
		}
	});
});

describe("prepared semantic headers", () => {
	it.each(["ascii", "nerd-font"] as const)("refreshes an expanded %s header in place without rendering shared output or its full target again", (mode) => {
		setIconMode(mode);
		const target = "FULL_TARGET|" + "界é".repeat(500);
		const component = new Text(Array.from({ length: 2000 }, (_, index) => `BODY_${index}`).join("\n"), 0, 0);
		const render = vi.spyOn(Text.prototype, "render");
		const layout = layoutToolView(view({
			expanded: true,
			head: { title: "Write", target, meta: ["2000 lines"], status: "running" },
			sections: [
				{ slot: "call", component, renderedWidth: "padded" },
				{ slot: "result", component, renderedWidth: "padded" },
			],
		}), snapshot(), plainTheme, 80, 0);
		expect(layout.refreshHeader).toBeTypeOf("function");
		expect(render).toHaveBeenCalledTimes(2);
		expect(layout.callChildBounds[0]?.component).not.toBe(component);
		expect(layout.callChildBounds[1]?.component).toBe(component);
		expect(layout.resultChildBounds[0]?.component).toBe(component);
		expect(rows(layout).join("\n").match(/FULL_TARGET/gu)).toHaveLength(1);
		expect(layout.callChildBounds[1]?.height).toBe(2000);
		const callRows = layout.callRows;
		const resultRows = layout.resultRows;
		const callBounds = layout.callChildBounds;
		const resultBounds = layout.resultChildBounds;
		const bodyBefore = callRows.slice(1);
		const resultBefore = [...resultRows];
		const offset = layout.resultOffset;
		const fullTargetBounds = { ...callBounds[0] };
		let previousHeader = callRows[0];
		let bodyReads = 0;
		for (const [output, firstBodyRow] of [[callRows, 1], [resultRows, 0]] as const) {
			for (let index = firstBodyRow; index < output.length; index++) {
				const row = output[index];
				Object.defineProperty(output, index, { get: () => { bodyReads++; return row; } });
			}
		}
		vi.mocked(visibleWidth).mockClear();
		for (const frame of [1, 2, 3]) {
			const readsBefore = bodyReads;
			layout.refreshHeader!(frame);
			expect(bodyReads).toBe(readsBefore);
			expect(callRows[0]).not.toBe(previousHeader);
			expect(stripTerminalSequences(callRows[0]!)).toContain(getToolSpinnerFrame(mode, frame));
			expect(layout.callRows).toBe(callRows);
			expect(layout.resultRows).toBe(resultRows);
			expect(layout.callChildBounds).toBe(callBounds);
			expect(layout.resultChildBounds).toBe(resultBounds);
			expect(layout.resultOffset).toBe(offset);
			expect(callRows.slice(1)).toEqual(bodyBefore);
			expect(resultRows).toEqual(resultBefore);
			expect(callBounds[0]).toEqual(fullTargetBounds);
			previousHeader = callRows[0];
		}
		expect(render).toHaveBeenCalledTimes(2);
		expect(vi.mocked(visibleWidth).mock.calls.some(([text]) => text.includes("FULL_TARGET"))).toBe(false);
	});

	it.each(["ascii", "nerd-font"] as const)("changes only the %s running status when title, metadata and linked command contain spinner glyphs", (mode) => {
		setIconMode(mode);
		const command = `echo "| - / \\ ⠋ ⠙" ${hyperlink("LINK", "https://example.org/?glyph=|")}`;
		const title = "Bash | - ⠋";
		const meta = "meta | - ⠙";
		const running = view({ head: { title, target: command, meta: [meta], status: "running" } });
		const layout = layoutToolView(running, snapshot(), plainTheme, 120, 0);
		expect(layout.refreshHeader).toBeTypeOf("function");
		const before = layout.callRows[0]!;
		for (const frame of [1, 2, 3]) {
			layout.refreshHeader!(frame);
			const header = layout.callRows[0]!;
			expect(header).not.toBe(before);
			expect(header).toContain(command);
			expect(header).toContain(title);
			expect(header).toContain(meta);
			expect(visibleWidth(stripTerminalSequences(header))).toBe(120);
			expect(header).toBe(layoutToolView(running, snapshot(), plainTheme, 120, frame).callRows[0]);
		}
	});

	it("prepares the full-target decision again on resize but keeps target placement stable on header clocks", () => {
		const target = "TARGET_" + "x".repeat(35);
		const running = view({ expanded: true, head: { title: "Read", target, meta: [], status: "running" } });
		const render = vi.spyOn(Text.prototype, "render");
		const wide = layoutToolView(running, snapshot(), plainTheme, 120, 0);
		const narrow = layoutToolView(running, snapshot(), plainTheme, 40, 0);
		expect(wide.refreshHeader).toBeTypeOf("function");
		expect(narrow.refreshHeader).toBeTypeOf("function");
		expect(wide.callRows[0]).toContain(target);
		expect(wide.callChildBounds).toEqual([]);
		expect(narrow.callRows[0]).not.toContain("TARGET_");
		expect(narrow.callChildBounds).toHaveLength(1);
		expect(narrow.callChildBounds[0]?.y).toBe(2);
		expect(render).toHaveBeenCalledExactlyOnceWith(36);
		const before = narrow.callRows.slice(1);
		for (const frame of [1, 2, 3]) {
			wide.refreshHeader!(frame);
			narrow.refreshHeader!(frame);
			expect(wide.callRows[0]).toContain(target);
			expect(narrow.callRows.slice(1)).toEqual(before);
		}
		expect(render).toHaveBeenCalledOnce();
	});

	it.each(["ascii", "nerd-font", "off"] as const)("preserves prepared %s truncation at narrow header widths", (mode) => {
		setIconMode(mode);
		for (const width of [1, 5, 7, 8, 10, 24]) {
			const running = view({ head: { title: "Read |", target: "界é", meta: ["meta -"], status: "running" } });
			const layout = layoutToolView(running, snapshot(), plainTheme, width, 0);
			expect(layout.refreshHeader).toBeTypeOf("function");
			for (const frame of [1, 2, 3]) {
				layout.refreshHeader!(frame);
				expect(layout.callRows[0]).toBe(layoutToolView(running, snapshot(), plainTheme, width, frame).callRows[0]);
			}
		}
	});

	it("uses the public state clock without copying inline card rows or changing local child origins", () => {
		vi.useFakeTimers();
		clearToolSpinners();
		try {
			const base = snapshot();
			const target = { state: base.context.state, invalidate: vi.fn() };
			setToolSpinnerActive(target, true);
			const component = new Text("BODY\nSECOND", 0, 0);
			const render = vi.spyOn(component, "render");
			const layout = layoutToolView(view({
				layout: "inline",
				head: { title: "Bash", target: "$ sleep 1", meta: [], status: "running" },
				sections: [{ slot: "result", component, renderedWidth: "padded" }],
			}), base, plainTheme, 80);
			expect(layout.refreshHeader).toBeTypeOf("function");
			const callRows = layout.callRows;
			const resultRows = layout.resultRows;
			const bounds = layout.resultChildBounds;
			const before = callRows[0];
			vi.advanceTimersByTime(80);
			layout.refreshHeader!();
			expect(callRows[0]).not.toBe(before);
			expect(stripTerminalSequences(callRows[0]!)).toContain(toolSpinnerFrame(base.context.state, "ascii"));
			expect(layout.callRows).toBe(callRows);
			expect(layout.resultRows).toBe(resultRows);
			expect(layout.resultChildBounds).toBe(bounds);
			expect(bounds).toEqual([{ component, x: 1, y: 0, width: 78, height: 2 }]);
			expect(rows(layout).join("\n")).toContain("SECOND");
			expect(render).toHaveBeenCalledOnce();
		} finally {
			clearToolSpinners();
			vi.useRealTimers();
		}
	});

	it("retains styled static header preparation and linked content while recoloring only its running glyph", () => {
		const fg = vi.fn((_color: string, text: string) => `\u001b[31m${text}\u001b[0m`);
		const theme = {
			fg,
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
			getBgAnsi: () => "\u001b[44m",
		} as unknown as Theme;
		const command = hyperlink("LINK |", "https://example.org/path");
		const layout = layoutToolView(view({ head: { title: "Bash", target: command, meta: ["META"], status: "running" } }), snapshot(), theme, 80, 0);
		expect(layout.refreshHeader).toBeTypeOf("function");
		fg.mockClear();
		vi.mocked(visibleWidth).mockClear();
		for (const frame of [1, 2, 3]) {
			layout.refreshHeader!(frame);
			expect(layout.callRows[0]).toContain(command);
			expect(layout.callRows[0]).toContain("\u001b[0m\u001b[44m");
			expect(layout.callRows[0]?.startsWith("\u001b[44m")).toBe(true);
			expect(stripTerminalSequences(layout.callRows[0]!)).toContain("META");
		}
		expect(fg.mock.calls).toEqual([["accent", "/"], ["accent", "-"], ["accent", "\\"]]);
		expect(vi.mocked(visibleWidth)).not.toHaveBeenCalled();
	});

	it.each(["ascii", "nerd-font", "off"] as const)("keeps every %s spinner frame one cell wide and preserves static OFF status", (mode) => {
		for (let frame = 0; frame < 10; frame++) expect(visibleWidth(getToolSpinnerFrame(mode, frame))).toBe(1);
		setIconMode(mode);
		const layout = layoutToolView(view({ head: { title: "Read", target: "", meta: [], status: "running" } }), snapshot(), plainTheme, 40, 0);
		expect(layout.refreshHeader).toBeTypeOf("function");
		const before = layout.callRows[0];
		layout.refreshHeader!(1);
		if (mode === "off") {
			expect(layout.callRows[0]).toBe(before);
			expect(stripTerminalSequences(layout.callRows[0]!)).toContain("running");
		} else {
			expect(layout.callRows[0]).not.toBe(before);
			expect(stripTerminalSequences(layout.callRows[0]!)).toContain(getToolSpinnerFrame(mode, 1));
		}
	});

	it.each(["mouse", "keyboard", "generic"] as const)("does not offer a body-skipping header capability for %s children", (kind) => {
		const component: Component = {
			render: () => ["A", "B", "C"],
			invalidate() {},
			...(kind === "mouse" ? { handleMouse: () => ({ handled: true }) } : {}),
			...(kind === "keyboard" ? { handleInput: () => {} } : {}),
		};
		const layout = layoutToolView(view({
			head: { title: "Tool", target: "", meta: [], status: "running" },
			preview: { edge: "tail", count: 1, unit: "visual-lines" },
			sections: [{ slot: "result", component, renderedWidth: "padded" }],
		}), { ...snapshot(), presentation: kind === "generic" ? "generic" : "builtin" }, plainTheme, 30, 0);
		expect(layout.refreshHeader).toBeUndefined();
		expect(layout.resultChildBounds).toEqual([{ component, x: 2, y: 0, width: 26, height: 3 }]);
		expect(rows(layout).join("\n")).toContain("A");
		expect(rows(layout).join("\n")).not.toContain("more lines");
	});
});

describe("owned padded rows and exact previews", () => {
	it.each([24, 80, 120])("keeps exact Unicode/ANSI/link head and tail visual previews at width %s for every padding", (width) => {
		for (const padding of [0, 1, 2]) {
			for (const edge of ["head", "tail"] as const) {
				const source = Array.from({ length: 18 }, (_, index) =>
					`\u001b[31mROW_${index} 界é 👩‍💻\u001b[0m ${hyperlink("LINK", "https://example.org/long-url")} ${"abcdefgh ".repeat(15)}`,
				).join("\n");
				const component = new Text(source, 0, 0);
				const childWidth = width - 2 - 2 * padding;
				const complete = component.render(childWidth);
				const count = 3;
				const selected = edge === "head" ? complete.slice(0, count) : complete.slice(-count);
				const hidden = complete.length - count;
				for (const marked of [false, true]) {
					const render = vi.spyOn(component, "render");
					const layout = layoutToolView(view({
						preview: { edge, count, unit: "visual-lines" },
						sections: [
							{ slot: "result", component, ...(marked ? { renderedWidth: "padded" as const } : {}) },
							{ slot: "result", component: new Text("WARNING", 0, 0), preview: false },
						],
					}), snapshot(true, padding), plainTheme, width);
					const expected = selected.map((line) =>
						`│${" ".repeat(padding)}${stripTerminalSequences(line)}${" ".repeat(padding)}│`,
					);
					expect(layout.resultRows.slice(0, count).map(stripTerminalSequences)).toEqual(expected);
					expect(rows(layout).join("\n")).toContain(`${hidden} more lines`);
					expect(rows(layout).join("\n")).toContain("WARNING");
					expect(rows(layout).every((line) => visibleWidth(line) === width)).toBe(true);
					const link = "\u001b]8;;https://example.org/long-url\u001b\\";
					expect(layout.resultRows.slice(0, count).some((line) => line.includes(link))).toBe(selected.some((line) => line.includes(link)));
					expect(layout.resultChildBounds[0]).toEqual({ component, x: 1 + padding, y: 0, width: childWidth, height: count });
					expect(render).toHaveBeenCalledExactlyOnceWith(childWidth);
					render.mockRestore();
				}
			}
		}
	});

	it("does not rescan or refill fully wrapped padded output, but still wraps an unmarked oversized custom child", () => {
		const component = new Text(Array.from({ length: 100 }, (_, index) => `ROW_${index} ${"界é ".repeat(20)}`).join("\n"), 0, 0);
		const complete = component.render(36);
		vi.mocked(visibleWidth).mockClear();
		vi.mocked(wrapTextWithAnsi).mockClear();
		const layout = layoutToolView(view({
			preview: { edge: "tail", count: 2, unit: "visual-lines" },
			sections: [{ slot: "result", component, renderedWidth: "padded" }],
		}), snapshot(), plainTheme, 40);
		const measuredRows = vi.mocked(visibleWidth).mock.calls.map(([line]) => line);
		const wrappedRows = vi.mocked(wrapTextWithAnsi).mock.calls.map(([line]) => line);
		expect(complete.some((line) => measuredRows.includes(line) || wrappedRows.includes(line))).toBe(false);
		expect(layout.resultRows.slice(0, 2).map(stripTerminalSequences)).toEqual(complete.slice(-2).map((line) => `│ ${line} │`));
		expect(rows(layout).join("\n")).toContain(`${complete.length - 2} more lines`);

		const raw = "\u001b[31m" + "界é ".repeat(30) + "\u001b[0m\nLAST";
		const custom = { render: vi.fn(() => [raw]), invalidate() {} };
		const expected = wrapTextWithAnsi(raw, 36);
		const fallback = layoutToolView(view({
			preview: { edge: "head", count: 2, unit: "visual-lines" },
			sections: [{ slot: "result", component: custom }],
		}), snapshot(), plainTheme, 40);
		expect(rows(fallback).join("\n")).not.toContain("LAST");
		expect(rows(fallback).join("\n")).toContain(`${expected.length - 2} more lines`);
		expect(fallback.resultChildBounds[0]).toEqual({ component: custom, x: 2, y: 0, width: 36, height: 2 });
		expect(custom.render).toHaveBeenCalledOnce();
	});

	it.each(["head", "tail"] as const)("wraps the selected five logical Find entries at the %s even when its child rows are padded", (edge) => {
		const entryLines = Array.from({ length: 8 }, (_, index) => `entry-${index}-界é-${"path/".repeat(10)}`);
		const component = Object.assign(new Text(entryLines.join("\n"), 0, 0), { entryLines });
		const render = vi.spyOn(component, "render");
		const selected = edge === "head" ? entryLines.slice(0, 5) : entryLines.slice(-5);
		const visual = selected.flatMap((line) => wrapTextWithAnsi(line, 20));
		const layout = layoutToolView(view({
			head: { title: "Find", target: "", meta: [], status: "done" },
			preview: { edge, count: 5, unit: "entries" },
			sections: [{ slot: "result", component, renderedWidth: "padded" }],
		}), snapshot(), plainTheme, 24);
		expect(layout.resultRows.slice(0, visual.length).map(stripTerminalSequences)).toEqual(visual.map((line) =>
			`│ ${stripTerminalSequences(line)}${" ".repeat(Math.max(0, 20 - visibleWidth(line)))} │`,
		));
		expect(rows(layout).join("\n")).toContain("3 more entries");
		expect(rows(layout).join("\n")).not.toContain(edge === "head" ? "entry-5" : "entry-0");
		expect(layout.resultChildBounds[0]?.height).toBe(visual.length);
		expect(render).toHaveBeenCalledExactlyOnceWith(20);
	});

	it.each([
		["framed", 5, 1],
		["framed", 6, 1],
		["inline", 1, 0],
		["inline", 2, 0],
		["inline", 3, 0],
	] as const)("preserves defensive wide-grapheme and combining content in %s width %s padding %s", (kind, width, padding) => {
		const component = new Text(`\u001b[31m界é👩‍💻\u001b[0m\n界`, 0, 0);
		const base = view({
			layout: kind,
			head: { title: "Read", target: "", meta: [], status: "done" },
			expanded: true,
		});
		const defensive = layoutToolView({ ...base, sections: [{ slot: "result", component }] }, snapshot(true, padding), plainTheme, width);
		const padded = layoutToolView({ ...base, sections: [{ slot: "result", component, renderedWidth: "padded" }] }, snapshot(true, padding), plainTheme, width);
		expect(padded.resultRows).toEqual(defensive.resultRows);
		expect(padded.resultChildBounds).toEqual(defensive.resultChildBounds);
		expect(rows(padded).join("\n")).toContain("界");
		expect(rows(padded).join("\n")).toContain("é");
		expect(rows(padded).join("\n")).toContain("👩‍💻");
	});

	it.each([2, 24, 80])("preserves defensive rows for an Indic grapheme wider than inline width %s", (width) => {
		const cluster = "क्".repeat(width + 1) + "क";
		expect(visibleWidth(cluster)).toBeGreaterThan(width);
		const component = new Text(cluster, 0, 0);
		const base = view({ layout: "inline", head: { title: "Read", target: "", meta: [], status: "done" }, expanded: true });
		const defensive = layoutToolView({ ...base, sections: [{ slot: "result", component }] }, snapshot(true, 0), plainTheme, width);
		const padded = layoutToolView({ ...base, sections: [{ slot: "result", component, renderedWidth: "padded" }] }, snapshot(true, 0), plainTheme, width);
		expect(padded.resultRows).toEqual(defensive.resultRows);
		expect(padded.resultChildBounds).toEqual(defensive.resultChildBounds);
		expect(rows(padded).join("\n")).toContain(cluster);
	});

	it.each([
		["spacing marks", "\u093e".repeat(5)],
		["halfwidth forms", "\uff76\uff9e"],
		["Thai AM", "\u0e01\u0e33"],
		["Lao AM", "\u0e81\u0eb3"],
		["variation-selector and non-RGI joiner", "e\uFE0F\u200D界"],
	] as const)("preserves the defensive SDK result for %s Unicode rows", (_label, source) => {
		const component = new Text(source + "\nLAST", 0, 0);
		const base = view({
			layout: "inline",
			head: { title: "Read", target: "", meta: [], status: "done" },
			preview: { edge: "tail", count: 3, unit: "visual-lines" },
		});
		for (const width of [1, 2, 3, 24]) {
			const defensive = layoutToolView({ ...base, sections: [{ slot: "result", component }] }, snapshot(true, 0), plainTheme, width);
			const padded = layoutToolView({ ...base, sections: [{ slot: "result", component, renderedWidth: "padded" }] }, snapshot(true, 0), plainTheme, width);
			expect(padded.resultRows).toEqual(defensive.resultRows);
			expect(padded.resultChildBounds).toEqual(defensive.resultChildBounds);
		}
	});

	it.each(["\tAB", "AB\rCD", "AB\nCD"])("keeps conservative control-row wrapping equivalent to unmarked output for %j", (source) => {
		const component = { render: () => [source], invalidate() {} };
		const base = view({ expanded: true });
		const defensive = layoutToolView({ ...base, sections: [{ slot: "result", component }] }, snapshot(true, 0), plainTheme, 6);
		const padded = layoutToolView({ ...base, sections: [{ slot: "result", component, renderedWidth: "padded" }] }, snapshot(true, 0), plainTheme, 6);
		expect(padded.resultRows).toEqual(defensive.resultRows);
		expect(padded.resultChildBounds).toEqual(defensive.resultChildBounds);
	});

	it.each([
		"\u001b_Ga=T;DATA\u001b\\",
		"\u001b]1337;File=x:DATA\u0007",
		"\u001bP0;1;0qDATA\u001b\\",
	])("lets an image in a shared padded child escape the whole card before previews and header preparation", (image) => {
		const component = { render: vi.fn(() => ["", "UNCHANGED", image, ""]), invalidate() {} };
		const layout = layoutToolView(view({
			expanded: true,
			head: { title: "Bash", target: "FULL_TARGET\nSECOND", meta: [], status: "running" },
			preview: { edge: "head", count: 1, unit: "visual-lines" },
			sections: [
				{ slot: "call", component, renderedWidth: "padded" },
				{ slot: "result", component, renderedWidth: "padded" },
			],
		}), snapshot(), plainTheme, 24, 0);
		expect(layout.callRows).toEqual(["", "UNCHANGED", image, ""]);
		expect(layout.resultRows).toEqual(layout.callRows);
		expect(layout.refreshHeader).toBeUndefined();
		expect(layout.callChildBounds).toEqual([{ component, x: 0, y: 0, width: 20, height: 4 }]);
		expect(layout.resultChildBounds).toEqual(layout.callChildBounds);
		expect(layout.resultOffset).toBe(4);
		expect(component.render).toHaveBeenCalledExactlyOnceWith(20);
	});
});
