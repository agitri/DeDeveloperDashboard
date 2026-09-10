import { describe, expect, it } from "vitest";
import { DddError } from "./error";
import { defaultGlobal, defaultLayout, globalFromJson, layoutFromJson } from "./models";

describe("global.json", () => {
  it("defaults to one Default environment with the shipped blue", () => {
    const g = defaultGlobal();
    expect(g.environments).toEqual([
      { id: "default", name: "Default", color: "#2f6ae8", hidden: false, collapsed: false },
    ]);
    expect(g.activeEnvironmentId).toBe("default");
    expect(g.appearance?.theme).toBe("system");
    // Field order is the Rust struct order, so the two apps write diffable files.
    expect(Object.keys(g)).toEqual(["version", "environments", "activeEnvironmentId", "appearance"]);
  });

  it("fills serde's defaults: version, hidden, collapsed, appearance", () => {
    const g = globalFromJson({
      environments: [{ id: "work", name: "Work", color: "#000" }],
      activeEnvironmentId: "work",
    });
    expect(g.version).toBe(1);
    expect(g.environments[0]).toEqual({ id: "work", name: "Work", color: "#000", hidden: false, collapsed: false });
    expect(g.appearance).toBeNull();
  });

  it("refuses a file missing a required field, as serde would", () => {
    expect(() => globalFromJson({ environments: [] })).toThrow(DddError);
    expect(() => globalFromJson({ environments: [] })).toThrow(/missing field `activeEnvironmentId`/);
  });
});

describe("layout.json", () => {
  it("defaults to nothing", () => {
    expect(defaultLayout()).toEqual({ version: 1, groups: [], tabs: [] });
  });

  it("fills widget and tab defaults", () => {
    const l = layoutFromJson({
      tabs: [{ id: "t", name: "T", widgets: [{ id: "w", kind: "clock", layout: { x: 0, y: 0, w: 3, h: 4 } }] }],
    });
    expect(l).toEqual({
      version: 1,
      groups: [],
      tabs: [
        {
          id: "t",
          name: "T",
          color: null,
          groupId: null,
          widgets: [
            {
              id: "w",
              kind: "clock",
              title: null,
              connectionId: null,
              filter: {},
              config: {},
              refreshSeconds: null,
              layout: { x: 0, y: 0, w: 3, h: 4 },
            },
          ],
        },
      ],
    });
  });
});
