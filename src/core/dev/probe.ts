/**
 * Is the thing on this port actually answering? Port of `dev/probe.rs`.
 *
 * Two tiers, because a bare TCP connect cannot tell a healthy server from a
 * wedged one: the kernel completes the handshake into the accept backlog
 * whether or not the process is in a state to accept it. A compiling Next.js
 * server connects instantly and then says nothing for fifteen seconds.
 *
 * So: connect always (safe against anything, and the only thing that can
 * produce `Down`), and time-to-first-byte only for processes we have reason to
 * believe speak HTTP. Sending `HEAD /` at Postgres every five seconds would be
 * antisocial.
 */
import net from "node:net";

/**
 * First byte under this and the server is fine.
 *
 * A loopback round trip is sub-millisecond of kernel work, so a quarter of a
 * second of it means the accept loop is busy — which for a dev server means
 * compiling. Measured: 5ms healthy, 978ms mid-compile. Two orders of magnitude
 * apart, so the boundary sits in an empty region.
 */
export const UP_MS = 250;

/** How long one probe may take before its answer is "slow", not "dead". */
export const DEADLINE_MS = 1500;

/** `unknown` is "not probed this cycle". It renders neutral and **never renders
 *  as up** — claiming a server is healthy because nobody asked is the one lie
 *  this widget must not tell. */
export type Health = "unknown" | "up" | "slow" | "down";

export interface Probe {
  health: Health;
  latencyMs: number | null;
}

/** What one on-demand probe answers — the Check button's return. */
export interface DevProbe {
  health: Health;
  latencyMs: number | null;
  checkedAt: string;
}

/** Where to dial. A host, never a name — see `target`. */
export interface Target {
  host: string;
  port: number;
}

export interface BatchTarget {
  key: string;
  target: Target;
  http: boolean;
}

/**
 * Turn a raw outcome into a verdict. Pure, and separated from the socket work
 * precisely so the rule that matters can be tested without one.
 *
 * **A timeout is never `down`.** Refused or reset is down; connected with no
 * bytes by the deadline is slow. A cold compile exceeds any sane deadline, and
 * calling that dead would be the tool confidently telling you to kill the thing
 * you are waiting for.
 */
export function classify(connected: boolean, firstByteMs: number | null): Probe {
  if (!connected) return { health: "down", latencyMs: null };
  // Connected, and nothing came back in time. Busy, not dead.
  if (firstByteMs === null) return { health: "slow", latencyMs: null };
  return { health: firstByteMs < UP_MS ? "up" : "slow", latencyMs: firstByteMs };
}

/**
 * Which address to probe, given how the socket was bound.
 *
 * **Never a name.** `localhost` resolves through the system resolver, whose
 * family preference is not ours to predict — and a family mismatch is the exact
 * bug this function exists to avoid. Anything that is not an IP literal falls
 * back to the v4 loopback, as the Rust's `parse().unwrap_or(LOCALHOST)` does.
 */
export function target(address: string, port: number): Target {
  // A wildcard bind in each family answers on that family's loopback.
  if (address === "0.0.0.0" || address === "*") return { host: "127.0.0.1", port };
  if (address === "::" || address === "[::]") return { host: "::1", port };
  const bare = address.replace(/^\[/, "").replace(/\]$/, "");
  return { host: net.isIP(bare) === 0 ? "127.0.0.1" : bare, port };
}

/**
 * What to put in a browser, which is deliberately *not* what we probe.
 *
 * For a loopback or wildcard bind that is `localhost`: it is what a developer
 * wants pasted into a browser, and browsers try both families themselves. For a
 * specific non-loopback bind it is the literal, bracketed for v6.
 */
export function browserUrl(address: string, port: number): string {
  const loopback = ["0.0.0.0", "*", "::", "[::]", "127.0.0.1", "::1", "[::1]"];
  const host = loopback.includes(address)
    ? "localhost"
    : address.includes(":")
      ? `[${address.replace(/^\[/, "").replace(/\]$/, "")}]`
      : address;
  return `http://${host}:${port}`;
}

