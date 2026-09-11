/**
 * Is the thing at that URL still answering? Port of `eol/live.rs`.
 *
 * This is not an uptime checker and must not become one. It answers one
 * question, at the cadence of the support data — which is slow on purpose —
 * because "unsupported runtime, still serving traffic" is a different problem
 * from "unsupported runtime in a folder", and the board ranks accordingly.
 *
 * The same honesty rule as the dev server board: **a timeout is not "down"**.
 */
import { DddError } from "../error";
import { isNumber, isString, record, required } from "../json";
import { validateUrl } from "./watchlist";

/**
 * How long a liveness answer is good for. Once an hour per URL: enough to be
 * current on a board you glance at, restrained enough not to be traffic on
 * someone else's server.
 */
export const TTL_SECONDS = 60 * 60;

/** The Rust's `#[serde(tag = "state", content = "detail")]`. */
export type Liveness =
  /** It answered, with this status code. A 403 from a server means a server is there. */
  | { state: "answering"; detail: number }
  /** Nothing came back in time. **Not** "down" — see the module note. */
  | { state: "noAnswer"; detail: string }
  /** The connection was refused, or the name does not resolve. This is the one that means gone. */
  | { state: "unreachable"; detail: string };

export function isServing(liveness: Liveness): boolean {
  return liveness.state === "answering";
}

export interface Checked {
  at: string;
  liveness: Liveness;
}

/** The Rust's `BTreeMap<String, Checked>`; sorted when it is written. */
export type Checks = Record<string, Checked>;

function livenessFromJson(raw: unknown): Liveness {
  const o = record(raw, "a liveness");
  const state = required(o, "state", isString);
  switch (state) {
    case "answering":
      return { state: "answering", detail: required(o, "detail", isNumber) };
    case "noAnswer":
      return { state: "noAnswer", detail: required(o, "detail", isString) };
    case "unreachable":
      return { state: "unreachable", detail: required(o, "detail", isString) };
    default:
      throw DddError.json("invalid type for field `state`");
  }
}

export function checkedFromJson(raw: unknown): Checked {
  const o = record(raw, "a check");
  return { at: required(o, "at", isString), liveness: livenessFromJson(o["liveness"]) };
}

export function checksFromJson(raw: unknown): Checks {
  const o = record(raw, "the checks");
  const out: Checks = {};
  for (const [url, value] of Object.entries(o)) out[url] = checkedFromJson(value);
  return out;
}

export function isFresh(checked: Checked, now: string): boolean {
  const at = instant(checked.at);
  const then = instant(now);
  if (at === null || then === null) return false;
  const age = Math.trunc((then - at) / 1000);
  return age >= 0 && age < TTL_SECONDS;
}

/**
 * Turn a request outcome into a verdict.
 *
 * Pure, and separated from the request precisely so the rule that matters —
 * that a timeout is never `unreachable` — is testable without a network.
 */
export function classify(status: number | null, timedOut: boolean, error: string | null): Liveness {
  if (status !== null) return { state: "answering", detail: status };
  if (timedOut) return { state: "noAnswer", detail: "no reply within the deadline" };
  return { state: "unreachable", detail: error ?? "could not connect" };
}

/** Check one URL with a `HEAD`. Any answer at all is an answer. */
export async function check(fetch: typeof globalThis.fetch, url: string): Promise<Liveness> {
  // Validated again here rather than trusted: this is the last point before an
  // outbound request, and the check is cheap.
  try {
    validateUrl(url);
  } catch {
    return { state: "unreachable", detail: "not an http address" };
  }
  try {
    const response = await fetch(url, {
      method: "HEAD",
      // Named rather than anonymous.
      headers: { "User-Agent": "DDD-dashboard (support watch)" },
      signal: AbortSignal.timeout(8_000),
    });
    return classify(response.status, false, null);
  } catch (e) {
    return classify(null, isTimeout(e), short(e));
  }
}

/** Reqwest's `Error::is_timeout`: `AbortSignal.timeout` aborts with this name. */
function isTimeout(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "TimeoutError";
}

export function short(e: unknown): string {
  // The error's text includes the whole URL and a chain; the row has room for a
  // reason, not a stack. A naive split on the first `:` would truncate inside
  // the URL itself (`https:`) for reqwest's own connect-error wrapper
  // (`error sending request for url (…): <cause>`), so that shape is
  // recognised and cut after its closing paren instead; anything else falls
  // back to the naive split.
  const message = e instanceof Error ? e.message : String(e);
  const prefix = "error sending request for url (";
  if (message.startsWith(prefix)) {
    const closeParen = message.indexOf(")", prefix.length);
    if (closeParen !== -1) return `${message.slice(0, closeParen + 1)} `;
  }
  return message.split(":")[0] ?? "could not connect";
}

/** Refresh the URLs whose last answer is stale, leaving the rest alone. */
export async function refresh(
  fetch: typeof globalThis.fetch,
  checks: Checks,
  urls: string[],
  now: string,
): Promise<void> {
  for (const url of urls) {
    const existing = checks[url];
    if (existing !== undefined && isFresh(existing, now)) continue;
    const liveness = await check(fetch, url);
    checks[url] = { at: now, liveness };
  }
}

/** `chrono::DateTime::parse_from_rfc3339` — an offset is required. */
function instant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
