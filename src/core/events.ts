/**
 * The local events table. Port of `events.rs`. One database per environment;
 * nothing here ever leaves the machine.
 *
 * `node:sqlite` is built into the Node that Electron 44 bundles, so there is no
 * native module to rebuild. Same DDL as the Rust, so both apps share the file.
 */
import { DatabaseSync } from "node:sqlite";
import { DddError } from "./error";
import type { EnvRoot } from "./paths";
import type { EventInput, EventRow } from "./models";
import { settingsLoad } from "./settings";

const DDL = `
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS events (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     ts          TEXT    NOT NULL,
     kind        TEXT    NOT NULL,
     source      TEXT,
     project     TEXT,
     tokens_in   INTEGER,
     tokens_out  INTEGER,
     cost_micros INTEGER,
     meta        TEXT
  );
  CREATE INDEX IF NOT EXISTS events_ts   ON events(ts);
  CREATE INDEX IF NOT EXISTS events_kind ON events(kind);`;

function withDb<T>(env: EnvRoot, body: (db: DatabaseSync) => T): T {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(env.eventsDb());
  } catch (e) {
    throw DddError.sqlite(e);
  }
  try {
    db.exec(DDL);
    return body(db);
  } catch (e) {
    throw e instanceof DddError ? e : DddError.sqlite(e);
  } finally {
    db.close();
  }
}

const orNull = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

export function log(env: EnvRoot, event: EventInput): number {
  return withDb(env, (db) => {
    const ts = new Date().toISOString();
    const meta = event.meta === undefined || event.meta === null ? null : JSON.stringify(event.meta);
    const result = db
      .prepare(
        `INSERT INTO events (ts, kind, source, project, tokens_in, tokens_out, cost_micros, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ts, event.kind, orNull(event.source), orNull(event.project), orNull(event.tokensIn), orNull(event.tokensOut), orNull(event.costMicros), meta);
    return Number(result.lastInsertRowid);
  });
}

export interface EventsQuery {
  /** RFC 3339 lower bound. */
  since?: string | null;
  /** Dotted namespace prefix (`ai.`, `tab.`) the stats widget wants. */
  kindPrefix?: string | null;
  limit: number;
}

interface Row {
  id: number;
  ts: string;
  kind: string;
  source: string | null;
  project: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_micros: number | null;
  meta: string | null;
}

/** Most recent first. */
export function query(env: EnvRoot, q: EventsQuery): EventRow[] {
  return withDb(env, (db) => {
    const rows = db
      .prepare(
        `SELECT id, ts, kind, source, project, tokens_in, tokens_out, cost_micros, meta
           FROM events
          WHERE ($since IS NULL OR ts >= $since)
            AND ($prefix IS NULL OR kind LIKE $prefix || '%')
          ORDER BY id DESC
          LIMIT $limit`,
      )
      .all({ since: orNull(q.since), prefix: orNull(q.kindPrefix), limit: q.limit }) as unknown as Row[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      source: r.source,
      project: r.project,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      costMicros: r.cost_micros,
      meta: parseMeta(r.meta),
    }));
  });
}

function parseMeta(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** "Wipe local data" in Settings → Data. */
export function clear(env: EnvRoot): void {
  withDb(env, (db) => {
    db.prepare("DELETE FROM events").run();
  });
}

/** The `event_log` command. Opting out of stats has to actually stop the
 *  writing, not just the charts. */
export function eventLog(env: EnvRoot, event: EventInput): void {
  let enabled = true;
  try {
    enabled = settingsLoad(env).data.statsLoggingEnabled;
  } catch {
    enabled = true;
  }
  if (enabled) log(env, event);
}
