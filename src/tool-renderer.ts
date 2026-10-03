import { keyHint, type ExtensionAPI, type Theme, type ToolInfo, type ToolRendererResolver, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, MouseRegion, Text, getCapabilities, getImageDimensions, imageFallback, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { containsTerminalImage } from "./frame.js";
import type { ToolContext, ToolResult, ToolSnapshot, ToolView, ToolViewFactory } from "./tool-presentation.js";
import { setToolSpinnerActive, type ToolSpinnerTarget } from "./tool-spinner.js";
import { getIconMode, getSettings, isShellEnabledByConfig, isToolEnabledByConfig } from "./settings.js";
import type { IconMode } from "./tool-icon.js";
import { isWebSearchTool } from "./web-search-presentation.js";

export interface ToolChildBounds {
	component: Component;
	/** Origin local to the owning fragment, in terminal cells. */
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ToolLayout {
	callRows: string[];
	resultRows: string[];
	callChildBounds: readonly ToolChildBounds[];
	resultChildBounds: readonly ToolChildBounds[];
	/** Fragment origins in the complete, shared layout. */
	callOffset: number;
	resultOffset: number;
	/** Refreshes callRows[0] in place; every other row and all bounds retain identity.
	 * Valid only while semantic inputs, width, padding, theme, icons and expansion are unchanged. */
	refreshHeader?: (spinnerFrameIndex?: number) => void;
}

/** One producer and one shared layout path, installed when semantic views are available. */
export interface ToolRendererImplementation {
	createToolView: ToolViewFactory;
	/** Display-only clock override for shell; public tool callers omit it. */
	layoutToolView: (view: ToolView, snapshot: ToolSnapshot, theme: Theme, width: number, spinnerFrameIndex?: number) => ToolLayout;
	/** May close over the exact-name settings list; called after every snapshot. */
	isWebSearchTool?: (toolName: string, toolInfo: ToolInfo | undefined, details: unknown) => boolean;
	/** Drop owned derived preparation for a real component/environment invalidation. */
	invalidateToolView?: (state: object) => void;
}

/** Shared current renderer state; shell reads this same object without a second enabled flag. */
export interface ToolRendererRuntimeState {
	readonly enabled: boolean;
	readonly revision: number;
	readonly implementation: ToolRendererImplementation | undefined;
}

interface ShellCompatibilityNotification {
	notify: () => void;
	notified: boolean;
}

interface ToolRuntime {
	enabled: boolean;
	enabledInitialized: boolean;
	initialEnvironmentDisabled: boolean;
	revision: number;
	implementation: ToolRendererImplementation | undefined;
	presentations: WeakRef<ToolPresentation>[];
	shellCompatibility: ShellCompatibilityNotification | undefined;
}
const RUNTIME_KEY = Symbol.for("pi-tools-style:runtime");
function runtime(): ToolRuntime {
	let value = Reflect.get(globalThis, RUNTIME_KEY) as ToolRuntime | undefined;
	if (!value) {
		const initialEnvironmentDisabled = process.env.PI_TOOLS_STYLE === "0";
		value = { enabled: !initialEnvironmentDisabled, enabledInitialized: false, initialEnvironmentDisabled,
			revision: 0, implementation: undefined, presentations: [], shellCompatibility: undefined };
		Reflect.set(globalThis, RUNTIME_KEY, value);
	}
	else if (typeof value.enabledInitialized !== "boolean") {
		// A hot-upgraded runtime already represents an established process choice.
		value.enabledInitialized = true;
		value.initialEnvironmentDisabled = false;
	}
	return value;
}

/** Public execution events identify one live TUI state, not replay/export states. */
export class ToolRendererSession {
	private readonly calls = new Map<string, WeakRef<object> | undefined>();

	executionStarted(toolCallId: string): void {
		this.calls.set(toolCallId, undefined);
		for (const ref of runtime().presentations) {
			const row = ref.deref();
			if (row?.session !== this || row.toolCallId !== toolCallId) continue;
			if (row.canClaimAnimation) this.claimState(toolCallId, row.state);
			row.invalidateRuntime();
		}
	}
	executionEnded(toolCallId: string): void {
		this.calls.delete(toolCallId);
		for (const ref of runtime().presentations) {
			const row = ref.deref();
			if (row?.session === this && row.toolCallId === toolCallId) row.invalidateRuntime();
		}
	}
	claimState(toolCallId: string, state: object): void {
		if (this.calls.has(toolCallId) && !this.calls.get(toolCallId)?.deref()) this.calls.set(toolCallId, new WeakRef(state));
	}
	isExecuting(toolCallId: string, state: object): boolean {
		return this.calls.get(toolCallId)?.deref() === state;
	}
	reset(): void {
		this.calls.clear();
		for (const ref of runtime().presentations) {
			const row = ref.deref();
			if (row?.session === this) row.stopAnimation();
		}
	}
	shutdown(): void {
		this.reset();
		runtime().presentations = runtime().presentations.filter((ref) => {
			const row = ref.deref();
			return row !== undefined && row.session !== this;
		});
	}
}

export function isToolRendererEnabled(): boolean { return runtime().enabled; }
export function getToolRendererRuntimeState(): ToolRendererRuntimeState { return runtime(); }
/** Disk/environment defaults apply once; explicit process choices survive session starts and reload. */
export function initializeToolRendererEnabled(enabled: boolean): void {
	const current = runtime();
	if (current.enabledInitialized) return;
	current.enabledInitialized = true;
	const initialEnabled = !current.initialEnvironmentDisabled && enabled;
	if (current.enabled === initialEnabled) return;
	current.enabled = initialEnabled;
	invalidateToolPresentations();
}
export function setToolRendererEnabled(enabled: boolean): void {
	const current = runtime();
	current.enabledInitialized = true;
	if (current.enabled === enabled) return;
	current.enabled = enabled;
	invalidateToolPresentations();
}
export function setToolRendererImplementation(implementation: ToolRendererImplementation | undefined): void {
	runtime().implementation = implementation;
	invalidateToolPresentations();
}

/** Bind one interactive session notification; shutdown removes the captured UI context. */
export function setShellCompatibilityNotifier(notify: (() => void) | undefined): void {
	runtime().shellCompatibility = notify ? { notify, notified: false } : undefined;
}

/** An incompatible private shell shape must never disable public tools or interrupt native rendering. */
export function reportShellIncompatibility(): void {
	const current = runtime();
	const notification = current.shellCompatibility;
	if (!current.enabled || !isShellEnabledByConfig() || !notification || notification.notified) return;
	notification.notified = true;
	try {
		notification.notify();
	} catch {
		// A detached UI cannot turn the native fallback into a rendering failure.
	}
}
/** An exact-name change must not cold-start another row's retained body or clock. */
export function invalidateToolPresentations(toolName?: string): void {
	const current = runtime();
	if (toolName === undefined) current.revision++;
	const live: WeakRef<ToolPresentation>[] = [];
	for (const ref of current.presentations) {
		const presentation = ref.deref();
		if (!presentation) continue;
		live.push(ref);
		if (toolName === undefined || presentation.toolName === toolName) presentation.invalidateRuntime();
	}
	current.presentations = live;
}

const BUILTINS: Readonly<Record<string, true | undefined>> = { bash: true, powershell: true, read: true, edit: true, write: true, find: true, grep: true, ls: true };
const MCP_RESOURCES: Readonly<Record<string, true | undefined>> = { list_mcp_resources: true, list_mcp_resource_templates: true, read_mcp_resource: true };
function isBuiltin(name: string, info: ToolInfo | undefined): boolean {
	return BUILTINS[name] === true && info?.sourceInfo.source === "builtin" && info.sourceInfo.path === `builtin:${name}`;
}
function isMcp(info: ToolInfo | undefined): boolean {
	return info?.sourceInfo.source === "builtin" && info.sourceInfo.path === "builtin:mcp";
}
function isWeb(name: string, info: ToolInfo | undefined, details: unknown): boolean {
	const recognizer = runtime().implementation?.isWebSearchTool;
	return recognizer ? recognizer(name, info, details) : isWebSearchTool(name, info, details, getSettings().webSearchTools);
}
function capturedInfo(info: ToolInfo | undefined): ToolInfo | undefined {
	return info ? { ...info, sourceInfo: { ...info.sourceInfo }, ...(info.namespace ? { namespace: { ...info.namespace } } : {}) } : undefined;
}
function classify(name: string, info: ToolInfo | undefined): ToolSnapshot["presentation"] {
	if (isWeb(name, info, undefined)) return "web";
	if (isMcp(info)) return "mcp";
	if (isBuiltin(name, info)) return "builtin";
	if (!info && (name.startsWith("mcp__") || MCP_RESOURCES[name] === true)) return "mcp-unresolved";
	return "generic";
}

export interface ToolPresentationCatalogEntry {
	readonly name: string;
	readonly presentation: ToolSnapshot["presentation"];
	readonly available: boolean;
	readonly support: "confirmed" | "conditional";
}

/** Public availability plus actual owned historical rows, never name-only renderer ownership. */
export function getToolPresentationCatalog(tools: readonly ToolInfo[]): readonly ToolPresentationCatalogEntry[] {
	const available = new Map<string, ToolInfo>();
	const names = new Set(Object.keys(BUILTINS));
	for (const tool of tools) {
		if (tool.exposure === "hidden") continue;
		available.set(tool.name, tool);
		names.add(tool.name);
	}
	const observed = new Map<string, ToolSnapshot["presentation"]>();
	const current = runtime();
	const live: WeakRef<ToolPresentation>[] = [];
	for (const ref of current.presentations) {
		const row = ref.deref();
		if (!row) continue;
		live.push(ref);
		names.add(row.toolName);
		// Web promotion is sticky even if another historical row predates recognition.
		if (observed.get(row.toolName) !== "web") observed.set(row.toolName, row.catalogPresentation);
	}
	current.presentations = live;
	const settings = getSettings();
	for (const name of Object.keys(settings.tools)) names.add(name);
	for (const name of settings.webSearchTools) names.add(name);
	const entries: ToolPresentationCatalogEntry[] = [];
	for (const name of names) {
		const info = available.get(name);
		const publicKind = classify(name, info);
		const historicalKind = observed.get(name);
		const presentation = historicalKind === "web" ? "web"
			: historicalKind !== undefined && (!info || publicKind === "generic" || publicKind === "mcp-unresolved")
				? historicalKind : publicKind;
		entries.push({
			name, presentation, available: info !== undefined,
			support: historicalKind !== undefined || (info !== undefined && publicKind !== "generic" && publicKind !== "mcp-unresolved")
				? "confirmed" : "conditional",
		});
	}
	return entries;
}

export function installToolRenderer(pi: ExtensionAPI): ToolRendererSession {
	const session = new ToolRendererSession();
	pi.registerToolRenderer(createToolRendererResolver(pi, session));
	return session;
}

export function createToolRendererResolver(pi: Pick<ExtensionAPI, "getAllTools">, session = new ToolRendererSession()): ToolRendererResolver {
	return (toolName, next) => {
		const downstream = next();
		const info = capturedInfo(pi.getAllTools().find((tool) => tool.name === toolName));
		const kind = classify(toolName, info);
		if ((kind === "generic" || kind === "mcp-unresolved") && downstream?.renderShell === "self") return downstream;
		const capturedDownstream: ToolRenderers | undefined = downstream ? {} : undefined;
		if (downstream && capturedDownstream) {
			const { renderShell, renderCall, renderResult } = downstream;
			if (renderShell !== undefined) capturedDownstream.renderShell = renderShell;
			if (renderCall !== undefined) capturedDownstream.renderCall = renderCall;
			if (renderResult !== undefined) capturedDownstream.renderResult = renderResult;
		}
		// Pi supplies a separate state object per historical row, including HTML rendering.
		const rows = new WeakMap<object, ToolPresentation>();
		const getRow = (context: ToolContext): ToolPresentation => {
			let row = rows.get(context.state);
			if (!row) {
				row = new ToolPresentation(toolName, capturedDownstream, info, kind, pi, session, context.state, context.toolCallId);
				rows.set(context.state, row);
				runtime().presentations.push(new WeakRef(row));
			}
			return row;
		};
		return {
			renderShell: "self",
			renderCall: (args, theme, context) => {
				const row = getRow(context);
				row.updateCall(args, theme, context);
				return row.callFragment;
			},
			renderResult: (result, options, theme, context) => {
				const row = getRow(context);
				row.updateResult(result, options, theme, context);
				return row.resultFragment;
			},
		};
	};
}

type Slot = "call" | "result";
type ResultOptions = Parameters<NonNullable<ToolRenderers["renderResult"]>>[1];
interface CallSnapshot { args: unknown; theme: Theme; context: ToolContext }
interface ResultSnapshot { result: ToolResult; options: ResultOptions; theme: Theme; context: ToolContext }
interface CachedLayout {
	layout: ToolLayout;
	width: number;
	revision: number;
	runtimeRevision: number;
	presentationEnabled: boolean;
	nativeShell?: Component;
}
interface RetainedView {
	view: ToolView;
	snapshot: ToolSnapshot;
	themeColors: Theme["colors"];
	colorMode: string | undefined;
	appearance: Theme["appearance"];
	iconMode: IconMode;
	headerOnly: boolean;
}

/** Stored lines are for composition only; the original child owns focus and capture. */
class NativeLines implements Component {
	constructor(readonly child: Component, private readonly rows: string[], private readonly region: MouseRegion, private readonly width: number) {}
	render(): string[] { return this.rows; }
	invalidate(): void { this.child.invalidate(); }
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.region.handleMouse({ ...event, width: this.width, height: this.rows.length });
	}
}
class ToolFragment implements Component {
	constructor(private readonly presentation: ToolPresentation, private readonly slot: Slot) {}
	render(width: number): string[] {
		const layout = this.presentation.ensureLayout(width).layout;
		return this.slot === "call" ? layout.callRows : layout.resultRows;
	}
	invalidate(): void { this.presentation.invalidate(); }
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.presentation.handleMouse(this.slot, event);
	}
}

