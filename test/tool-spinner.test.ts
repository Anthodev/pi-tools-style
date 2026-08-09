import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearToolSpinners,
  toolSpinnerFrame,
} from "../src/tool-spinner.ts";

interface FakeToolComponent {
  executionStarted: boolean;
  isPartial: boolean;
  ui: { requestRender: ReturnType<typeof vi.fn> };
}

function createComponent(): FakeToolComponent {
  return {
    executionStarted: false,
    isPartial: true,
    ui: { requestRender: vi.fn() },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  clearToolSpinners();
});

afterEach(() => {
  clearToolSpinners();
  vi.useRealTimers();
});

describe("toolSpinnerFrame", () => {
  it("stays hidden before execution starts", () => {
    const component = createComponent();

    expect(toolSpinnerFrame(component, "ascii")).toBeUndefined();
    vi.advanceTimersByTime(300);

    expect(component.ui.requestRender).not.toHaveBeenCalled();
  });

  it("animates ASCII frames while execution is partial", () => {
    const component = createComponent();
    component.executionStarted = true;

    expect(toolSpinnerFrame(component, "ascii")).toBe("|");
    vi.advanceTimersByTime(100);

    expect(component.ui.requestRender).toHaveBeenCalledTimes(1);
    expect(toolSpinnerFrame(component, "ascii")).toBe("/");
  });

  it("keeps the ASCII spinner when icons are off", () => {
    const component = createComponent();
    component.executionStarted = true;

    expect(toolSpinnerFrame(component, "off")).toBe("|");
    vi.advanceTimersByTime(100);

    expect(component.ui.requestRender).toHaveBeenCalledTimes(1);
    expect(toolSpinnerFrame(component, "off")).toBe("/");
  });

  it("animates Braille frames in Nerd Font mode", () => {
    const component = createComponent();
    component.executionStarted = true;

    expect(toolSpinnerFrame(component, "nerd-font")).toBe("⠋");
    vi.advanceTimersByTime(100);

    expect(toolSpinnerFrame(component, "nerd-font")).toBe("⠙");
  });

  it("stops animating after the final result", () => {
    const component = createComponent();
    component.executionStarted = true;
    toolSpinnerFrame(component, "ascii");
    vi.advanceTimersByTime(100);
    component.ui.requestRender.mockClear();

    component.isPartial = false;
    vi.advanceTimersByTime(100);

    expect(component.ui.requestRender).not.toHaveBeenCalled();
    expect(toolSpinnerFrame(component, "ascii")).toBeUndefined();
    vi.advanceTimersByTime(300);
    expect(component.ui.requestRender).not.toHaveBeenCalled();
  });

  it("cleans up all animation on session shutdown", () => {
    const component = createComponent();
    component.executionStarted = true;
    toolSpinnerFrame(component, "ascii");

    clearToolSpinners();
    vi.advanceTimersByTime(300);

    expect(component.ui.requestRender).not.toHaveBeenCalled();
  });

  it("drops active components that disappear from the transcript", () => {
    const component = createComponent();
    component.executionStarted = true;
    toolSpinnerFrame(component, "ascii");

    vi.advanceTimersByTime(2_100);
    const renderCount = component.ui.requestRender.mock.calls.length;
    vi.advanceTimersByTime(500);

    expect(renderCount).toBeGreaterThan(0);
    expect(component.ui.requestRender).toHaveBeenCalledTimes(renderCount);
  });

  it("fails open when Pi render invalidation throws", () => {
    const component = createComponent();
    component.executionStarted = true;
    component.ui.requestRender.mockImplementation(() => {
      throw new Error("render unavailable");
    });
    toolSpinnerFrame(component, "ascii");

    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
  });
});
