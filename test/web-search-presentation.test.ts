import { getMarkdownTheme, initTheme, type Theme, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { layoutToolView } from "../src/frame.js";

import {
	normalizeDisplayText,
	type ToolContext,
	type ToolResult,
	type ToolSection,
	type ToolSnapshot,
	type ToolView,
} from "../src/tool-presentation.ts";
import {
	createWebSearchView,
	invalidateWebSearchViewCache,
	isWebSearchTool,
	readWebResponse,
	type WebResponse,
	type WebSource,
} from "../src/web-search-presentation.ts";

const capabilities = vi.hoisted(() => ({
	images: null as "kitty" | "iterm2" | null,
	trueColor: false,
	hyperlinks: false,
}));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getCapabilities: () => capabilities,
	};
});

const theme = { fg: (_: string, text: string) => text } as unknown as Theme;

const RESERVED_NAMES = [
	"bash",
	"powershell",
	"read",
	"edit",
	"write",
	"find",
	"grep",
	"ls",
	"tool_search",
	"codemode",
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
];

/** The sequence a hyperlink helper actually emits. */
const LINK_OPEN = "\u001b]8;;";

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
	return { args: {}, context: context(), presentation: "web", ...overrides };
}

function webView(overrides: Partial<ToolSnapshot> = {}): ToolView {
	return createWebSearchView("web_search", snapshot(overrides), theme);
}

function sectionWithLabel(view: ToolView, label: string): ToolSection | undefined {
	return view.sections.find((section) => section.label === label);
}

function renderSection(section: ToolSection | undefined, width = 200): string {
	return section
		? section.component
				.render(width)
				.map((line) => line.trimEnd())
				.join("\n")
		: "";
}

function renderLabel(view: ToolView, label: string): string {
	return renderSection(sectionWithLabel(view, label));
}

/** A theme complete enough for the shared frame (it needs fg, bold and getBgAnsi). */
const frameTheme = {
	fg: (_: string, text: string) => text,
	bold: (text: string) => text,
	getBgAnsi: () => "",
} as unknown as Theme;

/** Render the whole card through the shared frame, collapsed or expanded. */
function frameRows(view: ToolView, snap: ToolSnapshot, width = 200): string[] {
	const layout = layoutToolView(view, snap, frameTheme, width);
	return [...layout.callRows, ...layout.resultRows].map(stripTerminalSequences);
}

function mcpInfo(overrides: Record<string, unknown> = {}): ToolInfo {
	return { name: "mcp__my_web__search", sourceInfo: { path: "builtin:mcp", source: "builtin" }, ...overrides } as ToolInfo;
}

function extensionInfo(overrides: Record<string, unknown> = {}): ToolInfo {
	return { name: "web_search", sourceInfo: { path: "/tmp/web.ts", source: "extension" }, ...overrides } as ToolInfo;
}

function fixtureSources(count: number): WebSource[] {
	return Array.from({ length: count }, (_, index) => ({
		url: `https://example.org/source-${index + 1}`,
		title: `Example Source ${index + 1}`,
	}));
}

function fixtureResponse(overrides: Partial<WebResponse> = {}): WebResponse {
	return { provider: "exa", sources: fixtureSources(10), ...overrides };
}

/** A structured result exactly like the replay fixture: sources live only in `details`. */
function structuredResult(overrides: Partial<WebResponse> = {}, extraDetails: Record<string, unknown> = {}): ToolResult {
	return textResult("RAW_WEB_BODY_WITHOUT_SOURCE_TITLES", {
		response: fixtureResponse(overrides),
		...extraDetails,
	});
}

beforeEach(() => {
	initTheme("dark", false);
});

afterEach(() => {
	capabilities.images = null;
	capabilities.hyperlinks = false;
	vi.restoreAllMocks();
});

describe("isWebSearchTool", () => {
	it("never recognises a reserved Pi tool, even when it is listed or proves MCP identity", () => {
		for (const name of RESERVED_NAMES) {
			expect(isWebSearchTool(name, mcpInfo({ name }), { server: "web", tool: "web_search" }, [name])).toBe(false);
		}
	});

	it("treats an exact configured exposure as an explicit declaration", () => {
		expect(isWebSearchTool("mcp__my_web__search", extensionInfo({ name: "mcp__my_web__search" }), undefined, ["mcp__my_web__search"])).toBe(true);
	});

	it("keeps configured names case-sensitive and exact", () => {
		const configured = ["mcp__my_web__search"];
		expect(isWebSearchTool("mcp__my_web__Search", undefined, undefined, configured)).toBe(false);
		expect(isWebSearchTool("mcp__my_web__search_extra", undefined, undefined, configured)).toBe(false);
		expect(isWebSearchTool("search", undefined, undefined, configured)).toBe(false);
	});

	it("recognises the Pi-native web_search without configuration or metadata", () => {
		expect(isWebSearchTool("web_search", undefined, undefined, [])).toBe(true);
		expect(isWebSearchTool("web_search", extensionInfo(), undefined, [])).toBe(true);
	});

	it("leaves search-like tools to their own renderers", () => {
		for (const name of ["browser_search", "sql_search", "code_search", "search", "fetch", "web_fetch"]) {
			expect(isWebSearchTool(name, extensionInfo({ name }), { server: "web", tool: "web_search" }, [])).toBe(false);
		}
	});

	it("recognises a confirmed MCP tool exposed as <namespace>__web_search", () => {
		const info = mcpInfo({ name: "mcp__my_web__web_search", namespace: { name: "mcp__my_web" } });
		expect(isWebSearchTool("mcp__my_web__web_search", info, undefined, [])).toBe(true);
	});

	it("refuses the namespace rule without confirmed native MCP provenance", () => {
		const info = extensionInfo({ name: "mcp__my_web__web_search", namespace: { name: "mcp__my_web" } });
		expect(isWebSearchTool("mcp__my_web__web_search", info, undefined, [])).toBe(false);
	});

	it("does not split a hashed name without a namespace", () => {
		const info = mcpInfo({ name: "mcp__a_b__c_d", namespace: { name: "mcp__a_b" } });
		expect(isWebSearchTool("mcp__a_b__c_d", info, undefined, [])).toBe(false);
		expect(isWebSearchTool("mcp__a_b_c_d__web_search", info, undefined, [])).toBe(false);
	});

	it("recognises a hashed confirmed MCP name only from its result details", () => {
		const info = mcpInfo({ name: "mcp__a_b__c_d" });
		expect(isWebSearchTool("mcp__a_b__c_d", info, { server: "my-web", tool: "web_search" }, [])).toBe(true);
	});

	it("requires both a non-empty server and the web_search tool marker", () => {
		const info = mcpInfo({ name: "mcp__a_b__c_d" });
		expect(isWebSearchTool("mcp__a_b__c_d", info, { server: "", tool: "web_search" }, [])).toBe(false);
		expect(isWebSearchTool("mcp__a_b__c_d", info, { tool: "web_search" }, [])).toBe(false);
		expect(isWebSearchTool("mcp__a_b__c_d", info, { server: 42, tool: "web_search" }, [])).toBe(false);
		expect(isWebSearchTool("mcp__a_b__c_d", info, { server: "my-web", tool: "lookup" }, [])).toBe(false);
		expect(isWebSearchTool("mcp__a_b__c_d", info, undefined, [])).toBe(false);
	});

	it("never derives web identity from details on a non-MCP tool", () => {
		expect(isWebSearchTool("mcp__a_b__c_d", extensionInfo({ name: "mcp__a_b__c_d" }), { server: "x", tool: "web_search" }, [])).toBe(false);
		expect(isWebSearchTool("mcp__a_b__c_d", undefined, { server: "x", tool: "web_search" }, [])).toBe(false);
	});
});

