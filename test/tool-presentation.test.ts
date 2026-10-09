import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { highlightCode, initTheme, ToolExecutionComponent, type Theme, type ToolInfo, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installToolsStyle } from "../index.ts";
import { layoutToolView } from "../src/frame.js";
import { setIconMode } from "../src/settings.ts";
import { createToolRendererResolver, setToolRendererEnabled } from "../src/tool-renderer.ts";
import { clearToolSpinners, getToolSpinnerFrame } from "../src/tool-spinner.ts";
import {
	createToolView,
	extractToolText,
	invalidateToolViewCache,
	normalizeDisplayText,
	resolveDisplayPath,
	type ToolContext,
	type ToolResult,
	type ToolSection,
	type ToolSnapshot,
	type ToolView,
} from "../src/tool-presentation.ts";

const capabilities = vi.hoisted(() => ({
	images: null as "kitty" | "iterm2" | null,
	trueColor: false,
	hyperlinks: false,
}));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
	return {
		...actual,
		getCapabilities: () => capabilities,
	};
});

const theme = { fg: (_: string, text: string) => text } as unknown as Theme;

function context(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		args: {},
		toolCallId: "call-id",
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
		outputPad: 1,
		...overrides,
	};
}

function result(content: ToolResult["content"], details: unknown = {}): ToolResult {
	return { content, details } as ToolResult;
}

function textResult(text: string, details: unknown = {}): ToolResult {
	return result([{ type: "text", text }], details);
}

function snapshot(overrides: Partial<ToolSnapshot> = {}): ToolSnapshot {
	return {
		args: {},
		context: context(),
		presentation: "builtin",
		...overrides,
	};
}

function view(toolName: string, overrides: Partial<ToolSnapshot> = {}): ToolView {
	return createToolView(toolName, snapshot(overrides), theme);
}

function sectionWithLabel(view: ToolView, label: string): ToolSection | undefined {
	return view.sections.find((section) => section.label === label);
}

/** Render a section and drop the width padding `Text` adds to every row. */
function renderSection(section: ToolSection | undefined, width = 200): string {
	return section
		? section.component
				.render(width)
				.map((line) => line.trimEnd())
				.join("\n")
		: "";
}

function renderInput(live: ToolView, width = 200): string {
	return live.sections.filter((entry) => entry.slot === "call").map((entry) => renderSection(entry, width)).join("\n");
}

function firstResultSection(live: ToolView): ToolSection | undefined {
	return live.sections.find((entry) => entry.slot === "result" && entry.preview !== false);
}

function primaryCallSection(live: ToolView): ToolSection | undefined {
	return live.sections.find((entry) => entry.slot === "call" && entry.label === undefined);
}

function mcpInfo(overrides: Partial<ToolInfo> = {}): ToolInfo {
	return {
		name: "mcp__docs__read",
		sourceInfo: { path: "builtin:mcp", source: "builtin" },
		...overrides,
	} as ToolInfo;
}

const plainTheme = {
	fg: (_: string, text: string) => text,
	bold: (text: string) => text,
	getBgAnsi: () => "",
} as unknown as Theme;

/** Run the real producer and the real frame layout, returning unstyled rows. */
function layoutRows(toolName: string, overrides: Partial<ToolSnapshot>, width = 80): string[] {
	const snap = snapshot(overrides);
	const rendered = createToolView(toolName, snap, plainTheme);
	const layout = layoutToolView(rendered, snap, plainTheme, width);
	return [...layout.callRows, ...layout.resultRows].map(stripTerminalSequences);
}

beforeEach(() => {
	initTheme("dark", false);
});

afterEach(() => {
	capabilities.images = null;
	capabilities.hyperlinks = false;
	vi.restoreAllMocks();
});

describe("normalizeDisplayText", () => {
	it("strips terminal escape sequences and carriage returns", () => {
		expect(normalizeDisplayText("\u001b[31mred\u001b[0m")).toBe("red");
		expect(normalizeDisplayText("a\r\nb")).toBe("a\nb");
		expect(normalizeDisplayText("\u001b]0;title\u0007kept")).toContain("kept");
	});

	it("converts tabs to three spaces", () => {
		expect(normalizeDisplayText("a\tb")).toBe("a   b");
	});

	it("maps C0 controls to Control Pictures, DEL to a glyph and C1 to a hex escape", () => {
		expect(normalizeDisplayText("a\u0007b")).toBe("a\u2407b");
		expect(normalizeDisplayText("a\u0001b")).toBe("a\u2401b");
		expect(normalizeDisplayText("a\u007fb")).toBe("a\u2421b");
		expect(normalizeDisplayText("a\u009bb")).toBe("a\\x9Bb");
	});

	it("keeps newlines and printable unicode", () => {
		expect(normalizeDisplayText("héllo\n🌍")).toBe("héllo\n🌍");
	});
});

