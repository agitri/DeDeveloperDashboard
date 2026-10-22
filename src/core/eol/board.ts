/**
 * The EOL watcher: what you shipped and stopped looking at. Port of
 * `eol/mod.rs`.
 *
 * Four pieces, joined here and nowhere else — the watchlist you wrote, the
 * declarations read off each checkout, the support schedules fetched once per
 * product, and a verdict per declaration.
 *
 * The join is pure over its inputs, so the ranking rule that decides what you
 * see first is a test rather than a thing you have to run the app to check.
 */
import { statSync } from "node:fs";
import type { Confidence, Declaration } from "./detect";
import type { Checks, Liveness } from "./live";
import { ageDays, isKnownProduct, type Cache } from "./schedule";
import { find, milestoneDate, severity, supportOn, type Support } from "./status";
import type { Watched } from "./watchlist";

/** What `detect.forDir` produced for each watched path, in watchlist order. */
export type Declarations = [string, Declaration[]][];

/** One declaration with its verdict attached. Field order is the Rust struct's. */
export interface Finding {
  product: string;
  /** Other files that said the same thing. Omitted when empty, as the Rust's
   *  `skip_serializing_if = "Vec::is_empty"` does. */
  also?: string[];
  cycle: string;
  source: string;
  confidence: Confidence;
  raw: string;
  support: Support;
  /** When security support ends, when that is known. */
  eolDate: string | null;
  /** When active support ends. */
  supportDate: string | null;
  /** The newest release of this line. Shown only when the newest-version lens
   *  is on — "Symfony 8.1 exists" is noise when you are on the 7.4 LTS. */
  latest: string | null;
  /** How old the schedule this verdict came from is, in days. */
  scheduleAgeDays: number | null;
}

export interface Row {
  path: string;
  name: string;
  url: string | null;
  note: string | null;
  /** The checkout is not on disk any more. Kept and marked: a watched thing
   *  disappearing is information, not a reason to drop the row. */
  missing: boolean;
  /** None of the files in `detect.FILES` were found. Distinct from healthy. */
  unreadable: boolean;
  /** What the live URL answered, when there is one and it has been checked. */
  live: Liveness | null;
  findings: Finding[];
  /** The worst verdict among the findings — what the row is sorted by. */
  worst: Support;
}

export interface Board {
  rows: Row[];
  /** Products whose schedule could not be refreshed this cycle. The rows still
   *  carry their last known dates. */
  stale: string[];
}

/**
 * Build the board.
 *
 * Rows are ordered by consequence: an unsupported runtime serving traffic is a
 * different problem from an unsupported runtime sitting in a folder, so a live
 * URL promotes a row rather than merely decorating it.
 */
export function build(
  watched: Watched[],
  declarations: Declarations,
  cache: Cache,
  checks: Checks,
  today: string,
  now: string,
  stale: string[],
): Board {
  const rows: Row[] = watched.map((w) => {
    const pair = declarations.find(([path]) => path === w.path);
    const found = pair === undefined ? [] : pair[1];
    const missing = !isDirectory(w.path);

    const findings: Finding[] = found.map((d) => {
      const entry = cache.products[d.product];
      const cycle = entry === undefined ? null : find(entry.cycles, d.cycle);
      return {
        product: d.product,
        // Where the Rust's `skip_serializing_if` fires.
        ...(d.also.length > 0 ? { also: [...d.also] } : {}),
        cycle: d.cycle,
        source: d.source,
        confidence: d.confidence,
        raw: d.raw,
        // No schedule means no verdict. A cycle the API has never heard of is
        // unknown, never ended — that would be the worst possible way to be
        // wrong.
        support: cycle === null ? { state: "unknown" } : supportOn(cycle, today),
        // Only ever a real date. "Reached" and "pending" are verdicts, and the
        // verdict already carries them.
        eolDate: cycle === null ? null : milestoneDate(cycle.eol),
        supportDate: cycle === null ? null : milestoneDate(cycle.support),
        latest: cycle === null ? null : cycle.latest,
        scheduleAgeDays: entry === undefined ? null : ageDays(entry, now),
      };
    });

    return {
      path: w.path,
      name: leaf(w.path),
      url: w.url,
      note: w.note,
      missing,
      unreadable: found.length === 0 && !missing,
      live: w.url === null ? null : (checks[w.url]?.liveness ?? null),
      findings,
      worst: worstOf(findings),
    };
  });

  // Severity first, then whether it is serving traffic. A live row and a
  // dormant one with the same verdict are not the same problem.
  rows.sort((a, b) => rank(b) - rank(a) || byteCompare(a.name, b.name));
  return { rows, stale };
}

/** Rust's `max_by_key` keeps the LAST of equal maxima, hence `>=`. */
function worstOf(findings: Finding[]): Support {
  let worst: Support | null = null;
  for (const f of findings) {
    if (worst === null || severity(f.support) >= severity(worst)) worst = f.support;
  }
  return worst ?? { state: "unknown" };
}

/**
 * Severity, doubled, plus one for a live URL.
 *
 * So live-and-ended beats ended, and ended still beats ending-soon-and-live — a
 * dead runtime in a folder is worse than one that merely expires in a month,
 * however loudly the latter is serving.
 */
export function rank(row: Row): number {
  // A URL that has been checked and found unreachable does not promote: it is
  // no longer serving anything, so it is back to being a folder. An unchecked
  // URL still promotes — the user said it was live, and not having asked yet is
  // not evidence against them.
  const serving = row.live !== null && row.live.state === "unreachable" ? false : row.url !== null;
  return severity(row.worst) * 2 + (serving ? 1 : 0);
}

/** Every live URL on the watchlist. The check list. */
export function urlsToCheck(watched: Watched[]): string[] {
  return watched.flatMap((w) => (w.url === null ? [] : [w.url]));
}

/** Every product any watched repo declares, deduplicated — the fetch list. */
export function productsNeeded(declarations: Declarations): string[] {
  const products = declarations.flatMap(([, ds]) => ds.map((d) => d.product)).filter(isKnownProduct);
  products.sort(byteCompare);
  // Rust's `dedup`: adjacent only, which after the sort is a full dedupe.
  return products.filter((p, i) => i === 0 || products[i - 1] !== p);
}

function leaf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Byte-wise, like Rust's `String::cmp`. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
