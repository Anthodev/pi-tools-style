/**
 * Semantic presentation for tool calls and results.
 *
 * A producer turns one render revision into a {@link ToolView}: a plain-text head
 * (title, target, metas, status, duration) plus semantic sections that carry real
 * content. The frame layout owns clamping, hidden-count hints, duration formatting
 * and styling, so nothing here pre-truncates or pre-styles a head field.
 *
 * Untrusted display text is normalized for the terminal only. Stored args and
 * results are never rewritten.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getLanguageFromPath,
	getMarkdownTheme,
	highlightCode,
	renderDiff,
	type Theme,
	type ToolInfo,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	Text,
	getCapabilities,
	getImageDimensions,
	hyperlink,
	imageFallback,
	stripTerminalSequences,
	type Component,
} from "@earendil-works/pi-tui";
import { getIconMode } from "./settings.js";

export type ToolStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface ToolHead {
	title: string;
	target: string;
	meta: readonly string[];
	status: ToolStatus;
	durationMs?: number;
}

export interface ToolPreview {
	edge: "head" | "tail";
	count: number;
	unit: "visual-lines" | "entries";
}

export interface ToolSection {
	label?: string;
	component: Component;
	slot: "call" | "result";
	preview?: boolean;
	previewPolicy?: ToolPreview;
	/**
	 * Set when the component's rows are already wrapped and padded for `render(width)`,
	 * so layout can skip its defensive wrap. Owned SDK `Text`/`Markdown` sections set it;
	 * entry lists, custom and interactive components leave it unset.
	 */
	renderedWidth?: "padded";
}

export interface ToolView {
	layout: "framed" | "inline";
	head: ToolHead;
	sections: readonly ToolSection[];
	preview?: ToolPreview;
	tone?: "warning" | "error";
	expanded: boolean;
}

export type ToolContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
export type ToolResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];

export interface ToolSnapshot {
	args: unknown;
	result?: ToolResult;
	context: ToolContext;
	toolInfo?: ToolInfo;
	presentation: "builtin" | "mcp" | "mcp-unresolved" | "web" | "execution" | "generic";
}

export type ToolViewFactory = (toolName: string, snapshot: ToolSnapshot, theme: Theme) => ToolView;

/** Execution ownership follows the exact requested name, independent of provenance. */
export function isExecutionToolName(toolName: string): boolean {
	return toolName === "codemode" || toolName.startsWith("ctx_execute");
}

/** Shown in place of a target whose value was streamed but is not the expected string. */
const INVALID_ARG = "[invalid arg]";
/** Marker for a streamed argument of the wrong type, so a valid string can still be that exact text. */
const WRONG_TYPE = Symbol("pi-tools-style:wrong-type-arg");
/** A streamed argument value: the string, absent, or present with a non-string type. */
type ArgValue = string | typeof WRONG_TYPE | undefined;
/** Shown while a streamed argument has not arrived yet. */
const PENDING = "…";

const MCP_RESOURCE_TITLES: Record<string, string> = {
	list_mcp_resources: "MCP Resources",
	list_mcp_resource_templates: "MCP Resource Templates",
	read_mcp_resource: "MCP Resource",
};


/* -------------------------------------------------------------------------- */
/* Display-text normalization                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Normalize untrusted text for terminal display:
 * - terminal escape sequences are removed;
 * - `\r` is dropped, tabs become three spaces, newlines and printable Unicode stay;
 * - remaining C0 controls become their Control Pictures glyph, DEL becomes `␡`
 *   and C1 controls become a literal `\xNN`.
 *
 * Applied only to displayed values; stored arguments and results are never mutated.
 */
export function normalizeDisplayText(value: string): string {
	if (value.length === 0) {
		return value;
	}
	const stripped = stripTerminalSequences(value);
	const withoutCarriageReturns = stripped.replace(/\r/g, "");
	const spaced = withoutCarriageReturns.replace(/\t/g, "   ");
	if (!/[\u0000-\u001f\u007f-\u009f\ufdd0-\ufdef\ufff9-\ufffb]/.test(spaced)) {
		return spaced;
	}
	let result = "";
	for (const char of spaced) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 0x0a) {
			result += char;
		} else if (code < 0x20) {
			result += String.fromCodePoint(0x2400 + code);
		} else if (code === 0x7f) {
			result += "\u2421";
		} else if (code >= 0x80 && code <= 0x9f) {
			result += `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
		} else if (code >= 0xfdd0 && code <= 0xfdef) {
			// Noncharacters have no printable form, so they are dropped.
		} else if (code >= 0xfff9 && code <= 0xfffb) {
			// Interlinear annotation controls carry no displayable text.
		} else {
			result += char;
		}
	}
	return result;
}

/* -------------------------------------------------------------------------- */
/* Path resolution and linking                                                */
/* -------------------------------------------------------------------------- */

/** Convert Git Bash, MSYS, Cygwin and WSL drive paths to native Windows form. */
function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
		return filePath;
	}
	const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(filePath);
	if (!match) {
		return filePath;
	}
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${(match[1] ?? "").toUpperCase()}:\\${suffix ?? ""}`;
}

function normalizeDisplayPathPart(value: string): string {
	let normalized = process.platform === "win32" ? normalizeWindowsShellPath(value) : value;
	if (normalized === "~") {
		return homedir();
	}
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return join(homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) {
		// A malformed URL or a non-local host must fail here so `linkPath` keeps the
		// plain text instead of fabricating a cwd-relative file link.
		return fileURLToPath(normalized);
	}
	return normalized;
}

/**
 * Pure display counterpart of the host tool's path resolution: no trim, no
 * unicode-space folding, no filesystem access. Windows shell drive paths are
 * converted before tilde expansion, `file://` URLs are decoded, and the result is
 * resolved against `cwd` when relative.
 */
export function resolveDisplayPath(input: string, cwd: string): string {
	const normalized = normalizeDisplayPathPart(input);
	const normalizedCwd = normalizeDisplayPathPart(cwd);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedCwd, normalized);
}

/** Link a styled path to its resolved `file://` URL when the terminal supports links. */
function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!rawPath) {
		return styledText;
	}
	try {
		if (!getCapabilities().hyperlinks) {
			return styledText;
		}
		return hyperlink(styledText, pathToFileURL(resolveDisplayPath(rawPath, cwd)).href);
	} catch {
		return styledText;
	}
}


/* -------------------------------------------------------------------------- */
/* Result text extraction                                                     */
/* -------------------------------------------------------------------------- */

