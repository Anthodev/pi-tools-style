import {
	BashExecutionComponent,
	ToolExecutionComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
	installRenderDecorator,
	isRenderDecoratorEnabled,
	setRenderDecoratorEnabled,
	type InstallStatus,
} from "./src/render-decorator.js";
import { formatToolTitle } from "./src/tool-icon.ts";
import {
	clearToolSpinners,
	toolSpinnerFrame,
} from "./src/tool-spinner.ts";
import {
	getIconMode,
	isIconMode,
	loadSettings,
	saveIconMode,
} from "./src/settings.ts";
import {
	createCategoryBorderStyle,
	createToolBorderStyle,
	setThemeProvider,
	type BorderStyle,
} from "./src/tool-category.js";

const TOOL_RENDER_KEY = Symbol.for("pi-tools-style:tool-render");
const SHELL_RENDER_KEY = Symbol.for("pi-tools-style:shell-render");

export interface InstallationResult {
	shell: InstallStatus;
	tools: InstallStatus;
}

export function installToolsStyle(): InstallationResult {
	const enabled = process.env.PI_TOOLS_STYLE !== "0";

	const tools = installRenderDecorator(ToolExecutionComponent, {
		enabled,
		key: TOOL_RENDER_KEY,
		styleBorderFor: toolBorderStyle,
		title: toolTitle,
		trimOuterRules: true,
	});
	const shell = installRenderDecorator(BashExecutionComponent, {
		enabled,
		key: SHELL_RENDER_KEY,
		styleBorderFor: () => createCategoryBorderStyle("execute"),
		title: () => formatToolTitle("shell", getIconMode()),
		trimOuterRules: true,
	});

	return { shell, tools };
}

export default function toolsStyleExtension(pi: ExtensionAPI): void {
	const installation = installToolsStyle();
	pi.on("session_start", async (_event, context) => {
		clearToolSpinners();
		await loadSettings();
		setThemeProvider(() => context.ui.theme);
	});
	pi.on("session_shutdown", () => {
		clearToolSpinners();
		setThemeProvider(undefined);
		return Promise.resolve();
	});

	const command = {
		description: "Configure tool boxes and icon mode",
		handler: async (args, context) => {
			const [action = "", value, ...extra] = args
				.trim()
				.toLowerCase()
				.split(/\s+/u);
			const notifyUsage = (): void => {
				context.ui.notify(
					"Usage: /tools-style [on|off|icons ascii|icons nerd-font|icons off]",
					"warning",
				);
			};

			if (action === "icons") {
				if (!isIconMode(value) || extra.length > 0) {
					notifyUsage();
					return;
				}

				await saveIconMode(value);
				context.ui.notify(`Tool icons: ${value}.`);
				return;
			}

			if (
				(action !== "" && action !== "on" && action !== "off") ||
				value !== undefined
			) {
				notifyUsage();
				return;
			}

			if (
				installation.tools === "unsupported" ||
				installation.shell === "unsupported"
			) {
				context.ui.notify(
					"Tool boxes unavailable: incompatible Pi renderer internals.",
					"warning",
				);
				return;
			}

			const current = isRenderDecoratorEnabled(TOOL_RENDER_KEY);
			const enabled = resolveRequestedState(action, current);

			setRenderDecoratorEnabled(TOOL_RENDER_KEY, enabled);
			setRenderDecoratorEnabled(SHELL_RENDER_KEY, enabled);
			if (!enabled) clearToolSpinners();
			context.ui.notify(`Tool boxes ${enabled ? "enabled" : "disabled"}.`);
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

function toolName(component: ToolExecutionComponent): string {
	const candidate = (component as unknown as { toolName?: unknown }).toolName;
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: "tool";
}

function toolTitle(component: ToolExecutionComponent): string {
	const mode = getIconMode();
	const title = formatToolTitle(toolName(component), mode);
	const spinner = toolSpinnerFrame(component, mode);
	return spinner ? `${title} ${spinner}` : title;
}

function toolBorderStyle(component: ToolExecutionComponent): BorderStyle {
	return createToolBorderStyle(toolName(component));
}
