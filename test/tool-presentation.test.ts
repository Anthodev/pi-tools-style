import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { initTheme, ToolExecutionComponent, type Theme, type ToolInfo, type ToolRenderers } from "@earendil-works/pi-coding-agent";
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

	it("normalizes control characters in head fields but keeps target newlines", () => {
		const live = view("bash", { args: { command: "echo\t\u0007\u001b[31mhi\u001b[0m" } });
		expect(live.head.target).toBe("$ echo   \u2407hi");
		expect(view("bash", { args: { command: "a\nb" } }).head.target).toBe("$ a\nb");
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
		expect(view("bash").head.target).toBe("…");
		expect(view("find").head.target).toBe("…");
		expect(view("read").head.target).toBe("…");
	});

	it("marks a present-but-wrong-type argument without throwing", () => {
		expect(view("bash", { args: { command: 42 } }).head.target).toBe("[invalid arg]");
		expect(view("find", { args: { pattern: { nested: true } } }).head.target).toBe("[invalid arg]");
		expect(view("bash", { args: { command: null } }).head.target).toBe("[invalid arg]");
		expect(view("read", { args: { path: null } }).head.target).toBe("[invalid arg]");
		expect(view("bash", { args: { command: undefined } }).head.target).toBe("…");
	});

	it("links a real '[invalid arg]' filename instead of reading it as the wrong-type marker", () => {
		capabilities.hyperlinks = true;
		const literal = view("read", { args: { path: "[invalid arg]" } }).head.target;
		expect(literal).toContain("\u001b]8;;");
		expect(stripTerminalSequences(literal)).toBe("[invalid arg]");

		expect(view("read", { args: { path: null } }).head.target).toBe("[invalid arg]");
	});

	it("ignores unsupported argument aliases and keeps the pending ellipsis", () => {
		for (const toolName of ["read", "write", "edit"]) {
			expect(view(toolName, { args: { ["file_path"]: "/tmp/a.txt" } }).head.target).toBe("…");
		}
		// ls documents a default target instead of pending.
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
		expect(live.head.target).toBe("$ ls -la");
		expect(live.head.meta).toEqual(["5s"]);
		expect(live.layout).toBe("framed");
		expect(live.preview).toEqual({ edge: "tail", count: 10, unit: "visual-lines" });
		expect(renderSection(sectionWithLabel(live, "Output"))).toContain("line2");
	});

	it("uses the PowerShell prompt for powershell", () => {
		expect(view("powershell", { args: { command: "Get-Date" } }).head.target).toBe("PS> Get-Date");
	});

	it("shows truncation and the full output path outside the clamp", () => {
		const live = view("bash", {
			args: { command: "cat big" },
			result: textResult("partial", {
				truncation: { truncated: true, maxBytes: 2048, truncatedBy: "bytes" },
				fullOutputPath: "/tmp/full.log",
			}),
		});
		const details = live.sections.find((section) => section.preview === false);
		expect(details).toBeDefined();
		const rendered = renderSection(details);
		expect(rendered).toContain("[Truncated");
		expect(rendered).toContain("2.0KB");
		expect(rendered).toContain("Full output: /tmp/full.log");
	});

	it("adds no section for an empty result", () => {
		expect(view("bash", { args: { command: "true" }, result: textResult("") }).sections).toEqual([]);
	});
});

