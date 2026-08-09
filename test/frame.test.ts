import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { frameLines, trimOuterRules } from "../src/frame.js";

const identity = (value: string) => value;

describe("frameLines", () => {
	it("renders a titled rounded frame at the requested width", () => {
		const lines = frameLines(["hello"], 18, {
			title: "read",
			styleBorder: identity,
		});

		expect(lines).toEqual([
			"╭─ read ─────────╮",
			"│ hello          │",
			"╰────────────────╯",
		]);
		expect(lines.every((line) => visibleWidth(line) === 18)).toBe(true);
	});

	it("measures ANSI-styled content by visible width", () => {
		const lines = frameLines(["\u001b[31mred\u001b[0m"], 12, {
			styleBorder: identity,
		});

		expect(lines.map(stripTerminalSequences)).toEqual([
			"╭──────────╮",
			"│ red      │",
			"╰──────────╯",
		]);
		expect(lines.every((line) => visibleWidth(line) === 12)).toBe(true);
	});

	it("truncates oversized content without exceeding terminal width", () => {
		const lines = frameLines(["abcdefghijk"], 10, {
			styleBorder: identity,
		});

		expect(lines.map(stripTerminalSequences)).toEqual([
			"╭────────╮",
			"│ abcdef │",
			"╰────────╯",
		]);
		expect(lines.every((line) => visibleWidth(line) === 10)).toBe(true);
	});

	it("fails open for widths too narrow to frame", () => {
		expect(frameLines(["abc"], 3, { styleBorder: identity })).toEqual(["abc"]);
	});

	it("does not frame terminal image control sequences", () => {
		const image = "\u001b_Gf=100,a=T;AAAA\u001b\\";

		expect(frameLines([image], 20, { styleBorder: identity })).toEqual([image]);
	});

	it("does not mutate caller-owned render arrays", () => {
		const source = ["hello"];

		frameLines(source, 12, { styleBorder: identity });

		expect(source).toEqual(["hello"]);
	});
});

describe("trimOuterRules", () => {
	it("removes AFT/native horizontal chrome only at outer edges", () => {
		const lines = ["", "\u001b[2m────────\u001b[0m", "body", "────────"];

		expect(trimOuterRules(lines)).toEqual(["body"]);
	});

	it("preserves horizontal rules inside content", () => {
		expect(trimOuterRules(["first", "────", "last"])).toEqual([
			"first",
			"────",
			"last",
		]);
	});
	it("preserves a lone horizontal rule returned as tool content", () => {
		expect(trimOuterRules(["────────"])).toEqual(["────────"]);
	});
});
