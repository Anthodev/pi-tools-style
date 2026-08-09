import { describe, expect, it } from "vitest";

import { formatToolTitle } from "../src/tool-icon.ts";

describe("formatToolTitle", () => {
	it.each([
		["read", "[F]"],
		["write", "[W]"],
		["apply_patch", "[E]"],
		["bash", "[$]"],
		["symbol_search", "[?]"],
		["web_search", "[@]"],
		["fetch_content", "[v]"],
		["mcp", "[M]"],
		["workflow", "[*]"],
		["todo", "[#]"],
		["ask_user", "[!]"],
		["lens_diagnostics", "[D]"],
		["vendor_custom_tool", "[T]"],
	] as const)("uses portable ASCII icon for %s", (toolName, expected) => {
		expect(formatToolTitle(toolName, "ascii")).toBe(
			`${expected} | ${toolName}`,
		);
	});

	it.each([
		["read", ""],
		["write", ""],
		["apply_patch", ""],
		["bash", ""],
		["symbol_search", ""],
		["web_search", ""],
		["fetch_content", ""],
		["mcp", ""],
		["workflow", ""],
		["todo", ""],
		["ask_user", ""],
		["lens_diagnostics", ""],
		["vendor_custom_tool", ""],
	] as const)("uses Nerd Font icon for %s", (toolName, expected) => {
		expect(formatToolTitle(toolName, "nerd-font")).toBe(
			`${expected} | ${toolName}`,
		);
	});

	it("omits the icon and separator when icons are off", () => {
		expect(formatToolTitle("read", "off")).toBe("read");
	});
});

describe("formatToolTitle", () => {
	it("places the icon before the tool name", () => {
		expect(formatToolTitle("read", "ascii")).toBe("[F] | read");
		expect(formatToolTitle("bash", "nerd-font")).toBe(" | bash");
	});
});
