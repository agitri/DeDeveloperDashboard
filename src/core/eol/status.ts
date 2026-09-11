/**
 * Dates in, verdict out. Port of `eol/status.rs`.
 *
 * Pure, and takes today as an argument rather than reading a clock, so every
 * boundary below is a test rather than a thing that will be true again next
 * year.
 */
import { DddError } from "../error";
import { isString, optional, record, required } from "../json";

/**
 * How far ahead "ending soon" looks. Long enough to plan an upgrade, short
 * enough not to cry wolf about a date two years out.
 */
export const HORIZON_DAYS = 90;

/** The Rust's `#[serde(tag = "state", content = "days")]`. */
export type Support =
  | { state: "active" }
  | { state: "securityOnly" }
  | { state: "endingSoon"; days: number }
  | { state: "ended" }
  | { state: "unknown" };

/** Worst first. The ordering the board is sorted by. */
export function severity(support: Support): number {
  switch (support.state) {
    case "ended":
      return 4;
    case "endingSoon":
      return 3;
    case "securityOnly":
      return 2;
    case "active":
      return 1;
    case "unknown":
      return 0;
  }
}

/**
 * A support milestone: a date, or a plain yes/no about whether it has been
 * reached.
 *
 * endoflife.date answers each field's own question, which means the two
 * booleans have **opposite polarity** and reading them uniformly gets real
 * cycles backwards:
 *
 * - `"eol": true` — is it end-of-life? yes. Reached.
 * - `"eol": false` — no, not yet. (Next.js 16, Go 1.27 today.)
 * - `"support": false` — is it in active support? no. Reached.
 * - `"support": true` — yes, still is.
 *
 * All four appear in live responses, which is how this was found.
 */
export type Milestone =
  | { kind: "date"; date: string }
  /** Already happened. */
  | { kind: "reached" }
  /** Not yet, and no date published for when. */
  | { kind: "pending" }
  /** The field is absent. Not evidence of anything. */
  | { kind: "absent" };

export function milestoneDate(m: Milestone): string | null {
  return m.kind === "date" ? m.date : null;
}

/** One release line, as endoflife.date describes it. */
export interface Cycle {
  /** `"8.0"`, `"24"`. Some products return this as a number. */
  cycle: string;
  /** When active support ends, or whether it has. */
  support: Milestone;
  /** When security support ends, or whether it has. The one that matters. */
  eol: Milestone;
  latest: string | null;
}

/** `Cycle::default()`. */
export function defaultCycle(): Cycle {
  return { cycle: "", support: { kind: "absent" }, eol: { kind: "absent" }, latest: null };
}

/** `Value::String | Value::Number` → text; anything else → null. */
function text(v: unknown): string | null {
  if (typeof v === "string") return v;
  // `serde_json::Number::to_string`. JSON.parse collapses `8.0` to `8`, which
  // the Rust would render as "8.0" — no product publishes a fractional cycle
  // that way, and every observed numeric `cycle` is an integer.
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * `true` means the field's own question is answered yes: for `eol`,
 * yes-it-is-EOL; for `support`, yes-it-is-still-supported.
 */
function milestone(v: unknown, trueMeansReached: boolean): Milestone {
  if (typeof v === "string" && v !== "") return { kind: "date", date: v };
  if (typeof v === "boolean") return v === trueMeansReached ? { kind: "reached" } : { kind: "pending" };
  return { kind: "absent" };
}

/**
 * The endoflife.date API shape. Port of the Rust's hand-written
 * `impl Deserialize for Cycle`: a cycle may arrive as a number, and the two
 * booleans have opposite polarity.
 */
export function cycleFromApi(raw: unknown): Cycle {
  const o = record(raw, "a cycle");
  return {
    cycle: text(o["cycle"]) ?? "",
    support: milestone(o["support"], false),
    eol: milestone(o["eol"], true),
    latest: text(o["latest"]),
  };
}

function milestoneFromJson(raw: unknown, field: string): Milestone {
  if (raw === undefined || raw === null) return { kind: "absent" };
  const o = record(raw, "a milestone");
  const kind = required(o, "kind", isString);
  switch (kind) {
    case "date":
      return { kind: "date", date: required(o, "date", isString) };
    case "reached":
      return { kind: "reached" };
    case "pending":
      return { kind: "pending" };
    case "absent":
      return { kind: "absent" };
    default:
      throw DddError.json(`invalid type for field \`${field}\``);
  }
}

/**
 * The *on-disk* shape, which is what `eol-cache.json` holds: `Milestone` is
 * serialised adjacently tagged (`{"kind":"date","date":"…"}`), not as the API's
 * bare string. The Rust has only the API decoder and so reads its own cache
 * back with every milestone flattened to `absent`; this is the second decoder
 * that fixes that, and `schedule.load` uses it.
 */
export function cycleFromJson(raw: unknown): Cycle {
  const o = record(raw, "a cycle");
  return {
    cycle: required(o, "cycle", isString),
    support: milestoneFromJson(o["support"], "support"),
    eol: milestoneFromJson(o["eol"], "eol"),
    latest: optional(o, "latest", isString, null as string | null),
  };
}

/**
 * The verdict for one cycle, on one day.
 *
 * **A date that is today is past.** Support that ends today is not support you
 * have — and picking the other convention would mean the widget goes quiet on
 * exactly the day it should speak up.
 */
export function supportOn(cycle: Cycle, today: string): Support {
  // Security support first: once it is gone, nothing else about the cycle
  // changes the answer.
  if (cycle.eol.kind === "reached") return { state: "ended" };
  if (cycle.eol.kind === "date") {
    if (cycle.eol.date <= today) return { state: "ended" };
    const days = daysBetween(today, cycle.eol.date);
    if (days !== null && days <= HORIZON_DAYS) return { state: "endingSoon", days };
  }

  switch (cycle.support.kind) {
    // Active support gone, security support still running: a real state, and
    // the one most long-lived projects are actually in.
    case "reached":
      return { state: "securityOnly" };
    case "date": {
      if (cycle.support.date <= today) return { state: "securityOnly" };
      // Active support ending inside the horizon is worth the same warning as
      // security support ending: it is when the upgrade window opens.
      const days = daysBetween(today, cycle.support.date);
      return days !== null && days <= HORIZON_DAYS ? { state: "endingSoon", days } : { state: "active" };
    }
    // No date for the end of active support, and security support has not
    // ended: a current release. `absent` on both is the only case where
    // nothing at all is known.
    case "pending":
      return { state: "active" };
    case "absent":
      return cycle.eol.kind === "absent" ? { state: "unknown" } : { state: "active" };
  }
}

/**
 * Find a cycle by name. Exact match only: `8.0` is not `8`, and treating them
 * as the same is how a widget confidently reports the wrong date.
 */
export function find(cycles: Cycle[], wanted: string): Cycle | null {
  return cycles.find((c) => c.cycle === wanted) ?? null;
}

/** Whole days from one ISO date to another. `null` if either is not a date. */
export function daysBetween(from: string, to: string): number | null {
  const a = parseDate(from);
  const b = parseDate(to);
  if (a === null || b === null) return null;
  return Math.trunc((b - a) / 86_400_000);
}

/** `chrono::NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d")` — strict. */
function parseDate(value: string): number | null {
  const head = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) return null;
  const year = Number(head.slice(0, 4));
  const month = Number(head.slice(5, 7));
  const day = Number(head.slice(8, 10));
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  // `Date.UTC` rolls `2026-13-45` over; chrono rejects it, so reject it here.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return ms;
}
