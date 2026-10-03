import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { initTheme, type Theme, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

import { flushSettingsWrites, getSettings, loadSettings, saveSettings } from "../src/settings.ts";
import { isToolRendererEnabled, setToolRendererEnabled } from "../src/tool-renderer.ts";
import { openToolsStyleConfig, type ToolsStyleConfigChange } from "../src/config-menu.ts";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

// Disclosure semantics the menu must state for a conditional entry, an offline
// (saved but absent) entry, and a gated per-tool preference. Asserted as word
// families, never as fixed copy.
const CONDITIONAL_DISCLOSURE = /third[- ]party|self[- ]render|supported renderer|only applies|conditional/i;
const OFFLINE_DISCLOSURE = /not (currently )?(exposed|available|installed)|unavailable|offline|retained|hidden/i;
const EFFECTIVE_OFF_DISCLOSURE = /takes effect|only when|effective when|not active/i;

// The eight native tool identities the menu must expose for editing.
const NATIVE_ORDER = ["bash", "powershell", "read", "edit", "write", "find", "grep", "ls"];
const NATIVE_TOOLS: readonly ToolInfo[] = NATIVE_ORDER.map((name) => toolInfo(name, "builtin", `builtin:${name}`));
const MCP_SEARCH_TOOL: ToolInfo = toolInfo("mcp__docs__search", "builtin", "builtin:mcp", "mcp__docs");

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";

let root = "";
let configPath = "";

beforeEach(async () => {
	initTheme("dark", false);
	setToolRendererEnabled(true);
	root = await mkdtemp(join(tmpdir(), "pi-tools-style-menu-"));
	configPath = join(root, "tools-style.json");
	// Missing file resets the shared in-memory snapshot to defaults for each test.
	await loadSettings(configPath);
});

afterEach(async () => {
	await rm(root, { force: true, recursive: true });
	setToolRendererEnabled(true);
});

function toolInfo(
	name: string,
	source = "extension",
	path = `/extensions/${name}.ts`,
	namespace?: string,
): ToolInfo {
	return {
		name,
		sourceInfo: { source, path },
		...(namespace ? { namespace: { name: namespace } } : {}),
	} as unknown as ToolInfo;
}

interface MenuComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): unknown;
	dispose(): void;
}

interface MenuHarness {
	readonly component: MenuComponent;
	readonly notify: Mock;
	readonly done: Mock;
	readonly opened: Promise<void>;
	readonly requestRender: Mock;
	readonly custom: Mock;
}

type Factory = (
	tui: TUI,
	theme: Theme,
	keybindings: unknown,
	done: (result: void) => void,
) => MenuComponent;

function openMenu(options: {
	tools: readonly ToolInfo[];
	onChange?: (change: ToolsStyleConfigChange) => Promise<void>;
}): MenuHarness {
	const notify = vi.fn();
	const requestRender = vi.fn();
	const done = vi.fn();
	const closed = deferred<void>();
	let factory: Factory | undefined;
	const custom = vi.fn((next: Factory) => {
		factory = next;
		return closed.promise;
	});
	const pi = { getAllTools: () => options.tools };
	const context = { mode: "tui", ui: { notify, custom, theme: piTheme } };
	const opened = openToolsStyleConfig(
		pi as never,
		context as never,
		options.onChange ?? (async () => {}),
	);
	expect(custom).toHaveBeenCalledTimes(1);
	const component = factory!(
		{ requestRender } as unknown as TUI,
		piTheme,
		{} as never,
		(result: void) => {
			done(result);
			closed.resolve(result);
		},
	);
	return { component, notify, done, opened, requestRender, custom };
}

function selectRow(component: MenuComponent, index: number): void {
	for (let step = 0; step < index; step++) component.handleInput(DOWN);
}

function selectRowUp(component: MenuComponent, index: number): void {
	for (let step = 0; step < index; step++) component.handleInput(UP);
}

function typeText(component: MenuComponent, text: string): void {
	for (const char of text) component.handleInput(char);
}

// Flattens a rendered component to one whitespace-normalized line so wrapped
// labels/descriptions can be asserted on their exact text.
function viewText(component: MenuComponent, width: number): string {
	const stripped = component.render(width).map((line) => stripTerminalSequences(line));
	return stripped.join(" ").replace(/\s+/g, " ").trim();
}

