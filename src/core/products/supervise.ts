/**
 * Products: the things a repo knows how to run. Port of `products/mod.rs`.
 *
 * A product outlives DDD — "start and leave up" — so children are spawned into
 * their own process group and DDD never waits on them. The only thing that
 * survives a restart is a PID in a file, hence `record`. Nothing runs
 * unapproved (`consent`), and it runs through your login shell (`shell`), a
 * deliberately wide door whose lock is consent.
 */
import { spawn as spawnProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { DddError } from "../error";
import { isArray, optional, record } from "../json";
import type { EnvRoot } from "../paths";
import type { ProductDecl } from "../models";
// `Product` is the renderer's widget shape; `models.ts` re-exports types it
// has a reason to touch, and nothing else has needed this one yet, so it is
// imported from its source rather than widening that list for one consumer.
import type { Product } from "../../renderer/src/types";
import { readJson, writeJson } from "../store";
import * as consent from "./consent";
import * as declare from "./declare";
import * as log from "./log";
import * as proc from "./proc";
import { claim, recordFromJson, stateOf, type Record, type State } from "./record";

/** `<env>/products.json`. */
export interface Supervision {
  running: Record[];
}

export function supervisionFromJson(raw: unknown): Supervision {
  const o = record(raw, "products");
  return { running: optional(o, "running", isArray, [] as unknown[]).map(recordFromJson) };
}

export function keyOf(projectId: string, productId: string): string {
  return `${projectId}/${productId}`;
}

/** A missing or unreadable file means nothing is running (Rust's
 *  `read_json(..).unwrap_or_default()`). */
export function records(env: EnvRoot): Supervision {
  try {
    return readJson(env.productsFile(), supervisionFromJson, () => ({ running: [] }));
  } catch {
    return { running: [] };
  }
}

export function put(env: EnvRoot, sup: Supervision): void {
  writeJson(env.productsFile(), sup);
}

/**
 * products.json is a read-modify-write, and `start` awaits the spawn between
 * reading the `running` list and writing it back. Node is single-threaded, but
 * `await` yields, so two starts (or a start racing a stop) could each read the
 * same list, spawn, and write — the second clobbering the first's record and
 * orphaning its process. Every mutation is therefore funnelled through one
 * promise chain: each call waits for the previous to settle before it reads, so
 * no two ever interleave. Reads (`assemble`, `runningRecord` on its own) do not
 * need the gate; approvals live in a different file and are written
 * synchronously, so they cannot interleave either.
 */
let productsGate: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const runNext = productsGate.then(work, work);
  productsGate = runNext.then(
    () => undefined,
    () => undefined,
  );
  return runNext;
}

/** Which shell to run a product through: `$SHELL -l -c '<run>'`. The `-l` is
 *  the point — a GUI process on macOS inherits launchd's environment, with none
 *  of the PATH, version-manager shims or direnv hooks a product needs. */