describe("extractToolText", () => {
	it("returns nothing for a missing result", () => {
		expect(extractToolText(undefined, true)).toBe("");
	});

	it("normalizes and joins text blocks with newlines", () => {
		const live = result([
			{ type: "text", text: "a\tb" },
			{ type: "text", text: "c\rd" },
		]);
		expect(extractToolText(live, true)).toBe("a   b\ncd");
	});

	it("adds an image placeholder only when the image cannot be shown", () => {
		const live = result([
			{ type: "text", text: "before" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);

		const unsupported = extractToolText(live, true);
		expect(unsupported).toContain("before");
		expect(unsupported).toContain("image/png");
		expect(unsupported.split("\n").length).toBeGreaterThan(1);

		const hidden = extractToolText(live, false);
		expect(hidden).toContain("image/png");

		capabilities.images = "kitty";
		expect(extractToolText(live, true)).toBe("before");
	});

	it("sanitizes a malicious MIME type in the generated image fallback", () => {
		const hostile = "image/png\u001b]0;owned\u0007\u0001\u009b";
		const live = result([{ type: "image", data: "AAAA", mimeType: hostile }]);

		const text = extractToolText(live, true);
		expect(text).toContain("image/png");
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("\u0007");
		expect(text).not.toContain("\u0001");
		expect(text).not.toContain("\u009b");

		// The result content is never mutated by display handling.
		expect(live.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: hostile });
	});
});

describe("resolveDisplayPath", () => {
	it("expands a tilde prefix", () => {
		expect(resolveDisplayPath("~/x", "/base")).toBe(join(homedir(), "x"));
		expect(resolveDisplayPath("~", "/base")).toBe(homedir());
	});

	it("decodes file URLs", () => {
		expect(resolveDisplayPath("file:///tmp/a%20b.txt", "/base")).toBe("/tmp/a b.txt");
	});

	it("resolves relatives against cwd and keeps absolutes", () => {
		expect(resolveDisplayPath("sub/x", "/base")).toBe("/base/sub/x");
		expect(resolveDisplayPath("/abs/x", "/base")).toBe("/abs/x");
	});

	it("does not trim whitespace", () => {
		expect(resolveDisplayPath("  x", "/base")).toBe("/base/  x");
	});

	it("fails on a malformed file URL instead of faking a relative path", () => {
		expect(() => resolveDisplayPath("file:///tmp/a%ZZ.txt", "/base")).toThrow();
	});

	it.skipIf(process.platform !== "win32")("converts Windows shell drive paths before expanding tildes", () => {
		expect(resolveDisplayPath("/c/Users/me", "C:\\base")).toBe("C:\\Users\\me");
		expect(resolveDisplayPath("/mnt/c/Users/me", "C:\\base")).toBe("C:\\Users\\me");
	});
});

describe("head contracts", () => {
	it("derives state from the live revision", () => {
		expect(view("bash").head.status).toBe("pending");
		expect(view("bash", { context: context({ executionStarted: true }) }).head.status).toBe("running");
		// Streamed arguments alone (no result, no started execution) are not "running".
		expect(view("bash", { context: context({ isPartial: true }) }).head.status).toBe("pending");
		expect(view("bash", { result: textResult("x") }).head.status).toBe("done");
		expect(view("bash", { result: textResult("x"), context: context({ isError: true }) }).head.status).toBe("error");
	});

	it("keeps a partial result running instead of final", () => {
		const partial = view("bash", {
			args: { command: "ls" },
			result: textResult("chunk"),
			context: context({ isPartial: true }),
		});
		expect(partial.head.status).toBe("running");

		const partialError = view("bash", {
			args: { command: "ls" },
			result: textResult("boom"),
			context: context({ isPartial: true, isError: true }),
		});
		expect(partialError.head.status).toBe("running");

		const final = view("bash", {
			args: { command: "ls" },
			result: textResult("done"),
			context: context({ isPartial: false }),
		});
		expect(final.head.status).toBe("done");

		const finalError = view("bash", {
			args: { command: "ls" },
			result: textResult("boom"),
			context: context({ isPartial: false, isError: true }),
		});
		expect(finalError.head.status).toBe("error");
	});

	it("never infers error or cancellation from free result text", () => {
		const errored = view("bash", { result: textResult("command not found"), context: context({ isError: false }) });
		expect(errored.head.status).toBe("done");
		expect(errored.tone).toBeUndefined();
	});

	it("normalizes controls in Command input but keeps command newlines", () => {
		const live = view("bash", { args: { command: "echo\t\u0007\u001b[31mhi\u001b[0m" } });
		expect(live.head.target).toBe("");
		expect(renderSection(sectionWithLabel(live, "Command"))).toBe("$ echo   \u2407hi");
		expect(renderSection(sectionWithLabel(view("bash", { args: { command: "a\nb" } }), "Command"))).toBe("$ a\nb");
	});

	it("carries duration only from context and never duplicates it into meta", () => {
		const live = view("bash", { args: { command: "ls" }, context: context({ durationMs: 1500 }) });
		expect(live.head.durationMs).toBe(1500);
		expect(live.head.meta.join(" ")).not.toContain("1.5");
		const absent = view("bash", { args: { command: "ls" } });
		expect(absent.head.durationMs).toBeUndefined();
		expect(absent.head.meta).toEqual([]);
	});

	it("uses a pending ellipsis while a streamed argument is missing", () => {
		expect(renderInput(view("bash"))).toContain("…");
		expect(renderInput(view("find"))).toContain("…");
		expect(renderInput(view("read"))).toContain("…");
	});

	it("marks a present-but-wrong-type argument without throwing", () => {
		expect(renderInput(view("bash", { args: { command: 42 } }))).toContain("[invalid arg]");
		expect(renderInput(view("find", { args: { pattern: { nested: true } } }))).toContain("[invalid arg]");
		expect(renderInput(view("bash", { args: { command: null } }))).toContain("[invalid arg]");
		expect(renderInput(view("read", { args: { path: null } }))).toContain("[invalid arg]");
		expect(renderInput(view("bash", { args: { command: undefined } }))).toContain("…");
	});

	it("links a real '[invalid arg]' filename instead of reading it as the wrong-type marker", () => {
		capabilities.hyperlinks = true;
		const literal = renderInput(view("read", { args: { path: "[invalid arg]" } }));
		expect(literal).toContain("\u001b]8;;");
		expect(stripTerminalSequences(literal)).toContain("[invalid arg]");

		expect(renderInput(view("read", { args: { path: null } }))).toContain("[invalid arg]");
	});

	it("ignores unsupported argument aliases and keeps the pending ellipsis", () => {
		for (const toolName of ["read", "write", "edit"]) {
			expect(renderInput(view(toolName, { args: { ["file_path"]: "/tmp/a.txt" } }))).toContain("…");
		}
		// Unsupported aliases never become the actual path.
		expect(view("ls", { args: { ["file_path"]: "/tmp/a.txt" } }).head.target).not.toBe("/tmp/a.txt");
	});

	it("ignores non-finite numeric arguments", () => {
		expect(view("bash", { args: { command: "ls", timeout: Number.NaN } }).head.meta).toEqual([]);
		expect(view("ls", { args: { limit: Number.POSITIVE_INFINITY } }).head.meta).toEqual([]);
	});

	it("follows the supplied expanded flag", () => {
		expect(view("edit", { context: context({ expanded: true }) }).expanded).toBe(true);
		expect(view("edit").expanded).toBe(false);
	});
});

describe("bash and powershell", () => {
	it("renders the command with a shell prompt and a tailing output preview", () => {
		const live = view("bash", {
			args: { command: "ls -la", timeout: 5 },
			result: textResult("line1\nline2"),
		});
		expect(live.head.target).toBe("");
		expect(renderSection(sectionWithLabel(live, "Command"))).toBe("$ ls -la");
		expect(live.head.meta).toEqual([]);
		expect(renderInput(live)).toContain("5s");
		expect(live.layout).toBe("framed");
		expect(live.preview).toEqual({ edge: "tail", count: 10, unit: "visual-lines" });
		expect(renderSection(sectionWithLabel(live, "Output"))).toContain("line2");
	});

	it("uses the PowerShell prompt for powershell", () => {
		expect(renderSection(sectionWithLabel(view("powershell", { args: { command: "Get-Date" } }), "Command"))).toBe("PS> Get-Date");
	});

	it("shows truncation and the full output path outside the clamp", () => {
		const live = view("bash", {
			args: { command: "cat big" },
			result: textResult("partial", {
				truncation: { truncated: true, maxBytes: 2048, truncatedBy: "bytes" },
				fullOutputPath: "/tmp/full.log",
			}),
		});
		const details = live.sections.find((section) => section.slot === "result" && section.preview === false);
		expect(details).toBeDefined();
		const rendered = renderSection(details);
		expect(rendered).toContain("[Truncated");
		expect(rendered).toContain("2.0KB");
		expect(rendered).toContain("Full output: /tmp/full.log");
	});

	it("keeps Command and adds no Output for an empty result", () => {
		const live = view("bash", { args: { command: "true" }, result: textResult("") });
		expect(renderInput(live)).toContain("$ true");
		expect(live.sections.filter((entry) => entry.slot === "result")).toEqual([]);
	});

	it("keeps shell options below Command instead of repeating supplied timeout in the header", () => {
		const rows = layoutRows("bash", { args: { command: "TIMEOUT_COMMAND", timeout: 5 }, result: textResult("TIMEOUT_OUTPUT") });
		const text = rows.join("\n");
		expect(rows[0]).not.toContain("TIMEOUT_COMMAND");
		expect(rows[0]).not.toContain("5s");
		expect(text).toContain("5s");
		expect(text.match(/5s/gu)).toHaveLength(1);
		expect(text.indexOf("TIMEOUT_COMMAND")).toBeLessThan(text.indexOf("5s"));
		expect(text.indexOf("5s")).toBeLessThan(text.indexOf("Output"));
	});
});

describe("read", () => {
	it("renders the path and supplied offset/limit in framed Input, never in the header", () => {
		const live = view("read", { args: { path: "/tmp/a.txt", offset: 5, limit: 10 } });
		expect(live.layout).toBe("framed");
		expect(live.head.target).toBe("");
		const input = renderInput(live);
		for (const supplied of ["/tmp/a.txt", "offset", "5", "limit", "10"]) expect(input).toContain(supplied);
		const offsetOnly = renderInput(view("read", { args: { path: "/tmp/a.txt", offset: 5 } }));
		expect(offsetOnly).toContain("offset");
		expect(offsetOnly).not.toContain("limit");
		const limitOnly = renderInput(view("read", { args: { path: "/tmp/a.txt", limit: 10 } }));
		expect(limitOnly).toContain("limit");
		expect(limitOnly).not.toContain("offset");
	});

	it("previews the first ten result visual lines without inventing an input offset", () => {
		const live = view("read", { args: { path: "/tmp/a.txt" } });
		expect(live.preview).toEqual({ edge: "head", count: 10, unit: "visual-lines" });
		expect(live.head.target).toBe("");
		expect(renderInput(live)).toContain("/tmp/a.txt");
		expect(renderInput(live)).not.toContain("offset");
	});

	it("shows the real result text and an error tone on failure", () => {
		const live = view("read", {
			args: { path: "/tmp/a.txt" },
			result: textResult("ENOENT: no such file"),
			context: context({ isError: true }),
		});
		expect(live.tone).toBe("error");
		expect(renderSection(firstResultSection(live))).toContain("ENOENT");
	});

	it("keeps truncation warnings outside the clamp", () => {
		const live = view("read", {
			args: { path: "/tmp/a.txt" },
			result: textResult("content", {
				truncation: { truncated: true, truncatedBy: "lines", outputLines: 2000, totalLines: 5000, maxLines: 2000 },
			}),
		});
		const warning = live.sections.find((section) => section.slot === "result" && section.preview === false);
		expect(warning?.preview).toBe(false);
		const rendered = renderSection(warning);
		expect(rendered).toContain("Truncated");
		expect(rendered).toContain("2000");
		expect(rendered).toContain("5000");
	});

	it("preserves leading indentation and blank lines of the file", () => {
		const indented = view("read", {
			args: { path: "/tmp/notes.unknownext" },
			result: textResult("def f():\n    return 1\n\n"),
		});
		expect(renderSection(firstResultSection(indented))).toBe("def f():\n    return 1");

		const leadingBlank = view("read", {
			args: { path: "/tmp/notes.unknownext" },
			result: textResult("\n    indented\n"),
		});
		expect(renderSection(firstResultSection(leadingBlank))).toBe("\n    indented");

		const markdown = view("read", {
			args: { path: "/tmp/notes.md" },
			result: textResult("\n    code block\n"),
		});
		expect(renderSection(firstResultSection(markdown))).toContain("code block");
	});
});

describe("write", () => {
	it("keeps the requested content visible after success", () => {
		const live = view("write", {
			args: { path: "/tmp/a.txt", content: "one\ntwo" },
			result: textResult("Wrote 2 lines"),
		});
		const content = primaryCallSection(live);
		expect(content?.slot).toBe("call");
		expect(renderSection(content)).toBe("one\ntwo");
		expect(live.head.meta).toEqual(["2 lines"]);
		expect(renderSection(sectionWithLabel(live, "Input"))).toContain("/tmp/a.txt");
		expect(renderSection(sectionWithLabel(live, "Output"))).toContain("Wrote 2 lines");
	});

	it("shows the real error without hiding the request", () => {
		const live = view("write", {
			args: { path: "/tmp/a.txt", content: "one" },
			result: textResult("EACCES: permission denied"),
			context: context({ isError: true }),
		});
		expect(live.tone).toBe("error");
		expect(renderSection(primaryCallSection(live))).toBe("one");
		const error = sectionWithLabel(live, "Error");
		expect(error?.preview).toBe(false);
		expect(renderSection(error)).toContain("EACCES");
	});

	it("reports a wrong-type content argument instead of inventing text", () => {
		expect(renderInput(view("write", { args: { path: "/tmp/a.txt", content: 3 } }))).toContain("[invalid arg]");
	});
});

describe("edit", () => {
	it("derives diff statistics only from the final diff", () => {
		const live = view("edit", {
			args: { path: "/tmp/a.txt" },
			result: textResult("ok", { diff: "--- a\n+++ b\n@@\n-old\n+new\n+extra\n" }),
		});
		expect(live.head.meta).toEqual(["+2 −1"]);
		expect(renderSection(sectionWithLabel(live, "Diff"))).toContain("+new");
	});

	it("does not claim statistics during the request revision", () => {
		const live = view("edit", {
			args: { path: "/tmp/a.txt", edits: [{ oldText: "old", newText: "new" }] },
		});
		expect(live.head.meta).toEqual([]);
		const preview = primaryCallSection(live);
		expect(preview?.slot).toBe("call");
		expect(renderSection(preview)).toBe("-old\n+new");
	});

	it("keeps the input alongside the real error on failure", () => {
		const live = view("edit", {
			args: { path: "/tmp/a.txt", oldText: "old", newText: "new" },
			result: textResult("String not found"),
			context: context({ isError: true }),
		});
		expect(live.tone).toBe("error");
		expect(renderInput(live)).toContain("-old\n+new");
		const error = sectionWithLabel(live, "Error");
		expect(error?.preview).toBe(false);
		expect(renderSection(error)).toContain("String not found");
	});

	it("marks malformed edit pairs instead of silently dropping the request", () => {
		const live = view("edit", { args: { path: "/tmp/a.txt", edits: [{ oldText: 1, newText: "new" }] } });
		expect(renderInput(live)).toContain("[invalid arg]");
		expect(renderInput(live)).toContain("new");
	});

	it("normalizes the raw diff before formatting it and counting statistics", () => {
		const rawDiff = "--- a\n+++ b\n@@ -1,1 +1,2 @@\n\u001b[9m-old\u001b[0m\n\u001b[32m+new\u001b[0m\n+bom\u0007\n";
		const live = view("edit", {
			args: { path: "/tmp/a.txt" },
			result: textResult("ok", { diff: rawDiff }),
		});

		expect(live.head.meta).toEqual(["+2 −1"]);
		const diff = renderSection(sectionWithLabel(live, "Diff"));
		expect(diff).toContain("\u2407");
		expect(diff).not.toContain("\u001b[9m");
		expect(diff).not.toContain("\u0007");
		// The renderer's own coloring survives.
		expect(diff).toContain("\u001b[");
	});

	it("keeps the request preview while a diff is still streaming", () => {
		const live = view("edit", {
			args: { path: "/tmp/a.txt", edits: [{ oldText: "old", newText: "new" }] },
			result: textResult("streaming", { diff: "--- a\n+++ b\n@@\n-old\n+new\n" }),
			context: context({ isPartial: true }),
		});

		expect(live.head.status).toBe("running");
		expect(live.head.meta).toEqual([]);
		expect(sectionWithLabel(live, "Diff")).toBeUndefined();
		expect(renderSection(primaryCallSection(live))).toBe("-old\n+new");
	});

	it("retains the active request primary beside a real partial error without premature diff statistics", () => {
		const state = {};
		const args = { path: "/offline/PARTIAL_ERROR_EDIT", oldText: "REQUEST_OLD", newText: "REQUEST_NEW" };
		const first = revision("edit", state, theme, { args });
		const failed = revision("edit", state, theme, {
			args,
			result: textResult("PARTIAL_DELIVERED_ERROR", { diff: "-NOT_FINAL\n+NOT_FINAL" }),
			context: context({ state, isError: true, isPartial: true }),
		});
		expect(primaryCallSection(failed)?.component).toBe(primaryCallSection(first)?.component);
		expect(renderInput(failed)).toContain("-REQUEST_OLD\n+REQUEST_NEW");
		expect(renderSection(sectionWithLabel(failed, "Error"))).toBe("PARTIAL_DELIVERED_ERROR");
		expect(sectionWithLabel(failed, "Error")?.preview).toBe(false);
		expect(sectionWithLabel(failed, "Diff")).toBeUndefined();
		expect(failed.head.meta).toEqual([]);
		expect(failed.head.status).toBe("running");
	});

	it("retains Input after an empty final success without inventing output", () => {
		const live = view("edit", {
			args: { path: "/tmp/a.txt", edits: [{ oldText: "old", newText: "new" }] },
			result: textResult(""),
		});
		expect(renderInput(live)).toContain("/tmp/a.txt");
		expect(renderInput(live)).toContain("-old\n+new");
		expect(live.sections.filter((entry) => entry.slot === "result")).toEqual([]);
	});
});

describe("find, grep and ls", () => {
	it("previews five whole entries for find", () => {
		const live = view("find", {
			args: { pattern: "*.ts", path: "/tmp/project", limit: 50 },
			result: textResult("a.ts\nb.ts\nc.ts"),
		});
		expect(live.preview).toEqual({ edge: "head", count: 5, unit: "entries" });
		expect(live.layout).toBe("framed");
		expect(live.head.target).toBe("");
		const input = renderInput(live);
		expect(input).toContain("*.ts");
		expect(input).toContain("/tmp/project");
		expect(input).toContain("50");
		expect(live.head.meta.join(" ")).not.toContain("/tmp/project");
		const entries = firstResultSection(live)?.component as { entryLines?: readonly string[] } | undefined;
		expect(entries?.entryLines).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("adds no entry section when find returns nothing", () => {
		const live = view("find", { args: { pattern: "*.ts" }, result: textResult("") });
		expect(live.sections.filter((entry) => entry.slot === "result")).toEqual([]);
		expect(renderInput(live)).toContain("*.ts");
	});

	it("keeps find limit warnings outside the clamp", () => {
		const live = view("find", {
			args: { pattern: "*.ts" },
			result: textResult("a.ts", { resultLimitReached: 100 }),
		});
		const warning = live.sections.find((section) => section.slot === "result" && section.preview === false);
		expect(warning?.preview).toBe(false);
		expect(renderSection(warning)).toContain("100 results limit");
	});

	it("surfaces grep metadata and warning flags", () => {
		const live = view("grep", {
			args: { pattern: "needle", path: "/tmp", glob: "*.ts", ignoreCase: true, literal: true, context: 3, limit: 20 },
			result: textResult("a.ts:1:needle", { matchLimitReached: 50, linesTruncated: true }),
		});
		const input = renderInput(live);
		for (const supplied of ["needle", "/tmp", "*.ts", "ignore", "literal", "context", "3", "limit", "20"]) {
			expect(input).toContain(supplied);
		}
		expect(live.head.meta.join(" ")).not.toContain("/tmp");
		expect(live.head.meta.join(" ")).not.toContain("*.ts");
		expect(live.head.target).toBe("");
		expect(live.preview).toEqual({ edge: "head", count: 10, unit: "visual-lines" });
		const warning = live.sections.find((section) => section.slot === "result" && section.preview === false);
		expect(warning?.preview).toBe(false);
		const rendered = renderSection(warning);
		expect(rendered).toContain("50 matches limit");
		expect(rendered).toContain("truncated");
	});

	it("keeps supplied ls options without inventing a working-directory input", () => {
		const live = view("ls", { args: { limit: 10 }, result: textResult("a\nb") });
		expect(live.head.target).toBe("");
		expect(renderInput(live)).not.toContain("path:");
		expect(renderInput(live)).toContain("10");
		expect(live.layout).toBe("framed");
	});
});

describe("provenance-aware dispatch", () => {
	it("returns full fallback Input for the generic presentation without native schema assumptions", () => {
		const live = view("read", { presentation: "generic", args: { path: "/tmp/a.txt" } });
		expect(live.layout).toBe("framed");
		expect(renderInput(live)).toContain("/tmp/a.txt");
		expect(sectionWithLabel(live, "Output")).toBeUndefined();
		expect(live.head.title).toBe("read");
		expect(live.head.target).toBe("");
	});

	it("treats an unknown builtin as generic without inventing content", () => {
		const live = view("not_a_tool");
		expect(live.head.title).toBe("not_a_tool");
		expect(renderInput(live)).toContain("{}");
		expect(sectionWithLabel(live, "Output")).toBeUndefined();
	});
});

describe("MCP", () => {
	it("uses the confirmed server/tool identity", () => {
		const live = view("mcp__docs__read", {
			presentation: "mcp",
			args: { path: "/x" },
			result: textResult("payload", { server: "docs", tool: "read" }),
		});
		expect(live.head.title).toBe("MCP");
		expect(live.head.target).toBe("docs/read");
		expect(live.preview).toEqual({ edge: "head", count: 5, unit: "visual-lines" });
	});

	it("falls back to a namespace target without splitting names", () => {
		const live = view("mcp__docs__read", {
			presentation: "mcp",
			toolInfo: mcpInfo({ namespace: { name: "mcp__docs" } }),
		});
		expect(live.head.target).toBe("mcp__docs/read");
		expect(live.head.meta).not.toContain("mcp__docs");
	});

	it("uses the namespace alone when the exposed name has no suffix", () => {
		const live = view("mcp__docs", { presentation: "mcp", toolInfo: mcpInfo({ namespace: { name: "mcp__docs" } }) });
		expect(live.head.target).toBe("mcp__docs");
	});

	it("falls back to the full exposed name", () => {
		const live = view("mcp__other__tool", { presentation: "mcp", toolInfo: mcpInfo({ namespace: { name: "mcp__docs" } }) });
		expect(live.head.target).toBe("mcp__other__tool");
	});

	it("reports exposure and true boolean hints only", () => {
		const live = view("mcp__docs__read", {
			presentation: "mcp",
			toolInfo: mcpInfo({
				namespace: { name: "mcp__docs" },
				exposure: "deferred",
				annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: false },
			}),
		});
		expect(live.head.meta).toEqual(["deferred", "hints: read-only, destructive"]);
	});

	it("keeps full argument data for layout previews and pretty-prints when expanded", () => {
		const collapsed = view("mcp__docs__read", {
			presentation: "mcp",
			args: { query: "x".repeat(200) },
		});
		const args = sectionWithLabel(collapsed, "Input");
		expect(args?.slot).toBe("call");
		expect(renderSection(args, 400)).toContain("x".repeat(200));

		const expanded = view("mcp__docs__read", {
			presentation: "mcp",
			args: { query: "abc", limit: 5 },
			context: context({ expanded: true }),
		});
		expect(renderSection(sectionWithLabel(expanded, "Input"))).toBe(
			'{\n  "query": "abc",\n  "limit": 5\n}',
		);
	});

	it("survives cyclic arguments without throwing", () => {
		const cyclic: Record<string, unknown> = { name: "loop" };
		cyclic.self = cyclic;
		const live = view("mcp__docs__read", { presentation: "mcp", args: cyclic });
		expect(renderSection(sectionWithLabel(live, "Input"))).toContain("loop");
	});

	it("keeps bigint/cyclic schema-less fields and does not mistake shared values for cycles", () => {
		const shared = { marker: "SHARED_DELIVERED_VALUE" };
		const args: Record<string, unknown> = { first: shared, second: shared, count: 12345678901234567890n };
		args.self = args;
		const input = renderInput(view("mcp__docs__read", { presentation: "mcp", args }), 1000);
		expect(input.match(/SHARED_DELIVERED_VALUE/gu)).toHaveLength(2);
		expect(input).toContain("12345678901234567890");
		expect(input).toContain('"self": "[Circular]"');
	});

	it("shows the literal Input for a propertyless call", () => {
		expect(renderSection(sectionWithLabel(view("mcp__docs__read", { presentation: "mcp", args: {} }), "Input"))).toBe("{}");
	});

	it("uses context.isError, not result.isError, and shows the full output path unread", () => {
		const live = view("mcp__docs__read", {
			presentation: "mcp",
			result: { ...textResult("boom", { server: "docs", tool: "read", fullOutputPath: "/nope/mcp.log" }), isError: true },
		});
		expect(live.tone).toBeUndefined();
		expect(live.head.status).toBe("done");
		const full = live.sections.find((section) => section.slot === "result" && section.preview === false);
		expect(renderSection(full)).toContain("/nope/mcp.log");

		const errored = view("mcp__docs__read", {
			presentation: "mcp",
			result: textResult("boom", { server: "docs", tool: "read" }),
			context: context({ isError: true }),
		});
		expect(errored.tone).toBe("error");
		expect(errored.head.status).toBe("error");
	});

	it("trims the result text like the native MCP renderer", () => {
		const live = view("mcp__docs__read", { presentation: "mcp", result: textResult("\n\npayload\n\n") });
		expect(renderSection(sectionWithLabel(live, "Output"))).toBe("payload");
	});
});

describe("MCP resources", () => {
	it("renders read_mcp_resource without repeating consumed arguments", () => {
		const live = view("read_mcp_resource", {
			presentation: "mcp",
			args: { server: "docs", uri: "res://x" },
			result: textResult("payload"),
		});
		expect(live.head.title).toBe("MCP Resource");
		expect(live.head.target).toBe("");
		expect(live.head.meta).toEqual([]);
		const input = renderInput(live);
		expect(input).toContain("res://x");
		expect(input).toContain("docs");
		expect(input.split("res://x")).toHaveLength(2);
		expect(input.split("docs")).toHaveLength(2);
	});

	it("keeps a listing cursor in Input without fabricating all-servers arguments", () => {
		const live = view("list_mcp_resources", {
			presentation: "mcp",
			args: { cursor: "next-page" },
		});
		expect(live.head.title).toBe("MCP Resources");
		expect(live.head.target).toBe("");
		expect(renderInput(live)).toContain("next-page");
		expect(renderInput(live)).not.toContain("all servers");
	});

	it("keeps the requested resource-listing server in Input", () => {
		const live = view("list_mcp_resource_templates", { presentation: "mcp", args: { server: "docs" } });
		expect(live.head.title).toBe("MCP Resource Templates");
		expect(live.head.target).toBe("");
		expect(renderInput(live)).toContain("docs");
	});

	it("keeps mcp-unresolved on the same frame", () => {
		const live = view("mcp__docs__read", { presentation: "mcp-unresolved", toolInfo: mcpInfo({ namespace: { name: "mcp__docs" } }) });
		expect(live.layout).toBe("framed");
		expect(live.head.title).toBe("MCP");
		expect(live.head.target).toBe("mcp__docs/read");
	});
});

describe("uniform native framed inputs", () => {
	it.each([
		["read", { path: "/offline/READ_PATH.txt", offset: 3, limit: 2 }, ["READ_PATH.txt", "3", "2"]],
		["find", { pattern: "FIND_PATTERN*.ts", path: "/offline/FIND_PATH", limit: 7 }, ["FIND_PATTERN", "FIND_PATH", "7"]],
		["grep", { pattern: "GREP_PATTERN", path: "/offline/GREP_PATH", glob: "*.unique", ignoreCase: false, literal: false, context: 0, limit: 0 }, ["GREP_PATTERN", "GREP_PATH", "*.unique", "false", "0"]],
		["ls", { path: "/offline/LS_PATH", limit: 3 }, ["LS_PATH", "3"]],
		["write", { path: "/offline/WRITE_PATH.txt", content: "WRITE_CONTENT" }, ["WRITE_PATH", "WRITE_CONTENT"]],
		["edit", { path: "/offline/EDIT_PATH.txt", oldText: "REQUEST_OLD", newText: "REQUEST_NEW" }, ["EDIT_PATH", "REQUEST_OLD", "REQUEST_NEW"]],
	] as const)("frames %s with actual input before delivered output and never in the header", (name, args, markers) => {
		const live = textResult("DELIVERED_RESULT", name === "edit" ? { diff: "--- a\n+++ b\n@@\n-FINAL_OLD\n+FINAL_NEW\n" } : {});
		const snap = snapshot({ args, result: live });
		const produced = createToolView(name, snap, plainTheme);
		expect(produced.layout).toBe("framed");
		expect(produced.head.target).toBe("");
		const input = stripTerminalSequences(renderInput(produced));
		for (const marker of markers) expect(input).toContain(marker);
		const layout = layoutToolView(produced, snap, plainTheme, 120);
		const call = layout.callRows.map(stripTerminalSequences).join("\n");
		const output = layout.resultRows.map(stripTerminalSequences).join("\n");
		expect(call).not.toMatch(/├─+ Input ─/u);
		for (const marker of markers) expect(layout.callRows[0]).not.toContain(marker);
		expect(output).toContain(name === "edit" ? "FINAL_NEW" : "DELIVERED_RESULT");
		expect(output).toContain(name === "edit" ? "Diff" : "Output");
		const path = args.path;
		expect([...layout.callRows, ...layout.resultRows].map(stripTerminalSequences).join("\n").split(path)).toHaveLength(2);
		expect(layout.resultOffset).toBe(layout.callRows.length);
	});

	it.each([
		["read", {}, "…"],
		["read", { path: null }, "[invalid arg]"],
		["find", {}, "…"],
		["find", { pattern: 42 }, "[invalid arg]"],
		["grep", {}, "…"],
		["grep", { pattern: false }, "[invalid arg]"],
		["ls", { path: null }, "[invalid arg]"],
		["write", { path: "/offline/pending", content: undefined }, "…"],
		["write", { path: "/offline/invalid", content: 42 }, "[invalid arg]"],
		["edit", { path: "/offline/pending" }, "…"],
		["edit", { path: "/offline/invalid", oldText: 42, newText: "NEW" }, "[invalid arg]"],
	] as const)("keeps %s Input visible while pending or malformed: %j", (name, args, marker) => {
		const rows = layoutRows(name, { args });
		const text = rows.join("\n");
		expect(rows[0]).toContain("╭");
		expect(rows[0]).not.toContain(marker);
		expect(text).not.toMatch(/├─+ Input ─/u);
		expect(text).toContain(marker);
		expect(text).not.toContain("Output");
	});

	it.each([
		["read", { path: "" }],
		["find", { pattern: "" }],
		["grep", { pattern: "" }],
		["ls", { path: "" }],
		["write", { path: "/offline/empty", content: "" }],
		["edit", { path: "/offline/empty", oldText: "", newText: "" }],
	] as const)("does not erase the explicitly empty %s input", (name, args) => {
		const text = layoutRows(name, { args }).join("\n");
		expect(text).not.toMatch(/├─+ Input ─/u);
		expect(text).toContain('""');
		expect(text).not.toContain("[invalid arg]");
	});

	it.each(["bash", "powershell"])("keeps %s Command preview independent of its output tail", (name) => {
		const args = { command: "FIRST_COMMAND\nSECOND_COMMAND", timeout: 0 };
		const live = textResult(numberedLines("SHELL_OUTPUT_", 12));
		const collapsed = layoutRows(name, { args, result: live }, 80);
		const text = collapsed.join("\n");
		expect(collapsed[0]).not.toContain("COMMAND");
		expect(text).not.toContain("Command");
		expect(text).toContain("FIRST_COMMAND");
		expect(text).not.toContain("SECOND_COMMAND");
		expect(text).toContain("1 more line");
		expect(text).toContain("2 more lines");
		expect(text).not.toContain("SHELL_OUTPUT_01");
		expect(text).toContain("SHELL_OUTPUT_12");
		expect(text.indexOf("FIRST_COMMAND")).toBeLessThan(text.indexOf("Output"));
		const expanded = layoutRows(name, { args, result: live, context: context({ expanded: true }) }, 80).join("\n");
		expect(expanded).toContain("SECOND_COMMAND");
		expect(expanded).toContain("SHELL_OUTPUT_01");
		expect(expanded).not.toContain("more line");
	});

	it("retains final Edit Input above the real diff and above a real failure", () => {
		const args = { path: "/offline/EDIT_INPUT.txt", edits: [{ oldText: "REQUEST_OLD", newText: "REQUEST_NEW" }] };
		const success = layoutRows("edit", {
			args,
			result: textResult("Edited", { diff: "--- a\n+++ b\n@@\n-DELIVERED_OLD\n+DELIVERED_NEW\n" }),
		}).join("\n");
		for (const marker of ["EDIT_INPUT.txt", "REQUEST_OLD", "REQUEST_NEW", "DELIVERED_OLD", "DELIVERED_NEW"]) expect(success).toContain(marker);
		expect(success.indexOf("EDIT_INPUT.txt")).toBeLessThan(success.indexOf("REQUEST_OLD"));
		expect(success.indexOf("REQUEST_NEW")).toBeLessThan(success.indexOf("Diff"));
		expect(success.match(/REQUEST_OLD/gu)).toHaveLength(1);
		expect(success.match(/REQUEST_NEW/gu)).toHaveLength(1);
		const failed = layoutRows("edit", { args, result: textResult("String not found"), context: context({ isError: true }) }).join("\n");
		expect(failed).toContain("REQUEST_OLD");
		expect(failed).toContain("REQUEST_NEW");
		expect(failed).toContain("String not found");
		expect(failed.indexOf("REQUEST_NEW")).toBeLessThan(failed.indexOf("String not found"));
	});
});

describe("complete native input data", () => {
	it.each(["bash", "powershell", "read", "find", "grep", "ls", "write", "edit"])(
		"keeps every supplied %s option, including false, zero and own __proto__ data",
		(name) => {
			const args = JSON.parse('{"command":"COMMAND_VALUE","path":"/offline/PATH_VALUE","pattern":"PATTERN_VALUE","content":"CONTENT_VALUE","oldText":"OLD_VALUE","newText":"NEW_VALUE","extra":false,"zero":0,"__proto__":{"marker":"OWN_NATIVE_PROPERTY"}}') as unknown;
			const before = JSON.stringify(args);
			const live = view(name, { args, result: textResult("ACTUAL_RESULT") });
			const input = stripTerminalSequences(renderInput(live, 1000));
			for (const marker of ["COMMAND_VALUE", "PATH_VALUE", "PATTERN_VALUE", "CONTENT_VALUE", "OLD_VALUE", "NEW_VALUE", "extra: false", "zero: 0", "__proto__", "OWN_NATIVE_PROPERTY"]) {
				expect(input).toContain(marker);
			}
			expect(live.head.target).toBe("");
			expect(live.head.meta.join(" ")).not.toContain("VALUE");
			expect(JSON.stringify(args)).toBe(before);
		},
	);

	it.each(["bash", "powershell", "read", "find", "grep", "ls", "write", "edit"])(
		"retains an explicitly delivered null %s input instead of substituting context args",
		(name) => {
			const live = view(name, { args: null, context: context({ args: { path: "NOT_DELIVERED", command: "NOT_DELIVERED" } }) });
			expect(renderInput(live)).toContain("null");
			expect(renderInput(live)).not.toContain("NOT_DELIVERED");
		},
	);

	it.each([
		["bash", "command"], ["powershell", "command"], ["read", "path"], ["find", "pattern"],
		["grep", "pattern"], ["ls", "path"], ["write", "content"], ["edit", "oldText"],
	] as const)("shows normalized-empty %s %s as a visible escaped literal", (name, field) => {
		for (const raw of ["\u001b[31m\u001b[0m", "\ufdd0", "\t\n  "]) {
			const args = { path: "/offline/EMPTY_INPUT.py", content: "content", oldText: "old", newText: "new", [field]: raw };
			const live = view(name, { args });
			expect(renderInput(live)).toContain(normalizeDisplayText(JSON.stringify(raw)));
			expect(renderInput(live)).not.toContain("\ufdd0");
			expect(live.head.target).toBe("");
		}
	});

	it("keeps the actual wrong-type string-field data beside the marker", () => {
		const input = renderInput(view("read", { args: { path: { nested: "INVALID_PATH_DATA" }, offset: 0, limit: false } }));
		expect(input).toContain('path: [invalid arg] ({"nested":"INVALID_PATH_DATA"})');
		expect(input).toContain("offset: 0");
		expect(input).toContain("limit: false");
	});

	it("does not erase invalid non-finite options or pretend they are header metadata", () => {
		const live = view("bash", { args: { command: "true", timeout: Number.NaN, extra: Infinity } });
		expect(live.head.meta).toEqual([]);
		expect(renderInput(live)).toContain("timeout: NaN");
		expect(renderInput(live)).toContain("extra: Infinity");
	});

	it("keeps complete mixed edit pairs and pair-specific properties without fabricating invalid diffs", () => {
		const args = {
			path: "/offline/MIXED_EDITS",
			edits: [
				{ oldText: "VALID_OLD", newText: "VALID_NEW", extra: false },
				{ oldText: 42, newText: "INVALID_PAIR_NEW", zero: 0 },
				null,
			],
		};
		const input = renderInput(view("edit", { args, result: textResult("String not found"), context: context({ isError: true }) }));
		expect(input).toContain("-VALID_OLD\n+VALID_NEW");
		expect(input).toContain("extra: false");
		expect(input).toContain("oldText: [invalid arg] (42)");
		expect(input).toContain("newText: INVALID_PAIR_NEW");
		expect(input).toContain("zero: 0");
		expect(input).toContain("[invalid arg] (null)");
		expect(input).not.toContain("-42");
	});

	it("retains both provided single-edit and multi-edit requests when both were delivered", () => {
		const input = renderInput(view("edit", {
			args: { path: "/offline/DUAL_EDIT", edits: [{ oldText: "MULTI_OLD", newText: "MULTI_NEW" }], oldText: "SINGLE_OLD", newText: "SINGLE_NEW" },
		}));
		for (const marker of ["-MULTI_OLD", "+MULTI_NEW", "-SINGLE_OLD", "+SINGLE_NEW"]) expect(input).toContain(marker);
	});
});

describe("complete generic semantic fallbacks", () => {
	it("keeps full safe fallback Input and extracted Output with independent previews", () => {
		const args = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`FIELD_${index + 1}`, `VALUE_${index + 1}`]));
		const delivered = textResult(numberedLines("GENERIC_OUTPUT_", 7));
		const snap = snapshot({ presentation: "generic", args, result: delivered });
		const live = createToolView("opaque_tool", snap, plainTheme);
		const input = sectionWithLabel(live, "Input");
		const output = sectionWithLabel(live, "Output");
		expect(input?.previewPolicy).toEqual({ edge: "head", count: 10, unit: "visual-lines" });
		expect(output?.previewPolicy).toEqual({ edge: "head", count: 5, unit: "visual-lines" });
		expect(renderSection(input)).toContain("VALUE_12");
		expect(renderSection(output)).toContain("GENERIC_OUTPUT_07");
		const rows = layoutRows("opaque_tool", { presentation: "generic", args, result: delivered }).join("\n");
		expect(rows).not.toMatch(/├─+ Input ─/u);
		expect(rows).toContain("Output");
		expect(rows).not.toContain("VALUE_12");
		expect(rows).not.toContain("GENERIC_OUTPUT_06");
		const expanded = layoutRows("opaque_tool", { presentation: "generic", args, result: delivered, context: context({ expanded: true }) }).join("\n");
		expect(expanded).toContain("VALUE_12");
		expect(expanded).toContain("GENERIC_OUTPUT_07");
		expect(expanded).not.toContain("more lines");
	});

	it.each([{ args: undefined, marker: "…" }, { args: {}, marker: "{}" }, { args: [], marker: "[]" }, { args: null, marker: "null" }, { args: "", marker: '""' }])(
		"keeps a generic literal Input for $marker without inventing an empty Output",
		({ args, marker }) => {
			const live = view("opaque_tool", { presentation: "generic", args, result: textResult(""), context: context({ args, isError: true }) });
			expect(renderInput(live)).toContain(marker);
			expect(live.sections.filter((entry) => entry.slot === "result")).toEqual([]);
			expect(live.tone).toBe("error");
		},
	);

	it("preserves fallback output indentation, normalized controls and delivered errors", () => {
		const live = view("opaque_tool", { presentation: "generic", args: { extra: false }, result: textResult("  ERROR_DETAIL\t\u0007\nSECOND_LINE"), context: context({ isError: true }) });
		expect(renderSection(sectionWithLabel(live, "Output"))).toBe("  ERROR_DETAIL   ␇\nSECOND_LINE");
		expect(live.head.target).toBe("");
		expect(live.tone).toBe("error");
	});
});

