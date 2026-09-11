import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultGlobal } from "../core/models";
import { scratchEnv } from "../core/testing";
import { bootLook } from "./look";

/**
 * The renderer picks its look from a per-origin localStorage cache before any
 * setting can arrive. The preload seeds that cache from `global.json`, so a
 * fresh profile boots with the saved look instead of classic plus a toast.
 */
describe("bootLook", () => {
  function writeGlobal(home: string, look: unknown): void {
    const g = defaultGlobal() as unknown as { appearance: Record<string, unknown> };
    g.appearance.look = look;
    writeFileSync(join(home, "global.json"), JSON.stringify(g));
  }

  it("reads the saved look", () => {
    const { home } = scratchEnv("look-console");
    writeGlobal(home, "console");
    expect(bootLook()).toBe("console");
    writeGlobal(home, "classic");
    expect(bootLook()).toBe("classic");
  });

  it("is classic on a first run, exactly as global_load would create it", () => {
    scratchEnv("look-fresh");
    expect(bootLook()).toBe("classic");
  });

  it("is classic for a file that predates the field (the Rust default)", () => {
    const { home } = scratchEnv("look-old");
    const g = defaultGlobal() as unknown as { appearance: Record<string, unknown> };
    delete g.appearance.look;
    writeFileSync(join(home, "global.json"), JSON.stringify(g));
    expect(bootLook()).toBe("classic");
  });

  it("is null, never a throw, when the home cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-test-look-broken-"));
    const notADir = join(dir, "file");
    writeFileSync(notADir, "x");
    process.env.DDD_HOME = notADir;
    expect(bootLook()).toBeNull();
  });
});
