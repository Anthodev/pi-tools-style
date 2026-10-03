/**
 * Web-search presentation: pure recognition, structural extraction and the
 * dedicated web view.
 *
 * Recognition is deliberately conservative — a configured exposure, the
 * Pi-native `web_search`, or a confirmed native-MCP tool that proves web-search
 * identity through its namespace or its result details. Structured extraction
 * trusts only the documented OMP response shape; anything else keeps the raw
 * response. Nothing here executes a tool, talks to a provider or reads a file.
 */
import { getMarkdownTheme, type Theme, type ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	Text,
	getCapabilities,
	hyperlink,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";

import {
	extractToolText,
	invalidateToolViewCache,
	normalizeDisplayText,
	reuseToolSection,
	type ToolResult,
	type ToolSection,
	type ToolSnapshot,
	type ToolView,
} from "./tool-presentation.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Shown while a streamed argument has not arrived yet. */
const PENDING = "…";
/** Shown in place of a target whose value was streamed but is not the expected string. */
const INVALID_ARG = "[invalid arg]";
const COLLAPSED_ARGS_CHARS = 100;
/** Collapsed source rows before the `… N more sources` hint. */
const COLLAPSED_SOURCES = 8;
/** Unstructured response lines kept before expansion. */
const UNSTRUCTURED_PREVIEW_LINES = 6;
const TREE_BRANCH = "├─";
const TREE_LAST = "└─";
const SEPARATOR = " · ";
/** C0, C1 and DEL are rejected before a URL may become a hyperlink target. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;

/** Pi tools that own their renderer; they are never the web exception. */
const RESERVED_TOOL_NAMES: Readonly<Record<string, true>> = {
	bash: true,
	powershell: true,
	read: true,
	edit: true,
	write: true,
	find: true,
	grep: true,
	ls: true,
	tool_search: true,
	codemode: true,
	list_mcp_resources: true,
	list_mcp_resource_templates: true,
	read_mcp_resource: true,
};

/** OMP `SEARCH_PROVIDER_LABELS` (tag 18.8.6) — unknown ids fall back to the raw id. */
const SEARCH_PROVIDER_LABELS: Readonly<Record<string, string>> = {
	parallel: "Parallel",
	perplexity: "Perplexity",
	gemini: "Gemini",
	anthropic: "Anthropic",
	codex: "OpenAI Codex",
	openai: "OpenAI API",
	xai: "xAI",
	openrouter: "OpenRouter",
	zai: "Z.AI",
	exa: "Exa",
	tinyfish: "TinyFish",
	jina: "Jina",
	kagi: "Kagi",
	tavily: "Tavily",
	firecrawl: "Firecrawl",
	brave: "Brave",
	kimi: "Kimi",
	synthetic: "Synthetic",
	ollama: "Ollama",
	searxng: "SearXNG",
	startpage: "Startpage",
	duckduckgo: "DuckDuckGo",
	ecosia: "Ecosia",
	google: "Google",
	mojeek: "Mojeek",
	public: "Public Web",
};

/* -------------------------------------------------------------------------- */
/* Extracted response shape                                                   */
/* -------------------------------------------------------------------------- */

export interface WebSource {
	url: string;
	title?: string;
	publishedDate?: string;
	ageSeconds?: number;
}

export interface WebUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	searchRequests?: number;
}

export interface WebResponse {
	provider: string;
	sources: readonly WebSource[];
	answer?: string;
	searchQueries?: readonly string[];
	model?: string;
	authMode?: string;
	usage?: WebUsage;
}

export interface WebResponseData {
	response: WebResponse;
	/** True when the response came from the single complete-text JSON fallback, not from `details`. */
	fromContent: boolean;
	/** Validated non-empty OMP error; only ever set when the response itself is validated. */
	error?: string;
}

/* -------------------------------------------------------------------------- */
/* Recognition                                                                */
/* -------------------------------------------------------------------------- */

function isConfirmedMcp(toolInfo: ToolInfo | undefined): boolean {
	const sourceInfo = toolInfo?.sourceInfo;
	return sourceInfo?.source === "builtin" && sourceInfo.path === "builtin:mcp";
}

/**
 * Whether a tool call is the web-search exception.
 *
 * Order matters: reserved Pi tools are refused even when they are configured by
 * mistake, an exact configured exposure is an explicit user declaration, the
 * Pi-native `web_search` is recognised on its own, and a native MCP tool only
 * qualifies with real identity evidence. Names are never split, hashed names are
 * never guessed and no `search` substring matches.
 */