describe("uniform input and output previews", () => {
	it.each([24, 80, 120])("bounds wrapped Write Input and Output independently at %s columns", (width) => {
		const args = {
			path: "/offline/wrapped.txt",
			content: numberedLines("WRITE_INPUT_", 12).split("\n").map((line) => `${line} ${"界é".repeat(12)}`).join("\n"),
		};
		const live = textResult(numberedLines("WRITE_OUTPUT_", 12).split("\n").map((line) => `${line} ${"界é".repeat(12)}`).join("\n"));
		for (const outputPad of [0, 1, 2]) {
			const snap = snapshot({ args, result: live, context: context({ outputPad }) });
			const produced = createToolView("write", snap, plainTheme);
			const layout = layoutToolView(produced, snap, plainTheme, width);
			const rows = [...layout.callRows, ...layout.resultRows].map(stripTerminalSequences);
			expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
			const input = primaryCallSection(produced);
			const output = sectionWithLabel(produced, "Output");
			expect(input).toBeDefined();
			expect(output).toBeDefined();
			const inputBounds = layout.callChildBounds.find((entry) => entry.component === input?.component);
			const outputBounds = layout.resultChildBounds.find((entry) => entry.component === output?.component);
			expect(inputBounds?.height).toBe(8);
			expect(outputBounds?.height).toBe(8);
			expect(inputBounds).toBeDefined();
			expect(outputBounds).toBeDefined();
			const hiddenInput = input!.component.render(inputBounds!.width).length - 8;
			const hiddenOutput = output!.component.render(outputBounds!.width).length - 8;
			expect(layout.callRows.map(stripTerminalSequences).join("\n")).toContain(`${hiddenInput} more lines`);
			expect(layout.resultRows.map(stripTerminalSequences).join("\n")).toContain(`${hiddenOutput} more lines`);
			expect(layout.resultOffset).toBe(layout.callRows.length);
			expect(layout.callRows.some((row) => stripTerminalSequences(row).startsWith("╰"))).toBe(false);
			expect(stripTerminalSequences(layout.resultRows.at(-1) ?? "")).toContain("╰");
			const expandedSnap = snapshot({ args, result: live, context: context({ expanded: true, outputPad }) });
			const expanded = layoutToolView(createToolView("write", expandedSnap, plainTheme), expandedSnap, plainTheme, width);
			const full = [...expanded.callRows, ...expanded.resultRows].map(stripTerminalSequences).join("\n");
			expect(full).toContain("WRITE_INPUT_12");
			expect(full).toContain("WRITE_OUTPUT_12");
			expect(full).not.toContain("more lines");
			expect(expanded.resultOffset).toBe(expanded.callRows.length);
		}
	});

	it("preserves real highlighted Write content as an Input continuation after completion", () => {
		const code = "def write_input():\n    return 1";
		const live = view("write", { args: { path: "/offline/highlight.py", content: code }, result: textResult("Wrote file") });
		const input = primaryCallSection(live);
		expect(input?.label).toBeUndefined();
		const expected = new Text(highlightCode(code, "python").join("\n"), 0, 0)
			.render(200).map((line) => line.trimEnd()).join("\n");
		expect(renderSection(input)).toBe(expected);
		expect(renderSection(sectionWithLabel(live, "Output"))).toContain("Wrote file");
	});

	it.each(["read", "ls"])("preserves %s output's head-ten policy and nonpreview warnings", (name) => {
		const args = { path: "/offline/HEAD_PATH", limit: 0 };
		const details = name === "read"
			? { truncation: { truncated: true, truncatedBy: "lines", outputLines: 12, totalLines: 20, maxLines: 12 } }
			: { entryLimitReached: 20 };
		const live = textResult(numberedLines("HEAD_OUTPUT_", 12), details);
		const collapsed = layoutRows(name, { args, result: live }).join("\n");
		expect(collapsed).toContain("HEAD_OUTPUT_01");
		expect(collapsed).toContain("HEAD_OUTPUT_10");
		expect(collapsed).not.toContain("HEAD_OUTPUT_11");
		expect(collapsed).toContain("2 more lines");
		expect(collapsed).toContain("Truncated");
		expect(collapsed).toContain("20");
		const expanded = layoutRows(name, { args, result: live, context: context({ expanded: true }) }).join("\n");
		expect(expanded).toContain("HEAD_OUTPUT_12");
		expect(expanded).not.toContain("more lines");
	});

	it("does not invent a success Output when Write delivers an empty result", () => {
		const text = layoutRows("write", { args: { path: "/offline/empty-result", content: "RETAINED_WRITE" }, result: textResult("") }).join("\n");
		expect(text).not.toMatch(/├─+ Input ─/u);
		expect(text).toContain("RETAINED_WRITE");
		expect(text).not.toContain("Output");
		expect(text).not.toContain("Wrote");
	});
});