describe("readWebResponse", () => {
	it("reads the documented details.response first", () => {
		const data = readWebResponse(
			structuredResult({
				answer: "ANSWER_MARKER",
				searchQueries: ["RESULT_QUERY_MARKER"],
				model: "gpt-5",
				authMode: "oauth",
				usage: { inputTokens: 0, totalTokens: 42 },
			}),
		);
		expect(data?.fromContent).toBe(false);
		expect(data?.response.provider).toBe("exa");
		expect(data?.response.sources).toHaveLength(10);
		expect(data?.response.answer).toBe("ANSWER_MARKER");
		expect(data?.response.searchQueries).toEqual(["RESULT_QUERY_MARKER"]);
		expect(data?.response.usage).toEqual({ inputTokens: 0, totalTokens: 42 });
		expect(data?.error).toBeUndefined();
	});

	it("keeps only type-conformant optional fields and refuses non-finite or negative numbers", () => {
		const data = readWebResponse(
			result(
				[{ type: "text", text: "raw" }],
				{
					response: {
						provider: "exa",
						sources: [
							{ url: "https://example.org/a", title: 7, publishedDate: null, ageSeconds: -1 },
							{ url: "https://example.org/b", ageSeconds: 0 },
							{ url: "https://example.org/c", ageSeconds: Number.POSITIVE_INFINITY },
						],
						answer: 12,
						searchQueries: "RESULT_QUERY_MARKER",
						model: 3,
						authMode: false,
						usage: { inputTokens: -5, totalTokens: Number.NaN, searchRequests: 4 },
					},
				},
			),
		);
		expect(data?.response.sources[0]).toEqual({ url: "https://example.org/a" });
		expect(data?.response.sources[1]?.ageSeconds).toBe(0);
		expect(data?.response.sources[2]?.ageSeconds).toBeUndefined();
		expect(data?.response.answer).toBeUndefined();
		expect(data?.response.searchQueries).toBeUndefined();
		expect(data?.response.model).toBeUndefined();
		expect(data?.response.authMode).toBeUndefined();
		expect(data?.response.usage).toEqual({ searchRequests: 4 });
	});

	it("invalidates the whole response when one source is malformed", () => {
		expect(
			readWebResponse(
				result([{ type: "text", text: "raw" }], {
					response: { provider: "exa", sources: [{ url: "https://example.org/a" }, { title: "no url" }] },
				}),
			),
		).toBeUndefined();
	});

	it("refuses aliases instead of guessing a source list", () => {
		for (const alias of ["results", "data", "items"]) {
			expect(
				readWebResponse(result([{ type: "text", text: "raw" }], { response: { provider: "exa", [alias]: fixtureSources(2) } })),
			).toBeUndefined();
		}
	});

	it("attaches details.error only to a validated response", () => {
		const withError = readWebResponse(structuredResult({}, { error: "provider exploded" }));
		expect(withError?.error).toBe("provider exploded");
		expect(readWebResponse(result([{ type: "text", text: "raw" }], { response: { provider: "exa" }, error: "boom" }))).toBeUndefined();
		expect(readWebResponse(structuredResult({}, { error: "" }))?.error).toBeUndefined();
		expect(readWebResponse(structuredResult({}, { error: 42 }))?.error).toBeUndefined();
	});

	it("accepts a single complete JSON text block as a root response", () => {
		const data = readWebResponse(textResult(JSON.stringify(fixtureResponse({ answer: "ANSWER_MARKER" }))));
		expect(data?.fromContent).toBe(true);
		expect(data?.response.provider).toBe("exa");
		expect(data?.response.sources).toHaveLength(10);
	});

	it("accepts a single complete JSON text block wrapped as {response, error}", () => {
		const payload = JSON.stringify({ response: fixtureResponse({ sources: fixtureSources(1) }), error: "partial failure" });
		const data = readWebResponse(textResult(payload));
		expect(data?.fromContent).toBe(true);
		expect(data?.error).toBe("partial failure");
	});

	it("never parses fences, prose or a substring", () => {
		const json = JSON.stringify(fixtureResponse({ sources: fixtureSources(1) }));
		expect(readWebResponse(textResult("```json\n" + json + "\n```"))).toBeUndefined();
		expect(readWebResponse(textResult(`here is the payload: ${json}`))).toBeUndefined();
	});

	it("refuses the text fallback when output is truncated or has a full output path", () => {
		const json = JSON.stringify(fixtureResponse({ sources: fixtureSources(1) }));
		expect(readWebResponse(textResult(`Warning: truncated output\n${json}`))).toBeUndefined();
		expect(readWebResponse(textResult(json, { fullOutputPath: "/tmp/full.txt" }))).toBeUndefined();
	});

	it("refuses the text fallback for several blocks or a non-text block", () => {
		const json = JSON.stringify(fixtureResponse({ sources: fixtureSources(1) }));
		expect(readWebResponse(result([{ type: "text", text: json }, { type: "text", text: json }], {}))).toBeUndefined();
		expect(readWebResponse(result([{ type: "image", data: "AA==", mimeType: "image/png" }], {}))).toBeUndefined();
		expect(readWebResponse(textResult(json, { fullOutputPath: "" }))?.fromContent).toBe(true);
	});

	it("never depends on structuredContent", () => {
		expect(
			readWebResponse(result([{ type: "text", text: "RAW_WEB_L01" }], { structuredContent: fixtureResponse({ sources: fixtureSources(2) }) })),
		).toBeUndefined();
	});

	it("keeps the raw response for invalid JSON or an unknown shape", () => {
		expect(readWebResponse(textResult("not json at all"))).toBeUndefined();
		expect(readWebResponse(textResult("[1,2,3]"))).toBeUndefined();
		expect(readWebResponse(textResult(JSON.stringify({ provider: "exa" })))).toBeUndefined();
	});
});

