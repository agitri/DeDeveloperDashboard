import { describe, expect, it } from "vitest";
import type { Item } from "../models";
import { fetchContext } from "./adapter";
import { forProvider } from "./providers";
import { IcsAdapter, addDuration, normalizeUrl, parseTime, property, rfc3339, toItems, unescape, unfold, utcToZoned, zonedToUtc } from "./ics";

/** The Rust test module's `refs_of`. */
function refsOf(item: { refs: string[] }, prefix: string): string[] {
  return item.refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));
}

const FEED =
  "BEGIN:VCALENDAR\r\n" +
  "X-WR-CALNAME:Work\r\n" +
  "BEGIN:VEVENT\r\n" +
  "UID:standup@example.dev\r\n" +
  "SUMMARY:Daily standup\r\n" +
  "DTSTART;TZID=Europe/Amsterdam:20260803T090000\r\n" +
  "DTEND;TZID=Europe/Amsterdam:20260803T091500\r\n" +
  "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,\r\n FR\r\n" +
  "EXDATE:20260817T070000Z,20260824T070000Z\r\n" +
  "LOCATION:Room 3\\, upstairs\r\n" +
  "END:VEVENT\r\n" +
  "BEGIN:VEVENT\r\n" +
  "UID:holiday@example.dev\r\n" +
  "SUMMARY:Day off\r\n" +
  "DTSTART;VALUE=DATE:20260819\r\n" +
  "END:VEVENT\r\n" +
  "END:VCALENDAR\r\n";

describe("normalizeUrl", () => {
  it("rewrites webcal and refuses every other scheme", () => {
    expect(normalizeUrl("webcal://p01-calendars.icloud.com/published/2/abc")).toBe(
      "https://p01-calendars.icloud.com/published/2/abc",
    );
    expect(normalizeUrl("webcals://p01-calendars.icloud.com/published/2/abc")).toBe(
      "https://p01-calendars.icloud.com/published/2/abc",
    );
    expect(normalizeUrl("  https://x.dev/a.ics  ")).toBe("https://x.dev/a.ics");
    expect(normalizeUrl("HTTP://x.dev/a.ics")).toBe("HTTP://x.dev/a.ics");
    for (const bad of ["file:///etc/passwd", "ftp://x.dev/a.ics", "/Users/me/a.ics", "javascript:1"]) {
      expect(() => normalizeUrl(bad), bad).toThrow("a calendar URL must be webcal://, https:// or http://");
    }
  });
});