// Matches a label as a whole word, so a test can act on an entry by identity
// instead of a pinned row order.
function labelPattern(label: string): RegExp {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|\\s)${escaped}(\\s|$)`);
}

function clickLabel(component: MenuComponent, label: string): void {
	const rows = component.render(80).map((line) => stripTerminalSequences(line));
	const pattern = labelPattern(label);
	const y = rows.findIndex((line) => pattern.test(line));
	expect(y).toBeGreaterThan(0);
	component.handleMouse({
		type: "click",
		button: "left",
		x: 4,
		y,
		screenX: 14,
		screenY: 20 + y,
		width: 80,
		height: rows.length,
		shift: false,
		alt: false,
		ctrl: false,
	} as TuiMouseEvent);
}

// Rendered row index of each label, so ordering is asserted on the real public
// render instead of a pinned array.
function labelRows(component: MenuComponent, labels: readonly string[]): number[] {
	const rows = component.render(80).map((line) => stripTerminalSequences(line));
	return labels.map((label) => {
		const pattern = labelPattern(label);
		const y = rows.findIndex((line) => pattern.test(line));
		expect(y).toBeGreaterThan(0);
		return y;
	});
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

// Local deferred: the ES2022 lib in this project has no Promise.withResolvers.
function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (reason?: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function patchOf(change: ToolsStyleConfigChange): Record<string, unknown> {
	switch (change.kind) {
		case "enabled":
			return { enabled: change.enabled };
		case "iconMode":
			return { iconMode: change.iconMode };
		case "shellEnabled":
			return { shellEnabled: change.enabled };
		case "tool":
			return { tools: { [change.name]: change.enabled } };
	}
}

// Deterministic microtask drain; no wall-clock timers.
async function flushMicrotasks(): Promise<void> {
	for (let step = 0; step < 6; step++) await Promise.resolve();
}

describe("tools style config menu", () => {
	it("resolves without opening a component outside TUI mode", async () => {
		const notify = vi.fn();
		const custom = vi.fn();
		await openToolsStyleConfig(
			{ getAllTools: () => NATIVE_TOOLS } as never,
			{ mode: "rpc", ui: { notify, custom } } as never,
			async () => {},
		);

		expect(custom).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("drives the real searchable SettingsList through the captured custom factory", () => {
		const harness = openMenu({ tools: [...NATIVE_TOOLS, MCP_SEARCH_TOOL] });

		typeText(harness.component, "grep");
		const view = viewText(harness.component, 80);
		expect(view).toContain("grep");
		expect(view).not.toContain("mcp__docs__search");
	});

	it("drives the globals and every native tool through independent preference controls", async () => {
		const changes: ToolsStyleConfigChange[] = [];
		const writes: Promise<void>[] = [];
		const harness = openMenu({
			tools: [...NATIVE_TOOLS, MCP_SEARCH_TOOL],
			onChange: (change) => {
				changes.push(change);
				const write = saveSettings(patchOf(change), configPath);
				writes.push(write);
				return write;
			},
		});

		// The three globals lead the menu and each one drives its own field.
		harness.component.handleInput(SPACE);
		selectRow(harness.component, 1);
		harness.component.handleInput(SPACE);
		selectRow(harness.component, 1);
		harness.component.handleInput(SPACE);
		expect(changes.slice(0, 3)).toEqual([
			{ kind: "enabled", enabled: false },
			{ kind: "iconMode", iconMode: "nerd-font" },
			{ kind: "shellEnabled", enabled: false },
		]);

		// Each native tool is its own control, reached by identity rather than by
		// any pinned row order.
		for (const name of NATIVE_ORDER) clickLabel(harness.component, name);
		expect(changes.slice(3)).toEqual(
			NATIVE_ORDER.map((name) => ({ kind: "tool", name, enabled: false })),
		);

		await Promise.all(writes);
		const persisted = JSON.parse(await readFile(configPath, "utf8"));
		expect(persisted).toMatchObject({
			enabled: false,
			iconMode: "nerd-font",
			shellEnabled: false,
			tools: Object.fromEntries(NATIVE_ORDER.map((name) => [name, false])),
		});
	});

	it("orders reserved-looking extras among ordinary names deterministically", () => {
		// `constructor`/`__proto__` must not resolve inherited values in the rank table,
		// and ordinary extras must still sort by exact name around them.
		const extras = ["constructor", "__proto__", "zzz_reserved", "aaa_reserved"];
		const harness = openMenu({
			tools: [
				...NATIVE_TOOLS,
				...extras.map((name) => toolInfo(name, "extension", `/extensions/${name}.ts`)),
			],
		});

		const indices = labelRows(harness.component, [
			...NATIVE_ORDER,
			"__proto__",
			"aaa_reserved",
			"constructor",
			"zzz_reserved",
		]);
		expect(indices).toEqual([...indices].sort((left, right) => left - right));
	});

	it("searches to an exact MCP identity and toggles it with Enter", () => {
		const changes: ToolsStyleConfigChange[] = [];
		const harness = openMenu({
			tools: [...NATIVE_TOOLS, MCP_SEARCH_TOOL],
			onChange: async (change) => {
				changes.push(change);
			},
		});

		typeText(harness.component, "mcp__docs__search");
		harness.component.handleInput(ENTER);

		expect(changes).toEqual([{ kind: "tool", name: "mcp__docs__search", enabled: false }]);
	});

	it("cycles with Space when the search box is empty but searches when it holds text", () => {
		const changes: ToolsStyleConfigChange[] = [];
		const harness = openMenu({
			tools: [...NATIVE_TOOLS],
			onChange: async (change) => {
				changes.push(change);
			},
		});

		// Empty search: Space activates the selected row.
		harness.component.handleInput(SPACE);
		expect(changes).toHaveLength(1);

		// Non-empty search: Space belongs to the search field and must not toggle.
		typeText(harness.component, "read");
		harness.component.handleInput(SPACE);
		expect(changes).toHaveLength(1);
	});

	it("reads current values from the real settings getters and writes through onChange", async () => {
		await saveSettings({ iconMode: "nerd-font", shellEnabled: false }, configPath);
		const changes: ToolsStyleConfigChange[] = [];
		let pending: Promise<void> = Promise.resolve();
		const harness = openMenu({
			tools: [...NATIVE_TOOLS],
			onChange: (change) => {
				changes.push(change);
				pending = saveSettings(patchOf(change), configPath);
				return pending;
			},
		});

		// Icon row (index 1): nerd-font -> off -> ascii per the exact enum.
		selectRow(harness.component, 1);
		harness.component.handleInput(SPACE);
		expect(changes).toEqual([{ kind: "iconMode", iconMode: "off" }]);
		harness.component.handleInput(SPACE);
		expect(changes[1]).toEqual({ kind: "iconMode", iconMode: "ascii" });
		await pending;

		// Shell row (index 2) is its own control, independent of any model bash tool.
		harness.component.handleInput(DOWN);
		harness.component.handleInput(SPACE);
		expect(changes[2]).toEqual({ kind: "shellEnabled", enabled: true });
		await pending;

		const persisted = JSON.parse(await readFile(configPath, "utf8"));
		expect(persisted.iconMode).toBe("ascii");
		expect(persisted.shellEnabled).toBe(true);
	});

	it("shows the raw runtime global state, not the saved preference, and keeps tool rows editable when off", async () => {
		await saveSettings({ enabled: false, tools: { bash: false } }, configPath);
		setToolRendererEnabled(true);
		const changes: ToolsStyleConfigChange[] = [];
		const record = async (change: ToolsStyleConfigChange): Promise<void> => {
			changes.push(change);
		};
		const harness = openMenu({ tools: [...NATIVE_TOOLS], onChange: record });

		// Saved preference is off but the effective runtime is on: the row cycles on -> off.
		harness.component.handleInput(SPACE);
		expect(changes[0]).toEqual({ kind: "enabled", enabled: false });

		// Global OFF never disables editing a per-tool preference.
		setToolRendererEnabled(false);
		const offHarness = openMenu({ tools: [...NATIVE_TOOLS], onChange: record });
		typeText(offHarness.component, "bash");
		offHarness.component.handleInput(ENTER);
		expect(changes[1]).toEqual({ kind: "tool", name: "bash", enabled: true });
	});

	it("keeps ids collision-safe for names that look like menu ids or contain separators", () => {
		const changes: ToolsStyleConfigChange[] = [];
		const tools = [
			...NATIVE_TOOLS,
			toolInfo("global.enabled"),
			toolInfo("global.iconMode"),
			toolInfo("tool:read"),
			toolInfo("a:b"),
		];
		const record = async (change: ToolsStyleConfigChange): Promise<void> => {
			changes.push(change);
		};

		// A fresh menu per name: the SDK search field accumulates typed text.
		for (const name of ["global.enabled", "global.iconMode", "tool:read", "a:b"]) {
			const harness = openMenu({ tools, onChange: record });
			typeText(harness.component, name);
			harness.component.handleInput(ENTER);
		}

		expect(changes).toEqual([
			{ kind: "tool", name: "global.enabled", enabled: false },
			{ kind: "tool", name: "global.iconMode", enabled: false },
			{ kind: "tool", name: "tool:read", enabled: false },
			{ kind: "tool", name: "a:b", enabled: false },
		]);
	});

	it("identifies conditional and offline entries and keeps them reachable", async () => {
		await saveSettings({ tools: { zzz_offline_tool: false } }, configPath);
		const changes: ToolsStyleConfigChange[] = [];
		const tools = [...NATIVE_TOOLS, toolInfo("zzz_conditional_tool")];
		const record = (change: ToolsStyleConfigChange): Promise<void> => {
			changes.push(change);
			return saveSettings(patchOf(change), configPath);
		};

		// A public tool without owned-renderer evidence stays reachable and says
		// that its preference only applies conditionally.
		const conditional = openMenu({ tools, onChange: record });
		typeText(conditional.component, "zzz_conditional_tool");
		const conditionalView = viewText(conditional.component, 80);
		expect(conditionalView).toContain("zzz_conditional_tool");
		expect(conditionalView).toMatch(CONDITIONAL_DISCLOSURE);
		conditional.component.handleInput(ENTER);
		expect(changes[0]).toEqual({ kind: "tool", name: "zzz_conditional_tool", enabled: false });

		// A saved-but-absent identity stays listed (not an empty search) and states
		// that it is retained without being currently exposed.
		const offline = openMenu({ tools, onChange: record });
		typeText(offline.component, "zzz_offline_tool");
		const offlineView = viewText(offline.component, 80);
		expect(offlineView).toContain("zzz_offline_tool");
		expect(offlineView).not.toContain("No matching settings");
		expect(offlineView).toMatch(OFFLINE_DISCLOSURE);
		// Availability and support are independent: an offline identity is still conditional
		// unless owned-row evidence confirmed its renderer.
		expect(offlineView).toMatch(CONDITIONAL_DISCLOSURE);
	});

	it("retains an offline preference and toggles it back on", async () => {
		await saveSettings({ tools: { zzz_offline_tool: false } }, configPath);
		const changes: ToolsStyleConfigChange[] = [];
		const harness = openMenu({
			tools: [...NATIVE_TOOLS],
			onChange: (change) => {
				changes.push(change);
				return saveSettings(patchOf(change), configPath);
			},
		});

		typeText(harness.component, "zzz_offline_tool");
		harness.component.handleInput(ENTER);
		expect(changes).toEqual([{ kind: "tool", name: "zzz_offline_tool", enabled: true }]);
	});

	it("explains the global gate on a tool row only while global styling is off", () => {
		setToolRendererEnabled(false);
		const offHarness = openMenu({ tools: [...NATIVE_TOOLS] });
		typeText(offHarness.component, "bash");
		const offView = viewText(offHarness.component, 80);
		expect(offView).toMatch(EFFECTIVE_OFF_DISCLOSURE);

		setToolRendererEnabled(true);
		const onHarness = openMenu({ tools: [...NATIVE_TOOLS] });
		typeText(onHarness.component, "bash");
		const onView = viewText(onHarness.component, 80);

		// Same row, same value: the only difference is the added gate disclosure.
		expect(onView).toContain("bash");
		expect(offView).not.toBe(onView);
		expect(offView.length).toBeGreaterThan(onView.length);
	});

	it("refreshes the global gate disclosure inside one opening", () => {
		setToolRendererEnabled(false);
		const harness = openMenu({
			tools: [...NATIVE_TOOLS],
			onChange: async (change) => {
				if (change.kind === "enabled") setToolRendererEnabled(change.enabled);
			},
		});

		// Global styling off: the selected tool row carries the gate warning.
		selectRow(harness.component, 3);
		expect(viewText(harness.component, 80)).toMatch(EFFECTIVE_OFF_DISCLOSURE);

		// Flipping the global on leaves the same opening without the stale warning.
		selectRowUp(harness.component, 3);
		harness.component.handleInput(SPACE);
		expect(isToolRendererEnabled()).toBe(true);
		selectRow(harness.component, 3);
		expect(viewText(harness.component, 80)).toContain("bash");
		expect(viewText(harness.component, 80)).not.toMatch(EFFECTIVE_OFF_DISCLOSURE);

		// The inverse transition restores it, still without reopening.
		selectRowUp(harness.component, 3);
		harness.component.handleInput(SPACE);
		expect(isToolRendererEnabled()).toBe(false);
		selectRow(harness.component, 3);
		expect(viewText(harness.component, 80)).toMatch(EFFECTIVE_OFF_DISCLOSURE);
		expect(harness.done).not.toHaveBeenCalled();
	});

	it("streams the exact tool identity and renders safely at narrow widths and long labels", () => {
		const changes: ToolsStyleConfigChange[] = [];
		const long = `zzz_${"l".repeat(180)}`;
		const control = "evil\u0007name";
		const harness = openMenu({
			tools: [...NATIVE_TOOLS, toolInfo(long), toolInfo(control)],
			onChange: (change) => {
				changes.push(change);
				return Promise.resolve();
			},
		});

		const narrow = harness.component.render(20);
		expect(narrow.length).toBeGreaterThan(0);
		for (const line of narrow) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
		expect(narrow.every((line) => !line.includes("\u0007"))).toBe(true);

		typeText(harness.component, "evil");
		harness.component.handleInput(ENTER);
		expect(changes).toEqual([{ kind: "tool", name: control, enabled: false }]);
	});

	it("shows the SDK empty state for a search with no matches", () => {
		const harness = openMenu({ tools: [...NATIVE_TOOLS] });
		typeText(harness.component, "zzzzzz");
		expect(viewText(harness.component, 80)).toContain("No matching settings");
	});

	it("keeps rapid toggles immediate with no input lock", () => {
		const changes: ToolsStyleConfigChange[] = [];
		const harness = openMenu({
			tools: [...NATIVE_TOOLS],
			onChange: (change) => {
				changes.push(change);
				return Promise.resolve();
			},
		});

		typeText(harness.component, "bash");
		for (let step = 0; step < 6; step++) harness.component.handleInput(ENTER);

		expect(changes.map((change) => change.kind === "tool" ? change.enabled : null)).toEqual([
			false, true, false, true, false, true,
		]);
	});

	it("routes mouse clicks through the public container into the SettingsList", () => {
		const changes: ToolsStyleConfigChange[] = [];
		const harness = openMenu({
			tools: [...NATIVE_TOOLS, toolInfo("zzz_click_target")],
			onChange: (change) => {
				changes.push(change);
				return Promise.resolve();
			},
		});

		clickLabel(harness.component, "zzz_click_target");

		expect(changes).toEqual([{ kind: "tool", name: "zzz_click_target", enabled: false }]);
	});

	it("applies the change and the real settings state without waiting for the writer", async () => {
		const changes: ToolsStyleConfigChange[] = [];
		const write = deferred<void>();
		let settled = false;
		const harness = openMenu({
			tools: [...NATIVE_TOOLS],
			onChange: async (change) => {
				changes.push(change);
				await saveSettings(patchOf(change), configPath);
				await write.promise;
				settled = true;
			},
		});
		const initial = getSettings().enabled;
		const before = viewText(harness.component, 80);

		harness.component.handleInput(SPACE);

		// Emitted synchronously, while the writer is still pending.
		expect(changes).toEqual([{ kind: "enabled", enabled: !initial }]);
		expect(settled).toBe(false);
		// The control itself already shows the new value.
		expect(viewText(harness.component, 80)).not.toBe(before);

		await flushMicrotasks();

		// A pending writer neither blocks the real settings state nor the control.
		expect(settled).toBe(false);
		expect(getSettings().enabled).toBe(!initial);
		harness.component.handleInput(SPACE);
		expect(changes).toHaveLength(2);
		expect(changes[1]).toEqual({ kind: "enabled", enabled: initial });
		expect(settled).toBe(false);

		write.resolve();
		// The first change is still awaiting the real queued rename, which only
		// macro-task I/O completion settles; drain the shared writer first.
		await flushSettingsWrites();
		await flushMicrotasks();
		expect(settled).toBe(true);
	});

	it("keeps the optimistic value and warns exactly once per rejected write", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		const changes: ToolsStyleConfigChange[] = [];
		const harness = openMenu({
			tools: [...NATIVE_TOOLS],
			onChange: (change) => {
				changes.push(change);
				return Promise.reject(new Error("disk full"));
			},
		});

		selectRow(harness.component, 3);
		harness.component.handleInput(SPACE);
		await flushMicrotasks();
		try {
			expect(harness.notify).toHaveBeenCalledTimes(1);
			expect(harness.notify).toHaveBeenCalledWith(expect.any(String), "warning");

			// No rollback: the value stays OFF, so the next toggle turns it back on,
			// and that second rejected write warns exactly once more.
			harness.component.handleInput(SPACE);
			expect(changes).toEqual([
				{ kind: "tool", name: "bash", enabled: false },
				{ kind: "tool", name: "bash", enabled: true },
			]);
			await flushMicrotasks();
			expect(harness.notify).toHaveBeenCalledTimes(2);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("treats a synchronous throw from the writer as one warning without unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		const harness = openMenu({
			tools: [...NATIVE_TOOLS],
			onChange: () => {
				throw new Error("sync writer failure");
			},
		});

		harness.component.handleInput(SPACE);
		await flushMicrotasks();
		try {
			expect(harness.notify).toHaveBeenCalledTimes(1);
			expect(harness.notify).toHaveBeenCalledWith(expect.any(String), "warning");
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("closes on Escape once, resolves before a delayed save, and reports a late failure without repainting", async () => {
		const write = deferred<void>();
		const harness = openMenu({
			tools: [...NATIVE_TOOLS],
			onChange: () => write.promise,
		});

		typeText(harness.component, "bash");
		harness.component.handleInput(ENTER);
		const rendersBeforeClose = harness.requestRender.mock.calls.length;

		harness.component.handleInput(ESC);
		expect(harness.done).toHaveBeenCalledTimes(1);
		await harness.opened;

		// External pending write keeps running; a late rejection still notifies exactly once.
		write.reject(new Error("late failure"));
		await flushMicrotasks();
		expect(harness.done).toHaveBeenCalledTimes(1);
		expect(harness.notify).toHaveBeenCalledTimes(1);
		expect(harness.notify).toHaveBeenCalledWith(expect.any(String), "warning");

		// Nothing repaints or reopens after the component was closed/disposed.
		expect(harness.requestRender.mock.calls.length).toBe(rendersBeforeClose);
		harness.component.handleInput(ESC);
		harness.component.handleInput(SPACE);
		expect(harness.done).toHaveBeenCalledTimes(1);
		expect(harness.requestRender.mock.calls.length).toBe(rendersBeforeClose);
	});

	it("picks up a tool discovered later and reads its preference back on reopen", async () => {
		const first = openMenu({ tools: [...NATIVE_TOOLS] });
		typeText(first.component, "zzz_added_later");
		expect(viewText(first.component, 80)).toContain("No matching settings");
		first.component.handleInput(ESC);

		const changes: ToolsStyleConfigChange[] = [];
		const writes: Promise<void>[] = [];
		const record = (change: ToolsStyleConfigChange): Promise<void> => {
			changes.push(change);
			const write = saveSettings(patchOf(change), configPath);
			writes.push(write);
			return write;
		};

		// The identity discovered on this opening is editable right away.
		const second = openMenu({
			tools: [...NATIVE_TOOLS, toolInfo("zzz_added_later")],
			onChange: record,
		});
		typeText(second.component, "zzz_added_later");
		expect(viewText(second.component, 80)).toContain("zzz_added_later");
		second.component.handleInput(ENTER);
		expect(changes[0]).toEqual({ kind: "tool", name: "zzz_added_later", enabled: false });
		await Promise.all(writes);
		expect(JSON.parse(await readFile(configPath, "utf8")).tools.zzz_added_later).toBe(false);

		// A further opening reads the changed preference back from real settings.
		const third = openMenu({
			tools: [...NATIVE_TOOLS, toolInfo("zzz_added_later")],
			onChange: record,
		});
		typeText(third.component, "zzz_added_later");
		third.component.handleInput(ENTER);
		expect(changes[1]).toEqual({ kind: "tool", name: "zzz_added_later", enabled: true });
		await Promise.all(writes);
	});

	it("does not request a repaint from a detached writer rejection after ordinary close", async () => {
		const write = deferred<void>();
		const harness = openMenu({
			tools: [...NATIVE_TOOLS],
			onChange: () => write.promise,
		});

		harness.component.handleInput(SPACE);
		harness.component.handleInput(ESC);
		await harness.opened;
		const renders = harness.requestRender.mock.calls.length;

		write.reject(new Error("detached"));
		await flushMicrotasks();

		expect(harness.notify).toHaveBeenCalledTimes(1);
		expect(harness.requestRender.mock.calls.length).toBe(renders);
	});
});
