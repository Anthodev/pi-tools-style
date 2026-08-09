import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import {
	installRenderDecorator,
	isRenderDecoratorEnabled,
} from "../src/render-decorator.js";

const identity = (value: string) => value;

describe("installRenderDecorator", () => {
	it("delegates at inner width then frames the original output", () => {
		const widths: number[] = [];
		class Example {
			render(width: number): string[] {
				widths.push(width);
				return ["content"];
			}
		}

		const status = installRenderDecorator(Example, {
			key: Symbol("inner-width"),
			title: () => "read",
			styleBorder: identity,
		});
		const lines = new Example().render(20);

		expect(status).toBe("installed");
		expect(widths).toEqual([16]);
		expect(lines.map(stripTerminalSequences)).toEqual([
			"╭─ read ───────────╮",
			"│ content          │",
			"╰──────────────────╯",
		]);
		expect(lines.every((line) => visibleWidth(line) === 20)).toBe(true);
	});

	it("is idempotent and refreshes configuration across reloads", () => {
		class Example {
			render(_width: number): string[] {
				return ["content"];
			}
		}
		const key = Symbol("reload-safe");

		installRenderDecorator(Example, {
			key,
			title: () => "old",
			styleBorder: identity,
		});
		const status = installRenderDecorator(Example, {
			key,
			title: () => "new",
			styleBorder: identity,
		});
		const lines = new Example().render(16).map(stripTerminalSequences);

		expect(status).toBe("already-installed");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("new");
		expect(lines[0]).not.toContain("old");
	});

	it("preserves inherited renderer composition", () => {
		class Parent {
			render(width: number): string[] {
				return [`first:${width}`];
			}
		}
		class Child extends Parent {}
		const key = Symbol("inherited");

		installRenderDecorator(Child, {
			key,
			styleBorder: identity,
		});
		Parent.prototype.render = function render(width: number): string[] {
			return [`latest:${width}`];
		};

		const lines = new Child().render(18).map(stripTerminalSequences);
		expect(lines[1]).toContain("latest:14");
	});

	it("can be disabled without replacing the original renderer", () => {
		class Example {
			render(width: number): string[] {
				return [`plain:${width}`];
			}
		}
		const key = Symbol("disabled");

		installRenderDecorator(Example, {
			key,
			styleBorder: identity,
		});
		installRenderDecorator(Example, {
			enabled: false,
			key,
			styleBorder: identity,
		});

		expect(new Example().render(20)).toEqual(["plain:20"]);
	});

	it("fails open when decoration throws", () => {
		class Example {
			render(width: number): string[] {
				return [`plain:${width}`];
			}
		}

		installRenderDecorator(Example, {
			key: Symbol("fail-open"),
			styleBorder: identity,
			title: () => {
				throw new Error("incompatible Pi internals");
			},
		});

		expect(new Example().render(20)).toEqual(["plain:20"]);
	});
	it("derives border style from the rendered component", () => {
		class Example {
			readonly color = "31";

			render(_width: number): string[] {
				return ["content"];
			}
		}
		const styleBorderFor = vi.fn(
			(instance: Example) =>
				(value: string): string =>
					`\u001b[${instance.color}m${value}\u001b[0m`,
		);
		const instance = new Example();

		installRenderDecorator(Example, {
			key: Symbol("instance-style"),
			styleBorderFor,
		});
		instance.render(20);

		expect(styleBorderFor).toHaveBeenCalledWith(instance);
	});

	it("does not expose an enabled state when installation is unsupported", () => {
		class Unsupported {}
		const key = Symbol("unsupported");

		const status = installRenderDecorator(Unsupported as never, { key });

		expect(status).toBe("unsupported");
		expect(isRenderDecoratorEnabled(key)).toBe(false);
	});

	it("reuses framed output while rendered content and chrome stay unchanged", () => {
		class Example {
			render(_width: number): string[] {
				return ["content"];
			}
		}
		const instance = new Example();

		installRenderDecorator(Example, {
			key: Symbol("cached-frame"),
			styleBorder: identity,
			title: () => "read",
		});
		const first = instance.render(20);
		const second = instance.render(20);

		expect(second).toBe(first);
	});

	it("invalidates cached output when rendered content changes", () => {
		let content = "first";
		class Example {
			render(_width: number): string[] {
				return [content];
			}
		}
		const instance = new Example();

		installRenderDecorator(Example, {
			key: Symbol("content-cache"),
			styleBorder: identity,
		});
		const first = instance.render(20);
		content = "second";
		const second = instance.render(20);

		expect(second).not.toBe(first);
		expect(second.join("\n")).toContain("second");
	});

	it("invalidates cached output when title or border styling changes", () => {
		let title = "first";
		let borderPrefix = "old";
		class Example {
			render(_width: number): string[] {
				return ["content"];
			}
		}
		const instance = new Example();

		installRenderDecorator(Example, {
			key: Symbol("chrome-cache"),
			styleBorder: (value) => `${borderPrefix}:${value}`,
			title: () => title,
		});
		const first = instance.render(20);
		title = "second";
		const second = instance.render(20);
		borderPrefix = "new";
		const third = instance.render(20);

		expect(second).not.toBe(first);
		expect(second.join("\n")).toContain("second");
		expect(third).not.toBe(second);
		expect(third[0]).toContain("new:");
	});
});
