import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forPids, parseLsof } from "./cwd";
import type { Runner } from "./run";

function fixture(stdout: string): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout, ok: true };
  };
  return { runner, calls };
}

describe("parsing lsof's cwd form", () => {
  it("parses the machine-readable form", () => {
    const out = parseLsof("p14577\nn/Users/rene/Projects/InstallonlineOrderPortal\np25197\nn/Users/rene/Projects/climate4u\n");
    expect(out.size).toBe(2);
    expect(out.get(25197)).toBe("/Users/rene/Projects/climate4u");
  });

  it("ignores lines it does not understand", () => {
    // lsof emits header and descriptor lines we did not ask about; they must
    // not become entries or shift the pid association.
    const out = parseLsof("f cwd\np1\nfcwd\nn/tmp\nCOMMAND\n");
    expect(out.get(1)).toBe("/tmp");
    expect(out.size).toBe(1);
  });

  it("drops a path with no pid before it", () => {
    // Never guess an association. A path with no owner is worse than absent,
    // because it would attach a project to the wrong row.
    expect(parseLsof("n/tmp/orphan\n").size).toBe(0);
  });

  it("keeps the first path when a process reports several", () => {
    expect(parseLsof("p7\nn/first\nn/second\n").get(7)).toBe("/first");
  });
});

describe("resolving working directories", () => {
  it("does no work for an empty pid list", async () => {
    const { runner, calls } = fixture("p1\nn/tmp\n");
    expect((await forPids([], runner, "darwin")).size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("asks lsof for every pid at once on a Mac", async () => {
    // Process spawn is ~30ms on macOS and dominates the actual work, so eight
    // servers asked separately would be a quarter of a second of overhead.
    const { runner, calls } = fixture("p1\nn/p/one\np2\nn/p/two\n");
    const out = await forPids([1, 2], runner, "darwin");
    expect(calls).toEqual([["lsof", "-a", "-d", "cwd", "-Fpn", "-p", "1,2"]]);
    expect([...out]).toEqual([
      [1, "/p/one"],
      [2, "/p/two"],
    ]);
  });

  it("reads procfs on Linux, with no process to spawn at all", async () => {
    const { runner, calls } = fixture("");
    const seen: string[] = [];
    const readLink = (path: string) => {
      seen.push(path);
      if (path === "/proc/2/cwd") throw new Error("ESRCH");
      return "/p/one";
    };
    const out = await forPids([1, 2], runner, "linux", readLink);
    expect(seen).toEqual(["/proc/1/cwd", "/proc/2/cwd"]);
    expect([...out]).toEqual([[1, "/p/one"]]);
    expect(calls).toEqual([]);
  });

  it("answers nothing on Windows", async () => {
    // Reading another process's PEB is undocumented, and the executable path
    // would name the Node installation rather than the project — worse than
    // nothing, because it looks like an answer.
    const { runner, calls } = fixture("p1\nn/p/one\n");
    expect((await forPids([1], runner, "win32")).size).toBe(0);
    expect(calls).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")(
    "resolves this very process",
    async () => {
      // The end-to-end check that needs no fixture: we know our own cwd.
      const found = await forPids([process.pid]);
      expect(realpathSync(found.get(process.pid)!)).toBe(realpathSync(process.cwd()));
    },
    30_000,
  );
});
