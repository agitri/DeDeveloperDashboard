import { describe, expect, it } from "vitest";
import { targetsOf } from "./LauncherWidget";
import type { Widget } from "../types";

function widget(targets: unknown): Widget {
  return {
    id: "w", kind: "launcher", title: null, connectionId: null,
    filter: {}, config: { targets }, refreshSeconds: null,
    layout: { x: 0, y: 0, w: 4, h: 6 },
  };
}

describe("targetsOf", () => {
  it("reads well-formed targets", () => {
    const out = targetsOf(widget([
      { id: "a", label: "DDD", path: "/p/DDD", open: "terminal" },
      { id: "b", label: "Renter", path: "/p/renter", open: "ide" },
    ]));
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
    expect(out[1]!.open).toBe("ide");
  });

  it("drops a target whose open kind is unknown", () => {
    // layout.json is user-editable, and a button that cannot do anything is
    // worse than a button that is not there.
    expect(targetsOf(widget([{ id: "a", path: "/p", open: "telepathy" }]))).toEqual([]);
  });

  it("collapses duplicate ids rather than colliding React keys", () => {
    const out = targetsOf(widget([
      { id: "a", path: "/one", open: "terminal" },
      { id: "a", path: "/two", open: "terminal" },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("/one");
  });

  it("falls back to the directory name when no label is given", () => {
    expect(targetsOf(widget([{ id: "a", path: "/p/projects/DDD", open: "ide" }]))[0]!.label)
      .toBe("DDD");
    expect(targetsOf(widget([{ id: "b", path: "/p/DDD/", open: "ide" }]))[0]!.label)
      .toBe("DDD");
  });

  it("survives anything that is not a target list", () => {
    for (const bad of [undefined, null, "targets", 7, {}, [null], [1], [{}]]) {
      expect(() => targetsOf(widget(bad)), JSON.stringify(bad)).not.toThrow();
      expect(targetsOf(widget(bad))).toEqual([]);
    }
  });
});
