import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	classifyTool,
	createCategoryBorderStyle,
	createToolBorderStyle,
	setThemeProvider,
} from "../src/tool-category.ts";

afterEach(() => setThemeProvider(undefined));

describe("classifyTool", () => {
	it.each([
		["read", "inspect"],
		["grep", "inspect"],
		["symbol_search", "inspect"],
		["write", "mutate"],
		["apply_patch", "mutate"],
		["memory_add", "mutate"],
		["bash", "execute"],
		["interactive_shell", "execute"],
		["ctx_execute_file", "execute"],
		["web_search", "external"],
		["fetch_content", "external"],
		["mcpScript", "external"],
		["workflow_control", "orchestrate"],
		["subagent_wait", "orchestrate"],
		["manage_todo_list", "orchestrate"],
		["ask_user", "interact"],
		["questionnaire", "interact"],
		["vendor_custom_tool", "other"],
	] as const)("classifies %s as %s", (toolName, expected) => {
		expect(classifyTool(toolName)).toBe(expected);
	});
});

describe("category border styles", () => {
	it("maps categories to semantic colors from the current Pi theme", () => {
		const fg = vi.fn(
			(color: ThemeColor, value: string) => `[${color}]${value}`,
		);
		setThemeProvider(() => ({ fg }) as unknown as Theme);

		expect(createToolBorderStyle("read")("│")).toBe("[mdLink]│");
		expect(createToolBorderStyle("write")("│")).toBe("[warning]│");
		expect(createToolBorderStyle("bash")("│")).toBe("[bashMode]│");
		expect(createToolBorderStyle("web_search")("│")).toBe("[syntaxType]│");
		expect(createToolBorderStyle("workflow")("│")).toBe(
			"[customMessageLabel]│",
		);
		expect(createToolBorderStyle("ask_user")("│")).toBe("[accent]│");
	});

	it("reads the theme provider again for each render", () => {
		let prefix = "first";
		setThemeProvider(
			() =>
				({
					fg: (_color: ThemeColor, value: string) => `${prefix}:${value}`,
				}) as unknown as Theme,
		);

		expect(createToolBorderStyle("read")("─")).toBe("first:─");
		prefix = "second";
		expect(createToolBorderStyle("read")("─")).toBe("second:─");
	});

	it("uses a dim theme-neutral fallback before session startup", () => {
		const styled = createCategoryBorderStyle("other")("│");

		expect(stripTerminalSequences(styled)).toBe("│");
		expect(styled).toContain("\u001b[2m");
	});
});
