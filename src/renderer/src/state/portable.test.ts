import { describe, expect, it } from "vitest";
import { exportLayout, importLayout, ImportError, PORTABLE_VERSION } from "./portable";
import type { Layout, Widget } from "../types";

function widget(id: string, over: Partial<Widget> = {}): Widget {
  return {
    id,
    kind: "items",
    title: null,
    connectionId: null,
    filter: {},
    config: {},
    refreshSeconds: null,
    layout: { x: 0, y: 0, w: 4, h: 6 },
    ...over,
  };
}

function layout(): Layout {
  return {
    version: 1,
    groups: [
      { id: "g-atelier", name: "Atelier", color: "#00a99f", collapsed: false },
      { id: "g-unused", name: "Unused", color: "#c026a3", collapsed: false },
    ],
    tabs: [
      { id: "t-morning", name: "Morning", color: null, groupId: null, widgets: [widget("w-1")] },
      { id: "t-site", name: "Site", color: null, groupId: "g-atelier", widgets: [widget("w-2")] },
    ],
  };
}

/** Deterministic ids, so the re-minting can be asserted rather than inferred. */
function minter() {
  let n = 0;
  return (prefix: string) => `${prefix}-new${++n}`;
}

describe("exportLayout", () => {
  it("carries only the groups its tabs actually use", () => {
    const doc = exportLayout(layout());
    expect(doc.groups.map((g) => g.id)).toEqual(["g-atelier"]);
  });

  it("can export a single tab", () => {
    const doc = exportLayout(layout(), { tabIds: ["t-site"] });
    expect(doc.tabs.map((t) => t.name)).toEqual(["Site"]);
    expect(doc.groups.map((g) => g.id)).toEqual(["g-atelier"]);
  });

  it("does not alias the layout it exported", () => {
    // A document that shares objects with the live board would let an edit to
    // one change the other.
    const source = layout();
    const doc = exportLayout(source);
    doc.tabs[0]!.name = "Changed";
    doc.tabs[0]!.widgets[0]!.title = "Changed";
    expect(source.tabs[0]!.name).toBe("Morning");
    expect(source.tabs[0]!.widgets[0]!.title).toBeNull();
  });
});

describe("importLayout", () => {
  it("re-mints every id — tabs, groups and widgets", () => {
    // The bug this whole module exists to prevent: ids are unique across
    // environments, not just within one, because envOf returns the first match.
    const doc = exportLayout(layout());
    const { tabs, groups } = importLayout(doc, minter());

    // The property, not the mint order: everything is new, and everything is
    // distinct. Asserting the exact sequence would pin the order groups and
    // widgets happen to be minted in, which is not a promise this makes.
    for (const tab of tabs) {
      expect(tab.id).toMatch(/^t-new/);
      for (const w of tab.widgets) expect(w.id).toMatch(/^w-new/);
    }
    for (const group of groups) expect(group.id).toMatch(/^g-new/);
    // Nothing kept an id from the document.
    const before = new Set(["t-morning", "t-site", "g-atelier", "w-1", "w-2"]);
    const after = [
      ...tabs.map((t) => t.id),
      ...groups.map((g) => g.id),
      ...tabs.flatMap((t) => t.widgets.map((w) => w.id)),
    ];
    expect(after.some((id) => before.has(id))).toBe(false);
  });

  it("keeps a tab inside its group by pointing at the group's new id", () => {
    const { tabs, groups } = importLayout(exportLayout(layout()), minter());
    const site = tabs.find((t) => t.name === "Site")!;
    expect(site.groupId).toBe(groups[0]!.id);
    expect(tabs.find((t) => t.name === "Morning")!.groupId).toBeNull();
  });

  it("importing the same document twice produces two disjoint boards", () => {
    // The actual failure mode, stated as a test: one environment's tabs
    // appearing frozen while another moves by itself.
    const doc = exportLayout(layout());
    const first = importLayout(doc, minter());
    const second = importLayout(doc, minter());
    const ids = (r: typeof first) => [...r.tabs.map((t) => t.id), ...r.groups.map((g) => g.id)];
    expect(ids(first).some((id) => ids(second).includes(id))).toBe(true);

    // …which is exactly why a real import mints from a source that does not
    // repeat. With the store's own `uid`, they are disjoint.
    const a = importLayout(doc, real());
    const b = importLayout(doc, real());
    expect(ids(a).some((id) => ids(b).includes(id))).toBe(false);
  });

  it("drops a reference to a group the document did not carry", () => {
    const orphan = {
      kind: "ddd.layout" as const,
      version: PORTABLE_VERSION,
      tabs: [{ id: "t", name: "Orphan", groupId: "g-gone", widgets: [] }],
      groups: [],
    };
    const { tabs } = importLayout(orphan, minter());
    expect(tabs[0]!.groupId).toBeNull();
  });

  it("arrives unbound from the exporter's connection", () => {
    // Credentials belong to the environment that holds them, so a widget
    // pointing at another world's connection would read nothing at best.
    const source = layout();
    source.tabs[0]!.widgets[0]!.connectionId = "conn-work-github";
    const { tabs } = importLayout(exportLayout(source), minter());
    expect(tabs[0]!.widgets[0]!.connectionId).toBeNull();
  });

  it("drops the compiled instructions but keeps what the widget was made from", () => {
    // The cache is keyed to a hash of a file that is not travelling; keeping it
    // would give the widget a filter it cannot explain.
    const source = layout();
    source.tabs[0]!.widgets[0]!.config = {
      presetFilter: { kind: "mail" },
      instructions: { sourceHash: "abc", filter: { limit: 10 }, compiledAt: "", unmet: [], model: "m" },
    };
    const { tabs } = importLayout(exportLayout(source), minter());
    expect(tabs[0]!.widgets[0]!.config.instructions).toBeUndefined();
    expect(tabs[0]!.widgets[0]!.config.presetFilter).toEqual({ kind: "mail" });
  });

  it("refuses what it cannot read, with a reason", () => {
    const cases: [unknown, RegExp][] = [
      ["not json at all", /readable JSON/],
      [JSON.stringify({ hello: "world" }), /not a DDD layout/],
      [{ kind: "ddd.layout", version: 99, tabs: [{ id: "a", name: "A" }] }, /newer DDD/],
      [{ kind: "ddd.layout", version: 1, tabs: [] }, /no tabs/],
      [{ kind: "ddd.layout", version: 1, tabs: [{ id: "a" }] }, /no name/],
      [null, /not a layout file/],
    ];
    for (const [input, message] of cases) {
      expect(() => importLayout(input, minter()), String(input)).toThrow(message);
      expect(() => importLayout(input, minter())).toThrow(ImportError);
    }
  });

  it("reads a document straight from its text", () => {
    const text = JSON.stringify(exportLayout(layout()));
    expect(importLayout(text, minter()).tabs).toHaveLength(2);
  });
});

/** The store's own id source, so the disjointness claim is about the real one. */
function real() {
  return (prefix: string) =>
    `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}