/**
 * Process names we will send HTTP bytes to.
 *
 * An allowlist rather than a guess: a database or a message broker should never
 * receive `HEAD /` from a dashboard, and "it is on a high port" is not evidence
 * of anything. Overridable per widget.
 */
export const HTTP_PROCESSES: readonly string[] = [
  "node", "next-server", "next", "vite", "esbuild", "webpack", "bun", "deno",
  "symfony", "php", "php-fpm", "caddy", "nginx", "httpd", "traefik",
  "python", "python3", "gunicorn", "uvicorn", "flask", "django",
  "ruby", "rails", "puma", "cargo", "rustc", "dotnet", "java", "gradle",
];

export function speaksHttp(process: string | null, allowlist: readonly string[]): boolean {
  if (process === null) return false;
  const name = process.toLowerCase();
  // A widget's own list replaces the default rather than extending it.
  const list = allowlist.length > 0 ? allowlist : HTTP_PROCESSES;
  return list.some((p) => name.includes(p.toLowerCase()));
}

/**
 * The request bytes, verbatim from the Rust.
 *
 * HTTP/1.0 so the server closes rather than holding the connection open, and
 * HEAD so nothing large is ever sent back. `Host` because a vhosted server may
 * otherwise answer 400 — which is still a first byte, and a first byte is the
 * whole measurement. The host is the Rust's `SocketAddr` display: a v6 literal
 * is bracketed.
 */
export function httpRequest(t: Target): string {
  const addr = t.host.includes(":") ? `[${t.host}]:${t.port}` : `${t.host}:${t.port}`;
  return `HEAD / HTTP/1.0\r\nHost: ${addr}\r\nUser-Agent: DDD-dev-board\r\nConnection: close\r\n\r\n`;
}

/**
 * Probe one socket, in at most `deadlineMs`.
 *
 * Tier 1 is the connect: safe to point at anything, and the only thing that can
 * produce `down`. Tier 2 asks for a byte, and only of processes the allowlist
 * vouched for. A deadline that lands before the handshake is `down` (the Rust's
 * `connect_timeout` returns an error); one that lands after it is `slow`.
 */
export function run(t: Target, http: boolean, deadlineMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    const started = Date.now();
    let connected = false;
    let settled = false;
    const socket = net.connect({ host: t.host, port: t.port });
    const finish = (probe: Probe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(probe);
    };
    const timer = setTimeout(() => finish(classify(connected, null)), deadlineMs);
    // Refused, reset, or unreachable before the handshake is the one honest
    // `down`; anything after it is busy, not dead.
    socket.on("error", () => finish(classify(connected, null)));
    // A closed connection with no reply is still an answer we did not get.
    socket.on("end", () => finish(classify(connected, null)));
    socket.on("close", () => finish(classify(connected, null)));
    socket.on("connect", () => {
      connected = true;
      if (!http) {
        // It accepted a connection and we never asked it for anything, so we
        // have no evidence about its accept loop. `classify(true, null)` would
        // say `slow`, which would be inventing a symptom we did not observe —
        // hence not reusing it here. Up, with no latency: "listening".
        finish({ health: "up", latencyMs: null });
        return;
      }
      socket.once("data", () => finish(classify(true, Date.now() - started)));
      // It took the connection and would not take the request: busy, not dead.
      socket.write(httpRequest(t), (error) => {
        if (error) finish(classify(true, null));
      });
    });
  });
}

/**
 * Probe every row of a batch concurrently, under one deadline for the batch.
 *
 * Returns what resolved, keyed by row key. What is missing stayed `unknown` and
 * gets another chance next cycle: there is no retry inside a cycle, because
 * retrying inside a poll is how a five-second poll becomes twenty.
 */
export async function batch(targets: BatchTarget[], deadlineMs: number): Promise<Map<string, Probe>> {
  const settled = await Promise.all(targets.map(async (t) => [t.key, await run(t.target, t.http, deadlineMs)] as const));
  return new Map(settled);
}
