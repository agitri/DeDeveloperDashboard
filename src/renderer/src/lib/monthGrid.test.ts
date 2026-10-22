import { describe, expect, it } from "vitest";
import { monthGrid } from "./monthGrid";

// Local, deliberately: toISOString() converts to UTC, which turns local
// midnight into the previous day anywhere east of Greenwich — the exact
// off-by-one this grid exists to avoid.
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("monthGrid", () => {
  it("returns whole weeks", () => {
    for (const month of [0, 1, 5, 11]) {
      const grid = monthGrid(2026, month, 1);
      expect(grid.length % 7, `month ${month}`).toBe(0);
    }
  });

  it("starts on the configured first day", () => {
    // August 2026 starts on a Saturday.
    expect(monthGrid(2026, 7, 1)[0]!.getDay()).toBe(1); // Monday-first
    expect(monthGrid(2026, 7, 0)[0]!.getDay()).toBe(0); // Sunday-first
  });

  it("includes leading and trailing days from the adjacent months", () => {
    const grid = monthGrid(2026, 7, 1);
    expect(iso(grid[0]!)).toBe("2026-07-27");
    expect(grid.some((d) => d.getMonth() === 6)).toBe(true);
    expect(grid.some((d) => d.getMonth() === 8)).toBe(true);
  });

  it("covers every day of the month exactly once", () => {
    const grid = monthGrid(2026, 1, 1); // February
    const inMonth = grid.filter((d) => d.getMonth() === 1).map(iso);
    expect(inMonth.length).toBe(28);
    expect(new Set(inMonth).size).toBe(28);
  });

  it("gets a leap February right", () => {
    const grid = monthGrid(2028, 1, 1);
    expect(grid.filter((d) => d.getMonth() === 1).length).toBe(29);
  });

  it("keeps the right day count through a DST change", () => {
    // The EU springs forward on the last Sunday of March. A grid built by
    // adding 24h at a time loses or repeats a day here.
    const grid = monthGrid(2026, 2, 1);
    expect(grid.filter((d) => d.getMonth() === 2).length).toBe(31);
    const days = grid.map(iso);
    expect(new Set(days).size).toBe(days.length);
  });

  it("produces consecutive dates with no gaps", () => {
    const grid = monthGrid(2026, 7, 1);
    for (let i = 1; i < grid.length; i++) {
      const gap = (grid[i]!.getTime() - grid[i - 1]!.getTime()) / 3_600_000;
      // 23–25 hours: a DST day is not 24, and that is the point.
      expect(gap).toBeGreaterThanOrEqual(23);
      expect(gap).toBeLessThanOrEqual(25);
    }
  });
});
