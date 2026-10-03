import type { IconMode } from "./tool-icon.js";

/** A public render-context state and its invalidation, never a Pi component. */
export interface ToolSpinnerTarget {
	state: object;
	invalidate: () => void;
}
interface SpinnerRuntime {
	frameIndex: number;
	targets: Set<WeakRef<ToolSpinnerTarget>>;
	references: WeakMap<object, WeakRef<ToolSpinnerTarget>>;
	timer: NodeJS.Timeout | undefined;
}
const SPINNER_RUNTIME_KEY = Symbol.for("pi-tools-style:tool-spinner");
const FRAME_INTERVAL_MS = 80;
const ASCII_FRAMES = ["|", "/", "-", "\\"] as const;
const NERD_FONT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Public tools use their gated ticker; shell may supply its native-loader clock index. */
export function getToolSpinnerFrame(mode: IconMode, frameIndex = getRuntime().frameIndex): string {
	const frames = mode === "nerd-font" ? NERD_FONT_FRAMES : ASCII_FRAMES;
	return frames[frameIndex % frames.length]!;
}

/** Unconfirmed replay/export states use a static initial frame. */
export function toolSpinnerFrame(state: object, mode: IconMode): string {
	const current = getRuntime();
	const ref = current.references.get(state);
	if (ref && current.targets.has(ref) && ref.deref()) return getToolSpinnerFrame(mode);
	return mode === "nerd-font" ? NERD_FONT_FRAMES[0] : ASCII_FRAMES[0];
}

export function setToolSpinnerActive(target: ToolSpinnerTarget, active: boolean): void {
	const current = getRuntime();
	let ref = current.references.get(target.state);
	if (!active) {
		if (ref?.deref() === target) {
			current.targets.delete(ref);
			current.references.delete(target.state);
		}
		stopTickerIfIdle(current);
		return;
	}
	if (!ref || ref.deref() !== target) {
		if (ref) current.targets.delete(ref);
		ref = new WeakRef(target);
		current.references.set(target.state, ref);
	}
	current.targets.add(ref);
	if (!current.timer) {
		current.timer = setInterval(() => tick(current), FRAME_INTERVAL_MS);
		current.timer.unref?.();
	}
}

export function clearToolSpinners(): void {
	const current = getRuntime();
	clearInterval(current.timer);
	current.timer = undefined;
	current.frameIndex = 0;
	current.targets.clear();
	current.references = new WeakMap();
}

function tick(current: SpinnerRuntime): void {
	current.frameIndex++;
	for (const ref of current.targets) {
		const target = ref.deref();
		if (!target) { current.targets.delete(ref); continue; }
		try {
			target.invalidate();
		} catch {
			// Detached TUI contexts cannot keep a presentation ticker alive.
			current.targets.delete(ref);
			if (current.references.get(target.state) === ref) current.references.delete(target.state);
		}
	}
	stopTickerIfIdle(current);
}
function stopTickerIfIdle(current: SpinnerRuntime): void {
	if (current.targets.size > 0 || !current.timer) return;
	clearInterval(current.timer);
	current.timer = undefined;
	current.frameIndex = 0;
}
function getRuntime(): SpinnerRuntime {
	const current = Reflect.get(globalThis, SPINNER_RUNTIME_KEY) as SpinnerRuntime | undefined;
	if (current?.targets instanceof Set) return current;
	// Reload replaces the old private-component ticker, not a second clock.
	clearInterval(current?.timer);
	const next: SpinnerRuntime = { frameIndex: 0, targets: new Set(), references: new WeakMap(), timer: undefined };
	Reflect.set(globalThis, SPINNER_RUNTIME_KEY, next);
	return next;
}
