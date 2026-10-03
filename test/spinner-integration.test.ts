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

		const baselineTimers = vi.getTimerCount();

		// Before the tool starts, the title is shown without a spinner frame
		// and the plugin has not armed any ticker timer.
		const idle = component.render(50).map(stripTerminalSequences).join("\n");
		expect(idle).toContain("read");
		expect(idle).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
		expect(vi.getTimerCount()).toBe(baselineTimers);

		component.markExecutionStarted();
		const running = component.render(50).map(stripTerminalSequences).join("\n");
		expect(running).toContain("read");
		expect(running).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
		expect(vi.getTimerCount()).toBe(baselineTimers + 1);

		// One tick advances the animation and asks the UI to redraw.
		const frameBefore = running.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u)?.[0];
		vi.advanceTimersByTime(80);
		expect(ui.requestRender).toHaveBeenCalled();

		const animated = component
			.render(50)
			.map(stripTerminalSequences)
			.join("\n");
		const frameAfter = animated.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u)?.[0];
		expect(frameAfter).toBeDefined();
		expect(frameAfter).not.toBe(frameBefore);

		// Completing the tool must stop the ticker by itself: after one more
		// interval there is no redraw request and no leftover timer, without
		// calling clearToolSpinners() first.
		component.updateResult(
			{
				content: [{ type: "text", text: "pi-1-tool-result" }],
				isError: false,
			},
			false,
		);
		ui.requestRender.mockClear();
		vi.advanceTimersByTime(80);

		expect(ui.requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(baselineTimers);

		const complete = component
			.render(50)
			.map(stripTerminalSequences)
			.join("\n");
		expect(complete).toContain("pi-1-tool-result");
		expect(complete).toContain("read");
		expect(complete).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
	});
});
