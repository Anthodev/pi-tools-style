import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getIconMode,
	getWebSearchTools,
	loadSettings,
	saveIconMode,
	setIconMode,
} from "../src/settings.ts";
import * as settings from "../src/settings.ts";
import type { ToolsStyleSettingsPatch } from "../src/settings.ts";

const ioHooks = vi.hoisted(() => ({
	beforeRead: undefined as ((path: unknown) => Promise<void>) | undefined,
	beforeWrite: undefined as ((path: unknown) => Promise<void>) | undefined,
	beforeRename: undefined as ((source: unknown, target: unknown) => Promise<void>) | undefined,
	afterRename: undefined as ((target: unknown) => Promise<void>) | undefined,
}));

// Delegate every operation to the real filesystem; only pause/fail uncertain I/O
// boundaries so overlapping user choices are deterministic.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		readFile: async (...args: Parameters<typeof actual.readFile>) => {
			await ioHooks.beforeRead?.(args[0]);
			return actual.readFile(...args);
		},
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			await ioHooks.beforeWrite?.(args[0]);
			return actual.writeFile(...args);
		},
		rename: async (...args: Parameters<typeof actual.rename>) => {
			await ioHooks.beforeRename?.(...args);
			await actual.rename(...args);
			await ioHooks.afterRename?.(args[1]);
		},
	};
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-tools-style-"));
	await loadSettings(join(root, "missing.json"));
});

afterEach(async () => {
	ioHooks.beforeRead = undefined;
	ioHooks.beforeWrite = undefined;
	ioHooks.beforeRename = undefined;
	ioHooks.afterRename = undefined;
	await loadSettings(join(root, "missing.json"));
	await rm(root, { force: true, recursive: true });
	vi.restoreAllMocks();
});

describe("tools style settings", () => {
	it("defaults to portable ASCII icons", () => {
		expect(getIconMode()).toBe("ascii");
	});

	it("loads a persisted Nerd Font preference", async () => {
		const path = join(root, "tools-style.json");
		await writeFile(path, '{"iconMode":"nerd-font"}\n');

		await loadSettings(path);

		expect(getIconMode()).toBe("nerd-font");
	});

	it("loads a persisted icons-off preference", async () => {
		const path = join(root, "tools-style.json");
		await writeFile(path, '{"iconMode":"off"}\n');

		await loadSettings(path);

		expect(getIconMode()).toBe("off");
	});

	it("falls back to ASCII for missing or invalid config", async () => {
		await loadSettings(join(root, "missing.json"));
		expect(getIconMode()).toBe("ascii");

		const invalid = join(root, "invalid.json");
		await writeFile(invalid, '{"iconMode":"unsupported"}\n');
		setIconMode("nerd-font");
		await loadSettings(invalid);

		expect(getIconMode()).toBe("ascii");
	});

	it("persists icon mode and creates the config directory", async () => {
		const path = join(root, "nested", "tools-style.json");

		await saveIconMode("nerd-font", path);

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			enabled: true,
			iconMode: "nerd-font",
			webSearchTools: [],
			shellEnabled: true,
			tools: {},
		});
		expect(getIconMode()).toBe("nerd-font");
	});
});

