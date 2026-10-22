/**
 * Reading and signalling a process by PID. Port of `products/proc.rs`.
 *
 * The only platform-specific corner of this feature. Everything that decides
 * anything lives in `record.ts` and is pure; this file answers "what holds
 * these PIDs right now" and "please stop". `ps` is reached through the injected
 * `Runner` so a test could feed fixture output, though the tests here use the
 * real thing against real processes, as the Rust does.
 */
import { execFileRunner, lines, type Runner } from "../dev/run";
import type { ProcInfo } from "./record";

/** Above every configured `pid_max` on any platform we run on — Linux's
 *  default ceiling is 4194304 and macOS wraps at 99999. */
export const PID_CEILING = 4_194_304;

const WIN_MESSAGE = "running products is not offered on Windows: the only way to stop one would be a force kill";

async function run(runner: Runner, args: string[]): Promise<string[]> {
  // `ps` exits non-zero when *no* PID matched, which is a normal empty answer
  // here rather than a failure. `execFileRunner` returns stdout regardless of
  // status, matching the Rust's `Command::output()`.
  const { stdout } = await runner("ps", args);
  return lines(stdout)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * What the OS says about a set of PIDs. Absent from the map means nothing
 * *usable* holds that PID. Batched because this runs on every refresh.
 */
export async function infos(pids: number[], runner: Runner = execFileRunner): Promise<Map<number, ProcInfo>> {
  if (process.platform === "win32") return new Map();

  // A PID that could not exist is dropped before asking: `ps` refuses the
  // *whole* batch when one argument is out of range, which would make one
  // corrupt record in products.json take the board with it.
  const asked = pids.filter((p) => p > 0 && p <= PID_CEILING);
  if (asked.length === 0) return new Map();
  const list = asked.join(",");
  const out = new Map<number, ProcInfo>();

  // `lstart` last, because it is the only field that contains spaces — so
  // everything before it splits cleanly and the remainder is the date.
  for (const line of await run(runner, ["-o", "pid=,stat=,lstart=", "-p", list])) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pidText = parts[0]!;
    const stat = parts[1]!;
    if (!/^\d+$/.test(pidText)) continue;
    const pid = Number(pidText);
    // A zombie has exited and not yet been reaped; it still answers `ps` with
    // its original start time. DDD never waits on a product, so skipping
    // zombies is how a product's exit becomes visible while DDD is up.
    if (stat.startsWith("Z")) continue;
    const startedAt = parts.slice(2).join(" ");
    if (startedAt === "") continue;
    out.set(pid, { startedAt, command: "" });
  }

  // Names are for display only, so a failure here costs a label, not a guard.
  for (const line of await run(runner, ["-o", "pid=,comm=", "-p", list])) {
    const parts = line.split(/\s+/);
    const pidText = parts[0];
    if (pidText === undefined || !/^\d+$/.test(pidText)) continue;
    const pid = Number(pidText);
    const comm = parts.slice(1).join(" ");
    const found = out.get(pid);
    if (found !== undefined) {
      // `comm` is a path on Linux and a basename on macOS. Show the last part.
      found.command = comm.slice(comm.lastIndexOf("/") + 1);
    }
  }
  return out;
}

export async function info(pid: number, runner: Runner = execFileRunner): Promise<ProcInfo | null> {
  return (await infos([pid], runner)).get(pid) ?? null;
}

/**
 * Ask a process to stop. `SIGTERM` only, and never after a failed guard — the
 * caller has just verified this PID against a fresh reading via `claim`. Throws
 * on failure; `supervise.stop` maps that to the caller. Windows has no
 * `SIGTERM` and `TerminateProcess` is a force kill, so products are not
 * supervised there at all rather than half-supervised.
 */
export function terminate(pid: number): void {
  if (process.platform === "win32") throw new Error(WIN_MESSAGE);
  process.kill(pid, "SIGTERM");
}
