import { classifyTool, type ToolCategory } from "./tool-category.js";

export type IconMode = "ascii" | "nerd-font" | "off";

type IconKind =
	| "bug"
	| "download"
	| "edit"
	| "file"
	| "globe"
	| "list"
	| "plug"
	| "question"
	| "save"
	| "search"
	| "sitemap"
	| "terminal"
	| "wrench";

const ASCII_ICONS: Record<IconKind, string> = {
	bug: "[D]",
	download: "[v]",
	edit: "[E]",
	file: "[F]",
	globe: "[@]",
	list: "[#]",
	plug: "[M]",
	question: "[!]",
	save: "[W]",
	search: "[?]",
	sitemap: "[*]",
	terminal: "[$]",
	wrench: "[T]",
};

const NERD_FONT_ICONS: Record<IconKind, string> = {
	bug: "", // nf-fa-bug
	download: "", // nf-fa-cloud_download
	edit: "", // nf-fa-edit
	file: "", // nf-fa-file
	globe: "", // nf-fa-globe
	list: "", // nf-fa-list
	plug: "", // nf-fa-plug
	question: "", // nf-fa-question_circle
	save: "", // nf-fa-save
	search: "", // nf-fa-search
	sitemap: "", // nf-fa-sitemap
	terminal: "", // nf-fa-terminal
	wrench: "", // nf-fa-wrench
};

const CATEGORY_ICON: Record<ToolCategory, IconKind> = {
	execute: "terminal",
	external: "globe",
	inspect: "search",
	interact: "question",
	mutate: "edit",
	orchestrate: "sitemap",
	other: "wrench",
};

const DIAGNOSTIC_TERMS = new Set(["diagnostics", "lens", "lsp"]);
const EDIT_TERMS = new Set(["edit", "patch", "replace"]);
const QUESTION_TERMS = new Set(["ask", "confirm", "question"]);
const SEARCH_TERMS = new Set(["find", "grep", "search", "symbol"]);
const EXECUTION_TERMS = new Set([
	"bash",
	"command",
	"exec",
	"execute",
	"run",
	"shell",
	"terminal",
]);

export function formatToolTitle(toolName: string, mode: IconMode): string {
	if (mode === "off") return toolName;
	return `${iconForTool(toolName, mode)} | ${toolName}`;
}

function iconForTool(
	toolName: string,
	mode: Exclude<IconMode, "off">,
): string {
	const kind = resolveIconKind(toolName);
	return mode === "nerd-font" ? NERD_FONT_ICONS[kind] : ASCII_ICONS[kind];
}

function resolveIconKind(toolName: string): IconKind {
	const normalized = normalizeToolName(toolName);
	const terms = normalized.split("_").filter(Boolean);
	const namespace = terms[0] ?? "";

	return (
		resolveDocumentIcon(normalized, terms) ??
		resolveExternalIcon(normalized, namespace) ??
		resolveOrchestrationIcon(normalized, namespace) ??
		resolveActionIcon(terms) ??
		CATEGORY_ICON[classifyTool(toolName)]
	);
}

function resolveDocumentIcon(
	normalized: string,
	terms: readonly string[],
): IconKind | undefined {
	if (hasAnyTerm(terms, DIAGNOSTIC_TERMS)) return "bug";
	if (normalized === "read" || normalized.startsWith("read_")) return "file";
	if (normalized === "write") return "save";
	if (hasAnyTerm(terms, EDIT_TERMS)) return "edit";
	return undefined;
}

function resolveExternalIcon(
	normalized: string,
	namespace: string,
): IconKind | undefined {
	if (namespace === "fetch" || normalized === "get_search_content") {
		return "download";
	}
	if (["web", "browser", "github", "slack"].includes(namespace)) {
		return "globe";
	}
	return namespace === "mcp" ? "plug" : undefined;
}

function resolveOrchestrationIcon(
	normalized: string,
	namespace: string,
): IconKind | undefined {
	if (normalized === "manage_todo_list") return "sitemap";
	if (["workflow", "subagent", "ralph"].includes(namespace)) return "sitemap";
	return namespace === "todo" ? "list" : undefined;
}

function resolveActionIcon(terms: readonly string[]): IconKind | undefined {
	if (hasAnyTerm(terms, QUESTION_TERMS)) return "question";
	if (hasAnyTerm(terms, SEARCH_TERMS)) return "search";
	return hasAnyTerm(terms, EXECUTION_TERMS) ? "terminal" : undefined;
}

function hasAnyTerm(
	terms: readonly string[],
	candidates: ReadonlySet<string>,
): boolean {
	return terms.some((term) => candidates.has(term));
}

function normalizeToolName(toolName: string): string {
	return toolName
		.replace(/([a-z\d])([A-Z])/gu, "$1_$2")
		.replace(/[^a-zA-Z\d]+/gu, "_")
		.replace(/^_+|_+$/gu, "")
		.toLowerCase();
}
