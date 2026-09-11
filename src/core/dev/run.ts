/**
 * The one way anything under `src/core/dev/` starts a process.
 *
 * The Rust reads listening sockets through the `listeners` crate and shells out
 * only for `lsof -d cwd` and `docker ps`. Node has no equivalent crate, so this
 * port shells out for the enumeration too — and every enumerator takes its
 * runner as an argument, so a test feeds it fixture output instead of whatever
 * happens to be running on the machine.
 */
import { execFile } from "node:child_process";

export interface RunResult {
  /** What the process wrote, even when it exited non-zero: `lsof -p` exits 1
   *  when one of the PIDs has gone and still prints the rest, and the Rust's
   *  `Command::output()` ignores the status the same way. Callers parse
   *  `stdout` regardless of `ok`; a spawn failure yields "" anyway. */
  stdout: string;
  /** False when the process could not be started, exited non-zero, or timed out. */
  ok: boolean;
}

export type Runner = (file: string, args: string[]) => Promise<RunResult>;

/** Big enough for `lsof` on a busy machine, and short enough that a wedged
 *  `docker` cannot hang a refresh. */
const RUN_OPTIONS = { encoding: "utf8" as const, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 };

/** Never rejects: an enumeration that cannot read simply finds less, and a
 *  dashboard that fails to render because one command was missing is worse
 *  than one showing fewer rows. */
export const execFileRunner: Runner = (file, args) =>
  new Promise((resolve) => {
    try {
      execFile(file, args, RUN_OPTIONS, (error, stdout) => {
        resolve({ stdout: stdout ?? "", ok: error === null });
      });
    } catch {
      resolve({ stdout: "", ok: false });
    }
  });

/** Split the way Rust's `str::lines()` does: `\r` stripped, no trailing empty. */
export function lines(output: string): string[] {
  const all = output.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all;
}
