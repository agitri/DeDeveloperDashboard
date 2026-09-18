import { describe, expect, it } from "vitest";
import { STEPS, progress, type WizardSnapshot } from "./steps";

const base: WizardSnapshot = { envCount: 1, tabCount: 2, widgetCount: 3, activeTabId: "t1", view: "board", guideOpen: false };

describe("wizard steps", () => {
  it("every step has copy and a done predicate", () => {
    for (const s of STEPS) {
      expect(s.title.trim()).not.toBe("");
      expect(s.instruction.trim()).not.toBe("");
      expect(typeof s.done).toBe("function");
    }
  });

  it("the flow is welcome → environment → tab → switch → widget → settings → features → finish", () => {
    expect(STEPS.map((s) => s.id)).toEqual(["welcome", "environment", "tab", "switch", "widget", "settings", "features", "finish"]);
  });

  const doneOf = (id: string) => STEPS.find((s) => s.id === id)!.done;

  it("environment step completes only when the env count rises", () => {
    expect(doneOf("environment")(base, { ...base, envCount: 2 })).toBe(true);
    expect(doneOf("environment")(base, { ...base, tabCount: 9 })).toBe(false);
  });
  it("tab step completes on a new tab; switch step on a changed active tab; widget step on a new widget", () => {
    expect(doneOf("tab")(base, { ...base, tabCount: 3 })).toBe(true);
    expect(doneOf("switch")(base, { ...base, activeTabId: "t2" })).toBe(true);
    expect(doneOf("widget")(base, { ...base, widgetCount: 4 })).toBe(true);
  });
  // A field-swap (checking the wrong count) must not pass: each step's
  // `done` reacts to its own field only, not any field moving.
  it("tab step ignores a widget-count change", () => {
    expect(doneOf("tab")(base, { ...base, widgetCount: 9 })).toBe(false);
  });
  it("switch step ignores a tab-count change", () => {
    expect(doneOf("switch")(base, { ...base, tabCount: 9 })).toBe(false);
  });
  it("widget step ignores a tab-count change", () => {
    expect(doneOf("widget")(base, { ...base, tabCount: 9 })).toBe(false);
  });
  it("settings step completes when the settings view is open", () => {
    expect(doneOf("settings")(base, { ...base, view: "settings" })).toBe(true);
    expect(doneOf("settings")(base, base)).toBe(false);
  });
  it("settings step stays false when the view is unchanged, even if another field moves", () => {
    expect(doneOf("settings")(base, { ...base, envCount: 9, tabCount: 9, widgetCount: 9, activeTabId: "t9" })).toBe(
      false,
    );
  });
  it("features step completes when the guide opens", () => {
    expect(doneOf("features")(base, { ...base, guideOpen: true })).toBe(true);
    expect(doneOf("features")(base, base)).toBe(false);
    expect(doneOf("features")(base, { ...base, view: "settings" })).toBe(false);
  });
  it("welcome and finish auto-complete (advanced by the user, not an action)", () => {
    expect(doneOf("welcome")(base, base)).toBe(true);
    expect(doneOf("finish")(base, base)).toBe(true);
  });

  it("the switch step's skipWhen gates on tab count, so a single-tab board never lands on a dead-end step", () => {
    const switchStep = STEPS.find((s) => s.id === "switch")!;
    expect(switchStep.skipWhen?.({ ...base, tabCount: 1 })).toBe(true);
    expect(switchStep.skipWhen?.({ ...base, tabCount: 2 })).toBe(false);
  });
  it("only the switch step declares skipWhen", () => {
    for (const s of STEPS) {
      if (s.id === "switch") continue;
      expect(s.skipWhen).toBeUndefined();
    }
  });

  it("progress is 1-based over the total", () => {
    expect(progress(0, 7)).toEqual({ current: 1, total: 7 });
  });
});
