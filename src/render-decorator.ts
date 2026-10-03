import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, keyHint, keyText, truncateTail } from "@earendil-works/pi-coding-agent";
import type { Theme, TruncationResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getIconMode, isShellEnabledByConfig } from "./settings.js";
import type { IconMode } from "./tool-icon.js";
import { getToolTheme } from "./tool-category.js";
import { getToolRendererRuntimeState, reportShellIncompatibility } from "./tool-renderer.js";
import type { ToolLayout, ToolRendererImplementation } from "./tool-renderer.js";
import type { ToolSnapshot, ToolStatus, ToolView, ToolViewFactory } from "./tool-presentation.js";

export type ShellInstallStatus = "already-installed" | "installed" | "unsupported";
export interface ShellRendererComponentType { readonly prototype: object; }
type ShellRender = (this: Component, width: number) => string[];
type ShellStatus = "running" | "complete" | "error" | "cancelled";
interface ShellAdapterRecord { originalDescriptor: PropertyDescriptor | undefined; wrapper: ShellRender; }
interface ShellAdapterRegistry { adapters: WeakMap<object, ShellAdapterRecord>; }
interface ShellCache {
	command: string; output: string; status: ShellStatus; expanded: boolean; colorKey: string; outputPad: number;
	exitCode: number | null | undefined; privateTruncated: boolean | undefined; maxBytes: number | undefined; fullOutputPath: string | undefined;
	width: number; revision: number; tick: number; mode: IconMode; themeColors: Theme["colors"];
	themeColorMode: string | undefined; themeAppearance: Theme["appearance"]; cancelKey: string; expandHint: string;
	factory: ToolViewFactory; layout: ToolRendererImplementation["layoutToolView"];
	truncation: TruncationResult; view: ToolView; snapshot: ToolSnapshot; prepared: ToolLayout; rows: string[];
}
interface ShellItem { state: Record<string, unknown>; invalidate: () => void; cache?: ShellCache; }
const SHELL_DECORATOR_KEY = Symbol.for("pi-tools-style:shell-render");
const OUTPUT_LIMITS = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };
const STATUS: Record<ShellStatus, ToolStatus> = { running: "running", complete: "done", error: "error", cancelled: "cancelled" };

function readRegistry(): ShellAdapterRegistry | undefined {
	const value: unknown = Reflect.get(globalThis, SHELL_DECORATOR_KEY);
	return typeof value === "object" && value !== null && Reflect.get(value, "adapters") instanceof WeakMap
		? value as ShellAdapterRegistry : undefined;
}

/** Only BashExecutionComponent.render is adapted; its methods and native child tree stay untouched. */
export function installShellRenderer(component: ShellRendererComponentType): ShellInstallStatus {
	try {
		const prototype = component.prototype;
		const registry = readRegistry() ?? { adapters: new WeakMap<object, ShellAdapterRecord>() };
		const installed = registry.adapters.get(prototype);
		if (installed) return Object.getOwnPropertyDescriptor(prototype, "render")?.value === installed.wrapper ? "already-installed" : "unsupported";
		const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
		const original: unknown = Reflect.get(prototype, "render");
		if (typeof original !== "function" || typeof Reflect.get(prototype, "getCommand") !== "function" || typeof Reflect.get(prototype, "getOutput") !== "function") return "unsupported";
		if (originalDescriptor && !("value" in originalDescriptor)) return "unsupported";
		if (!Reflect.set(globalThis, SHELL_DECORATOR_KEY, registry)) return "unsupported";
		const wrapper = createShellRenderer(original as ShellRender);
		Object.defineProperty(prototype, "render", { ...(originalDescriptor ?? { configurable: true, enumerable: false, writable: true }), value: wrapper });
		registry.adapters.set(prototype, { originalDescriptor, wrapper });
		return "installed";
	} catch {
		return "unsupported";
	}
}

