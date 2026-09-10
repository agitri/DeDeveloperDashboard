import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `core/` is the port of the Rust backend and must stay a plain Node library:
 * testable without a window, hostable by something other than Electron. The
 * only thing that keeps that true is this test.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("core stays electron-free", () => {
  it("never imports electron", () => {
    const offenders = walk(__dirname).filter((file) =>
      /(from\s+["']electron["']|require\(\s*["']electron["']\s*\))/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
