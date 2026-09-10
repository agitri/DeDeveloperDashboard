import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DddError } from "./error";
import { readJson, readJsonOpt, writeJson } from "./store";

const dir = () => mkdtempSync(join(tmpdir(), "ddd-store-"));

describe("store", () => {
  it("reads null for a missing or blank file, and the value otherwise", () => {
    const d = dir();
    expect(readJsonOpt(join(d, "none.json"))).toBeNull();
    writeFileSync(join(d, "blank.json"), "  \n");
    expect(readJsonOpt(join(d, "blank.json"))).toBeNull();
    writeFileSync(join(d, "one.json"), '{"a":1}');
    expect(readJsonOpt(join(d, "one.json"))).toEqual({ a: 1 });
  });

  it("falls back for a missing file and parses an existing one", () => {
    const d = dir();
    const parse = (raw: unknown) => ({ a: (raw as { a: number }).a * 2 });
    expect(readJson(join(d, "none.json"), parse, () => ({ a: 0 }))).toEqual({ a: 0 });
    writeFileSync(join(d, "one.json"), '{"a":21}');
    expect(readJson(join(d, "one.json"), parse, () => ({ a: 0 }))).toEqual({ a: 42 });
  });

  it("reports malformed JSON as a json error", () => {
    const d = dir();
    writeFileSync(join(d, "bad.json"), "{nope");
    try {
      readJsonOpt(join(d, "bad.json"));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DddError);
      expect((e as DddError).kind).toBe("json");
      expect((e as DddError).message).toMatch(/^json: /);
    }
  });

  it("writes pretty-printed JSON through a temp file, creating parents", () => {
    const d = dir();
    const path = join(d, "deep", "er", "layout.json");
    writeJson(path, { version: 1, tabs: [] });
    expect(readFileSync(path, "utf8")).toBe('{\n  "version": 1,\n  "tabs": []\n}');
    // No staging file left behind.
    expect(readdirSync(join(d, "deep", "er"))).toEqual(["layout.json"]);
    expect(existsSync(path + ".tmp")).toBe(false);
  });
});