describe("web search tool list", () => {
	it("defaults to an empty list", () => {
		expect(getWebSearchTools()).toEqual([]);
	});

	it("keeps absent, non-array and mixed entries out", async () => {
		const absent = join(root, "absent.json");
		await writeFile(absent, '{"iconMode":"nerd-font"}\n');
		await loadSettings(absent);
		expect(getWebSearchTools()).toEqual([]);

		const nonArray = join(root, "non-array.json");
		await writeFile(nonArray, '{"webSearchTools":"web_search"}\n');
		await loadSettings(nonArray);
		expect(getWebSearchTools()).toEqual([]);

		const mixed = join(root, "mixed.json");
		await writeFile(
			mixed,
			'{"webSearchTools":["my_web","",5,null,"Other Tool",["nested"]]}\n',
		);
		await loadSettings(mixed);
		expect(getWebSearchTools()).toEqual(["my_web", "Other Tool"]);
	});

	it("retains the exact case and whitespace of provider names", async () => {
		const path = join(root, "tools-style.json");
		await writeFile(
			path,
			'{"webSearchTools":["Web_Search"," my tool ","TAVILY","  "]}',
		);

		await loadSettings(path);

		expect(getWebSearchTools()).toEqual([
			"Web_Search",
			" my tool ",
			"TAVILY",
			"  ",
		]);
	});

	it("keeps the list when persisting an icon mode, then reloads it", async () => {
		const path = join(root, "tools-style.json");
		await writeFile(
			path,
			'{"iconMode":"ascii","webSearchTools":["my_web","Other"]}\n',
		);
		await loadSettings(path);

		await saveIconMode("nerd-font", path);

		expect(getIconMode()).toBe("nerd-font");
		expect(getWebSearchTools()).toEqual(["my_web", "Other"]);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			enabled: true,
			iconMode: "nerd-font",
			webSearchTools: ["my_web", "Other"],
			shellEnabled: true,
			tools: {},
		});

		await loadSettings(path);
		expect(getIconMode()).toBe("nerd-font");
		expect(getWebSearchTools()).toEqual(["my_web", "Other"]);
	});

	it("keeps the runtime list across a direct icon mode change", async () => {
		const path = join(root, "tools-style.json");
		await writeFile(path, '{"webSearchTools":["Keep__Me"]}\n');
		await loadSettings(path);

		setIconMode("off");

		expect(getIconMode()).toBe("off");
		expect(getWebSearchTools()).toEqual(["Keep__Me"]);
	});

	it("tolerates a legacy icon-only runtime object", () => {
		Reflect.set(globalThis, Symbol.for("pi-tools-style:settings"), {
			iconMode: "nerd-font",
		});

		expect(getIconMode()).toBe("nerd-font");
		expect(getWebSearchTools()).toEqual([]);

		setIconMode("ascii");
		expect(getIconMode()).toBe("ascii");
		expect(getWebSearchTools()).toEqual([]);
	});
});

