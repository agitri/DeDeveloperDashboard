/**
 * What is running on this machine, which project it belongs to, and whether it
 * is answering. Port of `dev/mod.rs`.
 *
 * A live read, not an `Item`: the item cache is deliberately allowed to be
 * stale, which is fine for a pull request and fatal for liveness. So this looks
 * like `repos_list` — read the world, join it against what this environment
 * knows, return rows — and writes nothing at all.
 */
import { DddError } from "../error";
import { isArray, isBoolean, isString, record } from "../json";
import * as containers from "./containers";
import type { DevContainer } from "./containers";
import * as cwd from "./cwd";
import * as listen from "./listen";
import type { Listener } from "./listen";
import * as probe from "./probe";
import { execFileRunner, type Runner } from "./run";

export type { DevContainer };

export interface DevServerFilter {
  /**
   * Show only rows that map to a project on disk.
   *
   * Default **true**, and the measurement is why: this machine has 311
   * listening sockets, of which 237 are Spotify, Sonos, Chrome, Control Centre
   * and other things nobody wants on a dev board. The join is the filter — a
   * dev server runs inside a project directory and Spotify does not.
   */
  knownOnly?: boolean;
  /** Substring over process name, project name and port. */
  query?: string;
  /** Process names eligible for an HTTP probe. Bundled default when absent. */
  http?: string[];
  /**
   * Include ports the kernel assigned rather than a human chose.
   *
   * Default **false**, and measured: this machine has 142 listeners at or above
   * 49152 against 21 below it, every one of which is a real dev server or a
   * Docker publish. Nobody types `localhost:62662`.
   */
  ephemeral?: boolean;
  /** Probe inline during this listing. Default **false**: the first paint
   *  should show rows before any socket work happens. */
  probe?: boolean;
}

export function devServerFilterFromJson(raw: unknown): DevServerFilter {
  const o = record(raw, "filter");
  const out: DevServerFilter = {};
  for (const field of ["knownOnly", "ephemeral", "probe"] as const) {
    const v = o[field];
    if (v === undefined || v === null) continue;
    if (!isBoolean(v)) throw DddError.json(`invalid type for field \`${field}\``);
    out[field] = v;
  }
  if (o.query !== undefined && o.query !== null) {
    if (!isString(o.query)) throw DddError.json("invalid type for field `query`");
    out.query = o.query;
  }
  if (o.http !== undefined && o.http !== null) {
    if (!isArray(o.http)) throw DddError.json("invalid type for field `http`");
    out.http = o.http.map((p) => {
      if (!isString(p)) throw DddError.json("invalid type for field `http`");
      return p;
    });
  }
  return out;
}

/** One listening socket, joined against what this environment knows. Field
 *  order is the Rust struct's, because that is the JSON the widget reads. */
export interface DevServerRow {
  /** `tcp:127.0.0.1:8005` — identity, React key, and the handle the probe and
   *  stop commands take. */
  key: string;
  port: number;
  /** As bound, verbatim. The family is load-bearing, so it is shown. */
  address: string;
  family: string;
  pid: number | null;
  process: string | null;
  cwd: string | null;
  /** Basename of the matched project directory. */
  projectName: string | null;
  /** Set only when *this* environment's registry claims it. */
  projectId: string | null;
  /** Set when the link store claims it — enables IDE and terminal on a checkout
   *  that was never registered as a project. */
  repoPath: string | null;
  /** The match came from an ancestor rather than the cwd itself, so a monorepo
   *  row can say which project it rolled up to. */
  matchedAncestor: boolean;
  /** What to paste into a browser. `null` when we have no reason to think it
   *  speaks HTTP — a fabricated link to a database is worse than no link. */
  url: string | null;
  health: probe.Health;
  latencyMs: number | null;
  checkedAt: string | null;
  /** Another UID's socket: no PID, not ours to probe, project or stop. */
  foreign: boolean;
  /** A Docker-published port. Shown, because it answers "what has 5432", and
   *  never probed, because a dashboard should not send HEAD / to Postgres. */
  docker: boolean;
  /** Containers composed from this row's project directory. */
  containers: DevContainer[];
  /** Extra processes sharing this exact listening socket. A forked pool —
   *  php-fpm workers, a JVM's children — inherits the parent's listening socket,
   *  so the OS reports one row per process. They are one server. */
  workers: number;
}

export interface DevServerListing {
  rows: DevServerRow[];
  /** Listeners that exist but are not shown, so the filter carries a number
   *  rather than silently eating three quarters of the machine. */
  hidden: number;
  /** Sockets belonging to another user, counted so the "your processes" caveat
   *  is honest rather than a vibe. */
  foreignCount: number;
  scanMs: number;
  /** The probe deadline landed with rows unresolved. They stay `unknown` and
   *  get another chance next cycle — never a fabricated verdict. */
  partial: boolean;
}