export function isWebSearchTool(
	toolName: string,
	toolInfo: ToolInfo | undefined,
	details: unknown,
	configuredNames: readonly string[],
): boolean {
	if (Object.hasOwn(RESERVED_TOOL_NAMES, toolName)) {
		return false;
	}
	if (configuredNames.includes(toolName)) {
		return true;
	}
	if (toolName === "web_search") {
		return true;
	}
	if (!isConfirmedMcp(toolInfo)) {
		return false;
	}
	const namespace = toolInfo?.namespace?.name;
	if (typeof namespace === "string" && namespace.length > 0 && toolName === `${namespace}__web_search`) {
		return true;
	}
	const record = asRecord(details);
	return record?.tool === "web_search" && typeof record.server === "string" && record.server.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

interface ContentBlockLike {
	type?: string;
	text?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			strings.push(entry);
		}
	}
	return strings;
}

function readSource(value: unknown): WebSource | undefined {
	const record = asRecord(value);
	if (!record || typeof record.url !== "string") {
		return undefined;
	}
	const source: WebSource = { url: record.url };
	if (typeof record.title === "string") {
		source.title = record.title;
	}
	if (typeof record.publishedDate === "string") {
		source.publishedDate = record.publishedDate;
	}
	const ageSeconds = finiteNonNegative(record.ageSeconds);
	if (ageSeconds !== undefined) {
		source.ageSeconds = ageSeconds;
	}
	return source;
}

function readUsage(value: unknown): WebUsage | undefined {
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	const inputTokens = finiteNonNegative(record.inputTokens);
	const outputTokens = finiteNonNegative(record.outputTokens);
	const totalTokens = finiteNonNegative(record.totalTokens);
	const searchRequests = finiteNonNegative(record.searchRequests);
	if (
		inputTokens === undefined &&
		outputTokens === undefined &&
		totalTokens === undefined &&
		searchRequests === undefined
	) {
		return undefined;
	}
	return {
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(searchRequests !== undefined ? { searchRequests } : {}),
	};
}

/**
 * Validate one candidate object as a `WebResponse`. A single malformed source
 * invalidates the whole response so a broken array is never partially trusted.
 */
function readWebResponseObject(value: unknown): WebResponse | undefined {
	const record = asRecord(value);
	if (!record || typeof record.provider !== "string" || !Array.isArray(record.sources)) {
		return undefined;
	}
	const sources: WebSource[] = [];
	for (const entry of record.sources) {
		const source = readSource(entry);
		if (!source) {
			return undefined;
		}
		sources.push(source);
	}
	const response: WebResponse = { provider: record.provider, sources };
	if (typeof record.answer === "string") {
		response.answer = record.answer;
	}
	const searchQueries = readStringArray(record.searchQueries);
	if (searchQueries !== undefined) {
		response.searchQueries = searchQueries;
	}
	if (typeof record.model === "string") {
		response.model = record.model;
	}
	if (typeof record.authMode === "string") {
		response.authMode = record.authMode;
	}
	const usage = readUsage(record.usage);
	if (usage !== undefined) {
		response.usage = usage;
	}
	return response;
}

function withValidatedResponse(response: WebResponse, fromContent: boolean, error: unknown): WebResponseData {
	const message = readNonEmptyString(error);
	return message === undefined
		? { response, fromContent }
		: { response, fromContent, error: message };
}

/** Single complete-text JSON fallback; refuses truncated output and anything but one text block. */
function readWebResponseFromContent(
	result: ToolResult,
	details: Record<string, unknown> | undefined,
): WebResponseData | undefined {
	const blocks = (result.content ?? []) as readonly ContentBlockLike[];
	const textBlocks = blocks.filter((block) => block.type === "text" && typeof block.text === "string");
	if (textBlocks.length !== 1) {
		return undefined;
	}
	const raw = textBlocks[0]?.text;
	if (raw === undefined) {
		return undefined;
	}
	if (readNonEmptyString(details?.fullOutputPath) !== undefined) {
		return undefined;
	}
	if (raw.trimStart().startsWith("Warning: truncated output")) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const record = asRecord(parsed);
	if (!record) {
		return undefined;
	}
	const nested = readWebResponseObject(record.response);
	if (nested) {
		return withValidatedResponse(nested, true, record.error);
	}
	const root = readWebResponseObject(record);
	return root ? { response: root, fromContent: true } : undefined;
}

