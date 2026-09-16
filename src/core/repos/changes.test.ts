import { describe, expect, it } from "vitest";
import { changesSince } from "./changes";
import type { Runner, RunResult } from "../dev/run";

function fakeRunner(map: Record<string, RunResult>): Runner {
  return async (file, args) => {
    const key = [file, ...args].join(" ");
    for (const k of Object.keys(map)) if (key.includes(k)) return map[k]!;
    return { stdout: "", ok: false };
  };
}
const ok = (stdout: string): RunResult => ({ stdout, ok: true });

describe("changesSince", () => {
  it("counts commits and distinct files and keeps messages", async () => {
    const runner = fakeRunner({
      // Checked before "log --since" below: both git calls share that
      // substring (both filter by `--since`), so the more specific key must
      // win the match or the name-only call would be misrouted to the
      // commits fixture.
      "log --name-only": ok("src/a.ts\nsrc/b.ts\nsrc/a.ts\n"), // duplicate a.ts counted once
      "log --since": ok("a1\tfix thing\nb2\tadd feature\n"), // hash<TAB>subject per line
    });
    const r = await changesSince(runner, "/repo", "2026-09-01T00:00:00.000Z");
    expect(r.commits).toBe(2);
    expect(r.filesChanged).toBe(2);
    expect(r.messages).toEqual(["fix thing", "add feature"]);
  });

  it("returns zeros when git fails (not a repo)", async () => {
    const runner: Runner = async () => ({ stdout: "", ok: false });
    expect(await changesSince(runner, "/x", "2026-09-01T00:00:00.000Z")).toEqual({ commits: 0, filesChanged: 0, messages: [] });
  });
});
