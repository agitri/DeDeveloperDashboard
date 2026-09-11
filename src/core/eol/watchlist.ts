/**
 * What you asked the watcher to watch. Port of `eol/watchlist.rs`.
 *
 * User-authored, so it lives outside the item cache for the same reason
 * `repo-links.json` does: `replaceForConnection` deletes and reinserts every
 * item on each sync, and anything you wrote there would be destroyed by the
 * next refresh.
 *
 * Explicit by design. A project you are working in gets its dependencies bumped
 * as a matter of course; the one that rots is the one that was built, shipped
 * and set aside.
 */
import { realpathSync, statSync } from "node:fs";
import { DddError } from "../error";
import { isArray, isString, optional, record, required } from "../json";
import type { EnvRoot } from "../paths";
import { readJson, writeJson } from "../store";

export interface Watched {
  /** Canonical path of the checkout. The identity of the record. */
  path: string;
  /**
   * Where it is serving, if it is. **Only ever typed by the user** — never
   * inferred from GitHub's `homepage`, from DNS, or from a compose file.
   */
  url: string | null;
  note: string | null;
  addedAt: string;
}

export interface Watchlist {
  watched: Watched[];
}

export function defaultWatchlist(): Watchlist {
  return { watched: [] };
}

export function watchedFromJson(raw: unknown): Watched {
  const o = record(raw, "a watched checkout");
  return {
    path: required(o, "path", isString),
    url: optional(o, "url", isString, null as string | null),
    note: optional(o, "note", isString, null as string | null),
    addedAt: required(o, "addedAt", isString),
  };
}

export function watchlistFromJson(raw: unknown): Watchlist {
  const o = record(raw, "a watchlist");
  return { watched: optional(o, "watched", isArray, [] as unknown[]).map(watchedFromJson) };
}

export function load(env: EnvRoot): Watchlist {
  return readJson(env.watchlistFile(), watchlistFromJson, defaultWatchlist);
}

export function save(env: EnvRoot, list: Watchlist): void {
  writeJson(env.watchlistFile(), { watched: list.watched.map((w) => ({ path: w.path, url: w.url, note: w.note, addedAt: w.addedAt })) });
}

/**
 * A URL that is safe to fetch later.
 *
 * http(s) only, and a host is required. This value ends up in an outbound
 * request, so what is refused here is what can never be requested — a `file://`
 * or a bare word must not become a fetch of something local.
 */
export function validateUrl(raw: string): string {
  const url = raw.trim();
  if (url === "") throw DddError.invalid("no address given");
  const rest = url.startsWith("https://") ? url.slice(8) : url.startsWith("http://") ? url.slice(7) : null;
  if (rest === null) throw DddError.invalid(`${url} is not an http or https address`);
  const host = rest.split(/[/?#]/)[0] ?? "";
  if (host === "" || !host.includes(".")) throw DddError.invalid(`${url} has no host to reach`);
  return url;
}

/**
 * Add a checkout, or update the one already there.
 *
 * Idempotent on path: assigning a repo twice sets its URL rather than producing
 * a second row that disagrees with the first. Synchronous end to end, so the
 * read and the write cannot interleave with another command.
 */
export function add(env: EnvRoot, rawPath: string, rawUrl: string | null, note: string | null): Watchlist {
  if (!isDirectory(rawPath)) throw DddError.notFound(`${rawPath} is not a directory`);
  let path: string;
  try {
    path = realpathSync(rawPath);
  } catch (e) {
    throw DddError.io(e);
  }
  const trimmed = rawUrl === null ? null : rawUrl.trim();
  const url = trimmed === null || trimmed === "" ? null : validateUrl(trimmed);

  const list = load(env);
  const existing = list.watched.find((w) => w.path === path);
  if (existing !== undefined) {
    // A later add with no URL must not silently forget the one already
    // recorded — clearing is its own action.
    if (url !== null) existing.url = url;
    if (note !== null) existing.note = note;
  } else {
    list.watched.push({ path, url, note, addedAt: new Date().toISOString() });
  }
  save(env, list);
  return list;
}

/**
 * Stop watching. Removes the record and nothing else — the checkout on disk is
 * untouched, as it is everywhere else in DDD.
 */
export function remove(env: EnvRoot, path: string): Watchlist {
  const list = load(env);
  list.watched = list.watched.filter((w) => w.path !== path);
  save(env, list);
  return list;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