/**
 * Extract the documented OMP response, or `undefined` to keep the raw result.
 *
 * `details.response` wins; the complete-text JSON fallback only applies to a
 * single untruncated text block and never strips fences, searches substrings or
 * accepts aliases such as `results`/`data`/`items`.
 */
export function readWebResponse(result: ToolResult): WebResponseData | undefined {
	const details = asRecord(result.details);
	const structured = readWebResponseObject(details?.response);
	if (structured) {
		return withValidatedResponse(structured, false, details?.error);
	}
	return readWebResponseFromContent(result, details);
}

/* -------------------------------------------------------------------------- */
/* Display helpers                                                            */
/* -------------------------------------------------------------------------- */

function searchProviderLabel(provider: string): string {
	if (provider === "none") {
		return "None";
	}
	// `Object.hasOwn` keeps inherited keys such as `constructor`/`__proto__` from
	// ever surfacing as a label; the raw provider id stays the fallback.
	const label = Object.hasOwn(SEARCH_PROVIDER_LABELS, provider) ? SEARCH_PROVIDER_LABELS[provider] : undefined;
	return typeof label === "string" ? label : normalizeDisplayText(provider);
}

function authShort(authMode: string | undefined): string | undefined {
	if (authMode === undefined || authMode.length === 0) {
		return undefined;
	}
	if (authMode === "oauth") {
		return "OAuth";
	}
	if (authMode === "api_key") {
		return "API";
	}
	return normalizeDisplayText(authMode);
}

/** Age in whole seconds/minutes/hours/days (ON product choice; no week/month tiers). */
function formatAge(ageSeconds: number): string {
	const seconds = Math.floor(ageSeconds);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	if (seconds < 3600) {
		return `${Math.floor(seconds / 60)}m`;
	}
	if (seconds < 86400) {
		return `${Math.floor(seconds / 3600)}h`;
	}
	return `${Math.floor(seconds / 86400)}d`;
}

/** Canonical `http:`/`https:` href, or `undefined` when the URL must not be clickable. */
function canonicalHttpHref(url: string): string | undefined {
	if (url.length === 0 || CONTROL_CHARS.test(url)) {
		return undefined;
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return undefined;
	}
	return parsed.href;
}

function hyperlinkSource(url: string, styledText: string): string {
	const href = canonicalHttpHref(url);
	if (href === undefined || !getCapabilities().hyperlinks) {
		return styledText;
	}
	try {
		return hyperlink(styledText, href);
	} catch {
		return styledText;
	}
}

function sourceTitle(source: WebSource): string {
	const title = source.title !== undefined ? normalizeDisplayText(source.title).trim() : "";
	if (title.length > 0) {
		return title;
	}
	const url = normalizeDisplayText(source.url).trim();
	return url.length > 0 ? url : "Untitled";
}

function sourceDomain(url: string): string | undefined {
	const href = canonicalHttpHref(url);
	if (href === undefined) {
		return undefined;
	}
	try {
		const hostname = new URL(href).hostname.replace(/^www\./u, "");
		return hostname.length > 0 ? hostname : undefined;
	} catch {
		return undefined;
	}
}

function sourceMeta(source: WebSource): string {
	const parts: string[] = [];
	const domain = sourceDomain(source.url);
	if (domain !== undefined) {
		parts.push(domain);
	}
	let trailing: string | undefined;
	if (source.ageSeconds !== undefined) {
		trailing = formatAge(source.ageSeconds);
	} else if (source.publishedDate !== undefined) {
		const published = normalizeDisplayText(source.publishedDate).trim();
		if (published.length > 0) {
			trailing = published;
		}
	}
	if (trailing !== undefined) {
		parts.push(trailing);
	}
	return parts.join(SEPARATOR);
}

function usageParts(usage: WebUsage): string[] {
	const parts: string[] = [];
	if (usage.inputTokens !== undefined) {
		parts.push(`in ${usage.inputTokens}`);
	}
	if (usage.outputTokens !== undefined) {
		parts.push(`out ${usage.outputTokens}`);
	}
	if (usage.totalTokens !== undefined) {
		parts.push(`total ${usage.totalTokens}`);
	}
	if (usage.searchRequests !== undefined) {
		parts.push(`search ${usage.searchRequests}`);
	}
	return parts;
}

