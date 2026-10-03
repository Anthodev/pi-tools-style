import {
	BashExecutionComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
	installShellRenderer,
	type ShellInstallStatus,
} from "./src/render-decorator.js";
import {
	installToolRenderer,
	invalidateToolPresentations,
	initializeToolRendererEnabled,
	reportShellIncompatibility,
	isToolRendererEnabled,
	setShellCompatibilityNotifier,
	setToolRendererEnabled,
	setToolRendererImplementation,
	type ToolRendererSession,
} from "./src/tool-renderer.js";
import { clearToolSpinners } from "./src/tool-spinner.ts";
import { createToolView, invalidateToolViewCache } from "./src/tool-presentation.js";
import { layoutToolView } from "./src/frame.js";
import { createWebSearchView, invalidateWebSearchViewCache, isWebSearchTool } from "./src/web-search-presentation.js";
import {
	flushSettingsWrites,
	getSettings,
	getWebSearchTools,
	isIconMode,
	isShellEnabledByConfig,
	loadSettings,
	saveSettings,
} from "./src/settings.ts";
import {
	setThemeProvider,
} from "./src/tool-category.js";

import { openToolsStyleConfig, type ToolsStyleConfigChange } from "./src/config-menu.js";

export interface InstallationResult {
	shell: ShellInstallStatus;
	session: ToolRendererSession;
}

export function installToolsStyle(pi: ExtensionAPI): InstallationResult {
	setToolRendererImplementation({
		createToolView: (toolName, snapshot, theme) => snapshot.presentation === "web"
			? createWebSearchView(toolName, snapshot, theme)
			: createToolView(toolName, snapshot, theme),
		layoutToolView,
		isWebSearchTool: (toolName, toolInfo, details) => isWebSearchTool(toolName, toolInfo, details, getWebSearchTools()),
		invalidateToolView: (state) => {
			invalidateToolViewCache(state);
			invalidateWebSearchViewCache(state);
		},
	});
	const session = installToolRenderer(pi);
	const shell = installShellRenderer(BashExecutionComponent);

	return { shell, session };
}

export default function toolsStyleExtension(pi: ExtensionAPI): void {
	const installation = installToolsStyle(pi);
	// Settings installs memory synchronously; runtime effects precede awaiting that write's durability.
	const applyChange = (change: ToolsStyleConfigChange): Promise<void> => {
		let write: Promise<void>;
		switch (change.kind) {
			case "enabled":
				write = saveSettings({ enabled: change.enabled });
				setToolRendererEnabled(change.enabled);
				if (!change.enabled) clearToolSpinners();
				break;
			case "iconMode":
				write = saveSettings({ iconMode: change.iconMode });
				invalidateToolPresentations();
				break;
			case "tool":
				write = saveSettings({ tools: { [change.name]: change.enabled } });
				invalidateToolPresentations(change.name);
				break;
			case "shellEnabled":
				write = saveSettings({ shellEnabled: change.enabled });
				break;
		}
		if (installation.shell === "unsupported" && isToolRendererEnabled() && isShellEnabledByConfig()) reportShellIncompatibility();
		return write;
	};
	pi.on("session_start", async (_event, context) => {
		clearToolSpinners();
		installation.session.reset();
		setShellCompatibilityNotifier(context.hasUI
			? () => context.ui.notify("Shell styling unavailable: incompatible Pi renderer internals.", "warning")
			: undefined);
		await loadSettings();
		initializeToolRendererEnabled(getSettings().enabled);
		setThemeProvider(() => context.ui.theme);
		invalidateToolPresentations();
		if (installation.shell === "unsupported" && isToolRendererEnabled() && isShellEnabledByConfig()) reportShellIncompatibility();
	});
	pi.on("session_shutdown", async () => {
		setShellCompatibilityNotifier(undefined);
		clearToolSpinners();
		installation.session.shutdown();
		setThemeProvider(undefined);
		await flushSettingsWrites();
	});
	pi.on("tool_execution_start", (event) => {
		installation.session.executionStarted(event.toolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		installation.session.executionEnded(event.toolCallId);
	});

	const command = {
		description: "Configure tool boxes and icon mode",
		handler: async (args, context) => {
			const [action = "", value, ...extra] = args.trim().toLowerCase().split(/\s+/u);
			const notifyUsage = (): void => {
				context.ui.notify(
					"Usage: /tools-style [on|off|config|icons ascii|icons nerd-font|icons off]",
					"warning",
				);
			};
			if (action === "config") {
				if (value !== undefined) {
					notifyUsage();
					return;
				}
				// RPC hasUI cannot host public custom TUI components.
				if (context.mode !== "tui") {
					context.ui.notify("Tool presentation configuration requires interactive TUI mode.", "warning");
					return;
				}
				await openToolsStyleConfig(pi, context, applyChange);
				return;
			}
			let change: ToolsStyleConfigChange;
			let success: string;
			if (action === "icons") {
				if (!isIconMode(value) || extra.length > 0) {
					notifyUsage();
					return;
				}
				change = { kind: "iconMode", iconMode: value };
				success = `Tool icons: ${value}.`;
			} else {
				if ((action !== "" && action !== "on" && action !== "off") || value !== undefined) {
					notifyUsage();
					return;
				}
				const enabled = resolveRequestedState(action, isToolRendererEnabled());
				change = { kind: "enabled", enabled };
				success = `Tool boxes ${enabled ? "enabled" : "disabled"}.`;
			}
			try {
				await applyChange(change);
			} catch {
				try {
					context.ui.notify("Tool presentation choice is active in this session, but not saved.", "error");
				} catch {
					// A detached command UI must not turn a handled write rejection into another failure.
				}
				return;
			}
			context.ui.notify(success);
		},
	} satisfies Parameters<ExtensionAPI["registerCommand"]>[1];

	pi.registerCommand("tools-style", command);
	pi.registerCommand("tstyle", {
		...command,
		description: "Alias for /tools-style",
	});
}

function resolveRequestedState(requested: string, current: boolean): boolean {
	if (requested === "on") return true;
	if (requested === "off") return false;
	return !current;
}

