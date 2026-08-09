import { afterEach, describe, expect, it, vi } from "vitest";

import toolsStyleExtension from "../index.js";
import {
	createCategoryBorderStyle,
	setThemeProvider,
} from "../src/tool-category.js";

afterEach(() => setThemeProvider(undefined));

describe("tools style extension", () => {
	it("registers no tools and exposes long and short command names", async () => {
		const registerTool = vi.fn();
		const registerCommand = vi.fn();
		const on = vi.fn();

		toolsStyleExtension({ on, registerCommand, registerTool } as never);

		expect(registerTool).not.toHaveBeenCalled();
		expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
		expect(registerCommand).toHaveBeenCalledTimes(2);
		expect(registerCommand).toHaveBeenCalledWith(
			"tools-style",
			expect.objectContaining({ description: expect.any(String) }),
		);
		expect(registerCommand).toHaveBeenCalledWith(
			"tstyle",
			expect.objectContaining({ description: expect.any(String) }),
		);

		const command = registerCommand.mock.calls.find(
			([name]) => name === "tools-style",
		)?.[1] as {
			handler: (
				args: string,
				context: { ui: { notify: ReturnType<typeof vi.fn> } },
			) => Promise<void>;
		};
		const notify = vi.fn();

		await command.handler("off", { ui: { notify } });
		await command.handler("on", { ui: { notify } });

		expect(notify).toHaveBeenNthCalledWith(1, "Tool boxes disabled.");
		expect(notify).toHaveBeenNthCalledWith(2, "Tool boxes enabled.");
	});

	it("shows usage instead of toggling for an unknown action", async () => {
		const registerCommand = vi.fn();
		toolsStyleExtension({
			on: vi.fn(),
			registerCommand,
			registerTool: vi.fn(),
		} as never);
		const command = registerCommand.mock.calls.find(
			([name]) => name === "tools-style",
		)?.[1] as {
			handler: (
				args: string,
				context: { ui: { notify: ReturnType<typeof vi.fn> } },
			) => Promise<void>;
		};
		const notify = vi.fn();

		await command.handler("typo", { ui: { notify } });

		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(
			"Usage: /tools-style [on|off|icons ascii|icons nerd-font|icons off]",
			"warning",
		);
	});

	it("releases the session theme provider on shutdown", async () => {
		const on = vi.fn();
		toolsStyleExtension({
			on,
			registerCommand: vi.fn(),
			registerTool: vi.fn(),
		} as never);
		const sessionStart = on.mock.calls.find(
			([event]) => event === "session_start",
		)?.[1] as (
			event: unknown,
			context: { ui: { theme: { fg: (_color: string, value: string) => string } } },
		) => Promise<void>;
		const sessionShutdown = on.mock.calls.find(
			([event]) => event === "session_shutdown",
		)?.[1] as () => Promise<void>;

		await sessionStart({}, {
			ui: { theme: { fg: (_color, value) => `theme:${value}` } },
		});
		expect(createCategoryBorderStyle("inspect")("│")).toBe("theme:│");

		await sessionShutdown();
		expect(createCategoryBorderStyle("inspect")("│")).not.toBe("theme:│");
	});
});
