import { describe, expect, it } from "vitest";
import { packWidgets } from "./arrange";
import type { Widget } from "../types";

function w(id: string, x: number, y: number, width: number, h: number): Widget {
  return {
    id,
    kind: "clock",
    title: null,
    connectionId: null,
    filter: {},
    config: {},
    refreshSeconds: null,
    layout: { x, y, w: width, h },
  };
}

const COLS = 12;

describe("packWidgets", () => {
  it("removes vertical gaps and keeps reading order", () => {
    // Two widgets stranded far down the canvas, in reading order b then a.
    const packed = packWidgets([w("a", 4, 40, 4, 6), w("b", 0, 40, 4, 6)], COLS);
    expect(packed.map((p) => p.id)).toEqual(["b", "a"]);
    expect(packed.map((p) => p.layout.y)).toEqual([0, 0]);
    expect(packed.map((p) => p.layout.x)).toEqual([0, 4]);
  });

  it("wraps to a new row when the next widget would overflow the grid", () => {
    const packed = packWidgets([w("a", 0, 0, 8, 3), w("b", 0, 1, 6, 4), w("c", 0, 2, 4, 2)], COLS);
    // a takes 0..8; b needs 6 and does not fit, so it starts a new row at the
    // height of the tallest widget in the row it left behind.
    expect(packed.find((p) => p.id === "b")!.layout).toMatchObject({ x: 0, y: 3 });
    expect(packed.find((p) => p.id === "c")!.layout).toMatchObject({ x: 6, y: 3 });
  });

  it("gives a full-width widget its own row", () => {
    const packed = packWidgets([w("a", 0, 0, 12, 4), w("b", 0, 1, 3, 3)], COLS);
    expect(packed.find((p) => p.id === "a")!.layout).toMatchObject({ x: 0, y: 0 });
    expect(packed.find((p) => p.id === "b")!.layout).toMatchObject({ x: 0, y: 4 });
  });

  it("never changes a widget's size", () => {
    const before = [w("a", 3, 9, 5, 7), w("b", 1, 2, 4, 6)];
    const packed = packWidgets(before, COLS);
    for (const original of before) {
      const after = packed.find((p) => p.id === original.id)!;
      expect(after.layout.w).toBe(original.layout.w);
      expect(after.layout.h).toBe(original.layout.h);
    }
  });

  it("is idempotent — tidying an already tidy canvas changes nothing", () => {
    const once = packWidgets([w("a", 7, 13, 4, 6), w("b", 0, 2, 5, 3), w("c", 2, 30, 3, 8)], COLS);
    expect(packWidgets(once, COLS)).toEqual(once);
  });

  it("returns an empty list unchanged", () => {
    expect(packWidgets([], COLS)).toEqual([]);
  });
});