describe("createWebSearchView before a result", () => {
	it("renders an inline card whose target is the streamed query", () => {
		const view = webView({ args: { query: "Pi 1.1" }, context: context({ executionStarted: true }) });
		expect(view.layout).toBe("inline");
		expect(view.head.title).toBe("Web Search");
		expect(view.head.target).toBe("Pi 1.1");
		expect(view.head.status).toBe("running");
	});

	it("shows a pending target and keeps the other arguments without inventing a query", () => {
		const view = webView({ args: { q: "hello" } });
		expect(view.head.target).toBe("…");
		expect(renderLabel(view, "Arguments")).toContain('q="hello"');
	});

	it("keeps the query out of the Arguments section", () => {
		const view = webView({ args: { query: "Pi 1.1", limit: 5 } });
		const argumentsBody = renderLabel(view, "Arguments");
		expect(argumentsBody).toContain("limit=5");
		expect(argumentsBody).not.toContain("query");
	});

	it("normalises control characters in the streamed query", () => {
		const view = webView({ args: { query: "Pi\u0000 1.1\u009b31m" } });
		expect(view.head.target).not.toContain("\u0000");
		expect(view.head.target).not.toContain("\u009b");
		expect(view.head.target).toContain("\\x9B");
	});

	it("keeps a multiline query intact so the frame can move it into the target section", () => {
		const view = webView({ args: { query: "first line\nsecond line" }, context: context({ expanded: true }) });
		expect(view.head.target).toBe("first line\nsecond line");
	});
});

