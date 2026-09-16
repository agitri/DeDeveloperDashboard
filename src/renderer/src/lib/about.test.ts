import { describe, expect, it } from "vitest";
import { recentForProject } from "./about";
import type { EventRow } from "../types";

const event = (over: Partial<EventRow> = {}): EventRow => ({
  id: 1,
  ts: "2026-09-16T10:00:00.000Z",
  kind: "item.start",
  project: "widgets",
  ...over,
});

describe("recentForProject", () => {
  it("matches events logged by project name", () => {
    const events = [
      event({ id: 3, project: "widgets" }),
      event({ id: 2, project: "other" }),
      event({ id: 1, project: "widgets" }),
    ];
    expect(recentForProject(events, "widgets").map((e) => e.id)).toEqual([3, 1]);
  });

  it("returns an empty list when the project name is missing", () => {
    const events = [event({ project: "widgets" })];
    expect(recentForProject(events, undefined)).toEqual([]);
    expect(recentForProject(events, "")).toEqual([]);
  });

  it("respects the limit, keeping newest-first order intact", () => {
    const events = [
      event({ id: 5 }),
      event({ id: 4 }),
      event({ id: 3 }),
      event({ id: 2 }),
      event({ id: 1 }),
    ];
    expect(recentForProject(events, "widgets", 2).map((e) => e.id)).toEqual([5, 4]);
  });

  it("also matches the promoted-tab project id, so tab.promote events stay visible", () => {
    const events = [
      event({ id: 2, project: "widgets" }),
      event({ id: 1, project: "widgets-a1b2c3", kind: "tab.promote" }),
    ];
    expect(recentForProject(events, "widgets", 8, "widgets-a1b2c3").map((e) => e.id)).toEqual([
      2, 1,
    ]);
  });
});