/** Restore the original own descriptor, or inheritance, only while our wrapper still owns render. */
export function uninstallShellRenderer(component: ShellRendererComponentType): boolean {
	try {
		const registry = readRegistry();
		const prototype = component.prototype;
		const installed = registry?.adapters.get(prototype);
		if (!installed || Object.getOwnPropertyDescriptor(prototype, "render")?.value !== installed.wrapper) return false;
		if (installed.originalDescriptor) Object.defineProperty(prototype, "render", installed.originalDescriptor);
		else if (!Reflect.deleteProperty(prototype, "render")) return false;
		registry!.adapters.delete(prototype);
		return true;
	} catch {
		return false;
	}
}

function createShellRenderer(original: ShellRender): ShellRender {
	const items = new WeakMap<Component, ShellItem>();
	return function renderShell(width: number): string[] {
		const runtime = getToolRendererRuntimeState();
		if (!runtime.enabled || !isShellEnabledByConfig()) return original.call(this, width);
		let rows: string[] | undefined;
		let checkingInternals = false;
		try {
			const implementation = runtime.implementation;
			const theme = getToolTheme();
			const outerWidth = Math.floor(width);
			if (implementation && theme && Number.isFinite(width) && outerWidth >= 5) {
				checkingInternals = true;
				const outputPad: unknown = Reflect.get(this, "outputPad");
				checkingInternals = !(typeof outputPad === "number" && Number.isFinite(outputPad) && outputPad >= 0
					&& outerWidth < Math.max(5, 3 + 2 * Math.floor(outputPad)));
				const getCommand: unknown = Reflect.get(this, "getCommand");
				const getOutput: unknown = Reflect.get(this, "getOutput");
				const status: unknown = Reflect.get(this, "status");
				const expanded: unknown = Reflect.get(this, "expanded");
				const colorKey: unknown = Reflect.get(this, "colorKey");
				const exitCode: unknown = Reflect.get(this, "exitCode");
				const fullOutputPath: unknown = Reflect.get(this, "fullOutputPath");
				const privateTruncation: unknown = Reflect.get(this, "truncationResult");
				const loader: unknown = Reflect.get(this, "loader");
				const privateTruncated = typeof privateTruncation === "object" && privateTruncation !== null ? Reflect.get(privateTruncation, "truncated") as unknown : undefined;
				const maxBytes = typeof privateTruncation === "object" && privateTruncation !== null ? Reflect.get(privateTruncation, "maxBytes") as unknown : undefined;
				const compatible = typeof getCommand === "function" && typeof getOutput === "function"
					&& (status === "running" || status === "complete" || status === "error" || status === "cancelled")
					&& typeof expanded === "boolean" && (colorKey === "dim" || colorKey === "bashMode")
					&& typeof outputPad === "number" && Number.isFinite(outputPad) && outputPad >= 0
					&& (exitCode === undefined || exitCode === null || (typeof exitCode === "number" && Number.isFinite(exitCode)))
					&& (fullOutputPath === undefined || typeof fullOutputPath === "string")
					&& (privateTruncation === undefined || (typeof privateTruncation === "object" && privateTruncation !== null && !Array.isArray(privateTruncation)))
					&& (privateTruncated === undefined || typeof privateTruncated === "boolean")
					&& (maxBytes === undefined || (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes >= 0))
					&& (status !== "running" || (typeof loader === "object" && loader !== null && typeof Reflect.get(loader, "render") === "function"));
				if (!compatible && checkingInternals) {
					checkingInternals = false;
					reportShellIncompatibility();
				}
				if (compatible && checkingInternals) {
					const command: unknown = getCommand.call(this);
					const output: unknown = getOutput.call(this);
					checkingInternals = false;
					if (typeof command !== "string" || typeof output !== "string") reportShellIncompatibility();
					if (typeof command === "string" && typeof output === "string") {
						const themeColors = theme.colors;
						const themeColorMode = theme.getColorMode?.();
						const themeAppearance = theme.appearance;
						const cancelKey = keyText("tui.select.cancel");
						const expandHint = keyHint("app.tools.expand", "to expand");
						let item = items.get(this);
						if (!item) { item = { state: {}, invalidate: () => this.invalidate() }; items.set(this, item); }
						const cache = item.cache;
						const mode = getIconMode();
						const tick = status === "running" && mode !== "off" ? Math.floor(Date.now() / 80) : 0;
						if (cache && cache.command === command && cache.output === output && cache.status === status && cache.expanded === expanded
							&& cache.colorKey === colorKey && cache.outputPad === outputPad && cache.exitCode === exitCode
							&& cache.privateTruncated === privateTruncated && cache.maxBytes === maxBytes && cache.fullOutputPath === fullOutputPath
							&& cache.revision === runtime.revision && cache.mode === mode && cache.themeColors === themeColors
							&& cache.themeColorMode === themeColorMode && cache.themeAppearance === themeAppearance
							&& cache.cancelKey === cancelKey && cache.expandHint === expandHint
							&& cache.factory === implementation.createToolView && cache.layout === implementation.layoutToolView) {
							if (cache.width === outerWidth && cache.tick === tick) return cache.rows;
							if (cache.width === outerWidth && cache.prepared.refreshHeader) {
								cache.prepared.refreshHeader(tick);
								cache.rows[0] = cache.prepared.callRows[0]!;
								cache.tick = tick;
								return cache.rows;
							}
							// Resize or an implementation without a prepared header still uses the complete layout.
							const layout = implementation.layoutToolView(cache.view, cache.snapshot, theme, outerWidth, tick);
							cache.rows = layout.callRows.concat(layout.resultRows);
							cache.prepared = layout;
							cache.width = outerWidth;
							cache.tick = tick;
							return cache.rows;
						}
						const truncation = cache?.output === output ? cache.truncation : truncateTail(output, OUTPUT_LIMITS);
						const args = { command };
						const snapshot: ToolSnapshot = {
							args, presentation: "builtin",
							result: { content: [{ type: "text", text: truncation.content }], details: {
								truncation: { truncated: privateTruncated === true || truncation.truncated, maxBytes: truncation.truncated ? truncation.maxBytes : maxBytes ?? truncation.maxBytes },
								...(fullOutputPath !== undefined ? { fullOutputPath } : {}),
							} },
							// Direct !/!! executions have no public tool-call identity or recorded duration.
							context: { args, toolCallId: "", state: item.state, lastComponent: undefined, invalidate: item.invalidate,
								cwd: process.cwd(), argsComplete: true, executionStarted: true, isPartial: status === "running",
								expanded, isError: status === "error", showImages: false, outputPad, durationMs: undefined },
						};
						const view = implementation.createToolView("bash", snapshot, theme);
						let meta = view.head.meta;
						if (colorKey === "dim" || status === "cancelled" || (status === "error" && typeof exitCode === "number")) {
							const extra = [...meta];
							if (colorKey === "dim") extra.push("!! · excluded from context");
							if (status === "cancelled") extra.push("cancelled");
							else if (status === "error" && typeof exitCode === "number") extra.push(`exit ${exitCode}`);
							meta = extra;
						}
						const viewForShell: ToolView = { ...view, head: { title: "Shell", target: view.head.target, status: STATUS[status], meta },
							...(status === "cancelled" ? { tone: "warning" } : {}),
							sections: status === "running" ? [...view.sections, { slot: "result", preview: false,
								component: new Text(theme.fg("muted", `Running... (${cancelKey} to cancel)`), 0, 0) }] : view.sections,
						};
						const layout = implementation.layoutToolView(viewForShell, snapshot, theme, outerWidth, tick);
						const renderedRows = layout.callRows.concat(layout.resultRows);
						rows = renderedRows;
						item.cache = { command, output, status, expanded, colorKey, outputPad, exitCode, privateTruncated, maxBytes, fullOutputPath,
							width: outerWidth, revision: runtime.revision, tick, mode, themeColors, factory: implementation.createToolView, layout: implementation.layoutToolView,
							themeColorMode, themeAppearance, cancelKey, expandHint,
							truncation, view: viewForShell, snapshot, prepared: layout, rows: renderedRows };
					}
				}
			}
		} catch {
			if (checkingInternals) reportShellIncompatibility();
			// Native rendering is deliberately outside this try: its errors must not trigger a second call.
		}
		return rows ?? original.call(this, width);
	};
}
