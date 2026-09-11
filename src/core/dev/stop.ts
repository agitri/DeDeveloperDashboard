/**
 * Asking a process to stop, and the guard that makes it defensible. Port of
 * `dev/stop.rs`.
 *
 * The instinct is to refuse this outright. The argument for shipping it is that
 * the alternative is worse: the user with an `EADDRINUSE` will copy the PID out
 * of this very widget and type `kill -9` at a shell, where the PID can be
 * mistyped and the reflex `-9` skips the shutdown the process was going to do.
 * Showing someone a PID and then declining to act on it is not caution.
 *
 * `SIGTERM` only. There is no force option at any depth of menu.
 */
import { DddError } from "../error";
import { key as keyOf, type Listener } from "./listen";

/** Why a stop was refused. Every variant is a sentence the widget can show as
 *  it stands — a refusal that cannot explain itself reads as a bug. */
export type Refusal =
  /** The socket is gone. Between the scan and the click, it exited on its own. */
  | { kind: "notListening" }
  /** Something is still on that port, and it is not what you clicked. This is
   *  the reuse guard firing, and it is the reason any of this is defensible. */
  | { kind: "reused"; now: string }
  /** No PID: another user's socket. There is no `sudo` path here, ever. */
  | { kind: "foreign" }
  /** A PID with no process name. The guard needs a name to compare, and a guard
   *  that cannot check is not a guard. */
  | { kind: "unnamed" };

export function refusalMessage(refusal: Refusal): string {
  switch (refusal.kind) {
    case "notListening":
      return "it already exited — nothing is on that port now";
    case "reused":
      return `declined: that port now belongs to ${refusal.now}, not the process you clicked`;
    case "foreign":
      return "not your process — DDD will not ask for privilege to stop it";
    case "unnamed":
      return "no process name to verify against, so the reuse guard cannot run";
  }
}

/**
 * May we signal this PID? `null` is yes.
 *
 * Re-enumerated listeners are the second half: between the scan that drew the
 * row and the click, ten seconds can pass, and a PID freed in that window gets
 * reassigned. Requiring the same PID on the same port under the same name turns
 * "silently killed the wrong process" into "declined, and here is what changed".
 *
 * Pure over its inputs, so the guard is tested without signalling anything.
 */
export function mayStop(key: string, pid: number, process: string, fresh: Listener[]): Refusal | null {
  if (process.trim() === "") return { kind: "unnamed" };
  const now = fresh.find((l) => keyOf(l) === key);
  if (now === undefined) return { kind: "notListening" };
  if (now.pid === null) return { kind: "foreign" };
  // The Rust compares with eq_ignore_ascii_case; process names are ASCII.
  if (now.pid !== pid || now.process.toLowerCase() !== process.toLowerCase()) {
    return { kind: "reused", now: `${now.process} (pid ${now.pid})` };
  }
  return null;
}

/** Injected only by tests, so the mapping below can be exercised without a
 *  process to refuse us. */
export type Kill = (pid: number, signal: "SIGTERM") => void;

/**
 * Send `SIGTERM`, and turn a refusal into the sentence the widget shows. The
 * PID has just been verified by `mayStop` against a fresh enumeration.
 *
 * Windows has no `SIGTERM`: `TerminateProcess` is `SIGKILL`-equivalent and
 * `GenerateConsoleCtrlEvent` does not cross sessions reliably, so offering the
 * only available primitive would quietly break the no-force rule. The widget
 * hides the button and says why rather than pretending.
 */
export function signal(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  kill: Kill = (target, sig) => {
    process.kill(target, sig);
  },
): void {
  if (platform === "win32") {
    throw DddError.invalid(
      `could not stop pid ${pid}: stopping a process is not offered on Windows: the only primitive available is a force kill`,
    );
  }
  try {
    kill(pid, "SIGTERM");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") {
      throw DddError.invalid("not your process — DDD will not ask for privilege to stop it");
    }
    // The Rust prints strerror here ("No such process (os error 3)"); Node's
    // message is "kill ESRCH". Same fact, different words — nothing reads it.
    throw DddError.invalid(`could not stop pid ${pid}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