describe("uniform MCP framed inputs", () => {
	it.each(["mcp", "mcp-unresolved"] as const)("keeps callable identity in the %s header but actual arguments only in Input", (presentation) => {
		const args = JSON.parse('{"query":"MCP_QUERY","path":"/offline/MCP_PATH","limit":0,"enabled":false,"__proto__":{"marker":"OWN_MCP_PROPERTY"}}') as unknown;
		const before = JSON.stringify(args);
		const rows = layoutRows("mcp__docs__lookup", {
			presentation,
			toolInfo: mcpInfo({ name: "mcp__docs__lookup", namespace: { name: "mcp__docs" } }),
			args,
			result: textResult("MCP_RESULT", { server: "docs", tool: "lookup" }),
		}, 120);
		const text = rows.join("\n");
		expect(rows[0]).toContain("docs/lookup");
		for (const marker of ["MCP_QUERY", "/offline/MCP_PATH", "OWN_MCP_PROPERTY"]) {
			expect(rows[0]).not.toContain(marker);
			expect(text.split(marker)).toHaveLength(2);
		}
		expect(text).not.toMatch(/├─+ Input ─/u);
		for (const marker of ["query", "limit", "0", "false", "__proto__", "Output", "MCP_RESULT"]) expect(text).toContain(marker);
		expect(text.indexOf("MCP_QUERY")).toBeLessThan(text.indexOf("Output"));
		expect(JSON.stringify(args)).toBe(before);
	});

	it.each(["read_mcp_resource", "list_mcp_resources", "list_mcp_resource_templates"])("puts every supplied %s argument in the body once", (name) => {
		const args = { server: "RESOURCE_SERVER", uri: "res://RESOURCE_URI", cursor: "RESOURCE_CURSOR", extra: false, limit: 0 };
		const rows = layoutRows(name, { presentation: "mcp", args, result: textResult("RESOURCE_RESULT") }, 120);
		const text = rows.join("\n");
		for (const marker of ["RESOURCE_SERVER", "res://RESOURCE_URI", "RESOURCE_CURSOR"]) {
			expect(rows[0]).not.toContain(marker);
			expect(text.split(marker)).toHaveLength(2);
		}
		expect(text).toContain("false");
		expect(text).toContain("0");
		expect(text).not.toMatch(/├─+ Input ─/u);
		expect(text.indexOf("RESOURCE_CURSOR")).toBeLessThan(text.indexOf("Output"));
		expect(text).toContain("RESOURCE_RESULT");
	});

	it.each([{ args: undefined, marker: "…" }, { args: {}, marker: "{}" }, { args: [], marker: "[]" }, { args: null, marker: "null" }])(
		"keeps absent or literal MCP Input for $marker",
		({ args, marker }) => {
			const text = layoutRows("mcp__docs__lookup", { presentation: "mcp", args, context: context({ args }) }).join("\n");
			expect(text).not.toMatch(/├─+ Input ─/u);
			expect(text).toContain(marker);
			expect(text).not.toContain("Output");
		},
	);

	it.each([
		[{ server: "docs" }, "…"],
		[{ server: "docs", uri: 42 }, "[invalid arg]"],
		[{ server: null, uri: "res://visible" }, "[invalid arg]"],
		[{ server: "", uri: "" }, '""'],
	] as const)("keeps missing, invalid and empty resource inputs visible: %j", (args, marker) => {
		const rows = layoutRows("read_mcp_resource", { presentation: "mcp", args });
		const text = rows.join("\n");
		expect(rows[0]).not.toContain(marker);
		expect(text).not.toMatch(/├─+ Input ─/u);
		expect(text).toContain(marker);
		expect(text).not.toContain("Output");
	});

	it("gives long MCP Input and Output independent hints and reveals both on expansion", () => {
		const args = { query: Array.from({ length: 32 }, (_, index) => `QUERY_${String(index + 1).padStart(2, "0")}`).join(" ") };
		const live = textResult(numberedLines("MCP_OUTPUT_", 7));
		const snap = snapshot({ presentation: "mcp", args, result: live });
		const produced = createToolView("mcp__docs__lookup", snap, plainTheme);
		const input = sectionWithLabel(produced, "Input");
		const output = sectionWithLabel(produced, "Output");
		expect(input).toBeDefined();
		expect(output).toBeDefined();
		const layout = layoutToolView(produced, snap, plainTheme, 24);
		const rows = [...layout.callRows, ...layout.resultRows].map(stripTerminalSequences);
		expect(layout.callChildBounds.find((entry) => entry.component === input?.component)?.height).toBe(10);
		expect(layout.resultChildBounds.find((entry) => entry.component === output?.component)?.height).toBe(5);
		expect(rows.filter((row) => /more lines/u.test(row))).toHaveLength(2);
		expect(rows.join("\n")).toContain("MCP_OUTPUT_05");
		expect(rows.join("\n")).not.toContain("MCP_OUTPUT_06");
		expect(rows.join("\n")).not.toContain("QUERY_32");
		expect(rows.every((row) => visibleWidth(row) <= 24)).toBe(true);
		const expanded = layoutRows("mcp__docs__lookup", { presentation: "mcp", args, result: live, context: context({ expanded: true }) }, 24).join("\n");
		expect(expanded).toContain("QUERY_32");
		expect(expanded).toContain("MCP_OUTPUT_07");
		expect(expanded).not.toContain("more lines");
	});
});

