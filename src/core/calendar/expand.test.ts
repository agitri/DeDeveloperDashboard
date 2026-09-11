import { describe, expect, it } from "vitest";
import { MAX_WINDOW_DAYS, expand, type EventSpec } from "./expand";

const at = (s: string) => new Date(s);

function event(id: string, start: string, end: string): EventSpec {
  return {
    id,
    title: id,
    start: at(start),
    end: at(end),
    allDay: false,
    tzid: null,
    rrule: null,
    exdates: [],
    overrides: null,
    calendar: "Test",
    color: "#2f6ae8",
    editable: false,
    location: null,
    url: null,
  };
}

const days = (out: { start: string }[]) => out.map((o) => new Date(o.start).getUTCDate());

describe("expand", () => {
  it("yields only the instances a weekly rule puts inside the window", () => {
    const e = { ...event("standup", "2026-08-03T09:00:00Z", "2026-08-03T09:15:00Z"), rrule: "FREQ=WEEKLY;BYDAY=MO" };
    const out = expand([e], at("2026-08-01T00:00:00Z"), at("2026-08-31T23:59:59Z"));
    expect(days(out)).toEqual([3, 10, 17, 24, 31]);
    expect(out.every((o) => !o.recurringUnexpanded)).toBe(true);
    expect(out[0]).toEqual({
      id: "standup@2026-08-03T09:00:00Z",
      title: "standup",
      start: "2026-08-03T09:00:00Z",
      end: "2026-08-03T09:15:00Z",
      allDay: false,
      calendar: "Test",
      color: "#2f6ae8",
      editable: false,
      location: null,
      url: null,
      recurringUnexpanded: false,
    });
  });

  it("keeps an occurrence that lands exactly on the window's first instant", () => {
    // Both ends of the window are inclusive here; the Rust gets the same effect
    // by stepping `after` back one second. Without it the first week of every
    // month is silently empty.
    const e = { ...event("standup", "2026-08-03T09:00:00Z", "2026-08-03T09:15:00Z"), rrule: "FREQ=WEEKLY;BYDAY=MO" };
    expect(expand([e], at("2026-08-03T09:00:00Z"), at("2026-08-05T00:00:00Z"))).toHaveLength(1);
  });

  it("removes one instance for an EXDATE", () => {
    const e = {
      ...event("standup", "2026-08-03T09:00:00Z", "2026-08-03T09:15:00Z"),
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      exdates: [at("2026-08-17T09:00:00Z")],
    };
    expect(days(expand([e], at("2026-08-01T00:00:00Z"), at("2026-08-31T23:59:59Z")))).toEqual([3, 10, 24, 31]);
  });

  it("lets a RECURRENCE-ID override replace its instance", () => {
    const series = { ...event("standup", "2026-08-03T09:00:00Z", "2026-08-03T09:15:00Z"), rrule: "FREQ=WEEKLY;BYDAY=MO" };
    const moved: EventSpec = {
      ...event("standup-moved", "2026-08-17T14:00:00Z", "2026-08-17T14:30:00Z"),
      title: "Standup (moved)",
      overrides: { seriesId: "standup", recurrenceId: at("2026-08-17T09:00:00Z") },
    };
    const out = expand([series, moved], at("2026-08-01T00:00:00Z"), at("2026-08-31T23:59:59Z"));
    // The 09:00 slot on the 17th is gone; the moved one stands in its place.
    expect(out.some((o) => o.start === "2026-08-17T09:00:00Z")).toBe(false);
    expect(out.some((o) => o.title === "Standup (moved)")).toBe(true);
    expect(out).toHaveLength(5);
  });

  it("keeps a local time across a DST change", () => {
    // Amsterdam leaves summer time on the last Sunday of October. A 09:00
    // meeting must stay 09:00 local — which means its UTC instant moves.
    const e = {
      ...event("standup", "2026-10-19T07:00:00Z", "2026-10-19T07:30:00Z"),
      tzid: "Europe/Amsterdam",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    };
    const out = expand([e], at("2026-10-01T00:00:00Z"), at("2026-11-15T00:00:00Z"));
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Amsterdam",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(out.length).toBeGreaterThan(1);
    for (const o of out) expect(local.format(new Date(o.start))).toBe("09:00");
    // And the UTC instants really do differ across the boundary, or the test
    // would pass on a broken implementation that ignores zones.
    expect(new Set(out.map((o) => new Date(o.start).getUTCHours())).size).toBe(2);
  });

  it("does not shift an all-day event by a day", () => {
    const e = {
      ...event("holiday", "2026-08-19T00:00:00Z", "2026-08-20T00:00:00Z"),
      allDay: true,
      // A timezone on an all-day event is exactly the trap: honouring it
      // renders the day before.
      tzid: "Pacific/Kiritimati",
      rrule: "FREQ=YEARLY",
    };
    const out = expand([e], at("2026-08-01T00:00:00Z"), at("2026-08-31T00:00:00Z"));
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe("2026-08-19T00:00:00Z");
  });

  it("shows a non-recurring event only when it overlaps", () => {
    const e = event("one-off", "2026-08-19T10:00:00Z", "2026-08-19T11:00:00Z");
    expect(expand([e], at("2026-08-01T00:00:00Z"), at("2026-08-31T00:00:00Z"))).toHaveLength(1);
    expect(expand([e], at("2026-09-01T00:00:00Z"), at("2026-09-30T00:00:00Z"))).toHaveLength(0);
  });

  it("shows the first instance of an unparseable rule and says so", () => {
    const e = { ...event("broken", "2026-08-19T10:00:00Z", "2026-08-19T11:00:00Z"), rrule: "FREQ=NONSENSE;BYDAY=??" };
    const out = expand([e], at("2026-08-01T00:00:00Z"), at("2026-08-31T00:00:00Z"));
    expect(out).toHaveLength(1);
    expect(out[0]!.recurringUnexpanded).toBe(true);
  });

  it("gives occurrences the same ids on two expansions", () => {
    const e = { ...event("standup", "2026-08-03T09:00:00Z", "2026-08-03T09:15:00Z"), rrule: "FREQ=WEEKLY;BYDAY=MO" };
    const from = at("2026-08-01T00:00:00Z");
    const to = at("2026-08-31T23:59:59Z");
    expect(expand([e], from, to).map((o) => o.id)).toEqual(expand([e], from, to).map((o) => o.id));
  });

  it("clamps a window wider than a year", () => {
    const e = { ...event("daily", "2026-01-01T00:00:00Z", "2026-01-01T00:30:00Z"), rrule: "FREQ=DAILY" };
    const out = expand([e], at("2026-01-01T00:00:00Z"), at("2036-01-01T00:00:00Z"));
    // Ten years of a daily rule would be ~3650 occurrences; the clamp keeps it
    // to a year, and the per-event ceiling would catch it even if not.
    expect(out.length).toBeLessThanOrEqual(MAX_WINDOW_DAYS + 1);
    expect(out.length).toBeGreaterThan(300);
  });

  it("comes back in start order", () => {
    const a = event("b-later", "2026-08-19T15:00:00Z", "2026-08-19T16:00:00Z");
    const b = event("a-earlier", "2026-08-19T09:00:00Z", "2026-08-19T10:00:00Z");
    expect(expand([a, b], at("2026-08-01T00:00:00Z"), at("2026-08-31T00:00:00Z"))[0]!.title).toBe("a-earlier");
  });

  it("degrades to the badge when the timezone is unknown", () => {
    const e = {
      ...event("standup", "2026-08-03T09:00:00Z", "2026-08-03T09:15:00Z"),
      tzid: "Mars/Olympus_Mons",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    };
    // An unknown zone must not lose the event; it degrades to the badge.
    const out = expand([e], at("2026-08-01T00:00:00Z"), at("2026-08-31T00:00:00Z"));
    expect(out).toHaveLength(1);
    expect(out[0]!.recurringUnexpanded).toBe(true);
  });

  it("tolerates a rule stored with its RRULE: prefix and a blank rule", () => {
    const prefixed = { ...event("standup", "2026-08-03T09:00:00Z", "2026-08-03T09:15:00Z"), rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO" };
    expect(days(expand([prefixed], at("2026-08-01T00:00:00Z"), at("2026-08-31T23:59:59Z")))).toEqual([3, 10, 17, 24, 31]);
    // A blank rule is not a rule: the event is a one-off, not a badged series.
    const blank = { ...event("one-off", "2026-08-19T10:00:00Z", "2026-08-19T11:00:00Z"), rrule: "   " };
    const out = expand([blank], at("2026-08-01T00:00:00Z"), at("2026-08-31T00:00:00Z"));
    expect(out).toHaveLength(1);
    expect(out[0]!.recurringUnexpanded).toBe(false);
  });
});
