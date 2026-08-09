import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { IconMode } from "./tool-icon.js";

interface ToolsStyleSettings {
	iconMode: IconMode;
}

const SETTINGS_KEY = Symbol.for("pi-tools-style:settings");
const DEFAULT_SETTINGS: Readonly<ToolsStyleSettings> = {
	iconMode: "ascii",
};

export function getIconMode(): IconMode {
	return getSettings().iconMode;
}

export function setIconMode(iconMode: IconMode): void {
	Reflect.set(globalThis, SETTINGS_KEY, {
		iconMode,
	} satisfies ToolsStyleSettings);
}

export async function loadSettings(path = getSettingsPath()): Promise<void> {
	setIconMode(DEFAULT_SETTINGS.iconMode);

	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as {
			iconMode?: unknown;
		};
		if (isIconMode(parsed.iconMode)) setIconMode(parsed.iconMode);
	} catch {
		// Missing or malformed user config intentionally falls back to ASCII.
	}
}

export async function saveIconMode(
	iconMode: IconMode,
	path = getSettingsPath(),
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ iconMode }, null, 2)}\n`, "utf8");
	setIconMode(iconMode);
}

function getSettingsPath(): string {
	return join(getAgentDir(), "config", "tools-style.json");
}

function getSettings(): ToolsStyleSettings {
	const current = Reflect.get(globalThis, SETTINGS_KEY) as
		| ToolsStyleSettings
		| undefined;
	if (current) return current;

	const initial = { ...DEFAULT_SETTINGS };
	Reflect.set(globalThis, SETTINGS_KEY, initial);
	return initial;
}

export function isIconMode(value: unknown): value is IconMode {
	return value === "ascii" || value === "nerd-font" || value === "off";
}
