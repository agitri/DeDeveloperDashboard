import { describe, expect, it } from "vitest";
import { buildGuide } from "./guide";
import { WIDGETS } from "../widgets/registry";

describe("buildGuide", () => {
  const guide = buildGuide(WIDGETS);

  it("has an entry for every widget kind (drift guard)", () => {
    const widgetIds = new Set(guide.filter((e) => e.group === "widget").map((e) => e.id));
    for (const def of WIDGETS) expect(widgetIds.has(`widget:${def.kind}`)).toBe(true);
  });

  it("gives every entry a non-empty what and how", () => {
    for (const e of guide) {
      expect(e.what.trim().length).toBeGreaterThan(0);
      expect(e.how.trim().length).toBeGreaterThan(0);
    }
  });

  it("has unique ids", () => {
    const ids = guide.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all three groups", () => {
    const groups = new Set(guide.map((e) => e.group));
    expect(groups).toEqual(new Set(["widget", "integration", "concept"]));
  });
});
