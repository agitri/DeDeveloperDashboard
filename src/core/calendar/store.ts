/**
 * Your own events: the ones that need no account at all. Port of
 * `calendar/store.rs`.
 *
 * Deliberately *not* in the item cache. `cache.replaceForConnection` deletes
 * and reinserts every item on each sync, so a user-authored event kept there
 * would survive exactly until the next refresh. This is the same lesson
 * `repos/links.ts` records, and it has the same answer: a store of its own,
 * merged with cached items at read time.
 */
import { DddError } from "../error";
import { isArray, isBoolean, isString, optional, record, required } from "../json";
import type { EnvRoot } from "../paths";
import { readJson, writeJson } from "../store";

export interface LocalEvent {
  id: string;
  title: string;
  /** RFC 3339. */
  start: string;
  end: string;
  allDay: boolean;
  /** Same grammar a subscribed event uses, so one expander serves both. */
  rrule: string | null;
  notes: string | null;
}

export interface LocalCalendar {
  events: LocalEvent[];
}

export function defaultLocalCalendar(): LocalCalendar {
  return { events: [] };
}

export function localEventFromJson(raw: unknown): LocalEvent {
  const o = record(raw, "event");
  return {
    id: required(o, "id", isString),
    title: required(o, "title", isString),
    start: required(o, "start", isString),
    end: required(o, "end", isString),
    allDay: optional(o, "allDay", isBoolean, false),
    rrule: optional(o, "rrule", isString, null as string | null),
    notes: optional(o, "notes", isString, null as string | null),
  };
}

export function localCalendarFromJson(raw: unknown): LocalCalendar {
  const o = record(raw, "calendar");
  return { events: optional(o, "events", isArray, [] as unknown[]).map(localEventFromJson) };
}

export function load(env: EnvRoot): LocalCalendar {
  return readJson(env.calendarFile(), localCalendarFromJson, defaultLocalCalendar);
}

export function save(env: EnvRoot, calendar: LocalCalendar): void {
  writeJson(env.calendarFile(), calendar);
}

/** Insert or replace by id, validating the times first. */
export function upsert(env: EnvRoot, event: LocalEvent): LocalEvent {
  const start = parse(event.start, "start");
  const end = parse(event.end, "end");
  if (end.getTime() < start.getTime()) throw DddError.config("an event cannot end before it starts");
  if (event.title.trim() === "") throw DddError.config("an event needs a title");

  // Read, modify and write with no await in between, as the Rust's
  // main-thread commands are serialized.
  const stored = load(env);
  stored.events = stored.events.filter((e) => e.id !== event.id);
  stored.events.push(event);
  save(env, stored);
  return event;
}

export function remove(env: EnvRoot, id: string): void {
  const stored = load(env);
  stored.events = stored.events.filter((e) => e.id !== id);
  save(env, stored);
}

/**
 * `chrono::DateTime::parse_from_rfc3339`, which `Date.parse` is not: it would
 * accept `2026-08-19`, `2026-08-19T09:00:00` and a pile of legacy formats, and
 * then silently read them in the machine's own zone. An offset is mandatory.
 */
export function parseRfc3339(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const at = Date.parse(value.replace(" ", "T"));
  return Number.isNaN(at) ? null : new Date(at);
}

function parse(value: string, field: string): Date {
  const at = parseRfc3339(value);
  if (at === null) throw DddError.config(`${field} is not an RFC 3339 timestamp: ${JSON.stringify(value)}`);
  return at;
}
