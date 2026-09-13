import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { info, infos } from "./proc";

/** High enough to be free, low enough that `ps` will consider the question. */
const DEAD = 99_998;
/** Above PID_CEILING, so it is dropped before `ps` is asked. */
const IMPOSSIBLE = 4_294_967_294;

async function waitUntil(cond: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe("proc", () => {
  it("our own process reads back", async () => {
    const got = await info(process.pid);
    expect(got).not.toBeNull();
    expect(got!.startedAt).not.toBe("");
    expect(got!.command).not.toBe("");
    expect(got!.command.includes("/")).toBe(false);
  });

  it("reading the same pid twice agrees", async () => {
    expect(await info(process.pid)).toEqual(await info(process.pid));
  });

  it("a pid that is not running is absent", async () => {
    expect(await info(DEAD)).toBeNull();
  });

  it("a pid that could not exist is absent without asking", async () => {
    expect(await info(IMPOSSIBLE)).toBeNull();
    expect(await info(0)).toBeNull();
  });

  it("one impossible pid does not hide the others", async () => {
    const got = await infos([process.pid, IMPOSSIBLE, 1]);
    expect(got.has(process.pid)).toBe(true);
    expect(got.has(1)).toBe(true);
  });

  it("asking about nothing asks the os nothing", async () => {
    expect((await infos([])).size).toBe(0);
  });

  it("a batch answers for every live pid at once", async () => {
    const got = await infos([process.pid, DEAD, 1]);
    expect(got.has(process.pid)).toBe(true);
    expect(got.has(DEAD)).toBe(false);
    expect(got.has(1)).toBe(true); // pid 1 always exists
  });

  it("an exited child is not reported as running", async () => {
    // Spawn something that exits at once and never wait on it, exactly as a
    // product is spawned. Poll until it reads as absent.
    const child = spawn("true", [], { stdio: "ignore", detached: true });
    child.unref();
    const pid = child.pid!;
    expect(await waitUntil(async () => (await info(pid)) === null)).toBe(true);
  });
});
