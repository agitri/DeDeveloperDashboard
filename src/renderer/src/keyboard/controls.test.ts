import { describe, expect, it } from "vitest";
import { nextControl } from "./controls";

// `nextControl` is the part with the arithmetic, and it is pure: give it a list
// and whatever the document says has focus. `controlsOf` reads a live DOM and is
// verified in a browser instead — this project carries no DOM test environment,
// and a fake one would only prove the fake behaves.
const list = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }) as unknown as HTMLElement);

describe("moving between a widget's controls", () => {
  it("lands on the first control when nothing is focused yet", () => {
    const controls = list(3);
    expect(nextControl(controls, null, 1)).toBe(controls[0]);
  });

  it("lands on the last one when arriving backwards", () => {
    // Same rule `moveWidgetFocus` uses one level up, so both levels behave the
    // same way when you arrive at them.
    const controls = list(3);
    expect(nextControl(controls, null, -1)).toBe(controls[2]);
  });

  it("wraps at both ends", () => {
    const controls = list(3);
    expect(nextControl(controls, controls[2]!, 1)).toBe(controls[0]);
    expect(nextControl(controls, controls[0]!, -1)).toBe(controls[2]);
  });

  it("steps one at a time in between", () => {
    const controls = list(4);
    expect(nextControl(controls, controls[1]!, 1)).toBe(controls[2]);
    expect(nextControl(controls, controls[1]!, -1)).toBe(controls[0]);
  });

  it("treats focus that is not in the list as no focus", () => {
    // The widget refreshed and replaced its buttons while one was focused; the
    // element still exists and still reports focus, but it is not on screen.
    const controls = list(3);
    const stale = { id: "gone" } as unknown as HTMLElement;
    expect(nextControl(controls, stale, 1)).toBe(controls[0]);
  });

  it("has nowhere to go in a widget with no controls", () => {
    // The clock. Pressing `l` there must be a no-op, not a crash.
    expect(nextControl([], null, 1)).toBeNull();
  });
});
