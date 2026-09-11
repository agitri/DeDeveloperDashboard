import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scratchEnv } from "../testing";
import { load, localCalendarFromJson, localEventFromJson, parseRfc3339, remove, save, upsert, type LocalEvent } from "./store";

function event(id: string): LocalEvent {
  return {
    id,
    title: "Dentist",
    start: "2026-08-19T09:00:00Z",
    end: "2026-08-19T09:30:00Z",
    allDay: false,
    rrule: null,
    notes: null,
  };
}

describe("the local calendar store", () => {
  it("round trips and replaces by id", () => {
    const { env } = scratchEnv("calendar-roundtrip");
    expect(load(env).events).toEqual([]);

    upsert(env, event("e1"));
    upsert(env, { ...event("e1"), title: "Dentist, moved" });

    const stored = load(env);
    expect(stored.events).toHaveLength(1);
    expect(stored.events[0]!.title).toBe("Dentist, moved");

    remove(env, "e1");
    expect(load(env).events).toEqual([]);
  });

  it("refuses an event that ends before it starts, and writes nothing", () => {
    const { env } = scratchEnv("calendar-backwards");
    expect(() => upsert(env, { ...event("e1"), end: "2026-08-19T08:00:00Z" })).toThrow(
      "an event cannot end before it starts",
    );
    expect(load(env).events).toEqual([]);
  });

  it("refuses a bad timestamp and an empty title", () => {
    const { env } = scratchEnv("calendar-invalid");
    expect(() => upsert(env, { ...event("e1"), start: "not a date" })).toThrow(
      'start is not an RFC 3339 timestamp: "not a date"',
    );
    expect(() => upsert(env, { ...event("e1"), end: "19 Aug" })).toThrow('end is not an RFC 3339 timestamp: "19 Aug"');
    expect(() => upsert(env, { ...event("e2"), title: "   " })).toThrow("an event needs a title");
  });

  it("leaves the rest alone when removing an absent id", () => {
    const { env } = scratchEnv("calendar-remove-absent");
    upsert(env, event("e1"));
    remove(env, "never-stored");
    expect(load(env).events).toHaveLength(1);
  });

  it("writes the Rust's field order and reads serde's defaults back", () => {
    const { env } = scratchEnv("calendar-shape");
    save(env, { events: [event("e1")] });
    expect(readFileSync(env.calendarFile(), "utf8")).toBe(
      '{\n  "events": [\n    {\n      "id": "e1",\n      "title": "Dentist",\n      "start": "2026-08-19T09:00:00Z",\n      "end": "2026-08-19T09:30:00Z",\n      "allDay": false,\n      "rrule": null,\n      "notes": null\n    }\n  ]\n}',
    );
    expect(localCalendarFromJson({})).toEqual({ events: [] });
    expect(localEventFromJson({ id: "e", title: "T", start: "a", end: "b" })).toEqual({
      id: "e",
      title: "T",
      start: "a",
      end: "b",
      allDay: false,
      rrule: null,
      notes: null,
    });
    expect(() => localEventFromJson({ id: "e", title: "T", start: "a" })).toThrow(/^json: missing field `end`$/);
    expect(() => localEventFromJson({ id: 3, title: "T", start: "a", end: "b" })).toThrow(/^json: /);
  });

  it("parseRfc3339 is strict, the way chrono's parse_from_rfc3339 is", () => {
    expect(parseRfc3339("2026-08-19T09:00:00Z")!.toISOString()).toBe("2026-08-19T09:00:00.000Z");
    expect(parseRfc3339("2026-08-19T11:00:00+02:00")!.toISOString()).toBe("2026-08-19T09:00:00.000Z");
    expect(parseRfc3339("2026-08-19T09:00:00.500Z")!.toISOString()).toBe("2026-08-19T09:00:00.500Z");
    // `Date.parse` would happily take all of these; chrono would not.
    expect(parseRfc3339("2026-08-19")).toBeNull();
    expect(parseRfc3339("2026-08-19T09:00:00")).toBeNull();
    expect(parseRfc3339("yesterday")).toBeNull();
    expect(parseRfc3339("2026-13-19T09:00:00Z")).toBeNull();
  });
});