/** A project this environment knows about, from either store. */
export interface KnownProject {
  path: string;
  id: string | null;
  isRepoLink: boolean;
}

// --- reading the machine ----------------------------------------------------

/** One read of the machine: what is listening, where those processes are, and
 *  what Docker composed from where. */
export interface Snapshot {
  listeners: Listener[];
  cwds: Map<number, string>;
  containers: Map<string, DevContainer[]>;
  scanMs: number;
}

export function emptySnapshot(): Snapshot {
  return { listeners: [], cwds: new Map(), containers: new Map(), scanMs: 0 };
}

/**
 * The floor under how often the OS is actually read.
 *
 * Two widgets on one board, or a manual refresh landing on top of a poll,
 * should not mean two `lsof` calls and two `docker ps`. Well under the 5s poll,
 * so it never makes the board stale — it only collapses bursts.
 */
export const MEMO_FLOOR_MS = 2000;

/**
 * Last read of the machine, and the single-flight around it.
 *
 * Deliberately not a module-level singleton: tests get their own instance, so a
 * memo test can never be made flaky by whatever else the suite is doing. The
 * Rust holds a mutex across the read; a second caller here awaits the read
 * already in flight instead, which is the same guarantee in a language with no
 * blocking lock.
 */
export class Memo {
  private last: { at: number; snapshot: Snapshot } | null = null;
  private inFlight: Promise<Snapshot> | null = null;

  async get(now: number, floorMs: number, read: () => Promise<Snapshot>): Promise<Snapshot> {
    if (this.last !== null && now - this.last.at < floorMs) return this.last.snapshot;
    if (this.inFlight !== null) return await this.inFlight;
    const reading = read().then(
      (snapshot) => {
        this.last = { at: now, snapshot };
        this.inFlight = null;
        return snapshot;
      },
      (e) => {
        this.inFlight = null;
        throw e;
      },
    );
    this.inFlight = reading;
    return await reading;
  }
}

/** Read the machine: listeners, then the working directory of every PID among
 *  them in one call, then Docker. */
export async function readMachine(runner: Runner = execFileRunner, platform: NodeJS.Platform = process.platform): Promise<Snapshot> {
  const started = Date.now();
  const listeners = await listen.enumerate(runner, platform);
  const pids = [...new Set(listeners.map((l) => l.pid).filter((pid): pid is number => pid !== null))].sort((a, b) => a - b);
  const cwds = await cwd.forPids(pids, runner, platform);
  const byDir = await containers.byProjectDir(runner);
  return { listeners, cwds, containers: byDir, scanMs: Date.now() - started };
}

/** The probe pass, injectable so a listing can be tested without sockets. */
export type ProbeRunner = (targets: probe.BatchTarget[], deadlineMs: number) => Promise<Map<string, probe.Probe>>;

/**
 * The whole command, minus the environment lookup: snapshot, join, probe.
 *
 * Split from `join` so the join stays pure and this stays the only part that
 * touches a socket.
 */
export async function list(
  snapshot: Snapshot,
  known: KnownProject[],
  filter: DevServerFilter,
  probeRunner: ProbeRunner = probe.batch,
): Promise<DevServerListing> {
  const http = filter.http ?? [];
  const listing = join(snapshot.listeners, snapshot.cwds, known, snapshot.containers, filter);
  listing.scanMs = snapshot.scanMs;

  if (!(filter.probe ?? false)) return listing;

  // Never a foreign socket — not ours to touch — and never a Docker-published
  // port, because a dashboard must not send HEAD / to Postgres on a timer.
  const targets: probe.BatchTarget[] = listing.rows
    .filter((r) => !r.foreign && !r.docker)
    .map((r) => ({ key: r.key, target: probe.target(r.address, r.port), http: probe.speaksHttp(r.process, http) }));
  if (targets.length === 0) return listing;

  const wanted = targets.length;
  const results = await probeRunner(targets, probe.DEADLINE_MS);
  const now = new Date().toISOString();
  for (const row of listing.rows) {
    const found = results.get(row.key);
    if (found === undefined) continue;
    row.health = found.health;
    row.latencyMs = found.latencyMs;
    row.checkedAt = now;
  }
  listing.partial = results.size < wanted;
  return listing;
}

/** The first port of the IANA dynamic range. At or above this, the kernel
 *  picked the number, which means no human ever typed it. */
export const EPHEMERAL = 49152;