describe("createToolView with layoutToolView", () => {
	it("keeps a multiline command intact and reveals it once expanded", () => {
		const collapsed = layoutRows("bash", { args: { command: "first\nsecond" } }).join("\n");
		expect(collapsed).toContain("first");
		expect(collapsed).not.toContain("second");

		const expanded = layoutRows("bash", {
			args: { command: "first\nsecond" },
			context: context({ expanded: true }),
		}).join("\n");
		expect(expanded).toContain("first");
		expect(expanded).toContain("second");
		expect(expanded).not.toContain("Command");
	});

	it("links path targets to their canonical file URL without altering the display text", () => {
		capabilities.hyperlinks = true;
		const cases: Array<{ input: string; resolved: string }> = [
			{ input: "/abs/x.txt", resolved: "/abs/x.txt" },
			{ input: "rel/x.txt", resolved: join(process.cwd(), "rel/x.txt") },
			{ input: "~/x.txt", resolved: join(homedir(), "x.txt") },
			{ input: "file:///tmp/a%20b.txt", resolved: "/tmp/a b.txt" },
		];
		for (const { input, resolved } of cases) {
			const target = renderInput(view("read", { args: { path: input } }));
			expect(target).toContain(`\u001b]8;;${pathToFileURL(resolved).href}\u001b\\`);
			// The visible text stays exactly what the caller passed; only the href is canonical.
			expect(stripTerminalSequences(target)).toContain(input);
		}
	});

	it("renders a wrong-type path as a marker instead of a fabricated link", () => {
		capabilities.hyperlinks = true;
		for (const toolName of ["read", "write", "edit", "ls"]) {
			const target = renderInput(view(toolName, { args: { path: null } }));
			expect(target).toContain("[invalid arg]");
			expect(target).not.toContain("\u001b]8;;");
		}
	});

	it("leaves an unresolvable file URL unlinked", () => {
		capabilities.hyperlinks = true;
		const target = renderInput(view("read", { args: { path: "file:///tmp/a%ZZ.txt" } }));
		expect(target).not.toContain("\u001b]8;;");
		expect(target).toContain("file:///tmp/a%ZZ.txt");
	});

	it.skipIf(process.platform === "win32")("leaves a non-local file URL unlinked", () => {
		capabilities.hyperlinks = true;
		const target = renderInput(view("read", { args: { path: "file://example.com/tmp/a.txt" } }));
		expect(target).not.toContain("\u001b]8;;");
		expect(target).toContain("file://example.com/tmp/a.txt");
	});
});

/* -------------------------------------------------------------------------- */
/* Real Pi components                                                         */
/* -------------------------------------------------------------------------- */

function nativeInfo(name: string): ToolInfo {
	return {
		name,
		description: "Local rendering fixture",
		parameters: { type: "object", properties: {} },
		exposure: "direct",
		sourceInfo: { source: "builtin", path: `builtin:${name}`, scope: "temporary", origin: "top-level" },
	} as ToolInfo;
}

function facade(name: string, downstream: ToolRenderers | undefined, tools: ToolInfo[] = []): ToolRenderers {
	return createToolRendererResolver({ getAllTools: () => tools })(name, () => downstream)!;
}

function realTool(name: string, renderers: ToolRenderers | undefined, args: unknown = { value: "arg" }): ToolExecutionComponent {
	return new ToolExecutionComponent(name, "same-row", args, { outputPad: 1 }, renderers, { requestRender: vi.fn() } as never, process.cwd());
}