class ToolPresentation {
	readonly callFragment: Component = new ToolFragment(this, "call");
	readonly resultFragment: Component = new ToolFragment(this, "result");
	private readonly nativeState = {};
	private readonly regions = new WeakMap<Component, MouseRegion>();
	private call: CallSnapshot | undefined;
	private result: ResultSnapshot | undefined;
	private context!: ToolContext;
	private theme!: Theme;
	private nativeCall: Component | undefined;
	private nativeResult: Component | undefined;
	private callChild: Component | undefined;
	private resultChild: Component | undefined;
	private callDirty = true;
	private resultDirty = true;
	private nativeActivated = false;
	private revision = 0;
	private cached: CachedLayout | undefined;
	private retained: RetainedView | undefined;
	private headerDirty = false;
	/** Only the tick's own synchronous SDK invalidate/updateDisplay transaction. */
	private animationSlot: Slot | "done" | undefined;
	private fullText: Text | undefined;
	private readonly nativeBox = new Box();
	private readonly nativeContainer = new Container();
	private localExpanded: boolean | undefined;
	private lastExpanded: boolean | undefined;
	private observedBeforeExecution = false;
	private readonly spinnerTarget: ToolSpinnerTarget;

	constructor(
		readonly toolName: string,
		private readonly downstream: ToolRenderers | undefined,
		private toolInfo: ToolInfo | undefined,
		private presentation: ToolSnapshot["presentation"],
		private readonly pi: Pick<ExtensionAPI, "getAllTools">,
		readonly session: ToolRendererSession,
		readonly state: object,
		readonly toolCallId: string,
	) {
		this.spinnerTarget = { state, invalidate: () => this.invalidateAnimation() };
	}

