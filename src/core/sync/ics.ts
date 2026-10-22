/**
 * Subscribed calendars: one `.ics` URL in, normalized `Item`s out. Port of
 * `sync/ics.rs`.
 *
 * Apple publishes nothing by itself, but Calendar.app will publish a single
 * calendar on request (Share Calendar → Public Calendar), yielding a
 * `webcal://…/published/2/…` URL that serves plain iCalendar. Google's "secret
 * address in iCal format" and most work calendars have the same shape, so this
 * one adapter covers all of them.
 *
 * Reading `~/Library/Calendars` directly was considered and rejected: it is
 * TCC-protected and would need Full Disk Access, a heavier and more fragile
 * ask than a URL.
 *
 * The URL *is* the secret — anyone holding it can read the calendar — so it
 * lives in the keychain and arrives here as `FetchContext.token`, which is why
 * this adapter needs no new plumbing.
 *
 * The time helpers at the top are exported because `calendar/expand.ts` needs
 * exactly the same local↔UTC rule; duplicating them is how two parsers of the
 * same feed end up an hour apart.
 */
import { DddError } from "../error";
import type { Item } from "../models";
import { itemId, refuse, statusLabel, type ActionRequest, type FetchContext, type SourceAdapter } from "./adapter";

/** A calendar feed that does not fit in memory is not a calendar feed. */
const MAX_BYTES = 8 * 1024 * 1024;
/** The Rust's shared reqwest client is built with a 30 s timeout (`lib.rs`). */
const TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// --- RFC 3339 and time zones ---------------------------------------------------

/** chrono omits the fractional part when it is zero; `toISOString()` always
 *  writes three digits. Everything on a calendar is whole seconds, so strip
 *  the `.000` and the two apps produce byte-identical timestamps. */
export function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.000Z$/, "Z");
}

const ZONES = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = ZONES.get(tz);
  if (f === undefined) {
    // `hourCycle: "h23"` so midnight is 00, not 24.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    ZONES.set(tz, f);
  }
  return f;
}

/** `"Europe/Amsterdam".parse::<chrono_tz::Tz>().is_ok()` — Intl throws a
 *  RangeError for a name no zone database has. */
export function isKnownZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading `instant` has in `tz`, as milliseconds whose *UTC*
 *  fields carry those local Y/M/D h:m:s. Never a real instant. */
export function utcToZoned(instant: Date, tz: string): number {
  if (tz === "UTC") return instant.getTime();
  const parts: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(instant)) parts[part.type] = part.value;
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Defensive: some ICU builds still render midnight as 24.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
}

/** The inverse: the real instant whose `tz` wall clock is `wall`. */
export function zonedToUtc(wall: number, tz: string): number {
  if (tz === "UTC") return wall;
  const offsetAt = (t: number) => utcToZoned(new Date(t), tz) - t;
  // A day either side brackets every real transition; a candidate that reads
  // back as the same wall clock is a real instant.
  const candidates = [wall - offsetAt(wall - DAY_MS), wall - offsetAt(wall + DAY_MS)].filter((t) => utcToZoned(new Date(t), tz) === wall);
  // An ambiguous local time (the hour that repeats when DST ends) resolves to
  // the earlier instant rather than being dropped, as chrono's `.earliest()`
  // does.
  if (candidates.length > 0) return Math.min(...candidates);
  // A local time that does not exist (the hour skipped when DST starts).
  // chrono's `.earliest()` is None there and the Rust drops the value; this
  // port keeps the event and lands it at the first instant that does exist,
  // because losing a meeting is worse than moving it by an hour. The only
  // deliberate divergence in this file.
  return wall - offsetAt(wall + DAY_MS);
}

// --- the adapter ---------------------------------------------------------------

export class IcsAdapter implements SourceAdapter {
  readonly source = "calendar.ics";

