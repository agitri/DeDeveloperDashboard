import { describe, expect, it } from "vitest";
import { asInt, asStr, at, costMicros, errorText, priceFor } from "./provider";

describe("the price table", () => {
  it("prices a thousand tokens the way the rate card reads", () => {
    // $5 / $25 per million → 1k in + 1k out = $0.005 + $0.025 = $0.03.
    expect(costMicros("claude-opus-5", 1_000, 1_000)).toBe(30_000);
  });

  it("local models are free at the API layer", () => {
    expect(costMicros("llama3.1:8b", 10_000, 10_000)).toBe(0);
  });

  it("knows every Claude row", () => {
    expect(priceFor("claude-sonnet-5")).toEqual({ input: 3, output: 15 });
    expect(priceFor("claude-haiku-4-5")).toEqual({ input: 1, output: 5 });
    expect(priceFor("claude-fable-5")).toEqual({ input: 10, output: 50 });
    expect(priceFor("claude-opus-4-7")).toEqual({ input: 5, output: 25 });
  });
});

describe("the JSON helpers", () => {
  const doc = { usage: { input_tokens: 12, output_tokens: 3.5 }, content: [{ type: "text", text: "hi" }], model: "m" };

  it("walks a JSON pointer-ish path, indexing arrays by number", () => {
    expect(at(doc, "usage/input_tokens")).toBe(12);
    expect(at(doc, "content/0/text")).toBe("hi");
    expect(at(doc, "content/9/text")).toBeUndefined();
    expect(at(doc, "nope/deeper")).toBeUndefined();
    expect(at(null, "x")).toBeUndefined();
  });

  it("asInt is Value::as_i64: integers only, else null", () => {
    expect(asInt(12)).toBe(12);
    expect(asInt(3.5)).toBeNull();
    expect(asInt("12")).toBeNull();
    expect(asStr("m")).toBe("m");
    expect(asStr(1)).toBeNull();
  });

  it("errorText reads an Error's message and stringifies the rest", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
  });
});
