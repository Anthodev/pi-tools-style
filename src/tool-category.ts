import type { Theme } from "@earendil-works/pi-coding-agent";

export type ToolCategory =
	| "execute"
	| "external"
	| "inspect"
	| "interact"
	| "mutate"
	| "orchestrate"
	| "other";

type ThemeProvider = () => Theme;

const THEME_PROVIDER_KEY = Symbol.for("pi-tools-style:theme-provider");

const EXTERNAL_NAMESPACES = new Set([
	"api",
	"browser",
	"fetch",
	"github",
	"http",
	"jira",
	"linear",
	"mcp",
	"slack",
	"source",
	"web",
]);
const ORCHESTRATION_NAMES = new Set([
	"manage_todo_list",
	"ralph_done",
	"ralph_start",
	"subagent",
	"subagent_supervisor",
	"subagent_wait",
	"todo",
	"workflow",
	"workflow_control",
]);
const INTERACTION_TERMS = new Set([
	"ask",
	"confirm",
	"prompt",
	"question",
	"questionnaire",
	"select",
]);
const EXECUTION_TERMS = new Set([
	"bash",
	"build",
	"command",
	"exec",
	"execute",
	"run",
	"shell",
	"terminal",
	"test",
]);
const MUTATION_TERMS = new Set([
	"add",
	"apply",
	"create",
	"delete",
	"edit",
	"mark",
	"patch",
	"remove",
	"replace",
	"set",
	"undo",
	"update",
	"write",
]);
const INSPECTION_TERMS = new Set([
	"diagnostics",
	"find",
	"get",
	"grep",
	"inspect",
	"lens",
	"list",
	"lsp",
	"query",
	"read",
	"report",
	"resolve",
	"search",
	"show",
	"status",
	"symbol",
]);

export function classifyTool(toolName: string): ToolCategory {
	const normalized = normalizeToolName(toolName);
	const terms = normalized.split("_").filter(Boolean);
	const namespace = terms[0] ?? "";

	if (EXTERNAL_NAMESPACES.has(namespace)) return "external";
	if (ORCHESTRATION_NAMES.has(normalized)) return "orchestrate";
	if (terms.some((term) => INTERACTION_TERMS.has(term))) return "interact";
	if (terms.some((term) => EXECUTION_TERMS.has(term))) return "execute";
	if (terms.some((term) => MUTATION_TERMS.has(term))) return "mutate";
	if (terms.some((term) => INSPECTION_TERMS.has(term))) return "inspect";
	return "other";
}

export function setThemeProvider(provider: ThemeProvider | undefined): void {
	if (provider) {
		Reflect.set(globalThis, THEME_PROVIDER_KEY, provider);
		return;
	}
	Reflect.deleteProperty(globalThis, THEME_PROVIDER_KEY);
}

/** Current public session theme; shell falls back to native until a provider is bound. */
export function getToolTheme(): Theme | undefined {
	const provider = Reflect.get(globalThis, THEME_PROVIDER_KEY) as
		| ThemeProvider
		| undefined;
	if (!provider) return undefined;

	try {
		return provider();
	} catch {
		return undefined;
	}
}

function normalizeToolName(toolName: string): string {
	return toolName
		.replace(/([a-z\d])([A-Z])/gu, "$1_$2")
		.replace(/[^a-zA-Z\d]+/gu, "_")
		.replace(/^_+|_+$/gu, "")
		.toLowerCase();
}