function firstNonEmpty(values: readonly string[] | undefined): string | undefined {
	if (values === undefined) {
		return undefined;
	}
	for (const value of values) {
		const normalized = normalizeDisplayText(value).trim();
		if (normalized.length > 0) {
			return normalized;
		}
	}
	return undefined;
}

/* -------------------------------------------------------------------------- */
/* View primitives                                                            */
/* -------------------------------------------------------------------------- */

function resolveStatus(snapshot: ToolSnapshot): ToolView["head"]["status"] {
	const { result, context } = snapshot;
	if (result && !context.isPartial) {
		return context.isError ? "error" : "done";
	}
	// Streaming is only running once there is something to stream: a partial
	// revision without a result (streamed args, no execution) stays pending.
	if (context.executionStarted || (result !== undefined && context.isPartial)) {
		return "running";
	}
	return "pending";
}

function makeHead(title: string, target: string, meta: readonly string[], snapshot: ToolSnapshot): ToolView["head"] {
	const duration = snapshot.context.durationMs;
	const durationMs = duration !== undefined && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
	return {
		title,
		// Newlines stay: the frame shows the first line in the header and moves the
		// full target into its own section when the view is expanded.
		target: normalizeDisplayText(target),
		meta: meta.map((entry) => normalizeDisplayText(entry).replace(/\n/g, " ")),
		status: resolveStatus(snapshot),
		...(durationMs !== undefined ? { durationMs } : {}),
	};
}

function componentSection(
	component: Component,
	slot: "call" | "result",
	preview: boolean,
	label?: string,
	renderedWidth?: "padded",
): ToolSection {
	const section: ToolSection = { component, slot, preview };
	if (label !== undefined) {
		section.label = label;
	}
	if (renderedWidth !== undefined) {
		section.renderedWidth = renderedWidth;
	}
	return section;
}

function textSection(
	lines: readonly string[],
	slot: "call" | "result",
	preview: boolean,
	label?: string,
): ToolSection | undefined {
	if (lines.length === 0 || lines.every((line) => line.length === 0)) {
		return undefined;
	}
	return componentSection(new Text(lines.join("\n"), 0, 0), slot, preview, label, "padded");
}

function markdownComponent(text: string): Component {
	return new Markdown(text, 0, 0, getMarkdownTheme());
}

/**
 * Retains the prepared Markdown primary of one render state while the visible
 * source text, its label and the theme signature stay unchanged. The retained
 * preparation is one current section per state, so an ordinary revision that
 * changes nothing rebuilds nothing, and any real change rebuilds it.
 */
function markdownSection(
	state: object | undefined,
	theme: Theme,
	kind: string,
	label: string,
	preview: boolean,
	text: string,
): ToolSection | undefined {
	return reuseToolSection(state, theme, kind, [label, preview ? "preview" : "full", text], () =>
		componentSection(markdownComponent(text), "result", preview, label, "padded"),
	);
}