describe("createWebSearchView structured result", () => {
	it("shows the args query exactly once, in the head", () => {
		const view = webView({ args: { query: "Pi 1.1" }, result: structuredResult({ answer: "ANSWER_MARKER" }) });
		expect(view.layout).toBe("framed");
		expect(view.head.target).toBe("Pi 1.1");
		expect(sectionWithLabel(view, "Query")).toBeUndefined();
		expect(renderLabel(view, "Answer")).not.toContain("Pi 1.1");
	});

	it("labels the source count and keeps eight rows collapsed with the extra hint", () => {
		const view = webView({ args: { query: "Pi 1.1" }, result: structuredResult({ answer: "ANSWER_MARKER" }) });
		const sources = sectionWithLabel(view, "Sources · 10");
		expect(sources?.slot).toBe("result");
		const collapsed = renderSection(sources);
		expect(collapsed.split("\n")).toHaveLength(9);
		expect(collapsed).toContain("… 2 more sources");
		expect(collapsed).not.toContain("Example Source 10");
	});

	it("shows every source when expanded", () => {
		const view = webView({
			args: { query: "Pi 1.1" },
			context: context({ expanded: true }),
			result: structuredResult({ answer: "ANSWER_MARKER" }),
		});
		const expanded = renderLabel(view, "Sources · 10");
		expect(expanded.split("\n")).toHaveLength(10);
		expect(expanded).not.toContain("more sources");
		expect(expanded).toContain("Example Source 10");
	});

	it("renders title, domain and s/m/h/d age, falling back to the URL then Untitled", () => {
		const view = webView({
			result: structuredResult({
				sources: [
					{ url: "https://www.example.org/a", title: "With title", ageSeconds: 90 },
					{ url: "https://example.org/b", publishedDate: "2026-09-01" },
					{ url: "https://example.org/c", title: "   " },
					{ url: "https://example.org/d", title: "Day", ageSeconds: 172800 },
					{ url: "not a url", title: "Unfetchable" },
					{ url: "", title: "" },
				],
			}),
		});
		const rows = renderLabel(view, "Sources · 6").split("\n");
		expect(rows[0]).toBe("├─ With title · example.org · 1m");
		expect(rows[1]).toBe("├─ https://example.org/b · example.org · 2026-09-01");
		expect(rows[2]).toBe("├─ https://example.org/c · example.org");
		expect(rows[3]).toBe("├─ Day · example.org · 2d");
		expect(rows[4]).toBe("├─ Unfetchable");
		expect(rows[5]).toBe("└─ Untitled");
	});

	it("links only the canonical http(s) href", () => {
		capabilities.hyperlinks = true;
		const view = webView({ result: structuredResult({ sources: [{ url: "https://EXAMPLE.org/a?b=2", title: "Anchor" }] }) });
		const rendered = renderLabel(view, "Sources · 1");
		expect(rendered).toContain(`${LINK_OPEN}https://example.org/a?b=2\u001b\\`);
		expect(rendered).not.toContain("EXAMPLE.org");
	});

	it("leaves rejected URLs as plain normalised text", () => {
		capabilities.hyperlinks = true;
		const view = webView({
			result: structuredResult({
				sources: [
					{ url: "javascript:alert(1)", title: "JS" },
					{ url: "file:///etc/passwd", title: "File" },
					{ url: "https://example.org/\u0000x" },
				],
			}),
		});
		const rendered = renderLabel(view, "Sources · 3");
		expect(rendered).not.toContain(LINK_OPEN);
		expect(rendered).toContain("JS");
		expect(rendered).toContain("\u2400");
		expect(rendered).not.toContain("\u0000");
	});

	it("reports a real zero-source response as a warning notice, not an error", () => {
		const view = webView({ result: structuredResult({ sources: [] }) });
		expect(view.tone).toBe("warning");
		expect(renderLabel(view, "Sources · 0")).toContain("No sources returned");
		expect(sectionWithLabel(view, "Error")).toBeUndefined();
	});

	it("puts a result-provided search query in a result-only section without repeating it in the head", () => {
		const view = webView({ args: {}, result: structuredResult({ searchQueries: ["RESULT_QUERY_MARKER"] }) });
		const query = sectionWithLabel(view, "Query");
		expect(query?.slot).toBe("result");
		expect(query?.preview).toBe(false);
		expect(renderSection(query)).toContain("RESULT_QUERY_MARKER");
		expect(view.head.target).toBe("");
		expect(view.head.target).not.toContain("RESULT_QUERY_MARKER");
	});

	it("never fabricates a query when the response has none", () => {
		const view = webView({ args: {}, result: structuredResult({ searchQueries: ["", "  "] }) });
		expect(sectionWithLabel(view, "Query")).toBeUndefined();
		expect(view.head.target).toBe("");
	});

	it("renders the answer as unclamped markdown and falls back to the real result text", () => {
		const withAnswer = webView({ result: structuredResult({ answer: "ANSWER_MARKER" }) });
		expect(sectionWithLabel(withAnswer, "Answer")?.preview).toBe(false);
		expect(renderLabel(withAnswer, "Answer")).toContain("ANSWER_MARKER");
		expect(withAnswer.preview).toBeUndefined();

		const withoutAnswer = webView({ result: structuredResult() });
		expect(renderLabel(withoutAnswer, "Answer")).toContain("RAW_WEB_BODY_WITHOUT_SOURCE_TITLES");
	});

	it("does not repeat a single-block structured JSON under Answer", () => {
		const payload = JSON.stringify(fixtureResponse({ sources: fixtureSources(2) }));
		const view = webView({ result: textResult(payload) });
		expect(sectionWithLabel(view, "Answer")).toBeUndefined();
		expect(renderLabel(view, "Sources · 2")).toContain("Example Source 1");
	});

	it("shows validated metadata and never an absent field", () => {
		const view = webView({
			result: structuredResult({ provider: "codex", model: "gpt-5", authMode: "api_key", usage: { inputTokens: 0, totalTokens: 42 } }),
		});
		expect(view.head.meta).toEqual(["OpenAI Codex"]);
		const metadata = renderLabel(view, "Metadata");
		expect(metadata).toContain("Provider: gpt-5 @ OpenAI Codex (API)");
		expect(metadata).toContain("Usage: in 0 · total 42");
		expect(metadata).not.toContain("search ");
	});

	it("maps oauth, keeps other modes and falls back to the raw provider id", () => {
		expect(renderLabel(webView({ result: structuredResult({ authMode: "oauth" }) }), "Metadata")).toContain("(OAuth)");
		expect(renderLabel(webView({ result: structuredResult({ authMode: "custom" }) }), "Metadata")).toContain("(custom)");
		expect(webView({ result: structuredResult({ provider: "acme" }) }).head.meta).toEqual(["acme"]);
		expect(webView({ result: structuredResult({ provider: "none" }) }).head.meta).toEqual(["None"]);
	});

	it("keeps full output and warnings outside the clamp", () => {
		const view = webView({
			result: structuredResult({}, { fullOutputPath: "/tmp/fixture-full.txt", warnings: ["first warning"] }),
		});
		const warnings = sectionWithLabel(view, "Warnings");
		expect(warnings?.preview).toBe(false);
		expect(renderSection(warnings)).toContain("first warning");
		const fullOutput = view.sections.at(-1);
		expect(fullOutput?.label).toBeUndefined();
		expect(fullOutput?.preview).toBe(false);
		expect(renderSection(fullOutput)).toContain("Full output: /tmp/fixture-full.txt");
	});

	it("keeps a literal invalid-arg marker query as the provided query", () => {
		const view = webView({
			args: { query: "[invalid arg]" },
			result: structuredResult({ searchQueries: ["RESULT_QUERY_MARKER"] }),
		});
		expect(view.head.target).toBe("[invalid arg]");
		expect(sectionWithLabel(view, "Query")).toBeUndefined();
	});

	it("falls back to the response query when the args query is not a string", () => {
		const view = webView({ args: { query: 42, limit: 5 }, result: structuredResult({ searchQueries: ["RESULT_QUERY_MARKER"] }) });
		expect(view.head.target).toBe("[invalid arg]");
		const query = sectionWithLabel(view, "Query");
		expect(query?.slot).toBe("result");
		expect(query?.preview).toBe(false);
		expect(renderSection(query)).toContain("RESULT_QUERY_MARKER");
		// The unusable raw argument is still shown, and the fallback never leaks there.
		const argumentsBody = renderLabel(view, "Arguments");
		expect(argumentsBody).toContain("query=42");
		expect(argumentsBody).not.toContain("RESULT_QUERY_MARKER");
	});

	it("treats an empty provided query as a provided query", () => {
		const view = webView({ args: { query: "" }, result: structuredResult({ searchQueries: ["RESULT_QUERY_MARKER"] }) });
		expect(view.head.target).toBe("");
		expect(sectionWithLabel(view, "Query")).toBeUndefined();
	});

	it("keeps only the call section outside the result slot", () => {
		const view = webView({ args: { query: "Pi 1.1", limit: 5 }, result: structuredResult({ answer: "ANSWER_MARKER" }) });
		for (const section of view.sections) {
			expect(section.slot).toBe(section.label === "Arguments" ? "call" : "result");
		}
	});

	it("keeps every source row inside the passed width", () => {
		const view = webView({
			context: context({ expanded: true }),
			result: structuredResult({
				sources: [
					{ url: "https://example.org/a", title: "A very long source title that keeps going and going" },
					{ url: "https://example.org/b", ageSeconds: 90 },
				],
			}),
		});
		const sources = sectionWithLabel(view, "Sources · 2");
		expect(sources).toBeDefined();
		for (const width of [24, 80]) {
			const lines = sources?.component.render(width) ?? [];
			expect(lines.length).toBeGreaterThan(0);
			expect(lines[0]).toContain("A very long");
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("normalises control and escape sequences in the answer, model, auth and full output", () => {
		const view = webView({
			result: structuredResult(
				{
					answer: "ANSWER_START\u001b]8;;https://evil.example\u0007ANSWER_END\u009b31m",
					model: "gpt\u00005",
					authMode: "custom\u009b31m",
				},
				{ fullOutputPath: "/tmp/\u009b31m-full.txt" },
			),
		});
		const rendered = [
			renderLabel(view, "Answer"),
			renderLabel(view, "Metadata"),
			renderSection(view.sections.at(-1)),
		].join("\n");
		expect(rendered).toContain("ANSWER_START");
		expect(rendered).not.toContain("\u009b");
		expect(rendered).not.toContain("\u001b]8;;https://evil.example");
		expect(rendered).toContain("\\x9B");
		expect(rendered).toContain("\u2400");
	});

	it("falls back to the raw id for provider keys inherited from Object.prototype", () => {
		for (const provider of ["constructor", "__proto__", "toString"]) {
			const view = webView({ result: structuredResult({ provider }) });
			expect(view.head.meta).toEqual([provider]);
			expect(renderLabel(view, "Metadata")).toContain(`Provider: ${provider}`);
		}
	});

	it("keeps an image indicator instead of losing it behind the structured answer", () => {
		const withAnswer = webView({
			context: context({ showImages: false }),
			result: result(
				[
					{ type: "text", text: "RAW_WEB_BODY_WITHOUT_SOURCE_TITLES" },
					{ type: "image", data: "AA==", mimeType: "image/png" },
				],
				{ response: fixtureResponse({ answer: "ANSWER_MARKER" }) },
			),
		});
		expect(renderLabel(withAnswer, "Answer")).toContain("ANSWER_MARKER");
		expect(renderLabel(withAnswer, "Answer")).not.toContain("image/png");
		const indicator = withAnswer.sections
			.map((section) => renderSection(section))
			.find((text) => text.includes("image/png"));
		expect(indicator).toContain("image/png");

		// The shared extraction already carries the indicator, so it is never doubled.
		const realText = webView({
			context: context({ showImages: false }),
			result: result(
				[
					{ type: "text", text: "RAW_WEB_L01" },
					{ type: "image", data: "AA==", mimeType: "image/png" },
				],
				{ response: fixtureResponse() },
			),
		});
		const occurrences = realText.sections.filter((section) => renderSection(section).includes("image/png")).length;
		expect(occurrences).toBe(1);
	});
});

describe("createWebSearchView error results", () => {
	it("owns the structured error message and invents no success", () => {
		const view = webView({ result: structuredResult({ answer: "ANSWER_MARKER" }, { error: "PROVIDER_FAILURE_MARKER" }) });
		expect(view.tone).toBe("error");
		expect(view.head.meta).toEqual(["Exa"]);
		expect(renderLabel(view, "Error")).toContain("PROVIDER_FAILURE_MARKER");
		expect(sectionWithLabel(view, "Answer")).toBeUndefined();
		expect(sectionWithLabel(view, "Sources · 10")).toBeUndefined();
		expect(sectionWithLabel(view, "Metadata")).toBeUndefined();
	});

	it("keeps the response fallback query, ahead of the real error, when the call had none", () => {
		const view = webView({
			args: {},
			result: structuredResult({ searchQueries: ["RESULT_QUERY_MARKER"] }, { error: "PROVIDER_FAILURE_MARKER" }),
		});
		expect(view.tone).toBe("error");
		const query = sectionWithLabel(view, "Query");
		expect(query?.slot).toBe("result");
		expect(query?.preview).toBe(false);
		expect(renderSection(query)).toContain("RESULT_QUERY_MARKER");
		expect(renderLabel(view, "Error")).toContain("PROVIDER_FAILURE_MARKER");
		const labels = view.sections.map((section) => section.label);
		expect(labels.indexOf("Query")).toBeLessThan(labels.indexOf("Error"));
		// The fallback is never duplicated into the header, and no success is invented.
		expect(view.head.target).toBe("");
		expect(sectionWithLabel(view, "Answer")).toBeUndefined();
		expect(sectionWithLabel(view, "Sources · 10")).toBeUndefined();
	});

	it("never repeats an args query for an error result", () => {
		const view = webView({
			args: { query: "Pi 1.1" },
			result: structuredResult({ searchQueries: ["RESULT_QUERY_MARKER"] }, { error: "PROVIDER_FAILURE_MARKER" }),
		});
		expect(view.head.target).toBe("Pi 1.1");
		expect(sectionWithLabel(view, "Query")).toBeUndefined();
		expect(renderLabel(view, "Error")).toContain("PROVIDER_FAILURE_MARKER");
	});

	it("uses the real result text for a flagged error", () => {
		const view = webView({
			result: textResult("MCP_WEB_ERROR_MARKER", { response: fixtureResponse() }),
			context: context({ isError: true }),
		});
		expect(view.tone).toBe("error");
		expect(renderLabel(view, "Error")).toContain("MCP_WEB_ERROR_MARKER");
		expect(sectionWithLabel(view, "Sources · 10")).toBeUndefined();
	});

	it("keeps hidden image placeholders beside a structured error message", () => {
		for (const showImages of [false, true]) {
			capabilities.images = null;
			const view = webView({
				result: result(
					[
						{ type: "text", text: "RAW_WEB_BODY_WITHOUT_SOURCE_TITLES" },
						{ type: "image", data: "AA==", mimeType: "image/png" },
					],
					{ response: fixtureResponse(), error: "PROVIDER_FAILURE_MARKER" },
				),
				context: context({ showImages }),
			});
			expect(view.tone).toBe("error");
			// The structured message neither carries nor swallows the placeholder.
			const errorSection = sectionWithLabel(view, "Error");
			expect(renderSection(errorSection)).toContain("PROVIDER_FAILURE_MARKER");
			expect(renderSection(errorSection)).not.toContain("image/png");
			const indicators = view.sections.filter((section) => renderSection(section).includes("image/png"));
			expect(indicators).toHaveLength(1);
			expect(renderSection(indicators[0])).toContain("[image/png]");
			expect(sectionWithLabel(view, "Answer")).toBeUndefined();
			expect(sectionWithLabel(view, "Sources · 10")).toBeUndefined();
		}
	});

	it("drops the placeholder when the terminal can draw the image", () => {
		capabilities.images = "kitty";
		const view = webView({
			result: result(
				[
					{ type: "text", text: "RAW_WEB_BODY_WITHOUT_SOURCE_TITLES" },
					{ type: "image", data: "AA==", mimeType: "image/png" },
				],
				{ response: fixtureResponse(), error: "PROVIDER_FAILURE_MARKER" },
			),
			context: context({ showImages: true }),
		});
		expect(view.tone).toBe("error");
		expect(renderLabel(view, "Error")).toContain("PROVIDER_FAILURE_MARKER");
		expect(view.sections.filter((section) => renderSection(section).includes("image/png"))).toHaveLength(0);
	});

	it("never doubles the image placeholder for a text-derived error message", () => {
		const view = webView({
			result: result(
				[
					{ type: "text", text: "MCP_WEB_ERROR_MARKER" },
					{ type: "image", data: "AA==", mimeType: "image/png" },
				],
				{ response: fixtureResponse() },
			),
			context: context({ isError: true, showImages: false }),
		});
		expect(view.tone).toBe("error");
		// The whole-result extraction already supplied the placeholder, so it stays
		// inside the single Error section.
		const errorSection = sectionWithLabel(view, "Error");
		expect(renderSection(errorSection)).toContain("MCP_WEB_ERROR_MARKER");
		expect(renderSection(errorSection)).toContain("[image/png]");
		const indicators = view.sections.filter((section) => renderSection(section).includes("image/png"));
		expect(indicators).toHaveLength(1);
	});

	it("names an unstructured error section Error and marks the tone", () => {
		const view = webView({ result: textResult("MCP_WEB_ERROR_MARKER"), context: context({ isError: true }) });
		expect(view.head.status).toBe("error");
		expect(view.tone).toBe("error");
		expect(sectionWithLabel(view, "Error")).toBeDefined();
		expect(sectionWithLabel(view, "Response")).toBeUndefined();
		expect(renderLabel(view, "Error")).toContain("MCP_WEB_ERROR_MARKER");
	});

	it("invents no error section for an empty error message", () => {
		const view = webView({ result: textResult("  \n "), context: context({ isError: true }) });
		expect(view.head.status).toBe("error");
		expect(view.tone).toBe("error");
		expect(sectionWithLabel(view, "Error")).toBeUndefined();
		expect(view.sections).toEqual([]);

		// A provided full output is still preserved beside the empty error.
		const withOutput = webView({
			result: result([{ type: "text", text: "" }], { fullOutputPath: "/tmp/empty-error.txt" }),
			context: context({ isError: true }),
		});
		expect(sectionWithLabel(withOutput, "Error")).toBeUndefined();
		expect(renderSection(withOutput.sections.at(-1))).toContain("Full output: /tmp/empty-error.txt");
	});

	it("previews six visual lines of a raw error and reveals the rest on expansion", () => {
		const lines = Array.from({ length: 20 }, (_, index) => `WEB_ERROR_L${String(index + 1).padStart(2, "0")}`);
		const snap = snapshot({ result: textResult(lines.join("\n")), context: context({ isError: true }) });
		const view = createWebSearchView("web_search", snap, theme);
		expect(view.preview).toEqual({ edge: "head", count: 6, unit: "visual-lines" });
		expect(sectionWithLabel(view, "Error")?.preview).toBe(true);

		const collapsed = frameRows(view, snap).join("\n");
		expect(collapsed.split("\n").filter((line) => /WEB_ERROR_L\d\d/u.test(line))).toHaveLength(6);
		expect(collapsed).toContain("WEB_ERROR_L01");
		expect(collapsed).toContain("WEB_ERROR_L06");
		expect(collapsed).toContain("14 more lines");
		expect(collapsed).not.toContain("WEB_ERROR_L20");

		const expandedSnap = snapshot({
			result: textResult(lines.join("\n")),
			context: context({ isError: true, expanded: true }),
		});
		const expanded = frameRows(createWebSearchView("web_search", expandedSnap, theme), expandedSnap).join("\n");
		expect(expanded.split("\n").filter((line) => /WEB_ERROR_L\d\d/u.test(line))).toHaveLength(20);
		expect(expanded).toContain("WEB_ERROR_L20");
		expect(expanded).not.toContain("more lines");
	});

	it("keeps a validated structured error message unclamped", () => {
		const lines = Array.from({ length: 20 }, (_, index) => `STRUCTURED_ERROR_L${String(index + 1).padStart(2, "0")}`);
		const snap = snapshot({
			result: textResult("RAW_WEB_BODY", { response: fixtureResponse(), error: lines.join("\n") }),
		});
		const view = createWebSearchView("web_search", snap, theme);
		expect(view.tone).toBe("error");
		expect(view.preview).toBeUndefined();
		expect(sectionWithLabel(view, "Error")?.preview).toBe(false);
		const collapsed = frameRows(view, snap).join("\n");
		expect(collapsed.split("\n").filter((line) => /STRUCTURED_ERROR_L\d\d/u.test(line))).toHaveLength(20);
		expect(collapsed).toContain("STRUCTURED_ERROR_L20");
		expect(collapsed).not.toContain("more lines");
	});

	it("keeps a content-derived error beside a validated response unclamped", () => {
		const lines = Array.from({ length: 20 }, (_, index) => `VALIDATED_CONTENT_ERROR_L${String(index + 1).padStart(2, "0")}`);
		const snap = snapshot({
			result: textResult(lines.join("\n"), { response: fixtureResponse() }),
			context: context({ isError: true }),
		});
		const view = createWebSearchView("web_search", snap, theme);
		expect(view.tone).toBe("error");
		expect(view.preview).toBeUndefined();
		expect(sectionWithLabel(view, "Error")?.preview).toBe(false);
		const collapsed = frameRows(view, snap).join("\n");
		expect(collapsed.split("\n").filter((line) => /VALIDATED_CONTENT_ERROR_L\d\d/u.test(line))).toHaveLength(20);
		expect(collapsed).toContain("VALIDATED_CONTENT_ERROR_L20");
		expect(collapsed).not.toContain("more lines");
	});

	it("never clamps warning or full-output text beside a raw error", () => {
		const warnings = Array.from({ length: 12 }, (_, index) => `WARN_LINE_${String(index + 1).padStart(2, "0")}`);
		const error = Array.from({ length: 20 }, (_, index) => `RAW_ERR_LINE_${String(index + 1).padStart(2, "0")}`).join("\n");
		const snap = snapshot({
			result: textResult(error, { warnings, fullOutputPath: "/tmp/raw-error.txt" }),
			context: context({ isError: true }),
		});
		const view = createWebSearchView("web_search", snap, theme);
		expect(sectionWithLabel(view, "Warnings")?.preview).toBe(false);
		const fullOutput = view.sections.at(-1);
		expect(fullOutput?.label).toBeUndefined();
		expect(fullOutput?.preview).toBe(false);

		const collapsed = frameRows(view, snap).join("\n");
		expect(collapsed.split("\n").filter((line) => /WARN_LINE_\d\d/u.test(line))).toHaveLength(12);
		expect(collapsed).toContain("WARN_LINE_12");
		expect(collapsed).toContain("Full output: /tmp/raw-error.txt");
		// Only the raw error section is clamped to the head preview.
		expect(collapsed).toContain("14 more lines");
	});
});

describe("createWebSearchView unstructured results", () => {
	it("previews six visual lines of the real text and invents no provider, count or metadata", () => {
		const lines = Array.from({ length: 12 }, (_, index) => `RAW_WEB_L${String(index + 1).padStart(2, "0")}`);
		const view = webView({ result: textResult(lines.join("\n")) });
		expect(view.preview).toEqual({ edge: "head", count: 6, unit: "visual-lines" });
		expect(view.head.meta).toEqual([]);
		expect(sectionWithLabel(view, "Response")?.preview).toBe(true);
		expect(view.sections.some((section) => (section.label ?? "").startsWith("Sources"))).toBe(false);
		expect(sectionWithLabel(view, "Metadata")).toBeUndefined();
		expect(renderLabel(view, "Response")).toContain("RAW_WEB_L01");
		expect(view.head.status).toBe("done");
	});

	it("keeps the real query in the head", () => {
		const view = webView({ args: { query: "Pi 1.1" }, result: textResult("RAW_WEB_L01") });
		expect(view.head.target).toBe("Pi 1.1");
	});

	it("shows the header and state only for empty text", () => {
		const view = webView({ result: textResult("   ") });
		expect(sectionWithLabel(view, "Response")).toBeUndefined();
		expect(view.sections).toEqual([]);
		expect(view.head.title).toBe("Web Search");
	});

	it("accepts a single-block OMP JSON response without structuredContent", () => {
		const payload = JSON.stringify({
			response: fixtureResponse({ answer: "ANSWER_MARKER", usage: { inputTokens: 0, totalTokens: 42 } }),
			error: undefined,
		});
		const view = webView({ result: textResult(payload) });
		expect(renderLabel(view, "Answer")).toContain("ANSWER_MARKER");
		expect(renderLabel(view, "Sources · 10")).toContain("Example Source 1");
	});

	it("adds no sources section when the count is unavailable", () => {
		const view = webView({ result: textResult("RAW_WEB_L01") });
		expect(view.sections.some((section) => (section.label ?? "").startsWith("Sources"))).toBe(false);
	});

	it("keeps internal blank lines of the raw response text", () => {
		const raw = "RAW_WEB_L01\n\nRAW_WEB_L03";
		const view = webView({ result: textResult(raw) });
		const response = sectionWithLabel(view, "Response");
		expect(response).toBeDefined();
		// The rendered rows must equal a real Markdown built from the same normalized
		// text at the same width and theme, so a dropped blank line cannot slip through.
		const reference = new Markdown(normalizeDisplayText(raw), 0, 0, getMarkdownTheme())
			.render(200)
			.map((line) => line.trimEnd());
		const rows = (response?.component.render(200) ?? []).map((line) => line.trimEnd());
		expect(rows).toEqual(reference);
		// Both paragraph markers survive on separate rows.
		const first = rows.findIndex((line) => line.includes("RAW_WEB_L01"));
		const second = rows.findIndex((line) => line.includes("RAW_WEB_L03"));
		expect(second).toBeGreaterThan(first);
	});

	it("accepts JSON carried by a single text block beside an image and keeps the indicator", () => {
		const payload = JSON.stringify(fixtureResponse({ sources: fixtureSources(2) }));
		const view = webView({
			context: context({ showImages: false }),
			result: result(
				[
					{ type: "image", data: "AA==", mimeType: "image/png" },
					{ type: "text", text: payload },
				],
				{},
			),
		});
		expect(sectionWithLabel(view, "Sources · 2")).toBeDefined();
		expect(sectionWithLabel(view, "Answer")).toBeUndefined();
		expect(view.sections.some((section) => renderSection(section).includes("image/png"))).toBe(true);
	});
});

describe("createWebSearchView status and duration", () => {
	it("reports the final duration the context provides", () => {
		const view = webView({ result: structuredResult(), context: context({ durationMs: 1250 }) });
		expect(view.head.durationMs).toBe(1250);
		expect(view.head.status).toBe("done");
	});

	it("omits a non-finite or negative duration", () => {
		expect(webView({ result: structuredResult(), context: context({ durationMs: Number.NaN }) }).head.durationMs).toBeUndefined();
		expect(webView({ result: structuredResult(), context: context({ durationMs: -100 }) }).head.durationMs).toBeUndefined();
	});

	it("keeps a streaming partial result running", () => {
		const view = webView({ result: structuredResult(), context: context({ isPartial: true }) });
		expect(view.head.status).toBe("running");
	});

	it("stays pending for a partial revision that has no result yet", () => {
		const view = webView({ context: context({ isPartial: true, argsComplete: false }) });
		expect(view.head.status).toBe("pending");
		expect(view.layout).toBe("inline");
	});

	it("runs once execution has started even before a result arrives", () => {
		expect(webView({ context: context({ executionStarted: true }) }).head.status).toBe("running");
		expect(webView({ context: context({ executionStarted: true, isPartial: true }) }).head.status).toBe("running");
	});
});

/* -------------------------------------------------------------------------- */
/* Owned primary reuse                                                        */
/* -------------------------------------------------------------------------- */

describe("owned web view reuse", () => {
	it("retains the answer and response Markdown for an unchanged revision", () => {
		const state = {};
		const response = { provider: "exa", sources: [{ url: "https://example.org/one", title: "One" }], answer: "ANSWER_TEXT" };
		const answered = textResult("RAW_BODY", { response });
		const raw = textResult("UNSTRUCTURED_BODY");

		const firstAnswer = webView({ args: { query: "q" }, context: context({ state }), result: answered });
		const secondAnswer = webView({ args: { query: "q" }, context: context({ state }), result: answered });
		expect(sectionWithLabel(secondAnswer, "Answer")?.component).toBe(sectionWithLabel(firstAnswer, "Answer")?.component);
		expect(renderSection(sectionWithLabel(secondAnswer, "Answer"))).toContain("ANSWER_TEXT");

		const firstRaw = webView({ args: { query: "q" }, context: context({ state }), result: raw });
		const secondRaw = webView({ args: { query: "q" }, context: context({ state }), result: raw });
		expect(sectionWithLabel(secondRaw, "Response")?.component).toBe(sectionWithLabel(firstRaw, "Response")?.component);
		expect(renderSection(sectionWithLabel(secondRaw, "Response"))).toContain("UNSTRUCTURED_BODY");
	});

	it("keeps the source list and metadata fresh while the retained answer is reused", () => {
		const state = {};
		const sources = [{ url: "https://example.org/one", title: "First source" }];
		const response = { provider: "exa", sources, answer: "ANSWER_TEXT", model: "exa-one" };
		const result = textResult("RAW_BODY", { response });

		const first = webView({ args: { query: "q" }, context: context({ state }), result });
		const second = webView({ args: { query: "q" }, context: context({ state }), result });
		expect(sectionWithLabel(second, "Answer")?.component).toBe(sectionWithLabel(first, "Answer")?.component);

		sources[0] = { url: "https://example.org/two", title: "Second source" };
		response.model = "exa-two";
		const third = webView({ args: { query: "q" }, context: context({ state }), result });

		expect(sectionWithLabel(third, "Answer")?.component).toBe(sectionWithLabel(first, "Answer")?.component);
		expect(sectionWithLabel(third, "Sources · 1")?.component).not.toBe(sectionWithLabel(first, "Sources · 1")?.component);
		expect(renderLabel(third, "Sources · 1")).toContain("Second source");
		expect(renderLabel(third, "Sources · 1")).not.toContain("First source");
		expect(renderLabel(third, "Metadata")).toContain("exa-two");
	});

	it("rebuilds the retained answer when the response text changes in place", () => {
		const state = {};
		const response = { provider: "exa", sources: [], answer: "ANSWER_TEXT" };
		const result = textResult("RAW_BODY", { response });

		const first = webView({ args: { query: "q" }, context: context({ state }), result });
		response.answer = "CHANGED_ANSWER";
		const second = webView({ args: { query: "q" }, context: context({ state }), result });

		expect(sectionWithLabel(second, "Answer")?.component).not.toBe(sectionWithLabel(first, "Answer")?.component);
		expect(renderSection(sectionWithLabel(second, "Answer"))).toContain("CHANGED_ANSWER");
		expect(renderSection(sectionWithLabel(second, "Answer"))).not.toContain("ANSWER_TEXT");
	});

	it("re-reads the mutable query argument on an ordinary revision", () => {
		const state = {};
		const args: { query: string } = { query: "first query" };
		const result = textResult("UNSTRUCTURED_BODY");

		expect(webView({ args, context: context({ state }), result }).head.target).toBe("first query");
		args.query = "second query";
		expect(webView({ args, context: context({ state }), result }).head.target).toBe("second query");
	});

	it("drops the retained answer when the web cache is explicitly invalidated", () => {
		const state = {};
		const response = { provider: "exa", sources: [], answer: "ANSWER_TEXT" };
		const result = textResult("RAW_BODY", { response });

		const first = webView({ args: { query: "q" }, context: context({ state }), result });
		const second = webView({ args: { query: "q" }, context: context({ state }), result });
		expect(sectionWithLabel(second, "Answer")?.component).toBe(sectionWithLabel(first, "Answer")?.component);

		invalidateWebSearchViewCache(state);

		const third = webView({ args: { query: "q" }, context: context({ state }), result });
		expect(sectionWithLabel(third, "Answer")?.component).not.toBe(sectionWithLabel(first, "Answer")?.component);
		expect(renderSection(sectionWithLabel(third, "Answer"))).toContain("ANSWER_TEXT");
	});

	it("recolours the metadata and rebuilds the answer when the theme colours change", () => {
		const state = {};
		const response = { provider: "exa", sources: [], answer: "ANSWER_TEXT" };
		const result = textResult("RAW_BODY", { response });
		// Structural theme stubs: the view reads only fg/colors/getColorMode/appearance.
		const base = {
			fg: (color: string, text: string) => `‹1:${color}›${text}`,
			colors: { muted: "M1" },
			getColorMode: () => "truecolor",
			appearance: "dark",
		} as unknown as Theme;
		const first = createWebSearchView("web_search", snapshot({ args: { query: "q" }, context: context({ state }), result }), base);
		const proxied = createWebSearchView(
			"web_search",
			snapshot({ args: { query: "q" }, context: context({ state }), result }),
			new Proxy(base, {}),
		);
		expect(sectionWithLabel(proxied, "Answer")?.component).toBe(sectionWithLabel(first, "Answer")?.component);
		expect(renderLabel(proxied, "Metadata")).toContain("‹1:muted›");

		const recolouredTheme = {
			fg: (color: string, text: string) => `‹2:${color}›${text}`,
			colors: { muted: "M2" },
			getColorMode: () => "truecolor",
			appearance: "dark",
		} as unknown as Theme;
		const recoloured = createWebSearchView(
			"web_search",
			snapshot({ args: { query: "q" }, context: context({ state }), result }),
			recolouredTheme,
		);
		expect(sectionWithLabel(recoloured, "Answer")?.component).not.toBe(sectionWithLabel(first, "Answer")?.component);
		expect(renderLabel(recoloured, "Metadata")).toContain("‹2:muted›");
		expect(renderLabel(recoloured, "Metadata")).not.toContain("‹1:");
	});

	it("marks owned text and Markdown sections padded and leaves the source list unmarked", () => {
		const answered = webView({ args: { query: "q" }, result: structuredResult({ answer: "ANSWER_TEXT" }) });
		expect(sectionWithLabel(answered, "Answer")?.renderedWidth).toBe("padded");
		expect(sectionWithLabel(answered, "Sources · 10")?.renderedWidth).toBeUndefined();
		expect(sectionWithLabel(answered, "Metadata")?.renderedWidth).toBe("padded");

		const raw = webView({ args: { query: "q" }, result: textResult("UNSTRUCTURED_BODY") });
		expect(sectionWithLabel(raw, "Response")?.renderedWidth).toBe("padded");

		const failed = webView({ args: { query: "q" }, result: textResult("BOOM"), context: context({ isError: true }) });
		expect(sectionWithLabel(failed, "Error")?.renderedWidth).toBe("padded");

		const pending = webView({ args: { query: "q", limit: 5 } });
		expect(sectionWithLabel(pending, "Arguments")?.renderedWidth).toBe("padded");
	});
});
