import {
	containsTerminalImage,
	frameContentWidth,
	frameLines,
	trimOuterRules,
	type FrameOptions,
} from "./frame.js";

interface Renderable {
	render(width: number): string[];
}

type RenderableConstructor<T extends Renderable = Renderable> = abstract new (
	...args: never[]
) => T;

type RenderFunction = (this: Renderable, width: number) => string[];
type DecoratedPrototype = Renderable & Record<symbol, unknown>;

export interface RenderDecoratorConfig<T extends Renderable = Renderable>
	extends Omit<FrameOptions, "title"> {
	enabled?: boolean;
	key: symbol;
	styleBorderFor?: (
		instance: T,
	) => NonNullable<FrameOptions["styleBorder"]>;
	title?: (instance: T) => string | undefined;
	trimOuterRules?: boolean;
}

export type InstallStatus = "already-installed" | "installed" | "unsupported";

interface StoredConfig extends Omit<RenderDecoratorConfig, "enabled"> {
	enabled: boolean;
}

interface ResolvedFrameOptions {
	options: FrameOptions;
	styleSignature: string | undefined;
	title: string | undefined;
}

interface RenderCacheEntry {
	config: StoredConfig;
	output: string[];
	rendered: readonly string[];
	styleSignature: string | undefined;
	title: string | undefined;
	width: number;
}

const BORDER_STYLE_PROBE = "╭─╮│╰─╯";

export function installRenderDecorator<T extends Renderable>(
	component: RenderableConstructor<T>,
	config: RenderDecoratorConfig<T>,
): InstallStatus {
	const prototype = component.prototype as DecoratedPrototype;

	if (prototype[config.key] === true) {
		storeConfig(config);
		return "already-installed";
	}

	const renderOriginal = resolveOriginalRenderer(prototype);
	if (!renderOriginal) return "unsupported";

	storeConfig(config);

	Object.defineProperty(prototype, "render", {
		configurable: true,
		value: createDecoratedRenderer(config.key, renderOriginal),
		writable: true,
	});
	Object.defineProperty(prototype, config.key, {
		configurable: false,
		value: true,
		writable: false,
	});

	return "installed";
}

export function isRenderDecoratorEnabled(key: symbol): boolean {
	return readConfig(key)?.enabled ?? false;
}

export function setRenderDecoratorEnabled(key: symbol, enabled: boolean): void {
	const current = readConfig(key);
	if (current) Reflect.set(globalThis, key, { ...current, enabled });
}

function resolveOriginalRenderer(
	prototype: DecoratedPrototype,
): RenderFunction | undefined {
	if (Object.hasOwn(prototype, "render")) {
		const ownRenderer = prototype.render;
		return typeof ownRenderer === "function" ? ownRenderer : undefined;
	}

	const parent = Object.getPrototypeOf(prototype) as Renderable | null;
	if (typeof parent?.render !== "function") return undefined;

	return function renderInherited(width: number): string[] {
		const currentParent = Object.getPrototypeOf(prototype) as Renderable | null;
		return typeof currentParent?.render === "function"
			? currentParent.render.call(this, width)
			: [];
	};
}

function createDecoratedRenderer(
	key: symbol,
	renderOriginal: RenderFunction,
): RenderFunction {
	const cache = new WeakMap<Renderable, RenderCacheEntry>();

	return function decoratedRender(width: number): string[] {
		const current = readConfig(key);
		if (!current?.enabled) return renderOriginal.call(this, width);

		const innerWidth = frameContentWidth(width, current.horizontalPadding);
		if (innerWidth < 1) return renderOriginal.call(this, width);

		const rendered = renderOriginal.call(this, innerWidth);
		if (containsTerminalImage(rendered)) {
			return renderOriginal.call(this, width);
		}

		try {
			const resolved = resolveFrameOptions(this, current);
			const cached = cache.get(this);
			if (
				cached?.config === current &&
				cached.width === width &&
				cached.title === resolved.title &&
				cached.styleSignature === resolved.styleSignature &&
				linesEqual(cached.rendered, rendered)
			) {
				return cached.output;
			}

			const output = decorateLines(rendered, width, current, resolved.options);
			cache.set(this, {
				config: current,
				output,
				rendered: [...rendered],
				styleSignature: resolved.styleSignature,
				title: resolved.title,
				width,
			});
			return output;
		} catch {
			return renderOriginal.call(this, width);
		}
	};
}

function resolveFrameOptions(
	instance: Renderable,
	config: StoredConfig,
): ResolvedFrameOptions {
	const title = config.title?.(instance);
	const options: FrameOptions = {};

	if (config.horizontalPadding !== undefined) {
		options.horizontalPadding = config.horizontalPadding;
	}
	const styleBorder = config.styleBorderFor?.(instance) ?? config.styleBorder;
	if (styleBorder !== undefined) {
		options.styleBorder = styleBorder;
	}
	if (title) options.title = title;

	return {
		options,
		// Theme providers can change border output without changing component content.
		styleSignature: styleBorder?.(BORDER_STYLE_PROBE),
		title,
	};
}

function decorateLines(
	rendered: readonly string[],
	width: number,
	config: StoredConfig,
	options: FrameOptions,
): string[] {
	const lines = config.trimOuterRules
		? trimOuterRules(rendered)
		: [...rendered];

	return frameLines(lines, width, options);
}

function linesEqual(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((line, index) => line === right[index])
	);
}

function storeConfig<T extends Renderable>(
	config: RenderDecoratorConfig<T>,
): void {
	const stored: StoredConfig = {
		...config,
		enabled: config.enabled ?? true,
	} as StoredConfig;
	Reflect.set(globalThis, config.key, stored);
}

function readConfig(key: symbol): StoredConfig | undefined {
	return Reflect.get(globalThis, key) as StoredConfig | undefined;
}