describe("per-tool presentation preferences", () => {
	it("supplies all five defaults for legacy, missing and malformed configs", async () => {
		const path = join(root, "tools-style.json");
		for (const content of [
			'{"iconMode":"off","webSearchTools":["Legacy_Web"]}',
			"null",
			"[]",
			'"not an object"',
			"{malformed",
		]) {
			await writeFile(path, content);
			await loadSettings(path);
			expect(settings.getSettings()).toEqual(content.startsWith('{"iconMode"') ? {
				enabled: true,
				iconMode: "off",
				webSearchTools: ["Legacy_Web"],
				shellEnabled: true,
				tools: {},
			} : {
				enabled: true,
				iconMode: "ascii",
				webSearchTools: [],
				shellEnabled: true,
				tools: {},
			});
			expect(Object.getPrototypeOf(settings.getSettings().tools)).toBeNull();
		}
		await loadSettings(join(root, "missing.json"));
		expect(settings.isShellEnabledByConfig()).toBe(true);
		expect(settings.isToolEnabledByConfig("read")).toBe(true);
	});

	it("normalizes mixed fields individually and keeps exact own tool identities", async () => {
		const path = join(root, "tools-style.json");
		await writeFile(path, `{
			"enabled": false,
			"iconMode": "unsupported",
			"webSearchTools": ["Web_Search", "", 7, " padded "],
			"shellEnabled": false,
			"tools": {
				"read": false, "Read": true, " padded ": false, "  ": false,
				"mcp__Docs__search:part": false, "": false, "bad": "false",
				"number": 0, "null": null, "array": [false],
				"__proto__": false, "constructor": false,
				"toString": false, "prototype": false
			},
			"unknown": "ignored"
		}`);
		await loadSettings(path);

		expect(settings.getSettings()).toEqual({
			enabled: false,
			iconMode: "ascii",
			webSearchTools: ["Web_Search", " padded "],
			shellEnabled: false,
			tools: JSON.parse('{"read":false,"Read":true," padded ":false,"  ":false,"mcp__Docs__search:part":false,"__proto__":false,"constructor":false,"toString":false,"prototype":false}'),
		});
		for (const name of ["read", " padded ", "  ", "mcp__Docs__search:part", "__proto__", "constructor", "toString", "prototype"]) {
			expect(settings.isToolEnabledByConfig(name), name).toBe(false);
		}
		for (const name of ["Read", "READ", "padded", "bad", "number", "null", "array", ""]) {
			expect(settings.isToolEnabledByConfig(name), name).toBe(true);
		}
		expect(settings.isShellEnabledByConfig()).toBe(false);
		expect(Object.getPrototypeOf(settings.getSettings().tools)).toBeNull();
	});

	it.each([null, [], false, "read"])("ignores invalid tool-map shape %j without losing valid other fields", async (tools) => {
		const path = join(root, "tools-style.json");
		await writeFile(path, JSON.stringify({ enabled: false, shellEnabled: "false", iconMode: "off", tools }));
		await loadSettings(path);

		expect(settings.getSettings()).toEqual({
			enabled: false, iconMode: "off", webSearchTools: [], shellEnabled: true, tools: {},
		});
		expect(settings.isToolEnabledByConfig("constructor")).toBe(true);
		expect(settings.isShellEnabledByConfig()).toBe(true);
	});

	it("repairs legacy runtime data once without accepting inherited flags", () => {
		const inheritedTools = Object.assign(Object.create({ inherited: false, constructor: false }), {
			read: false,
		});
		Reflect.set(globalThis, Symbol.for("pi-tools-style:settings"), {
			iconMode: "nerd-font",
			webSearchTools: ["Exact_Web"],
			tools: inheritedTools,
		});

		const repaired = settings.getSettings();
		expect(repaired).toEqual({
			enabled: true, iconMode: "nerd-font", webSearchTools: ["Exact_Web"], shellEnabled: true, tools: { read: false },
		});
		expect(settings.isToolEnabledByConfig("read")).toBe(false);
		expect(settings.isToolEnabledByConfig("inherited")).toBe(true);
		expect(settings.isToolEnabledByConfig("constructor")).toBe(true);
		expect(Object.getPrototypeOf(repaired.tools)).toBeNull();
		expect(settings.getSettings()).toBe(repaired);
	});

	it("merges own tool patches and preserves every preference through both icon APIs", async () => {
		const path = join(root, "tools-style.json");
		// Object.assign would route "__proto__" through the prototype setter and
		// drop it; redefine the JSON-produced own key explicitly.
		const names = Object.assign(Object.create({ inherited: false }), JSON.parse('{"toString":false,"read":false}'));
		Object.defineProperty(names, "__proto__", { value: false, enumerable: true, writable: true, configurable: true });
		await settings.saveSettings({
			enabled: false, shellEnabled: false, webSearchTools: ["Web_Search", " exact "], tools: names,
		}, path);
		await settings.saveSettings({ tools: { read: true, Read: false, "mcp__docs__search": false } }, path);
		setIconMode("off");
		expect(settings.getSettings()).toEqual({
			enabled: false,
			iconMode: "off",
			webSearchTools: ["Web_Search", " exact "],
			shellEnabled: false,
			tools: JSON.parse('{"__proto__":false,"toString":false,"read":true,"Read":false,"mcp__docs__search":false}'),
		});

		await saveIconMode("nerd-font", path);
		// The stored document preserves input insertion order; "__proto__" was
		// redefined last on the source object, so it serializes third here.
		const expected = {
			enabled: false,
			iconMode: "nerd-font",
			webSearchTools: ["Web_Search", " exact "],
			shellEnabled: false,
			tools: JSON.parse('{"toString":false,"read":true,"__proto__":false,"Read":false,"mcp__docs__search":false}'),
		};
		expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
		await loadSettings(path);
		expect(settings.getSettings()).toEqual(expected);
		expect(settings.isToolEnabledByConfig("inherited")).toBe(true);
	});

	it("ignores unknown or invalid patch fields rather than deleting session choices", async () => {
		const path = join(root, "tools-style.json");
		await settings.saveSettings({ enabled: false, shellEnabled: false, iconMode: "off", tools: { read: false } }, path);
		await settings.saveSettings({
			enabled: "false", shellEnabled: null, iconMode: "unsupported", tools: { read: "false", "": false }, unknown: true,
		} as unknown as ToolsStyleSettingsPatch, path);

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			enabled: false, iconMode: "off", webSearchTools: [], shellEnabled: false, tools: { read: false },
		});
	});

	it("owns immutable input snapshots so later caller mutations cannot alter pending preferences", async () => {
		const path = join(root, "tools-style.json");
		const webSearchTools = ["Keep_Web"];
		const tools = { read: false };
		const pending = settings.saveSettings({ webSearchTools, tools }, path);
		webSearchTools.push("Later_Web");
		tools.read = true;

		expect(settings.getSettings()).toEqual({
			enabled: true, iconMode: "ascii", webSearchTools: ["Keep_Web"], shellEnabled: true, tools: { read: false },
		});
		await pending;
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			enabled: true, iconMode: "ascii", webSearchTools: ["Keep_Web"], shellEnabled: true, tools: { read: false },
		});
	});
});

