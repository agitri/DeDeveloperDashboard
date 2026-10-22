/**
 * Cloning, detached. Port of `repos/clone.rs`.
 *
 * A large clone takes minutes, and a command that blocks that long looks like a
 * hung app. So the work is spawned and progress is pushed over the same event
 * channel the file watcher already uses — the row updates itself exactly the
 * way a todo does.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DddError } from "../error";
import type { EnvRoot } from "../paths";
import { GIT_EXEC_OPTIONS, register } from "../projects";
import { canonicalPath, upsert } from "./links";

/**
 * One progress tick. Deliberately not the IPC event payload: the caller maps
 * this into whatever it emits, so the clone itself knows nothing about windows
 * or serialization — which is also what lets a test run a real clone and simply
 * collect these.
 */
export interface Progress {
  phase: string;
  percent: number;
  done: boolean;
  error: string | null;
}

const step = (phase: string, percent: number): Progress => ({ phase, percent, done: false, error: null });
const finished = (): Progress => ({ phase: "Done", percent: 100, done: true, error: null });
const failed = (error: string): Progress => ({ phase: "Failed", percent: 0, done: true, error });

/** How many trailing stderr lines to keep for a failure message. */
const TAIL_LINES = 20;

/** The subprocess runner, injectable so a test can make `git` fail to start.
 *  The default is the real `node:child_process` `spawn`. */
export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check a clone can start, and say where it would land.
 *
 * Separate from `run` because this is the part the caller must do *before*
 * detaching: a refusal has to reach the user as a failed command, not as a
 * progress event nobody is listening for yet.
 */
export function prepare(parent: string, remote: string): string {
  if (!isDir(parent)) throw DddError.notFound(`${parent} is not a directory`);
  const target = targetDir(parent, remote);
  // Refuse rather than merge into something that is already there — a
  // half-finished checkout that showed up some other way is not ours to
  // overwrite silently.
  let occupied = false;
  if (existsSync(target)) {
    try {
      occupied = readdirSync(target).length > 0;
    } catch {
      // The Rust's `.unwrap_or(false)`: unreadable is not "occupied".
      occupied = false;
    }
  }
  if (occupied) throw DddError.config(`${target} already exists and is not empty`);
  return target;
}

/**
 * Where a clone of `remote` lands under `parent`.
 *
 * `remote` is a normalized `host/owner/repo` string, sometimes with a trailing
 * slash depending on where it came from — trim it before taking the last
 * segment, or a trailing slash would name the folder "".
 */
export function targetDir(parent: string, remote: string): string {
  const trimmed = remote.replace(/\/+$/, "");
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return join(parent, last === "" ? "repo" : last);
}

/**
 * `Receiving objects:  41% (…)` → `{ phase: "Receiving objects", percent: 41 }`.
 *
 * A percentage git never actually emits (over 100, or too big to fit a `u8` at
 * all) must not blow up: it clamps what parses and rejects what doesn't, same
 * as any other malformed line.
 */
export function parseProgress(line: string): { phase: string; percent: number } | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const phase = line.slice(0, colon);
  const rest = line.slice(colon + 1);
  const percentIndex = rest.indexOf("%");
  if (percentIndex < 0) return null;
  const head = rest.slice(0, percentIndex);
  let i = head.length;
  while (i > 0 && head[i - 1]! >= "0" && head[i - 1]! <= "9") i--;
  const digits = head.slice(i);
  if (digits === "") return null;
  const percent = Number(digits);
  // The Rust parses into a `u8` first: anything over 255 is not a number it
  // accepts, and only what parses is then clamped to 100.
  if (percent > 255) return null;
  return { phase: phase.trim(), percent: Math.min(percent, 100) };
}

/**
 * Run the clone to completion, reporting progress as it goes.
 *
 * On success the repo is linked and registered as a project, because a clone is
 * just a link plus the fetch that makes it true.
 */
export function run(
  env: EnvRoot,
  remote: string,
  cloneUrl: string,
  target: string,
  onProgress: (p: Progress) => void,
  spawnFn: SpawnLike = nodeSpawn,
): Promise<void> {
  return new Promise((resolve) => {
    // Deferred past the current tick: `repo_clone` returns its target
    // synchronously, and no progress tick may reach a listener before that
    // return has happened. The Rust gets this ordering for free by running
    // the whole body on `spawn_blocking`; here it takes an explicit yield.
    setImmediate(() => {
      onProgress(step("Starting", 0));

      let child: ChildProcess;
      try {
        child = spawnFn("git", ["clone", "--progress", cloneUrl, target], {
          stdio: ["ignore", "ignore", "pipe"],
          // The Rust inherits the environment; this port shares `projects.ts`'s
          // GIT_TERMINAL_PROMPT=0 so a credential prompt fails instead of hanging
          // a clone forever behind a window that cannot answer it.
          env: GIT_EXEC_OPTIONS.env,
        });
      } catch (e) {
        onProgress(failed(`could not start git: ${e instanceof Error ? e.message : String(e)}`));
        return resolve();
      }

      // git writes progress to stderr, one carriage-return-delimited chunk at a
      // time rather than one line at a time — reading by line would sit blocked
      // until the whole clone finished.
      const tail: string[] = [];
      let buffer = "";
      const take = (chunk: string): void => {
        const line = chunk.trim();
        if (line === "") return;
        const parsed = parseProgress(line);
        if (parsed !== null) onProgress(step(parsed.phase, parsed.percent));
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
      };

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (data: string) => {
        buffer += data;
        const parts = buffer.split("\r");
        // The last piece may be half a chunk; hold it until more arrives.
        buffer = parts.pop() ?? "";
        for (const part of parts) take(part);
      });

      // Node reports a failure to start asynchronously, where Rust's `spawn()`
      // returns the error directly — same message, later.
      let spawnError: Error | null = null;
      child.once("error", (e: Error) => {
        spawnError = e;
      });

      child.once("close", (code: number | null) => {
        take(buffer);
        buffer = "";
        if (spawnError !== null) {
          onProgress(failed(`could not start git: ${spawnError.message}`));
          return resolve();
        }
        if (code === 0) {
          let canonical: string;
          try {
            // See `links.canonicalPath`: the link's path must be canonical or
            // `repos_list`'s projectId join against the registry's canonicalized
            // `ProjectRef.path` never fires for this repo. The target didn't
            // exist before the clone, so this is the first point canonicalizing
            // it is even possible.
            canonical = canonicalPath(target);
          } catch (e) {
            onProgress(failed(`clone finished but ${e instanceof Error ? e.message : String(e)}`));
            return resolve();
          }
          try {
            upsert(env, { remote, path: canonical, source: "manual", confidence: "exact" });
          } catch {
            // The Rust's `let _ =`: a store that will not take the link does not
            // un-clone the repo.
          }
          try {
            // `projects.register` does its own canonicalization of `path`,
            // independently of the one above — the same split `repo_link` uses.
            register(env, target);
          } catch {
            /* see above */
          }
          onProgress(finished());
          return resolve();
        }
        // A partial checkout is reported, never deleted — destroying a
        // half-finished download of a large repo is worse than leaving a folder
        // to clean up.
        onProgress(failed(tail.join("\n")));
        resolve();
      });
    });
  });
}
