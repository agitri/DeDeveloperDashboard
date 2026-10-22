import { describe, expect, it } from "vitest";
import { formatBinding, splitBinding } from "./keys";

describe("splitBinding", () => {
  it("separates the modifier glyphs from the key so the badge can size them apart", () => {
    const s = splitBinding("mod+shift+2");
    expect(s.key).toBe("2");
    expect(s.mods).toBe(formatBinding("mod+shift+2").slice(0, -1));
  });

  it("has no modifiers for a bare key", () => {
    expect(splitBinding("j")).toEqual({ mods: "", key: "J" });
  });
});