function sectionsOf(...candidates: readonly (ToolSection | undefined)[]): ToolSection[] {
	return candidates.filter((candidate): candidate is ToolSection => candidate !== undefined);
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function jsonText(value: unknown, pretty: boolean): string {
	if (pretty && typeof value === "string") {
		return value;
	}
	try {
		const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
		return text ?? String(value);
	} catch {
		return String(value);
	}
}

function argEntries(args: unknown): Array<[string, unknown]> {
	if (args === undefined || args === null) {
		return [];
	}
	if (typeof args === "object" && !Array.isArray(args)) {
		return Object.entries(args as Record<string, unknown>);
	}
	return [["args", args]];
}

function argumentsSection(args: unknown, expanded: boolean): ToolSection | undefined {
	const entries = argEntries(args);
	if (entries.length === 0) {
		return undefined;
	}
	const lines: string[] = [];
	if (expanded) {
		lines.push(...normalizeDisplayText(jsonText(args, true)).split("\n"));
	} else {
		const pairs = entries.map(([key, value]) => `${key}=${jsonText(value, false)}`).join(" ");
		const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
		lines.push(normalizeDisplayText(preview));
	}
	return textSection(lines, "call", true, "Arguments");
}

/** Drop the arguments already shown in the head so the query is never repeated. */
function remainingArgs(args: unknown, consumed: readonly string[]): unknown {
	if (consumed.length === 0) {
		return args;
	}
	const record = asRecord(args);
	if (!record) {
		return args;
	}
	return Object.fromEntries(Object.entries(record).filter(([key]) => !consumed.includes(key)));
}

/* -------------------------------------------------------------------------- */
/* Source rows                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Width-aware source list: `8` rows collapsed (plus a `… N more sources` hint)
 * and every row expanded. Renders once per width and stays within the child
 * width unless a title budget floor or an oversized meta forces a frame wrap.
 */
class SourcesComponent implements Component {
	private readonly sources: readonly WebSource[];
	private readonly theme: Theme;
	private readonly expanded: boolean;

	constructor(sources: readonly WebSource[], theme: Theme, expanded: boolean) {
		this.sources = sources;
		this.theme = theme;
		this.expanded = expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const available = Math.max(0, width);
		const visible = this.expanded ? this.sources.length : Math.min(this.sources.length, COLLAPSED_SOURCES);
		const hidden = this.sources.length - visible;
		const lines: string[] = [];
		for (let index = 0; index < visible; index++) {
			const source = this.sources[index];
			if (!source) {
				continue;
			}
			const last = hidden === 0 && index === visible - 1;
			lines.push(this.sourceLine(source, last, available));
		}
		if (hidden > 0) {
			lines.push(this.theme.fg("muted", truncateToWidth(`… ${hidden} more sources`, available, "…")));
		}
		return lines;
	}

	/**
	 * One source stays on one line: the tree prefix is reserved first, then a
	 * readable title budget, and the meta suffix gets whatever is left — a suffix
	 * too wide for the remainder is truncated instead of wrapping the row.
	 */
	private sourceLine(source: WebSource, last: boolean, width: number): string {
		const prefix = `${last ? TREE_LAST : TREE_BRANCH} `;
		const available = Math.max(0, width - visibleWidth(prefix));
		const meta = sourceMeta(source);
		const suffix = meta.length > 0 ? `${SEPARATOR}${meta}` : "";
		const titleBudget = Math.min(available, Math.max(12, available - visibleWidth(suffix)));
		const suffixBudget = available - titleBudget;
		const titleText = truncateToWidth(sourceTitle(source), titleBudget, "…");
		const suffixText = suffix.length > 0 && suffixBudget > 0 ? truncateToWidth(suffix, suffixBudget, "…") : "";
		const styledTitle = this.theme.fg("accent", titleText);
		const linkedTitle = hyperlinkSource(source.url, styledTitle);
		const styledSuffix = suffixText.length > 0 ? this.theme.fg("muted", suffixText) : "";
		return `${prefix}${linkedTitle}${styledSuffix}`;
	}
}

/* -------------------------------------------------------------------------- */
/* View                                                                       */
/* -------------------------------------------------------------------------- */

function readWarnings(details: Record<string, unknown> | undefined): string[] | undefined {
	const warnings = readStringArray(details?.warnings);
	if (warnings === undefined) {
		return undefined;
	}
	const lines = warnings.map((warning) => normalizeDisplayText(warning).trim()).filter((line) => line.length > 0);
	return lines.length > 0 ? lines : undefined;
}

function queryFromArgs(args: Record<string, unknown> | undefined): string | undefined {
	const value = args?.query;
	if (value === undefined || value === null) {
		return undefined;
	}
	return typeof value === "string" ? value : INVALID_ARG;
}

/**
 * The response-provided search query, rendered as its own result section only
 * when the call carried no query of its own; the head then stays the single
 * place a query is shown.
 */
function fallbackQuerySection(response: WebResponse, hasQueryArg: boolean): ToolSection | undefined {
	if (hasQueryArg) {
		return undefined;
	}
	const fallback = firstNonEmpty(response.searchQueries);
	return fallback !== undefined ? textSection([fallback], "result", false, "Query") : undefined;
}

/** The real error text, plus whether it came from the structured OMP error field. */
function errorMessage(snapshot: ToolSnapshot, data: WebResponseData | undefined): { text: string; structured: boolean } {
	const errorText = data?.error !== undefined ? normalizeDisplayText(data.error).trim() : "";
	if (errorText.length > 0) {
		return { text: errorText, structured: true };
	}
	return { text: extractToolText(snapshot.result, snapshot.context.showImages).trim(), structured: false };
}

/**
 * Image placeholders the terminal cannot draw. Derived from the content blocks
 * on a copy so the stored result is never mutated, and skipped when a result
 * section already renders the shared extraction of the whole result.
 */
function imageFallbackLines(snapshot: ToolSnapshot): string[] {
	const result = snapshot.result;
	if (!result || (getCapabilities().images && snapshot.context.showImages)) {
		return [];
	}
	const images = (result.content ?? []).filter((block) => block.type === "image");
	if (images.length === 0) {
		return [];
	}
	const text = extractToolText({ ...result, content: images }, false).trim();
	return text.length > 0 ? text.split("\n") : [];
}

/** Build the semantic view for one render revision of a recognised web tool. */
export function createWebSearchView(toolName: string, snapshot: ToolSnapshot, theme: Theme): ToolView {
	const args = asRecord(snapshot.args ?? snapshot.context.args);
	const query = queryFromArgs(args);
	// Only a real string argument counts as a provided query: the invalid marker is
	// a display placeholder, so a literal "[invalid arg]" query is still the query.
	const hasQueryArg = typeof args?.query === "string";
	const consumedArgs = remainingArgs(args, hasQueryArg ? ["query"] : []);
	const details = asRecord(snapshot.result?.details);
	const data = snapshot.result ? readWebResponse(snapshot.result) : undefined;

	// Before a result: inline call card, the query once, the rest of the args kept.
	if (!snapshot.result) {
		return {
			layout: "inline",
			head: makeHead("Web Search", query ?? PENDING, [], snapshot),
			sections: sectionsOf(argumentsSection(consumedArgs, snapshot.context.expanded)),
			expanded: snapshot.context.expanded,
		};
	}

	const isError = snapshot.context.isError;
	const argumentsBlock = argumentsSection(consumedArgs, snapshot.context.expanded);
	const warningsLines = readWarnings(details);
	const warningsBlock =
		warningsLines !== undefined ? textSection(warningsLines, "result", false, "Warnings") : undefined;
	const fullOutputPath = details?.fullOutputPath;
	const fullOutput = typeof fullOutputPath === "string" && fullOutputPath.length > 0 ? fullOutputPath : undefined;
	const fullOutputBlock =
		fullOutput !== undefined
			? textSection([theme.fg("muted", `Full output: ${normalizeDisplayText(fullOutput)}`)], "result", false)
			: undefined;

	// An error owns its own message; success results are never invented next to it.
	if (isError || data?.error !== undefined) {
		const { text: message, structured } = errorMessage(snapshot, data);
		const providerLabel = data !== undefined && data.response.provider !== "none" ? searchProviderLabel(data.response.provider) : undefined;
		const meta = providerLabel !== undefined && providerLabel.length > 0 ? [providerLabel] : [];
		// Styling an empty message would emit an ANSI-only row that defeats the
		// section guard, so the section exists only for real message text.
		// A validated response keeps its whole error message, whatever the text
		// provenance. Only a raw, unstructured error (no validated response at all)
		// is just response text, so it takes the same head preview as any
		// unstructured response: the collapsed card shows six visual lines and the
		// shared hint expands the rest.
		const clampMessage = data === undefined && message.length > 0;
		const errorBlock =
			message.length > 0
				? textSection(message.split("\n").map((line) => theme.fg("error", line)), "result", clampMessage, "Error")
				: undefined;
		// A structured error message replaces the whole-result extraction, so the
		// hidden image placeholders it would have carried are rendered separately;
		// a text-derived message already contains them and is never doubled.
		const imageBlock = structured ? textSection(imageFallbackLines(snapshot), "result", false) : undefined;
		// A validated response may still carry the real fallback query; it is data,
		// not invented success, and stays the only query when the call had none.
		const queryBlock = data !== undefined ? fallbackQuerySection(data.response, hasQueryArg) : undefined;
		const view: ToolView = {
			layout: "framed",
			head: makeHead("Web Search", query ?? "", meta, snapshot),
			sections: sectionsOf(argumentsBlock, queryBlock, errorBlock, imageBlock, warningsBlock, fullOutputBlock),
			tone: "error",
			expanded: snapshot.context.expanded,
		};
		if (clampMessage) {
			view.preview = { edge: "head", count: UNSTRUCTURED_PREVIEW_LINES, unit: "visual-lines" };
		}
		return view;
	}

	// Unstructured response: real query, real text, no invented count/provider.
	if (!data) {
		const text = extractToolText(snapshot.result, snapshot.context.showImages).trim();
		const lines = text.length > 0 ? text.split("\n") : [];
		const view: ToolView = {
			layout: "framed",
			head: makeHead("Web Search", query ?? "", [], snapshot),
			sections: sectionsOf(
				argumentsBlock,
				lines.length > 0
					? markdownSection(
							snapshot.context.state,
							theme,
							"web-response",
							isError ? "Error" : "Response",
							true,
							lines.join("\n"),
						)
					: undefined,
				warningsBlock,
				fullOutputBlock,
			),
			preview: { edge: "head", count: UNSTRUCTURED_PREVIEW_LINES, unit: "visual-lines" },
			expanded: snapshot.context.expanded,
		};
		if (isError) {
			view.tone = "error";
		}
		return view;
	}

	// Structured response.
	const response = data.response;
	const providerLabel = searchProviderLabel(response.provider);
	const meta = providerLabel.length > 0 ? [providerLabel] : [];

	const sections: ToolSection[] = [];
	if (argumentsBlock) {
		sections.push(argumentsBlock);
	}

	// The args query stays in the head; only a result-provided fallback becomes a result section.
	const queryBlock = fallbackQuerySection(response, hasQueryArg);
	if (queryBlock) {
		sections.push(queryBlock);
	}

	const answer = readNonEmptyString(response.answer);
	let contentRendered = false;
	if (answer !== undefined) {
		const answerSection = markdownSection(
			snapshot.context.state,
			theme,
			"web-answer",
			"Answer",
			false,
			normalizeDisplayText(answer),
		);
		if (answerSection) {
			sections.push(answerSection);
		}
	} else if (!data.fromContent) {
		const real = extractToolText(snapshot.result, snapshot.context.showImages).trim();
		if (real.length > 0) {
			const answerSection = markdownSection(snapshot.context.state, theme, "web-answer", "Answer", false, real);
			if (answerSection) {
				sections.push(answerSection);
				contentRendered = true;
			}
		}
	}
	if (!contentRendered) {
		const imageBlock = textSection(imageFallbackLines(snapshot), "result", false);
		if (imageBlock) {
			sections.push(imageBlock);
		}
	}

	const sources = response.sources;
	if (sources.length > 0) {
		sections.push(
			componentSection(new SourcesComponent(sources, theme, snapshot.context.expanded), "result", false, `Sources${SEPARATOR}${sources.length}`),
		);
	} else {
		const notice = textSection([theme.fg("muted", "No sources returned")], "result", false, `Sources${SEPARATOR}0`);
		if (notice) {
			sections.push(notice);
		}
	}

	if (warningsBlock) {
		sections.push(warningsBlock);
	}

	const metadataLines: string[] = [];
	const model = response.model !== undefined && response.model.length > 0 ? normalizeDisplayText(response.model) : undefined;
	const providerInfo = model !== undefined ? `${model} @ ${providerLabel}` : providerLabel;
	const auth = authShort(response.authMode);
	metadataLines.push(theme.fg("muted", `Provider: ${providerInfo}${auth !== undefined ? ` (${auth})` : ""}`));
	const usage = response.usage !== undefined ? usageParts(response.usage) : [];
	if (usage.length > 0) {
		metadataLines.push(theme.fg("muted", `Usage: ${usage.join(SEPARATOR)}`));
	}
	sections.push(componentSection(new Text(metadataLines.join("\n"), 0, 0), "result", false, "Metadata", "padded"));

	if (fullOutputBlock) {
		sections.push(fullOutputBlock);
	}

	const view: ToolView = {
		layout: "framed",
		head: makeHead("Web Search", query ?? "", meta, snapshot),
		sections,
		expanded: snapshot.context.expanded,
	};
	if (sources.length === 0) {
		view.tone = "warning";
	}
	return view;
}

/**
 * Drops the retained web-search preparation of one render state, so the next
 * revision rebuilds its Markdown even when the answer text and the theme are
 * unchanged. Wired to the runtime root/environment invalidation.
 */
export function invalidateWebSearchViewCache(state: object): void {
	invalidateToolViewCache(state);
}