	/** Read only during menu discovery; this class remains private to the weak runtime registry. */
	get catalogPresentation(): ToolSnapshot["presentation"] { return this.presentation; }

	/** An already-started snapshot alone cannot claim animation; observe a pending lifecycle first. */
	get canClaimAnimation(): boolean {
		return this.observedBeforeExecution && (!this.result || this.context.isPartial);
	}

	updateCall(args: unknown, theme: Theme, context: ToolContext): void {
		const animation = this.animationSlot === "call" && this.call !== undefined
			&& args === this.call.args && this.sameAnimationContext(theme, context, this.call.context);
		if (!animation) this.animationSlot = undefined;
		this.call = { args, theme, context: { ...context } };
		this.context = this.call.context;
		this.theme = theme;
		if (animation) {
			this.animationSlot = this.result ? "result" : "done";
			return;
		}
		this.observedBeforeExecution ||= !context.executionStarted || !context.argsComplete;
		this.callDirty = true;
		this.changed();
		this.refreshProvenance();
		this.observeExpansion();
		if (this.canClaimAnimation) this.session.claimState(this.toolCallId, this.state);
		this.refreshAnimation();
		// A previously mounted native renderer must see completion even while hidden.
		if (this.nativeActivated) this.ensureNativeCall();
	}
	updateResult(result: ToolResult, options: ResultOptions, theme: Theme, context: ToolContext): void {
		const previous = this.result;
		const animation = this.animationSlot === "result" && previous !== undefined
			// Pi makes a new result wrapper on every updateDisplay; only its source references are stable.
			&& result.content === previous.result.content && result.details === previous.result.details
			&& options.expanded === previous.options.expanded && options.isPartial === previous.options.isPartial
			&& this.sameAnimationContext(theme, context, previous.context);
		if (!animation) this.animationSlot = undefined;
		this.result = { result, options: { ...options }, theme, context: { ...context } };
		this.context = this.result.context;
		this.theme = theme;
		if (animation) {
			this.animationSlot = "done";
			return;
		}
		this.observedBeforeExecution ||= !context.executionStarted || !context.argsComplete;
		this.resultDirty = true;
		this.changed();
		this.refreshProvenance();
		this.observeExpansion();
		if (this.canClaimAnimation) this.session.claimState(this.toolCallId, this.state);
		this.refreshAnimation();
		if (this.nativeActivated) this.ensureNativeResult();
	}
	private sameEnvironment(theme: Theme): boolean {
		const retained = this.retained;
		return retained !== undefined && retained.themeColors === theme.colors
			&& retained.colorMode === theme.getColorMode?.() && retained.appearance === theme.appearance
			&& retained.iconMode === getIconMode();
	}
	private sameAnimationContext(theme: Theme, context: ToolContext, previous: ToolContext): boolean {
		return this.sameEnvironment(theme) && context.args === previous.args && context.state === previous.state
			&& context.toolCallId === previous.toolCallId && context.cwd === previous.cwd
			&& context.executionStarted === previous.executionStarted && context.argsComplete === previous.argsComplete
			&& context.isPartial === previous.isPartial && context.expanded === previous.expanded
			&& context.showImages === previous.showImages && context.isError === previous.isError
			&& context.durationMs === previous.durationMs && context.outputPad === previous.outputPad;
	}
	private changed(): void {
		this.revision++;
		this.cached = undefined;
		this.retained = undefined;
		this.headerDirty = false;
		this.animationSlot = undefined;
	}
	private invalidateView(): void {
		this.changed();
		runtime().implementation?.invalidateToolView?.(this.state);
	}
	private refreshProvenance(): void {
		if (!this.toolInfo && this.presentation === "mcp-unresolved") {
			this.toolInfo = capturedInfo(this.pi.getAllTools().find((tool) => tool.name === this.toolName));
			if (this.toolInfo) this.presentation = classify(this.toolName, this.toolInfo);
		}
		if (isWeb(this.toolName, this.toolInfo, this.result?.result.details)) this.presentation = "web";
	}
	private autoExpandedActive(): boolean {
		return this.presentation === "builtin" && (this.toolName === "edit" || this.toolName === "write") && (!this.result || this.context.isPartial);
	}
	private observeExpansion(): void {
		if (!this.autoExpandedActive()) this.localExpanded = undefined;
		else if (this.lastExpanded !== undefined && this.lastExpanded !== this.context.expanded) this.localExpanded = this.context.expanded;
		this.lastExpanded = this.context.expanded;
	}
	private expanded(): boolean {
		return this.autoExpandedActive() ? (this.localExpanded ?? true) : this.context.expanded;
	}
	private refreshAnimation(): void {
		const current = runtime();
		const running = (!this.result || this.context.isPartial) && (this.context.executionStarted || this.result !== undefined);
		setToolSpinnerActive(this.spinnerTarget, current.enabled && isToolEnabledByConfig(this.toolName)
			&& current.implementation !== undefined && running && this.session.isExecuting(this.toolCallId, this.state));
	}
	stopAnimation(): void {
		setToolSpinnerActive(this.spinnerTarget, false);
	}
	private invalidateAnimation(): void {
		const current = runtime();
		const cached = this.cached;
		if (!current.enabled || !isToolEnabledByConfig(this.toolName) || !current.implementation || !this.retained?.headerOnly
			|| !cached?.layout.refreshHeader || cached.nativeShell
			|| cached.revision !== this.revision || cached.runtimeRevision !== current.revision
			|| !this.sameEnvironment(this.theme)) {
			this.invalidateRuntime();
			return;
		}
		this.headerDirty = true;
		this.animationSlot = "call";
		try {
			// Installed Pi synchronously invalidates both fragments and re-enters each callback once.
			// Later requestRender painting is outside this scope; real inputs always win over the clock.
			this.context.invalidate();
		} finally {
			this.animationSlot = undefined;
		}
	}
	invalidateRuntime(): void {
		this.invalidateView();
		this.refreshAnimation();
		this.context?.invalidate();
	}
	invalidate(): void {
		if (this.animationSlot !== undefined) return;
		this.callDirty = true;
		this.resultDirty = true;
		this.invalidateView();
		this.callChild?.invalidate();
		if (this.resultChild !== this.callChild) this.resultChild?.invalidate();
	}
	private nativeContext(context: ToolContext, lastComponent: Component | undefined): ToolContext {
		return {
			...context, state: this.nativeState, lastComponent,
			invalidate: () => {
				this.callDirty = true;
				this.resultDirty = true;
				this.invalidateView();
				context.invalidate();
			},
		};
	}
	private ensureNativeCall(): Component | undefined {
		if (!this.callDirty) return this.callChild;
		this.callDirty = false;
		const snapshot = this.call ?? { args: this.context.args, theme: this.theme, context: this.context };
		const renderer = this.downstream?.renderCall;
		if (renderer) {
			try {
				this.nativeCall = renderer(snapshot.args, snapshot.theme, this.nativeContext(snapshot.context, this.nativeCall));
				this.callChild = this.nativeCall;
				return this.callChild;
			} catch { this.nativeCall = undefined; }
		}
		this.callChild = new Text(formatNativeCall(this.toolName, snapshot.args, snapshot.theme, snapshot.context.expanded), 0, 0);
		return this.callChild;
	}
	private ensureNativeResult(): Component | undefined {
		if (!this.result || !this.resultDirty) return this.resultChild;
		this.resultDirty = false;
		const snapshot = this.result;
		const renderer = this.downstream?.renderResult;
		if (renderer) {
			try {
				this.nativeResult = renderer(snapshot.result, snapshot.options, snapshot.theme, this.nativeContext(snapshot.context, this.nativeResult));
				this.resultChild = this.nativeResult;
				return this.resultChild;
			} catch { this.nativeResult = undefined; }
		}
		this.resultChild = createNativeResultFallback(snapshot);
		return this.resultChild;
	}
	private nativeChildren(): { call: Component | undefined; result: Component | undefined } {
		this.nativeActivated = true;
		return { call: this.ensureNativeCall(), result: this.ensureNativeResult() };
	}
	private snapshot(): ToolSnapshot {
		return {
			args: this.call ? this.call.args : this.context.args,
			context: this.expanded() === this.context.expanded ? this.context : { ...this.context, expanded: this.expanded() },
			presentation: this.presentation,
			...(this.result ? { result: this.result.result } : {}),
			...(this.toolInfo ? { toolInfo: this.toolInfo } : {}),
		};
	}
	ensureLayout(width: number): CachedLayout {
		const current = runtime();
		const presentationEnabled = current.enabled && isToolEnabledByConfig(this.toolName);
		if (this.retained && !this.sameEnvironment(this.theme)) {
			this.callDirty = true;
			this.resultDirty = true;
			this.invalidateView();
		}
		const cached = this.cached;
		if (cached?.width === width && cached.revision === this.revision && cached.runtimeRevision === current.revision
			&& cached.presentationEnabled === presentationEnabled) {
			if (!this.headerDirty) return cached;
			try {
				cached.layout.refreshHeader?.();
				this.headerDirty = false;
				return cached;
			} catch {
				// A failed capability takes the same complete-layout/native fallback path as initial preparation.
				this.changed();
			}
		}
		let rendered: { layout: ToolLayout; nativeShell?: Component } | undefined;
		if (presentationEnabled && current.implementation) {
			try {
				if (!this.retained) {
					const snapshot = this.snapshot();
					let view = current.implementation.createToolView(this.toolName, snapshot, this.theme);
					if (this.presentation === "generic") {
						const children = this.nativeChildren();
						view = { ...view, sections: [
							...(children.call ? [{ component: children.call, slot: "call" as const }] : []),
							...(children.result ? [{ component: children.result, slot: "result" as const }] : []),
						] };
					}
					this.retained = {
						view, snapshot, themeColors: this.theme.colors, colorMode: this.theme.getColorMode?.(),
						appearance: this.theme.appearance, iconMode: getIconMode(),
						headerOnly: this.presentation !== "generic" && !view.sections.some((section) =>
							typeof section.component.handleMouse === "function" || typeof section.component.handleInput === "function"),
					};
				}
				const { view, snapshot } = this.retained;
				if (view.layout !== "framed" || width >= Math.max(5, 3 + 2 * snapshot.context.outputPad)) {
					rendered = { layout: current.implementation.layoutToolView(view, snapshot, this.theme, width) };
				}
			} catch { /* Presentation failure restores Pi, not a synthetic execution result. */ }
		}
		if (!rendered) rendered = this.nativeLayout(width, presentationEnabled);
		this.cached = { ...rendered, width, revision: this.revision, runtimeRevision: current.revision, presentationEnabled };
		this.headerDirty = false;
		return this.cached;
	}
	private region(component: Component): MouseRegion {
		let region = this.regions.get(component);
		if (!region) {
			region = new MouseRegion(component, () => undefined);
			this.regions.set(component, region);
		}
		return region;
	}
	private nativeLayout(width: number, allowImagePassthrough: boolean): { layout: ToolLayout; nativeShell: Component } {
		const bgFn = (text: string): string => this.theme.bg(this.context.isPartial ? "toolPendingBg" : this.context.isError ? "toolErrorBg" : "toolSuccessBg", text);
		if (!this.downstream) {
			let text = this.theme.fg("toolTitle", this.theme.bold(this.toolName));
			const args = JSON.stringify(this.call ? this.call.args : this.context.args, null, 2);
			if (args) text += `\n\n${args}`;
			const output = nativeText(this.result?.result, this.context.showImages);
			if (output) text += `\n${output}`;
			this.fullText ??= new Text("", this.context.outputPad, 1, bgFn);
			this.fullText.setCustomBgFn(bgFn);
			this.fullText.setPaddingX(this.context.outputPad);
			this.fullText.setText(text);
			const rows = this.fullText.render(width);
			const bounds = { component: this.fullText, x: 0, y: 0, width, height: rows.length };
			return {
				layout: { callRows: this.result ? [] : rows, resultRows: this.result ? rows : [], callChildBounds: this.result ? [] : [bounds], resultChildBounds: this.result ? [bounds] : [], callOffset: 0, resultOffset: 0 },
				nativeShell: this.region(this.fullText),
			};
		}
		const children = this.nativeChildren();
		const self = this.downstream.renderShell === "self";
		const childWidth = self ? width : Math.max(1, width - 2 * this.context.outputPad);
		const callRows = children.call?.render(childWidth) ?? [];
		const resultRows = !children.result ? []
			: children.result === children.call ? callRows
				: children.result.render(childWidth);
		const passthrough = allowImagePassthrough && (containsTerminalImage(callRows) || containsTerminalImage(resultRows));
		const shell = self || passthrough ? this.nativeContainer : this.nativeBox;
		shell.clear();
		if (shell instanceof Box) { shell.setPaddingX(this.context.outputPad); shell.setBgFn(bgFn); }
		if (children.call) shell.addChild(new NativeLines(children.call, callRows, this.region(children.call), childWidth));
		if (children.result) shell.addChild(new NativeLines(children.result, resultRows, this.region(children.result), childWidth));
		const rows = shell.render(width);
		const padX = shell instanceof Box ? this.context.outputPad : 0;
		const padY = shell instanceof Box && rows.length > 0 ? 1 : 0;
		const split = this.result ? Math.min(rows.length, padY + callRows.length) : rows.length;
		const callBounds = children.call ? [{ component: children.call, x: padX, y: padY, width: childWidth, height: callRows.length }] : [];
		const resultBounds = children.result ? [{ component: children.result, x: padX, y: padY + callRows.length - split, width: childWidth, height: resultRows.length }] : [];
		return { layout: { callRows: rows.slice(0, split), resultRows: rows.slice(split), callChildBounds: callBounds, resultChildBounds: resultBounds, callOffset: 0, resultOffset: split }, nativeShell: shell };
	}
	handleMouse(slot: Slot, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const cached = this.ensureLayout(event.width);
		const layout = cached.layout;
		if (event.y < 0 || event.y >= (slot === "call" ? layout.callRows.length : layout.resultRows.length)) return undefined;
		if (cached.nativeShell) {
			return cached.nativeShell.handleMouse?.({ ...event, y: event.y + (slot === "call" ? layout.callOffset : layout.resultOffset), height: layout.callRows.length + layout.resultRows.length });
		}
		const bounds = slot === "call" ? layout.callChildBounds : layout.resultChildBounds;
		for (const child of bounds) {
			if (event.x >= child.x && event.x < child.x + child.width && event.y >= child.y && event.y < child.y + child.height) {
				const dispatched = this.region(child.component).handleMouse({ ...event, x: event.x - child.x, y: event.y - child.y, width: child.width, height: child.height });
				if (dispatched) return dispatched;
				break;
			}
		}
		if (event.type === "click" && event.button === "left" && event.x >= 0 && event.x < event.width && this.autoExpandedActive()) {
			this.localExpanded = !this.expanded();
			this.changed();
			this.context.invalidate();
			return { handled: true };
		}
		return undefined;
	}
}

