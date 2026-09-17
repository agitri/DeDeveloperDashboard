import { describe, expect, it } from "vitest";
import { STEPS, progress, type WizardSnapshot } from "./steps";

const base: WizardSnapshot = { envCount: 1, tabCount: 2, widgetCount: 3, activeTabId: "t1", view: "board" };

describe("wizard steps", () => {
  it("every step has copy and a done predicate", () => {
    for (const s of STEPS) {
      expect(s.title.trim()).not.toBe("");
      expect(s.instruction.trim()).not.toBe("");
      expect(typeof s.done).toBe("function");
    }
  });

  it("the flow is welcome → environment → tab → switch → widget → settings → finish", () => {
    expect(STEPS.map((s) => s.id)).toEqual(["welcome", "environment", "tab", "switch", "widget", "settings", "finish"]);
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
  it("settings step completes when the settings view is open", () => {
    expect(doneOf("settings")(base, { ...base, view: "settings" })).toBe(true);
    expect(doneOf("settings")(base, base)).toBe(false);
  });
  it("welcome and finish auto-complete (advanced by the user, not an action)", () => {
    expect(doneOf("welcome")(base, base)).toBe(true);
    expect(doneOf("finish")(base, base)).toBe(true);
  });

  it("progress is 1-based over the total", () => {
    expect(progress(0, 7)).toEqual({ current: 1, total: 7 });
  });
});
