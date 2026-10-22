import { describe, expect, it } from "vitest";
import { HINT_SIZES, SCHEMES, clampScale, hintAttr, schemeVars } from "./appearance";

describe("schemes", () => {
  it("ships the six agreed presets, default first", () => {
    expect(SCHEMES.map((s) => s.id)).toEqual(["default", "nord", "solarized", "gruvbox", "paper", "mono"]);
  });

  it("the default scheme sets no variables, so the stylesheet's own palette shows", () => {
    expect(schemeVars("default", "dark", "classic")).toEqual({});
    expect(schemeVars("default", "light", "console")).toEqual({});
  });

  it("maps a preset onto classic's token names", () => {
    const v = schemeVars("nord", "dark", "classic");
    expect(v["--bg"]).toBe("#2e3440");
    expect(v["--ink"]).toBe("#eceff4");
    expect(v["--raised"]).toBeDefined();
    expect(v["--sunken"]).toBeDefined();
    expect(v["--line-strong"]).toBeDefined();
    expect(v["--text"]).toBeUndefined();
  });

  it("maps the same preset onto console's token names", () => {
    const v = schemeVars("nord", "dark", "console");
    expect(v["--bg"]).toBe("#2e3440");
    expect(v["--text"]).toBe("#eceff4");
    expect(v["--surface-2"]).toBeDefined();
    expect(v["--ink"]).toBeUndefined();
  });

  it("every non-default preset defines a full light and dark palette", () => {
    for (const s of SCHEMES.filter((x) => x.id !== "default")) {
      for (const theme of ["light", "dark"] as const) {
        const classic = schemeVars(s.id, theme, "classic");
        expect(Object.keys(classic).sort()).toEqual(
          ["--bg", "--err", "--ink", "--ink-2", "--ink-3", "--line", "--line-strong", "--ok", "--raised", "--sunken", "--surface", "--warn"].sort(),
        );
        for (const value of Object.values(classic)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("falls back to the default scheme for an id it does not know", () => {
    expect(schemeVars("neon", "dark", "classic")).toEqual({});
  });
});

describe("clampScale", () => {
  it("keeps the zoom inside 80%..150% and rounds to whole percents", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(0.5)).toBe(0.8);
    expect(clampScale(2)).toBe(1.5);
    expect(clampScale(1.23)).toBe(1.23);
    expect(clampScale(1.234)).toBe(1.23);
    expect(clampScale(Number.NaN)).toBe(1);
  });
});

describe("hintAttr", () => {
  it("is the saved size, medium when unset or unknown", () => {
    expect(HINT_SIZES).toEqual(["small", "medium", "large"]);
    expect(hintAttr("large")).toBe("large");
    expect(hintAttr(undefined)).toBe("medium");
    expect(hintAttr("giant")).toBe("medium");
  });
});
