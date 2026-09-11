/**
 * Which directory a process is running in — the step that turns a port number
 * into a project name. Port of `dev/cwd.rs`.
 *
 * One call for every PID at once, not one per PID. Process spawn is ~30ms on
 * macOS (dyld plus code-signing) and dominates the actual work, so eight
 * servers would be a quarter of a second of pure overhead if asked separately.
 */
import { readlinkSync } from "node:fs";
import { execFileRunner, lines, type Runner } from "./run";

/**
 * Working directory for each PID we could resolve.
 *
 * A PID missing from the result is not an error: the process may have exited
 * between enumeration and this call, or belong to another user. Both mean the
 * same thing to a caller — no project for that row.
 */
export async function forPids(
  pids: number[],
  runner: Runner = execFileRunner,
  platform: NodeJS.Platform = process.platform,
  readLink: (path: string) => string = readlinkSync,
): Promise<Map<number, string>> {
  if (platform === "linux") {
    // procfs answers directly, with no process to spawn at all.
    const out = new Map<number, string>();
    for (const pid of pids) {
      try {
        out.set(pid, readLink(`/proc/${pid}/cwd`));
      } catch {
        // Gone, or another user's. Both mean no project for that row.
      }
    }
    return out;
  }
  if (platform !== "darwin") {
    // Windows: reading another process's PEB is undocumented, and the
    // executable path would name the Node installation rather than the project
    // — worse than nothing, because it looks like an answer. Windows rows carry
    // port, PID and process name, and no project.
    return new Map();
  }
  if (pids.length === 0) return new Map();
  // `-Fpn` is lsof's machine-readable mode: `p<pid>` then `n<path>` lines.
  // `-d cwd` restricts it to the one descriptor we want.
  const out = await runner("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]);
  return parseLsof(out.stdout);
}

/** `p1234\nn/path/to/dir\n` repeating. Pure, so the parsing is testable without
 *  a machine to run `lsof` on. */
export function parseLsof(output: string): Map<number, string> {
  const out = new Map<number, string>();
  let current: number | null = null;
  for (const line of lines(output)) {
    const tag = line.slice(0, 1);
    const value = line.slice(1).trim();
    if (tag === "p") {
      current = /^\d+$/.test(value) ? Number(value) : null;
    } else if (tag === "n") {
      // A process can report several cwd lines across threads; the first is the
      // one that answers "where is this running".
      if (current !== null && !out.has(current)) out.set(current, value);
    }
  }
  return out;
}