export function shell(): string {
  return process.env.SHELL ?? "/bin/sh";
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** How a product is launched. Injectable so a test could fake it; defaults to
 *  the real spawn for the platform. */
export type Spawn = (run: string, dir: string, logPath: string) => Promise<{ pid: number; startedAt: string; command: string }>;

const unixSpawn: Spawn = async (run, dir, logPath) => {
  // One descriptor, opened once and handed to both stdout and stderr, like the
  // Rust's `try_clone`. The child inherits its own copy; the parent closes it.
  const fd = openSync(logPath, "a");
  let pid: number | undefined;
  try {
    const child = spawnProcess(shell(), ["-l", "-c", run], {
      cwd: dir,
      stdio: ["ignore", fd, fd],
      // Its own process group, so a signal aimed at DDD does not take every
      // product with it. `unref` and no `exit` listener: the product outlives
      // us, and the record on disk is the only registry.
      detached: true,
    });
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(fd);
  }
  if (pid === undefined) {
    throw DddError.config("the command exited before it could be recorded — check the log");
  }
  // Read the OS start time immediately. `proc.infos` treats the eventual zombie
  // as gone, which is how the product's exit becomes visible later.
  const found = await proc.info(pid);
  if (found === null) {
    throw DddError.config("the command exited before it could be recorded — check the log");
  }
  return { pid, startedAt: found.startedAt, command: found.command };
};

const win32Spawn: Spawn = async () => {
  throw DddError.config(
    "running products is not offered on Windows: the only way to stop one would be a force kill",
  );
};

const defaultSpawn: Spawn = process.platform === "win32" ? win32Spawn : unixSpawn;

/** Everything the widget needs about one declared product. */
export async function assemble(
  env: EnvRoot,
  projectId: string,
  projectPath: string,
  decls: ProductDecl[],
): Promise<Product[]> {
  const supervision = records(env);
  const approvals = consent.load(env.productApprovalsFile());
  const usable = declare.usable(projectPath, decls);

  const pids: number[] = [];
  for (const d of usable) {
    const rec = supervision.running.find((r) => r.key === keyOf(projectId, d.decl.id));
    if (rec !== undefined) pids.push(rec.pid);
  }
  const live = await proc.infos(pids);

  return usable.map((d) => {
    const key = keyOf(projectId, d.decl.id);
    const rec = supervision.running.find((r) => r.key === key);
    const state = stateOf(rec, rec !== undefined ? live.get(rec.pid) : undefined);
    const missing = consent.check(approvals, key, d.decl.run, d.dir);
    return {
      key,
      projectId,
      productId: d.decl.id,
      name: declare.label(d.decl),
      run: d.decl.run,
      dir: d.dir,
      port: d.decl.port,
      // The directory has to exist before the command means anything, and a
      // checkout that moved is the common way it stops doing.
      dirExists: isDir(d.dir),
      needsApproval: missing === null ? null : consent.missingMessage(missing),
      state,
      log: log.tail(log.file(env.productsLogDir(), key), 6),
    };
  });
}

/** Approve this exact command, in this exact directory. */
export function approve(env: EnvRoot, key: string, run: string, dir: string): void {
  consent.approve(env.productApprovalsFile(), key, consent.token(run, dir));
}

export function revoke(env: EnvRoot, key: string): void {
  consent.revoke(env.productApprovalsFile(), key);
}

/** Start a product, detached, with its output captured. */
export function start(
  env: EnvRoot,
  key: string,
  run: string,
  dir: string,
  spawn: Spawn = defaultSpawn,
): Promise<Record> {
  return serialize(async () => {
    const approvals = consent.load(env.productApprovalsFile());
    const missing = consent.check(approvals, key, run, dir);
    if (missing !== null) throw DddError.config(consent.missingMessage(missing));

    if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);
    const existing = await runningRecord(env, key);
    if (existing !== null) {
      throw DddError.config(`already running as pid ${existing.pid} — stop it first`);
    }

    const logDir = env.productsLogDir();
    mkdirSync(logDir, { recursive: true });
    const logPath = log.file(logDir, key);
    // The only moment we are the log's only writer.
    log.trim(logPath);

    const { pid, startedAt, command } = await spawn(run, dir, logPath);
    const since = new Date().toISOString();

    const supervision = records(env);
    supervision.running = supervision.running.filter((r) => r.key !== key);
    const parts = key.split("/");
    const entry: Record = {
      key,
      projectId: parts[0] ?? "",
      productId: parts[1] ?? "",
      pid,
      startedAt,
      command,
      since,
    };
    supervision.running.push(entry);
    put(env, supervision);
    return entry;
  });
}

/** The record for a product, but only if it still passes the guard. */
export async function runningRecord(env: EnvRoot, key: string): Promise<Record | null> {
  const supervision = records(env);
  const rec = supervision.running.find((r) => r.key === key);
  if (rec === undefined) return null;
  return claim(rec, await proc.info(rec.pid)).kind === "ours" ? rec : null;
}

/**
 * Ask a product to stop, and forget it. The guard runs first and the signal
 * only follows it. A record that no longer verifies is dropped rather than
 * signalled: the PID it names belongs to something else now.
 */
export function stop(env: EnvRoot, key: string): Promise<State> {
  return serialize(async () => {
    const supervision = records(env);
    const rec = supervision.running.find((r) => r.key === key);
    if (rec === undefined) return { state: "stopped" };

    const c = claim(rec, await proc.info(rec.pid));
    supervision.running = supervision.running.filter((r) => r.key !== key);
    put(env, supervision);

    if (c.kind === "ours") {
      try {
        proc.terminate(rec.pid);
      } catch (e) {
        throw DddError.config(`could not stop it: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { state: "stopped" };
    }
    if (c.kind === "gone") return { state: "exited", since: rec.since };
    throw DddError.config(
      `declined: pid ${rec.pid} belongs to ${c.now} now, not to this product — the record has been cleared`,
    );
  });
}
