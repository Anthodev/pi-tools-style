import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, initTheme, keyText, truncateTail } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installShellRenderer, uninstallShellRenderer } from "../src/render-decorator.js";
import { layoutToolView } from "../src/frame.js";
import { getToolTheme, setThemeProvider } from "../src/tool-category.js";
import { createToolView } from "../src/tool-presentation.js";
import { loadSettings, saveSettings, setIconMode } from "../src/settings.js";
import { clearToolSpinners } from "../src/tool-spinner.js";
import { invalidateToolPresentations, setShellCompatibilityNotifier, setToolRendererEnabled, setToolRendererImplementation } from "../src/tool-renderer.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

class NativeShell {
	command = "printf SHELL_COMMAND";
	output = "";
	status = "running";
	expanded = false;
	colorKey = "bashMode";
	outputPad = 1;
	exitCode: number | undefined;
	fullOutputPath: string | undefined;
	truncationResult: { truncated: boolean; maxBytes: number } | undefined;
	loader = { render: vi.fn(() => ["NATIVE_LOADING"]), invalidate: vi.fn() };
	children = [{ render: vi.fn(() => ["NATIVE_CHILD"]), invalidate: vi.fn() }];
	nativeWidths: number[] = [];
	getCommand() { return this.command; }
	getOutput() { return this.output; }
	invalidate() {}
	render(width: number) { this.nativeWidths.push(width); return [`NATIVE ${width} ${this.command}`, this.output]; }
}
class Shell extends NativeShell {}
class OwnShell extends NativeShell { override render(width: number) { return super.render(width); } }
const text = (shell: Shell, width = 100) => shell.render(width).map(stripTerminalSequences).join("\n");

let configDirectory: string;
let configPath: string;
beforeEach(async () => {
	configDirectory = await mkdtemp(join(tmpdir(), "tools-style-shell-"));
	configPath = join(configDirectory, "settings.json");
	await loadSettings(configPath);
});
afterEach(async () => {
	await loadSettings(join(configDirectory, "missing.json"));
	await rm(configDirectory, { recursive: true, force: true });
});

beforeEach(() => {
	vi.useFakeTimers(); vi.setSystemTime(0); initTheme("dark", false); clearToolSpinners(); setIconMode("ascii");
	setShellCompatibilityNotifier(undefined);
	setToolRendererEnabled(true); setToolRendererImplementation({ createToolView, layoutToolView }); setThemeProvider(() => theme);
});
afterEach(() => {
	setShellCompatibilityNotifier(undefined);
	uninstallShellRenderer(Shell); uninstallShellRenderer(OwnShell); setThemeProvider(undefined); clearToolSpinners();
	setToolRendererImplementation(undefined); setToolRendererEnabled(true); setIconMode("ascii"); vi.useRealTimers();
});

