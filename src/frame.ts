import { keyHint, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	Text,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { getIconMode } from "./settings.js";
import { formatToolTitle } from "./tool-icon.js";
import { getToolSpinnerFrame, toolSpinnerFrame } from "./tool-spinner.js";
import type { EntryLinesComponent, ToolSection, ToolSnapshot, ToolView } from "./tool-presentation.js";
import type { ToolChildBounds, ToolLayout } from "./tool-renderer.js";

const RESET = "\u001b[0m";
const DEFAULT_PADDING = 1;
const TERMINAL_IMAGE_SEQUENCES = [
	"\u001b_G", // Kitty graphics protocol
	"\u001b]1337;File=", // iTerm2 inline images
] as const;
const SIXEL_SEQUENCE = /(?:\u001bP|\u0090)[0-9;]*q/u;
// SDK wrapping can retain a grapheme wider than its width. These are the branches
// that can exceed the usual one/two-cell base width in Pi's graphemeWidth.
const DEFENSIVE_PADDED_ROW = /[\t\r\n\p{Mark}\uFF00-\uFFEF\u0E33\u0EB3]/u;


export function containsTerminalImage(lines: readonly string[]): boolean {
	return lines.some((line) =>
		TERMINAL_IMAGE_SEQUENCES.some((sequence) => line.includes(sequence))
			|| SIXEL_SEQUENCE.test(line),
	);
}

interface RenderedSection {
	section: ToolSection;
	rows: readonly string[];
}

/**
 * Compose a single semantic card and assign intact sections to the two Pi slots.
 * Interaction routing belongs to ToolPresentation; bounds retain the real children.
 */
export function layoutToolView(
	view: ToolView,
	snapshot: ToolSnapshot,
	theme: Theme,
	width: number,
	spinnerFrameIndex?: number,
): ToolLayout {
	const outerWidth = Math.max(1, Math.floor(width));
	const framed = view.layout === "framed";
	const padding = framed
		? normalizePadding(snapshot.context.outputPad)
		: Math.min(normalizePadding(snapshot.context.outputPad), Math.floor((outerWidth - 1) / 2));
	const childWidth = Math.max(1, outerWidth - (framed ? 2 : 0) - 2 * padding);
	const rendered = new Map<Component, readonly string[]>();
	const sections: RenderedSection[] = [];
	// Rendering is done before decoration or previews: an image escapes the entire card.
	for (const section of view.sections) {
		let childRows = rendered.get(section.component);
		if (!childRows) {
			childRows = section.component.render(childWidth);
			rendered.set(section.component, childRows);
		}
		sections.push({ section, rows: childRows });
	}
	const layout: ToolLayout = {
		callRows: [],
		resultRows: [],
		callChildBounds: [],
		resultChildBounds: [],
		callOffset: 0,
		resultOffset: 0,
	};
	const callBounds: ToolChildBounds[] = [];
	const resultBounds: ToolChildBounds[] = [];
	layout.callChildBounds = callBounds;
	layout.resultChildBounds = resultBounds;
	const hasResult = snapshot.result !== undefined;
	if (sections.some(({ rows }) => containsTerminalImage(rows))) {
		for (const slot of ["call", "result"] as const) {
			const output = slot === "call" || !hasResult ? layout.callRows : layout.resultRows;
			const bounds = slot === "call" || !hasResult ? callBounds : resultBounds;
			for (const entry of sections) {
				if (entry.section.slot !== slot || entry.rows.length === 0) continue;
				bounds.push({ component: entry.section.component, x: 0, y: output.length, width: childWidth, height: entry.rows.length });
				output.push(...entry.rows);
			}
		}
		layout.resultOffset = layout.callRows.length;
		return layout;
	}

	const borderColor: ThemeColor = view.tone === "error" || view.head.status === "error"
		? "error"
		: view.tone === "warning" || view.head.status === "cancelled"
			? "warning"
			: view.head.status === "pending" || view.head.status === "running"
				? "accent"
				: "borderMuted";
	const background = theme.getBgAnsi(borderColor === "error" ? "toolErrorBg"
		: view.head.status === "pending" || view.head.status === "running" ? "toolPendingBg" : "toolSuccessBg");
	const paint = (line: string) => {
		if (!background) return line;
		// Reapply the card background after any SGR resetting it, including compound SGRs.
		const stabilized = line.replace(/\u001b\[([0-9;]*)m/gu, (sequence: string, parameters: string) => {
			const codes = parameters.split(";");
			for (let index = 0; index < codes.length; index++) {
				const code = codes[index];
				if (code === "" || code === "0" || code === "49") return sequence + background;
				// RGB/palette channels may contain 0 or 49 without being SGR resets.
				if (code === "38" || code === "48" || code === "58") {
					index += codes[index + 1] === "2" ? 4 : codes[index + 1] === "5" ? 2 : 0;
				}
			}
			return sequence;
		});
		return background + stabilized + "\u001b[49m";
	};
	const border = (text: string) => theme.fg(borderColor, text);
	const capWidth = Math.min(3, Math.max(0, outerWidth - 2));
	const cap = "─".repeat(capWidth);
	const barBudget = Math.max(0, outerWidth - capWidth - 4);
	const bar = (left: string, right: string, label: string) => {
		const text = barBudget > 0 && label ? ` ${truncateToWidth(label, barBudget, "…")} ` : "";
		const fill = "─".repeat(Math.max(0, outerWidth - 2 - capWidth - visibleWidth(text)));
		return paint(border(left + cap) + text + border(fill + right));
	};
	const pad = " ".repeat(padding);
	const body = (line: string, padded = false) => {
		// Children own their ANSI text. Close styles/links only outside their content.
		const reset = line.includes("\u001b") ? "\u001b]8;;\u001b\\" + RESET : "";
		const fill = padded ? "" : " ".repeat(Math.max(0, childWidth - visibleWidth(line)));
		return paint(framed
			? border("│") + pad + line + reset + fill + pad + border("│")
			: pad + line + reset + fill + pad);
	};
	const headerWidth = Math.max(0, outerWidth - (framed ? Math.min(3, outerWidth - 2) + 4 : 2 * padding));
	const header = semanticHeader(view, snapshot, theme, borderColor, headerWidth, spinnerFrameIndex);
	let headerText = header.text;
	let serializeHeader: (text: string) => string;
	if (framed) {
		headerText = barBudget > 0 ? truncateToWidth(headerText, barBudget, "…") : "";
		const gap = headerText ? " " : "";
		const fill = "─".repeat(Math.max(0, outerWidth - 2 - capWidth - header.width - 2 * gap.length));
		const left = border("╭" + cap) + gap;
		const right = gap + border(fill + "╮");
		serializeHeader = (text) => paint(left + text + right);
	} else {
		const reset = headerText.includes("\u001b") ? "\u001b]8;;\u001b\\" + RESET : "";
		const right = reset + " ".repeat(Math.max(0, childWidth - header.width)) + pad;
		serializeHeader = (text) => paint(pad + text + right);
	}
	const preparedHeader = serializeHeader(headerText);
	layout.callRows.push(preparedHeader);
	if (snapshot.presentation !== "generic" && !view.sections.some(({ component }) =>
		typeof component.handleMouse === "function" || typeof component.handleInput === "function",
	)) {
		const refreshText = header.refreshText;
		layout.refreshHeader = refreshText
			? (frameIndex) => { layout.callRows[0] = serializeHeader(refreshText(frameIndex)); }
			: () => { layout.callRows[0] = preparedHeader; };
	}
	if (header.fullTarget) {
		const section: ToolSection = {
			label: /^(?:bash|powershell|shell)$/iu.test(stripTerminalSequences(view.head.title)) ? "Command" : "Target",
			slot: "call",
			preview: false,
			renderedWidth: "padded",
			component: new Text(view.head.target, 0, 0),
		};
		sections.unshift({ section, rows: section.component.render(childWidth) });
	}
	for (const slot of ["call", "result"] as const) {
		const output = slot === "call" || !hasResult ? layout.callRows : layout.resultRows;
		const bounds = slot === "call" || !hasResult ? callBounds : resultBounds;
		for (const entry of sections) {
			if (entry.section.slot !== slot || entry.rows.length === 0) continue;
			const interactive = typeof entry.section.component.handleMouse === "function"
				|| typeof entry.section.component.handleInput === "function";
			let content: readonly string[] = entry.rows;
			let padded = entry.section.renderedWidth === "padded" && snapshot.presentation !== "generic" && !interactive;
			let hidden = 0;
			const preview = snapshot.presentation !== "generic" && !view.expanded && entry.section.preview !== false && !interactive
				? view.preview : undefined;
			if (preview?.unit === "entries") {
				padded = false;
				const entries = (entry.section.component as Partial<EntryLinesComponent>).entryLines;
				if (!entries) throw new Error("Entry previews require logical entryLines");
				const count = Math.max(0, Math.floor(preview.count));
				hidden = Math.max(0, entries.length - count);
				const selected = preview.edge === "tail" ? entries.slice(hidden) : entries.slice(0, count);
				content = selected.flatMap((line) => wrapTextWithAnsi(line, childWidth));
			} else if (snapshot.presentation !== "generic" && !interactive) {
				if (padded) {
					let wrapped: string[] | undefined;
					for (let index = 0; index < entry.rows.length; index++) {
						const line = entry.rows[index]!;
						if ((childWidth < 2 || DEFENSIVE_PADDED_ROW.test(line))
							&& (visibleWidth(line) > childWidth || line.includes("\n"))) {
							wrapped ??= entry.rows.slice(0, index);
							wrapped.push(...wrapTextWithAnsi(line, childWidth));
						} else {
							wrapped?.push(line);
						}
					}
					if (wrapped) {
						content = wrapped;
						padded = false;
					}
				} else {
					content = entry.rows.flatMap((line) => visibleWidth(line) > childWidth || line.includes("\n")
						? wrapTextWithAnsi(line, childWidth) : [line]);
				}
				if (preview) {
					const count = Math.max(0, Math.floor(preview.count));
					hidden = Math.max(0, content.length - count);
					content = preview.edge === "tail" ? content.slice(hidden) : content.slice(0, count);
				}
			}
			if (content.length === 0 && hidden === 0) continue;
			if (entry.section.label) {
				const label = theme.fg("muted", entry.section.label);
				output.push(framed ? bar("├", "┤", label) : body(truncateToWidth(label, childWidth, "…")));
			}
			if (content.length > 0) {
				bounds.push({ component: entry.section.component, x: padding + (framed ? 1 : 0), y: output.length, width: childWidth, height: content.length });
				for (const line of content) output.push(body(line, padded));
			}
			if (hidden > 0) {
				const unit = preview?.unit === "entries" ? "entries" : "lines";
				const hint = theme.fg("dim", `… ${hidden} more ${unit} ${keyHint("app.tools.expand", "to expand")}`);
				for (const line of wrapTextWithAnsi(hint, childWidth)) output.push(body(line));
			}
		}
	}
	if (framed) {
		(hasResult ? layout.resultRows : layout.callRows).push(paint(border(`╰${"─".repeat(Math.max(0, outerWidth - 2))}╯`)));
	}
	layout.resultOffset = layout.callRows.length;
	return layout;
}

function semanticHeader(view: ToolView, snapshot: ToolSnapshot, theme: Theme, color: ThemeColor, width: number, spinnerFrameIndex?: number) {
	const mode = getIconMode();
	const status = view.head.status;
	// The shell adapter supplies its native-loader clock; public tools isolate per render-context state.
	const runningSymbol = (frameIndex?: number) => frameIndex === undefined
		? toolSpinnerFrame(snapshot.context.state, mode) : getToolSpinnerFrame(mode, frameIndex);
	const symbol = mode === "off" ? status
		: status === "running" ? runningSymbol(spinnerFrameIndex)
			: status === "pending" ? mode === "nerd-font" ? "○" : "?"
				: status === "done" ? mode === "nerd-font" ? "✓" : "ok"
					: status === "error" ? mode === "nerd-font" ? "✗" : "!"
						: mode === "nerd-font" ? "⊘" : "-";
	const duration = view.head.durationMs;
	const final = status === "done" || status === "error" || status === "cancelled";
	const state = theme.fg(color, symbol);
	const timing = final && duration !== undefined && Number.isFinite(duration) && duration >= 0
		? theme.fg("dim", duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`) : "";
	const ending = [state, timing].filter(Boolean).join(" · ");
	const endingWidth = visibleWidth(ending);
	// Keep a target summary visible even when a long title or metadata competes with it.
	const targetReserve = view.head.target ? Math.min(16, Math.floor(width / 3)) : 0;
	const titleBudget = Math.max(0, width - endingWidth - 3 - targetReserve - (targetReserve ? 1 : 0));
	const title = theme.bold(theme.fg("toolTitle", truncateToWidth(formatToolTitle(view.head.title, mode), titleBudget, "…")));
	const metaBudget = Math.max(0, width - visibleWidth(title) - endingWidth - 6 - targetReserve - (targetReserve ? 1 : 0));
	const rawMeta = view.head.meta.filter(Boolean).join(" · ");
	const meta = metaBudget > 0 && rawMeta ? theme.fg("dim", truncateToWidth(rawMeta, metaBudget, "…")) : "";
	const fixed = [title, meta, ending].filter(Boolean).join(" · ");
	const targetBudget = Math.max(0, width - visibleWidth(fixed) - 1);
	const target = view.head.target;
	const multiline = target.includes("\n") || target.includes("\r");
	const fullTarget = view.expanded && Boolean(target) && (multiline || visibleWidth(target) > targetBudget);
	const summary = target.split(/\r?\n/u)[0] ?? "";
	const visibleTarget = !fullTarget && targetBudget > 0 && target
		? theme.fg("toolOutput", truncateToWidth(summary + (multiline ? " …" : ""), targetBudget, "…")) : "";
	const first = [title, visibleTarget].filter(Boolean).join(" ");
	const prefix = [first, meta].filter(Boolean).join(" · ");
	const beforeState = prefix ? prefix + " · " : "";
	const rawText = beforeState + ending;
	const text = truncateToWidth(rawText, width, "…");
	return {
		text,
		width: visibleWidth(text),
		fullTarget,
		// A running glyph is the last visible cell. If truncation removed it, the
		// prepared header is static; otherwise its one-cell budget never changes.
		...(status === "running" && mode !== "off" && visibleWidth(rawText) <= width
			? { refreshText: (frameIndex?: number) => beforeState + theme.fg(color, runningSymbol(frameIndex)) }
			: {}),
	};
}

function normalizePadding(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_PADDING;
	return Math.max(0, Math.floor(value));
}

