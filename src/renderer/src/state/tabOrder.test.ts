import { describe, expect, it } from "vitest";
import { moveGroup, moveTab, setTabGroup, type Ordering } from "./tabOrder";
import type { Tab, TabGroup } from "../types";

function tab(id: string, groupId: string | null = null): Tab {
  return { id, name: id.toUpperCase(), color: null, groupId, widgets: [] };
}

function group(id: string): TabGroup {
  return { id, name: id, color: "#2f6ae8", collapsed: false };
}

/**
 * The invariant the whole module exists to hold: a group renders as one pill
 * spanning a run of tabs, so its tabs must sit next to each other. Re-run at
 * the end of every case rather than trusted once.
 */
function expectContiguous({ tabs, groups }: Ordering) {
  for (const g of groups) {
    const indices = tabs.flatMap((t, i) => (t.groupId === g.id ? [i] : []));
    expect(indices.length, `group ${g.id} exists but holds no tabs`).toBeGreaterThan(0);
    for (let n = 1; n < indices.length; n++) {
      expect(indices[n], `group ${g.id} is split across the strip`).toBe(indices[n - 1]! + 1);
    }
  }
  // No tab may point at a group that is gone.
  const ids = new Set(groups.map((g) => g.id));
  for (const t of tabs) {
    if (t.groupId !== null) expect(ids.has(t.groupId!)).toBe(true);
  }
}

/** A, [B C]g1, D, E */
function fixture(): Ordering {
  return {
    tabs: [tab("a"), tab("b", "g1"), tab("c", "g1"), tab("d"), tab("e")],
    groups: [group("g1")],
  };
}

