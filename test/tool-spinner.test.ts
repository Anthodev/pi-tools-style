import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToolSpinners, getToolSpinnerFrame, setToolSpinnerActive, toolSpinnerFrame, type ToolSpinnerTarget } from "../src/tool-spinner.ts";

function target(): ToolSpinnerTarget {
	return { state: {}, invalidate: vi.fn() };
}
beforeEach(() => { vi.useFakeTimers(); clearToolSpinners(); });
afterEach(() => { clearToolSpinners(); vi.useRealTimers(); });

describe("shared public-context animation", () => {
	it("reads a static glyph without starting a timer for replay or export", () => {
		const state = {};
		expect(getToolSpinnerFrame("ascii")).toBe("|");
		expect(toolSpinnerFrame(state, "nerd-font")).toBe("⠋");
		vi.advanceTimersByTime(800);
		expect(vi.getTimerCount()).toBe(0);
		expect(toolSpinnerFrame(state, "nerd-font")).toBe("⠋");
	});

	it("uses explicit native-shell phase without registering a row or advancing replay/export", () => {
		const replay = {};
		expect(getToolSpinnerFrame("ascii", 0)).toBe("|");
		expect(getToolSpinnerFrame("ascii", 1)).toBe("/");
		expect(getToolSpinnerFrame("nerd-font", 0)).toBe("⠋");
		expect(getToolSpinnerFrame("nerd-font", 1)).toBe("⠙");
		vi.advanceTimersByTime(80);
		expect(getToolSpinnerFrame("ascii")).toBe("|");
		expect(toolSpinnerFrame(replay, "nerd-font")).toBe("⠋");
		expect(vi.getTimerCount()).toBe(0);
	});

	for (const mode of ["ascii", "off", "nerd-font"] as const) {
		it(`advances ${mode} glyphs every 80ms through public invalidation`, () => {
			const current = target();
			setToolSpinnerActive(current, true);
			expect(toolSpinnerFrame(current.state, mode)).toBe(mode === "nerd-font" ? "⠋" : "|");
			vi.advanceTimersByTime(80);
			expect(current.invalidate).toHaveBeenCalledOnce();
			expect(toolSpinnerFrame(current.state, mode)).toBe(mode === "nerd-font" ? "⠙" : "/");
		});
	}

	it("uses one ticker for multiple live rows and does not animate an unrelated state", () => {
		const first = target(); const second = target();
		setToolSpinnerActive(first, true); setToolSpinnerActive(second, true); setToolSpinnerActive(first, true);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(80);
		expect(first.invalidate).toHaveBeenCalledOnce(); expect(second.invalidate).toHaveBeenCalledOnce();
		expect(toolSpinnerFrame({}, "ascii")).toBe("|");
	});

	it("stops immediately when the last row completes or is disabled", () => {
		const current = target(); setToolSpinnerActive(current, true);
		vi.advanceTimersByTime(80); vi.mocked(current.invalidate).mockClear();
		setToolSpinnerActive(current, false);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(800);
		expect(current.invalidate).not.toHaveBeenCalled();
		expect(getToolSpinnerFrame("ascii")).toBe("|");
	});

	it("clears all references and cadence on session shutdown", () => {
		const current = target(); setToolSpinnerActive(current, true);
		clearToolSpinners(); vi.advanceTimersByTime(800);
		expect(vi.getTimerCount()).toBe(0);
		expect(current.invalidate).not.toHaveBeenCalled();
		expect(toolSpinnerFrame(current.state, "ascii")).toBe("|");
	});

	it("drops a target whose public invalidation throws, without affecting another live row", () => {
		const broken = { state: {}, invalidate: vi.fn(() => { throw Error("closed session"); }) };
		const live = target(); setToolSpinnerActive(broken, true); setToolSpinnerActive(live, true);
		expect(() => vi.advanceTimersByTime(80)).not.toThrow();
		vi.advanceTimersByTime(80);
		expect(broken.invalidate).toHaveBeenCalledOnce(); expect(live.invalidate).toHaveBeenCalledTimes(2);
	});
});
