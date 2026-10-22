/**
 * What is listening, and who owns it. Port of `dev/listen.rs`.
 *
 * The only file that names the enumeration tool. Everything above this speaks
 * DDD's own `Listener`, so replacing `lsof` with libproc or
 * `GetExtendedTcpTable` is a day's work in one file rather than a rewrite.
 */
import { execFileRunner, lines, type Runner } from "./run";

/** One listening socket, in our terms rather than the tool's. */
export interface Listener {
  port: number;
  /** As bound, verbatim: `127.0.0.1`, `::1`, `*`. */
  address: string;
  /**
   * `null` when the socket belongs to another UID.
   *
   * On macOS this is not a permission we can request: the kernel simply does
   * not attribute other users' sockets to a non-root caller. It is **not** TCC
   * — no prompt, entitlement or plist changes it. Only root does, and a
   * dashboard should not be root.
   */
  pid: number | null;
  /** `""` where the Rust has `None`: netstat cannot name a process, and
   *  inventing one would be worse than admitting we do not know. */
  process: string;
}

/**
 * `tcp:127.0.0.1:8005` — identity, React key, and the handle the probe and
 * stop commands take.
 *
 * Keyed on address *and* port because two sockets can share a port across
 * families: `127.0.0.1:8000` and `[::1]:8000` are two processes, and a
 * port-keyed list would silently collapse them into one row.
 */
export function key(l: Listener): string {
  return `tcp:${l.address}:${l.port}`;
}

/** `v4` · `v6`, for a badge — the family is load-bearing here, so it is shown
 *  rather than inferred by the reader. */
export function family(l: Listener): "v4" | "v6" {
  return l.address.includes(":") && l.address !== "*" ? "v6" : "v4";
}

/** No PID means another UID's socket: not ours to probe, project or stop. */
export function foreign(l: Listener): boolean {
  return l.pid === null;
}

/** Wildcard binds arrive spelled several ways; the rest pass through verbatim,
 *  unbracketed so the key matches the Rust's `SocketAddr` spelling. */
export function normalizeAddress(address: string): string {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  return bare === "0.0.0.0" || bare === "::" || bare === "*" ? "*" : bare;
}

/** `-F pcn` is lsof's machine-readable mode: `p<pid>`, `c<command>`, `n<addr>`.
 *  `f<fd>` lines come anyway and are ignored. */
export const LSOF_ARGS = ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"];
export const NETSTAT_ARGS = ["-ano"];

/** Every TCP socket in LISTEN state this user can see.
 *
 *  Never rejects: an enumeration that cannot read simply finds less. */
export async function enumerate(runner: Runner = execFileRunner, platform: NodeJS.Platform = process.platform): Promise<Listener[]> {
  const found =
    platform === "win32"
      ? parseNetstat((await runner("netstat", NETSTAT_ARGS)).stdout)
      : parseLsof((await runner("lsof", LSOF_ARGS)).stdout);
  return order(found);
}

/** Stable order so a refresh does not reshuffle the board under the cursor,
 *  then Rust's `Vec::dedup`: consecutive identical sockets collapse (lsof
 *  reports a dual-descriptor bind twice), different processes on one socket do
 *  not — that collapse belongs to the join, which counts them as workers. */
export function order(found: Listener[]): Listener[] {
  const sorted = [...found].sort((a, b) => a.port - b.port || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return sorted.filter((l, i) => {
    const previous = sorted[i - 1];
    return (
      previous === undefined ||
      !(previous.port === l.port && previous.address === l.address && previous.pid === l.pid && previous.process === l.process)
    );
  });
}

export function parseLsof(output: string): Listener[] {
  const out: Listener[] = [];
  let pid: number | null = null;
  let command = "";
  for (const line of lines(output)) {
    const tag = line.slice(0, 1);
    const value = line.slice(1).trim();
    if (tag === "p") {
      pid = integer(value);
      command = "";
    } else if (tag === "c") {
      command = value;
    } else if (tag === "n") {
      // Never guess an association: a socket with no owner above it is dropped.
      if (pid === null) continue;
      // An established socket carries an arrow. `-sTCP:LISTEN` should already
      // have excluded it; this is the belt to that braces.
      if (value.includes("->")) continue;
      const socket = splitHostPort(value);
      if (socket === null) continue;
      out.push({ port: socket.port, address: normalizeAddress(socket.host), pid, process: command });
    }
  }
  return out;
}

/** `  TCP    0.0.0.0:135   0.0.0.0:0   LISTENING   1044`. The process name is
 *  not in this output, so Windows rows carry port, PID and no name. */
export function parseNetstat(output: string): Listener[] {
  const out: Listener[] = [];
  for (const line of lines(output)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP" || parts[3] !== "LISTENING") continue;
    const socket = splitHostPort(parts[1]!);
    if (socket === null) continue;
    out.push({ port: socket.port, address: normalizeAddress(socket.host), pid: integer(parts[4]!), process: "" });
  }
  return out;
}

/** `127.0.0.1:8005`, `*:3000`, `[::1]:5199` — split at the last colon, which is
 *  why the v6 literal keeps its brackets until `normalizeAddress`. */
function splitHostPort(value: string): { host: string; port: number } | null {
  const at = value.lastIndexOf(":");
  if (at <= 0) return null;
  const port = integer(value.slice(at + 1));
  if (port === null || port > 65535) return null;
  return { host: value.slice(0, at), port };
}

/** Rust's `str::parse::<u32>()`: whole string, digits only. */
function integer(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}