interface ContentBlock {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/**
 * Shared text extraction for a tool result: text blocks are normalized and joined
 * with newlines; image blocks become a text fallback when the terminal cannot show
 * them or images are hidden for this revision.
 */
export function extractToolText(result: ToolResult | undefined, showImages: boolean): string {
	if (!result) {
		return "";
	}
	const blocks = (result.content ?? []) as readonly ContentBlock[];
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text") {
			parts.push(normalizeDisplayText(block.text ?? ""));
		}
	}
	const images = blocks.filter((block) => block.type === "image");
	if (images.length > 0 && (!getCapabilities().images || !showImages)) {
		for (const image of images) {
			const mimeType = image.mimeType ?? "image/unknown";
			const dimensions =
				image.data && image.mimeType ? (getImageDimensions(image.data, image.mimeType) ?? undefined) : undefined;
			// The MIME comes from the tool, so only the generated display text is sanitized.
			parts.push(normalizeDisplayText(imageFallback(mimeType, dimensions)));
		}
	}
	return parts.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Head computation                                                           */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function argValue(args: Record<string, unknown> | undefined, key: string): ArgValue {
	const value = args?.[key];
	if (value === undefined) {
		return undefined;
	}
	return typeof value === "string" ? value : WRONG_TYPE;
}

function resolveStatus(snapshot: ToolSnapshot): ToolStatus {
	if (snapshot.result && !snapshot.context.isPartial) {
		return snapshot.context.isError ? "error" : "done";
	}
	if (snapshot.context.executionStarted || (snapshot.result !== undefined && snapshot.context.isPartial)) {
		return "running";
	}
	return "pending";
}

/**
 * Sanitize raw display text for a single-line field (meta entry, note or path
 * annotation). Styled strings must never be passed through here.
 */
function singleLineText(value: string): string {
	return normalizeDisplayText(value).replace(/\n/g, " ");
}

function makeHead(
	title: string,
	target: string,
	meta: readonly string[],
	snapshot: ToolSnapshot,
): ToolHead {
	const duration = snapshot.context.durationMs;
	const durationMs = duration !== undefined && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
	// Target and meta arrive normalized by their producer, so links and newlines
	// generated here survive for the layout to reveal and expand.
	return {
		title,
		target,
		meta,
		status: resolveStatus(snapshot),
		...(durationMs !== undefined ? { durationMs } : {}),
	};
}

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

function textComponent(lines: readonly string[]): Component {
	return new Text(lines.join("\n"), 0, 0);
}

/**
 * Component shape for entry lists that must be clamped per whole entry before
 * wrapping: the logical entries stay inspectable next to the rendered component.
 */
export interface EntryLinesComponent extends Component {
	readonly entryLines: readonly string[];
}

/**
 * Entry-list component that exposes its logical entries so the layout can select
 * whole entries before wrapping instead of cutting a wrapped entry in half.
 */
function entriesComponent(lines: readonly string[]): EntryLinesComponent {
	const text = new Text(lines.join("\n"), 0, 0);
	return {
		entryLines: [...lines],
		render: (width: number) => text.render(width),
		invalidate: () => text.invalidate(),
	};
}

