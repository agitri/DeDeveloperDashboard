/**
 * The normalized item cache, one database per environment. Port of
 * `sync/cache.rs`. Widgets read from here and only from here; the scheduler is
 * the only writer. Same DDL as the Rust so both apps share the file.
 */
import { DatabaseSync } from "node:sqlite";
import { DddError } from "../error";
import type { EnvRoot } from "../paths";
import type { Item, ItemAction, ItemFilter } from "../models";

const DDL = `
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS items (
     id            TEXT PRIMARY KEY,
     connection_id TEXT NOT NULL,
     source        TEXT NOT NULL,
     kind          TEXT NOT NULL,
     project       TEXT,
     title         TEXT NOT NULL,
     body          TEXT,
     url           TEXT,
     refs          TEXT NOT NULL DEFAULT '[]',
     actions       TEXT NOT NULL DEFAULT '[]',
     updated_at    TEXT NOT NULL,
     unread        INTEGER NOT NULL DEFAULT 0,
     synced_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS items_conn    ON items(connection_id);
  CREATE INDEX IF NOT EXISTS items_source  ON items(source, kind);
  CREATE INDEX IF NOT EXISTS items_updated ON items(updated_at DESC);`;

function withDb<T>(env: EnvRoot, body: (db: DatabaseSync) => T): T {
  let db: DatabaseSync;
  try {
    // rusqlite sets a 5 s busy timeout on every open; node:sqlite defaults to 0.
    db = new DatabaseSync(env.cacheDb(), { timeout: 5000 });
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

/** Replace everything this connection contributed with a fresh snapshot, in
 *  one transaction so a widget can never observe the gap. A snapshot rather
 *  than a merge, because "closed yesterday" has to be able to disappear. */
export function replaceForConnection(env: EnvRoot, connectionId: string, items: Item[]): void {
  withDb(env, (db) => {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM items WHERE connection_id = ?").run(connectionId);
      const syncedAt = new Date().toISOString();
      // OR REPLACE: a duplicate id from a misbehaving adapter costs that one
      // row, not the whole transaction.
      const insert = db.prepare(
        `INSERT OR REPLACE INTO items
           (id, connection_id, source, kind, project, title, body, url, refs, actions, updated_at, unread, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of items) {
        insert.run(
          item.id,
          item.connectionId,
          item.source,
          item.kind,
          item.project ?? null,
          item.title,
          item.body ?? null,
          item.url ?? null,
          JSON.stringify(item.refs),
          JSON.stringify(item.actions),
          item.updatedAt,
          item.unread ? 1 : 0,
          syncedAt,
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
}

const COLUMNS = "id, connection_id, source, kind, project, title, body, url, refs, actions, updated_at, unread";

interface Row {
  id: string;
  connection_id: string;
  source: string;
  kind: string;
  project: string | null;
  title: string;
  body: string | null;
  url: string | null;
  refs: string;
  actions: string;
  updated_at: string;
  unread: number;
}

function rowToItem(r: Row, environmentId: string): Item {
  return {
    id: r.id,
    // Stamped from the root that opened the database: a row physically cannot
    // have come from another environment.
    environmentId,
    connectionId: r.connection_id,
    source: r.source,
    kind: r.kind,
    project: r.project,
    title: r.title,
    body: r.body,
    url: r.url,
    refs: parseJson<string[]>(r.refs, []),
    actions: parseJson<ItemAction[]>(r.actions, []),
    updatedAt: r.updated_at,
    unread: r.unread !== 0,
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function query(env: EnvRoot, filter: ItemFilter): Item[] {
  return withDb(env, (db) => {
    const like = filter.query ? `%${filter.query}%` : null;
    const excludeKinds = filter.excludeKinds ?? [];
    // Built into the SQL, not filtered afterward: exclusion has to happen
    // before LIMIT or a caller asking for 200 items with one kind excluded can
    // get back far fewer than 200.
    const excludeClause = excludeKinds.length === 0 ? "" : `AND kind NOT IN (${excludeKinds.map(() => "?").join(",")})`;
    const sql = `SELECT ${COLUMNS} FROM items
      WHERE (? IS NULL OR connection_id = ?)
        AND (? IS NULL OR source = ?)
        AND (? IS NULL OR kind = ?)
        AND (? IS NULL OR project = ?)
        AND (? IS NULL OR title LIKE ? OR IFNULL(body,'') LIKE ?)
        AND (? = 0 OR unread = 1)
        ${excludeClause}
      ORDER BY updated_at DESC
      LIMIT ?`;
    const c = filter.connectionId ?? null;
    const s = filter.source ?? null;
    const k = filter.kind ?? null;
    const p = filter.project ?? null;
    const unread = filter.unreadOnly ? 1 : 0;
    const params: (string | number | null)[] = [c, c, s, s, k, k, p, p, like, like, like, unread, ...excludeKinds, filter.limit ?? 200];
    const rows = db.prepare(sql).all(...params) as unknown as Row[];
    return rows.map((r) => rowToItem(r, env.id));
  });
}

/** Look one item up by id, for acting on it. */
export function find(env: EnvRoot, id: string): Item | null {
  return withDb(env, (db) => {
    const row = db.prepare(`SELECT ${COLUMNS} FROM items WHERE id = ?`).get(id) as unknown as Row | undefined;
    return row ? rowToItem(row, env.id) : null;
  });
}

export function clear(env: EnvRoot): void {
  withDb(env, (db) => {
    db.prepare("DELETE FROM items").run();
  });
}
