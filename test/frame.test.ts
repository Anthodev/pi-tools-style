import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, hyperlink, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
		head: { title: "Bash", target: "", meta: [], status: "done" },
		sections: [],
		expanded: false,
		...overrides,
	};
}

function inputSection(text: string, label = "Input"): ToolView["sections"][number] {
	return {
		slot: "call", label, component: new Text(text, 0, 0), renderedWidth: "padded",
		previewPolicy: { edge: "head", count: label === "Command" ? 1 : 10, unit: "visual-lines" },
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
	it("preserves callable MCP identity when long metadata competes for header space", () => {
		const layout = layoutToolView(view({
			head: { title: "MCP", target: "docs.lookup", meta: ["metadata".repeat(10)], status: "done" },
		}), { ...snapshot(), presentation: "mcp" }, plainTheme, 40);
		const header = rows(layout)[0]!;
		expect(header).toContain("docs");
		expect(header).toContain("ok");
		expect(visibleWidth(header)).toBe(40);
		expect(layout.callChildBounds).toEqual([]);
	});

	it.each([24, 80, 120])("keeps a truncated callable identity in the header rather than injecting a Target on expansion at width %s", (width) => {
		const input = inputSection("query: BODY_INPUT");
		const base = view({
			head: { title: "MCP", target: "docs." + "lookup".repeat(30), meta: [], status: "done" },
			sections: [input],
		});
		const toolSnapshot = { ...snapshot(), presentation: "mcp" as const };
		const collapsed = layoutToolView(base, toolSnapshot, plainTheme, width);
		const expanded = layoutToolView({ ...base, expanded: true }, toolSnapshot, plainTheme, width);
		expect(rows(expanded)[0]).toBe(rows(collapsed)[0]);
		expect(rows(expanded)[0]).toContain("docs");
		expect(rows(expanded)[0]).not.toContain("BODY_INPUT");
		expect(rows(expanded).join("\n")).not.toContain("Target");
		expect(expanded.callChildBounds).toEqual(collapsed.callChildBounds);
		expect(expanded.callChildBounds).toHaveLength(1);
		expect(expanded.callChildBounds[0]?.component).toBe(input.component);
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

	it.each(["Bash", "Shell", "Read"])("renders the expanded multiline %s input in call exactly once", (title) => {
		const target = "first-target-marker\nsecond-target-marker";
		const label = title === "Read" ? "Input" : "Command";
		const layout = layoutToolView(view({
			expanded: true, head: { title, target: "", meta: [], status: "done" },
			sections: [inputSection(target, label)],
		}), snapshot(), plainTheme, 40);
		const rendered = rows(layout);
		expect(rendered[0]).not.toContain("first-target-marker");
		expect(rendered.join("\n").match(/first-target-marker/gu)).toHaveLength(1);
		// Neither the Input nor the Command divider is shown; the body follows the header directly.
		expect(rendered.join("\n")).not.toContain(label);
		expect(layout.resultRows.join("\n")).not.toContain("second-target-marker");
	});

	it("previews a wrapped linked Input independently of its identity-only header and reveals it on expansion", () => {
		const target = hyperlink("TARGET_" + "界é".repeat(40), "https://example.org/input");
		const head = { title: "Read", target: "", meta: [], status: "done" as const };
		const input = { ...inputSection(target), previewPolicy: { edge: "head", count: 1, unit: "visual-lines" } as const };
		const collapsed = layoutToolView(view({ head, sections: [input] }), snapshot(), plainTheme, 30);
		expect(collapsed.callRows[0]).not.toContain("TARGET");
		expect(rows(collapsed).join("\n")).not.toContain("Input");
		expect(rows(collapsed).join("\n")).toContain("more lines");
		expect(collapsed.callChildBounds[0]).toMatchObject({ component: input.component, y: 1, width: 26, height: 1 });
		const expanded = layoutToolView(view({ head, sections: [input], expanded: true }), snapshot(), plainTheme, 30);
		expect(expanded.callRows[0]).not.toContain("TARGET");
		expect(rows(expanded).join("\n")).not.toContain("more lines");
		expect(expanded.callChildBounds[0]?.height).toBe(input.component.render(26).length);
		expect(expanded.callRows.join("\n")).toContain("\u001b]8;;https://example.org/input\u001b\\");
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

	it("leaves interactive children intact while previewing a noninteractive generic sibling", () => {
		const interactive: Component = {
			render: vi.fn(() => ["A", "B", "C", "D"]),
			handleMouse: () => ({ handled: true }),
			invalidate() {},
		};
		const passive = new Text("PASSIVE_1\nPASSIVE_2\nPASSIVE_3\nPASSIVE_4", 0, 0);
		const layout = layoutToolView(view({
			preview: { edge: "head", count: 2, unit: "visual-lines" },
			sections: [
				{ slot: "call", label: "Input", component: interactive },
				{ slot: "result", label: "Output", component: passive },
			],
		}), { ...snapshot(), presentation: "generic" }, plainTheme, 80);
		const rendered = rows(layout).join("\n");
		expect(layout.callChildBounds[0]).toMatchObject({ component: interactive, height: 4 });
		expect(rendered).toContain("D");
		expect(rendered).toContain("PASSIVE_2");
		expect(rendered).not.toContain("PASSIVE_3");
		expect(rendered.match(/2 more lines/gu)).toHaveLength(1);
		expect(layout.resultChildBounds[0]).toMatchObject({ component: passive, height: 2 });
		const expanded = layoutToolView(view({
			expanded: true,
			preview: { edge: "head", count: 2, unit: "visual-lines" },
			sections: [
				{ slot: "call", label: "Input", component: interactive },
				{ slot: "result", label: "Output", component: passive },
			],
		}), { ...snapshot(), presentation: "generic" }, plainTheme, 80);
		expect(rows(expanded).join("\n")).toContain("PASSIVE_4");
		expect(rows(expanded).join("\n")).not.toContain("more lines");
		expect(expanded.callChildBounds[0]?.component).toBe(interactive);
		expect(expanded.resultChildBounds[0]?.component).toBe(passive);
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
			head: { title: "Read", target: "", meta: [], status: "done" },
			sections: [{ slot: "result", component: { render: () => [theme.fg("toolOutput", "a\u001b[0mb\u001b[49mc")], invalidate() {} } }],
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

describe("bounded rich generic sections", () => {
	it.each([24, 80, 120])("preserves styled Input/Output rows with independent head previews and local bounds at width %s", (width) => {
		for (const padding of [0, 1, 2]) {
			const childWidth = width - 2 - 2 * padding;
			const input = new Text(Array.from({ length: 12 }, (_, index) =>
				`\u001b[35mRICH_IN_${index + 1}\u001b[0m ${hyperlink("INPUT_LINK", "https://example.org/input")}`,
			).join("\n"), 0, 0);
			const output = new Text(Array.from({ length: 9 }, (_, index) =>
				`\u001b[32mRICH_OUT_${index + 1}\u001b[0m ${hyperlink("OUTPUT_LINK", "https://example.org/output")}`,
			).join("\n"), 0, 0);
			const completeInput = input.render(childWidth);
			const completeOutput = output.render(childWidth);
			const sections: ToolView["sections"] = [
				{ slot: "call", label: "Input", component: input,
					previewPolicy: { edge: "head", count: 10, unit: "visual-lines" } },
				{ slot: "result", label: "Output", component: output,
					previewPolicy: { edge: "head", count: 5, unit: "visual-lines" } },
			];
			const base = { ...snapshot(true, padding), presentation: "generic" as const };
			const collapsed = layoutToolView(view({ sections }), base, plainTheme, width);
			const rendered = rows(collapsed).join("\n");
			expect(collapsed.callRows[0]).not.toContain("RICH_IN");
			expect(rendered).toContain(`${completeInput.length - 10} more lines`);
			expect(rendered).toContain(`${completeOutput.length - 5} more lines`);
			expect(collapsed.callChildBounds).toEqual([{ component: input, x: 1 + padding, y: 1, width: childWidth, height: 10 }]);
			expect(collapsed.resultChildBounds).toEqual([{ component: output, x: 1 + padding, y: 1, width: childWidth, height: 5 }]);
			for (const [childRows, bounds, expected] of [
				[collapsed.callRows, collapsed.callChildBounds[0]!, completeInput.slice(0, 10)],
				[collapsed.resultRows, collapsed.resultChildBounds[0]!, completeOutput.slice(0, 5)],
			] as const) {
				expect(childRows.slice(bounds.y, bounds.y + bounds.height).map(stripTerminalSequences)).toEqual(
					expected.map((line) => `│${" ".repeat(padding)}${stripTerminalSequences(line)}${" ".repeat(padding)}│`),
				);
			}
			expect(collapsed.callRows.join("\n")).toContain("\u001b[35m");
			expect(collapsed.resultRows.join("\n")).toContain("\u001b[32m");
			expect(collapsed.callRows.join("\n")).toContain("\u001b]8;;https://example.org/input\u001b\\");
			expect(collapsed.resultRows.join("\n")).toContain("\u001b]8;;https://example.org/output\u001b\\");
			expect(rows(collapsed).every((line) => visibleWidth(line) === width)).toBe(true);
			expect(collapsed.resultOffset).toBe(collapsed.callRows.length);
			expect(rows(collapsed).filter((line) => line.startsWith("╰"))).toHaveLength(1);
			expect(collapsed.resultRows.at(-1)).toMatch(/^╰/u);
			const expanded = layoutToolView(view({ sections, expanded: true }), base, plainTheme, width);
			expect(expanded.callChildBounds[0]).toMatchObject({ component: input, height: completeInput.length });
			expect(expanded.resultChildBounds[0]).toMatchObject({ component: output, height: completeOutput.length });
			expect(rows(expanded).join("\n")).not.toContain("more lines");
		}
	});

	it("selects whole generic logical entries without applying their policy to the Input section", () => {
		const entryLines = Array.from({ length: 7 }, (_, index) =>
			`\u001b[32mENTRY_${index + 1}\u001b[0m_${"path/".repeat(8)}`,
		);
		const input = new Text("ARG_1\nARG_2\nARG_3\nARG_4", 0, 0);
		const output = Object.assign(new Text(entryLines.join("\n"), 0, 0), { entryLines });
		const sections: ToolView["sections"] = [
			{ slot: "call", label: "Input", component: input,
				previewPolicy: { edge: "head", count: 2, unit: "visual-lines" } },
			{ slot: "result", label: "Output", component: output,
				previewPolicy: { edge: "head", count: 5, unit: "entries" } },
		];
		const base = { ...snapshot(), presentation: "generic" as const };
		const collapsed = layoutToolView(view({ sections }), base, plainTheme, 24);
		const selected = entryLines.slice(0, 5).flatMap((line) => wrapTextWithAnsi(line, 20));
		const rendered = rows(collapsed).join("\n");
		expect(rendered).toContain("2 more lines");
		expect(rendered).toContain("2 more entries");
		expect(rendered).toContain("ENTRY_5");
		expect(rendered).not.toContain("ENTRY_6");
		expect(rendered).not.toContain("ARG_3");
		expect(collapsed.resultChildBounds[0]).toMatchObject({ component: output, height: selected.length });
		expect(collapsed.resultRows.slice(1, 1 + selected.length).map(stripTerminalSequences)).toEqual(
			selected.map((line) => `│ ${stripTerminalSequences(line)}${" ".repeat(20 - visibleWidth(line))} │`),
		);
		const expanded = layoutToolView(view({ sections, expanded: true }), base, plainTheme, 24);
		expect(rows(expanded).join("\n")).toContain("ARG_4");
		expect(rows(expanded).join("\n")).toContain("ENTRY_7");
		expect(rows(expanded).join("\n")).not.toContain("more entries");
	});

	it("previews nested passive public Containers without replacing their original bounds identities", () => {
		const input = new Container();
		const nested = new Container();
		nested.addChild(new Text(Array.from({ length: 12 }, (_, index) => `NESTED_INPUT_${index + 1}`).join("\n"), 0, 0));
		input.addChild(nested);
		const output = new Container();
		output.addChild(new Text(Array.from({ length: 9 }, (_, index) => `NESTED_OUTPUT_${index + 1}`).join("\n"), 0, 0));
		const layout = layoutToolView(view({
			head: { title: "Nested", target: "", meta: [], status: "running" },
			sections: [
				{ slot: "call", label: "Input", component: input,
					previewPolicy: { edge: "head", count: 10, unit: "visual-lines" } },
				{ slot: "result", label: "Output", component: output,
					previewPolicy: { edge: "head", count: 5, unit: "visual-lines" } },
			],
		}), { ...snapshot(), presentation: "generic" }, plainTheme, 80, 0);
		const rendered = rows(layout).join("\n");
		expect(rendered).toContain("NESTED_INPUT_10");
		expect(rendered).not.toContain("NESTED_INPUT_11");
		expect(rendered).toContain("NESTED_OUTPUT_5");
		expect(rendered).not.toContain("NESTED_OUTPUT_6");
		expect(rendered).toContain("2 more lines");
		expect(rendered).toContain("4 more lines");
		expect(layout.callChildBounds).toEqual([{ component: input, x: 2, y: 1, width: 76, height: 10 }]);
		expect(layout.resultChildBounds).toEqual([{ component: output, x: 2, y: 1, width: 76, height: 5 }]);
		expect(layout.refreshHeader).toBeTypeOf("function");
	});

	it.each(["mouse", "keyboard", "opaque"] as const)("keeps %s interaction within nested public Containers intact while previewing their passive sibling", (kind) => {
		const leaf = new Text(Array.from({ length: 12 }, (_, index) => `INTERACTIVE_${index + 1}`).join("\n"), 0, 0);
		if (kind === "mouse") Object.assign(leaf, { handleMouse: () => ({ handled: true }) });
		if (kind === "keyboard") Object.assign(leaf, { handleInput: () => {} });
		const nested = new Container();
		nested.addChild(leaf);
		const input = new Container();
		input.addChild(nested);
		if (kind === "opaque") Object.assign(input, { handleMouse: () => undefined });
		const output = new Container();
		output.addChild(new Text("PASSIVE_1\nPASSIVE_2\nPASSIVE_3\nPASSIVE_4\nPASSIVE_5\nPASSIVE_6", 0, 0));
		const layout = layoutToolView(view({
			head: { title: "Nested", target: "", meta: [], status: "running" },
			sections: [
				{ slot: "call", label: "Input", component: input,
					previewPolicy: { edge: "head", count: 10, unit: "visual-lines" } },
				{ slot: "result", label: "Output", component: output,
					previewPolicy: { edge: "head", count: 5, unit: "visual-lines" } },
			],
		}), { ...snapshot(), presentation: "generic" }, plainTheme, 80);
		const rendered = rows(layout).join("\n");
		expect(rendered).toContain("INTERACTIVE_12");
		expect(rendered).not.toContain("2 more lines");
		expect(rendered).toContain("PASSIVE_5");
		expect(rendered).not.toContain("PASSIVE_6");
		expect(rendered).toContain("1 more lines");
		expect(layout.callChildBounds).toEqual([{ component: input, x: 2, y: 1, width: 76, height: 12 }]);
		expect(layout.resultChildBounds).toEqual([{ component: output, x: 2, y: 1, width: 76, height: 5 }]);
		expect(layout.refreshHeader).toBeUndefined();
	});

	it("keeps the only closure in call while a pre-result Input preview is clipped", () => {
		const input = new Text("INPUT_1\nINPUT_2\nINPUT_3", 0, 0);
		const layout = layoutToolView(view({ sections: [
			{ slot: "call", label: "Input", component: input,
				previewPolicy: { edge: "head", count: 1, unit: "visual-lines" } },
		] }), { ...snapshot(false), presentation: "generic" }, plainTheme, 80);
		expect(layout.resultRows).toEqual([]);
		expect(layout.callChildBounds).toEqual([{ component: input, x: 2, y: 1, width: 76, height: 1 }]);
		expect(rows(layout).join("\n")).toContain("2 more lines");
		expect(rows(layout).join("\n")).not.toContain("INPUT_2");
		expect(layout.callRows.at(-1)).toMatch(/^╰/u);
		expect(layout.resultOffset).toBe(layout.callRows.length);
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
			const running = view({
				head: { title: "Bash", target: "", meta: [], status: "running" },
				sections: [inputSection("$ sleep 1", "Command")],
			});
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
			head: { title: "Write", target: "", meta: ["2000 lines"], status: "running" },
			sections: [
				inputSection(target),
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
		const running = view({
			head: { title, target: "", meta: [meta], status: "running" },
			sections: [inputSection(command, "Command")],
		});
		const layout = layoutToolView(running, snapshot(), plainTheme, 120, 0);
		expect(layout.refreshHeader).toBeTypeOf("function");
		const before = layout.callRows[0]!;
		for (const frame of [1, 2, 3]) {
			layout.refreshHeader!(frame);
			const header = layout.callRows[0]!;
			expect(header).not.toBe(before);
			expect(header).not.toContain(command);
			expect(layout.callRows.slice(1).join("\n")).toContain(command);
			expect(header).toContain(title);
			expect(header).toContain(meta);
			expect(visibleWidth(stripTerminalSequences(header))).toBe(120);
			expect(header).toBe(layoutToolView(running, snapshot(), plainTheme, 120, frame).callRows[0]);
		}
	});

	it("rewraps the explicit Input on resize but keeps its placement and body stable on header clocks", () => {
		const target = "TARGET_" + "x".repeat(35);
		const input = inputSection(target);
		const running = view({
			expanded: true, head: { title: "Read", target: "", meta: [], status: "running" },
			sections: [input],
		});
		const render = vi.spyOn(input.component, "render");
		const wide = layoutToolView(running, snapshot(), plainTheme, 120, 0);
		const narrow = layoutToolView(running, snapshot(), plainTheme, 40, 0);
		expect(wide.refreshHeader).toBeTypeOf("function");
		expect(narrow.refreshHeader).toBeTypeOf("function");
		expect(wide.callRows[0]).not.toContain(target);
		expect(wide.callChildBounds[0]).toMatchObject({ component: input.component, y: 1, width: 116, height: 1 });
		expect(narrow.callRows[0]).not.toContain("TARGET_");
		expect(narrow.callChildBounds[0]).toMatchObject({ component: input.component, y: 1, width: 36, height: 2 });
		expect(render).toHaveBeenCalledTimes(2);
		const before = narrow.callRows.slice(1);
		for (const frame of [1, 2, 3]) {
			wide.refreshHeader!(frame);
			narrow.refreshHeader!(frame);
			expect(wide.callRows[0]).not.toContain(target);
			expect(narrow.callRows.slice(1)).toEqual(before);
		}
		expect(render).toHaveBeenCalledTimes(2);
	});

	it.each(["ascii", "nerd-font", "off"] as const)("preserves prepared %s truncation at narrow header widths", (mode) => {
		setIconMode(mode);
		for (const width of [1, 5, 7, 8, 10, 24]) {
			const running = view({ head: { title: "MCP |", target: "docs.界é", meta: ["meta -"], status: "running" } });
			const layout = layoutToolView(running, { ...snapshot(), presentation: "mcp" }, plainTheme, width, 0);
			expect(layout.refreshHeader).toBeTypeOf("function");
			for (const frame of [1, 2, 3]) {
				layout.refreshHeader!(frame);
				expect(layout.callRows[0]).toBe(layoutToolView(running, { ...snapshot(), presentation: "mcp" }, plainTheme, width, frame).callRows[0]);
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
				head: { title: "MCP", target: "docs.lookup", meta: [], status: "running" },
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

	it("retains styled static header preparation while the linked command moves to its body section", () => {
		const fg = vi.fn((_color: string, text: string) => `\u001b[31m${text}\u001b[0m`);
		const theme = {
			fg,
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
			getBgAnsi: () => "\u001b[44m",
		} as unknown as Theme;
		const command = hyperlink("LINK |", "https://example.org/path");
		const layout = layoutToolView(view({
			head: { title: "Bash", target: "", meta: ["META"], status: "running" },
			sections: [inputSection(command, "Command")],
		}), snapshot(), theme, 80, 0);
		expect(layout.refreshHeader).toBeTypeOf("function");
		expect(layout.callRows[0]).not.toContain(command);
		expect(layout.callRows.slice(1).join("\n")).toContain(command);
		fg.mockClear();
		vi.mocked(visibleWidth).mockClear();
		for (const frame of [1, 2, 3]) {
			layout.refreshHeader!(frame);
			expect(layout.callRows[0]).not.toContain(command);
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

	it.each(["mouse", "keyboard"] as const)("does not offer a body-skipping header capability for %s children", (kind) => {
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
		}), snapshot(), plainTheme, 30, 0);
		expect(layout.refreshHeader).toBeUndefined();
		expect(layout.resultChildBounds).toEqual([{ component, x: 2, y: 0, width: 26, height: 3 }]);
		expect(rows(layout).join("\n")).toContain("A");
		expect(rows(layout).join("\n")).not.toContain("more lines");
	});

	it("refreshes only a noninteractive generic header while retaining clipped rich body rows and bounds", () => {
		const component = new Text("\u001b[32mRICH_A\u001b[0m\nRICH_B\nRICH_C", 0, 0);
		const layout = layoutToolView(view({
			head: { title: "ThirdParty", target: "", meta: [], status: "running" },
			sections: [{ slot: "result", label: "Output", component,
				previewPolicy: { edge: "head", count: 1, unit: "visual-lines" } }],
		}), { ...snapshot(), presentation: "generic" }, plainTheme, 80, 0);
		expect(layout.refreshHeader).toBeTypeOf("function");
		expect(rows(layout).join("\n")).toContain("2 more lines");
		expect(rows(layout).join("\n")).not.toContain("RICH_B");
		const callRows = layout.callRows;
		const resultRows = layout.resultRows;
		const resultBounds = layout.resultChildBounds;
		const before = [...resultRows];
		const initialHeader = callRows[0];
		vi.mocked(visibleWidth).mockClear();
		vi.mocked(wrapTextWithAnsi).mockClear();
		for (const frame of [1, 2, 3]) {
			layout.refreshHeader!(frame);
			expect(callRows[0]).not.toBe(initialHeader);
			expect(layout.callRows).toBe(callRows);
			expect(layout.resultRows).toBe(resultRows);
			expect(layout.resultChildBounds).toBe(resultBounds);
			expect(resultRows).toEqual(before);
		}
		expect(vi.mocked(visibleWidth)).not.toHaveBeenCalled();
		expect(vi.mocked(wrapTextWithAnsi)).not.toHaveBeenCalled();
		expect(resultBounds[0]).toMatchObject({ component, y: 1, height: 1 });
	});

	it.each(["render", "invalidate"] as const)("still previews passive generic bodies with custom %s methods without offering header-only retention", (method) => {
		const child = new Text("CUSTOM_1\nCUSTOM_2\nCUSTOM_3", 0, 0);
		if (method === "render") child.render = () => ["CUSTOM_1", "CUSTOM_2", "CUSTOM_3"];
		else child.invalidate = () => { child.setText("CHANGED"); };
		const container = new Container();
		container.addChild(child);
		const layout = layoutToolView(view({
			head: { title: "Custom", target: "", meta: [], status: "running" },
			sections: [{ slot: "result", label: "Output", component: container,
				previewPolicy: { edge: "head", count: 1, unit: "visual-lines" } }],
		}), { ...snapshot(), presentation: "generic" }, plainTheme, 80);
		expect(rows(layout).join("\n")).toContain("CUSTOM_1");
		expect(rows(layout).join("\n")).not.toContain("CUSTOM_2");
		expect(rows(layout).join("\n")).toContain("2 more lines");
		expect(layout.resultChildBounds).toEqual([{ component: container, x: 2, y: 1, width: 76, height: 1 }]);
		expect(layout.refreshHeader).toBeUndefined();
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
			head: { title: "Bash", target: "", meta: [], status: "running" },
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

describe("per-section previews and shell command ownership", () => {
	type FrameSection = ToolView["sections"][number];
	const section = (value: Record<string, unknown>): FrameSection => value as unknown as FrameSection;
	const head = { title: "Read", target: "", meta: [], status: "done" } as const;
	const inputRows = Array.from({ length: 12 }, (_, index) => `IN_${index + 1}`);
	const outputRows = Array.from({ length: 12 }, (_, index) => `OUT_${index + 1}`);
	const callEntries = Array.from({ length: 9 }, (_, index) => `CALL_${index + 1}`);
	const executionSections = (): FrameSection[] => {
		const calls = Object.assign(new Text(callEntries.join("\n"), 0, 0), { entryLines: callEntries });
		return [
			section({ slot: "call", label: "Input", component: new Text(inputRows.join("\n"), 0, 0), preview: true,
				previewPolicy: { edge: "head", count: 10, unit: "visual-lines" } }),
			section({ slot: "result", label: "Output", component: new Text(outputRows.join("\n"), 0, 0), preview: true,
				previewPolicy: { edge: "head", count: 5, unit: "visual-lines" } }),
			section({ slot: "result", label: "Calls", component: calls, preview: true,
				previewPolicy: { edge: "tail", count: 8, unit: "entries" } }),
		];
	};

	it("applies independent input, output and calls policies with separate hints", () => {
		const layout = layoutToolView({
			layout: "framed", head, expanded: false, sections: executionSections(),
		} as unknown as ToolView, snapshot(), plainTheme, 40);
		const joined = rows(layout).join("\n");
		expect(joined).toContain("IN_10");
		expect(joined).not.toContain("IN_11");
		expect(joined).toContain("2 more lines");
		expect(joined).toContain("OUT_5");
		expect(joined).not.toContain("OUT_6");
		expect(joined).toContain("7 more lines");
		expect(joined).toContain("CALL_2");
		expect(joined).toContain("CALL_9");
		expect(joined).not.toMatch(/\bCALL_1\b/u);
		expect(joined).toContain("1 more entries");
	});

	it("reveals every delivered row on expansion and drops section hints", () => {
		const layout = layoutToolView({
			layout: "framed", head, expanded: true, sections: executionSections(),
		} as unknown as ToolView, snapshot(), plainTheme, 40);
		const joined = rows(layout).join("\n");
		expect(joined).toContain("IN_12");
		expect(joined).toContain("OUT_12");
		expect(joined).toContain("CALL_1");
		expect(joined).not.toContain("more lines");
		expect(joined).not.toContain("more entries");
		expect(layout.callChildBounds.map((bounds) => bounds.height)).toEqual([12]);
		expect(layout.resultChildBounds.map((bounds) => bounds.height)).toEqual([12, 9]);
	});

	it("keeps preview false authoritative over a section policy and a view fallback", () => {
		const layout = layoutToolView({
			layout: "framed", head, expanded: false,
			preview: { edge: "tail", count: 1, unit: "visual-lines" },
			sections: [
				section({ slot: "result", label: "Locked", component: new Text("LOCK_A\nLOCK_B\nLOCK_C", 0, 0),
					preview: false, previewPolicy: { edge: "head", count: 1, unit: "visual-lines" } }),
				section({ slot: "result", label: "FallsBack", component: new Text("FALL_A\nFALL_B\nFALL_C", 0, 0) }),
			],
		} as unknown as ToolView, snapshot(), plainTheme, 40);
		const joined = rows(layout).join("\n");
		expect(joined).toContain("LOCK_A");
		expect(joined).toContain("LOCK_C");
		expect(joined).toContain("FALL_C");
		expect(joined).not.toContain("FALL_A");
		expect(joined).toContain("2 more lines");
	});

	it.each(["Bash", "Shell", "PowerShell", "powershell"])("keeps the %s command body bounded and out of the header without a Command divider", (title) => {
		const layout = layoutToolView(view({
			head: { title, target: "", meta: [], status: "done" },
			sections: [
				inputSection("printf FIRST\nprintf SECOND", "Command"),
				{ slot: "result", label: "Output", component: new Text("FIRST_OUTPUT\nSECOND_OUTPUT", 0, 0) },
			],
		}), snapshot(), plainTheme, 40);
		const rendered = rows(layout);
		const joined = rendered.join("\n");
		expect(rendered[0]).not.toContain("printf");
		expect(joined).not.toContain("Command");
		expect(joined).toContain("printf FIRST");
		expect(joined).not.toContain("printf SECOND");
		expect(joined).toContain("1 more lines");
		expect(joined).toContain("FIRST_OUTPUT");
	});

	it("orders the whole command above output when expanded without duplicating it", () => {
		const layout = layoutToolView(view({
			expanded: true,
			head: { title: "Bash", target: "", meta: [], status: "done" },
			sections: [
				inputSection("printf FIRST\nprintf SECOND", "Command"),
				{ slot: "result", label: "Output", component: new Text("FIRST_OUTPUT\nSECOND_OUTPUT", 0, 0) },
			],
		}), snapshot(), plainTheme, 40);
		const rendered = rows(layout);
		const joined = rendered.join("\n");
		expect(rendered[0]).not.toContain("printf");
		expect(joined.match(/printf FIRST/gu)).toHaveLength(1);
		expect(joined.match(/printf SECOND/gu)).toHaveLength(1);
		expect(rendered.findIndex((line) => line.includes("printf SECOND")))
			.toBeLessThan(rendered.findIndex((line) => line.includes("FIRST_OUTPUT")));
	});

	it("counts command and output hints independently", () => {
		const layout = layoutToolView(view({
			head: { title: "Shell", target: "", meta: [], status: "done" },
			preview: { edge: "tail", count: 2, unit: "visual-lines" },
			sections: [
				inputSection("line-one\nline-two\nline-three", "Command"),
				{ slot: "result", label: "Output", component: new Text("O1\nO2\nO3\nO4\nO5", 0, 0) },
			],
		}), snapshot(), plainTheme, 40);
		const joined = rows(layout).join("\n");
		expect(joined).toContain("line-one");
		expect(joined).not.toContain("line-three");
		expect(joined).toContain("2 more lines");
		expect(joined).toContain("3 more lines");
	});

	it.each([24, 80, 120])("keeps the collapsed command body inside width %s for every padding", (width) => {
		for (const padding of [0, 1, 2]) {
			const layout = layoutToolView(view({
				head: { title: "Bash", target: "", meta: [], status: "done" },
				sections: [inputSection(`printf ${"x".repeat(120)}`, "Command")],
			}), snapshot(true, padding), plainTheme, width);
			expect(rows(layout).every((line) => visibleWidth(line) === width)).toBe(true);
			expect(rows(layout).join("\n")).not.toContain("Command");
		}
	});

	it("preserves a linked Unicode command in the body and never in the header", () => {
		const command = `${hyperlink("CMD_LINK", "https://example.org/cmd")} 界é`;
		const layout = layoutToolView(view({
			head: { title: "Bash", target: "", meta: [], status: "done" },
			sections: [inputSection(command, "Command")],
		}), snapshot(), plainTheme, 60);
		expect(layout.callRows[0]).not.toContain("CMD_LINK");
		expect(layout.callRows.slice(1).join("\n")).toContain(command);
		expect(layout.callChildBounds[0]?.x).toBe(2);
	});

	it.each(["ascii", "nerd-font"] as const)("keeps the running shell body frozen while only the %s header clock advances", (mode) => {
		setIconMode(mode);
		const component = new Text("OUT_A\nOUT_B", 0, 0);
		const render = vi.spyOn(Text.prototype, "render");
		const layout = layoutToolView(view({
			head: { title: "Bash", target: "", meta: [], status: "running" },
			sections: [inputSection("printf RUN\nprintf SECOND", "Command"), { slot: "result", component }],
		}), snapshot(), plainTheme, 80, 0);
		expect(layout.refreshHeader).toBeTypeOf("function");
		const callRows = layout.callRows;
		const resultRows = layout.resultRows;
		const callBounds = layout.callChildBounds;
		const resultBounds = layout.resultChildBounds;
		const bodyBefore = callRows.slice(1);
		const resultBefore = [...resultRows];
		const commandBounds = { ...callBounds[0]! };
		expect(render).toHaveBeenCalledTimes(2);
		expect(commandBounds.height).toBe(1);
		for (const frame of [1, 2, 3]) {
			layout.refreshHeader!(frame);
			expect(stripTerminalSequences(callRows[0]!)).toContain(getToolSpinnerFrame(mode, frame));
			expect(layout.callRows).toBe(callRows);
			expect(layout.resultRows).toBe(resultRows);
			expect(callRows.slice(1)).toEqual(bodyBefore);
			expect(resultRows).toEqual(resultBefore);
			expect(callBounds[0]).toEqual(commandBounds);
			expect(layout.resultChildBounds).toBe(resultBounds);
		}
		expect(render).toHaveBeenCalledTimes(2);
	});
});

describe("omitted Input divider", () => {
	const readHead = { title: "Read", target: "", meta: [], status: "done" } as const;

	it("starts the call body directly after the header without an Input row and keeps Output", () => {
		const input = new Text("INPUT_ONE\nINPUT_TWO", 0, 0);
		const output = new Text("OUT_RESULT", 0, 0);
		const layout = layoutToolView(view({
			head: readHead,
			sections: [
				{ slot: "call", label: "Input", component: input,
					previewPolicy: { edge: "head", count: 1, unit: "visual-lines" } },
				{ slot: "result", label: "Output", component: output },
			],
		}), snapshot(), plainTheme, 40);
		const rendered = rows(layout);
		const joined = rendered.join("\n");
		expect(joined).not.toContain("Input");
		expect(rendered[0]).not.toContain("INPUT_ONE");
		expect(stripTerminalSequences(layout.callRows[1]!)).toContain("INPUT_ONE");
		expect(joined).toContain("1 more lines");
		expect(joined).toContain("Output");
		expect(joined).toContain("OUT_RESULT");
		expect(layout.callChildBounds).toEqual([{ component: input, x: 2, y: 1, width: 36, height: 1 }]);
		expect(layout.resultOffset).toBe(layout.callRows.length);
		expect(rendered.filter((line) => line.startsWith("╰"))).toHaveLength(1);
		expect(layout.resultRows.at(-1)).toMatch(/^╰/u);
	});

	it("keeps independent Input/Output hints and reveals both on expansion without the Input divider", () => {
		const sections: ToolView["sections"] = [
			{ slot: "call", label: "Input", component: new Text("IN_1\nIN_2\nIN_3", 0, 0),
				previewPolicy: { edge: "head", count: 1, unit: "visual-lines" } },
			{ slot: "result", label: "Output", component: new Text("OUT_1\nOUT_2\nOUT_3\nOUT_4\nOUT_5", 0, 0),
				previewPolicy: { edge: "head", count: 2, unit: "visual-lines" } },
		];
		const collapsed = layoutToolView(view({ head: readHead, sections }), snapshot(), plainTheme, 40);
		const joined = rows(collapsed).join("\n");
		expect(joined).not.toContain("Input");
		expect(joined).toContain("2 more lines");
		expect(joined).toContain("3 more lines");
		expect(collapsed.callChildBounds[0]).toMatchObject({ y: 1, height: 1 });
		expect(collapsed.resultChildBounds[0]).toMatchObject({ y: 1, height: 2 });
		const expanded = layoutToolView(view({ head: readHead, sections, expanded: true }), snapshot(), plainTheme, 40);
		const expandedJoined = rows(expanded).join("\n");
		expect(expandedJoined).toContain("IN_3");
		expect(expandedJoined).toContain("OUT_5");
		expect(expandedJoined).not.toContain("more lines");
	});

	it("omits the Input divider while preserving interactive call children and their bounds", () => {
		const interactive: Component = {
			render: () => ["INTER_ONE", "INTER_TWO"], invalidate() {}, handleMouse: () => ({ handled: true }),
		};
		const output = new Text("RESULT_ONE\nRESULT_TWO", 0, 0);
		const layout = layoutToolView(view({
			head: { title: "Custom", target: "", meta: [], status: "done" },
			sections: [
				{ slot: "call", label: "Input", component: interactive,
					previewPolicy: { edge: "head", count: 1, unit: "visual-lines" } },
				{ slot: "result", label: "Output", component: output,
					previewPolicy: { edge: "head", count: 1, unit: "visual-lines" } },
			],
		}), { ...snapshot(), presentation: "generic" }, plainTheme, 40);
		const joined = rows(layout).join("\n");
		expect(joined).not.toContain("Input");
		expect(joined).toContain("Output");
		expect(joined).toContain("INTER_ONE");
		expect(joined).toContain("INTER_TWO");
		expect(layout.callChildBounds).toEqual([{ component: interactive, x: 2, y: 1, width: 36, height: 2 }]);
		expect(layout.resultChildBounds[0]).toMatchObject({ y: 1, height: 1 });
	});

	it("omits the Command divider while keeping the exact command body and bounds", () => {
		const layout = layoutToolView(view({
			head: { title: "Bash", target: "", meta: [], status: "done" },
			sections: [inputSection("printf FIRST\nprintf SECOND", "Command")],
		}), snapshot(false), plainTheme, 40);
		const rendered = rows(layout);
		expect(rendered[0]).not.toContain("printf");
		expect(rendered.join("\n")).not.toContain("Command");
		expect(rendered.join("\n")).toContain("printf FIRST");
		expect(rendered.join("\n")).not.toContain("printf SECOND");
		expect(layout.callChildBounds[0]).toMatchObject({ y: 1, height: 1 });
	});
});

describe("omitted Command divider", () => {
	const bashHead = { title: "Bash", target: "", meta: [], status: "done" } as const;

	it("starts the call body directly after the header with the exact command, independent collapsed hints and the full command on expansion", () => {
		const command = "printf FIRST\nprintf SECOND";
		const outputRows = Array.from({ length: 13 }, (_, index) => `OUT_${index + 1}`);
		const input = new Text(command, 0, 0);
		const output = new Text(outputRows.join("\n"), 0, 0);
		const sections: ToolView["sections"] = [
			{ slot: "call", label: "Command", component: input,
				previewPolicy: { edge: "head", count: 1, unit: "visual-lines" } },
			{ slot: "result", label: "Output", component: output,
				previewPolicy: { edge: "tail", count: 10, unit: "visual-lines" } },
		];
		const collapsed = layoutToolView(view({ head: bashHead, sections }), snapshot(), plainTheme, 40);
		const rendered = rows(collapsed);
		const joined = rendered.join("\n");
		expect(joined).not.toContain("Command");
		expect(rendered[0]).not.toContain("printf");
		// The visible command starts immediately after the header, with no divider row between them.
		expect(stripTerminalSequences(rendered[1]!)).toContain("printf FIRST");
		expect(joined).not.toContain("printf SECOND");
		expect(joined).toContain("1 more lines");
		expect(joined).toContain("Output");
		expect(joined).toContain("OUT_4");
		expect(joined).not.toContain("OUT_3");
		expect(joined).toContain("OUT_13");
		expect(joined).toContain("3 more lines");
		expect(collapsed.callChildBounds).toEqual([{ component: input, x: 2, y: 1, width: 36, height: 1 }]);
		expect(collapsed.resultChildBounds[0]).toMatchObject({ component: output, y: 1, height: 10 });
		expect(collapsed.resultOffset).toBe(collapsed.callRows.length);
		expect(collapsed.resultOffset).toBe(3);

		const expanded = layoutToolView(view({ head: bashHead, sections, expanded: true }), snapshot(), plainTheme, 40);
		const expandedJoined = rows(expanded).join("\n");
		expect(expandedJoined).not.toContain("Command");
		expect(expandedJoined).toContain("printf FIRST");
		expect(expandedJoined).toContain("printf SECOND");
		expect(expandedJoined).not.toContain("more lines");
		expect(expanded.callChildBounds).toEqual([{ component: input, x: 2, y: 1, width: 36, height: 2 }]);
	});
});
