import {
	BashExecutionComponent,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installToolsStyle } from "../index.ts";
import { setIconMode } from "../src/settings.ts";
import { clearToolSpinners } from "../src/tool-spinner.ts";
import { setRenderDecoratorEnabled } from "../src/render-decorator.ts";

const TOOL_RENDER_KEY = Symbol.for("pi-tools-style:tool-render");
const SHELL_RENDER_KEY = Symbol.for("pi-tools-style:shell-render");

const SPINNER_CHARS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;

/**
 * Asserts exactly one plugin frame: a single top border (╭…╮, optionally
 * carrying the title) and a single bottom border (╰…╯), with every
 * marker-bearing line strictly between them and delimited by │ on both
 * sides. Does not snapshot the exact frame.
 */
function assertSingleFrame(
	lines: string[],
	options: { title?: string; markers: string[] },
) {
	const topIndices = lines.reduce<number[]>(
		(acc, line, i) => (line.startsWith("╭") ? [...acc, i] : acc),
		[],
	);
	const bottomIndices = lines.reduce<number[]>(
		(acc, line, i) => (line.startsWith("╰") ? [...acc, i] : acc),
		[],
	);

	expect(topIndices).toHaveLength(1);
	expect(bottomIndices).toHaveLength(1);

	// Bounds proven by the preceding toHaveLength(1) assertions.
	const top = topIndices[0]!;
	const bottom = bottomIndices[0]!;
	expect(lines[top]!.endsWith("╮")).toBe(true);
	expect(lines[bottom]!.endsWith("╯")).toBe(true);
	expect(top).toBeLessThan(bottom);

	if (options.title !== undefined) {
		expect(lines[top]).toContain(options.title);
	}

	for (const marker of options.markers) {
		const markerLines = lines.reduce<number[]>(
			(acc, line, i) => (line.includes(marker) ? [...acc, i] : acc),
			[],
		);
		expect(markerLines.length).toBeGreaterThanOrEqual(1);
		for (const i of markerLines) {
			expect(i).toBeGreaterThan(top);
			expect(i).toBeLessThan(bottom);
			// Index proven valid: sourced from the lines array itself.
			const line = lines[i]!;
			expect(line.startsWith("│")).toBe(true);
			expect(line.endsWith("│")).toBe(true);
		}
	}
}

function renderPlain(component: { render(width: number): string[] }, width = 50) {
	return component.render(width).map(stripTerminalSequences);
}

function createShell(ui: unknown, excludeFromContext: boolean) {
	const component = new BashExecutionComponent(
		"printf pi-1-shell-command",
		ui as never,
		excludeFromContext,
	);
	component.appendOutput("pi-1-shell-result\n");
	component.setComplete(0, false);
	return component;
}

function createCustomRendererTool(
	ui: unknown,
	renderShell: "default" | "self",
) {
	const component = new ToolExecutionComponent(
		"read",
		"call-renderer",
		{ path: "README.md" },
		undefined,
		{
			renderShell,
			renderCall: () => new Text("pi-1-custom-call", 0, 0),
			renderResult: () => new Text("pi-1-custom-result", 0, 0),
		},
		ui as never,
		process.cwd(),
	);
	component.markExecutionStarted();
	component.updateResult(
		{
			content: [{ type: "text", text: "irrelevant-fallback" }],
			isError: false,
		},
		false,
	);
	return component;
}

beforeEach(() => {
	vi.useFakeTimers();
	initTheme("dark", false);
	clearToolSpinners();
	setIconMode("ascii");
	installToolsStyle();
});

afterEach(() => {
	setRenderDecoratorEnabled(TOOL_RENDER_KEY, true);
	setRenderDecoratorEnabled(SHELL_RENDER_KEY, true);
	clearToolSpinners();
	setIconMode("ascii");
	vi.useRealTimers();
});

describe("real BashExecutionComponent decoration", () => {
	for (const excludeFromContext of [false, true]) {
		it(`frames completed shell output (excludeFromContext: ${excludeFromContext})`, () => {
			const shell = createShell({ requestRender: vi.fn() }, excludeFromContext);
			const lines = renderPlain(shell);

			const rendered = lines.join("\n");
			// The result marker must stay distinct from the command header so
			// losing the output would fail the test.
			expect(rendered).toContain("printf pi-1-shell-command");
			expect(rendered).toContain("pi-1-shell-result");

			assertSingleFrame(lines, {
				title: "shell",
				markers: ["pi-1-shell-result"],
			});

			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(50);
			}
		});
	}
});

describe("third-party renderer composition", () => {
	for (const renderShell of ["default", "self"] as const) {
		it(`keeps renderer markers inside one plugin frame (renderShell: ${renderShell})`, () => {
			const tool = createCustomRendererTool(
				{ requestRender: vi.fn() },
				renderShell,
			);
			const lines = renderPlain(tool);
			const rendered = lines.join("\n");

			expect(rendered).toContain("pi-1-custom-call");
			expect(rendered).toContain("pi-1-custom-result");
			assertSingleFrame(lines, {
				markers: ["pi-1-custom-call", "pi-1-custom-result"],
			});
			expect(rendered).not.toMatch(SPINNER_CHARS);
		});
	}
});

describe("decorator toggle and reinstall idempotence", () => {
	it("drops the frame when disabled, restores it, and never stacks frames", () => {
		const ui = { requestRender: vi.fn() };
		const shell = createShell(ui, false);
		const tool = createCustomRendererTool(ui, "default");

		setRenderDecoratorEnabled(TOOL_RENDER_KEY, false);
		setRenderDecoratorEnabled(SHELL_RENDER_KEY, false);

		const shellLines = renderPlain(shell);
		expect(shellLines.join("\n")).toContain("pi-1-shell-result");
		expect(shellLines.join("\n").includes("╭")).toBe(false);

		const toolLines = renderPlain(tool);
		expect(toolLines.join("\n")).toContain("pi-1-custom-call");
		expect(toolLines.join("\n")).toContain("pi-1-custom-result");
		expect(toolLines.join("\n").includes("╭")).toBe(false);

		setRenderDecoratorEnabled(TOOL_RENDER_KEY, true);
		setRenderDecoratorEnabled(SHELL_RENDER_KEY, true);

		installToolsStyle();
		installToolsStyle();

		const reframed = renderPlain(shell);
		expect(reframed.join("\n")).toContain("pi-1-shell-result");
		assertSingleFrame(reframed, {
			title: "shell",
			markers: ["pi-1-shell-result"],
		});

		const toolReframed = renderPlain(tool);
		const toolRendered = toolReframed.join("\n");
		expect(toolRendered).toContain("pi-1-custom-call");
		expect(toolRendered).toContain("pi-1-custom-result");
		assertSingleFrame(toolReframed, {
			markers: ["pi-1-custom-call", "pi-1-custom-result"],
		});
	});
});