const plainRows = (component: ToolExecutionComponent, width = 80): string[] => component.render(width).map(stripTerminalSequences);
const numberedLines = (prefix: string, count: number): string =>
	Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`).join("\n");

describe("semantic views on real Pi components", () => {
	beforeEach(() => {
		installToolsStyle({ registerToolRenderer: vi.fn(), getAllTools: () => [] } as never);
		setToolRendererEnabled(true);
		clearToolSpinners();
		setIconMode("ascii");
	});

	afterEach(() => {
		clearToolSpinners();
		setToolRendererEnabled(true);
	});

	it("renders a real grep row in a frame with Input before Output and warnings outside the clamp", () => {
		const component = realTool("grep", facade("grep", undefined, [nativeInfo("grep")]), { pattern: "needle" });
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: numberedLines("G", 12) }],
				details: { matchLimitReached: 10, linesTruncated: true },
				isError: false,
				durationMs: 1250,
			},
			false,
		);

		const rows = plainRows(component);
		expect(rows.some((row) => row.startsWith("╭"))).toBe(true);
		expect(rows.some((row) => row.startsWith("╰"))).toBe(true);
		expect(rows[0]).not.toContain("needle");
		const text = rows.join("\n");
		expect(text).toContain("Grep");
		expect(text).toContain("needle");
		expect(text).not.toMatch(/├─+ Input ─/u);
		expect(text.indexOf("needle")).toBeLessThan(text.indexOf("Output"));
		expect(text.match(/needle/gu)).toHaveLength(1);
		expect(text).toContain("G01");
		expect(text).toContain("G10");
		expect(text).not.toContain("G11");
		expect(text).toContain("2 more lines");
		expect(text).toContain("10 matches limit");
		expect(text).toContain("some lines truncated");
		expect(text).toContain("1.3s");

		component.setExpanded(true);
		expect(plainRows(component).join("\n")).toContain("G12");
	});

	it("keeps a streaming confirmed MCP row running, shows the real error, and restores the captured downstream render OFF", () => {
		const args = { query: "needle" };
		const metadata = mcpInfo({ name: "mcp__docs__lookup", namespace: { name: "mcp__docs" } });
		const downstream: ToolRenderers = {
			renderCall: () => new Text("DOWNSTREAM_MCP_CALL", 0, 0),
			renderResult: () => new Text("DOWNSTREAM_MCP_RESULT", 0, 0),
		};
		const component = realTool(metadata.name, facade(metadata.name, downstream, [metadata]), args);
		const native = realTool(metadata.name, downstream, args);
		const details = { server: "my-docs", tool: "lookup" };
		const progress = { content: [{ type: "text", text: "PROGRESS_MARKER" }], details, isError: false, durationMs: 1250 };
		const failure = { content: [{ type: "text", text: "MCP_ERROR_TEXT" }], details, isError: true, durationMs: 1250 };
		component.markExecutionStarted();
		native.markExecutionStarted();
		component.updateResult(progress, true);
		native.updateResult(progress, true);

		const streaming = plainRows(component).join("\n");
		expect(streaming).toContain("PROGRESS_MARKER");
		expect(streaming).toContain("my-docs/lookup");
		expect(streaming).toContain(`· ${getToolSpinnerFrame("ascii")}`);
		expect(streaming).not.toMatch(/\bok\b/);
		expect(streaming).not.toContain("1.3s");

		component.updateResult(failure, false);
		native.updateResult(failure, false);
		const failed = plainRows(component).join("\n");
		expect(failed).toContain("MCP_ERROR_TEXT");
		expect(failed).toContain("!");
		expect(failed).toContain("1.3s");
		expect(failed).not.toMatch(/\bok\b/);
		expect(failed).not.toContain("DOWNSTREAM_MCP");

		setToolRendererEnabled(false);
		for (const width of [24, 80, 120]) expect(component.render(width)).toEqual(native.render(width));
		expect(plainRows(component).join("\n")).toContain("DOWNSTREAM_MCP_RESULT");
		setToolRendererEnabled(true);
		expect(plainRows(component).join("\n")).toContain("MCP_ERROR_TEXT");
	});

	it("omits a duration for a finalized row replayed without one", () => {
		const component = realTool("bash", facade("bash", undefined, [nativeInfo("bash")]), { command: "printf replay" });
		const replay = { content: [{ type: "text", text: "REPLAY_OUTPUT" }], details: {}, isError: false };
		component.markExecutionStarted();
		component.updateResult(replay, false);

		const first = plainRows(component).join("\n");
		expect(first).toContain("REPLAY_OUTPUT");
		expect(first).toContain("ok");
		expect(first).not.toMatch(/\d/);

		component.updateResult(replay, false);
		const second = plainRows(component).join("\n");
		expect(second).toContain("REPLAY_OUTPUT");
		expect(second).not.toMatch(/\d/);
	});
});

/* -------------------------------------------------------------------------- */
/* Owned primary reuse                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One owned producer revision for a render state. Reusing the same state object
 * exercises the retained preparation the layout depends on.
 */
function revision(toolName: string, state: object, activeTheme: Theme, overrides: Partial<ToolSnapshot> = {}): ToolView {
	return createToolView(toolName, snapshot({ context: context({ state }), ...overrides }), activeTheme);
}

describe("owned primary reuse", () => {
	it("retains the prepared output component for an unchanged revision", () => {
		const state = {};
		const args = { command: "ls -la", timeout: 5 };
		const toolResult = textResult("first line\nsecond line");
		const first = sectionWithLabel(revision("bash", state, theme, { args, result: toolResult }), "Output");
		const second = sectionWithLabel(revision("bash", state, theme, { args, result: toolResult }), "Output");

		expect(second?.component).toBe(first?.component);
		expect(renderSection(second)).toBe("first line\nsecond line");
		expect(renderSection(sectionWithLabel(revision("bash", state, theme, { args, result: toolResult }), "Command"))).toBe("$ ls -la");
	});

	it("re-reads a result mutated in place on the same render state", () => {
		const state = {};
		const args = { command: "ls" };
		const toolResult: ToolResult = textResult("before");
		const first = sectionWithLabel(revision("bash", state, theme, { args, result: toolResult }), "Output");
		toolResult.content = [{ type: "text", text: "after" }];
		const second = sectionWithLabel(revision("bash", state, theme, { args, result: toolResult }), "Output");

		expect(second?.component).not.toBe(first?.component);
		expect(renderSection(second)).toBe("after");
		expect(renderSection(second)).not.toContain("before");
	});

	it("keeps the details note fresh while the output component is retained", () => {
		const state = {};
		const args = { command: "ls" };
		const first = revision("bash", state, theme, { args, result: textResult("out") });
		const second = revision("bash", state, theme, { args, result: textResult("out", { fullOutputPath: "/tmp/full.log" }) });

		expect(first.sections.filter((entry) => entry.slot === "result")).toHaveLength(1);
		expect(second.sections.filter((entry) => entry.slot === "result")).toHaveLength(2);
		expect(sectionWithLabel(second, "Output")?.component).toBe(sectionWithLabel(first, "Output")?.component);
		expect(renderSection(second.sections.find((entry) => entry.slot === "result" && entry.preview === false))).toContain("/tmp/full.log");
	});

	it("retains a highlighted Read body and rebuilds it after the explicit root invalidation", () => {
		const state = {};
		const args = { path: "/tmp/module.py" };
		const toolResult = textResult("def run():\n    return 1");
		const first = revision("read", state, theme, { args, result: toolResult });
		const second = revision("read", state, theme, { args, result: toolResult });
		expect(firstResultSection(second)?.component).toBe(firstResultSection(first)?.component);
		expect(renderSection(firstResultSection(second))).toContain("run");

		invalidateToolViewCache(state);

		const third = revision("read", state, theme, { args, result: toolResult });
		expect(firstResultSection(third)?.component).not.toBe(firstResultSection(first)?.component);
		expect(renderSection(firstResultSection(third))).toContain("run");
	});

	it("retains a Read Markdown body and rebuilds it when the file text changes", () => {
		const state = {};
		const args = { path: "/tmp/notes.md" };
		const toolResult: ToolResult = textResult("# Title\n\nbody");
		const first = revision("read", state, theme, { args, result: toolResult });
		const second = revision("read", state, theme, { args, result: toolResult });
		expect(firstResultSection(second)?.component).toBe(firstResultSection(first)?.component);
		expect(renderSection(firstResultSection(second))).toContain("Title");

		toolResult.content = [{ type: "text", text: "# Other heading\n\nbody" }];
		const third = revision("read", state, theme, { args, result: toolResult });
		expect(firstResultSection(third)?.component).not.toBe(firstResultSection(first)?.component);
		expect(renderSection(firstResultSection(third))).toContain("Other heading");
	});

	it("retains a styled body across a colour-equivalent theme proxy and recolours when the colours change", () => {
		const state = {};
		const args = { pattern: "needle" };
		const toolResult = textResult("m1\nm2");
		// Structural theme stubs: the producers read only fg/colors/getColorMode/appearance.
		const base = {
			fg: (color: string, text: string) => `‹1:${color}›${text}`,
			colors: { toolOutput: "T1" },
			getColorMode: () => "truecolor",
			appearance: "dark",
		} as unknown as Theme;
		const first = revision("grep", state, base, { args, result: toolResult });
		const proxied = revision("grep", state, new Proxy(base, {}), { args, result: toolResult });
		expect(firstResultSection(proxied)?.component).toBe(firstResultSection(first)?.component);
		expect(renderSection(firstResultSection(proxied))).toContain("‹1:toolOutput›m1");

		const recolouredTheme = {
			fg: (color: string, text: string) => `‹2:${color}›${text}`,
			colors: { toolOutput: "T2" },
			getColorMode: () => "truecolor",
			appearance: "dark",
		} as unknown as Theme;
		const recoloured = revision("grep", state, recolouredTheme, { args, result: toolResult });
		expect(firstResultSection(recoloured)?.component).not.toBe(firstResultSection(first)?.component);
		expect(renderSection(firstResultSection(recoloured))).toContain("‹2:toolOutput›m1");
		expect(renderSection(firstResultSection(recoloured))).not.toContain("‹1:");
	});

	it("retains Write content and rebuilds it when the argument changes in place", () => {
		const state = {};
		const args: { path: string; content: string } = { path: "/tmp/notes.unknownext", content: "print(1)" };
		const first = primaryCallSection(revision("write", state, theme, { args }));
		const second = primaryCallSection(revision("write", state, theme, { args }));
		expect(second?.component).toBe(first?.component);
		expect(renderSection(second)).toBe("print(1)");

		args.content = "print(2)";
		const third = primaryCallSection(revision("write", state, theme, { args }));
		expect(third?.component).not.toBe(first?.component);
		expect(renderSection(third)).toBe("print(2)");
	});

	it("retains the finalized diff and rebuilds it when the diff is replaced in place", () => {
		const state = {};
		const args = { path: "/tmp/notes.unknownext" };
		const details: { diff?: string } = { diff: "--- a/notes\n+++ b/notes\n@@ -1,1 +1,1 @@\n-old\n+fresh\n" };
		const toolResult = result([{ type: "text", text: "ok" }], details);
		const first = sectionWithLabel(revision("edit", state, theme, { args, result: toolResult }), "Diff");
		const second = sectionWithLabel(revision("edit", state, theme, { args, result: toolResult }), "Diff");
		expect(second?.component).toBe(first?.component);
		expect(renderSection(second)).toContain("fresh");

		details.diff = "--- a/notes\n+++ b/notes\n@@ -1,1 +1,1 @@\n-replaced\n+rewritten\n";
		const third = sectionWithLabel(revision("edit", state, theme, { args, result: toolResult }), "Diff");
		expect(third?.component).not.toBe(first?.component);
		expect(renderSection(third)).toContain("rewritten");
		expect(renderSection(third)).not.toContain("fresh");
	});

	it("keeps the final diff primary while uncached full requests and options change", () => {
		const state = {};
		const args = { path: "/offline/CACHE_EDIT", edits: [{ oldText: "REQUEST_BEFORE", newText: "REQUEST_NEW" }], extra: false };
		const delivered = textResult("Edited", { diff: "--- a\n+++ b\n@@\n-RESULT_OLD\n+RESULT_NEW\n" });
		const first = revision("edit", state, theme, { args, result: delivered });
		const firstDiff = sectionWithLabel(first, "Diff");
		const second = revision("edit", state, theme, { args, result: delivered });
		expect(sectionWithLabel(second, "Diff")?.component).toBe(firstDiff?.component);
		expect(renderInput(second)).toContain("-REQUEST_BEFORE\n+REQUEST_NEW");
		args.edits[0]!.oldText = "REQUEST_AFTER";
		args.extra = true;
		const third = revision("edit", state, theme, { args, result: delivered });
		expect(sectionWithLabel(third, "Diff")?.component).toBe(firstDiff?.component);
		expect(renderInput(third)).toContain("-REQUEST_AFTER\n+REQUEST_NEW");
		expect(renderInput(third)).toContain("extra: true");
		expect(renderInput(third)).not.toContain("REQUEST_BEFORE");
		invalidateToolViewCache(state);
		const rebuilt = revision("edit", state, theme, { args, result: delivered });
		expect(sectionWithLabel(rebuilt, "Diff")?.component).not.toBe(firstDiff?.component);
		expect(renderInput(rebuilt)).toContain("REQUEST_AFTER");
	});

	it("retains the Write input primary when only real success/error output changes", () => {
		const state = {};
		const args = { path: "/offline/WRITE_CACHE.py", content: "print(WRITE_INPUT)" };
		const first = revision("write", state, theme, { args, result: textResult("SUCCESS_BEFORE") });
		const second = revision("write", state, theme, { args, result: textResult("SUCCESS_AFTER") });
		expect(primaryCallSection(second)?.component).toBe(primaryCallSection(first)?.component);
		expect(renderSection(sectionWithLabel(second, "Output"))).toBe("SUCCESS_AFTER");
		const failed = revision("write", state, theme, {
			args, result: textResult("REAL_FAILURE"), context: context({ state, isError: true }),
		});
		expect(primaryCallSection(failed)?.component).toBe(primaryCallSection(first)?.component);
		expect(renderSection(sectionWithLabel(failed, "Error"))).toBe("REAL_FAILURE");
		expect(sectionWithLabel(failed, "Output")).toBeUndefined();
	});

	it("retains the streamed edit preview and rebuilds it when the arguments change in place", () => {
		const state = {};
		const edits = [{ oldText: "old", newText: "fresh" }];
		const args = { path: "/tmp/module.py", edits };
		const first = primaryCallSection(revision("edit", state, theme, { args }));
		const second = primaryCallSection(revision("edit", state, theme, { args }));
		expect(second?.component).toBe(first?.component);
		expect(renderSection(second)).toBe("-old\n+fresh");

		edits[0] = { oldText: "old", newText: "changed" };
		const third = primaryCallSection(revision("edit", state, theme, { args }));
		expect(third?.component).not.toBe(first?.component);
		expect(renderSection(third)).toBe("-old\n+changed");
	});

	it("refreshes active Edit when a nested wrong-type value changes from null to NaN", () => {
		const state = {};
		const edits: Array<{ oldText: unknown; newText: string }> = [{ oldText: null, newText: "DELIVERED_NEW" }];
		const args = { path: "/offline/INVALID_CACHE_EDIT", edits };
		const first = primaryCallSection(revision("edit", state, theme, { args }));
		expect(renderSection(first)).toContain("oldText: [invalid arg] (null)");
		edits[0]!.oldText = Number.NaN;
		const second = primaryCallSection(revision("edit", state, theme, { args }));
		expect(renderSection(second)).toContain("oldText: [invalid arg] (NaN)");
		expect(renderSection(second)).not.toContain("(null)");
		expect(second?.component).not.toBe(first?.component);
	});

	it("refreshes active Edit when absent edits becomes an own undefined edits property", () => {
		const state = {};
		const args: Record<string, unknown> = { path: "/offline/PRESENCE_CACHE_EDIT" };
		const first = primaryCallSection(revision("edit", state, theme, { args }));
		expect(renderSection(first)).toContain("oldText: …");
		args.edits = undefined;
		const second = primaryCallSection(revision("edit", state, theme, { args }));
		expect(renderSection(second)).toBe("edits: …");
		expect(second?.component).not.toBe(first?.component);
	});

	it.each(["single", "multi", "mixed"])("refreshes active Edit when boxed string becomes valid string in %s request", (shape) => {
		const state = {};
		const pair: Record<string, unknown> = { oldText: Object("OLD"), newText: shape === "mixed" ? null : "NEW" };
		const args = shape === "single" ? { path: "/offline/BOXED_EDIT", ...pair } : { path: "/offline/BOXED_EDIT", edits: [pair] };
		const first = primaryCallSection(revision("edit", state, theme, { args }));
		expect(renderSection(first)).toContain('oldText: [invalid arg] ("OLD")');
		if (shape === "single") {
			(args as Record<string, unknown>).oldText = "OLD";
		} else {
			pair.oldText = "OLD";
		}
		const second = primaryCallSection(revision("edit", state, theme, { args }));
		expect(renderSection(second)).toContain(shape === "mixed" ? "oldText: OLD" : "-OLD\n+NEW");
		expect(renderSection(second)).not.toContain('oldText: [invalid arg] ("OLD")');
		expect(second?.component).not.toBe(first?.component);
	});

	it.each(["read", "find", "grep", "ls", "mcp__docs__lookup", "read_mcp_resource"])(
		"keeps the %s output primary while ordinary supplied inputs change",
		(name) => {
			const state = {};
			const args = { path: "/offline/BEFORE.unknownext", pattern: "PATTERN_BEFORE", server: "SERVER_BEFORE", uri: "res://BEFORE", extra: false };
			const overrides = { args, result: textResult("OUTPUT_PRIMARY\nSECOND_ROW"), presentation: name.startsWith("mcp__") ? "mcp" as const : "builtin" as const };
			const first = revision(name, state, theme, overrides);
			args.path = "/offline/AFTER.unknownext";
			args.pattern = "PATTERN_AFTER";
			args.server = "SERVER_AFTER";
			args.uri = "res://AFTER";
			args.extra = true;
			const second = revision(name, state, theme, overrides);
			expect(firstResultSection(second)?.component).toBe(firstResultSection(first)?.component);
			expect(renderInput(second)).toContain("AFTER");
			expect(renderInput(second)).toContain("true");
			expect(renderInput(second)).not.toContain("BEFORE");
		},
	);

	it("retains the MCP output component and rebuilds it when the text changes in place", () => {
		const state = {};
		const toolInfo = mcpInfo({ name: "mcp__docs__read", namespace: { name: "mcp__docs" } });
		const args = { query: "needle" };
		const toolResult: ToolResult = textResult("MCP_FIRST");
		const overrides = { args, toolInfo, presentation: "mcp" as const };
		const first = sectionWithLabel(
			revision("mcp__docs__read", state, theme, { ...overrides, result: toolResult }),
			"Output",
		);
		const second = sectionWithLabel(
			revision("mcp__docs__read", state, theme, { ...overrides, result: toolResult }),
			"Output",
		);
		expect(second?.component).toBe(first?.component);
		expect(renderSection(second)).toContain("MCP_FIRST");

		toolResult.content = [{ type: "text", text: "MCP_SECOND" }];
		const third = sectionWithLabel(
			revision("mcp__docs__read", state, theme, { ...overrides, result: toolResult }),
			"Output",
		);
		expect(third?.component).not.toBe(first?.component);
		expect(renderSection(third)).toContain("MCP_SECOND");
	});

	it("keeps each render state's retained preparation independent", () => {
		const firstState = {};
		const secondState = {};
		const args = { command: "ls" };
		const toolResult = textResult("same");
		const firstBefore = sectionWithLabel(revision("bash", firstState, theme, { args, result: toolResult }), "Output");
		const secondBefore = sectionWithLabel(revision("bash", secondState, theme, { args, result: toolResult }), "Output");
		expect(secondBefore?.component).not.toBe(firstBefore?.component);

		invalidateToolViewCache(firstState);

		const firstAfter = sectionWithLabel(revision("bash", firstState, theme, { args, result: toolResult }), "Output");
		const secondAfter = sectionWithLabel(revision("bash", secondState, theme, { args, result: toolResult }), "Output");
		expect(firstAfter?.component).not.toBe(firstBefore?.component);
		expect(secondAfter?.component).toBe(secondBefore?.component);
	});

	it("retains a component whose rows are already padded for the layout width", () => {
		const output = sectionWithLabel(
			view("bash", { args: { command: "ls" }, result: textResult("x".repeat(120)) }),
			"Output",
		);
		expect(output?.renderedWidth).toBe("padded");

		const rows = output?.component.render(40) ?? [];
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.every((row) => visibleWidth(row) === 40)).toBe(true);
	});

	it("marks owned SDK text and Markdown sections and leaves the entry preview unmarked", () => {
		const markdown = view("read", { args: { path: "/tmp/notes.md" }, result: textResult("# Title") });
		expect(firstResultSection(markdown)?.renderedWidth).toBe("padded");

		const highlighted = view("read", { args: { path: "/tmp/module.py" }, result: textResult("def run(): pass") });
		expect(firstResultSection(highlighted)?.renderedWidth).toBe("padded");

		const entries = Array.from({ length: 7 }, (_, index) => `file-${index + 1}.ts`).join("\n");
		const find = view("find", { args: { pattern: "file" }, result: textResult(entries) });
		// The layout selects whole logical entries through this exported shape.
		expect(firstResultSection(find)?.renderedWidth).toBeUndefined();
		expect(firstResultSection(find)?.component).toMatchObject({
			entryLines: Array.from({ length: 7 }, (_, index) => `file-${index + 1}.ts`),
		});

		const rows = layoutRows("find", { args: { pattern: "file" }, result: textResult(entries) }).join("\n");
		expect(rows).toContain("file-5.ts");
		expect(rows).not.toContain("file-6.ts");
		expect(rows).toContain("2 more entries");
	});
});

const executionPresentation: ToolSnapshot["presentation"] = "execution";

function executionRows(name: string, args: unknown, live?: ToolResult, expanded = false, partial = false, width = 120): string[] {
	return layoutRows(name, {
		presentation: executionPresentation,
		args,
		...(live === undefined ? {} : { result: live }),
		context: context({ expanded, isPartial: partial, executionStarted: true }),
	}, width);
}

function executionOutput(name: string, args: unknown, live: ToolResult): string {
	const rendered = view(name, { presentation: executionPresentation, args, result: live });
	return stripTerminalSequences(renderSection(sectionWithLabel(rendered, "Output"), 10000));
}

function contextEcho(args: { language: string; code: string; path?: string }, file = false): string {
	const shown = args.code.length <= 2000 ? args.code : `${args.code.slice(0, 2000)}\n… (truncated)`;
	return `${file && args.path ? `path=${args.path}\n` : ""}\`\`\`${args.language}\n${shown}\n\`\`\`\n\n`;
}

