import { describe, expect, it } from "vitest";
import { repoFilterFromJson } from "./filter";

describe("repoFilterFromJson", () => {
  it("keeps only what is present, and omits absent fields entirely", () => {
    expect(repoFilterFromJson({})).toEqual({});
    expect(repoFilterFromJson({ scope: "all" })).toEqual({ scope: "all" });
    expect(repoFilterFromJson({ scope: null, query: "ddd" })).toEqual({ query: "ddd" });
    expect(JSON.stringify(repoFilterFromJson({ scope: "all" }))).toBe('{"scope":"all"}');
  });

  it("rejects a wrongly typed field and a non-object", () => {
    expect(() => repoFilterFromJson({ scope: 3 })).toThrow(/^json: /);
    expect(() => repoFilterFromJson([])).toThrow(/^json: /);
  });
});