function trimTrailingEmptyLines(lines: readonly string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

interface SectionOptions {
	label?: string;
	slot?: "call" | "result";
	preview?: boolean;
	previewPolicy?: ToolPreview;
}

function section(lines: readonly string[], options: SectionOptions = {}): ToolSection | undefined {
	if (lines.length === 0 || lines.every((line) => line.length === 0)) {
		return undefined;
	}
	const result: ToolSection = {
		component: textComponent(lines),
		slot: options.slot ?? "result",
		preview: options.preview ?? true,
		renderedWidth: "padded",
	};
	if (options.label !== undefined) {
		result.label = options.label;
	}
	if (options.previewPolicy !== undefined) {
		result.previewPolicy = options.previewPolicy;
	}
	return result;
}

function sectionsOf(...candidates: readonly (ToolSection | undefined)[]): ToolSection[] {
	return candidates.filter((candidate): candidate is ToolSection => candidate !== undefined);
}

const INPUT_PREVIEW: ToolPreview = { edge: "head", count: 10, unit: "visual-lines" };
const OUTPUT_PREVIEW: ToolPreview = { edge: "head", count: 5, unit: "visual-lines" };
const COMMAND_PREVIEW: ToolPreview = { edge: "head", count: 1, unit: "visual-lines" };
const WRITE_PREVIEW: ToolPreview = { edge: "head", count: 8, unit: "visual-lines" };

/** Explicit null/primitive arguments are delivered data, not a missing revision. */
function suppliedArgs(snapshot: ToolSnapshot): unknown {
	return snapshot.args === undefined ? snapshot.context.args : snapshot.args;
}

function argumentText(value: unknown, pretty = false): string {
	return normalizeDisplayText(typeof value === "number" && !Number.isFinite(value) ? String(value) : jsonText(value, pretty && typeof value !== "string"));
}

function stringInput(value: unknown): string {
	if (value === undefined) {
		return PENDING;
	}
	if (typeof value !== "string") {
		return `${INVALID_ARG} (${argumentText(value)})`;
	}
	const normalized = normalizeDisplayText(value);
	return normalized.trim().length === 0 ? argumentText(value) : normalized;
}

function inputField(key: string, value: unknown, theme: Theme, cwd: string, required = false): string {
	const label = normalizeDisplayText(key);
	const pathText = key === "path" && typeof value === "string" ? normalizeDisplayText(value) : undefined;
	if (pathText !== undefined && pathText.trim().length > 0) {
		// Display the full caller text, while resolving only the hyperlink destination.
		return `${label}: ${linkPath(theme.fg("accent", pathText), value as string, cwd)}`;
	}
	return `${label}: ${required || key === "path" || key === "pattern" || key === "glob" ? stringInput(value) : argumentText(value)}`;
}

/** Lightweight complete input beside an independently retained result primary. */
function nativeInputSection(
	snapshot: ToolSnapshot,
	theme: Theme,
	required: readonly string[],
	excluded: readonly string[] = [],
	preview = true,
): ToolSection {
	const value = suppliedArgs(snapshot);
	const args = asRecord(value);
	const lines: string[] = [];
	if (args) {
		for (const key of required) {
			lines.push(inputField(key, args[key], theme, snapshot.context.cwd, true));
		}
		const entries = Object.entries(args);
		for (const [key, entry] of entries) {
			if (!required.includes(key) && !excluded.includes(key)) {
				lines.push(inputField(key, entry, theme, snapshot.context.cwd));
			}
		}
		if (entries.length === 0) {
			lines.push("{}");
		}
	} else {
		lines.push(value === undefined ? PENDING : argumentText(value, true));
	}
	return section(lines, { label: "Input", slot: "call", preview, previewPolicy: INPUT_PREVIEW })!;
}

function fullArgumentsSection(args: unknown): ToolSection {
	const text = args === undefined ? PENDING : argumentText(args, true);
	return section(text.split("\n"), { label: "Input", slot: "call", previewPolicy: INPUT_PREVIEW })!;
}

/* -------------------------------------------------------------------------- */
/* Retained primaries                                                         */
/* -------------------------------------------------------------------------- */

type PrimaryPart = string | number | boolean | undefined;

interface ThemeSignature {
	readonly colors: object | undefined;
	readonly mode: unknown;
	readonly appearance: unknown;
}

interface PreparedPrimary {
	readonly kind: string;
	readonly theme: ThemeSignature;
	readonly parts: readonly PrimaryPart[];
	readonly section: ToolSection | undefined;
}

/** One retained primary preparation per render state — never a history or a path map. */
const PREPARED_PRIMARIES = new WeakMap<object, PreparedPrimary>();

/**
 * The installed SDK theme exposes its palette, colour mode and appearance as stable
 * O(1) values. Neither the theme Proxy identity nor a freshly allocated
 * `getMarkdownTheme()` may be used as a key: both change without changing a colour.
 */
function themeSignature(theme: Theme): ThemeSignature {
	const source: Record<string, unknown> = theme as unknown as Record<string, unknown>;
	const colors: unknown = source.colors;
	const colorMode: unknown = source.getColorMode;
	const appearance: unknown = source.appearance;
	return {
		colors: typeof colors === "object" && colors !== null ? (colors as object) : undefined,
		mode: typeof colorMode === "function" ? (colorMode as () => unknown).call(theme) : colorMode,
		appearance,
	};
}

function matchesPreparedPrimary(
	current: PreparedPrimary,
	kind: string,
	theme: ThemeSignature,
	parts: readonly PrimaryPart[],
): boolean {
	if (current.kind !== kind) {
		return false;
	}
	const sameTheme =
		current.theme.colors === theme.colors &&
		current.theme.mode === theme.mode &&
		current.theme.appearance === theme.appearance;
	if (!sameTheme || current.parts.length !== parts.length) {
		return false;
	}
	return current.parts.every((part, index) => part === parts[index]);
}

/**
 * Reuses the current primary section of one render state while its effective
 * immutable inputs and theme are unchanged, and rebuilds it otherwise. Callers read
 * every mutable args/result value first and pass those values as `parts`, so an
 * in-place mutation always reaches the rebuilt section; no caller-owned object is
 * ever retained here.
 */
export function reuseToolSection(
	state: object | undefined,
	theme: Theme,
	kind: string,
	parts: readonly PrimaryPart[],
	build: () => ToolSection | undefined,
): ToolSection | undefined {
	if (state === undefined) {
		return build();
	}
	const themeKey = themeSignature(theme);
	const current = PREPARED_PRIMARIES.get(state);
	if (current !== undefined && matchesPreparedPrimary(current, kind, themeKey, parts)) {
		return current.section;
	}
	const section = build();
	PREPARED_PRIMARIES.set(state, { kind, theme: themeKey, parts: parts.slice(), section });
	return section;
}

/** Drops the retained preparation for one render state after a root/environment change. */
export function invalidateToolViewCache(state: object): void {
	PREPARED_PRIMARIES.delete(state);
}

/* -------------------------------------------------------------------------- */
/* Generic                                                                    */
/* -------------------------------------------------------------------------- */

function genericView(toolName: string, snapshot: ToolSnapshot, theme: Theme): ToolView {
	const isError = snapshot.context.isError;
	const output = extractToolText(snapshot.result, snapshot.context.showImages);
	return {
		layout: "framed",
		head: makeHead(normalizeDisplayText(toolName), "", [], snapshot),
		sections: sectionsOf(
			fullArgumentsSection(suppliedArgs(snapshot)),
			output.length > 0
				? section(output.split("\n").map((line) => theme.fg(isError ? "error" : "toolOutput", line)), {
					label: "Output", slot: "result", previewPolicy: OUTPUT_PREVIEW,
				}) : undefined,
		),
		...(isError ? { tone: "error" } : {}),
		expanded: snapshot.context.expanded,
	};
}

/* -------------------------------------------------------------------------- */
/* Context execution                                                          */
/* -------------------------------------------------------------------------- */

const EXECUTION_INPUT_PREVIEW: ToolPreview = { edge: "head", count: 10, unit: "visual-lines" };
const EXECUTION_OUTPUT_PREVIEW: ToolPreview = { edge: "head", count: 5, unit: "visual-lines" };
const EXECUTION_LANGUAGES: Readonly<Record<string, true | undefined>> = {
	javascript: true, typescript: true, python: true, shell: true, ruby: true, go: true,
	rust: true, php: true, perl: true, r: true, elixir: true, csharp: true,
};

function executionCodeSection(
	code: ArgValue,
	language: string | undefined,
	state: object | undefined,
	theme: Theme,
	label?: string,
): ToolSection {
	const normalized = typeof code === "string" ? normalizeDisplayText(code) : undefined;
	const literal = normalized !== undefined && normalized.trim().length === 0;
	const text = code === undefined ? PENDING : code === WRONG_TYPE ? INVALID_ARG
		: literal ? `code: ${normalizeDisplayText(jsonText(code, false))}` : normalized!;
	const grammar = language !== undefined && Object.hasOwn(EXECUTION_LANGUAGES, language)
		? language === "shell" ? "bash" : language : undefined;
	return reuseToolSection(state, theme, "execution-code", [text, language, grammar, label, code === WRONG_TYPE, literal], () => {
		const lines = typeof code === "string" && !literal && grammar !== undefined
			? highlightCode(text, grammar) : text.split("\n");
		return section(lines, {
			slot: "call", previewPolicy: EXECUTION_INPUT_PREVIEW,
			...(label === undefined ? {} : { label }),
		});
	})!;
}

function executionArgumentsSection(args: unknown, label?: string): ToolSection | undefined {
	const text = args === undefined ? PENDING : normalizeDisplayText(jsonText(args, true));
	return section(text.split("\n"), {
		slot: "call", preview: false, ...(label === undefined ? {} : { label }),
	});
}

function contextInputEcho(toolName: string, args: unknown): string | undefined {
	if (toolName !== "ctx_execute" && toolName !== "ctx_execute_file") return undefined;
	const record = asRecord(args);
	if (typeof record?.language !== "string" || typeof record.code !== "string") return undefined;
	const file = toolName === "ctx_execute_file";
	if (file && typeof record.path !== "string") return undefined;
	const code = record.code;
	const shown = code.length <= 2000 ? code : `${code.slice(0, 2000)}\n… (truncated)`;
	return `${file && record.path ? `path=${record.path}\n` : ""}\`\`\`${record.language}\n${shown}\n\`\`\`\n\n`;
}

function executionOutputText(
	toolName: string,
	args: unknown,
	result: ToolResult | undefined,
	showImages: boolean,
): string {
	const first = result?.content[0];
	if (result && first?.type === "text") {
		const echo = contextInputEcho(toolName, args);
		let remaining: string | undefined;
		if (echo !== undefined && first.text.startsWith(echo)) {
			remaining = first.text.slice(echo.length);
		} else if (toolName === "codemode" && /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/.test(first.text)) {
			remaining = "";
		}
		if (remaining !== undefined) {
			const content = remaining.length === 0 ? result.content.slice(1)
				: [{ ...first, text: remaining }, ...result.content.slice(1)];
			return extractToolText({ ...result, content }, showImages);
		}
	}
	return extractToolText(result, showImages);
}

function executionView(toolName: string, snapshot: ToolSnapshot, theme: Theme): ToolView {
	return toolName === "codemode" ? codemodeView(snapshot, theme) : contextExecutionView(toolName, snapshot, theme);
}

/** Match the native cents/two-significant-digit convention, including zero. */
function executionCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function codemodeCallsSection(details: unknown, expanded: boolean, theme: Theme): ToolSection | undefined {
	const calls = asRecord(details)?.calls;
	if (!Array.isArray(calls) || calls.length === 0) return undefined;
	const mode = getIconMode();
	const states = {
		running: { ascii: "...", nerd: "…", color: "warning" },
		ok: { ascii: "ok", nerd: "✓", color: "success" },
		error: { ascii: "!", nerd: "✗", color: "error" },
		cancelled: { ascii: "-", nerd: "⊘", color: "muted" },
	} as const;
	const entries = calls.map((value: unknown) => {
		const call = asRecord(value);
		if (!call || typeof call.id !== "string" || typeof call.name !== "string"
			|| typeof call.args !== "string" || typeof call.status !== "string"
			|| !Object.hasOwn(states, call.status)) {
			return normalizeDisplayText(jsonText(value, true));
		}
		const state = states[call.status as keyof typeof states];
		const symbol = mode === "off" ? call.status : mode === "nerd-font" ? state.nerd : state.ascii;
		const normalizedArgs = normalizeDisplayText(call.args);
		const args = !expanded && normalizedArgs.length > 80 ? `${normalizedArgs.slice(0, 77)}...` : normalizedArgs;
		let line = `${theme.fg(state.color, symbol)} ${theme.fg("toolTitle", normalizeDisplayText(call.name))}`;
		if (args) line += ` ${theme.fg("muted", args)}`;
		const duration = finiteNumber(call.durationMs);
		if (duration !== undefined && duration >= 0) {
			line += ` ${theme.fg("dim", duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`)}`;
		}
		const cost = finiteNumber(call.cost);
		if (cost !== undefined && cost >= 0) line += ` ${theme.fg("dim", executionCost(cost))}`;
		if (expanded && typeof call.error === "string" && call.error.length > 0) {
			line += `\n    ${theme.fg("error", normalizeDisplayText(call.error).split("\n").join("\n    "))}`;
		}
		return line;
	});
	return {
		label: "Calls", slot: "result", component: entriesComponent(entries),
		previewPolicy: { edge: "tail", count: 8, unit: "entries" },
	};
}

function codemodeView(snapshot: ToolSnapshot, theme: Theme): ToolView {
	const args = snapshot.args;
	const record = asRecord(args);
	const extraEntries = argEntries(args).filter(([key]) => key !== "code");
	const details = asRecord(snapshot.result?.details);
	const calls = details?.calls;
	let total = 0;
	let positiveCosts = 0;
	if (Array.isArray(calls)) {
		for (const call of calls) {
			const cost = finiteNumber(asRecord(call)?.cost);
			if (cost !== undefined && cost >= 0) {
				total += cost;
				if (cost > 0) positiveCosts++;
			}
		}
	}
	const output = snapshot.context.isPartial ? ""
		: executionOutputText("codemode", args, snapshot.result, snapshot.context.showImages);
	const fullOutputPath = details?.fullOutputPath;
	const view: ToolView = {
		layout: "framed",
		head: makeHead("codemode", "", [], snapshot),
		sections: sectionsOf(
			executionCodeSection(argValue(record, "code"), "javascript", snapshot.context.state, theme, "Input"),
			extraEntries.length > 0 ? executionArgumentsSection(Object.fromEntries(extraEntries)) : undefined,
			codemodeCallsSection(snapshot.result?.details, snapshot.context.expanded, theme),
			positiveCosts > 1 ? section([theme.fg("muted", `Model calls: ${executionCost(total)}`)], { preview: false }) : undefined,
			section(output.split("\n"), { label: "Output", slot: "result", previewPolicy: EXECUTION_OUTPUT_PREVIEW }),
			typeof fullOutputPath === "string" && fullOutputPath.length > 0
				? section([theme.fg("muted", `Full output: ${normalizeDisplayText(fullOutputPath)}`)], { preview: false }) : undefined,
		),
		expanded: snapshot.context.expanded,
	};
	if (snapshot.context.isError) view.tone = "error";
	return view;
}

function contextExecutionView(toolName: string, snapshot: ToolSnapshot, theme: Theme): ToolView {
	const args = snapshot.args;
	const record = asRecord(args);
	const known = toolName === "ctx_execute" || toolName === "ctx_execute_file";
	const callSections: ToolSection[] = [];
	if (known) {
		const metadata: string[] = [];
		const fields = toolName === "ctx_execute_file" ? ["path", "language"] : ["language"];
		for (const field of fields) {
			const value = argValue(record, field);
			metadata.push(`${field}: ${value === undefined ? PENDING : value === WRONG_TYPE ? INVALID_ARG : normalizeDisplayText(value)}`);
		}
		callSections.push(section(metadata, { label: "Input", slot: "call", preview: false })!);
		const language = argValue(record, "language");
		callSections.push(executionCodeSection(
			argValue(record, "code"), typeof language === "string" ? language : undefined,
			snapshot.context.state, theme,
		));
		const consumed = new Set([...fields, "code"]);
		const options = argEntries(args).filter(([key]) => !consumed.has(key));
		if (options.length > 0) {
			const lines = options.flatMap(([key, value]) => normalizeDisplayText(
				`${key}: ${jsonText(value, false)}${key === "timeout" && typeof value === "number" ? " ms" : ""}`,
			).split("\n"));
			callSections.push(section(lines, { slot: "call", preview: false })!);
		}
	} else {
		const text = args === undefined ? PENDING : normalizeDisplayText(jsonText(args, true));
		const primary = reuseToolSection(snapshot.context.state, theme, "execution-arguments", [toolName, text], () => {
			const input = executionArgumentsSection(args, "Input");
			if (input) {
				input.preview = true;
				input.previewPolicy = EXECUTION_INPUT_PREVIEW;
			}
			return input;
		});
		if (primary) callSections.push(primary);
	}
	const output = executionOutputText(toolName, args, snapshot.result, snapshot.context.showImages);
	const view: ToolView = {
		layout: "framed",
		head: makeHead(normalizeDisplayText(toolName), "", [], snapshot),
		sections: sectionsOf(
			...callSections,
			section(output.split("\n"), { label: "Output", slot: "result", previewPolicy: EXECUTION_OUTPUT_PREVIEW }),
		),
		expanded: snapshot.context.expanded,
	};
	if (snapshot.context.isError) view.tone = "error";
	return view;
}

/* -------------------------------------------------------------------------- */
/* Shell (bash / powershell)                                                  */
/* -------------------------------------------------------------------------- */

function shellView(toolName: string, snapshot: ToolSnapshot, theme: Theme): ToolView {
	const value = suppliedArgs(snapshot);
	const args = asRecord(value);
	const command = args?.command;
	const isPowerShell = toolName === "powershell";
	const prompt = isPowerShell ? "PS> " : "$ ";
	const commandText = args
		? `${typeof command === "string" ? prompt : ""}${stringInput(command)}`
		: value === undefined ? PENDING : argumentText(value, true);
	const options: string[] = [];
	if (args) {
		const entries = Object.entries(args);
		for (const [key, entry] of entries) {
			if (key !== "command") {
				options.push(`${normalizeDisplayText(key)}: ${key === "timeout" && finiteNumber(entry) !== undefined ? `${entry}s` : argumentText(entry)}`);
			}
		}
		if (entries.length === 0) {
			options.push("{}");
		}
	}
	const head = makeHead(isPowerShell ? "PowerShell" : "Bash", "", [], snapshot);

	const output = extractToolText(snapshot.result, snapshot.context.showImages).trim();
	const details = asRecord(snapshot.result?.details);
	const truncation = asRecord(details?.truncation);
	const fullOutputPath = typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;

	const detailsLines: string[] = [];
	if (truncation?.truncated === true) {
		detailsLines.push(theme.fg("warning", `[Truncated: ${formatSize(finiteNumber(truncation.maxBytes) ?? DEFAULT_MAX_BYTES)} limit]`));
	}
	if (fullOutputPath) {
		detailsLines.push(theme.fg("muted", `Full output: ${singleLineText(fullOutputPath)}`));
	}

	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(
			section(commandText.split("\n"), { label: "Command", slot: "call", previewPolicy: COMMAND_PREVIEW }),
			options.length > 0 ? section(options, { slot: "call", preview: false }) : undefined,
			reuseToolSection(snapshot.context.state, theme, "shell-output", [output], () =>
				output.length > 0 ? section(output.split("\n"), { label: "Output", slot: "result" }) : undefined,
			),
			detailsLines.length > 0 ? section(detailsLines, { preview: false, slot: "result" }) : undefined,
		),
		preview: { edge: "tail", count: 10, unit: "visual-lines" },
		expanded: snapshot.context.expanded,
	};
	if (snapshot.context.isError) {
		view.tone = "error";
	}
	return view;
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

function readView(snapshot: ToolSnapshot, theme: Theme): ToolView {
	const args = asRecord(suppliedArgs(snapshot));
	const rawPath = argValue(args, "path");
	const head = makeHead("Read", "", [], snapshot);

	const result = snapshot.result;
	const isError = snapshot.context.isError;
	// No whole-output trim: leading indentation and blank lines belong to the file.
	const output = extractToolText(result, snapshot.context.showImages);
	const lang = !isError && rawPath !== undefined && rawPath !== WRONG_TYPE ? getLanguageFromPath(rawPath) : undefined;
	const bodyLines = trimTrailingEmptyLines(output.split("\n"));

	let contentSection: ToolSection | undefined;
	if (bodyLines.length > 0) {
		const bodyText = bodyLines.join("\n");
		const state = snapshot.context.state;
		if (lang === "markdown") {
			contentSection = reuseToolSection(state, theme, "read-markdown", [bodyText], () => ({
				component: new Markdown(bodyText, 0, 0, getMarkdownTheme()),
				label: "Output",
				slot: "result",
				preview: true,
				renderedWidth: "padded",
			}));
		} else if (lang) {
			const language = lang;
			contentSection = reuseToolSection(state, theme, "read-code", [language, bodyText], () =>
				section(highlightCode(bodyText, language), { label: "Output", preview: true, slot: "result" }),
			);
		} else {
			const color = isError ? "error" : "toolOutput";
			contentSection = reuseToolSection(state, theme, "read-text", [color, bodyText], () =>
				section(
					bodyLines.map((line) => theme.fg(color, line)),
					{ label: "Output", preview: true, slot: "result" },
				),
			);
		}
	}

	const truncation = asRecord(result?.details?.truncation);
	const warnings: string[] = [];
	if (truncation?.truncated === true) {
		if (truncation.firstLineExceedsLimit === true) {
			warnings.push(
				`[First line exceeds ${formatSize(finiteNumber(truncation.maxBytes) ?? DEFAULT_MAX_BYTES)} limit]`,
			);
		} else if (truncation.truncatedBy === "lines") {
			warnings.push(
				`[Truncated: showing ${finiteNumber(truncation.outputLines) ?? 0} of ${
					finiteNumber(truncation.totalLines) ?? 0
				} lines (${finiteNumber(truncation.maxLines) ?? DEFAULT_MAX_LINES} line limit)]`,
			);
		} else {
			warnings.push(
				`[Truncated: ${finiteNumber(truncation.outputLines) ?? 0} lines shown (${formatSize(
					finiteNumber(truncation.maxBytes) ?? DEFAULT_MAX_BYTES,
				)} limit)]`,
			);
		}
	}

	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(
			nativeInputSection(snapshot, theme, ["path"]),
			contentSection,
			warnings.length > 0 ? section(warnings.map((line) => theme.fg("warning", line)), { preview: false }) : undefined,
		),
		preview: { edge: "head", count: 10, unit: "visual-lines" },
		expanded: snapshot.context.expanded,
	};
	if (isError) {
		view.tone = "error";
	}
	return view;
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

function writeView(snapshot: ToolSnapshot, theme: Theme): ToolView {
	const args = asRecord(suppliedArgs(snapshot));
	const rawPath = argValue(args, "path");
	const content = args?.content;
	const isError = snapshot.context.isError;
	const normalized = typeof content === "string" ? normalizeDisplayText(content) : undefined;
	const literal = normalized !== undefined && normalized.trim().length === 0;
	const text = typeof content === "string" && !literal ? normalized! : `content: ${stringInput(content)}`;
	const lang = !literal && typeof content === "string" && typeof rawPath === "string" ? getLanguageFromPath(rawPath) : undefined;
	const color = content !== undefined && typeof content !== "string" ? "error" : "toolOutput";
	const contentSection = reuseToolSection(
		snapshot.context.state, theme, "write-input", [text, lang, literal, color],
		() => section(lang ? highlightCode(text, lang) : text.split("\n").map((line) => theme.fg(color, line)), {
			slot: "call", previewPolicy: WRITE_PREVIEW,
		}),
	);
	const meta = normalized === undefined ? [] : [`${trimTrailingEmptyLines(normalized.split("\n")).length} lines`];
	const head = makeHead("Write", "", meta, snapshot);
	const resultText = extractToolText(snapshot.result, snapshot.context.showImages);
	const resultSection = resultText.length > 0
		? section(resultText.split("\n").map((line) => theme.fg(isError ? "error" : "toolOutput", line)), {
			label: isError ? "Error" : "Output", slot: "result", preview: !isError, previewPolicy: WRITE_PREVIEW,
		}) : undefined;
	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(nativeInputSection(snapshot, theme, ["path"], ["content"], false), contentSection, resultSection),
		preview: WRITE_PREVIEW,
		expanded: snapshot.context.expanded,
	};
	if (isError) {
		view.tone = "error";
	}
	return view;
}

/* -------------------------------------------------------------------------- */
/* Edit                                                                       */
/* -------------------------------------------------------------------------- */

/** Show the delivered request, not a reconstructed version of the result diff. */
function editRequestLines(args: Record<string, unknown> | undefined, theme: Theme): string[] {
	const lines: string[] = [];
	const hasEdits = args !== undefined && Object.hasOwn(args, "edits");
	const edits = args?.edits;
	const requests: unknown[] = [];
	if (hasEdits) {
		if (Array.isArray(edits) && edits.length > 0) {
			requests.push(...edits);
		} else {
			lines.push(`edits: ${edits === undefined ? PENDING : `${INVALID_ARG} (${argumentText(edits, true)})`}`);
		}
	}
	if (!hasEdits || Object.hasOwn(args!, "oldText") || Object.hasOwn(args!, "newText")) {
		requests.push({ oldText: args?.oldText, newText: args?.newText });
	}
	for (const request of requests) {
		const pair = asRecord(request);
		if (!pair) {
			lines.push(`${INVALID_ARG} (${argumentText(request, true)})`);
			continue;
		}
		if (typeof pair.oldText === "string" && typeof pair.newText === "string") {
			for (const line of stringInput(pair.oldText).split("\n")) {
				lines.push(theme.fg("toolDiffRemoved", `-${line}`));
			}
			for (const line of stringInput(pair.newText).split("\n")) {
				lines.push(theme.fg("toolDiffAdded", `+${line}`));
			}
		} else {
			lines.push(`oldText: ${stringInput(pair.oldText)}`, `newText: ${stringInput(pair.newText)}`);
		}
		for (const [key, entry] of Object.entries(pair)) {
			if (key !== "oldText" && key !== "newText") {
				lines.push(`${normalizeDisplayText(key)}: ${argumentText(entry)}`);
			}
		}
	}
	return lines;
}

/** Key the displayed request fields individually: JSON merges null/NaN and absent/undefined. */
function editRequestParts(args: Record<string, unknown> | undefined): PrimaryPart[] {
	const hasEdits = args !== undefined && Object.hasOwn(args, "edits");
	const parts: PrimaryPart[] = [
		hasEdits,
		args !== undefined && Object.hasOwn(args, "oldText"),
		args !== undefined && Object.hasOwn(args, "newText"),
		typeof args?.oldText === "string", typeof args?.newText === "string",
		argumentText(args?.oldText), argumentText(args?.newText),
	];
	if (!hasEdits) {
		return parts;
	}
	const edits = args!.edits;
	if (!Array.isArray(edits) || edits.length === 0) {
		parts.push(argumentText(edits, true));
		return parts;
	}
	parts.push(edits.length);
	for (const request of edits) {
		const pair = asRecord(request);
		if (!pair) {
			parts.push(false, argumentText(request, true));
			continue;
		}
		const entries = Object.entries(pair);
		parts.push(true, typeof pair.oldText === "string", typeof pair.newText === "string",
			argumentText(pair.oldText), argumentText(pair.newText), entries.length);
		for (const [key, entry] of entries) {
			if (key !== "oldText" && key !== "newText") {
				parts.push(normalizeDisplayText(key), argumentText(entry));
			}
		}
	}
	return parts;
}

function editDiffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) {
			added++;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			removed++;
		}
	}
	return { added, removed };
}

function editView(snapshot: ToolSnapshot, theme: Theme): ToolView {
	const args = asRecord(suppliedArgs(snapshot));
	const rawPath = argValue(args, "path");
	const filePath = rawPath !== undefined && rawPath !== WRONG_TYPE ? rawPath : undefined;
	const isError = snapshot.context.isError;
	const details = asRecord(snapshot.result?.details);
	// A diff and its statistics belong to the final revision; active revisions keep
	// showing the request preview instead of half-streamed diff data.
	const finalized = snapshot.result !== undefined && !snapshot.context.isPartial;
	const resultDiff =
		!isError && finalized && typeof details?.diff === "string" ? normalizeDisplayText(details.diff) : undefined;

	const meta: string[] = [];
	if (resultDiff && resultDiff.length > 0) {
		const stats = editDiffStats(resultDiff);
		meta.push(`+${stats.added} −${stats.removed}`);
	}

	const head = makeHead("Edit", "", meta, snapshot);

	const resultText = extractToolText(snapshot.result, snapshot.context.showImages);

	let primary: ToolSection | undefined;
	const state = snapshot.context.state;
	const buildRequest = () => section(editRequestLines(args, theme), { slot: "call", previewPolicy: INPUT_PREVIEW });
	// The active request and final result share the one retained-primary slot.
	// Final Input is ordinary; whole-view retention still keeps it stable on ticks/resize.
	const request = finalized ? buildRequest() : reuseToolSection(state, theme, "edit-request", editRequestParts(args), buildRequest);
	if (isError) {
		if (resultText.length > 0) {
			const buildError = () => section(resultText.split("\n").map((line) => theme.fg("error", line)), {
				label: "Error", slot: "result", preview: false,
			});
			primary = finalized ? reuseToolSection(state, theme, "edit-error", [resultText], buildError) : buildError();
		}
	} else if (resultDiff !== undefined && resultDiff.length > 0) {
		const diff = resultDiff;
		primary = reuseToolSection(state, theme, "edit-diff", [diff, filePath], () =>
			section(renderDiff(diff, filePath === undefined ? {} : { filePath }).split("\n"), {
				label: "Diff",
				slot: "result",
				preview: true,
				previewPolicy: INPUT_PREVIEW,
			}),
		);
	} else if (finalized && resultText.length > 0) {
		primary = reuseToolSection(state, theme, "edit-text", [resultText], () =>
			section(resultText.split("\n").map((line) => theme.fg("toolOutput", line)), {
				label: "Diff",
				slot: "result",
				preview: true,
				previewPolicy: INPUT_PREVIEW,
			}),
		);
	}

	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(nativeInputSection(snapshot, theme, ["path"], ["oldText", "newText", "edits"], false), request, primary),
		preview: { edge: "head", count: 10, unit: "visual-lines" },
		expanded: snapshot.context.expanded,
	};
	if (isError) {
		view.tone = "error";
	}
	return view;
}

/* -------------------------------------------------------------------------- */
/* Find                                                                       */
/* -------------------------------------------------------------------------- */

function findView(snapshot: ToolSnapshot, theme: Theme): ToolView {
	const head = makeHead("Find", "", [], snapshot);

	const output = extractToolText(snapshot.result, snapshot.context.showImages).trim();
	const entryLines = output.length > 0 ? trimTrailingEmptyLines(output.split("\n")) : [];

	const details = asRecord(snapshot.result?.details);
	const truncation = asRecord(details?.truncation);
	const resultLimit = finiteNumber(details?.resultLimitReached);
	const warnings: string[] = [];
	if (resultLimit !== undefined) {
		warnings.push(`${resultLimit} results limit`);
	}
	if (truncation?.truncated === true) {
		warnings.push(`${formatSize(finiteNumber(truncation.maxBytes) ?? DEFAULT_MAX_BYTES)} limit`);
	}

	// Entry previews stay unmarked: the layout selects whole logical entries and wraps
	// only the selected rows itself, so the padded marker must not apply here.
	const entrySection: ToolSection | undefined =
		entryLines.length > 0
			? reuseToolSection(snapshot.context.state, theme, "find-entries", [output], () => ({
					component: entriesComponent(entryLines.map((line) => theme.fg("toolOutput", line))),
					label: "Output",
					slot: "result",
					preview: true,
				}))
			: undefined;

	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(
			nativeInputSection(snapshot, theme, ["pattern"]),
			entrySection,
			warnings.length > 0 ? section([theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)], { preview: false }) : undefined,
		),
		preview: { edge: "head", count: 5, unit: "entries" },
		expanded: snapshot.context.expanded,
	};
	if (snapshot.context.isError) {
		view.tone = "error";
	}
	return view;
}

/* -------------------------------------------------------------------------- */
/* Grep                                                                       */
/* -------------------------------------------------------------------------- */

function grepView(snapshot: ToolSnapshot, theme: Theme): ToolView {
	const head = makeHead("Grep", "", [], snapshot);

	const output = extractToolText(snapshot.result, snapshot.context.showImages).trim();
	const outputLines = output.length > 0 ? output.split("\n") : [];

	const details = asRecord(snapshot.result?.details);
	const truncation = asRecord(details?.truncation);
	const matchLimit = finiteNumber(details?.matchLimitReached);
	const warnings: string[] = [];
	if (matchLimit !== undefined) {
		warnings.push(`${matchLimit} matches limit`);
	}
	if (truncation?.truncated === true) {
		warnings.push(`${formatSize(finiteNumber(truncation.maxBytes) ?? DEFAULT_MAX_BYTES)} limit`);
	}
	if (details?.linesTruncated === true) {
		warnings.push("some lines truncated");
	}

	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(
			nativeInputSection(snapshot, theme, ["pattern"]),
			reuseToolSection(snapshot.context.state, theme, "grep-output", [output], () =>
				section(outputLines.map((line) => theme.fg("toolOutput", line)), { label: "Output", preview: true, slot: "result" }),
			),
			warnings.length > 0 ? section([theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)], { preview: false }) : undefined,
		),
		preview: { edge: "head", count: 10, unit: "visual-lines" },
		expanded: snapshot.context.expanded,
	};
	if (snapshot.context.isError) {
		view.tone = "error";
	}
	return view;
}

/* -------------------------------------------------------------------------- */
/* Ls                                                                         */
/* -------------------------------------------------------------------------- */

function lsView(snapshot: ToolSnapshot, theme: Theme): ToolView {
	const head = makeHead("Ls", "", [], snapshot);

	const output = extractToolText(snapshot.result, snapshot.context.showImages).trim();
	const outputLines = output.length > 0 ? output.split("\n") : [];

	const details = asRecord(snapshot.result?.details);
	const truncation = asRecord(details?.truncation);
	const entryLimit = finiteNumber(details?.entryLimitReached);
	const warnings: string[] = [];
	if (entryLimit !== undefined) {
		warnings.push(`${entryLimit} entries limit`);
	}
	if (truncation?.truncated === true) {
		warnings.push(`${formatSize(finiteNumber(truncation.maxBytes) ?? DEFAULT_MAX_BYTES)} limit`);
	}

	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(
			nativeInputSection(snapshot, theme, []),
			reuseToolSection(snapshot.context.state, theme, "ls-output", [output], () =>
				section(outputLines.map((line) => theme.fg("toolOutput", line)), { label: "Output", preview: true, slot: "result" }),
			),
			warnings.length > 0 ? section([theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)], { preview: false }) : undefined,
		),
		preview: { edge: "head", count: 10, unit: "visual-lines" },
		expanded: snapshot.context.expanded,
	};
	if (snapshot.context.isError) {
		view.tone = "error";
	}
	return view;
}

/* -------------------------------------------------------------------------- */
/* MCP                                                                        */
/* -------------------------------------------------------------------------- */

interface McpIdentity {
	target: string;
	namespace?: string;
}

function mcpIdentity(toolName: string, snapshot: ToolSnapshot): McpIdentity {
	const details = asRecord(snapshot.result?.details);
	const server = typeof details?.server === "string" ? details.server : undefined;
	const tool = typeof details?.tool === "string" ? details.tool : undefined;
	if (server && tool) {
		return { target: `${server}/${tool}` };
	}
	const namespace = snapshot.toolInfo?.namespace?.name;
	if (namespace && namespace.length > 0) {
		const suffixPrefix = `${namespace}__`;
		if (toolName.startsWith(suffixPrefix)) {
			return { target: `${namespace}/${toolName.slice(suffixPrefix.length)}`, namespace };
		}
		return { target: toolName, namespace };
	}
	return { target: toolName };
}

function mcpMeta(identity: McpIdentity, snapshot: ToolSnapshot): string[] {
	const meta: string[] = [];
	if (identity.namespace && !identity.target.startsWith(identity.namespace)) {
		meta.push(singleLineText(identity.namespace));
	}
	const exposure = snapshot.toolInfo?.exposure;
	if (exposure !== undefined && exposure !== "direct") {
		meta.push(exposure);
	}
	const annotations = snapshot.toolInfo?.annotations;
	if (annotations) {
		const hints: string[] = [];
		if (annotations.readOnlyHint === true) {
			hints.push("read-only");
		}
		if (annotations.destructiveHint === true) {
			hints.push("destructive");
		}
		if (annotations.idempotentHint === true) {
			hints.push("idempotent");
		}
		if (annotations.openWorldHint === true) {
			hints.push("open-world");
		}
		if (hints.length > 0) {
			meta.push(`hints: ${hints.join(", ")}`);
		}
	}
	return meta;
}

/** Stringify untrusted argument values without throwing on bigint or cyclic input. */
function jsonText(value: unknown, pretty: boolean): string {
	if (pretty && typeof value === "string") {
		return value;
	}
	try {
		const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
		return text ?? String(value);
	} catch {
		// Preserve delivered fields on the exceptional bigint/cycle path as well.
		const ancestors: object[] = [];
		try {
			const text = JSON.stringify(value, function (_key, entry: unknown): unknown {
				if (typeof entry === "bigint") {
					return String(entry);
				}
				if (typeof entry !== "object" || entry === null) {
					return entry;
				}
				while (ancestors.length > 0 && ancestors.at(-1) !== this) {
					ancestors.pop();
				}
				if (ancestors.includes(entry)) {
					return "[Circular]";
				}
				ancestors.push(entry);
				return entry;
			}, pretty ? 2 : undefined);
			return text ?? String(value);
		} catch {
			return String(value);
		}
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


function mcpView(toolName: string, snapshot: ToolSnapshot, theme: Theme): ToolView {
	const identity = mcpIdentity(toolName, snapshot);
	const head = makeHead("MCP", normalizeDisplayText(identity.target), mcpMeta(identity, snapshot), snapshot);

	const isError = snapshot.context.isError;
	const output = extractToolText(snapshot.result, snapshot.context.showImages).trim();
	const details = asRecord(snapshot.result?.details);
	const fullOutputPath = typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;

	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(
			fullArgumentsSection(suppliedArgs(snapshot)),
			reuseToolSection(snapshot.context.state, theme, "mcp-output", [isError ? "error" : "toolOutput", output], () => {
				const outputLines =
					output.length > 0 ? output.split("\n").map((line) => theme.fg(isError ? "error" : "toolOutput", line)) : [];
				return outputLines.length > 0
					? section(outputLines, { label: "Output", slot: "result", preview: true })
					: undefined;
			}),
			fullOutputPath !== undefined && fullOutputPath.length > 0
				? section([theme.fg("muted", `Full output: ${singleLineText(fullOutputPath)}`)], { slot: "result", preview: false })
				: undefined,
		),
		preview: { edge: "head", count: 5, unit: "visual-lines" },
		expanded: snapshot.context.expanded,
	};
	if (isError) {
		view.tone = "error";
	}
	return view;
}

/* -------------------------------------------------------------------------- */
/* MCP resources                                                              */
/* -------------------------------------------------------------------------- */

function mcpResourceView(toolName: string, snapshot: ToolSnapshot, theme: Theme): ToolView {
	const title = MCP_RESOURCE_TITLES[toolName] ?? "MCP Resource";
	const head = makeHead(title, "", [], snapshot);

	const output = extractToolText(snapshot.result, snapshot.context.showImages).trim();
	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(
			nativeInputSection(snapshot, theme, toolName === "read_mcp_resource" ? ["server", "uri"] : []),
			reuseToolSection(
				snapshot.context.state,
				theme,
				"mcp-resource-output",
				[snapshot.context.isError ? "error" : "toolOutput", output],
				() => {
					const outputLines =
						output.length > 0
							? output.split("\n").map((line) => theme.fg(snapshot.context.isError ? "error" : "toolOutput", line))
							: [];
					return outputLines.length > 0
						? section(outputLines, { label: "Output", slot: "result", preview: true })
						: undefined;
				},
			),
		),
		preview: { edge: "head", count: 5, unit: "visual-lines" },
		expanded: snapshot.context.expanded,
	};
	if (snapshot.context.isError) {
		view.tone = "error";
	}
	return view;
}

function sourceIsMcp(snapshot: ToolSnapshot): boolean {
	const path = snapshot.toolInfo?.sourceInfo?.path;
	return (
		path === "builtin:mcp" ||
		path === undefined ||
		snapshot.presentation === "mcp" ||
		snapshot.presentation === "mcp-unresolved"
	);
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

const BUILTIN_PRODUCERS: Record<string, (snapshot: ToolSnapshot, theme: Theme) => ToolView> = {
	bash: (snapshot, theme) => shellView("bash", snapshot, theme),
	powershell: (snapshot, theme) => shellView("powershell", snapshot, theme),
	read: readView,
	write: writeView,
	edit: editView,
	find: findView,
	grep: grepView,
	ls: lsView,
};

/** Build the semantic view for one render revision. */
export function createToolView(toolName: string, snapshot: ToolSnapshot, theme: Theme): ToolView {
	const isMcpResource = MCP_RESOURCE_TITLES[toolName] !== undefined && sourceIsMcp(snapshot);
	switch (snapshot.presentation) {
		case "execution":
			return executionView(toolName, snapshot, theme);
		case "generic":
		case "web":
			return genericView(toolName, snapshot, theme);
		case "mcp":
		case "mcp-unresolved":
			return isMcpResource ? mcpResourceView(toolName, snapshot, theme) : mcpView(toolName, snapshot, theme);
		default:
			break;
	}
	if (isMcpResource) {
		return mcpResourceView(toolName, snapshot, theme);
	}
	const producer = BUILTIN_PRODUCERS[toolName];
	return producer ? producer(snapshot, theme) : genericView(toolName, snapshot, theme);
}
