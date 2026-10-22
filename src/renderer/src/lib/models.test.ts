import { describe, expect, it } from "vitest";
import { fmtBytes, moveQueue, percent } from "./models";
import type { ModelScan } from "../types";

const scan: ModelScan = {
  totalBytes: 60,
  stores: [
    { runtime: "ollama", label: "Ollama", root: "/o", present: true, bytes: 50, models: [
      { id: "ollama:a:1", runtime: "ollama", name: "a:1", path: "/o/m/a/1", bytes: 30 },
      { id: "ollama:b:1", runtime: "ollama", name: "b:1", path: "/o/m/b/1", bytes: 20 },
    ] },
    { runtime: "huggingface", label: "HF", root: "/h", present: true, bytes: 10, models: [
      { id: "huggingface:x/y", runtime: "huggingface", name: "x/y", path: "/h/models--x--y", bytes: 10 },
    ] },
    { runtime: "jan", label: "Jan", root: "/j", present: false, bytes: 0, models: [] },
  ],
};

describe("fmtBytes", () => {
  it("picks the unit that keeps the number short", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(4_683_074_048)).toBe("4.7 GB");
    expect(fmtBytes(45_000_000_000)).toBe("45 GB"); // decimal, as Finder and `ollama list` report
    expect(fmtBytes(1500)).toBe("1.5 KB");
  });
});

describe("percent", () => {
  it("is 0 to 100 and never divides by zero", () => {
    expect(percent(50, 200)).toBe(25);
    expect(percent(0, 0)).toBe(0);
    expect(percent(300, 200)).toBe(100);
  });
});

describe("moveQueue", () => {
  it("lists every model still in a store, in display order, skipping ones already moved", () => {
    expect(moveQueue(scan, new Set(["ollama:b:1"]))).toEqual(["ollama:a:1", "huggingface:x/y"]);
  });
});
