/**
 * The dev board's pure decisions: how a health verdict reads, how fast to poll,
 * and what to hand someone when the widget cannot answer their question.
 *
 * Separated from the widget for the usual reason — these are the parts worth
 * testing, and none of them need a socket, a store or a render.
 */

export type Health = "unknown" | "up" | "slow" | "down";

export interface Badge {
  label: string;
  /** A CSS variable, so both themes come from the same palette. */
  color: string;
  title: string;
}

/**
 * Health → what the dot says.
 *
 * `unknown` is neutral and specifically **not** green: claiming a server is
 * healthy because nobody asked is the one lie this widget must not tell. And
 * `slow` is not a failure state — it is the shape of a cold compile.
 */
export function badge(health: Health, latencyMs: number | null): Badge {
  switch (health) {
    case "up":
      return {
        label: latencyMs === null ? "listening" : `${latencyMs}ms`,
        color: "var(--ok)",
        title:
          latencyMs === null
            ? "Accepted a connection. Not asked for a reply — its process is not on the HTTP list."
            : `Answered in ${latencyMs}ms`,
      };
    case "slow":
      return {
        label: "busy",
        color: "var(--warn)",
        title: "Connected, but nothing came back in time. Usually compiling — not dead, and not worth killing.",
      };
    case "down":
      return {
        label: "down",
        color: "var(--err)",
        title: "The connection was refused or reset. Nothing is answering on this socket.",
      };
    default:
      return {
        label: "—",
        color: "var(--ink-3)",
        title: "Not checked yet.",
      };
  }
}

/**
 * Poll interval for the next cycle, in milliseconds.
 *
 * The machine is at load 17 because you are compiling, which is exactly when
 * you are watching this board and exactly when it can least afford a fifth of a
 * core. So a slow scan buys itself room and gives it back as things recover.
 *
 * The dead band between 400ms and 750ms is deliberate: without it the interval
 * oscillates every single cycle.
 */
export function nextInterval(baseMs: number, currentMs: number, lastScanMs: number): number {
  const CEILING = 30_000;
  const next = lastScanMs > 750 ? currentMs * 2 : lastScanMs < 400 ? Math.floor(currentMs / 2) : currentMs;
  return Math.min(Math.max(next, baseMs), Math.max(CEILING, baseMs));
}

/**
 * The command that answers the question this widget cannot.
 *
 * DDD can only see processes running as you. When the port someone is hunting
 * belongs to root or another user, handing over the exact command beats an
 * apology. Returns null rather than building a command around junk — this
 * string is meant to be pasted into a shell.
 */
export function lsofCommand(port: string): string | null {
  if (!/^\d+$/.test(port.trim())) return null;
  const n = Number(port.trim());
  if (n < 1 || n > 65535) return null;
  return `sudo lsof -i :${n} -sTCP:LISTEN`;
}

/** How a container's state reads in the drill-down. */
export function containerTone(running: boolean, unhealthy: boolean): string {
  if (!running) return "var(--ink-3)";
  return unhealthy ? "var(--warn)" : "var(--ok)";
}