describe("read", () => {
	it("renders an inline path target with an offset range", () => {
		const live = view("read", { args: { path: "/tmp/a.txt", offset: 5, limit: 10 } });
		expect(live.layout).toBe("inline");
		expect(live.head.target).toBe("/tmp/a.txt:5-14");
		expect(view("read", { args: { path: "/tmp/a.txt", offset: 5 } }).head.target).toBe("/tmp/a.txt:5");
		expect(view("read", { args: { path: "/tmp/a.txt", limit: 10 } }).head.target).toBe("/tmp/a.txt:1-10");
	});

	it("defaults the target offset to 1 and previews the first ten visual lines", () => {
		const live = view("read", { args: { path: "/tmp/a.txt" } });
		expect(live.preview).toEqual({ edge: "head", count: 10, unit: "visual-lines" });
		expect(live.head.target).toBe("/tmp/a.txt");
	});

	it("shows the real result text and an error tone on failure", () => {
		const live = view("read", {
			args: { path: "/tmp/a.txt" },
			result: textResult("ENOENT: no such file"),
			context: context({ isError: true }),
		});
		expect(live.tone).toBe("error");
		expect(live.sections[0]?.component.render(200).join("\n")).toContain("ENOENT");
	});

	it("keeps truncation warnings outside the clamp", () => {
		const live = view("read", {
			args: { path: "/tmp/a.txt" },
			result: textResult("content", {
				truncation: { truncated: true, truncatedBy: "lines", outputLines: 2000, totalLines: 5000, maxLines: 2000 },
			}),
		});
		const warning = live.sections.find((section) => section.preview === false);
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
		expect(renderSection(indented.sections[0])).toBe("def f():\n    return 1");

		const leadingBlank = view("read", {
			args: { path: "/tmp/notes.unknownext" },
			result: textResult("\n    indented\n"),
		});
		expect(renderSection(leadingBlank.sections[0])).toBe("\n    indented");

		const markdown = view("read", {
			args: { path: "/tmp/notes.md" },
			result: textResult("\n    code block\n"),
		});
		expect(renderSection(markdown.sections[0])).toContain("code block");
	});
});

describe("write", () => {
	it("keeps the requested content visible after success", () => {
		const live = view("write", {
			args: { path: "/tmp/a.txt", content: "one\ntwo" },
			result: textResult("Wrote 2 lines"),
		});
		const content = sectionWithLabel(live, "Content");
		expect(content?.slot).toBe("call");
		expect(renderSection(content)).toBe("one\ntwo");
		expect(live.head.meta).toEqual(["2 lines"]);
	});

	it("shows the real error without hiding the request", () => {
		const live = view("write", {
			args: { path: "/tmp/a.txt", content: "one" },
			result: textResult("EACCES: permission denied"),
			context: context({ isError: true }),
		});
		expect(live.tone).toBe("error");
		expect(renderSection(sectionWithLabel(live, "Content"))).toBe("one");
		const error = sectionWithLabel(live, "Error");
		expect(error?.preview).toBe(false);
		expect(renderSection(error)).toContain("EACCES");
	});

	it("reports a wrong-type content argument instead of inventing text", () => {
		expect(renderSection(sectionWithLabel(view("write", { args: { path: "/tmp/a.txt", content: 3 } }), "Content"))).toBe(
			"[invalid arg]",
		);
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
		const preview = sectionWithLabel(live, "Preview");
		expect(preview?.slot).toBe("call");
		expect(renderSection(preview)).toBe("-old\n+new");
	});

	it("replaces the preview with the real error on failure", () => {
		const live = view("edit", {
			args: { path: "/tmp/a.txt", oldText: "old", newText: "new" },
			result: textResult("String not found"),
			context: context({ isError: true }),
		});
		expect(live.tone).toBe("error");
		expect(sectionWithLabel(live, "Preview")).toBeUndefined();
		const error = sectionWithLabel(live, "Error");
		expect(error?.preview).toBe(false);
		expect(renderSection(error)).toContain("String not found");
	});

	it("ignores malformed edit pairs", () => {
		const live = view("edit", { args: { path: "/tmp/a.txt", edits: [{ oldText: 1, newText: "new" }] } });
		expect(live.sections).toEqual([]);
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
		expect(renderSection(sectionWithLabel(live, "Preview"))).toBe("-old\n+new");
	});

	it("shows no body for an empty final success instead of the request preview", () => {
		const live = view("edit", {
			args: { path: "/tmp/a.txt", edits: [{ oldText: "old", newText: "new" }] },
			result: textResult(""),
		});
		expect(live.sections).toEqual([]);
		expect(sectionWithLabel(live, "Preview")).toBeUndefined();
	});
});