  async fetch(cx: FetchContext): Promise<Item[]> {
    const url = normalizeUrl(cx.token);
    let response: Response;
    try {
      response = await cx.fetch(url, {
        method: "GET",
        headers: { Accept: "text/calendar, text/plain" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw DddError.config(`${cx.connection.label}: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!response.ok) {
      throw DddError.config(`${cx.connection.label} returned ${statusLabel(response)}`);
    }

    let body: ArrayBuffer;
    try {
      body = await response.arrayBuffer();
    } catch (e) {
      throw DddError.config(`${cx.connection.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Byte length, as the Rust's `body.len()` is.
    if (body.byteLength > MAX_BYTES) {
      throw DddError.config(`${cx.connection.label} sent ${body.byteLength} bytes, over the ${MAX_BYTES} cap`);
    }

    // `String::from_utf8_lossy`: invalid bytes become U+FFFD, never an error.
    const text = new TextDecoder("utf-8").decode(body);
    if (!text.includes("BEGIN:VCALENDAR")) {
      throw DddError.config(`${cx.connection.label} did not return an iCalendar feed`);
    }

    return toItems(text, cx.connection.id, cx.environmentId);
  }

  /** The trait default in `sync/adapter.rs`: a subscribed feed is read-only. */
  async perform(_cx: FetchContext, request: ActionRequest): Promise<string> {
    return refuse(this.source, request.action);
  }
}

/**
 * `webcal://` is the same feed over https; anything else that could reach the
 * filesystem or another protocol is refused before a request is made, because
 * this string came from the user and turns into outbound traffic.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  const rewritten =
    trimmed.startsWith("webcal://") ? `https://${trimmed.slice("webcal://".length)}`
    : trimmed.startsWith("webcals://") ? `https://${trimmed.slice("webcals://".length)}`
    : trimmed;

  const lower = rewritten.toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://")) return rewritten;
  throw DddError.config("a calendar URL must be webcal://, https:// or http://");
}

/**
 * One `Item` per `VEVENT`. A `VEVENT` that cannot be understood is skipped,
 * never fatal: one broken entry in a shared work calendar must not cost you
 * the other three hundred.
 */
export function toItems(ics: string, connectionId: string, environmentId: string): Item[] {
  const lines = unfold(ics);
  let calendarName = "";
  for (const line of lines) {
    const value = property(line, "X-WR-CALNAME");
    if (value !== null) {
      calendarName = value;
      break;
    }
  }

  const items: Item[] = [];
  let block: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      block = [];
    } else if (line.startsWith("END:VEVENT")) {
      if (block !== null) {
        const fields = block;
        block = null;
        const item = toItem(fields, connectionId, environmentId, calendarName);
        if (item !== null) items.push(item);
      }
    } else if (block !== null) {
      block.push(line);
    }
  }

  return items;
}

function toItem(fields: string[], connectionId: string, environmentId: string, calendarName: string): Item | null {
  const uid = find(fields, "UID");
  if (uid === null) return null;
  const started = findTime(fields, "DTSTART");
  if (started === null) return null;
  const [start, startTz, allDay] = started;

  // No DTEND is legal: DURATION may say, and an all-day event without either
  // is one day long. Guessing 30 minutes would put the wrong block on screen.
  const dtend = findTime(fields, "DTEND");
  const duration = find(fields, "DURATION");
  const end =
    dtend !== null ?
      dtend[0]
    : ((duration === null ? null : addDuration(start, duration)) ?? new Date(start.getTime() + (allDay ? DAY_MS : HOUR_MS)));

  const refs = [`dtstart:${rfc3339(start)}`, `dtend:${rfc3339(end)}`, `allday:${allDay}`];
  if (startTz !== null) refs.push(`tzid:${startTz}`);
  const rule = find(fields, "RRULE");
  if (rule !== null) refs.push(`rrule:${rule}`);
  for (const line of fields.filter((l) => l.startsWith("EXDATE"))) {
    // EXDATE can carry a comma-separated list on one line.
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    for (const one of line.slice(colon + 1).split(",")) {
      const at = parseTime(one.trim(), null);
      if (at !== null) refs.push(`exdate:${rfc3339(at[0])}`);
    }
  }
  const recurrence = findTime(fields, "RECURRENCE-ID");
  if (recurrence !== null) {
    refs.push(`recurrenceid:${rfc3339(recurrence[0])}`);
    refs.push(`series:${uid}`);
  }
  const location = find(fields, "LOCATION");
  if (location !== null) refs.push(`location:${unescape(location)}`);
  if (calendarName !== "") {
    // The feed's own name, so the legend can say "Work" rather than repeating
    // the connection label the user typed.
    refs.push(`calendar:${unescape(calendarName)}`);
  }

  const rawRecurrenceId = find(fields, "RECURRENCE-ID");
  const summary = find(fields, "SUMMARY");
  const description = find(fields, "DESCRIPTION");

  return {
    // A recurrence override shares its series' UID, so the id must include the
    // instance or the override would replace the series in the cache.
    id: itemId(connectionId, rawRecurrenceId === null ? uid : `${uid}#${rawRecurrenceId}`),
    environmentId,
    connectionId,
    source: "calendar.ics",
    kind: "event",
    project: null,
    title: summary === null ? "(no title)" : unescape(summary),
    body: description === null ? null : unescape(description),
    url: find(fields, "URL"),
    refs,
    actions: [],
    updatedAt: rfc3339(start),
    unread: false,
  };
}

/**
 * iCalendar folds long lines by continuing them on the next, prefixed with a
 * space or tab. Every parser that forgets this loses the tail of long
 * descriptions and, worse, of long RRULEs.
 */
export function unfold(ics: string): string[] {
  const out: string[] = [];
  for (const raw of ics.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** The value of `NAME` or `NAME;PARAMS`, ignoring case in the name. */
export function property(line: string, name: string): string | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const key = line.slice(0, colon).split(";")[0]!;
  return key.toLowerCase() === name.toLowerCase() ? line.slice(colon + 1) : null;
}

function find(fields: string[], name: string): string | null {
  for (const line of fields) {
    const value = property(line, name);
    if (value !== null) return value;
  }
  return null;
}

function findTime(fields: string[], name: string): [Date, string | null, boolean] | null {
  const line = fields.find((l) => {
    const colon = l.indexOf(":");
    return colon >= 0 && l.slice(0, colon).split(";")[0]!.toLowerCase() === name.toLowerCase();
  });
  if (line === undefined) return null;
  const colon = line.indexOf(":");
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  let tzid: string | null = null;
  for (const param of head.split(";")) {
    if (param.startsWith("TZID=")) {
      tzid = param.slice("TZID=".length);
      break;
    }
  }
  // `head.contains("VALUE=DATE")` in the Rust, so `VALUE=DATE-TIME` also reads
  // as all-day. Ported as-is rather than fixed, so both apps agree.
  const isDate = head.includes("VALUE=DATE");
  const parsed = parseTime(value, tzid);
  if (parsed === null) return null;
  return [parsed[0], tzid, parsed[1] || isDate];
}

/** `20260819T090000Z`, `20260819T090000` (in TZID), or `20260819` (all-day).
 *  Returns `[instant, allDay]`. */
export function parseTime(value: string, tzid: string | null): [Date, boolean] | null {
  const trimmed = value.trim();

  if (trimmed.endsWith("Z")) {
    const at = naiveDateTime(trimmed.slice(0, -1));
    return at === null ? null : [new Date(at), false];
  }

  const naive = naiveDateTime(trimmed);
  if (naive !== null) {
    // An ambiguous local time resolves to the earlier instant; an unknown zone
    // reads the naive time as UTC, exactly as the Rust's `tzid.and_then(...)`
    // falling through to `None` does.
    const zone = tzid !== null && isKnownZone(tzid) ? tzid : null;
    return [new Date(zone === null ? naive : zonedToUtc(naive, zone)), false];
  }

  // All-day: kept at UTC midnight and never shifted by a zone, or it renders on
  // the day before for anyone west of the meridian.
  const date = naiveDate(trimmed);
  return date === null ? null : [new Date(date), true];
}

/** chrono's `%Y%m%dT%H%M%S`: exact, and it rejects an impossible date. */
function naiveDateTime(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (m === null) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const at = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(at);
  const round =
    back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day &&
    back.getUTCHours() === hour &&
    back.getUTCMinutes() === minute &&
    back.getUTCSeconds() === second;
  return round ? at : null;
}

function naiveDate(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (m === null) return null;
  const [year, month, day] = m.slice(1).map(Number) as [number, number, number];
  const at = Date.UTC(year, month - 1, day);
  const back = new Date(at);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? at : null;
}

export function addDuration(start: Date, spec: string): Date | null {
  // A subset of ISO 8601 durations: what calendars actually emit.
  const seconds = durationSeconds(spec);
  return seconds === null ? null : new Date(start.getTime() + seconds * 1000);
}

/** `PT1H30M`, `P2D`, `PT45M` → seconds. Returns `null` for anything else, which
 *  falls back to the default duration rather than inventing a length. */
function durationSeconds(spec: string): number | null {
  const body = spec.trim();
  if (!body.startsWith("P")) return null;
  const rest = body.slice(1);
  const t = rest.indexOf("T");
  const daysPart = t < 0 ? rest : rest.slice(0, t);
  const timePart = t < 0 ? "" : rest.slice(t + 1);

  let seconds = 0;
  // One accumulator across both loops, as the Rust has: `P2` leaves "2"
  // unconsumed and the duration reads as zero rather than as two of anything.
  let number = "";
  const take = (): number | null => {
    if (number === "") return null;
    const n = Number(number);
    number = "";
    return Number.isSafeInteger(n) ? n : null;
  };

  for (const c of daysPart) {
    if (c >= "0" && c <= "9") {
      number += c;
      continue;
    }
    const n = take();
    if (n === null) return null;
    if (c === "D") seconds += n * 86_400;
    else if (c === "W") seconds += n * 604_800;
    else return null;
  }
  for (const c of timePart) {
    if (c >= "0" && c <= "9") {
      number += c;
      continue;
    }
    const n = take();
    if (n === null) return null;
    if (c === "H") seconds += n * 3_600;
    else if (c === "M") seconds += n * 60;
    else if (c === "S") seconds += n;
    else return null;
  }
  return seconds;
}

/** iCalendar escapes commas, semicolons and newlines in text values. */
export function unescape(value: string): string {
  return value.replaceAll("\\n", "\n").replaceAll("\\N", "\n").replaceAll("\\,", ",").replaceAll("\\;", ";").replaceAll("\\\\", "\\");
}
