import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	classifyTool,
	getToolTheme,
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

describe("current theme provider", () => {
	it("reads the current public session theme without retaining its first value", () => {
		const first = { fg: vi.fn() } as unknown as Theme;
		const second = { fg: vi.fn() } as unknown as Theme;
		let current = first;
		setThemeProvider(() => current);
		expect(getToolTheme()).toBe(first);
		current = second;
		expect(getToolTheme()).toBe(second);
	});

	it("returns no theme before startup and after provider release", () => {
		expect(getToolTheme()).toBeUndefined();
		setThemeProvider(() => ({ fg: vi.fn() }) as unknown as Theme);
		setThemeProvider(undefined);
		expect(getToolTheme()).toBeUndefined();
	});

	it("fails open when a theme provider throws", () => {
		setThemeProvider(() => { throw new Error("theme unavailable"); });
		expect(getToolTheme()).toBeUndefined();
	});
});