describe("ordered atomic settings persistence", () => {
	it("applies rapid choices immediately but persists their complete snapshots in order", async () => {
		const path = join(root, "tools-style.json");
		const entered = deferred();
		const release = deferred();
		const persisted: unknown[] = [];
		ioHooks.beforeWrite = async () => {
			ioHooks.beforeWrite = undefined;
			entered.resolve();
			await release.promise;
		};
		ioHooks.afterRename = async (target) => {
			if (target === path) persisted.push(JSON.parse(await readFile(path, "utf8")));
		};
		const first = settings.saveSettings({ enabled: false, tools: { read: false } }, path);
		const second = settings.saveSettings({ shellEnabled: false, iconMode: "off" }, path);
		const third = settings.saveSettings({ tools: { read: true, "mcp__docs__search": false }, webSearchTools: ["Exact_Web"] }, path);
		try {
			expect(settings.getSettings()).toEqual({
				enabled: false, iconMode: "off", webSearchTools: ["Exact_Web"], shellEnabled: false,
				tools: { read: true, "mcp__docs__search": false },
			});
			await entered.promise;
			expect(persisted).toEqual([]);
		} finally {
			release.resolve();
			await Promise.all([first, second, third]);
		}
		expect(persisted).toEqual([
			{ enabled: false, iconMode: "ascii", webSearchTools: [], shellEnabled: true, tools: { read: false } },
			{ enabled: false, iconMode: "off", webSearchTools: [], shellEnabled: false, tools: { read: false } },
			{ enabled: false, iconMode: "off", webSearchTools: ["Exact_Web"], shellEnabled: false, tools: { read: true, "mcp__docs__search": false } },
		]);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(persisted[2]);
		expect(settings.getSettings()).toEqual(persisted[2]);
	});

	it("keeps the previous target and applied session choice after atomic failure, then accepts a later save", async () => {
		const path = join(root, "tools-style.json");
		await saveIconMode("ascii", path);
		const original = await readFile(path, "utf8");
		const failure = new Error("rename denied");
		ioHooks.beforeRename = async () => {
			ioHooks.beforeRename = undefined;
			throw failure;
		};

		await expect(settings.saveSettings({ enabled: false, shellEnabled: false, tools: { read: false } }, path)).rejects.toBe(failure);
		expect(await readFile(path, "utf8")).toBe(original);
		expect(settings.getSettings()).toEqual({
			enabled: false, iconMode: "ascii", webSearchTools: [], shellEnabled: false, tools: { read: false },
		});
		expect(await readdir(root)).toEqual(["tools-style.json"]);

		await saveIconMode("off", path);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			enabled: false, iconMode: "off", webSearchTools: [], shellEnabled: false, tools: { read: false },
		});
	});

	it("shares pending writes across a module reload without completion rolling back newer choices", async () => {
		const path = join(root, "tools-style.json");
		const entered = deferred();
		const release = deferred();
		const persisted: unknown[] = [];
		ioHooks.beforeWrite = async () => {
			ioHooks.beforeWrite = undefined;
			entered.resolve();
			await release.promise;
		};
		ioHooks.afterRename = async (target) => {
			if (target === path) persisted.push(JSON.parse(await readFile(path, "utf8")));
		};
		const first = settings.saveSettings({ enabled: false, tools: { read: false } }, path);
		let second: Promise<void> | undefined;
		try {
			await entered.promise;
			vi.resetModules();
			// A static import would reuse the original instance and miss the reload boundary.
			const reloaded = await import("../src/settings.ts");
			second = reloaded.saveSettings({ iconMode: "nerd-font", shellEnabled: false, tools: { read: true } }, path);
			expect(settings.getSettings()).toBe(reloaded.getSettings());
			expect(reloaded.getSettings()).toEqual({
				enabled: false, iconMode: "nerd-font", webSearchTools: [], shellEnabled: false, tools: { read: true },
			});
		} finally {
			release.resolve();
			await Promise.all([first, second]);
		}
		expect(persisted).toEqual([
			{ enabled: false, iconMode: "ascii", webSearchTools: [], shellEnabled: true, tools: { read: false } },
			{ enabled: false, iconMode: "nerd-font", webSearchTools: [], shellEnabled: false, tools: { read: true } },
		]);
		expect(settings.getSettings()).toEqual(persisted[1]);
	});

	it("loads behind pending writes and cannot replace newer synchronous choices", async () => {
		const path = join(root, "tools-style.json");
		await saveIconMode("ascii", path);
		const entered = deferred();
		const release = deferred();
		ioHooks.beforeWrite = async () => {
			ioHooks.beforeWrite = undefined;
			entered.resolve();
			await release.promise;
		};
		const first = settings.saveSettings({ enabled: false, tools: { read: false } }, path);
		await entered.promise;
		const loading = loadSettings(path);
		const newer = settings.saveSettings({ iconMode: "off", shellEnabled: false, tools: { read: true } }, path);
		try {
			expect(settings.getSettings()).toEqual({
				enabled: false, iconMode: "off", webSearchTools: [], shellEnabled: false, tools: { read: true },
			});
		} finally {
			release.resolve();
			await Promise.all([first, loading, newer]);
		}
		expect(settings.getSettings()).toEqual({
			enabled: false, iconMode: "off", webSearchTools: [], shellEnabled: false, tools: { read: true },
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(settings.getSettings());
	});

	it("does not let a load already reading overwrite a newer in-memory icon choice", async () => {
		const path = join(root, "tools-style.json");
		await writeFile(path, '{"enabled":false,"iconMode":"nerd-font","shellEnabled":false,"tools":{"read":false}}');
		const entered = deferred();
		const release = deferred();
		ioHooks.beforeRead = async (target) => {
			if (target !== path) return;
			ioHooks.beforeRead = undefined;
			entered.resolve();
			await release.promise;
		};
		const loading = loadSettings(path);
		try {
			await entered.promise;
			setIconMode("off");
		} finally {
			release.resolve();
			await loading;
		}
		expect(settings.getSettings()).toEqual({
			enabled: true, iconMode: "off", webSearchTools: [], shellEnabled: true, tools: {},
		});
	});
});

