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

export type ToolStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface ToolHead {
	title: string;
	target: string;
	meta: readonly string[];
	status: ToolStatus;
	durationMs?: number;
}

export interface ToolSection {
	label?: string;
	component: Component;
	slot: "call" | "result";
	preview?: boolean;
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
	preview?: { edge: "head" | "tail"; count: number; unit: "visual-lines" | "entries" };
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
	presentation: "builtin" | "mcp" | "mcp-unresolved" | "web" | "generic";
}

export type ToolViewFactory = (toolName: string, snapshot: ToolSnapshot, theme: Theme) => ToolView;

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

const COLLAPSED_ARGS_CHARS = 100;

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

function shortenPath(value: string): string {
	const home = homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
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

function renderPath(rawPath: ArgValue, theme: Theme, cwd: string): string {
	if (rawPath === WRONG_TYPE) {
		return INVALID_ARG;
	}
	if (rawPath === undefined || rawPath === "") {
		return theme.fg("toolOutput", PENDING);
	}
	// Only the displayed text is sanitized; the link target keeps the original input.
	return linkPath(theme.fg("accent", normalizeDisplayText(shortenPath(rawPath))), rawPath, cwd);
}

/**
 * Head target for a path argument: pending while it streams in, otherwise the
 * display path (never a fabricated link for a wrong-type value).
 */
function pathTarget(rawPath: ArgValue, theme: Theme, cwd: string): string {
	return rawPath === undefined ? PENDING : renderPath(rawPath, theme, cwd);
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
	return result;
}

function sectionsOf(...candidates: readonly (ToolSection | undefined)[]): ToolSection[] {
	return candidates.filter((candidate): candidate is ToolSection => candidate !== undefined);
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

function genericView(toolName: string, snapshot: ToolSnapshot): ToolView {
	return {
		layout: "framed",
		head: makeHead(normalizeDisplayText(toolName), "", [], snapshot),
		sections: [],
		expanded: snapshot.context.expanded,
	};
}

/* -------------------------------------------------------------------------- */
/* Shell (bash / powershell)                                                  */
/* -------------------------------------------------------------------------- */

function shellView(toolName: string, snapshot: ToolSnapshot, theme: Theme): ToolView {
	const args = asRecord(snapshot.args ?? snapshot.context.args);
	const command = argValue(args, "command");
	const timeout = finiteNumber(args?.timeout);
	const isPowerShell = toolName === "powershell";
	const prompt = isPowerShell ? "PS> " : "$ ";

	const meta: string[] = [];
	if (timeout !== undefined) {
		meta.push(`${timeout}s`);
	}

	const target =
		command === undefined
			? PENDING
			: command === WRONG_TYPE
				? INVALID_ARG
				: `${prompt}${normalizeDisplayText(command)}`;
	const head = makeHead(isPowerShell ? "PowerShell" : "Bash", target, meta, snapshot);

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
	const args = asRecord(snapshot.args ?? snapshot.context.args);
	const rawPath = argValue(args, "path");
	const offset = finiteNumber(args?.offset);
	const limit = finiteNumber(args?.limit);

	let range = "";
	if (offset !== undefined || limit !== undefined) {
		const start = offset ?? 1;
		const end = limit !== undefined ? start + limit - 1 : undefined;
		range = end !== undefined ? `:${start}-${end}` : `:${start}`;
	}

	const head = makeHead("Read", `${pathTarget(rawPath, theme, snapshot.context.cwd)}${range}`, [], snapshot);

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
				slot: "result",
				preview: true,
				renderedWidth: "padded",
			}));
		} else if (lang) {
			const language = lang;
			contentSection = reuseToolSection(state, theme, "read-code", [language, bodyText], () =>
				section(highlightCode(bodyText, language), { preview: true, slot: "result" }),
			);
		} else {
			const color = isError ? "error" : "toolOutput";
			contentSection = reuseToolSection(state, theme, "read-text", [color, bodyText], () =>
				section(
					bodyLines.map((line) => theme.fg(color, line)),
					{ preview: true, slot: "result" },
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
		layout: "inline",
		head,
		sections: sectionsOf(
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
	const args = asRecord(snapshot.args ?? snapshot.context.args);
	const rawPath = argValue(args, "path");
	const contentValue = args?.content;
	const content = typeof contentValue === "string" ? contentValue : undefined;
	const isError = snapshot.context.isError;

	const meta: string[] = [];
	let contentSection: ToolSection | undefined;
	if (content !== undefined) {
		const lang = rawPath !== undefined && rawPath !== WRONG_TYPE ? getLanguageFromPath(rawPath) : undefined;
		const normalized = normalizeDisplayText(content);
		const bodyLines = trimTrailingEmptyLines(normalized.split("\n"));
		meta.push(`${bodyLines.length} lines`);
		const state = snapshot.context.state;
		if (lang) {
			const language = lang;
			contentSection = reuseToolSection(state, theme, "write-code", [language, normalized], () =>
				section(highlightCode(normalized, language), { label: "Content", slot: "call", preview: true }),
			);
		} else {
			contentSection = reuseToolSection(state, theme, "write-text", [normalized], () =>
				section(bodyLines.map((line) => theme.fg("toolOutput", line)), { label: "Content", slot: "call", preview: true }),
			);
		}
	} else if (contentValue !== undefined) {
		contentSection = section([theme.fg("error", INVALID_ARG)], { label: "Content", slot: "call", preview: false });
	}

	const head = makeHead("Write", pathTarget(rawPath, theme, snapshot.context.cwd), meta, snapshot);

	const resultText = extractToolText(snapshot.result, snapshot.context.showImages).trim();
	const errorSection =
		isError && resultText.length > 0
			? section(resultText.split("\n").map((line) => theme.fg("error", line)), {
					label: "Error",
					slot: "result",
					preview: false,
				})
			: undefined;

	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(contentSection, errorSection),
		preview: { edge: "head", count: 8, unit: "visual-lines" },
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

interface EditPair {
	oldText: string;
	newText: string;
}

function collectEditPairs(args: Record<string, unknown> | undefined): EditPair[] | undefined {
	if (!args) {
		return undefined;
	}
	const edits = args.edits;
	if (Array.isArray(edits) && edits.length > 0) {
		const pairs: EditPair[] = [];
		for (const edit of edits) {
			const record = asRecord(edit);
			if (typeof record?.oldText !== "string" || typeof record.newText !== "string") {
				return undefined;
			}
			pairs.push({ oldText: record.oldText, newText: record.newText });
		}
		return pairs;
	}
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return [{ oldText: args.oldText, newText: args.newText }];
	}
	return undefined;
}

function editPreviewLines(pairs: readonly EditPair[], theme: Theme): string[] {
	const lines: string[] = [];
	for (const pair of pairs) {
		for (const line of normalizeDisplayText(pair.oldText).split("\n")) {
			lines.push(theme.fg("toolDiffRemoved", `-${line}`));
		}
		for (const line of normalizeDisplayText(pair.newText).split("\n")) {
			lines.push(theme.fg("toolDiffAdded", `+${line}`));
		}
	}
	return lines;
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
	const args = asRecord(snapshot.args ?? snapshot.context.args);
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

	const head = makeHead("Edit", pathTarget(rawPath, theme, snapshot.context.cwd), meta, snapshot);

	const resultText = extractToolText(snapshot.result, snapshot.context.showImages).trim();

	let primary: ToolSection | undefined;
	const state = snapshot.context.state;
	if (isError) {
		if (resultText.length > 0) {
			primary = reuseToolSection(state, theme, "edit-error", [resultText], () =>
				section(resultText.split("\n").map((line) => theme.fg("error", line)), {
					label: "Error",
					slot: "result",
					preview: false,
				}),
			);
		}
	} else if (resultDiff !== undefined && resultDiff.length > 0) {
		const diff = resultDiff;
		primary = reuseToolSection(state, theme, "edit-diff", [diff, filePath], () =>
			section(renderDiff(diff, filePath === undefined ? {} : { filePath }).split("\n"), {
				label: "Diff",
				slot: "result",
				preview: true,
			}),
		);
	} else if (finalized && resultText.length > 0) {
		primary = reuseToolSection(state, theme, "edit-text", [resultText], () =>
			section(resultText.split("\n").map((line) => theme.fg("toolOutput", line)), {
				label: "Diff",
				slot: "result",
				preview: true,
			}),
		);
	} else if (!finalized) {
		const pairs = collectEditPairs(args);
		if (pairs) {
			const editPairs = pairs;
			const parts = editPairs.flatMap((pair) => [pair.oldText, pair.newText]);
			primary = reuseToolSection(state, theme, "edit-preview", parts, () =>
				section(editPreviewLines(editPairs, theme), { label: "Preview", slot: "call", preview: true }),
			);
		}
	}

	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(primary),
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
	const args = asRecord(snapshot.args ?? snapshot.context.args);
	const pattern = argValue(args, "pattern");
	const rawPath = argValue(args, "path");
	const limit = finiteNumber(args?.limit);

	const meta: string[] = [];
	if (rawPath !== undefined && rawPath !== WRONG_TYPE && rawPath !== "") {
		meta.push(singleLineText(`in ${shortenPath(rawPath)}`));
	}
	if (limit !== undefined) {
		meta.push(`limit ${limit}`);
	}

	const head = makeHead(
		"Find",
		pattern === undefined ? PENDING : pattern === WRONG_TYPE ? INVALID_ARG : normalizeDisplayText(pattern),
		meta,
		snapshot,
	);

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
					slot: "result",
					preview: true,
				}))
			: undefined;

	const view: ToolView = {
		layout: "inline",
		head,
		sections: sectionsOf(
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
	const args = asRecord(snapshot.args ?? snapshot.context.args);
	const pattern = argValue(args, "pattern");
	const rawPath = argValue(args, "path");
	const glob = argValue(args, "glob");
	const limit = finiteNumber(args?.limit);
	const contextLines = finiteNumber(args?.context);

	const meta: string[] = [];
	if (rawPath !== undefined && rawPath !== WRONG_TYPE && rawPath !== "") {
		meta.push(singleLineText(`in ${shortenPath(rawPath)}`));
	}
	if (glob !== undefined && glob !== WRONG_TYPE && glob !== "") {
		meta.push(singleLineText(glob));
	}
	if (args?.ignoreCase === true) {
		meta.push("ignore-case");
	}
	if (args?.literal === true) {
		meta.push("literal");
	}
	if (contextLines !== undefined) {
		meta.push(`context ${contextLines}`);
	}
	if (limit !== undefined) {
		meta.push(`limit ${limit}`);
	}

	const head = makeHead(
		"Grep",
		pattern === undefined ? PENDING : pattern === WRONG_TYPE ? INVALID_ARG : normalizeDisplayText(pattern),
		meta,
		snapshot,
	);

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
		layout: "inline",
		head,
		sections: sectionsOf(
			reuseToolSection(snapshot.context.state, theme, "grep-output", [output], () =>
				section(outputLines.map((line) => theme.fg("toolOutput", line)), { preview: true, slot: "result" }),
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
	const args = asRecord(snapshot.args ?? snapshot.context.args);
	const rawPath = argValue(args, "path");
	const limit = finiteNumber(args?.limit);

	const meta: string[] = [];
	if (limit !== undefined) {
		meta.push(`limit ${limit}`);
	}

	const target = rawPath === undefined || rawPath === "" ? "." : rawPath;
	const head = makeHead("Ls", renderPath(target, theme, snapshot.context.cwd), meta, snapshot);

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
		layout: "inline",
		head,
		sections: sectionsOf(
			reuseToolSection(snapshot.context.state, theme, "ls-output", [output], () =>
				section(outputLines.map((line) => theme.fg("toolOutput", line)), { preview: true, slot: "result" }),
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

function mcpArgumentsSection(args: unknown, expanded: boolean): ToolSection | undefined {
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
	return section(lines, { label: "Arguments", slot: "call", preview: true });
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
			mcpArgumentsSection(snapshot.args ?? snapshot.context.args, snapshot.context.expanded),
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
	const args = asRecord(snapshot.args ?? snapshot.context.args);
	const title = MCP_RESOURCE_TITLES[toolName] ?? "MCP Resource";
	const reading = toolName === "read_mcp_resource";
	const server = argValue(args, "server");
	const uri = argValue(args, "uri");

	const meta: string[] = [];
	if (reading && server !== undefined && server !== WRONG_TYPE) {
		meta.push(singleLineText(`server: ${server}`));
	}

	const target = reading
		? uri === undefined
			? PENDING
			: uri === WRONG_TYPE
				? INVALID_ARG
				: normalizeDisplayText(uri)
		: server === undefined
			? "all servers"
			: server === WRONG_TYPE
				? INVALID_ARG
				: normalizeDisplayText(server);
	const head = makeHead(title, target, meta, snapshot);

	const consumed = new Set<string>(reading ? ["server", "uri"] : ["server"]);
	const remainingArgs = args
		? Object.fromEntries(Object.entries(args).filter(([key]) => !consumed.has(key)))
		: undefined;

	const output = extractToolText(snapshot.result, snapshot.context.showImages).trim();
	const view: ToolView = {
		layout: "framed",
		head,
		sections: sectionsOf(
			mcpArgumentsSection(remainingArgs, snapshot.context.expanded),
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
		case "generic":
		case "web":
			return genericView(toolName, snapshot);
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
	return producer ? producer(snapshot, theme) : genericView(toolName, snapshot);
}
