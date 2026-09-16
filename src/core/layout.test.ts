import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchEnv } from "./testing";
import { layoutFileRead, layoutFileWrite, layoutLoad, layoutSave } from "./layout";

describe("layout on disk", () => {
  it("is empty for a fresh environment and round-trips", () => {
    const { env } = scratchEnv("layout");
    expect(layoutLoad(env)).toEqual({ version: 1, groups: [], tabs: [] });
    layoutSave(env, { version: 1, groups: [], tabs: [{ id: "t", name: "T", color: null, groupId: null, widgets: [] }] });
    expect(layoutLoad(env).tabs[0]?.name).toBe("T");
    expect(readFileSync(env.layoutFile(), "utf8")).toContain('"name": "T"');
  });

  it("survives an app restart: lastVisitedAt round-trips through save/load", () => {
    const { env } = scratchEnv("layout-last-visited");
    layoutSave(env, {
      version: 1,
      groups: [],
      tabs: [
        { id: "away", name: "Away", color: null, groupId: null, widgets: [], lastVisitedAt: "2026-08-01T12:00:00.000Z" },
        { id: "fresh", name: "Fresh", color: null, groupId: null, widgets: [] },
      ],
    });
    const loaded = layoutLoad(env);
    expect(loaded.tabs.find((t) => t.id === "away")?.lastVisitedAt).toBe("2026-08-01T12:00:00.000Z");
    // Backward-compat: a tab with no stamp still loads, defaulting to null.
    expect(loaded.tabs.find((t) => t.id === "fresh")?.lastVisitedAt).toBeNull();
  });
});

describe("layout files the user picks", () => {
  it("only ever writes a .json file", () => {
    const { home } = scratchEnv("layout-write");
    expect(() => layoutFileWrite(join(home, "board.txt"), "{}")).toThrow("a layout is written as a .json file");
    layoutFileWrite(join(home, "board.json"), '{"version":1}');
    expect(readFileSync(join(home, "board.json"), "utf8")).toBe('{"version":1}');
  });

  it("only ever reads a small .json file", () => {
    const { home } = scratchEnv("layout-read");
    expect(() => layoutFileRead(join(home, "board.txt"))).toThrow("a layout is read from a .json file");
    writeFileSync(join(home, "big.json"), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    expect(() => layoutFileRead(join(home, "big.json"))).toThrow(/a layout is kilobytes/);
    writeFileSync(join(home, "ok.json"), '{"version":1}');
    expect(layoutFileRead(join(home, "ok.json"))).toBe('{"version":1}');
  });
});
