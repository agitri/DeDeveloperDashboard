/**
 * Support schedules from endoflife.date, and the cache in front of them. Port
 * of `eol/schedule.rs`.
 *
 * **The first thing in DDD that needs the network without an account.** The
 * rules are stated here and enforced by the shape of the code:
 *
 * - One request per *product*, never per repo. Six Symfony projects are one
 *   request.
 * - Cached on disk for seven days.
 * - Offline is a normal state. The last cached answer stands and the row says
 *   how old it is.
 * - The request is `GET /api/<product>.json` and nothing else.
 */
import { DddError } from "../error";
import { isArray, isPlainRecord, isString, optional, record, required } from "../json";
import type { EnvRoot } from "../paths";
import { readJson, writeJson } from "../store";
import { statusLabel } from "../sync/adapter";
import { checksFromJson, type Checks } from "./live";
import { cycleFromApi, cycleFromJson, type Cycle } from "./status";

/**
 * How long a cached schedule is good for. Seven days against data that moves in
 * years — the cache is about being polite, not about being fresh.
 */
export const TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Only these are ever requested. An allowlist rather than "whatever a manifest
 * mentioned", so a crafted `composer.json` cannot turn this into a fetcher of
 * arbitrary URLs.
 */
export const PRODUCTS: readonly string[] = [
  "php",
  "nodejs",
  "symfony",
  "laravel",
  "python",
  "django",
  "ruby",
  "rails",
  "go",
  "rust",
  "nextjs",
  "dotnet",
];

export function isKnownProduct(product: string): boolean {
  return PRODUCTS.includes(product);
}

/** Where the schedules come from. */
export const API = "https://endoflife.date/api";

/** The URL for a product. Built from the allowlist, never from user input. */
export function urlFor(product: string): string | null {
  return urlForBase(API, product);
}

/** The same, against a given base — the seam the offline path is tested on. */
export function urlForBase(base: string, product: string): string | null {
  return isKnownProduct(product) ? `${base}/${product}.json` : null;
}

export interface Entry {
  fetchedAt: string;
  cycles: Cycle[];
}

export interface Cache {
  /** The Rust's `BTreeMap`; sorted when it is written. */
  products: Record<string, Entry>;
  /**
   * The last answer from each watched live URL, keyed by URL. Same file, same
   * reasoning: derived, and safe to delete.
   */
  live: Checks;
}

export function defaultCache(): Cache {
  return { products: {}, live: {} };
}

export function entryFromJson(raw: unknown): Entry {
  const o = record(raw, "a schedule entry");
  // `cycleFromJson`, not `cycleFromApi`: what is on disk is the tagged
  // Milestone shape that `save` wrote, not the API's bare strings.
  return { fetchedAt: required(o, "fetchedAt", isString), cycles: required(o, "cycles", isArray).map(cycleFromJson) };
}

export function cacheFromJson(raw: unknown): Cache {
  const o = record(raw, "an eol cache");
  const products: Record<string, Entry> = {};
  for (const [product, value] of Object.entries(optional(o, "products", isPlainRecord, {}))) {
    products[product] = entryFromJson(value);
  }
  return { products, live: checksFromJson(optional(o, "live", isPlainRecord, {})) };
}

export function load(env: EnvRoot): Cache {
  return readJson(env.eolCacheFile(), cacheFromJson, defaultCache);
}

export function save(env: EnvRoot, cache: Cache): void {
  writeJson(env.eolCacheFile(), forDisk(cache));
}

/** Byte-wise, like Rust's `String::cmp`, which is what a `BTreeMap` sorts by. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Field order and key order as the Rust's serde would write them. */
function forDisk(cache: Cache): unknown {
  const products: Record<string, unknown> = {};
  for (const product of Object.keys(cache.products).sort(byteCompare)) {
    const entry = cache.products[product]!;
    products[product] = {
      fetchedAt: entry.fetchedAt,
      cycles: entry.cycles.map((c) => ({ cycle: c.cycle, support: c.support, eol: c.eol, latest: c.latest })),
    };
  }
  const live: Record<string, unknown> = {};
  for (const url of Object.keys(cache.live).sort(byteCompare)) {
    const checked = cache.live[url]!;
    live[url] = { at: checked.at, liveness: checked.liveness };
  }
  return { products, live };
}

/**
 * Whether this entry still counts as current.
 *
 * Pure, and takes `now` rather than reading a clock, so the TTL is a test.
 */
export function isFresh(entry: Entry, now: string): boolean {
  const fetched = instant(entry.fetchedAt);
  const then = instant(now);
  // An unreadable timestamp means we cannot claim it is fresh. Refetching is
  // the safe direction; the stale data still stands if that fails.
  if (fetched === null || then === null) return false;
  const age = Math.trunc((then - fetched) / 1000);
  return age >= 0 && age < TTL_SECONDS;
}

/** How old an entry is, in whole days, for the "as of" line on the widget. */
export function ageDays(entry: Entry, now: string): number | null {
  const fetched = instant(entry.fetchedAt);
  const then = instant(now);
  if (fetched === null || then === null) return null;
  return Math.trunc((then - fetched) / 86_400_000);
}

/**
 * Fetch the products that are stale or missing, and leave everything else
 * alone.
 *
 * **A failed fetch never empties an entry.** Offline with week-old dates is a
 * working widget; offline with no dates is a broken one.
 */
export async function refresh(fetch: typeof globalThis.fetch, cache: Cache, wanted: string[], now: string): Promise<string[]> {
  return refreshFrom(API, fetch, cache, wanted, now);
}

export async function refreshFrom(
  base: string,
  fetch: typeof globalThis.fetch,
  cache: Cache,
  wanted: string[],
  now: string,
): Promise<string[]> {
  const failed: string[] = [];
  for (const product of wanted) {
    if (!isKnownProduct(product)) continue;
    const existing = cache.products[product];
    if (existing !== undefined && isFresh(existing, now)) continue;
    const url = urlForBase(base, product);
    if (url === null) continue;
    let cycles: Cycle[] | null;
    try {
      cycles = await fetchOne(fetch, url);
    } catch {
      cycles = null;
    }
    if (cycles !== null && cycles.length > 0) {
      cache.products[product] = { fetchedAt: now, cycles };
    } else {
      // Including an empty list: a product that answers with nothing has told
      // us nothing, and overwriting good data with it would be a loss rather
      // than an update.
      failed.push(product);
    }
  }
  return failed;
}

export async function fetchOne(fetch: typeof globalThis.fetch, url: string): Promise<Cycle[]> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        // Named rather than anonymous: a free service is owed the ability to
        // see who is calling it and block us if we misbehave.
        "User-Agent": "DDD-dashboard (https://github.com/agitri/ddd)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw DddError.invalid(`could not reach endoflife.date: ${message(e)}`);
  }
  if (!response.ok) throw DddError.invalid(`endoflife.date answered ${statusLabel(response)}`);
  try {
    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) throw DddError.json("invalid type: expected a sequence");
    return raw.map(cycleFromApi);
  } catch (e) {
    throw DddError.invalid(`unreadable schedule: ${message(e)}`);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `chrono::DateTime::parse_from_rfc3339` — an offset is required. */
function instant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
