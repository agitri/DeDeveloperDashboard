import { describe as suite, expect, it } from "vitest";
import { describe, resolveFilter } from "./instructions";

suite("resolveFilter", () => {
  it("adds a compiled filter to a preset that does not collide with it", () => {
    const merged = resolveFilter({ kind: "mail" }, { kind: "mail" }, { excludeKinds: ["mail_bulk"], limit: 10 });
    expect(merged).toEqual({ kind: "mail", excludeKinds: ["mail_bulk"], limit: 10 });
  });

  it("lets an instruction overrule a preset default", () => {
    // "Show read ones too" on an Unread-only preset. Without this the
    // instruction is silently ignored, which is the failure this feature exists
    // to avoid.
    const merged = resolveFilter({ unreadOnly: true }, { unreadOnly: true }, { unreadOnly: false });
    expect(merged.unreadOnly).toBe(false);
  });

  it("lets a control the user touched beat the instruction", () => {
    // The scope switch says `all` and the instruction says `recent`. The switch
    // is on screen and was touched more recently, so it wins.
    const merged = resolveFilter({ scope: "all" }, { scope: "recent" }, { scope: "recent", query: "api" });
    expect(merged.scope).toBe("all");
    expect(merged.query).toBe("api");
  });

  it("treats a key the preset never seeded as a control", () => {
    const merged = resolveFilter({ query: "typed" }, {}, { query: "compiled" });
    expect(merged.query).toBe("typed");
  });

  it("treats everything as a control when no preset was recorded", () => {
    // A widget created before presetFilter existed keeps behaving exactly as
    // it did — the safe direction for a migration nobody runs.
    const merged = resolveFilter({ kind: "mail" }, undefined, { kind: "issue", limit: 5 });
    expect(merged.kind).toBe("mail");
    expect(merged.limit).toBe(5);
  });

  it("changes nothing when there are no instructions", () => {
    const current = { scope: "all" };
    expect(resolveFilter(current, { scope: "recent" }, undefined)).toBe(current);
  });
});

suite("describe", () => {
  it("renders the spec's mail example the way a person would say it", () => {
    expect(describe({ kind: "mail", excludeKinds: ["mail_bulk"], limit: 10 })).toEqual([
      "Only mail.",
      "Hiding bulk mail.",
      "Showing the newest 10.",
    ]);
  });

  it("says something sensible when nothing was narrowed", () => {
    expect(describe({})).toEqual([
      "Nothing narrowed — this shows everything the widget can.",
    ]);
  });

  it("distinguishes unread-only from explicitly showing both", () => {
    expect(describe({ unreadOnly: true })).toEqual(["Unread only."]);
    expect(describe({ unreadOnly: false })).toEqual(["Read and unread."]);
  });

  it("covers every field the schema allows", () => {
    const all = describe({
      source: "github",
      kind: "pull_request",
      excludeKinds: ["comment", "issue"],
      query: "api",
      project: "ddd",
      unreadOnly: true,
      limit: 5,
      connectionId: "c1",
    });
    expect(all).toHaveLength(8);
    expect(all).toContain("Hiding comments and issues.");
    expect(all).toContain("From github.");
  });

  it("renders the repos widget's own field", () => {
    expect(describe({ scope: "all" })).toEqual(["All of them, not just recent."]);
  });
});
