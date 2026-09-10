import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { globalKeymapFile } from "./paths";
import { scratchEnv } from "./testing";
import { keymapLoad, keymapSave } from "./keymap";

describe("keymap", () => {
  it("is null until someone saves one", () => {
    scratchEnv("keymap-none");
    expect(keymapLoad()).toBeNull();
  });

  it("is adopted from the active environment once", () => {
    const { env } = scratchEnv("keymap-migration");
    writeFileSync(env.keymapFile(), JSON.stringify({ "tab.new": ["mod+shift+t"] }));
    expect((keymapLoad() as Record<string, string[]>)["tab.new"]).toEqual(["mod+shift+t"]);
    // Now global; the old per-environment file is no longer consulted.
    writeFileSync(env.keymapFile(), JSON.stringify({ "tab.new": ["mod+9"] }));
    expect((keymapLoad() as Record<string, string[]>)["tab.new"]).toEqual(["mod+shift+t"]);
  });

  it("stores whatever the frontend hands it, verbatim", () => {
    scratchEnv("keymap-save");
    keymapSave({ "palette.open": ["mod+k"] });
    expect(JSON.parse(readFileSync(globalKeymapFile(), "utf8"))).toEqual({ "palette.open": ["mod+k"] });
    expect(keymapLoad()).toEqual({ "palette.open": ["mod+k"] });
  });
});