describe("find, grep and ls", () => {
	it("previews five whole entries for find", () => {
		const live = view("find", {
			args: { pattern: "*.ts", path: "/tmp/project", limit: 50 },
			result: textResult("a.ts\nb.ts\nc.ts"),
		});
		expect(live.preview).toEqual({ edge: "head", count: 5, unit: "entries" });
		expect(live.head.target).toBe("*.ts");
		expect(live.head.meta).toEqual(["in /tmp/project", "limit 50"]);
		const entries = live.sections[0]?.component as { entryLines?: readonly string[] } | undefined;
		expect(entries?.entryLines).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("adds no entry section when find returns nothing", () => {
		const live = view("find", { args: { pattern: "*.ts" }, result: textResult("") });
		expect(live.sections).toEqual([]);
	});

	it("keeps find limit warnings outside the clamp", () => {
		const live = view("find", {
			args: { pattern: "*.ts" },
			result: textResult("a.ts", { resultLimitReached: 100 }),
		});
		const warning = live.sections.find((section) => section.preview === false);
		expect(warning?.preview).toBe(false);
		expect(renderSection(warning)).toContain("100 results limit");
	});

	it("surfaces grep metadata and warning flags", () => {
		const live = view("grep", {
			args: { pattern: "needle", path: "/tmp", glob: "*.ts", ignoreCase: true, literal: true, context: 3, limit: 20 },
			result: textResult("a.ts:1:needle", { matchLimitReached: 50, linesTruncated: true }),
		});
		expect(live.head.meta).toEqual(["in /tmp", "*.ts", "ignore-case", "literal", "context 3", "limit 20"]);
		expect(live.head.target).toBe("needle");
		expect(live.preview).toEqual({ edge: "head", count: 10, unit: "visual-lines" });
		const warning = live.sections.find((section) => section.preview === false);
		expect(warning?.preview).toBe(false);
		const rendered = renderSection(warning);
		expect(rendered).toContain("50 matches limit");
		expect(rendered).toContain("truncated");
	});

	it("defaults the ls target to the working directory", () => {
		const live = view("ls", { args: { limit: 10 }, result: textResult("a\nb") });
		expect(live.head.target).toBe(".");
		expect(live.head.meta).toEqual(["limit 10"]);
		expect(live.layout).toBe("inline");
	});
});

describe("provenance-aware dispatch", () => {
	it("returns a header-only view for the generic presentation", () => {
		const live = view("read", { presentation: "generic", args: { path: "/tmp/a.txt" } });
		expect(live.sections).toEqual([]);
		expect(live.preview).toBeUndefined();
		expect(live.head.title).toBe("read");
		expect(live.head.target).toBe("");
	});

	it("treats an unknown builtin as generic without inventing content", () => {
		const live = view("not_a_tool");
		expect(live.head.title).toBe("not_a_tool");
		expect(live.sections).toEqual([]);
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

	it("collapses arguments to 100 characters and pretty-prints when expanded", () => {
		const collapsed = view("mcp__docs__read", {
			presentation: "mcp",
			args: { query: "x".repeat(200) },
		});
		const args = sectionWithLabel(collapsed, "Arguments");
		expect(args?.slot).toBe("call");
		const visible = stripTerminalSequences(renderSection(args).split("\n")[0] ?? "");
		expect(visible.length).toBeGreaterThan(0);
		expect(visible.length).toBeLessThanOrEqual(100);

		const expanded = view("mcp__docs__read", {
			presentation: "mcp",
			args: { query: "abc", limit: 5 },
			context: context({ expanded: true }),
		});
		expect(renderSection(sectionWithLabel(expanded, "Arguments"))).toBe(
			'{\n  "query": "abc",\n  "limit": 5\n}',
		);
	});

	it("survives cyclic arguments without throwing", () => {
		const cyclic: Record<string, unknown> = { name: "loop" };
		cyclic.self = cyclic;
		const live = view("mcp__docs__read", { presentation: "mcp", args: cyclic });
		expect(renderSection(sectionWithLabel(live, "Arguments"))).toContain("loop");
	});

	it("adds no arguments section for a propertyless call", () => {
		expect(sectionWithLabel(view("mcp__docs__read", { presentation: "mcp", args: {} }), "Arguments")).toBeUndefined();
	});

	it("uses context.isError, not result.isError, and shows the full output path unread", () => {
		const live = view("mcp__docs__read", {
			presentation: "mcp",
			result: { ...textResult("boom", { server: "docs", tool: "read", fullOutputPath: "/nope/mcp.log" }), isError: true },
		});
		expect(live.tone).toBeUndefined();
		expect(live.head.status).toBe("done");
		const full = live.sections.find((section) => section.preview === false);
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
		expect(live.head.target).toBe("res://x");
		expect(live.head.meta).toEqual(["server: docs"]);
		expect(sectionWithLabel(live, "Arguments")).toBeUndefined();
	});

	it("keeps the cursor for resource listing and targets all servers by default", () => {
		const live = view("list_mcp_resources", {
			presentation: "mcp",
			args: { cursor: "next-page" },
		});
		expect(live.head.title).toBe("MCP Resources");
		expect(live.head.target).toBe("all servers");
		expect(renderSection(sectionWithLabel(live, "Arguments"))).toContain('cursor="next-page"');
	});

	it("targets the requested server for resource listing", () => {
		const live = view("list_mcp_resource_templates", { presentation: "mcp", args: { server: "docs" } });
		expect(live.head.title).toBe("MCP Resource Templates");
		expect(live.head.target).toBe("docs");
		expect(sectionWithLabel(live, "Arguments")).toBeUndefined();
	});

	it("keeps mcp-unresolved on the same frame", () => {
		const live = view("mcp__docs__read", { presentation: "mcp-unresolved", toolInfo: mcpInfo({ namespace: { name: "mcp__docs" } }) });
		expect(live.layout).toBe("framed");
		expect(live.head.title).toBe("MCP");
		expect(live.head.target).toBe("mcp__docs/read");
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
		expect(expanded).toContain("Command");
		expect(expanded).toContain("first");
		expect(expanded).toContain("second");
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
			const target = view("read", { args: { path: input } }).head.target;
			expect(target).toContain(`\u001b]8;;${pathToFileURL(resolved).href}\u001b\\`);
			// The visible text stays exactly what the caller passed; only the href is canonical.
			expect(stripTerminalSequences(target)).toBe(input);
		}
	});

	it("renders a wrong-type path as a marker instead of a fabricated link", () => {
		capabilities.hyperlinks = true;
		for (const toolName of ["read", "write", "edit", "ls"]) {
			const target = view(toolName, { args: { path: null } }).head.target;
			expect(target).toContain("[invalid arg]");
			expect(target).not.toContain("\u001b]8;;");
		}
	});

	it("leaves an unresolvable file URL unlinked", () => {
		capabilities.hyperlinks = true;
		const target = view("read", { args: { path: "file:///tmp/a%ZZ.txt" } }).head.target;
		expect(target).not.toContain("\u001b]8;;");
		expect(target).toBe("file:///tmp/a%ZZ.txt");
	});

	it.skipIf(process.platform === "win32")("leaves a non-local file URL unlinked", () => {
		capabilities.hyperlinks = true;
		const target = view("read", { args: { path: "file://example.com/tmp/a.txt" } }).head.target;
		expect(target).not.toContain("\u001b]8;;");
		expect(target).toBe("file://example.com/tmp/a.txt");
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

	it("renders a real grep row inline without a frame and keeps warnings outside the clamp", () => {
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
		expect(rows.some((row) => row.startsWith("╭"))).toBe(false);
		expect(rows.some((row) => row.startsWith("╰"))).toBe(false);
		const text = rows.join("\n");
		expect(text).toContain("Grep");
		expect(text).toContain("needle");
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
		expect(revision("bash", state, theme, { args, result: toolResult }).head.target).toBe("$ ls -la");
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

		expect(first.sections).toHaveLength(1);
		expect(second.sections).toHaveLength(2);
		expect(second.sections[0]?.component).toBe(first.sections[0]?.component);
		expect(renderSection(second.sections[1])).toContain("/tmp/full.log");
	});

	it("retains a highlighted Read body and rebuilds it after the explicit root invalidation", () => {
		const state = {};
		const args = { path: "/tmp/module.py" };
		const toolResult = textResult("def run():\n    return 1");
		const first = revision("read", state, theme, { args, result: toolResult });
		const second = revision("read", state, theme, { args, result: toolResult });
		expect(second.sections[0]?.component).toBe(first.sections[0]?.component);
		expect(renderSection(second.sections[0])).toContain("run");

		invalidateToolViewCache(state);

		const third = revision("read", state, theme, { args, result: toolResult });
		expect(third.sections[0]?.component).not.toBe(first.sections[0]?.component);
		expect(renderSection(third.sections[0])).toContain("run");
	});

	it("retains a Read Markdown body and rebuilds it when the file text changes", () => {
		const state = {};
		const args = { path: "/tmp/notes.md" };
		const toolResult: ToolResult = textResult("# Title\n\nbody");
		const first = revision("read", state, theme, { args, result: toolResult });
		const second = revision("read", state, theme, { args, result: toolResult });
		expect(second.sections[0]?.component).toBe(first.sections[0]?.component);
		expect(renderSection(second.sections[0])).toContain("Title");

		toolResult.content = [{ type: "text", text: "# Other heading\n\nbody" }];
		const third = revision("read", state, theme, { args, result: toolResult });
		expect(third.sections[0]?.component).not.toBe(first.sections[0]?.component);
		expect(renderSection(third.sections[0])).toContain("Other heading");
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
		expect(proxied.sections[0]?.component).toBe(first.sections[0]?.component);
		expect(renderSection(proxied.sections[0])).toContain("‹1:toolOutput›m1");

		const recolouredTheme = {
			fg: (color: string, text: string) => `‹2:${color}›${text}`,
			colors: { toolOutput: "T2" },
			getColorMode: () => "truecolor",
			appearance: "dark",
		} as unknown as Theme;
		const recoloured = revision("grep", state, recolouredTheme, { args, result: toolResult });
		expect(recoloured.sections[0]?.component).not.toBe(first.sections[0]?.component);
		expect(renderSection(recoloured.sections[0])).toContain("‹2:toolOutput›m1");
		expect(renderSection(recoloured.sections[0])).not.toContain("‹1:");
	});

	it("retains Write content and rebuilds it when the argument changes in place", () => {
		const state = {};
		const args: { path: string; content: string } = { path: "/tmp/notes.unknownext", content: "print(1)" };
		const first = sectionWithLabel(revision("write", state, theme, { args }), "Content");
		const second = sectionWithLabel(revision("write", state, theme, { args }), "Content");
		expect(second?.component).toBe(first?.component);
		expect(renderSection(second)).toBe("print(1)");

		args.content = "print(2)";
		const third = sectionWithLabel(revision("write", state, theme, { args }), "Content");
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

	it("retains the streamed edit preview and rebuilds it when the arguments change in place", () => {
		const state = {};
		const edits = [{ oldText: "old", newText: "fresh" }];
		const args = { path: "/tmp/module.py", edits };
		const first = sectionWithLabel(revision("edit", state, theme, { args }), "Preview");
		const second = sectionWithLabel(revision("edit", state, theme, { args }), "Preview");
		expect(second?.component).toBe(first?.component);
		expect(renderSection(second)).toBe("-old\n+fresh");

		edits[0] = { oldText: "old", newText: "changed" };
		const third = sectionWithLabel(revision("edit", state, theme, { args }), "Preview");
		expect(third?.component).not.toBe(first?.component);
		expect(renderSection(third)).toBe("-old\n+changed");
	});

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
		expect(markdown.sections[0]?.renderedWidth).toBe("padded");

		const highlighted = view("read", { args: { path: "/tmp/module.py" }, result: textResult("def run(): pass") });
		expect(highlighted.sections[0]?.renderedWidth).toBe("padded");

		const entries = Array.from({ length: 7 }, (_, index) => `file-${index + 1}.ts`).join("\n");
		const find = view("find", { args: { pattern: "file" }, result: textResult(entries) });
		// The layout selects whole logical entries through this exported shape.
		expect(find.sections[0]?.renderedWidth).toBeUndefined();
		expect(find.sections[0]?.component).toMatchObject({
			entryLines: Array.from({ length: 7 }, (_, index) => `file-${index + 1}.ts`),
		});

		const rows = layoutRows("find", { args: { pattern: "file" }, result: textResult(entries) }).join("\n");
		expect(rows).toContain("file-5.ts");
		expect(rows).not.toContain("file-6.ts");
		expect(rows).toContain("2 more entries");
	});
});