describe("toItems", () => {
  it("parses a feed into one item per event", () => {
    const items = toItems(FEED, "conn-1", "default");
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe("Daily standup");
    expect(items[0]!.kind).toBe("event");
    expect(items[0]!.source).toBe("calendar.ics");
    expect(items[0]!.connectionId).toBe("conn-1");
    expect(items[0]!.environmentId).toBe("default");
    expect(items[0]!.id).toBe("conn-1:standup@example.dev");
  });

  it("unfolds a continued line rather than truncating the rule", () => {
    // A folded RRULE that loses its tail turns a weekday meeting into a
    // Thursday one — silently, and only for some feeds.
    const items = toItems(FEED, "conn-1", "default");
    expect(refsOf(items[0]!, "rrule:")).toEqual(["FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]);
  });

  it("resolves a TZID start to UTC and keeps the zone", () => {
    const items = toItems(FEED, "conn-1", "default");
    // 09:00 Amsterdam in August is CEST, so 07:00Z.
    expect(refsOf(items[0]!, "dtstart:")[0]).toBe("2026-08-03T07:00:00Z");
    expect(refsOf(items[0]!, "dtend:")[0]).toBe("2026-08-03T07:15:00Z");
    expect(refsOf(items[0]!, "tzid:")).toEqual(["Europe/Amsterdam"]);
    expect(refsOf(items[0]!, "allday:")).toEqual(["false"]);
    expect(items[0]!.updatedAt).toBe("2026-08-03T07:00:00Z");
  });

  it("reads every EXDATE from one comma-separated line", () => {
    const items = toItems(FEED, "conn-1", "default");
    expect(refsOf(items[0]!, "exdate:")).toEqual(["2026-08-17T07:00:00Z", "2026-08-24T07:00:00Z"]);
  });

  it("flags an all-day event and gives it a day", () => {
    const items = toItems(FEED, "conn-1", "default");
    const holiday = items.find((i) => i.title === "Day off")!;
    expect(refsOf(holiday, "allday:")).toEqual(["true"]);
    expect(refsOf(holiday, "dtstart:")[0]).toBe("2026-08-19T00:00:00Z");
    expect(refsOf(holiday, "dtend:")[0]).toBe("2026-08-20T00:00:00Z");
  });

  it("unescapes text values", () => {
    const items = toItems(FEED, "conn-1", "default");
    expect(refsOf(items[0]!, "location:")).toEqual(["Room 3, upstairs"]);
  });

  it("skips a malformed event and keeps the rest", () => {
    const feed =
      "BEGIN:VCALENDAR\r\n" +
      "BEGIN:VEVENT\r\nSUMMARY:No uid at all\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nUID:no-start\r\nSUMMARY:No start\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nUID:fine\r\nSUMMARY:Fine\r\nDTSTART:20260819T090000Z\r\nEND:VEVENT\r\n" +
      "END:VCALENDAR\r\n";
    const items = toItems(feed, "conn-1", "default");
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Fine");
    // No DTEND and no DURATION on a timed event: one hour.
    expect(refsOf(items[0]!, "dtend:")[0]).toBe("2026-08-19T10:00:00Z");
  });

  it("lets DURATION stand in for a missing DTEND", () => {
    const feed =
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:d\r\nSUMMARY:D\r\n" +
      "DTSTART:20260819T090000Z\r\nDURATION:PT1H30M\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    expect(refsOf(toItems(feed, "conn-1", "default")[0]!, "dtend:")[0]).toBe("2026-08-19T10:30:00Z");
  });

  it("gives a recurrence override its own id and names its series", () => {
    const feed =
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Moved\r\n" +
      "DTSTART:20260817T140000Z\r\nRECURRENCE-ID:20260817T070000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const items = toItems(feed, "conn-1", "default");
    // Sharing the series UID would make the override overwrite the series in
    // the cache — the id must carry the instance.
    expect(items[0]!.id).toContain("#");
    expect(items[0]!.id).toBe("conn-1:standup#20260817T070000Z");
    expect(refsOf(items[0]!, "series:")).toEqual(["standup"]);
    expect(refsOf(items[0]!, "recurrenceid:")[0]).toBe("2026-08-17T07:00:00Z");
  });

  it("renders an event with no SUMMARY", () => {
    const feed = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260819T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    expect(toItems(feed, "c", "default")[0]!.title).toBe("(no title)");
  });

  it("travels the feed's own name with each event", () => {
    expect(refsOf(toItems(FEED, "conn-1", "default")[0]!, "calendar:")).toEqual(["Work"]);
  });

  it("puts the refs in the Rust's order", () => {
    expect(toItems(FEED, "conn-1", "default")[0]!.refs).toEqual([
      "dtstart:2026-08-03T07:00:00Z",
      "dtend:2026-08-03T07:15:00Z",
      "allday:false",
      "tzid:Europe/Amsterdam",
      "rrule:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      "exdate:2026-08-17T07:00:00Z",
      "exdate:2026-08-24T07:00:00Z",
      "location:Room 3, upstairs",
      "calendar:Work",
    ]);
  });
});

describe("the small parsers", () => {
  it("unfold joins a continuation onto the previous line and drops the CR", () => {
    // A leading space and a leading tab both continue; the marker itself goes.
    expect(unfold("A:1\r\nB:2\r\n 3\r\n\t4\r\n")).toEqual(["A:1", "B:234", ""]);
    // A continuation with nothing before it is a line of its own, not a crash.
    expect(unfold(" orphan")).toEqual([" orphan"]);
  });

  it("property matches the name case-insensitively and keeps colons in the value", () => {
    expect(property("URL:https://x.dev/a?b=1", "url")).toBe("https://x.dev/a?b=1");
    expect(property("DTSTART;TZID=Europe/Amsterdam:20260803T090000", "DTSTART")).toBe("20260803T090000");
    expect(property("SUMMARY:Hi", "UID")).toBeNull();
    expect(property("no colon here", "UID")).toBeNull();
  });

  it("parseTime handles Z, a floating time in a zone, and a bare date", () => {
    expect(parseTime("20260819T090000Z", null)![0].toISOString()).toBe("2026-08-19T09:00:00.000Z");
    expect(parseTime("20260819T090000Z", null)![1]).toBe(false);
    expect(parseTime(" 20260803T090000 ", "Europe/Amsterdam")![0].toISOString()).toBe("2026-08-03T07:00:00.000Z");
    // An unknown zone is not an error: the naive time is read as UTC.
    expect(parseTime("20260803T090000", "Mars/Olympus_Mons")![0].toISOString()).toBe("2026-08-03T09:00:00.000Z");
    expect(parseTime("20260803T090000", null)![0].toISOString()).toBe("2026-08-03T09:00:00.000Z");
    const day = parseTime("20260819", null)!;
    expect(day[0].toISOString()).toBe("2026-08-19T00:00:00.000Z");
    expect(day[1]).toBe(true);
    expect(parseTime("not a time", null)).toBeNull();
    expect(parseTime("20260231", null)).toBeNull();
    expect(parseTime("20261301T090000Z", null)).toBeNull();
  });

  it("addDuration reads the subset of ISO 8601 calendars emit", () => {
    const start = new Date("2026-08-19T09:00:00Z");
    expect(addDuration(start, "PT1H30M")!.toISOString()).toBe("2026-08-19T10:30:00.000Z");
    expect(addDuration(start, "P2D")!.toISOString()).toBe("2026-08-21T09:00:00.000Z");
    expect(addDuration(start, "PT45M")!.toISOString()).toBe("2026-08-19T09:45:00.000Z");
    expect(addDuration(start, "P1W")!.toISOString()).toBe("2026-08-26T09:00:00.000Z");
    expect(addDuration(start, "PT30S")!.toISOString()).toBe("2026-08-19T09:00:30.000Z");
    // Anything else falls back to the default duration rather than inventing one.
    expect(addDuration(start, "1H")).toBeNull();
    expect(addDuration(start, "PT1Y")).toBeNull();
    expect(addDuration(start, "PTH")).toBeNull();
  });

  it("unescape undoes the four iCalendar escapes", () => {
    expect(unescape("a\\nb\\Nc\\,d\\;e\\\\f")).toBe("a\nb\nc,d;e\\f");
  });

  it("the zone helpers are independent of the machine's own zone", () => {
    // 09:00 Amsterdam is 07:00Z in August (CEST) and 08:00Z in November (CET).
    expect(zonedToUtc(Date.UTC(2026, 7, 3, 9, 0, 0), "Europe/Amsterdam")).toBe(Date.parse("2026-08-03T07:00:00Z"));
    expect(zonedToUtc(Date.UTC(2026, 10, 2, 9, 0, 0), "Europe/Amsterdam")).toBe(Date.parse("2026-11-02T08:00:00Z"));
    // The hour that repeats when summer time ends resolves to the earlier one.
    expect(zonedToUtc(Date.UTC(2026, 9, 25, 2, 30, 0), "Europe/Amsterdam")).toBe(Date.parse("2026-10-25T00:30:00Z"));
    expect(utcToZoned(new Date("2026-08-03T07:00:00Z"), "Europe/Amsterdam")).toBe(Date.UTC(2026, 7, 3, 9, 0, 0));
    expect(utcToZoned(new Date("2026-08-03T07:00:00Z"), "UTC")).toBe(Date.parse("2026-08-03T07:00:00Z"));
    expect(rfc3339(new Date("2026-08-03T07:00:00Z"))).toBe("2026-08-03T07:00:00Z");
  });
});

describe("IcsAdapter.fetch", () => {
  /** A fetch that answers with one canned body and records what it was asked. */
  function fakeFetch(body: BodyInit, init?: ResponseInit) {
    const calls: { url: string; accept: string | null }[] = [];
    const fetch = (async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: String(url), accept: new Headers(options?.headers).get("accept") });
      return new Response(body, init);
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }

  const connection = { id: "conn-1", label: "Work", provider: "calendar.ics" };

  it("rewrites webcal, asks for calendar text and returns the items", async () => {
    const { fetch, calls } = fakeFetch(FEED, { status: 200 });
    const items = await new IcsAdapter().fetch(
      fetchContext({ environmentId: "default", connection, token: "webcal://x.dev/a.ics", fetch }),
    );
    expect(calls).toEqual([{ url: "https://x.dev/a.ics", accept: "text/calendar, text/plain" }]);
    expect(items.map((i) => i.title)).toEqual(["Daily standup", "Day off"]);
  });

  it("names the connection in every failure, verbatim", async () => {
    const adapter = new IcsAdapter();
    const cx = (f: typeof globalThis.fetch) => fetchContext({ connection, token: "https://x.dev/a.ics", fetch: f });

    const boom = (async () => {
      throw new Error("boom");
    }) as typeof globalThis.fetch;
    await expect(adapter.fetch(cx(boom))).rejects.toThrow("Work: boom");

    await expect(adapter.fetch(cx(fakeFetch("", { status: 404, statusText: "Not Found" }).fetch))).rejects.toThrow(
      "Work returned 404 Not Found",
    );

    const tooBig = new Uint8Array(8 * 1024 * 1024 + 1);
    await expect(adapter.fetch(cx(fakeFetch(tooBig, { status: 200 }).fetch))).rejects.toThrow(
      "Work sent 8388609 bytes, over the 8388608 cap",
    );

    await expect(adapter.fetch(cx(fakeFetch("<html>nope</html>", { status: 200 }).fetch))).rejects.toThrow(
      "Work did not return an iCalendar feed",
    );

    await expect(adapter.fetch(fetchContext({ connection, token: "ftp://x.dev/a.ics", fetch: boom }))).rejects.toThrow(
      "a calendar URL must be webcal://, https:// or http://",
    );
  });

  it("refuses every outbound action: a subscribed feed is read-only", async () => {
    const item: Item = {
      id: "conn-1:x",
      environmentId: "default",
      connectionId: "conn-1",
      source: "calendar.ics",
      kind: "event",
      project: null,
      title: "Daily standup",
      body: null,
      url: null,
      refs: [],
      actions: [],
      updatedAt: "2026-08-19T09:00:00Z",
      unread: false,
    };
    await expect(
      new IcsAdapter().perform(fetchContext({ connection }), { action: "comment", item, input: null }),
    ).rejects.toThrow("calendar.ics cannot comment");
  });

  it("is what providers.forProvider builds for calendar.ics", () => {
    expect(forProvider("calendar.ics")).toBeInstanceOf(IcsAdapter);
    expect(forProvider("calendar.ics")!.source).toBe("calendar.ics");
  });
});
