import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real filesystem throughout; only the rename entry is pausable so a queued
// menu write can outlive an immediate Escape (same pattern as settings.test.ts).
const ioHooks: { beforeRename: ((...args: unknown[]) => Promise<void>) | undefined } = { beforeRename: undefined };
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		rename: async (...args: Parameters<typeof actual.rename>) => {
			await ioHooks.beforeRename?.(...args);
			return actual.rename(...args);
		},
	};
});
import { BashExecutionComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext, ToolInfo, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import type { Mock } from "vitest";
import { Text, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import * as settings from "../src/settings.ts";
import { isToolRendererEnabled, setShellCompatibilityNotifier, setToolRendererEnabled } from "../src/tool-renderer.ts";
import { uninstallShellRenderer } from "../src/render-decorator.js";

import toolsStyleExtension, { installToolsStyle } from "../index.js";
import {
	getToolTheme,
	setThemeProvider,
} from "../src/tool-category.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

type SessionStartHook = (event: unknown, context: ExtensionContext) => Promise<void>;
type SessionShutdownHook = () => Promise<void>;

let configDirectory: string;
let configPath: string;
const durableSave = settings.saveSettings;
const durableLoad = settings.loadSettings;
beforeEach(async () => {
	configDirectory = await mkdtemp(join(tmpdir(), "tools-style-extension-"));
	configPath = join(configDirectory, "settings.json");
	await durableLoad(configPath);
	vi.spyOn(settings, "saveSettings").mockImplementation((patch) => durableSave(patch, configPath));
});
afterEach(async () => {
	await durableLoad(join(configDirectory, "missing.json"));
	await rm(configDirectory, { recursive: true, force: true });
});

afterEach(() => {
	setThemeProvider(undefined); setShellCompatibilityNotifier(undefined); setToolRendererEnabled(true);
	vi.restoreAllMocks(); vi.useRealTimers();
});

describe("tools style extension", () => {
	it("registers no tools and exposes long and short command names", async () => {
		const registerTool = vi.fn();
		const registerCommand = vi.fn();
		const on = vi.fn();
		const registerToolRenderer = vi.fn();
		const originalRender = ToolExecutionComponent.prototype.render;

		toolsStyleExtension({ on, registerCommand, registerTool, registerToolRenderer, getAllTools: () => [] } as never);

		expect(registerTool).not.toHaveBeenCalled();
		expect(registerToolRenderer).toHaveBeenCalledOnce();
		expect(ToolExecutionComponent.prototype.render).toBe(originalRender);
		expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
		expect(on).toHaveBeenCalledWith("tool_execution_start", expect.any(Function));
		expect(on).toHaveBeenCalledWith("tool_execution_end", expect.any(Function));
		expect(registerCommand).toHaveBeenCalledTimes(2);
		expect(registerCommand).toHaveBeenCalledWith(
			"tools-style",
			expect.objectContaining({ description: expect.any(String) }),
		);
		expect(registerCommand).toHaveBeenCalledWith(
			"tstyle",
			expect.objectContaining({ description: expect.any(String) }),
		);

		const command = registerCommand.mock.calls.find(
			([name]) => name === "tools-style",
		)?.[1] as {
			handler: (
				args: string,
				context: { ui: { notify: Mock } },
			) => Promise<void>;
		};
		const notify = vi.fn();

		await command.handler("off", { ui: { notify } });
		await command.handler("on", { ui: { notify } });

		expect(notify).toHaveBeenNthCalledWith(1, "Tool boxes disabled.");
		expect(notify).toHaveBeenNthCalledWith(2, "Tool boxes enabled.");
	});

	it("shows usage instead of toggling for an unknown action", async () => {
		const registerCommand = vi.fn();
		toolsStyleExtension({
			on: vi.fn(),
			registerCommand,
			registerTool: vi.fn(),
			registerToolRenderer: vi.fn(),
			getAllTools: () => [],
		} as never);
		const command = registerCommand.mock.calls.find(
			([name]) => name === "tools-style",
		)?.[1] as {
			handler: (
				args: string,
				context: { ui: { notify: Mock } },
			) => Promise<void>;
		};
		const notify = vi.fn();

		await command.handler("typo", { ui: { notify } });

		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(
			"Usage: /tools-style [on|off|config|icons ascii|icons nerd-font|icons off]",
			"warning",
		);
	});

	it("keeps public tool rendering available and shows the exact incompatible-shell warning", async () => {
		uninstallShellRenderer(BashExecutionComponent);
		const outputDescriptor = Object.getOwnPropertyDescriptor(BashExecutionComponent.prototype, "getOutput")!;
		Object.defineProperty(BashExecutionComponent.prototype, "getOutput", { configurable: true, value: undefined });
		try {
			const registerCommand = vi.fn();
			const on = vi.fn();
			const registerToolRenderer = vi.fn();
			toolsStyleExtension({ on, registerCommand, registerToolRenderer, getAllTools: () => [] } as never);
			const command = registerCommand.mock.calls.find(([name]) => name === "tools-style")![1] as {
				handler: (args: string, context: { ui: { notify: Mock } }) => Promise<void>;
			};
			const notify = vi.fn();
			initTheme("dark", false);
			vi.spyOn(settings, "loadSettings").mockResolvedValue(undefined);
			const start = on.mock.calls.find(([event]) => event === "session_start")![1] as SessionStartHook;
			const shutdown = on.mock.calls.find(([event]) => event === "session_shutdown")![1] as SessionShutdownHook;
			await start({}, { hasUI: true, ui: { notify, theme } } as never);
			await command.handler("on", { ui: { notify } });
			expect(notify).toHaveBeenNthCalledWith(1, "Shell styling unavailable: incompatible Pi renderer internals.", "warning");
			expect(notify).toHaveBeenNthCalledWith(2, "Tool boxes enabled.");
			await command.handler("on", { ui: { notify } });
			expect(notify.mock.calls.filter(([message]) => message === "Shell styling unavailable: incompatible Pi renderer internals.")).toHaveLength(1);
			const resolver = registerToolRenderer.mock.calls[0]![0] as ToolRendererResolver;
			const renderers = resolver("custom", () => ({ renderCall: () => new Text("PUBLIC_TOOL_STILL_WORKS", 0, 0) }));
			initTheme("dark", false);
			const row = new ToolExecutionComponent("custom", "shell-unsupported", {}, {}, renderers, { requestRender: vi.fn() } as never, process.cwd());
			expect(row.render(80).map(stripTerminalSequences).join("\n")).toContain("PUBLIC_TOOL_STILL_WORKS");
			await shutdown();
		} finally {
			Object.defineProperty(BashExecutionComponent.prototype, "getOutput", outputDescriptor);
		}
	});

	it("releases the session theme provider on shutdown", async () => {
		const on = vi.fn();
		toolsStyleExtension({
			on,
			registerCommand: vi.fn(),
			registerTool: vi.fn(),
			registerToolRenderer: vi.fn(),
			getAllTools: () => [],
		} as never);
		const sessionStart = on.mock.calls.find(
			([event]) => event === "session_start",
		)?.[1] as (
			event: unknown,
			context: { ui: { theme: { fg: (_color: string, value: string) => string } } },
		) => Promise<void>;
		const sessionShutdown = on.mock.calls.find(
			([event]) => event === "session_shutdown",
		)?.[1] as () => Promise<void>;

		await sessionStart({}, {
			ui: { theme: { fg: (_color, value) => `theme:${value}` } },
		});
		expect(getToolTheme()?.fg("muted", "│")).toBe("theme:│");

		await sessionShutdown();
		expect(getToolTheme()).toBeUndefined();
	});
	it("surfaces encountered shell-field incompatibility once per interactive session while public tools stay enabled", async () => {
		vi.useFakeTimers(); initTheme("dark", false);
		vi.spyOn(settings, "loadSettings").mockResolvedValue(undefined);
		const on = vi.fn(); const registerToolRenderer = vi.fn();
		toolsStyleExtension({ on, registerCommand: vi.fn(), registerToolRenderer, getAllTools: () => [] } as never);
		const start = on.mock.calls.find(([event]) => event === "session_start")![1] as SessionStartHook;
		const shutdown = on.mock.calls.find(([event]) => event === "session_shutdown")![1] as SessionShutdownHook;
		const firstNotify = vi.fn(); const nextNotify = vi.fn();
		await start({}, { hasUI: true, ui: { notify: firstNotify, theme } } as never);
		const shell = new BashExecutionComponent("printf GUARDED_SHELL", { requestRender: vi.fn() } as never);
		shell.appendOutput("GUARDED_OUTPUT"); shell.setComplete(0, false);
		const nativeRender = Object.getPrototypeOf(BashExecutionComponent.prototype).render as (this: BashExecutionComponent, width: number) => string[];
		const native = nativeRender.call(shell, 80);
		Reflect.set(shell, "status", "future-status");
		try {
			expect(shell.render(80)).toEqual(native);
			expect(shell.render(80)).toEqual(native);
			expect(firstNotify).toHaveBeenCalledOnce();
			expect(firstNotify).toHaveBeenCalledWith("Shell styling unavailable: incompatible Pi renderer internals.", "warning");
			expect(isToolRendererEnabled()).toBe(true);
			const resolver = registerToolRenderer.mock.calls[0]![0] as ToolRendererResolver;
			const renderer = resolver("custom", () => ({ renderCall: () => new Text("PUBLIC_TOOL_AFTER_GUARD", 0, 0) }));
			const row = new ToolExecutionComponent("custom", "guarded-shell", {}, {}, renderer, { requestRender: vi.fn() } as never, process.cwd());
			expect(row.render(80).map(stripTerminalSequences).join("\n")).toContain("PUBLIC_TOOL_AFTER_GUARD");
			await shutdown();
			shell.render(80);
			expect(firstNotify).toHaveBeenCalledOnce();
			await start({ reason: "reload" }, { hasUI: true, ui: { notify: nextNotify, theme } } as never);
			expect(shell.render(80)).toEqual(native);
			expect(nextNotify).toHaveBeenCalledOnce();
			expect(firstNotify).toHaveBeenCalledOnce();
		} finally {
			Reflect.set(shell, "status", "complete");
			await shutdown();
		}
	});
	it("keeps headless/export contexts silent on incompatible shell shapes", async () => {
		vi.useFakeTimers(); initTheme("dark", false);
		vi.spyOn(settings, "loadSettings").mockResolvedValue(undefined);
		const on = vi.fn();
		toolsStyleExtension({ on, registerCommand: vi.fn(), registerToolRenderer: vi.fn(), getAllTools: () => [] } as never);
		const start = on.mock.calls.find(([event]) => event === "session_start")![1] as SessionStartHook;
		const shutdown = on.mock.calls.find(([event]) => event === "session_shutdown")![1] as SessionShutdownHook;
		const notify = vi.fn();
		await start({}, { hasUI: false, ui: { notify, theme } } as never);
		const shell = new BashExecutionComponent("printf HEADLESS", { requestRender: vi.fn() } as never);
		shell.setComplete(0, false); Reflect.set(shell, "status", "future-status");
		try {
			shell.render(80);
			expect(notify).not.toHaveBeenCalled();
		} finally {
			Reflect.set(shell, "status", "complete");
			await shutdown();
		}
	});
	it("reloads settings and providers without resetting the user's disabled choice or stacking shell wrappers", async () => {
		initTheme("dark", false);
		const load = vi.spyOn(settings, "loadSettings").mockResolvedValue(undefined);
		const firstOn = vi.fn(); const nextOn = vi.fn();
		const api = (on: Mock) => ({ on, registerCommand: vi.fn(), registerToolRenderer: vi.fn(), getAllTools: () => [] });
		toolsStyleExtension(api(firstOn) as never);
		const firstStart = firstOn.mock.calls.find(([event]) => event === "session_start")![1] as SessionStartHook;
		const firstShutdown = firstOn.mock.calls.find(([event]) => event === "session_shutdown")![1] as SessionShutdownHook;
		const publicTheme = theme;
		await firstStart({}, { hasUI: true, ui: { notify: vi.fn(), theme: publicTheme } } as never);
		setToolRendererEnabled(false);
		const wrapper = BashExecutionComponent.prototype.render;
		await firstShutdown();
		toolsStyleExtension(api(nextOn) as never);
		const nextStart = nextOn.mock.calls.find(([event]) => event === "session_start")![1] as SessionStartHook;
		const nextShutdown = nextOn.mock.calls.find(([event]) => event === "session_shutdown")![1] as SessionShutdownHook;
		try {
			await nextStart({ reason: "reload" }, { hasUI: true, ui: { notify: vi.fn(), theme: publicTheme } } as never);
			expect(load).toHaveBeenCalledTimes(2);
			expect(isToolRendererEnabled()).toBe(false);
			expect(BashExecutionComponent.prototype.render).toBe(wrapper);
			expect(firstOn.mock.calls).toHaveLength(4);
			expect(nextOn.mock.calls).toHaveLength(4);
			expect(getToolTheme()).toBe(publicTheme);
		} finally {
			await nextShutdown();
		}
	});
	it("reads the current exact configured web list after installation and keeps promotion sticky", () => {
		initTheme("dark", false);
		const name = "mcp__my_web__search";
		const metadata = {
			name, description: "Offline fixture", exposure: "direct", parameters: { type: "object", properties: {} },
			namespace: { name: "mcp__my_web" },
			sourceInfo: { source: "builtin", path: "builtin:mcp", scope: "temporary", origin: "top-level" },
		} as ToolInfo;
		const configured = vi.spyOn(settings, "getWebSearchTools").mockReturnValue([]);
		const registerToolRenderer = vi.fn();
		const installation = installToolsStyle({ registerToolRenderer, getAllTools: () => [metadata] } as never);
		try {
			const resolver = registerToolRenderer.mock.calls[0]![0] as ToolRendererResolver;
			const renderer = resolver(name, () => ({ renderShell: "self", renderCall: () => new Text("CONFIGURED_PROVIDER", 0, 0) }))!;
			const component = new ToolExecutionComponent(name, "configured", { query: "initial" }, {}, renderer, { requestRender: vi.fn() } as never, process.cwd());
			expect(component.render(80).map(stripTerminalSequences).join("\n")).not.toContain("Web Search");
			configured.mockReturnValue([name]);
			component.updateArgs({ query: "configured-after-install" });
			expect(component.render(80).map(stripTerminalSequences).join("\n")).toContain("Web Search");
			configured.mockReturnValue([]);
			component.updateArgs({ query: "sticky-after-config-removal" });
			const sticky = component.render(80).map(stripTerminalSequences).join("\n");
			expect(sticky).toContain("Web Search"); expect(sticky).toContain("sticky-after-config-removal");
		} finally {
			installation.session.shutdown();
			configured.mockRestore();
		}
	});
});

describe("configuration commands coordinate actual choices and durability", () => {
	function commands() {
		const registerCommand = vi.fn(); const on = vi.fn(); const getAllTools = vi.fn(() => [{
			name: "read", description: "fixture", exposure: "direct",
			sourceInfo: { source: "builtin", path: "builtin:read" },
		} as ToolInfo]);
		toolsStyleExtension({ on, registerCommand, registerToolRenderer: vi.fn(), getAllTools } as never);
		const long = registerCommand.mock.calls.find(([name]) => name === "tools-style")![1] as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
		const short = registerCommand.mock.calls.find(([name]) => name === "tstyle")![1] as typeof long;
		getAllTools.mockClear();
		return { long, short, on, getAllTools };
	}

	for (const alias of ["long", "short"] as const) it(`opens config through ${alias} and applies a real SettingsList exact-tool choice`, async () => {
		initTheme("dark", false);
		const registered = commands();
		const notify = vi.fn(); const requestRender = vi.fn();
		const custom = vi.fn(async (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Component) => {
			let close!: () => void;
			const closed = new Promise<void>((resolve) => { close = resolve; });
			const component = factory({ requestRender }, theme, {}, close);
			expect(component.render(80).map(stripTerminalSequences).join("\n")).toContain("read");
			component.handleInput!("read");
			component.handleInput!("\r");
			expect(settings.getSettings().tools.read).toBe(false);
			component.handleInput!("\x1b");
			await closed;
			Reflect.get(component, "dispose")?.call(component);
		});
		await registered[alias].handler("config", { mode: "tui", hasUI: true, ui: { custom, notify, theme } } as never);
		await settings.loadSettings(configPath);
		expect(custom).toHaveBeenCalledOnce();
		expect(settings.getSettings().tools.read).toBe(false);
		expect(notify).not.toHaveBeenCalled();
		expect(registered.getAllTools).toHaveBeenCalledOnce();
	});

	it("lets Escape close immediately but makes SDK shutdown await the pending real menu write after synchronous teardown", async () => {
		initTheme("dark", false);
		setThemeProvider(() => theme);
		const registered = commands();
		let unblock!: () => void; let reachedRename!: () => void;
		const gate = new Promise<void>((resolve) => { unblock = resolve; });
		const entered = new Promise<void>((resolve) => { reachedRename = resolve; });
		ioHooks.beforeRename = async () => {
			ioHooks.beforeRename = undefined;
			reachedRename();
			await gate;
		};
		const notify = vi.fn();
		const custom = async (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Component) => {
			let close!: () => void;
			const closed = new Promise<void>((resolve) => { close = resolve; });
			const component = factory({ requestRender: vi.fn() }, theme, {}, close);
			component.handleInput!("read"); component.handleInput!("\r"); component.handleInput!("\x1b");
			await closed;
			Reflect.get(component, "dispose")?.call(component);
		};
		try {
			await registered.long.handler("config", { mode: "tui", hasUI: true, ui: { custom, notify, theme } } as never);
			expect(settings.getSettings().tools.read).toBe(false);
			await entered;
			const shutdown = registered.on.mock.calls.find(([event]) => event === "session_shutdown")![1] as SessionShutdownHook;
			let exited = false;
			const stopped = shutdown().then(() => { exited = true; });
			expect(getToolTheme()).toBeUndefined();
			await Promise.resolve(); await Promise.resolve();
			expect(exited).toBe(false);
			unblock();
			await stopped;
			expect(JSON.parse(await readFile(configPath, "utf8")).tools.read).toBe(false);
			expect(notify).not.toHaveBeenCalled();
		} finally {
			ioHooks.beforeRename = undefined;
			unblock();
		}
	});

	for (const mode of ["rpc", "headless"] as const) it(`rejects ${mode} config before catalog enumeration or custom UI despite hasUI`, async () => {
		const { long, getAllTools } = commands(); const custom = vi.fn(); const notify = vi.fn();
		await long.handler("config", { mode, hasUI: true, ui: { custom, notify } } as never);
		expect(custom).not.toHaveBeenCalled(); expect(getAllTools).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce(); expect(notify.mock.calls[0]![1]).toBe("warning");
	});

	it("rejects config extra arguments without changing state or opening a menu", async () => {
		const { long, getAllTools } = commands(); const custom = vi.fn(); const notify = vi.fn();
		const before = isToolRendererEnabled();
		await long.handler("config extra", { mode: "tui", ui: { custom, notify } } as never);
		expect(isToolRendererEnabled()).toBe(before); expect(custom).not.toHaveBeenCalled();
		expect(getAllTools).not.toHaveBeenCalled(); expect(notify.mock.calls[0]![0]).toContain("Usage:");
	});

	it("persists explicit same-value OFF and bare toggles without losing other preferences", async () => {
		await settings.saveSettings({ shellEnabled: false, webSearchTools: ["EXACT_WEB"], tools: { read: false } }, configPath);
		const { long, short } = commands(); const ctx = { ui: { notify: vi.fn() } } as never;
		setToolRendererEnabled(false);
		await long.handler("off", ctx);
		expect(JSON.parse(await readFile(configPath, "utf8")).enabled).toBe(false);
		await short.handler("", ctx);
		expect(isToolRendererEnabled()).toBe(true);
		const saved = JSON.parse(await readFile(configPath, "utf8"));
		expect(saved).toEqual({ enabled: true, iconMode: "ascii", shellEnabled: false, webSearchTools: ["EXACT_WEB"], tools: { read: false } });
	});

	for (const action of ["off", "icons nerd-font"] as const) it(`applies ${action} immediately but emits only a session-not-saved error on a real write failure`, async () => {
		const blocker = join(configDirectory, "blocked");
		await writeFile(blocker, "not a directory", "utf8");
		vi.mocked(settings.saveSettings).mockImplementation((patch) => durableSave(patch, join(blocker, "settings.json")));
		const { long } = commands(); const notify = vi.fn();
		await long.handler(action, { ui: { notify } } as never);
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0]![1]).toBe("error");
		expect(notify.mock.calls[0]![0]).toMatch(/active in this session.*not saved/i);
		if (action === "off") expect(isToolRendererEnabled()).toBe(false);
		else expect(settings.getIconMode()).toBe("nerd-font");
	});

	it("applies fresh persisted global false after load, while env-0 does not become a saved choice on an icon command", async () => {
		const key = Symbol.for("pi-tools-style:runtime"); const previous = Reflect.get(globalThis, key);
		try {
			await settings.saveSettings({ enabled: false }, configPath);
			Reflect.deleteProperty(globalThis, key); vi.stubEnv("PI_TOOLS_STYLE", "");
			vi.spyOn(settings, "loadSettings").mockImplementation(() => durableLoad(configPath));
			const first = commands();
			const start = first.on.mock.calls.find(([event]) => event === "session_start")![1] as SessionStartHook;
			await start({}, { hasUI: true, ui: { notify: vi.fn(), theme } } as never);
			expect(isToolRendererEnabled()).toBe(false);
			await settings.saveSettings({ enabled: true }, configPath);
			Reflect.deleteProperty(globalThis, key); vi.stubEnv("PI_TOOLS_STYLE", "0");
			const second = commands();
			const secondStart = second.on.mock.calls.find(([event]) => event === "session_start")![1] as SessionStartHook;
			await secondStart({}, { hasUI: true, ui: { notify: vi.fn(), theme } } as never);
			expect(isToolRendererEnabled()).toBe(false);
			await second.long.handler("icons off", { ui: { notify: vi.fn() } } as never);
			expect(JSON.parse(await readFile(configPath, "utf8")).enabled).toBe(true);
			await second.long.handler("on", { ui: { notify: vi.fn() } } as never);
			await secondStart({ reason: "reload" }, { hasUI: true, ui: { notify: vi.fn(), theme } } as never);
			expect(isToolRendererEnabled()).toBe(true);
		} finally {
			Reflect.set(globalThis, key, previous); vi.unstubAllEnvs();
		}
	});
});
