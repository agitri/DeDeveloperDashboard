/**
 * Turning recurrence rules into the occurrences a window actually contains.
 * Port of `calendar/expand.rs`.
 *
 * Expansion happens here, on read, never at sync time. A `FREQ=WEEKLY` event
 * with no `UNTIL` has infinitely many occurrences, so materialising them into
 * the item cache is not an option — one stored event carries the rule, and the
 * read path asks it for the window on screen.
 *
 * Pure: no I/O, no clock. Everything it needs arrives as arguments, which is
 * what makes recurrence — the part most likely to be subtly wrong — testable.
 */
import { rrulestr } from "rrule";
import { isKnownZone, rfc3339, utcToZoned, zonedToUtc } from "../sync/ics";

/** The longest window one call will expand. A UI bug asking for the year 3000
 *  must cost a clamp, not a hang. */
export const MAX_WINDOW_DAYS = 366;
/** Per-event ceiling handed to the rrule iterator. */
export const MAX_OCCURRENCES = 1000;

const DAY_MS = 86_400_000;

/** One stored event: a single `VEVENT`, or one of your own. */
export interface EventSpec {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** IANA name from the source's `TZID`. Expansion runs in this zone so a
   *  09:00 meeting stays 09:00 across a DST boundary. */
  tzid: string | null;
  rrule: string | null;
  exdates: Date[];
  /** Set when this `VEVENT` is a `RECURRENCE-ID` override of another event. */
  overrides: Override | null;
  calendar: string;
  color: string;
  /** Only your own events. A subscribed feed is read-only and the UI must say
   *  so rather than offering an edit the next sync silently reverts. */
  editable: boolean;
  location: string | null;
  url: string | null;
}

export interface Override {
  /** The item id of the series this replaces an instance of. */
  seriesId: string;
  /** Which instance, by its original start. */
  recurrenceId: Date;
}

/** Serialize-only in the Rust, so the shape lives here rather than being
 *  imported from the renderer. */
export interface Occurrence {
  /** Event id plus this occurrence's start: stable across refreshes, and
   *  distinct per instance of a recurring event. */
  id: string;
  title: string;
  /** RFC 3339, UTC — what serde makes of the Rust's `DateTime<Utc>`. */
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
  color: string;
  editable: boolean;
  location: string | null;
  url: string | null;
  /** The rule could not be expanded, so this is the series' first instance
   *  standing in for all of them. Surfaced, never silently wrong. */
  recurringUnexpanded: boolean;
}

/** Every occurrence overlapping `[from, to]`, from every event given. */
export function expand(events: EventSpec[], from: Date, to: Date): Occurrence[] {
  const end = clampWindow(from, to);

  // An override replaces one instance of its series, so the series must know
  // to skip that slot. Collect them before expanding anything.
  const replaced: [string, number][] = events
    .filter((e) => e.overrides !== null)
    .map((e) => [e.overrides!.seriesId, e.overrides!.recurrenceId.getTime()]);

  const out: Occurrence[] = [];
  for (const event of events) {
    const skip = replaced.filter(([series]) => series === event.id).map(([, at]) => at);
    out.push(...expandOne(event, from, end, skip));
  }

  // Start then id, exactly as the Rust's `sort_by`. Both are RFC 3339 UTC
  // strings in the same shape, so a string compare is a time compare.
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function clampWindow(from: Date, to: Date): Date {
  const longest = new Date(from.getTime() + MAX_WINDOW_DAYS * DAY_MS);
  return to.getTime() > longest.getTime() ? longest : to;
}

function expandOne(event: EventSpec, from: Date, to: Date, skip: number[]): Occurrence[] {
  const durationMs = event.end.getTime() - event.start.getTime();

  const rule = event.rrule !== null && event.rrule.trim() !== "" ? event.rrule : null;
  if (rule === null) {
    return overlaps(event.start, event.end, from, to) ? [occurrence(event, event.start, durationMs, false)] : [];
  }

  const starts = startsFromRule(event, rule, from, to);
  // A rule we cannot expand degrades to the series' first instance, badged.
  // Dropping the event entirely would hide a real meeting.
  if (starts === null) {
    return overlaps(event.start, event.end, from, to) ? [occurrence(event, event.start, durationMs, true)] : [];
  }

  return starts
    .filter((start) => !skip.includes(start.getTime()) && !event.exdates.some((x) => x.getTime() === start.getTime()))
    .map((start) => occurrence(event, start, durationMs, false));
}

function startsFromRule(event: EventSpec, rule: string, from: Date, to: Date): Date[] | null {
  // An all-day event has no wall-clock time to preserve, so it is expanded in
  // UTC. Running it through a timezone is exactly how an all-day event ends up
  // rendered on the day before.
  const tz = event.allDay ? "UTC" : (event.tzid ?? "UTC");
  // An unknown zone returns null, so the caller badges the series rather than
  // guessing — the Rust's `name.parse::<chrono_tz::Tz>().ok()?`.
  if (!isKnownZone(tz)) return null;

  // The Rust hands rrule a `DTSTART;TZID=<tz>:<local>` and lets the crate do
  // the zone arithmetic. rrule@2.8.1 cannot: its `dateInTimeZone`
  // (`dist/esm/dateutil.js`) computes the TZID offset *relative to the
  // machine's own zone*, so the same feed expands to different instants on
  // different laptops. So the rule is built floating — no TZID, no Z — which
  // keeps rrule inside its own fake-UTC space, and the wall clock is converted
  // to and from real instants here, by `utcToZoned`/`zonedToUtc`.
  const spec = `DTSTART:${stamp(utcToZoned(event.start, tz))}\nRRULE:${rule.trim().replace(/^(?:RRULE:)+/, "")}`;

  try {
    const set = rrulestr(spec, { forceset: true });
    // `between(after, before, inc)` with `inc: true` includes both ends, which
    // is what the Rust buys with `after(from - 1s)`: an occurrence landing
    // exactly on the window's first instant is kept. The end is inclusive here
    // and exclusive in the Rust — a one-instant difference at `to`, taken
    // deliberately because an inclusive `from` is what the behaviour test pins.
    const dates = set.between(new Date(utcToZoned(from, tz)), new Date(utcToZoned(to, tz)), true);
    // The Rust passes the ceiling into `.all(MAX_OCCURRENCES)`; rrule's
    // `between` has no limit argument, so it is applied after the fact. The
    // window clamp already bounds the work.
    return dates.slice(0, MAX_OCCURRENCES).map((d) => new Date(zonedToUtc(d.getTime(), tz)));
  } catch {
    // rrule throws on an unknown FREQ or a malformed BYDAY.
    return null;
  }
}

/** A fake-UTC millisecond value as `%Y%m%dT%H%M%S`. */
function stamp(wall: number): string {
  const d = new Date(wall);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function overlaps(start: Date, end: Date, from: Date, to: Date): boolean {
  return start.getTime() <= to.getTime() && end.getTime() >= from.getTime();
}

function occurrence(event: EventSpec, start: Date, durationMs: number, unexpanded: boolean): Occurrence {
  return {
    id: `${event.id}@${rfc3339(start)}`,
    title: event.title,
    start: rfc3339(start),
    end: rfc3339(new Date(start.getTime() + durationMs)),
    allDay: event.allDay,
    calendar: event.calendar,
    color: event.color,
    editable: event.editable,
    location: event.location,
    url: event.url,
    recurringUnexpanded: unexpanded,
  };
}
