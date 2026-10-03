import { getSettingsListTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

import { getSettings, isShellEnabledByConfig, isToolEnabledByConfig } from "./settings.js";
import type { IconMode } from "./tool-icon.js";
import { getToolPresentationCatalog, isToolRendererEnabled, type ToolPresentationCatalogEntry } from "./tool-renderer.js";

/**
 * Change emitted by the config menu. The caller owns persistence and runtime effects; the menu only
 * reports the row the user changed.
 */
export type ToolsStyleConfigChange =
	| { readonly kind: "enabled"; readonly enabled: boolean }
	| { readonly kind: "iconMode"; readonly iconMode: IconMode }
	| { readonly kind: "shellEnabled"; readonly enabled: boolean }
	| { readonly kind: "tool"; readonly name: string; readonly enabled: boolean };

const ENABLED_ID = "global.enabled";
const ICON_MODE_ID = "global.iconMode";
const SHELL_ENABLED_ID = "global.shellEnabled";
const TOOL_ID_PREFIX = "tool:";

const ON = "on";
const OFF = "off";
const ICON_MODES = ["ascii", "nerd-font", "off"] as const;
const NATIVE_RANK: Record<string, number> = {
	bash: 0,
	powershell: 1,
	read: 2,
	edit: 3,
	write: 4,
	find: 5,
	grep: 6,
	ls: 7,
};
const NATIVE_COUNT = Object.keys(NATIVE_RANK).length;

const ENABLED_DESCRIPTION = "Renders tool calls with the tools-style presentation for this session.";
const ICON_MODE_DESCRIPTION = "Icon set used in tool call titles.";
const SHELL_ENABLED_DESCRIPTION = "Applies the tools-style presentation to direct shell command output.";
const EXPOSED_NOTE = "Currently exposed by this session.";
const OFFLINE_NOTE = "Not currently exposed; preference is retained for this exact name.";
const CONDITIONAL_NOTE = "Applies when this tool uses a supported renderer; third-party self-renderers remain unchanged.";
const EFFECTIVE_OFF_NOTE = "Global styling is off, so this preference takes effect only when global styling is on.";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_VISIBLE_ROWS = 15;
const HEADER = "Tools style configuration";
const HELPER = "Type to search. Enter or Space changes the selected value, Escape closes.";

function iconModeOf(value: string): IconMode | undefined {
	switch (value) {
		case "ascii":
		case "nerd-font":
		case "off":
			return value;
		default:
			return undefined;
	}
}

/**
 * Display-only sanitising: control characters would corrupt the terminal grid, and built-in search
 * only reads the label. The row id and the emitted tool name always keep the exact identity.
 */
function displayName(name: string): string {
	return name.replace(CONTROL_CHARACTERS, "");
}

/** Own-property lookup: reserved-looking names must never resolve inherited values. */
function nativeRank(name: string): number | undefined {
	return Object.hasOwn(NATIVE_RANK, name) ? NATIVE_RANK[name] : undefined;
}

/** Native tools first in their existing order, then every other exact name sorted deterministically. */
function orderEntries(entries: readonly ToolPresentationCatalogEntry[]): readonly ToolPresentationCatalogEntry[] {
	return [...entries].sort((a, b) => {
		const left = nativeRank(a.name);
		const right = nativeRank(b.name);
		if (left !== undefined || right !== undefined) {
			return (left ?? NATIVE_COUNT) - (right ?? NATIVE_COUNT);
		}
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});
}

function toolDescription(entry: ToolPresentationCatalogEntry, globalOff: boolean): string {
	const parts = [entry.available ? EXPOSED_NOTE : OFFLINE_NOTE];
	// Availability and support are independent dimensions: an offline identity is still conditional
	// unless owned-row evidence confirmed its renderer.
	if (entry.support === "conditional") {
		parts.push(CONDITIONAL_NOTE);
	}
	if (globalOff) {
		parts.push(EFFECTIVE_OFF_NOTE);
	}
	return parts.join(" ");
}

function toolItem(entry: ToolPresentationCatalogEntry, globalOff: boolean): SettingItem {
	return {
		id: `${TOOL_ID_PREFIX}${entry.name}`,
		label: displayName(entry.name),
		description: toolDescription(entry, globalOff),
		currentValue: isToolEnabledByConfig(entry.name) ? ON : OFF,
		values: [ON, OFF],
	};
}

/**
 * Row ids are exact and collision-safe: the global rows are matched before the fixed `tool:` prefix,
 * and only that fixed prefix is ever stripped, so names containing colons stay intact.
 */
function changeOf(id: string, value: string): ToolsStyleConfigChange | undefined {
	if (id === ENABLED_ID) {
		return { kind: "enabled", enabled: value === ON };
	}
	if (id === SHELL_ENABLED_ID) {
		return { kind: "shellEnabled", enabled: value === ON };
	}
	if (id === ICON_MODE_ID) {
		const iconMode = iconModeOf(value);
		return iconMode === undefined ? undefined : { kind: "iconMode", iconMode };
	}
	if (id.startsWith(TOOL_ID_PREFIX)) {
		return { kind: "tool", name: id.slice(TOOL_ID_PREFIX.length), enabled: value === ON };
	}
	return undefined;
}

export function openToolsStyleConfig(
	pi: Pick<ExtensionAPI, "getAllTools">,
	context: ExtensionCommandContext,
	onChange: (change: ToolsStyleConfigChange) => Promise<void>,
): Promise<void> {
	if (context.mode !== "tui") {
		return Promise.resolve();
	}
	return context.ui.custom<void>((tui, theme, _keybindings, done) => {
		// The catalog is evaluated once per opening, so a later opening sees newly discovered tools.
		const entries = orderEntries(getToolPresentationCatalog(pi.getAllTools()));
		const globalOff = !isToolRendererEnabled();
		const toolRows = entries.map((entry) => ({ entry, item: toolItem(entry, globalOff) }));
		const items: SettingItem[] = [
			{
				id: ENABLED_ID,
				label: "Tools style rendering",
				description: ENABLED_DESCRIPTION,
				// Raw runtime state for this session, not the saved preference.
				currentValue: isToolRendererEnabled() ? ON : OFF,
				values: [ON, OFF],
			},
			{
				id: ICON_MODE_ID,
				label: "Icon mode",
				description: ICON_MODE_DESCRIPTION,
				currentValue: getSettings().iconMode,
				values: [...ICON_MODES],
			},
			{
				id: SHELL_ENABLED_ID,
				label: "Shell commands (!/!!)",
				description: SHELL_ENABLED_DESCRIPTION,
				currentValue: isShellEnabledByConfig() ? ON : OFF,
				values: [ON, OFF],
			},
			...toolRows.map((row) => row.item),
		];

		let closed = false;
		const close = (): void => {
			if (closed) {
				return;
			}
			closed = true;
			done(undefined);
		};

		const reportFailure = (): void => {
			try {
				context.ui.notify("Tools style: that change could not be saved", "warning");
			} catch {
				// Best-effort warning; the caller's promise already reports the failure.
			}
		};

		/** Keeps every tool row's gate disclosure in step with the applied global choice. */
		const refreshGateDisclosure = (enabled: boolean): void => {
			const off = !enabled;
			for (const row of toolRows) {
				row.item.description = toolDescription(row.entry, off);
			}
		};

		const emit = (id: string, newValue: string): void => {
			const change = changeOf(id, newValue);
			if (change === undefined) {
				return;
			}
			if (change.kind === "enabled") {
				// The row value and its disclosure move together, without rebuilding the menu.
				refreshGateDisclosure(change.enabled);
			}
			let pending: Promise<void>;
			try {
				pending = onChange(change);
			} catch {
				reportFailure();
				return;
			}
			void pending.then(undefined, reportFailure);
		};

		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, MAX_VISIBLE_ROWS),
			getSettingsListTheme(),
			emit,
			close,
			{ enableSearch: true },
		);

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", HEADER), 1, 0));
		container.addChild(new Text(theme.fg("dim", HELPER), 1, 0));
		container.addChild(settingsList);

		return {
			render(width: number): string[] {
				return container.render(width);
			},
			invalidate(): void {
				container.invalidate();
			},
			// Every key byte is delegated to the SDK component, which owns search and value cycling.
			handleInput(data: string): void {
				if (closed) {
					return;
				}
				settingsList.handleInput(data);
				if (!closed) {
					tui.requestRender();
				}
			},
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (closed) {
					return undefined;
				}
				const result = container.handleMouse(event);
				if (!closed) {
					tui.requestRender();
				}
				return result;
			},
			dispose(): void {
				// Writes stay detached: settlements must not repaint or mutate this disposed component.
				closed = true;
			},
		};
	});
}