/**
 * Join listeners against what this environment knows.
 *
 * Pure over its inputs so every rule below is testable without a socket, a
 * process table, or Docker.
 */
export function join(
  listeners: Listener[],
  cwds: Map<number, string>,
  known: KnownProject[],
  byDir: Map<string, DevContainer[]>,
  filter: DevServerFilter,
): DevServerListing {
  const knownOnly = filter.knownOnly ?? true;
  const ephemeral = filter.ephemeral ?? false;
  const needle = filter.query === undefined ? null : filter.query.toLowerCase();
  const http = filter.http ?? [];

  let foreignCount = 0;
  let hidden = 0;
  const rows: DevServerRow[] = [];

  // Collapse a forked pool to one row before anything else looks at the list:
  // every rule below is about a socket, and a socket is what a key names.
  const workers = new Map<string, number>();
  const first = listeners.filter((l) => {
    const seen = (workers.get(listen.key(l)) ?? 0) + 1;
    workers.set(listen.key(l), seen);
    return seen === 1;
  });
  // Stable, so ties keep the order the enumeration produced.
  first.sort((a, b) => a.port - b.port);

  for (const l of first) {
    // Port 0 is not something anything can connect to; it appears in the table
    // for sockets bound without a port and is pure noise.
    if (l.port === 0) continue;
    if (!ephemeral && l.port >= EPHEMERAL) {
      hidden += 1;
      continue;
    }
    if (listen.foreign(l)) foreignCount += 1;

    const dir = l.pid === null ? null : (cwds.get(l.pid) ?? null);
    const matched = dir === null ? null : matchProject(dir, known);
    // Recorded here, while the cwd is still in hand, so a monorepo row can say
    // it rolled up rather than silently renaming itself.
    const matchedAncestor = matched !== null && dir !== null && matched.path !== dir;
    const docker = l.process.toLowerCase().includes("docker");

    // A Docker-published port has the daemon as its process, so its cwd is
    // Docker's own — never a project. Attribute it by which project's compose
    // file published that port instead.
    const projectDir =
      matched !== null ? matched.path
      : docker ? dirPublishing(l.port, byDir)
      : null;
    const rowContainers = projectDir === null ? [] : (byDir.get(projectDir)?.slice() ?? []);
    // A Docker row is named by its compose project rather than by the
    // directory's basename: a compose file living in `…/foo/backend` gives every
    // container a `foo-` prefix, and "backend" matches nothing the user sees in
    // `docker ps`.
    const projectName =
      matched === null && docker && rowContainers[0] !== undefined ? rowContainers[0].project
      : projectDir === null ? null
      : leaf(projectDir);

    if (knownOnly && projectName === null) {
      hidden += 1;
      continue;
    }
    if (needle !== null) {
      const haystack = `${l.port} ${l.process} ${projectName ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }

    const probesHttp = !docker && probe.speaksHttp(l.process, http);

    rows.push({
      key: listen.key(l),
      port: l.port,
      address: l.address,
      family: listen.family(l),
      pid: l.pid,
      // `""` is this port's spelling of the Rust's `None`: a socket with no name.
      process: l.process === "" ? null : l.process,
      cwd: dir,
      projectName,
      projectId: matched?.id ?? null,
      repoPath: matched !== null && matched.isRepoLink ? matched.path : null,
      matchedAncestor,
      url: probesHttp ? probe.browserUrl(l.address, l.port) : null,
      health: "unknown",
      latencyMs: null,
      checkedAt: null,
      foreign: listen.foreign(l),
      docker,
      containers: rowContainers,
      workers: Math.max((workers.get(listen.key(l)) ?? 1) - 1, 0),
    });
  }

  return { rows, hidden, foreignCount, scanMs: 0, partial: false };
}

/**
 * The project a directory belongs to: itself, or the nearest ancestor.
 *
 * Ancestor matching is what makes a monorepo work — a dev server started in
 * `myapp/packages/web` belongs to `myapp`. Longest match wins, so a nested
 * project inside another is attributed to the nearer one.
 */
function matchProject(dir: string, known: KnownProject[]): KnownProject | null {
  let best: KnownProject | null = null;
  for (const p of known) {
    if (dir !== p.path && !dir.startsWith(`${p.path}/`)) continue;
    // `>=` so the last of equal-length matches wins, as Rust's max_by_key does.
    if (best === null || p.path.length >= best.path.length) best = p;
  }
  return best;
}

/** Which project's compose file published this host port. */
function dirPublishing(port: number, byDir: Map<string, DevContainer[]>): string | null {
  for (const [dir, list] of byDir) {
    if (list.some((c) => c.running && c.ports.includes(port))) return dir;
  }
  return null;
}

function leaf(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}