function formatNativeCall(title: string, args: unknown, theme: Theme, expanded: boolean): string {
	const header = theme.fg("toolTitle", theme.bold(title));
	if (args == null) return header;
	const entries = typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [["args", args]];
	if (entries.length === 0) return header;
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			return `  ${key}: ${text.replace(/\t/g, "   ").replace(/\r/g, "").split("\n").join("\n    ")}`;
		});
		return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
	}
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	return `${header} ${theme.fg("muted", pairs.length > 100 ? `${pairs.slice(0, 97)}...` : pairs)}`;
}
function createNativeResultFallback(snapshot: ResultSnapshot): Component | undefined {
	const output = nativeText(snapshot.result, snapshot.context.showImages);
	if (!output) return undefined;
	const lines = output.split("\n");
	const shown = snapshot.options.expanded ? lines : lines.slice(0, 10);
	const remaining = lines.length - shown.length;
	let text = shown.map((line) => snapshot.theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) text += `${snapshot.theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${snapshot.theme.fg("muted", ")")}`;
	return new Text(text, 0, 0);
}

// Pi's OFF path strips ANSI and binary controls, rather than using the semantic
// display normalizer. Keep it distinct so restoration is byte-for-byte native.
const NATIVE_ANSI = /(?:\u001b\][\s\S]*?(?:\u0007|\u001b\u005c|\u009c))|[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
function nativeText(result: ToolResult | undefined, showImages: boolean): string {
	if (!result) return "";
	let text = result.content.filter((block) => block.type === "text").map((block) => block.text.replace(NATIVE_ANSI, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufff9-\ufffb]/g, "").replace(/\r/g, "")).join("\n");
	if (!getCapabilities().images || !showImages) {
		const images = result.content.filter((block) => block.type === "image").map((block) => imageFallback(block.mimeType ?? "image/unknown", block.data && block.mimeType ? (getImageDimensions(block.data, block.mimeType) ?? undefined) : undefined)).join("\n");
		if (images) text = text ? `${text}\n${images}` : images;
	}
	return text;
}