describe("moveTab", () => {
  it("joins the group when dropped into the middle of its run", () => {
    const after = moveTab(fixture(), "e", 2);
    expect(after.tabs.map((t) => t.id)).toEqual(["a", "b", "e", "c", "d"]);
    expect(after.tabs.find((t) => t.id === "e")!.groupId).toBe("g1");
    expectContiguous(after);
  });

  it("joins neither group when dropped on the boundary between two", () => {
    const start: Ordering = {
      tabs: [tab("a", "g1"), tab("b", "g1"), tab("c", "g2"), tab("d", "g2"), tab("e")],
      groups: [group("g1"), group("g2")],
    };
    const after = moveTab(start, "e", 2);
    expect(after.tabs.map((t) => t.id)).toEqual(["a", "b", "e", "c", "d"]);
    expect(after.tabs.find((t) => t.id === "e")!.groupId).toBeNull();
    expectContiguous(after);
  });

  it("leaves the group when dragged out of its run", () => {
    const after = moveTab(fixture(), "b", 5);
    expect(after.tabs.map((t) => t.id)).toEqual(["a", "c", "d", "e", "b"]);
    expect(after.tabs.find((t) => t.id === "b")!.groupId).toBeNull();
    expectContiguous(after);
  });

  it("deletes the group when its last tab leaves", () => {
    const start: Ordering = {
      tabs: [tab("a"), tab("b", "g1"), tab("c")],
      groups: [group("g1")],
    };
    const after = moveTab(start, "b", 3);
    expect(after.groups).toEqual([]);
    expect(after.tabs.find((t) => t.id === "b")!.groupId).toBeNull();
    expectContiguous(after);
  });

  it("is a no-op when a tab is dropped back where it started", () => {
    const before = fixture();
    const after = moveTab(before, "d", 3);
    expect(after.tabs.map((t) => t.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(after.tabs.map((t) => t.groupId)).toEqual([null, "g1", "g1", null, null]);
    expectContiguous(after);
  });

  it("ignores a tab id that is not in the strip", () => {
    const before = fixture();
    expect(moveTab(before, "nope", 0)).toEqual(before);
  });

  it("clamps an out-of-range index instead of dropping the tab", () => {
    const after = moveTab(fixture(), "a", 99);
    expect(after.tabs.map((t) => t.id)).toEqual(["b", "c", "d", "e", "a"]);
    expectContiguous(after);
  });
});

describe("setTabGroup", () => {
  it("splices a joining tab next to its new group-mates", () => {
    const after = setTabGroup(fixture(), "e", "g1");
    expect(after.tabs.map((t) => t.id)).toEqual(["a", "b", "c", "e", "d"]);
    expect(after.tabs.find((t) => t.id === "e")!.groupId).toBe("g1");
    expectContiguous(after);
  });

  it("splices a leaving tab just outside its former run, not through it", () => {
    const after = setTabGroup(fixture(), "b", null);
    expect(after.tabs.map((t) => t.id)).toEqual(["a", "c", "b", "d", "e"]);
    expect(after.tabs.find((t) => t.id === "b")!.groupId).toBeNull();
    expectContiguous(after);
  });

  it("deletes the group the last member leaves", () => {
    const start: Ordering = { tabs: [tab("a"), tab("b", "g1")], groups: [group("g1")] };
    const after = setTabGroup(start, "b", null);
    expect(after.groups).toEqual([]);
    expectContiguous(after);
  });

  it("repairs a layout whose group was already split on disk", () => {
    // Hand-edited layout.json, or a file from before groups had a UI: g1's
    // tabs are not adjacent. Any operation must return a strip that renders.
    const broken: Ordering = {
      tabs: [tab("a", "g1"), tab("b"), tab("c", "g1")],
      groups: [group("g1")],
    };
    expectContiguous(setTabGroup(broken, "b", null));
  });
});

describe("moveTab with an explicit group", () => {
  /**
   * The reason this parameter exists. Inference needs a tab on *both* sides in
   * the same group, so the edges of a run and one-tab groups were unjoinable by
   * drag — the caret landed inside the group's box and the drop did not join.
   */
  it("joins at a run's leading edge, which inference cannot reach", () => {
    // A, [B C]g1, D, E — dropping E at index 1 is the boundary just before B.
    const after = moveTab(fixture(), "e", 1, "g1");
    expect(after.tabs.map((t) => t.id)).toEqual(["a", "e", "b", "c", "d"]);
    expect(after.tabs.find((t) => t.id === "e")!.groupId).toBe("g1");
    expectContiguous(after);
  });

  it("joins at a run's trailing edge, which inference cannot reach", () => {
    const after = moveTab(fixture(), "e", 3, "g1");
    expect(after.tabs.find((t) => t.id === "e")!.groupId).toBe("g1");
    expectContiguous(after);
  });

  it("joins a group that holds only one tab", () => {
    const start: Ordering = {
      tabs: [tab("a"), tab("b", "g1"), tab("c")],
      groups: [group("g1")],
    };
    // A one-tab group has no inside at all, so this was impossible before.
    const after = moveTab(start, "c", 1, "g1");
    expect(after.tabs.find((t) => t.id === "c")!.groupId).toBe("g1");
    expect(after.groups).toHaveLength(1);
    expectContiguous(after);
  });

  it("leaves every group when the drop says null, even inside a run", () => {
    // Dragging out is the same gesture as dragging in, pointed elsewhere.
    const after = moveTab(fixture(), "b", 2, null);
    expect(after.tabs.find((t) => t.id === "b")!.groupId).toBeNull();
    expectContiguous(after);
  });

  it("ignores a group id that does not exist", () => {
    const after = moveTab(fixture(), "e", 1, "nonexistent");
    expect(after.tabs.find((t) => t.id === "e")!.groupId).toBeNull();
    expectContiguous(after);
  });

  it("still infers when no group is given", () => {
    // The old behaviour has to survive: callers without a pointer to hit-test
    // pass nothing and get neighbour inference.
    const after = moveTab(fixture(), "e", 2);
    expect(after.tabs.find((t) => t.id === "e")!.groupId).toBe("g1");
    expectContiguous(after);
  });

  it("deletes a group whose last tab is dragged out", () => {
    const start: Ordering = {
      tabs: [tab("a"), tab("b", "g1"), tab("c")],
      groups: [group("g1")],
    };
    const after = moveTab(start, "b", 3, null);
    expect(after.groups).toEqual([]);
    expectContiguous(after);
  });
});

/**
 * An `Ordering` is one environment's tabs and groups, so these assert the wall
 * between environments at the only layer that can see both sides of it.
 *
 * The risk is not hypothetical for long: ids are unique today only because
 * `uid()` mints them randomly, and layout import — promised in §5.9 — would
 * make one environment's group id reachable from another's.
 */
describe("a tab cannot join another environment's group", () => {
  /** Two environments whose groups have deliberately different ids. */
  const work: Ordering = {
    tabs: [tab("w1", "g-work"), tab("w2")],
    groups: [{ id: "g-work", name: "Sprint", color: "#c96a00", collapsed: false }],
  };
  // p3 keeps g-personal populated: an empty group is deleted by design, which
  // would otherwise make "the group survived" untestable here.
  const personal: Ordering = {
    tabs: [tab("p1"), tab("p2"), tab("p3", "g-personal")],
    groups: [{ id: "g-personal", name: "Garden", color: "#6b8f00", collapsed: false }],
  };

  it("refuses a foreign group on a drop", () => {
    const after = moveTab(personal, "p2", 0, "g-work");
    expect(after.tabs.find((t) => t.id === "p2")!.groupId).toBeNull();
    expectContiguous(after);
  });

  it("refuses a foreign group when set directly", () => {
    const after = setTabGroup(personal, "p1", "g-work");
    expect(after.tabs.find((t) => t.id === "p1")!.groupId).toBeNull();
    // The other environment's group is untouched by the attempt.
    expect(after.groups.map((g) => g.id)).toEqual(["g-personal"]);
    expectContiguous(after);
  });

  it("leaves the other environment's ordering alone entirely", () => {
    const before = JSON.stringify(work);
    moveTab(personal, "p2", 0, "g-work");
    setTabGroup(personal, "p1", "g-work");
    expect(JSON.stringify(work)).toBe(before);
  });

  it("still honours a group the ordering does own", () => {
    // The guard must not be so blunt that it refuses legitimate moves.
    const after = setTabGroup(personal, "p2", "g-personal");
    expect(after.tabs.find((t) => t.id === "p2")!.groupId).toBe("g-personal");
    expectContiguous(after);
  });

  it("treats a refused foreign group as leaving, not as an arbitrary move", () => {
    // This is what the explicit guard buys over letting `normalize` clean up
    // afterwards. Both end with the tab ungrouped — but the *position* differs.
    //
    // Refused early, the move anchors on the group the tab is leaving, so it
    // lands just outside that run, exactly as `setTabGroup(…, null)` would.
    // Left to normalize, the anchor is the foreign id, no run matches it, and
    // the tab stays where it began — ungrouped but sitting in a spot no
    // deliberate move would have chosen.
    const env: Ordering = {
      tabs: [tab("p1", "g-mine"), tab("p2", "g-mine"), tab("p3")],
      groups: [{ id: "g-mine", name: "Mine", color: "#6b8f00", collapsed: false }],
    };

    const refused = setTabGroup(env, "p1", "g-work");
    expect(refused.tabs.find((t) => t.id === "p1")!.groupId).toBeNull();
    expect(refused.tabs.map((t) => t.id)).toEqual(["p2", "p1", "p3"]);

    // …and it matches what asking to leave outright does.
    const left = setTabGroup(env, "p1", null);
    expect(refused.tabs.map((t) => t.id)).toEqual(left.tabs.map((t) => t.id));
    expectContiguous(refused);
  });

  it("a tab already carrying a foreign id is cleaned rather than rendered", () => {
    // What an imported layout would look like before ids were re-minted.
    const imported: Ordering = {
      tabs: [tab("i1", "g-work"), tab("i2")],
      groups: [{ id: "g-personal", name: "Garden", color: "#6b8f00", collapsed: false }],
    };
    const after = moveTab(imported, "i2", 0);
    expect(after.tabs.find((t) => t.id === "i1")!.groupId).toBeNull();
    expectContiguous(after);
  });
});

describe("moveGroup", () => {
  // A group is dragged by its pill, and the whole run travels with it.
  // A, [B C]g1, D, E — the same fixture the moveTab cases use.
  const base = fixture;

  it("moves the whole run to the boundary, not just its first tab", () => {
    const moved = moveGroup(base(), "g1", 5);
    expect(moved.tabs.map((t) => t.id)).toEqual(["a", "d", "e", "b", "c"]);
    expect(moved.tabs.filter((t) => t.groupId === "g1").map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("moves it to the front", () => {
    const moved = moveGroup(base(), "g1", 0);
    expect(moved.tabs.map((t) => t.id)).toEqual(["b", "c", "a", "d", "e"]);
  });

  it("counts only the boundary shift its own members cause", () => {
    // Boundary 4 sits before `e`. Two of the group's members are before it, so
    // after removal the target is 2 — `e` still ends up last.
    const moved = moveGroup(base(), "g1", 4);
    expect(moved.tabs.map((t) => t.id)).toEqual(["a", "d", "b", "c", "e"]);
  });

  it("leaves an ordering alone when the group is not in it", () => {
    const before = base();
    expect(moveGroup(before, "nope", 0).tabs.map((t) => t.id)).toEqual(
      before.tabs.map((t) => t.id),
    );
  });

  it("does not nest one group inside another", () => {
    // Groups are one level deep. Dropped into g2's run, g1 lands after it
    // rather than splitting it or becoming a child of it.
    const two: Ordering = {
      tabs: [tab("a"), tab("b", "g2"), tab("c", "g2"), tab("d", "g1"), tab("e", "g1")],
      groups: [group("g1"), group("g2")],
    };
    const moved = moveGroup(two, "g1", 2);
    expect(moved.tabs.map((t) => t.id)).toEqual(["a", "b", "c", "d", "e"]);
    // Both runs are still whole, and still their own.
    expect(moved.tabs.filter((t) => t.groupId === "g2").map((t) => t.id)).toEqual(["b", "c"]);
    expect(moved.tabs.filter((t) => t.groupId === "g1").map((t) => t.id)).toEqual(["d", "e"]);
  });

  it("keeps every run contiguous afterwards", () => {
    expectContiguous(moveGroup(base(), "g1", 3));
    expectContiguous(moveGroup(base(), "g1", 0));
    expectContiguous(moveGroup(base(), "g1", 5));
  });
});
