import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getIconMode,
	loadSettings,
	saveIconMode,
	setIconMode,
} from "../src/settings.ts";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-tools-style-"));
	setIconMode("ascii");
});

afterEach(async () => {
	await rm(root, { force: true, recursive: true });
	setIconMode("ascii");
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

		expect(await readFile(path, "utf8")).toBe(
			'{\n  "iconMode": "nerd-font"\n}\n',
		);
		expect(getIconMode()).toBe("nerd-font");
	});
});