describe("isolated shell renderer installation", () => {
	it("installs once across reload without touching inherited render, methods, or child trees", () => {
		const inherited = NativeShell.prototype.render;
		const getCommand = Shell.prototype.getCommand;
		const getOutput = Shell.prototype.getOutput;
		const shell = new Shell();
		const children = shell.children;
		const loader = shell.loader;
		expect(Object.hasOwn(Shell.prototype, "render")).toBe(false);
		expect(installShellRenderer(Shell)).toBe("installed");
		const wrapper = Shell.prototype.render;
		expect(installShellRenderer(Shell)).toBe("already-installed");
		expect(Shell.prototype.render).toBe(wrapper);
		text(shell);
		expect(NativeShell.prototype.render).toBe(inherited);
		expect(Shell.prototype.getCommand).toBe(getCommand);
		expect(Shell.prototype.getOutput).toBe(getOutput);
		expect(shell.children).toBe(children);
		expect(shell.loader).toBe(loader);
		expect(shell.nativeWidths).toEqual([]);
		expect(uninstallShellRenderer(Shell)).toBe(true);
		expect(Object.hasOwn(Shell.prototype, "render")).toBe(false);
		expect(Shell.prototype.render).toBe(inherited);
		expect(uninstallShellRenderer(Shell)).toBe(false);
	});
	it("restores an original own descriptor exactly", () => {
		const original = Object.getOwnPropertyDescriptor(OwnShell.prototype, "render");
		expect(installShellRenderer(OwnShell)).toBe("installed");
		expect(uninstallShellRenderer(OwnShell)).toBe(true);
		expect(Object.getOwnPropertyDescriptor(OwnShell.prototype, "render")).toEqual(original);
	});
	it("does not overwrite or uninstall a later third-party render owner", () => {
		installShellRenderer(Shell); const ours = Shell.prototype.render;
		const replacement = vi.fn(() => ["THIRD_PARTY"]);
		Object.defineProperty(Shell.prototype, "render", { value: replacement, configurable: true, writable: true });
		expect(installShellRenderer(Shell)).toBe("unsupported");
		expect(uninstallShellRenderer(Shell)).toBe(false);
		expect(Shell.prototype.render).toBe(replacement);
		Object.defineProperty(Shell.prototype, "render", { value: ours, configurable: true, writable: true });
	});
	it("fails open on incompatible prototypes without disabling public tool styling", () => {
		class Incompatible { render() { return ["NATIVE"]; } }
		const original = Incompatible.prototype.render;
		expect(installShellRenderer(Incompatible)).toBe("unsupported");
		expect(Incompatible.prototype.render).toBe(original);
	});
	it("replaces live legacy framing without trusting its stale marker or losing native descriptor ownership", () => {
		class LegacyShell extends NativeShell {}
		const key = Symbol.for("pi-tools-style:shell-render");
		const previousRegistry: unknown = Reflect.get(globalThis, key);
		const legacy = function (this: NativeShell, width: number) {
			const config: unknown = Reflect.get(globalThis, key);
			return typeof config === "object" && config !== null && Reflect.get(config, "enabled") === true
				? ["LEGACY_FRAME"] : NativeShell.prototype.render.call(this, width);
		};
		Object.defineProperty(LegacyShell.prototype, key, { value: true, configurable: false, writable: false });
		Object.defineProperty(LegacyShell.prototype, "render", { value: legacy, configurable: true, writable: true });
		const legacyDescriptor = Object.getOwnPropertyDescriptor(LegacyShell.prototype, "render");
		const row = new LegacyShell(); row.status = "complete"; row.output = "LIVE_LEGACY_OUTPUT";
		const native = NativeShell.prototype.render.call(row, 83); row.nativeWidths.length = 0;
		try {
			Reflect.set(globalThis, key, { key, enabled: true });
			expect(row.render(83)).toEqual(["LEGACY_FRAME"]);
			expect(installShellRenderer(LegacyShell)).toBe("installed");
			const wrapper = LegacyShell.prototype.render;
			expect(installShellRenderer(LegacyShell)).toBe("already-installed");
			expect(LegacyShell.prototype.render).toBe(wrapper);
			const styled = row.render(83).map(stripTerminalSequences);
			expect(styled.filter((line) => line.startsWith("╭"))).toHaveLength(1);
			expect(styled.join("\n")).toContain("LIVE_LEGACY_OUTPUT");
			expect(styled.join("\n")).not.toContain("LEGACY_FRAME");
			setToolRendererEnabled(false);
			expect(row.render(83)).toEqual(native);
			expect(row.nativeWidths).toEqual([83]);
			setToolRendererEnabled(true);
			expect(text(row, 83)).not.toContain("LEGACY_FRAME");
			expect(uninstallShellRenderer(LegacyShell)).toBe(true);
			expect(Object.getOwnPropertyDescriptor(LegacyShell.prototype, "render")).toEqual(legacyDescriptor);
			expect(Reflect.get(LegacyShell.prototype, key)).toBe(true);
		} finally {
			uninstallShellRenderer(LegacyShell);
			if (previousRegistry === undefined) Reflect.deleteProperty(globalThis, key);
			else Reflect.set(globalThis, key, previousRegistry);
		}
	});
});

