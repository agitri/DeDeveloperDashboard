import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PER_FILE, contextFor, planFor } from "./icm";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ddd-icm-"));
  mkdirSync(join(dir, ".ddd", "icm"), { recursive: true });
  return dir;
}

describe("ICM assembly", () => {
  it("assembles files in a stable order", () => {
    // Stable order is not cosmetic: an unstable prefix defeats prompt caching.
    const dir = scratch();
    writeFileSync(join(dir, ".ddd/icm/b-architecture.md"), "hexagonal");
    writeFileSync(join(dir, ".ddd/icm/a-conventions.md"), "tabs not spaces");
    const context = contextFor(dir);
    expect(context.indexOf("a-conventions")).toBeLessThan(context.indexOf("b-architecture"));
    expect(context).toBe(contextFor(dir));
    expect(context).toBe("\n## a-conventions.md\n\ntabs not spaces\n\n## b-architecture.md\n\nhexagonal\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a project without icm is not an error", () => {
    expect(contextFor(join(tmpdir(), "ddd-icm-absent"))).toBe("");
  });

  it("marks truncation instead of cutting silently", () => {
    const dir = scratch();
    writeFileSync(join(dir, ".ddd/icm/huge.md"), "x".repeat(MAX_PER_FILE + 500));
    expect(contextFor(dir)).toContain("[…truncated]");
    rmSync(dir, { recursive: true, force: true });
  });

  it("the plan describes exactly what is sent", () => {
    const dir = scratch();
    writeFileSync(join(dir, ".ddd/icm/a.md"), "conventions");
    writeFileSync(join(dir, ".ddd/icm/b.md"), "architecture");
    const plan = planFor(dir);
    const text = contextFor(dir);
    expect(plan.files).toHaveLength(2);
    expect(plan.totalUsed).toBe(Buffer.byteLength(text));
    for (const file of plan.files) expect(text).toContain(file.name);
    expect(plan.missing).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a clipped file says so and reports both sizes, in bytes", () => {
    const dir = scratch();
    writeFileSync(join(dir, ".ddd/icm/huge.md"), "x".repeat(MAX_PER_FILE + 500));
    const file = planFor(dir).files[0]!;
    expect(file.truncated).toBe(true);
    expect(file.bytes).toBe(MAX_PER_FILE + 500);
    expect(file.used).toBeLessThan(file.bytes);
    rmSync(dir, { recursive: true, force: true });
  });

  it("clips on a character boundary, never inside a multi-byte character", () => {
    const dir = scratch();
    // "é" is two bytes; a run of them can only be cut between characters.
    writeFileSync(join(dir, ".ddd/icm/accents.md"), "é".repeat(MAX_PER_FILE));
    const text = contextFor(dir);
    expect(text).not.toContain("�");
    expect(text).toContain("[…truncated]");
    rmSync(dir, { recursive: true, force: true });
  });

  it("files past the budget are named rather than silently dropped", () => {
    const dir = scratch();
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `.ddd/icm/${i}.md`), "y".repeat(MAX_PER_FILE));
    const plan = planFor(dir);
    expect(plan.skipped.length).toBeGreaterThan(0);
    expect(plan.files.length).toBeLessThan(5);
    expect(plan.files.length + plan.skipped.length).toBe(5);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a missing folder is marked missing rather than empty", () => {
    const plan = planFor(join(tmpdir(), "ddd-icm-nowhere"));
    expect(plan.missing).toBe(true);
    expect(plan.files).toEqual([]);
    expect(plan.dir.endsWith("icm")).toBe(true);
    expect(plan.budget).toBe(24_000);

    const dir = scratch();
    const empty = planFor(dir);
    expect(empty.missing).toBe(false);
    expect(empty.files).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a dotfile is not context, and a subfolder is not a file", () => {
    const dir = scratch();
    writeFileSync(join(dir, ".ddd/icm/.DS_Store"), "junk");
    mkdirSync(join(dir, ".ddd/icm/notes"));
    writeFileSync(join(dir, ".ddd/icm/real.md"), "words");
    const plan = planFor(dir);
    expect(plan.files.map((f) => f.name)).toEqual(["real.md"]);
    expect(plan.files[0]!.path).toBe(join(dir, ".ddd/icm/real.md"));
    rmSync(dir, { recursive: true, force: true });
  });
});