describe("owned context execution inputs", () => {
	it("renders language, code and every supplied option inside Input before Output, without repeating code", () => {
		const args = JSON.parse('{"language":"javascript","code":"console.log(CTX_INPUT)","timeout":0,"background":false,"cwd":"/offline/cwd","intent":"CTX_INTENT","unknown":0,"__proto__":{"marker":"OWN_PROPERTY"}}') as unknown;
		const rows = executionRows("ctx_execute", args, textResult("CTX_OUTPUT"));
		const text = rows.join("\n");
		expect(rows[0]).toContain("ctx_execute");
		expect(rows[0]).not.toContain("CTX_INPUT");
		expect(text.match(/ctx_execute/gu)).toHaveLength(1);
		for (const value of ["javascript", "console.log(CTX_INPUT)", "timeout", "background", "false", "/offline/cwd", "CTX_INTENT", "unknown", "__proto__", "OWN_PROPERTY", "Output", "CTX_OUTPUT"]) {
			expect(text).toContain(value);
		}
		expect(text).not.toMatch(/├─+ Input ─/u);
		expect(text).toMatch(/0\s*ms/u);
		expect(text.match(/console\.log\(CTX_INPUT\)/gu)).toHaveLength(1);
		expect(text.indexOf("javascript")).toBeLessThan(text.indexOf("console.log"));
		expect(text.indexOf("console.log")).toBeLessThan(text.indexOf("background"));
		expect(text.indexOf("background")).toBeLessThan(text.indexOf("Output"));
	});

	it("renders file path and supplied code without opening the referenced file or inventing server defaults", () => {
		const args = { path: "/offline/does-not-exist.json", language: "python", code: "print(FILE_CONTENT)" };
		const text = executionRows("ctx_execute_file", args, textResult(contextEcho(args, true) + "FILE_OUTPUT")).join("\n");
		expect(text).not.toMatch(/├─+ Input ─/u);
		for (const value of [args.path, "python", args.code, "Output", "FILE_OUTPUT"]) expect(text).toContain(value);
		expect(text).not.toContain("path=");
		expect(text).not.toContain("timeout");
		expect(text).not.toContain("background");
		expect(text.indexOf(args.path)).toBeLessThan(text.indexOf(args.code));
	});

	it.each([
		["ctx_execute", {}, ["language: …", "…"]],
		["ctx_execute", { language: false, code: 0 }, ["language: [invalid arg]", "[invalid arg]"]],
		["ctx_execute_file", { path: false, language: 0, code: null }, ["path: [invalid arg]", "language: [invalid arg]", "[invalid arg]"]],
		["ctx_execute_file", {}, ["path: …", "language: …", "…"]],
	] as const)("keeps Input visible for incomplete or invalid %s args %j", (name, args, markers) => {
		const text = executionRows(name, args).join("\n");
		expect(text).not.toMatch(/├─+ Input ─/u);
		for (const marker of markers) expect(text).toContain(marker);
		expect(text).not.toContain("Output");
	});

	it.each(["", " ", "\t\n  "])("shows empty/whitespace code %j as escaped literal input", (code) => {
		const text = executionRows("ctx_execute", { language: "javascript", code }).join("\n");
		expect(text).toContain(`code: ${JSON.stringify(code)}`);
		expect(text).not.toMatch(/├─+ Input ─/u);
	});

	it.each([
		{ name: "ctx_execute", code: "\u001b[31m\u001b[0m" },
		{ name: "ctx_execute_file", code: "\u001b[31m\u001b[0m" },
		{ name: "codemode", code: "\u001b[31m\u001b[0m" },
		{ name: "ctx_execute", code: "\ufdd0" },
		{ name: "ctx_execute_file", code: "\ufdd0" },
		{ name: "codemode", code: "\ufdd0" },
	])("keeps normalized-empty $name code $code visible as a safe compact literal", ({ name, code }) => {
		const args = { code, language: "javascript", path: "/offline/unread" };
		const text = executionRows(name, args).join("\n");
		expect(text).not.toMatch(/├─+ Input ─/u);
		expect(text).toContain(`code: ${normalizeDisplayText(JSON.stringify(code))}`);
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("\ufdd0");
		expect(args.code).toBe(code);
	});

	it.each(["javascript", "typescript", "python", "shell", "ruby", "go", "rust", "php", "perl", "r", "elixir", "csharp", "unknown-language"])("preserves supplied %s code as rendered input", (language) => {
		const code = "LANGUAGE_MARKER\n  KEEP_INDENT";
		const text = executionRows("ctx_execute", { language, code }, undefined, true).join("\n");
		expect(text).toContain(language);
		expect(text).toContain("LANGUAGE_MARKER");
		expect(text).toContain("  KEEP_INDENT");
	});

	it("uses the real Bash highlighter for shell and plain normalized text for unknown language", () => {
		const code = 'if true; then\n\tprintf "$HOME"\nfi';
		const shell = view("ctx_execute", { presentation: executionPresentation, args: { language: "shell", code } });
		const primary = shell.sections.find((entry) => entry.slot === "call" && stripTerminalSequences(renderSection(entry)).includes("printf"));
		expect(primary).toBeDefined();
		const expected = new Text(highlightCode(normalizeDisplayText(code), "bash").join("\n"), 0, 0)
			.render(200).map((line) => line.trimEnd()).join("\n");
		expect(renderSection(primary)).toBe(expected);
		const unknown = view("ctx_execute", { presentation: executionPresentation, args: { language: "no-grammar", code } });
		const raw = unknown.sections.find((entry) => entry.slot === "call" && stripTerminalSequences(renderSection(entry)).includes("printf"));
		expect(renderSection(raw)).toBe(normalizeDisplayText(code));
	});

	it("independently previews ten first code rows and five first output rows, leaving options unclamped", () => {
		const args = { language: "javascript", code: numberedLines("INPUT_", 12), intent: "ALWAYS_VISIBLE" };
		const live = textResult(numberedLines("OUTPUT_", 7));
		const collapsed = executionRows("ctx_execute", args, live).join("\n");
		expect(collapsed).toContain("INPUT_10");
		expect(collapsed).not.toContain("INPUT_11");
		expect(collapsed).toContain("OUTPUT_05");
		expect(collapsed).not.toContain("OUTPUT_06");
		expect(collapsed.match(/2 more lines/gu)).toHaveLength(2);
		expect(collapsed).toContain("ALWAYS_VISIBLE");
		const expanded = executionRows("ctx_execute", args, live, true).join("\n");
		expect(expanded).toContain("INPUT_12");
		expect(expanded).toContain("OUTPUT_07");
		expect(expanded).not.toContain("more lines");
	});

	it.each([{ args: undefined }, { args: {} }, { args: [] }, { args: null }])("keeps future suffix Input for $args without assuming the current schema", ({ args }) => {
		const text = executionRows("ctx_execute_future", args, textResult("FUTURE_OUTPUT")).join("\n");
		expect(text).not.toMatch(/├─+ Input ─/u);
		expect(text).toContain(args === undefined ? "…" : JSON.stringify(args));
		expect(text).toContain("Output");
		expect(text).toContain("FUTURE_OUTPUT");
	});

	it("serializes all future suffix arguments and never removes a fence as an assumed input echo", () => {
		const args = { language: "javascript", code: "FUTURE_CODE", extra: false };
		const text = executionRows("ctx_execute_future", args, textResult(contextEcho(args) + "FUTURE_OUTPUT"), true).join("\n");
		expect(text).toContain("extra");
		expect(text).toContain("false");
		expect(text.match(/FUTURE_CODE/gu)).toHaveLength(2);
		expect(text).toContain("```javascript");
	});
});

