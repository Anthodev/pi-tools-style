import {
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installToolsStyle } from "../index.ts";
import { setIconMode } from "../src/settings.ts";
import { clearToolSpinners } from "../src/tool-spinner.ts";

beforeEach(() => {
	vi.useFakeTimers();
	initTheme("dark", false);
	clearToolSpinners();
	setIconMode("nerd-font");
	installToolsStyle();
});

afterEach(() => {
	clearToolSpinners();
	setIconMode("ascii");
	vi.useRealTimers();
});

describe("running tool title", () => {
	it("shows a spinner only while the real Pi component is executing", () => {
		const ui = { requestRender: vi.fn() };
		const component = new ToolExecutionComponent(
			"read",
			"call-1",
			{ path: "README.md" },
			undefined,
			undefined,
			ui as never,
			process.cwd(),
		);

		component.markExecutionStarted();
		const running = component.render(50).map(stripTerminalSequences).join("\n");
		expect(running).toContain(" | read ⠋");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				isError: false,
			},
			false,
		);
		const complete = component
			.render(50)
			.map(stripTerminalSequences)
			.join("\n");
		expect(complete).toContain(" | read");
		expect(complete).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
	});
});
