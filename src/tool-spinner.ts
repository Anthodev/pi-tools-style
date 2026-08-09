import type { IconMode } from "./tool-icon.js";

interface SpinnerUi {
  requestRender?: () => void;
}

interface ToolSpinnerTarget {
  executionStarted?: unknown;
  isPartial?: unknown;
  ui?: SpinnerUi;
}

interface SpinnerRuntime {
  frameIndex: number;
  targets: Map<object, number>;
  timer: NodeJS.Timeout | undefined;
}

const SPINNER_RUNTIME_KEY = Symbol.for("pi-tools-style:tool-spinner");
const FRAME_INTERVAL_MS = 80;
const STALE_TARGET_MS = 2_000;
const ASCII_FRAMES = ["|", "/", "-", "\\"] as const;
const NERD_FONT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function toolSpinnerFrame(
  target: object,
  mode: IconMode,
): string | undefined {
  const runtime = getRuntime();
  if (!isExecuting(target)) {
    runtime.targets.delete(target);
    stopTickerIfIdle(runtime);
    return undefined;
  }

  runtime.targets.set(target, Date.now());
  ensureTicker(runtime);
  const frames = mode === "nerd-font" ? NERD_FONT_FRAMES : ASCII_FRAMES;
  return frames[runtime.frameIndex % frames.length];
}

export function clearToolSpinners(): void {
  const runtime = getRuntime();
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = undefined;
  runtime.frameIndex = 0;
  runtime.targets.clear();
}

function ensureTicker(runtime: SpinnerRuntime): void {
  if (runtime.timer) return;

  runtime.timer = setInterval(() => tick(runtime), FRAME_INTERVAL_MS);
  runtime.timer.unref?.();
}

function tick(runtime: SpinnerRuntime): void {
  runtime.frameIndex += 1;
  const now = Date.now();
  const activeUis = new Set<SpinnerUi>();

  for (const [target, lastSeenAt] of runtime.targets) {
    if (!isExecuting(target) || now - lastSeenAt > STALE_TARGET_MS) {
      runtime.targets.delete(target);
      continue;
    }
    const ui = readTarget(target).ui;
    if (ui) activeUis.add(ui);
  }

  for (const ui of activeUis) {
    try {
      ui.requestRender?.();
    } catch {
      // Presentation failure must never affect tool execution.
    }
  }

  stopTickerIfIdle(runtime);
}

function stopTickerIfIdle(runtime: SpinnerRuntime): void {
  if (runtime.targets.size > 0 || !runtime.timer) return;
  clearInterval(runtime.timer);
  runtime.timer = undefined;
  runtime.frameIndex = 0;
}

function isExecuting(target: object): boolean {
  const fields = readTarget(target);
  return fields.executionStarted === true && fields.isPartial === true;
}

function readTarget(target: object): ToolSpinnerTarget {
  return target as ToolSpinnerTarget;
}

function getRuntime(): SpinnerRuntime {
  const current = Reflect.get(globalThis, SPINNER_RUNTIME_KEY) as
    | SpinnerRuntime
    | undefined;
  if (current) return current;

  const runtime: SpinnerRuntime = {
    frameIndex: 0,
    targets: new Map(),
    timer: undefined,
  };
  Reflect.set(globalThis, SPINNER_RUNTIME_KEY, runtime);
  return runtime;
}