describe("settings shutdown queue drain", () => {
	it("waits for already queued choices to reach disk without another save or reload", async () => {
		const path = join(root, "tools-style.json");
		const entered = deferred();
		const release = deferred();
		ioHooks.beforeWrite = async () => {
			ioHooks.beforeWrite = undefined;
			entered.resolve();
			await release.promise;
		};
		const first = settings.saveSettings({ enabled: false, tools: { read: false } }, path);
		const second = settings.saveSettings({ shellEnabled: false, iconMode: "off" }, path);
		const flushing = settings.flushSettingsWrites();
		let drained = false;
		void flushing.then(() => { drained = true; });
		try {
			await entered.promise;
			expect(drained).toBe(false);
			expect(settings.getSettings()).toEqual({
				enabled: false, iconMode: "off", webSearchTools: [], shellEnabled: false, tools: { read: false },
			});
		} finally {
			release.resolve();
			await Promise.all([first, second, flushing]);
		}
		expect(drained).toBe(true);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			enabled: false, iconMode: "off", webSearchTools: [], shellEnabled: false, tools: { read: false },
		});
		expect(await readdir(root)).toEqual(["tools-style.json"]);
	});

	it("drains a handled failure without reporting it again or blocking the next queued choice", async () => {
		const path = join(root, "tools-style.json");
		const failure = new Error("rename denied during shutdown");
		ioHooks.beforeRename = async () => {
			ioHooks.beforeRename = undefined;
			throw failure;
		};
		const first = settings.saveSettings({ tools: { read: false } }, path);
		const rejected = expect(first).rejects.toBe(failure);
		const second = settings.saveSettings({ shellEnabled: false }, path);
		await expect(settings.flushSettingsWrites()).resolves.toBeUndefined();
		await Promise.all([rejected, second]);

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			enabled: true, iconMode: "ascii", webSearchTools: [], shellEnabled: false, tools: { read: false },
		});
	});
});

describe("atomic temporary-file ownership", () => {
	it("does not remove a pre-existing adjacent file when exclusive creation fails", async () => {
		const path = join(root, "tools-style.json");
		await saveIconMode("ascii", path);
		const original = await readFile(path, "utf8");
		let occupied = "";
		ioHooks.beforeWrite = async (target) => {
			ioHooks.beforeWrite = undefined;
			if (typeof target !== "string") throw new Error("Expected a filesystem path");
			occupied = target;
			await writeFile(occupied, "pre-existing temporary data", "utf8");
		};

		await expect(settings.saveSettings({ shellEnabled: false }, path)).rejects.toMatchObject({ code: "EEXIST" });
		expect(await readFile(path, "utf8")).toBe(original);
		expect(await readFile(occupied, "utf8")).toBe("pre-existing temporary data");
		expect(settings.isShellEnabledByConfig()).toBe(false);
	});
});
