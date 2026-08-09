import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const RESET = "\u001b[0m";
const DEFAULT_PADDING = 1;
const MINIMUM_FRAME_WIDTH = 5;
const HORIZONTAL_RULE = /^[─━═╌╍┄┅┈┉-]+$/u;
const TERMINAL_IMAGE_SEQUENCES = [
	"\u001b_G", // Kitty graphics protocol
	"\u001b]1337;File=", // iTerm2 inline images
	"\u001bPq", // Sixel device control string
	"\u0090q", // Eight-bit Sixel device control string
] as const;

export interface FrameOptions {
	horizontalPadding?: number;
	styleBorder?: (value: string) => string;
	title?: string;
}

export function frameContentWidth(
	width: number,
	horizontalPadding = DEFAULT_PADDING,
): number {
	const padding = normalizePadding(horizontalPadding);
	return Math.max(0, Math.floor(width) - 2 - padding * 2);
}

export function frameLines(
	sourceLines: readonly string[],
	width: number,
	options: FrameOptions = {},
): string[] {
	const lines = [...sourceLines];
	const outerWidth = Math.floor(width);
	const padding = normalizePadding(options.horizontalPadding);

	if (
		lines.length === 0 ||
		outerWidth < MINIMUM_FRAME_WIDTH ||
		containsTerminalImage(lines)
	) {
		return lines;
	}

	const contentWidth = frameContentWidth(outerWidth, padding);
	if (contentWidth < 1) return lines;

	const styleBorder = options.styleBorder ?? identity;
	const horizontalPadding = " ".repeat(padding);
	const top = renderTopBorder(outerWidth, options.title, styleBorder);
	const bottom = styleBorder(`╰${"─".repeat(outerWidth - 2)}╯`);
	const body = lines.map((line) => {
		const content = truncateToWidth(line, contentWidth, "");
		const remaining = Math.max(0, contentWidth - visibleWidth(content));

		const reset = content.includes("\u001b") ? RESET : "";
		return `${styleBorder("│")}${horizontalPadding}${content}${reset}${" ".repeat(
			remaining,
		)}${horizontalPadding}${styleBorder("│")}`;
	});

	return [top, ...body, bottom];
}

export function containsTerminalImage(lines: readonly string[]): boolean {
	return lines.some((line) =>
		TERMINAL_IMAGE_SEQUENCES.some((sequence) => line.includes(sequence)),
	);
}

export function trimOuterRules(sourceLines: readonly string[]): string[] {
	const lines = [...sourceLines];

	const firstRuleIndex =
		lines.length > 1 &&
		stripTerminalSequences(lines[0] ?? "").trim() === "" &&
		isHorizontalRule(lines[1] ?? "")
			? 1
			: 0;
	const lastRuleIndex = lines.length - 1;

	if (
		firstRuleIndex < lastRuleIndex &&
		isHorizontalRule(lines[firstRuleIndex] ?? "") &&
		isHorizontalRule(lines[lastRuleIndex] ?? "")
	) {
		return lines.slice(firstRuleIndex + 1, lastRuleIndex);
	}

	return lines;
}

function renderTopBorder(
	width: number,
	rawTitle: string | undefined,
	styleBorder: (value: string) => string,
): string {
	const title = normalizeTitle(rawTitle);
	const maxTitleWidth = Math.max(0, width - 6);

	if (!title || maxTitleWidth < 1) {
		return styleBorder(`╭${"─".repeat(width - 2)}╮`);
	}

	const visibleTitle = truncateToWidth(title, maxTitleWidth, "");
	const prefix = `╭─ ${visibleTitle} `;
	const fill = "─".repeat(Math.max(1, width - visibleWidth(prefix) - 1));
	return `${styleBorder(prefix)}${styleBorder(fill)}${styleBorder("╮")}`;
}

function isHorizontalRule(line: string): boolean {
	const visible = stripTerminalSequences(line).trim();
	return visible.length > 0 && HORIZONTAL_RULE.test(visible);
}

function normalizePadding(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_PADDING;
	return Math.max(0, Math.floor(value));
}

function normalizeTitle(value: string | undefined): string {
	if (!value) return "";
	return stripTerminalSequences(value).replace(/\s+/gu, " ").trim();
}

function identity(value: string): string {
	return value;
}
