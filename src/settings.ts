import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { IconMode } from "./tool-icon.js";

export interface ToolsStyleSettings {
	readonly enabled: boolean;
	readonly iconMode: IconMode;
	readonly webSearchTools: readonly string[];
	readonly shellEnabled: boolean;
	readonly tools: Readonly<Record<string, boolean>>;
}

export interface ToolsStyleSettingsPatch {
	readonly enabled?: boolean;
	readonly iconMode?: IconMode;
	readonly webSearchTools?: readonly string[];
	readonly shellEnabled?: boolean;
	readonly tools?: Readonly<Record<string, boolean>>;
}

interface SettingsStore {
	value: Readonly<ToolsStyleSettings>;
	writerTail: Promise<void>;
	mutationSequence: number;
}

const SETTINGS_KEY = Symbol.for("pi-tools-style:settings");
const DEFAULT_SETTINGS: Readonly<ToolsStyleSettings> = Object.freeze({
	enabled: true,
	iconMode: "ascii",
	webSearchTools: Object.freeze([] as string[]),
	shellEnabled: true,
	tools: Object.freeze(Object.create(null) as Record<string, boolean>),
});
let trustedStore: SettingsStore | undefined;

export function getIconMode(): IconMode {
	return getSettings().iconMode;
}

export function getWebSearchTools(): readonly string[] {
	return getSettings().webSearchTools;
}

export function getSettings(): Readonly<ToolsStyleSettings> {
	return getStore().value;
}

export function isToolEnabledByConfig(toolName: string): boolean {
	const tools = getSettings().tools;
	return Object.hasOwn(tools, toolName) ? tools[toolName] === true : true;
}

export function isShellEnabledByConfig(): boolean {
	return getSettings().shellEnabled;
}

export function setIconMode(iconMode: IconMode): void {
	applyPatch(getStore(), { iconMode });
}

export function loadSettings(path = getSettingsPath()): Promise<void> {
	const store = getStore();
	const mutationSequence = store.mutationSequence;
	return enqueue(store, async () => {
		let value = DEFAULT_SETTINGS;
		try {
			value = normalizeSettings(JSON.parse(await readFile(path, "utf8")));
		} catch {
			// Missing or malformed user config intentionally falls back to defaults.
		}
		if (store.mutationSequence === mutationSequence) store.value = value;
	});
}

export function saveSettings(
	patch: ToolsStyleSettingsPatch,
	path = getSettingsPath(),
): Promise<void> {
	const store = getStore();
	const snapshot = applyPatch(store, patch);
	return enqueue(store, () => persistSettings(snapshot, path));
}

export function saveIconMode(
	iconMode: IconMode,
	path = getSettingsPath(),
): Promise<void> {
	return saveSettings({ iconMode }, path);
}

export function flushSettingsWrites(): Promise<void> {
	return getStore().writerTail;
}

function getSettingsPath(): string {
	return join(getAgentDir(), "config", "tools-style.json");
}

function getStore(): SettingsStore {
	const current: unknown = Reflect.get(globalThis, SETTINGS_KEY);
	if (trustedStore && current === trustedStore) return trustedStore;

	const candidate = typeof current === "object" && current !== null
		? current as Partial<SettingsStore>
		: undefined;
	if (
		candidate &&
		typeof candidate.value === "object" &&
		candidate.value !== null &&
		!Array.isArray(candidate.value) &&
		candidate.writerTail instanceof Promise &&
		typeof candidate.mutationSequence === "number" &&
		Number.isSafeInteger(candidate.mutationSequence) &&
		candidate.mutationSequence >= 0
	) {
		// A reloaded module joins the existing queue, normalizing its value once.
		trustedStore = candidate as SettingsStore;
		trustedStore.value = normalizeSettings(trustedStore.value);
	} else {
		// Repair an absent, legacy direct settings object or foreign runtime value.
		trustedStore = {
			value: normalizeSettings(current),
			writerTail: Promise.resolve(),
			mutationSequence: 0,
		};
		Reflect.set(globalThis, SETTINGS_KEY, trustedStore);
	}
	return trustedStore;
}

function enqueue(store: SettingsStore, operation: () => Promise<void>): Promise<void> {
	const pending = store.writerTail.then(operation);
	// Return this write's rejection, but never poison subsequent queued operations.
	store.writerTail = pending.catch(() => {});
	return pending;
}

function applyPatch(
	store: SettingsStore,
	patch: ToolsStyleSettingsPatch,
): Readonly<ToolsStyleSettings> {
	const current = store.value;
	const enabled = ownValue(patch, "enabled");
	const iconMode = ownValue(patch, "iconMode");
	const webSearchTools = ownValue(patch, "webSearchTools");
	const shellEnabled = ownValue(patch, "shellEnabled");
	const tools = ownValue(patch, "tools");
	const value: Readonly<ToolsStyleSettings> = Object.freeze({
		enabled: typeof enabled === "boolean" ? enabled : current.enabled,
		iconMode: isIconMode(iconMode) ? iconMode : current.iconMode,
		webSearchTools: Array.isArray(webSearchTools)
			? normalizeWebSearchTools(webSearchTools)
			: current.webSearchTools,
		shellEnabled: typeof shellEnabled === "boolean" ? shellEnabled : current.shellEnabled,
		tools: typeof tools === "object" && tools !== null && !Array.isArray(tools)
			? normalizeTools(tools, current.tools)
			: current.tools,
	});
	store.value = value;
	store.mutationSequence++;
	return value;
}

async function persistSettings(settings: Readonly<ToolsStyleSettings>, path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	let writeCompleted = false;
	try {
		await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		writeCompleted = true;
		await rename(temporary, path);
	} catch (error) {
		// An exclusive-create collision is not our file; later rename failures are.
		const occupied = !writeCompleted && typeof error === "object" && error !== null &&
			"code" in error && error.code === "EEXIST";
		if (!occupied) {
			try {
				await unlink(temporary);
			} catch {
				// Cleanup must not replace the original write/rename failure.
			}
		}
		throw error;
	}
}

function normalizeSettings(value: unknown): Readonly<ToolsStyleSettings> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_SETTINGS;
	const enabled = ownValue(value, "enabled");
	const iconMode = ownValue(value, "iconMode");
	const shellEnabled = ownValue(value, "shellEnabled");
	return Object.freeze({
		enabled: typeof enabled === "boolean" ? enabled : DEFAULT_SETTINGS.enabled,
		iconMode: isIconMode(iconMode) ? iconMode : DEFAULT_SETTINGS.iconMode,
		webSearchTools: normalizeWebSearchTools(ownValue(value, "webSearchTools")),
		shellEnabled: typeof shellEnabled === "boolean" ? shellEnabled : DEFAULT_SETTINGS.shellEnabled,
		tools: normalizeTools(ownValue(value, "tools")),
	});
}

function ownValue(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function normalizeTools(
	value: unknown,
	base?: Readonly<Record<string, boolean>>,
): Readonly<Record<string, boolean>> {
	const tools = Object.assign(Object.create(null) as Record<string, boolean>, base);
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		for (const [name, enabled] of Object.entries(value)) {
			if (name.length > 0 && typeof enabled === "boolean") tools[name] = enabled;
		}
	}
	return Object.freeze(tools);
}

export function isIconMode(value: unknown): value is IconMode {
	return value === "ascii" || value === "nerd-font" || value === "off";
}


function normalizeWebSearchTools(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return DEFAULT_SETTINGS.webSearchTools;
	return Object.freeze(value.filter(
		(entry): entry is string => typeof entry === "string" && entry.length > 0,
	));
}