describe("shared semantic shell view", () => {
	it("bypasses guarded internals and forwards exact width when only direct Shell is OFF", async () => {
		installShellRenderer(Shell);
		const shell = new Shell(); shell.status = "complete"; shell.output = "SHELL_CURRENT";
		const notify = vi.fn(); setShellCompatibilityNotifier(notify);
		await saveSettings({ shellEnabled: false }, configPath);
		Object.defineProperty(shell, "status", { configurable: true, get: () => { throw new Error("private status must not be read"); } });
		expect(shell.render(83.5)).toEqual(["NATIVE 83.5 printf SHELL_COMMAND", "SHELL_CURRENT"]);
		expect(shell.nativeWidths).toEqual([83.5]);
		expect(notify).not.toHaveBeenCalled();
		Object.defineProperty(shell, "status", { configurable: true, writable: true, value: "complete" });
		shell.output = "UPDATED_DURING_SHELL_OFF";
		await saveSettings({ shellEnabled: true }, configPath);
		expect(text(shell)).toContain("UPDATED_DURING_SHELL_OFF");
		expect(text(shell)).toContain("Shell");
	});

	it("retains the prepared Shell body across model Bash-only preference changes", async () => {
		const factory = vi.fn(createToolView); const layout = vi.fn(layoutToolView);
		setToolRendererImplementation({ createToolView: factory, layoutToolView: layout });
		installShellRenderer(Shell);
		const shell = new Shell(); shell.status = "complete"; shell.output = "RETAINED_SHELL_BODY";
		const rows = shell.render(80);
		await saveSettings({ tools: { bash: false } }, configPath); invalidateToolPresentations("bash");
		expect(shell.render(80)).toBe(rows);
		expect(factory).toHaveBeenCalledOnce(); expect(layout).toHaveBeenCalledOnce();
		await saveSettings({ tools: { bash: true } }, configPath); invalidateToolPresentations("bash");
		expect(shell.render(80)).toBe(rows);
		expect(factory).toHaveBeenCalledOnce(); expect(layout).toHaveBeenCalledOnce();
	});
	it("shows command, streamed output, native cancel hint and a pure 80ms spinner with no added timer", () => {
		const factory = vi.fn(createToolView);
		setToolRendererImplementation({ createToolView: factory, layoutToolView });
		installShellRenderer(Shell); const shell = new Shell();
		const beforeTimers = vi.getTimerCount();
		const initial = text(shell);
		expect(initial).toContain("Shell"); expect(initial).toContain("$ printf SHELL_COMMAND");
		expect(initial).toContain(`Running... (${keyText("tui.select.cancel")} to cancel)`);
		shell.output = "STREAM_ONE\nSTREAM_TWO\n";
		expect(text(shell)).toContain("STREAM_ONE"); expect(text(shell)).toContain("STREAM_TWO");
		const beforeTickFactories = factory.mock.calls.length;
		const frame = text(shell); vi.advanceTimersByTime(80);
		expect(text(shell)).not.toBe(frame);
		expect(vi.getTimerCount()).toBe(beforeTimers);
		expect(factory).toHaveBeenCalledTimes(beforeTickFactories);
		text(shell, 120);
		expect(factory).toHaveBeenCalledTimes(beforeTickFactories);
		shell.status = "complete"; shell.exitCode = 0;
		const final = text(shell); expect(final).toContain("ok"); expect(final).not.toContain("Running...");
		vi.advanceTimersByTime(800); expect(text(shell)).toBe(final);
		expect(shell.getOutput()).toBe("STREAM_ONE\nSTREAM_TWO\n");
	});
	it("uses tail ten visual lines, keeps command expansion, and expands existing rows", () => {
		installShellRenderer(Shell); const shell = new Shell(); shell.status = "complete";
		shell.command = "printf FIRST_COMMAND\nprintf SECOND_COMMAND";
		shell.output = Array.from({ length: 16 }, (_, i) => `SHELL_LINE_${String(i + 1).padStart(2, "0")}`).join("\n");
		const collapsed = text(shell);
		expect(collapsed).not.toContain("SHELL_LINE_01"); expect(collapsed).toContain("SHELL_LINE_07"); expect(collapsed).toContain("SHELL_LINE_16");
		expect(collapsed).not.toContain("SECOND_COMMAND"); expect(collapsed).toContain("6 more lines");
		shell.expanded = true;
		const expanded = text(shell); expect(expanded).toContain("SHELL_LINE_01"); expect(expanded).toContain("SECOND_COMMAND"); expect(expanded).toContain("Command");
		expect(shell.getOutput()).toBe(shell.output);
	});
	it("shows real nonzero exit code, distinct cancellation, and context exclusion", () => {
		installShellRenderer(Shell); const shell = new Shell(); shell.output = "FAILURE_OUTPUT"; shell.status = "error"; shell.exitCode = 42;
		expect(text(shell)).toContain("exit 42"); expect(text(shell)).toContain("FAILURE_OUTPUT");
		shell.status = "cancelled"; shell.exitCode = undefined; shell.colorKey = "dim";
		const cancelled = text(shell, 150);
		expect(cancelled).toContain("cancelled"); expect(cancelled).toContain("!! · excluded from context"); expect(cancelled).not.toContain("exit 42"); expect(cancelled).not.toContain("Running...");
	});
	it("applies Pi's native tail line/byte limits before the shared visual preview", () => {
		const factory = vi.fn(createToolView); setToolRendererImplementation({ createToolView: factory, layoutToolView });
		installShellRenderer(Shell); const shell = new Shell(); shell.status = "complete"; shell.expanded = true;
		shell.output = Array.from({ length: DEFAULT_MAX_LINES + 5 }, (_, i) => `NATIVE_LIMIT_LINE_${String(i + 1).padStart(4, "0")}`).join("\n");
		shell.fullOutputPath = "/tmp/full-shell-output.log";
		const before = shell.getOutput();
		const rendered = text(shell);
		const snapshot = factory.mock.calls[0]![1];
		expect(snapshot.result?.content).toEqual([{ type: "text", text: truncateTail(before, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content }]);
		expect(rendered).not.toContain("NATIVE_LIMIT_LINE_0001"); expect(rendered).toContain("NATIVE_LIMIT_LINE_0006");
		expect(rendered).toContain("Truncated"); expect(rendered).toContain("Full output: /tmp/full-shell-output.log");
		expect(shell.getOutput()).toBe(before);
		shell.output = "BYTE_HEAD\n" + "x".repeat(DEFAULT_MAX_BYTES + 100) + "\nBYTE_TAIL";
		text(shell);
		expect(factory.mock.calls.at(-1)![1].result?.content).toEqual([{ type: "text", text: truncateTail(shell.output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content }]);
	});
	it("accepts absent optional completion metadata", () => {
		installShellRenderer(Shell); const shell = new Shell(); shell.status = "complete"; shell.output = "OPTIONAL_FIELDS_ABSENT";
		Reflect.deleteProperty(shell, "exitCode"); Reflect.deleteProperty(shell, "fullOutputPath"); Reflect.deleteProperty(shell, "truncationResult"); Reflect.deleteProperty(shell, "loader");
		expect(text(shell)).toContain("Shell"); expect(text(shell)).toContain("OPTIONAL_FIELDS_ABSENT"); expect(shell.nativeWidths).toEqual([]);
	});
	it("reads current enabled state, theme, icons and factories rather than an installation snapshot", () => {
		const factory = vi.fn(createToolView); setToolRendererImplementation({ createToolView: factory, layoutToolView });
		installShellRenderer(Shell); const shell = new Shell(); shell.status = "complete"; shell.output = "RUNTIME_ROW";
		const first = text(shell); expect(factory).toHaveBeenCalledTimes(1); expect(text(shell)).toBe(first); expect(factory).toHaveBeenCalledTimes(1);
		setIconMode("off"); expect(text(shell)).toContain("done"); expect(factory).toHaveBeenCalledTimes(2);
		const secondTheme = { fg: (_color: string, value: string) => value, bold: (value: string) => value, getBgAnsi: () => "" } as unknown as Theme;
		setThemeProvider(() => secondTheme); text(shell); expect(factory).toHaveBeenCalledTimes(3); expect(getToolTheme()).toBe(secondTheme);
		const rebound = vi.fn(createToolView); setToolRendererImplementation({ createToolView: rebound, layoutToolView }); text(shell); expect(rebound).toHaveBeenCalledTimes(1);
		setToolRendererEnabled(false); expect(shell.render(100)).toEqual(["NATIVE 100 printf SHELL_COMMAND", "RUNTIME_ROW"]);
		setToolRendererEnabled(true); expect(text(shell)).toContain("Shell"); expect(rebound).toHaveBeenCalledTimes(2);
	});
	for (const status of ["running", "complete"] as const) it(`recolors the cached ${status} card through the same live public theme proxy`, () => {
		const factory = vi.fn(createToolView);
		setToolRendererImplementation({ createToolView: factory, layoutToolView });
		installShellRenderer(Shell);
		const shell = new Shell(); shell.status = status; shell.output = "THEME_BODY";
		const publicTheme = getToolTheme()!;
		const colors = publicTheme.colors;
		const before = shell.render(100);
		expect(factory).toHaveBeenCalledOnce();
		expect(shell.render(100)).toBe(before);
		initTheme("light", false);
		expect(getToolTheme()).toBe(publicTheme);
		expect(publicTheme.colors).not.toBe(colors);
		shell.invalidate();
		const after = shell.render(100);
		expect(after).not.toEqual(before);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(shell.render(100)).toBe(after);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(shell.nativeWidths).toEqual([]);
	});
	it("reuses a view when only public theme proxy identity changes and resolved colors stay identical", () => {
		const factory = vi.fn(createToolView);
		setToolRendererImplementation({ createToolView: factory, layoutToolView });
		installShellRenderer(Shell);
		const shell = new Shell(); shell.status = "complete";
		const firstProxy = new Proxy(theme, {});
		const secondProxy = new Proxy(theme, {});
		setThemeProvider(() => firstProxy);
		const before = shell.render(100);
		setThemeProvider(() => secondProxy);
		expect(secondProxy).not.toBe(firstProxy);
		expect(secondProxy.colors).toBe(firstProxy.colors);
		expect(shell.render(100)).toBe(before);
		expect(factory).toHaveBeenCalledOnce();
	});
	it("reprepares a retained shell when color mode or appearance changes without replacing resolved colors", () => {
		let colorMode = "truecolor";
		let appearance = "dark";
		const liveTheme = new Proxy(theme, { get: (target, key, receiver) => key === "getColorMode" ? () => colorMode : key === "appearance" ? appearance : Reflect.get(target, key, receiver) });
		setThemeProvider(() => liveTheme);
		const factory = vi.fn((...args: Parameters<typeof createToolView>) => {
			const view = createToolView(...args);
			return { ...view, head: { ...view.head, target: `${view.head.target} ${liveTheme.getColorMode()} ${liveTheme.appearance}` } };
		});
		setToolRendererImplementation({ createToolView: factory, layoutToolView });
		installShellRenderer(Shell);
		const shell = new Shell(); shell.status = "complete";
		const colors = liveTheme.colors;
		expect(text(shell)).toContain("truecolor dark");
		colorMode = "256color";
		expect(liveTheme.colors).toBe(colors);
		expect(text(shell)).toContain("256color dark");
		appearance = "light";
		expect(liveTheme.colors).toBe(colors);
		expect(text(shell)).toContain("256color light");
		expect(factory).toHaveBeenCalledTimes(3);
	});

	for (const width of [24, 80, 120]) for (const outputPad of [0, 1, 2]) it(`keeps Unicode rows inside width=${width}, padding=${outputPad}`, () => {
		installShellRenderer(Shell); const shell = new Shell(); shell.status = "complete"; shell.outputPad = outputPad;
		shell.output = "UNICODE 漢😀 e\u0301 ".repeat(8);
		const rows = shell.render(width);
		expect(rows.some((line) => stripTerminalSequences(line).startsWith("╭"))).toBe(true);
		expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
	});
});

describe("exact single native fallback", () => {
	for (const width of [0, 1, 4, 4.75, Number.NaN, Number.POSITIVE_INFINITY]) it(`calls native once at unchanged width=${width}`, () => {
		const warning = vi.fn(); setShellCompatibilityNotifier(warning);
		installShellRenderer(Shell); const shell = new Shell();
		expect(shell.render(width)).toEqual([`NATIVE ${width} printf SHELL_COMMAND`, ""]);
		expect(shell.nativeWidths).toEqual([width]);
		expect(warning).not.toHaveBeenCalled();
	});
	for (const [key, value] of [
		["status", "unknown"], ["expanded", undefined], ["colorKey", "unexpected"], ["outputPad", Number.NaN], ["outputPad", Infinity], ["outputPad", -1],
		["exitCode", Number.NaN], ["fullOutputPath", 4], ["truncationResult", "invalid"], ["truncationResult", { truncated: "yes" }], ["truncationResult", { maxBytes: Infinity }],
		["loader", undefined], ["getCommand", undefined], ["getOutput", () => 4], ["getCommand", () => ({ command: "invalid" })], ["getOutput", () => { throw new Error("getter failed"); }],
	] as const) it(`guards incompatible ${key} without changing native width`, () => {
		const warning = vi.fn(); setShellCompatibilityNotifier(warning);
		installShellRenderer(Shell); const shell = new Shell(); Reflect.set(shell, key, value);
		expect(shell.render(80)).toEqual(["NATIVE 80 printf SHELL_COMMAND", ""]); expect(shell.nativeWidths).toEqual([80]);
		expect(warning).toHaveBeenCalledOnce();
		expect(shell.render(80)).toEqual(["NATIVE 80 printf SHELL_COMMAND", ""]);
		expect(warning).toHaveBeenCalledOnce();
	});
	it("falls back once on factory/layout exceptions and never swallows native errors", () => {
		installShellRenderer(Shell); const shell = new Shell();
		const warning = vi.fn(); setShellCompatibilityNotifier(warning);
		setToolRendererImplementation({ createToolView: () => { throw new Error("view failed"); }, layoutToolView });
		shell.render(81); expect(shell.nativeWidths).toEqual([81]);
		setToolRendererImplementation({ createToolView, layoutToolView: () => { throw new Error("layout failed"); } });
		shell.render(82); expect(shell.nativeWidths).toEqual([81, 82]);
		expect(warning).not.toHaveBeenCalled();
		const original = OwnShell.prototype.render;
		let nativeCalls = 0;
		Object.defineProperty(OwnShell.prototype, "render", { configurable: true, writable: true, value() { nativeCalls++; throw new Error("native failed"); } });
		installShellRenderer(OwnShell);
		expect(() => new OwnShell().render(83)).toThrow("native failed"); expect(nativeCalls).toBe(1);
		uninstallShellRenderer(OwnShell); Object.defineProperty(OwnShell.prototype, "render", { configurable: true, writable: true, value: original });
	});
	it("restores the original before output arrives and after final completion on the same row", () => {
		installShellRenderer(Shell); const shell = new Shell();
		setToolRendererEnabled(false); shell.render(40); expect(shell.nativeWidths).toEqual([40]);
		setToolRendererEnabled(true); text(shell, 40); expect(shell.nativeWidths).toEqual([40]);
		shell.output = "FINAL_OUTPUT"; shell.status = "complete"; setToolRendererEnabled(false); shell.render(40);
		expect(shell.nativeWidths).toEqual([40, 40]);
		setToolRendererEnabled(true); expect(text(shell, 40)).toContain("FINAL_OUTPUT");
	});
	it("reports no incompatibility for disabled styles or padding-narrow cards, even with an unknown status", () => {
		const warning = vi.fn(); setShellCompatibilityNotifier(warning);
		installShellRenderer(Shell);
		const shell = new Shell(); shell.status = "unknown";
		setToolRendererEnabled(false);
		shell.render(80);
		expect(warning).not.toHaveBeenCalled();
		setToolRendererEnabled(true);
		shell.outputPad = 2;
		shell.render(6);
		expect(warning).not.toHaveBeenCalled();
		shell.render(80);
		expect(warning).toHaveBeenCalledOnce();
		expect(shell.nativeWidths).toEqual([80, 6, 80]);
	});
	it("replaces and releases the session-linked notification and ignores a detached UI failure", () => {
		installShellRenderer(Shell);
		const shell = new Shell(); shell.status = "unknown";
		const first = vi.fn(); const second = vi.fn();
		setShellCompatibilityNotifier(first);
		shell.render(80); shell.render(80);
		expect(first).toHaveBeenCalledOnce();
		setShellCompatibilityNotifier(second);
		shell.render(80);
		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
		setShellCompatibilityNotifier(undefined);
		shell.render(80);
		expect(second).toHaveBeenCalledOnce();
		setShellCompatibilityNotifier(() => { throw new Error("stale UI"); });
		expect(shell.render(80)).toEqual(["NATIVE 80 printf SHELL_COMMAND", ""]);
		expect(shell.nativeWidths).toEqual([80, 80, 80, 80, 80]);
	});
	it("falls back without a bound public theme or implementation", () => {
		installShellRenderer(Shell); const shell = new Shell(); setThemeProvider(undefined);
		shell.render(80); expect(shell.nativeWidths).toEqual([80]);
		setThemeProvider(() => theme); setToolRendererImplementation(undefined);
		shell.render(81); expect(shell.nativeWidths).toEqual([80, 81]);
	});
});