describe("exact raw execution output separation", () => {
	it.each(["ctx_execute", "ctx_execute_file"])("removes only the exact first raw echo for %s without mutating input or blocks", (name) => {
		const args = Object.freeze({ path: "/offline/a\tb\u0007.json", language: "python", code: "\tprint('RAW')\r\n\u0001" });
		const first = Object.freeze({ type: "text" as const, text: contextEcho(args, name === "ctx_execute_file") + "  REAL\tOUTPUT\u0007" });
		const second = Object.freeze({ type: "text" as const, text: "==> text 2/2 <==\n<console_output>\nSECOND\n</console_output>" });
		const live = result([first, second]);
		const original = JSON.stringify({ args, live });
		const output = executionOutput(name, args, live);
		expect(output).toBe("  REAL   OUTPUT␇\n==> text 2/2 <==\n<console_output>\nSECOND\n</console_output>");
		expect(output).not.toContain("RAW");
		expect(JSON.stringify({ args, live })).toBe(original);
	});

	it.each([2000, 2001])("uses server UTF-16 truncation at %i code units, not scalar counts", (length) => {
		const code = "x".repeat(1999) + (length === 2000 ? "x" : "😀");
		expect(code.length).toBe(length);
		const args = { language: "javascript", code };
		const output = executionOutput("ctx_execute", args, textResult(contextEcho(args) + "THRESHOLD_OUTPUT"));
		expect(output).toBe("THRESHOLD_OUTPUT");
	});

	it.each([
		"```javascript\nGENUINE_OUTPUT\n```",
		"```javascript\nINPUT\n```\nOUTPUT_WITHOUT_REQUIRED_BLANK_LINE",
		"```python\nINPUT\n```\n\nLANGUAGE_MISMATCH",
		"before\n```javascript\nINPUT\n```\n\nINTERNAL_ECHO",
		"```javascript\r\nINPUT\r\n```\r\n\r\nVERSION_MISMATCH",
	])("preserves genuine Markdown and mismatched raw echo %j", (output) => {
		expect(executionOutput("ctx_execute", { language: "javascript", code: "INPUT" }, textResult(output))).toBe(normalizeDisplayText(output));
	});

	it("does not match normalized-but-different controls or a different file path", () => {
		const args = { language: "python", code: "\tINPUT", path: "/offline/original" };
		const normalizedEcho = contextEcho({ ...args, code: "   INPUT" });
		expect(executionOutput("ctx_execute", args, textResult(normalizedEcho + "OUTPUT"))).toContain("```python");
		const wrongPath = contextEcho({ ...args, path: "/offline/other" }, true);
		expect(executionOutput("ctx_execute_file", args, textResult(wrongPath + "OUTPUT"))).toContain("path=/offline/other");
	});

	it("drops an emptied echo block without a phantom joining line and preserves later echoes", () => {
		const args = { language: "shell", code: "echo INPUT" };
		const echo = contextEcho(args);
		expect(executionOutput("ctx_execute", args, result([
			{ type: "text", text: echo }, { type: "text", text: "REAL_OUTPUT" },
		]))).toBe("REAL_OUTPUT");
		expect(executionOutput("ctx_execute", args, result([
			{ type: "text", text: "REAL_OUTPUT" }, { type: "text", text: echo + "LATER" },
		]))).toContain(echo + "LATER");
	});

	it.each([
		["ctx_execute", { language: 0, code: "INPUT" }],
		["ctx_execute", { language: "javascript", code: false }],
		["ctx_execute_file", { language: "javascript", code: "INPUT" }],
		["ctx_execute_file", { language: "javascript", code: "INPUT", path: null }],
	] as const)("keeps the server-looking output when %s cannot prove the echo arguments", (name, args) => {
		const text = "```javascript\nINPUT\n```\n\nUNPROVEN_OUTPUT";
		expect(executionOutput(name, args, textResult(text))).toBe(text);
	});

	it("does not strip a later text echo when the first block is an image, and keeps hidden-image fallback", () => {
		const args = { language: "javascript", code: "INPUT" };
		const live = result([{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: contextEcho(args) + "OUTPUT" }]);
		const text = executionRows("ctx_execute", args, live, true).join("\n");
		expect(text).toContain("image/png");
		expect(text).toContain("```javascript");
	});

	it.each(["(no output)", "Timeout after 2500 ms", "Background task started", "Indexed summary\n… (truncated)\nFull output: /offline/result.txt"])("preserves supplied server notices %j", (text) => {
		const args = { language: "javascript", code: "INPUT" };
		expect(executionOutput("ctx_execute", args, textResult(contextEcho(args) + text))).toBe(text);
	});

	it.each(["", "```javascript\nINPUT\n```\n\n"])("omits Output for actually empty output %j", (text) => {
		const rendered = executionRows("ctx_execute", { language: "javascript", code: "INPUT" }, textResult(text)).join("\n");
		expect(rendered).not.toMatch(/├─+ Input ─/u);
		expect(rendered).not.toContain("Output");
		expect(rendered).not.toContain("(no output)");
	});
});

describe("owned codemode rendering", () => {
	const wrapper = "Script completed\nWall time 0.125 seconds\nOutput:\n";

	it("keeps script options verbatim in Input and unexpected args visible without duplicating code", () => {
		const code = '// @options: {"timeout_ms":2500}\nconsole.log(CODE_INPUT)';
		const text = executionRows("codemode", { code, unexpected: false, zero: 0 }, textResult("CODE_OUTPUT")).join("\n");
		expect(text).toContain(code.split("\n")[0]);
		expect(text).toContain("console.log(CODE_INPUT)");
		expect(text.match(/CODE_INPUT/gu)).toHaveLength(1);
		expect(text).toContain("unexpected");
		expect(text).toContain("false");
		expect(text).toContain("zero");
		expect(text).not.toMatch(/├─+ Input ─/u);
		expect(text.indexOf("CODE_INPUT")).toBeLessThan(text.indexOf("Output"));
	});

	it.each(["completed", "failed"])("removes only the complete structural %s wrapper block and preserves delivered segments", (status) => {
		const segments = "==> text 1/2 <==\n  RESULT\n==> text 2/2 <==\n<console_output>\nCONSOLE\n</console_output>\n… (truncated)";
		const live = result([
			{ type: "text", text: wrapper.replace("completed", status) },
			{ type: "text", text: segments },
		]);
		const before = JSON.stringify(live);
		expect(executionOutput("codemode", { code: "INPUT" }, live)).toBe(segments);
		expect(JSON.stringify(live)).toBe(before);
	});

	it.each(["Script error: BOOM", wrapper + "MERGED_OUTPUT", "before\n" + wrapper, wrapper.replace("0.125", "unknown")])("keeps non-structural or merged wrapper/error %j", (text) => {
		expect(executionOutput("codemode", { code: "INPUT" }, textResult(text))).toBe(text);
	});

	it("keeps a structural-looking wrapper in a later block", () => {
		expect(executionOutput("codemode", { code: "INPUT" }, result([
			{ type: "text", text: "BEFORE" }, { type: "text", text: wrapper },
		]))).toContain("BEFORE\nScript completed");
	});

	it("previews eight complete last calls, sums hidden costs, and expands delivered args and multiline errors", () => {
		const calls = Array.from({ length: 9 }, (_, index) => ({
			id: `call-${index}`, name: `NESTED_${index + 1}`,
			args: index === 3 ? "a".repeat(90) + "ARGS_TAIL" : `{"marker":"CALL_${index + 1}"}`,
			status: index === 3 ? "error" : index === 4 ? "cancelled" : index === 5 ? "running" : "ok",
			durationMs: index === 8 ? 1250 : 12,
			...(index === 3 ? { error: "NESTED_ERROR\nERROR_DETAIL" } : {}),
			...(index === 0 ? { cost: 0.10 } : index === 8 ? { cost: 0.20 } : {}),
		}));
		const args = { code: numberedLines("CODE_", 12) };
		const live = result([{ type: "text", text: wrapper }, { type: "text", text: numberedLines("RESULT_", 7) }], { calls, fullOutputPath: "/offline/codemode-full.txt" });
		const before = JSON.stringify({ args, live });
		setIconMode("ascii");
		try {
			const collapsed = executionRows("codemode", args, live).join("\n");
			expect(collapsed).toContain("Calls");
			expect(collapsed).not.toContain("NESTED_1");
			expect(collapsed).toContain("NESTED_2");
			expect(collapsed).toContain("NESTED_9");
			expect(collapsed).toContain("1 more entries");
			expect(collapsed).toContain("Model calls: $0.30");
			expect(collapsed).toMatch(/1\.3\s*s/u);
			expect(collapsed).toMatch(/12\s*ms/u);
			expect(collapsed).not.toContain("ARGS_TAIL");
			expect(collapsed).toContain("RESULT_05");
			expect(collapsed).not.toContain("RESULT_06");
			expect(collapsed).not.toContain("CODE_11");
			expect(collapsed).toContain("Full output: /offline/codemode-full.txt");
			expect(collapsed).not.toMatch(/├─+ Input ─/u);
			expect(collapsed.indexOf("CODE_01")).toBeLessThan(collapsed.indexOf("Calls"));
			expect(collapsed.indexOf("Calls")).toBeLessThan(collapsed.indexOf("Output"));
			expect(collapsed.indexOf("Output")).toBeLessThan(collapsed.indexOf("Full output"));
			const expanded = executionRows("codemode", args, live, true).join("\n");
			for (const value of ["NESTED_1", "ARGS_TAIL", "NESTED_ERROR", "ERROR_DETAIL", "CODE_12", "RESULT_07"]) expect(expanded).toContain(value);
			expect(JSON.stringify({ args, live })).toBe(before);
		} finally {
			setIconMode("ascii");
		}
	});

	it.each([
		["ascii", ["...", "ok", "!", "-"]],
		["nerd-font", ["…", "✓", "✗", "⊘"]],
		["off", ["running", "ok", "error", "cancelled"]],
	] as const)("renders static nested call states in %s mode", (mode, markers) => {
		setIconMode(mode);
		try {
			const calls = ["running", "ok", "error", "cancelled"].map((status, i) => ({ id: `${i}`, name: `STATE_${i}`, args: "{}", status }));
			const rows = executionRows("codemode", { code: "INPUT" }, textResult("", { calls }));
			markers.forEach((marker, i) => expect(rows.find((row) => row.includes(`STATE_${i}`))).toContain(marker));
		} finally {
			setIconMode("ascii");
		}
	});

	it("keeps partial calls visible but withholds Output until completion", () => {
		const args = { code: "INPUT" };
		const calls = [{ id: "1", name: "LIVE_CALL", args: "{}", status: "running" }];
		const partial = executionRows("codemode", args, textResult("NOT_PARTIAL_OUTPUT", { calls }), false, true).join("\n");
		expect(partial).toContain("LIVE_CALL");
		expect(partial).not.toContain("Output");
		expect(partial).not.toContain("NOT_PARTIAL_OUTPUT");
		expect(partial).not.toContain("indexing");
		const complete = executionRows("codemode", args, textResult("FINAL_OUTPUT", { calls: [{ ...calls[0], status: "ok" }] })).join("\n");
		expect(complete).toContain("LIVE_CALL");
		expect(complete).toContain("FINAL_OUTPUT");
	});

	it("safely displays malformed calls without inventing states or numeric metadata", () => {
		const calls = [null, { malformed: "BAD_CALL" }, { id: "1", name: "VALID_CALL", args: "{}", status: "ok", durationMs: -1, cost: Infinity }];
		const text = executionRows("codemode", { code: "INPUT" }, textResult("OUTPUT", { calls }), true).join("\n");
		expect(text).toContain("null");
		expect(text).toContain("BAD_CALL");
		expect(text).toContain("VALID_CALL");
		expect(text).not.toContain("-1ms");
		expect(text).not.toContain("$Infinity");
		expect(text).not.toContain("Model calls:");
	});

	it.each([
		[0, 0, "0", "$0.0"],
		[12.6, 0.001234, "13", "$0.0012"],
		[1000, 0.01, "1.0", "$0.01"],
	] as const)("formats finite call duration %s and cost %s without a spurious total", (durationMs, cost, duration, formattedCost) => {
		const live = textResult("", { calls: [{ id: "1", name: "NUMERIC_CALL", args: "{}", status: "ok", durationMs, cost }] });
		const text = executionRows("codemode", { code: "INPUT" }, live).join("\n");
		expect(text).toContain(formattedCost);
		expect(text).toMatch(new RegExp(`${duration.replace(".", "\\.")}\\s*${durationMs < 1000 ? "ms" : "s"}`, "u"));
		expect(text).not.toContain("Model calls:");
	});

	it.each([NaN, Infinity, -1])("omits non-finite or negative numeric call metadata %s", (value) => {
		const live = textResult("", { calls: [{ id: "1", name: "INVALID_NUMERIC", args: "{}", status: "ok", durationMs: value, cost: value }] });
		const text = executionRows("codemode", { code: "INPUT" }, live).join("\n");
		expect(text).toContain("INVALID_NUMERIC");
		expect(text).not.toMatch(/\$(?:NaN|Infinity|-1)|(?:NaN|Infinity|-1)\s*(?:ms|s)\b/u);
		expect(text).not.toContain("Model calls:");
	});

	it.each([undefined, null, {}, "not-array"])("omits Calls for non-array details %j", (calls) => {
		const text = executionRows("codemode", { code: "INPUT" }, textResult("OUTPUT", { calls })).join("\n");
		expect(text).not.toContain("Calls");
		expect(text).toContain("OUTPUT");
	});
});

describe("execution primary reuse", () => {
	it.each(["ctx_execute", "ctx_execute_file", "codemode", "ctx_execute_future"])("retains %s input while results change and re-reads mutable args", (name) => {
		const state = {};
		const args = { code: "CACHE_BEFORE", language: "javascript", path: "/offline/unread", extra: false };
		const render = (output: string) => revision(name, state, plainTheme, { presentation: executionPresentation, args, result: textResult(output) });
		const first = render("OUTPUT_BEFORE");
		const primary = first.sections.find((entry) => entry.slot === "call" && renderSection(entry).includes("CACHE_BEFORE"));
		expect(primary).toBeDefined();
		const second = render("OUTPUT_AFTER");
		const retained = second.sections.find((entry) => entry.slot === "call" && renderSection(entry).includes("CACHE_BEFORE"));
		expect(retained?.component).toBe(primary?.component);
		expect(renderSection(sectionWithLabel(second, "Output"))).toContain("OUTPUT_AFTER");
		args.code = "CACHE_AFTER";
		const third = render("OUTPUT_AFTER");
		const refreshed = third.sections.find((entry) => entry.slot === "call" && renderSection(entry).includes("CACHE_AFTER"));
		expect(refreshed).toBeDefined();
		expect(refreshed?.component).not.toBe(primary?.component);
		invalidateToolViewCache(state);
		const rebuilt = render("OUTPUT_AFTER").sections.find((entry) => entry.slot === "call" && renderSection(entry).includes("CACHE_AFTER"));
		expect(rebuilt?.component).not.toBe(refreshed?.component);
		expect(renderSection(rebuilt)).toContain("CACHE_AFTER");
	});
});
