# Phase 4 — Calendar, Repos, Dev Servers, EOL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The calendar, repos, dev-server and end-of-life widgets work: subscribed ICS feeds and local events expand into occurrences; GitHub repos join to checkouts on disk, can be scanned, linked and cloned with live progress; listening dev servers are listed, probed and stopped with the Rust's guards; watched checkouts get an end-of-life board from endoflife.date with offline-safe caches. Seventeen commands join the registry.

**Architecture:** `core/calendar/*`, `core/sync/ics.ts`, `core/repos/{scan,clone}.ts` (plus the rest of `links.ts`), `core/dev/*` and `core/eol/*` ported one-to-one from the Rust. Subprocesses (`git`, `lsof`, `netstat`, `docker`) run through an injectable runner; HTTP through the injected `fetch` already in `SyncDeps`; the clone's progress reaches the renderer as `ddd://repo-progress` through the phase 1 `Emitter`. Recurrence expansion uses the `rrule` package with IANA zones. Every read-modify-write of a JSON store is synchronous within one handler, which reproduces the serialisation the Rust gets from main-thread commands.

**Tech Stack:** Electron 44, TypeScript 5.8, vitest 5, `node:child_process`, `node:net`, `node:fs`, global `fetch` with `AbortSignal.timeout`, `rrule`.

**Spec:** `docs/superpowers/specs/2026-09-10-node-port-design.md` (§3, §4 phase 4, §5 rows `sync/ics.rs`, `calendar/*`, `repos/*`, `dev/*`, `eol/*`, §6, §7, §8)

## Global Constraints

- Source of truth: `../DDD/src-tauri/src/{calendar/*,sync/ics.rs,repos/*,dev/*,eol/*}.rs` and the matching commands in `commands.rs` at commit `7fe0f68` (read-only). When in doubt, do what the Rust does and leave a comment.
- Nothing under `src/core/` may import `electron`. Core reaches the network only through an injected `fetch`, spawns subprocesses only through an injectable runner (default `execFile`/`spawn`), touches the keychain only through the injected `SecretStore`, and emits events only through the `Emitter`. Tests inject fakes; main injects the real ones.
- On-disk compatibility: `calendar.json`, `repo-links.json`, `watchlist.json`, `eol-cache.json` are written with the Rust field order, two-space JSON, tmp+rename; `null` for `Option::None` unless the Rust has `skip_serializing_if`. Canonical paths use `realpathSync`, the same function `projects.register` uses, so joins by path hold.
- Read-modify-write of a JSON store is synchronous within one function: no `await` between the read and the write.
- Timestamps: `new Date().toISOString()` for stored "now" values; occurrence ids and any value the Rust formats with `to_rfc3339()` for a whole-second UTC instant use the `rfc3339()` helper (no `.000`).
- Command names and argument keys are the Tauri ones the renderer already sends (listed per task). `repo_clone` returns the target path immediately; progress arrives as `ddd://repo-progress` with `{ remote, phase, percent, done, error }`.
- Error text verbatim from the Rust (each task lists its strings). A timeout is never "down" (dev probe) and never "unreachable" (EOL live check).
- Security boundaries kept: ICS URLs must be webcal/https/http; watchlist URLs http(s) with a dotted host, re-validated before the outbound HEAD; only the twelve-product allowlist can become an endoflife.date URL; docker rows never get a URL or a probe; stopping a process is refused on Windows and never escalates privilege.
- No test may reach the real network, the real keychain, or the real `~/.ddd`; every test that opens an `EnvRoot` calls `scratchEnv()` first. Real `git` and local sockets on 127.0.0.1 are allowed. Tests never open windows.
- No renderer changes. Core declares its own shapes; the renderer's `types/index.ts` is the cross-check.
- Commit after every task. End every commit message with these two trailer lines exactly, regardless of any other attribution guidance:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_017ja7FNu24S9L9DM9L8p9Dr`

---
## Assembly notes (read before any commands task)

- `src/main/commands.ts` gains module-level helpers over this phase: Task 3 adds `uuidIsh()`, `parseInstant`, `specFromItem`, `specFromLocal`; Task 6 adds `isDir(path)` and `leaf(path)` and `import * as links from "../core/repos/links"`; Task 9 adds `knownProjects(env)` and `const machine = new Memo()`; Task 12 adds the EOL pipeline. A later task must REUSE a helper or import that an earlier task already added (same name, same file) rather than redeclare it — check the file before adding.
- Each section's core modules may define their own private `leaf`/`isDirectory` helpers inside `src/core/dev/board.ts` and `src/core/eol/board.ts`; that is fine (module scope), only `commands.ts` must stay duplicate-free.
- `src/core/sync/providers.ts` gains `case "calendar.ics"` in Task 1 only.
- `NOT_YET_PORTED` in `src/main/commands.test.ts` loses its names in Tasks 3, 6, 9 and 12; Task 13 verifies the final set.
- New dependency: `rrule@2.8.1` (Task 2). Nothing else.
- Rulings from the design (recorded in the ledger): recurrence expansion builds a floating DTSTART and converts wall time itself with `Intl`, because `rrule`'s TZID handling depends on the machine zone; clone runs git with `GIT_TERMINAL_PROMPT=0`; listener enumeration uses `lsof`/`netstat` (no `listeners` crate equivalent); the EOL cache decoder is fixed to read the tagged on-disk shape the Rust writes (the Rust cannot read its own cache); `eol_board` awaits between loading and saving `eol-cache.json`, as the Rust command does — it is derived data.

---

### Task 1: The `calendar.ics` adapter

**Files:**
- Create: `src/core/sync/ics.ts`
- Modify: `src/core/sync/providers.ts`
- Test: `src/core/sync/ics.test.ts`

**Interfaces:**
- Consumes: `itemId(connectionId, sourceKey)`, `statusLabel(response)`, `refuse(source, action)`, `type ActionRequest`, `type FetchContext`, `type SourceAdapter`, `fetchContext(partial)` (test helper) from `src/core/sync/adapter.ts`; `DddError` from `src/core/error.ts`; `type Item` from `src/core/models.ts`.
- Produces: `class IcsAdapter implements SourceAdapter` (`readonly source = "calendar.ics"`, `fetch(cx)`, `perform(cx, request)`), `normalizeUrl(raw): string`, `toItems(ics, connectionId, environmentId): Item[]`, `unfold(ics): string[]`, `property(line, name): string | null`, `parseTime(value, tzid): [Date, boolean] | null`, `addDuration(start, spec): Date | null`, `unescape(value): string`, and the four time helpers **Task 2 imports**: `rfc3339(date): string`, `isKnownZone(name): boolean`, `utcToZoned(instant, tz): number`, `zonedToUtc(wall, tz): number`.

- [ ] **Step 1: Write the failing tests**

`src/core/sync/ics.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/sync/ics.test.ts` — expected: failure to resolve `./ics`.

- [ ] **Step 3: Write the module**

`src/core/sync/ics.ts`:

```ts
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
  const candidates = [wall - offsetAt(wall - DAY_MS), wall - offsetAt(wall + DAY_MS)].filter(
    (t) => utcToZoned(new Date(t), tz) === wall,
  );
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
  const rewritten = trimmed.startsWith("webcal://")
    ? `https://${trimmed.slice("webcal://".length)}`
    : trimmed.startsWith("webcals://")
      ? `https://${trimmed.slice("webcals://".length)}`
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
    dtend !== null
      ? dtend[0]
      : ((duration === null ? null : addDuration(start, duration)) ??
        new Date(start.getTime() + (allDay ? DAY_MS : HOUR_MS)));

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
  return value
    .replaceAll("\\n", "\n")
    .replaceAll("\\N", "\n")
    .replaceAll("\\,", ",")
    .replaceAll("\\;", ";")
    .replaceAll("\\\\", "\\");
}
```

Then register it. In `src/core/sync/providers.ts`, add the import and the case:

```ts
import { GitHubAdapter } from "./github";
import { IcsAdapter } from "./ics";
import { MockAdapter } from "./mock";
```

```ts
    case "calendar.ics":
      return new IcsAdapter();
```

(place the case after `"github"`, before `"mock"`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/sync/ics.test.ts` — expected: PASS. Then `TZ=America/New_York npx vitest run src/core/sync/ics.test.ts` and `TZ=Pacific/Kiritimati npx vitest run src/core/sync/ics.test.ts` — expected: PASS in both. The zone helpers must not depend on the machine's own zone; if these two runs disagree, the bug is in `utcToZoned`/`zonedToUtc`, not in the test.

- [ ] **Step 5: Commit**

```bash
git add src/core/sync/ics.ts src/core/sync/ics.test.ts src/core/sync/providers.ts
git commit -m "feat(sync): the calendar.ics adapter"
```

---

### Task 2: The local calendar store and recurrence expansion

**Files:**
- Create: `src/core/calendar/store.ts`, `src/core/calendar/expand.ts`
- Test: `src/core/calendar/store.test.ts`, `src/core/calendar/expand.test.ts`

**Interfaces:**
- Consumes: `readJson`, `writeJson` from `src/core/store.ts`; `DddError` from `src/core/error.ts`; `record`, `required`, `optional`, `isString`, `isBoolean`, `isArray` from `src/core/json.ts`; `type EnvRoot` (`calendarFile()`) from `src/core/paths.ts`; `scratchEnv` from `src/core/testing.ts`; **`rfc3339`, `isKnownZone`, `utcToZoned`, `zonedToUtc` from `src/core/sync/ics.ts` (Task 1)**; `rrulestr` from the `rrule` npm package.
- Produces: `store.ts`: `LocalEvent`, `LocalCalendar`, `defaultLocalCalendar()`, `localEventFromJson(raw)`, `localCalendarFromJson(raw)`, `parseRfc3339(value): Date | null`, `load(env)`, `save(env, calendar)`, `upsert(env, event)`, `remove(env, id)`. `expand.ts`: `EventSpec`, `Override`, `Occurrence`, `MAX_WINDOW_DAYS`, `MAX_OCCURRENCES`, `expand(events, from, to): Occurrence[]`.

- [ ] **Step 1: Add the dependency**

Run: `npm install rrule` — this installs `rrule@2.8.1` (plus `tslib`) and adds it to `dependencies` in `package.json`. It has no other runtime dependency and needs only `Intl`, which Node 24 has. Commit `package.json` and `package-lock.json` with the rest of this task.

- [ ] **Step 2: Write the failing tests**

`src/core/calendar/store.test.ts`:

```ts
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
```

`src/core/calendar/expand.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/core/calendar` — expected: failure to resolve `./store` and `./expand`.

- [ ] **Step 4: Write the modules**

`src/core/calendar/store.ts`:

```ts
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
```

`src/core/calendar/expand.ts`:

```ts
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
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/core/calendar` — expected: PASS.

Then run the expansion tests under two other machine zones, because the whole point of the floating-DTSTART design is that the answer must not depend on where the laptop is: `TZ=America/New_York npx vitest run src/core/calendar/expand.test.ts` and `TZ=Pacific/Kiritimati npx vitest run src/core/calendar/expand.test.ts` — expected: PASS in both.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/core/calendar/store.ts src/core/calendar/store.test.ts src/core/calendar/expand.ts src/core/calendar/expand.test.ts
git commit -m "feat(calendar): local events and recurrence expansion"
```

---

### Task 3: The three calendar commands

**Files:**
- Modify: `src/main/commands.ts`, `src/main/commands.test.ts`

**Interfaces:**
- Consumes: `expand`, `type EventSpec`, `type Override`, `type Occurrence` from `src/core/calendar/expand.ts`; `load`, `upsert`, `remove`, `localEventFromJson`, `parseRfc3339`, `type LocalEvent` from `src/core/calendar/store.ts`; `itemId` from `src/core/sync/adapter.ts`; `cache.query` from `src/core/sync/cache.ts`; `settingsLoad`, `defaultSettings` from `src/core/settings.ts`; `toItems` from `src/core/sync/ics.ts`; `replaceForConnection` from `src/core/sync/cache.ts` (tests only).
- Produces: commands `calendar_list`, `calendar_event_save`, `calendar_event_delete`.

- [ ] **Step 1: Write the failing tests**

In `src/main/commands.test.ts`, remove these three names from the `NOT_YET_PORTED` set: `"calendar_list"`, `"calendar_event_save"`, `"calendar_event_delete"`.

Add these imports at the top of the file (alongside the existing ones):

```ts
import { replaceForConnection } from "../core/sync/cache";
import { toItems } from "../core/sync/ics";
import { load as calendarLoad } from "../core/calendar/store";
```

Then append:

```ts
describe("calendar commands", () => {
  /** A one-event feed run through the real adapter, so the refs the command
   *  reads are the refs the adapter actually writes. */
  function icsItems(connectionId: string) {
    const feed =
      "BEGIN:VCALENDAR\r\nX-WR-CALNAME:Work\r\nBEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Daily standup\r\n" +
      "DTSTART:20260819T090000Z\r\nDTEND:20260819T093000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    return toItems(feed, connectionId, "default");
  }

  const mine = { id: "mine", title: "Dentist", start: "2026-08-19T14:00:00Z", end: "2026-08-19T15:00:00Z" };

  it("keeps your own events when a sync wipes the subscribed ones", async () => {
    // The regression `repo-links.json` exists to prevent, pinned for the
    // calendar too: a sync deletes and reinserts every item for a connection,
    // so anything the user authored must live outside the cache or it is gone
    // on the next refresh.
    const { env } = scratchEnv("cmd-calendar-survives-sync");
    replaceForConnection(env, "conn-1", icsItems("conn-1"));
    await commands.calendar_event_save!({ env: "default", event: mine });

    const before = (await commands.calendar_list!({
      env: "default",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-31T00:00:00Z",
    })) as { title: string; editable: boolean }[];
    expect(before.map((o) => o.title)).toEqual(["Daily standup", "Dentist"]);

    // The feed went empty — an unshared calendar, a revoked URL, a bad day.
    replaceForConnection(env, "conn-1", []);

    const after = (await commands.calendar_list!({
      env: "default",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-31T00:00:00Z",
    })) as { title: string; editable: boolean }[];
    expect(after).toHaveLength(1);
    expect(after[0]!.title).toBe("Dentist");
    expect(after[0]!.editable).toBe(true);
  });

  it("never marks a subscribed occurrence editable, and dresses it from the connection", async () => {
    const { env } = scratchEnv("cmd-calendar-readonly");
    const settings = defaultSettings();
    settings.connections.push({
      id: "conn-1",
      provider: "calendar.ics",
      label: "Work calendar",
      status: "connected",
      scopes: [],
      config: { color: "#ff8800" },
      lastSyncAt: null,
      error: null,
    } as Connection);
    settingsSave(env, settings);
    replaceForConnection(env, "conn-1", icsItems("conn-1"));
    await commands.calendar_event_save!({ env: "default", event: mine });

    const out = (await commands.calendar_list!({
      env: "default",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-31T00:00:00Z",
    })) as { id: string; title: string; editable: boolean; calendar: string; color: string; start: string; end: string }[];
    expect(out.map((o) => o.editable)).toEqual([false, true]);
    // The feed's own X-WR-CALNAME wins over the label the user typed.
    expect(out[0]).toMatchObject({
      id: "conn-1:standup@2026-08-19T09:00:00Z",
      calendar: "Work",
      color: "#ff8800",
      start: "2026-08-19T09:00:00Z",
      end: "2026-08-19T09:30:00Z",
    });
    // Your own events borrow the ICS connection's colour and say whose they are.
    expect(out[1]).toMatchObject({ calendar: "My calendar", color: "#ff8800" });
  });

  it("falls back to the default colour and calendar name with no connection", async () => {
    scratchEnv("cmd-calendar-defaults");
    replaceForConnection(EnvRoot.open("default"), "conn-1", icsItems("conn-1"));
    const out = (await commands.calendar_list!({
      env: "default",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-31T00:00:00Z",
    })) as { color: string }[];
    expect(out[0]!.color).toBe("#00a99f");
  });

  it("makes a bad window an error, not an empty calendar", async () => {
    scratchEnv("cmd-calendar-bad-window");
    await expect(
      commands.calendar_list!({ env: "default", from: "yesterday", to: "2026-08-31T00:00:00Z" }),
    ).rejects.toThrow("from is not an RFC 3339 timestamp");
    await expect(
      commands.calendar_list!({ env: "default", from: "2026-08-01T00:00:00Z", to: "soon" }),
    ).rejects.toThrow("to is not an RFC 3339 timestamp");
  });

  it("mints an id when one is saved without it, and deletes by id", async () => {
    const { env } = scratchEnv("cmd-calendar-mints-id");
    const saved = (await commands.calendar_event_save!({
      env: "default",
      event: { id: "", title: "Dentist", start: "2026-08-19T09:00:00Z", end: "2026-08-19T10:00:00Z" },
    })) as { id: string; allDay: boolean; rrule: string | null; notes: string | null };
    expect(saved.id.startsWith("ev-")).toBe(true);
    // serde's defaults come back filled in, not absent.
    expect(saved).toMatchObject({ allDay: false, rrule: null, notes: null });

    await commands.calendar_event_delete!({ env: "default", id: saved.id });
    expect(calendarLoad(env).events).toEqual([]);
  });

  it("validates the event it is handed instead of writing it as-is", async () => {
    scratchEnv("cmd-calendar-validate");
    await expect(commands.calendar_event_save!({ env: "default", event: { id: "x", title: "T" } })).rejects.toThrow(
      /^json: missing field `start`$/,
    );
    await expect(
      commands.calendar_event_save!({
        env: "default",
        event: { id: "x", title: "T", start: "2026-08-19T10:00:00Z", end: "2026-08-19T09:00:00Z" },
      }),
    ).rejects.toThrow("an event cannot end before it starts");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/commands.test.ts` — expected: the contract test fails (three names neither registered nor listed) and the new tests fail with `commands.calendar_list is not a function`.

- [ ] **Step 3: Add the commands**

In `src/main/commands.ts`, add the imports:

```ts
import * as calendar from "../core/calendar/store";
import { expand, type EventSpec, type Override } from "../core/calendar/expand";
import { itemId as makeItemId } from "../core/sync/adapter";
import { defaultSettings } from "../core/settings";
import type { Item, ItemFilter, Settings } from "../core/models";
```

(`itemId` is aliased because `item_action` already binds an `itemId` argument name; `defaultSettings` joins the existing `../core/settings` import line if you prefer.)

Add the three handlers inside `createCommands`, after the AI block:

```ts
    // --- calendar -----------------------------------------------------------

    /** Everything on the calendar in a window, from both sources at once.
     *
     *  Subscribed events come from the item cache like every other widget's
     *  data; your own come from `calendar.json`, which exists because the cache
     *  is wiped and replaced on each sync. Recurrence is expanded here, on read
     *  — a weekly rule with no end has infinitely many occurrences and cannot
     *  be stored. */
    calendar_list: async ({ env, from, to }) => {
      const r = root(env);
      const start = parseInstant(String(from), "from");
      const end = parseInstant(String(to), "to");

      // `settings_load(...).unwrap_or_default()` in the Rust: a broken
      // settings file must not empty the calendar.
      let settings: Settings;
      try {
        settings = settingsLoad(r);
      } catch {
        settings = defaultSettings();
      }

      const filter: ItemFilter = { kind: "event", limit: 5000 };
      const specs: EventSpec[] = [];
      for (const item of cache.query(r, filter)) {
        const spec = specFromItem(item, settings);
        if (spec !== null) specs.push(spec);
      }

      const colour = settings.connections.find((c) => c.provider === "calendar.ics")?.config.color ?? "#00a99f";

      for (const event of calendar.load(r).events) {
        const spec = specFromLocal(event, colour);
        if (spec !== null) specs.push(spec);
      }

      return expand(specs, start, end);
    },

    calendar_event_save: async ({ env, event }) => {
      const r = root(env);
      const parsed = calendar.localEventFromJson(event);
      const withId =
        parsed.id.trim() === "" ? { ...parsed, id: `ev-${uuidIsh()}` } : parsed;
      return calendar.upsert(r, withId);
    },

    calendar_event_delete: async ({ env, id }) => {
      calendar.remove(root(env), String(id));
    },
```

and, next to the other module-level helpers in `commands.ts` (beside `findProject`), these four:

```ts
function parseInstant(value: string, field: string): Date {
  const at = calendar.parseRfc3339(value);
  // Note the message has no value in it — unlike `calendar/store.ts`'s.
  if (at === null) throw DddError.config(`${field} is not an RFC 3339 timestamp`);
  return at;
}

/** Rebuild an expandable event from what the adapter put in `refs`. */
function specFromItem(item: Item, settings: Settings): EventSpec | null {
  const pick = (prefix: string): string | null => {
    for (const r of item.refs) if (r.startsWith(prefix)) return r.slice(prefix.length);
    return null;
  };
  const all = (prefix: string): string[] =>
    item.refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));

  const connection = settings.connections.find((c) => c.id === item.connectionId);

  const startRef = pick("dtstart:");
  const endRef = pick("dtend:");
  if (startRef === null || endRef === null) return null;
  const start = calendar.parseRfc3339(startRef);
  const end = calendar.parseRfc3339(endRef);
  if (start === null || end === null) return null;

  const series = pick("series:");
  const recurrenceRef = pick("recurrenceid:");
  const recurrenceId = recurrenceRef === null ? null : calendar.parseRfc3339(recurrenceRef);
  const overrides: Override | null =
    series !== null && recurrenceId !== null
      ? // The series id must be the *item* id the series was stored under, not
        // the bare UID, or the override never matches anything.
        { seriesId: makeItemId(item.connectionId, series), recurrenceId }
      : null;

  return {
    id: item.id,
    title: item.title,
    start,
    end,
    allDay: pick("allday:") === "true",
    tzid: pick("tzid:"),
    rrule: pick("rrule:"),
    exdates: all("exdate:")
      .map((v) => calendar.parseRfc3339(v))
      .filter((d): d is Date => d !== null),
    overrides,
    calendar: pick("calendar:") ?? connection?.label ?? "Calendar",
    color: connection?.config.color ?? "#00a99f",
    // A subscribed feed is read-only. Offering an edit that the next sync
    // silently reverts would be worse than offering none.
    editable: false,
    location: pick("location:"),
    url: item.url,
  };
}

function specFromLocal(event: calendar.LocalEvent, color: string): EventSpec | null {
  const start = calendar.parseRfc3339(event.start);
  const end = calendar.parseRfc3339(event.end);
  if (start === null || end === null) return null;
  return {
    id: event.id,
    title: event.title,
    start,
    end,
    allDay: event.allDay,
    tzid: null,
    rrule: event.rrule,
    exdates: [],
    overrides: null,
    calendar: "My calendar",
    color,
    editable: true,
    location: null,
    url: null,
  };
}

/** Enough entropy for a local id. Not a security boundary — it only has to not
 *  collide inside one user's calendar file. The Rust formats nanoseconds since
 *  the epoch as hex; JS has milliseconds, so the sub-millisecond digits come
 *  from a random draw, which serves the same purpose. */
function uuidIsh(): string {
  return (BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000))).toString(16);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/main/commands.test.ts` — expected: PASS, including both contract tests.

- [ ] **Step 5: Full verification and commit**

Run: `npm test` and `npm run typecheck` — expected: all green.

```bash
git add src/main/commands.ts src/main/commands.test.ts
git commit -m "feat(main): calendar_list, calendar_event_save and calendar_event_delete"
```

<!-- deps/notes for the assembler -->
<!--
NEW NPM DEPENDENCIES
- rrule@2.8.1 (runtime `dependencies`, installed in Task 2 Step 1) — recurrence-rule
  expansion, the port of the Rust `rrule` crate. Pulls in `tslib@^2.4.0` only. No
  luxon, no other peer; needs `Intl` only, which Node 24 has. Its ESM entry uses
  extensionless relative imports, which vite/vitest and electron-vite resolve; the
  `main` field is the ES5 CJS build for anything that needs it.

WHAT OTHER SECTIONS MUST KNOW
- `src/core/sync/ics.ts` (Task 1) is where the shared RFC-3339/time-zone helpers live:
  `rfc3339(date)`, `isKnownZone(name)`, `utcToZoned(instant, tz)`, `zonedToUtc(wall, tz)`.
  `src/core/calendar/expand.ts` imports them from there rather than duplicating the
  local↔UTC rule. Any other section that needs chrono-compatible `to_rfc3339()`
  output should import `rfc3339` from `src/core/sync/ics.ts` too.
- `src/core/calendar/store.ts` (Task 2) exports `parseRfc3339(value): Date | null`,
  a strict `chrono::DateTime::parse_from_rfc3339` (an offset is mandatory).
  `src/main/commands.ts` uses it for `parse_instant`; any other command that parses a
  user-supplied timestamp should use it rather than bare `Date.parse`.
- Task 1 modifies `src/core/sync/providers.ts` (adds `case "calendar.ics"`). If another
  section also edits that file, expect a trivial merge in the same switch.
- Task 3 removes `calendar_list`, `calendar_event_save`, `calendar_event_delete` from
  `NOT_YET_PORTED` in `src/main/commands.test.ts`, and adds a module-level `uuidIsh()`
  helper to `src/main/commands.ts` — a later section wanting a minted id can reuse it.
- `Occurrence` (expand.ts) and `LocalEvent` (store.ts) match the renderer shapes in
  `src/renderer/src/types/index.ts` field for field; nothing imports across that line.

RUST BEHAVIOUR NOT REPRODUCED EXACTLY (each flagged in a code comment at the site)
1. Timestamp spelling. chrono's `to_rfc3339()` writes `2026-08-03T07:00:00+00:00`, so
   the Rust unit tests assert that text. The port's settled convention (conventions §
   "Timestamps") is `toISOString()`, i.e. `2026-08-03T07:00:00Z` — which is also what
   serde's chrono impl produces for the `Occurrence` payload that actually crosses IPC.
   `rfc3339()` strips the `.000` so whole-second instants are byte-identical to serde's
   output. The ported tests assert the `Z` form. Both spellings parse on both sides, so
   a cache.db written by either app still reads.
2. Non-existent local times. `zonedToUtc` in `ics.ts`: chrono's `.earliest()` returns
   None for the hour skipped when DST starts, and the Rust then drops the VEVENT
   entirely. This port keeps the event and places it at the first instant that does
   exist. Ambiguous times (the repeated hour) do resolve to the earlier instant, as the
   Rust does, and that case is tested.
3. Recurrence window end. The Rust calls `.before(to)`; `rrule`'s `between(from, to,
   true)` is inclusive at both ends, so an occurrence landing exactly on `to` is kept
   here and may not be there. The inclusive `from` end is the behaviour the Rust buys
   with its `- 1s` step back, and it is pinned by a test.
4. Recurrence zone arithmetic is done by hand, not by `rrule`. rrule@2.8.1's TZID
   support (`dateInTimeZone` in `dist/esm/dateutil.js`) computes the offset relative to
   the *machine's* zone and therefore yields different instants on different machines —
   verified. The rule is built with a floating `DTSTART` and the wall↔instant
   conversion happens in `utcToZoned`/`zonedToUtc`. Result verified identical to the
   Rust's expectations under TZ=UTC, America/New_York, Europe/Amsterdam and
   Pacific/Kiritimati; the tasks tell the implementer to re-run under those zones.
5. `uuid_ish()` is nanoseconds-since-epoch in hex; JS has only milliseconds, so the
   sub-millisecond digits are random. Same shape, same purpose (no collision inside one
   calendar file), not the same number.
6. `find_time`'s `head.contains("VALUE=DATE")` also matches `VALUE=DATE-TIME` in the
   Rust, marking such an event all-day. Ported as-is rather than fixed, so both apps
   agree; commented at the site.
-->

### Task 4: Link lookup, removal, canonical paths, and the scan walk

**Files:**
- Modify: `src/core/repos/links.ts` (it already has the types, `defaultRepoLinks`, `repoLinkFromJson`, `repoLinksFromJson`, `load`, `save`, `upsert` — read it first and add to it; do not rewrite what is there)
- Modify: `src/core/repos/links.test.ts` (append; keep every existing test)
- Create: `src/core/repos/scan.ts`
- Test: `src/core/repos/scan.test.ts`

**Interfaces:**
- Consumes: `RepoLink { remote: string | null; path: string; source: "scan" | "manual"; confidence: "exact" | "fallback" }`, `RepoLinks { links: RepoLink[]; scanRoots: string[]; preferredProtocol: string | null }`, `load(env)`, `save(env, links)`, `upsert(env, link)` from `src/core/repos/links.ts`; `fallbackKey(url): string | null` from `src/core/repos/remote.ts`; `gitRemote(dir): Promise<string | null>` from `src/core/projects.ts`; `DddError` from `src/core/error.ts`; `EnvRoot` from `src/core/paths.ts`; `scratchEnv(name)` from `src/core/testing.ts`.
- Produces: in `links.ts` — `remove(env, remote: string): void`, `removeByPath(env, path: string): void`, `find(links: RepoLinks, wanted: string): RepoLink | null`, `findWithTier(links: RepoLinks, normalized: string, https: string): { link: RepoLink; confidence: Confidence } | null`, `canonicalPath(path: string): string`. In `scan.ts` — `Found { path: string; url: string | null }`, `candidates(root: string): string[]`, `scanRoot(root: string): Promise<Found[]>`, `inferProtocol(found: Found[]): string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/repos/links.test.ts`, and extend its existing import line from `./links` to:

```ts
import { canonicalPath, find, findWithTier, load, remove, removeByPath, repoLinksFromJson, save, upsert, type RepoLinks } from "./links";
```

and add `mkdtempSync` and `rmSync` to the existing `node:fs` import, plus `tmpdir` from `node:os` and `join` from `node:path`:

```ts
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Then append:

```ts
describe("finding and removing links", () => {
  it("round-trips, replaces the same remote at a new path, and removes by remote", () => {
    const { env } = scratchEnv("roundtrip");
    expect(load(env).links).toEqual([]);

    upsert(env, { remote: "github.com/agitri/ddd", path: "/tmp/ddd", source: "scan", confidence: "exact" });
    // A repo cannot be in two places; the newest claim wins.
    upsert(env, { remote: "github.com/agitri/ddd", path: "/tmp/ddd-moved", source: "manual", confidence: "exact" });

    const stored = load(env);
    expect(stored.links).toHaveLength(1);
    expect(stored.links[0]!.path).toBe("/tmp/ddd-moved");
    expect(stored.links[0]!.source).toBe("manual");

    expect(find(stored, "github.com/agitri/ddd")).not.toBeNull();
    expect(find(stored, "github.com/agitri/other")).toBeNull();

    remove(env, "github.com/agitri/ddd");
    expect(load(env).links).toEqual([]);
  });

  it("never returns a checkout that has no remote", () => {
    const { env } = scratchEnv("find-skips-none");
    upsert(env, { remote: null, path: "/tmp/a", source: "scan", confidence: "exact" });
    expect(find(load(env), "github.com/agitri/ddd")).toBeNull();
  });

  it("removeByPath drops only that checkout", () => {
    const { env } = scratchEnv("remove-by-path");
    upsert(env, { remote: null, path: "/tmp/a", source: "scan", confidence: "exact" });
    upsert(env, { remote: null, path: "/tmp/b", source: "scan", confidence: "exact" });

    removeByPath(env, "/tmp/a");
    const stored = load(env);
    expect(stored.links).toHaveLength(1);
    expect(stored.links[0]!.path).toBe("/tmp/b");
  });

  it("removing an absent remote leaves other links untouched", () => {
    const { env } = scratchEnv("remove-absent");
    upsert(env, { remote: "github.com/agitri/ddd", path: "/tmp/ddd", source: "scan", confidence: "exact" });
    remove(env, "github.com/agitri/never-stored");

    const stored = load(env);
    expect(stored.links).toHaveLength(1);
    expect(stored.links[0]!.remote).toBe("github.com/agitri/ddd");
  });
});

describe("findWithTier reports the tier this lookup used", () => {
  const store = (link: { remote: string; path: string; confidence: "exact" | "fallback" }): RepoLinks => ({
    links: [{ remote: link.remote, path: link.path, source: "scan", confidence: link.confidence }],
    scanRoots: [],
    preferredProtocol: null,
  });

  it("reports exact even when the stored link itself is fallback", () => {
    // The stored link's own confidence is fallback, but this lookup found it
    // via the exact `remote:` key — the join's own tier wins.
    const stored = store({ remote: "github.com/agitri/ddd", path: "/repo", confidence: "fallback" });
    const matched = findWithTier(stored, "github.com/agitri/ddd", "https://github.com/agitri/ddd");
    expect(matched).not.toBeNull();
    expect(matched!.link.path).toBe("/repo");
    expect(matched!.confidence).toBe("exact");
  });

  it("reports fallback even when the stored link itself is exact", () => {
    // The regression case: the exact `remote:` key does not match (a different
    // host), but owner/repo does. The stored link says exact — because *it* was
    // established with full confidence — but *this* lookup only found it
    // through the weak tier, so the row must say so.
    const stored = store({ remote: "gitlab.com/agitri/ddd", path: "/repo", confidence: "exact" });
    const matched = findWithTier(stored, "github.com/agitri/ddd", "https://github.com/agitri/ddd");
    expect(matched).not.toBeNull();
    expect(matched!.link.path).toBe("/repo");
    expect(matched!.confidence).toBe("fallback");
  });

  it("returns null when neither key matches", () => {
    const stored = store({ remote: "gitlab.com/other/thing", path: "/elsewhere", confidence: "exact" });
    expect(findWithTier(stored, "github.com/agitri/ddd", "https://github.com/agitri/ddd")).toBeNull();
  });

  it("cannot produce a false positive from an empty key", () => {
    // A repo whose URL failed to normalize has no `remote:` ref, so the caller
    // passes an empty string. With no `https:` ref either there is nothing to
    // key a fallback off — an empty query key must not act as a wildcard.
    const stored = store({ remote: "github.com/agitri/ddd", path: "/repo", confidence: "exact" });
    expect(findWithTier(stored, "", "")).toBeNull();
  });

  it("skips a checkout with no remote at the fallback tier too", () => {
    const stored: RepoLinks = { links: [{ remote: null, path: "/repo", source: "scan", confidence: "exact" }], scanRoots: [], preferredProtocol: null };
    expect(findWithTier(stored, "github.com/agitri/ddd", "https://github.com/agitri/ddd")).toBeNull();
  });
});

describe("canonicalPath", () => {
  it("resolves a real path and throws io for one that is not there", () => {
    const dir = mkdtempSync(join(tmpdir(), "ddd-canon-"));
    // Not compared against `dir` itself: a macOS temp dir lives behind a
    // symlink (/var → /private/var), which is exactly what this has to resolve.
    expect(canonicalPath(dir)).toBe(realpathSync(dir));
    // Every spelling of the same folder collapses to one string — the whole
    // reason the link store goes through this.
    expect(canonicalPath(join(dir, "."))).toBe(canonicalPath(dir));
    expect(canonicalPath(`${dir}/`)).toBe(canonicalPath(dir));
    // A path that vanished between being found and being stored is a real
    // error, not something to paper over by falling back to the raw path.
    expect(() => canonicalPath(join(dir, "does-not-exist"))).toThrow(/^io: /);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

`src/core/repos/scan.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidates, inferProtocol, scanRoot, type Found } from "./scan";

const tempRoot = (name: string) => mkdtempSync(join(tmpdir(), `ddd-scan-${name}-`));

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

function makeRepo(root: string, name: string, remote: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["remote", "add", "origin", remote]);
  return dir;
}

function makeCheckoutWithoutRemote(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  return dir;
}

const at = (found: Found[], name: string) => found.find((f) => basename(f.path) === name);

describe("scanRoot", () => {
  it("finds repos one level down and skips everything else", async () => {
    const root = tempRoot("basic");
    makeRepo(root, "ddd", "git@github.com:agitri/ddd.git");
    makeRepo(root, "renter", "https://github.com/agitri/renter.git");
    mkdirSync(join(root, "just-a-folder"));
    writeFileSync(join(root, "a-file.txt"), "x");

    const found = await scanRoot(root);
    expect(found).toHaveLength(2);
    expect(at(found, "ddd")!.url).toContain("agitri/ddd");
    // Stable order so a rescan produces a diffable result.
    expect(found.map((f) => basename(f.path))).toEqual(["ddd", "renter"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a checkout that has no origin", async () => {
    // Discarding these is how two thirds of a real projects folder became
    // invisible: a scratch repo is still a repository.
    const root = tempRoot("no-origin");
    makeRepo(root, "ddd", "git@github.com:agitri/ddd.git");
    makeCheckoutWithoutRemote(root, "scratch");

    const found = await scanRoot(root);
    expect(found).toHaveLength(2);
    expect(at(found, "scratch")!.url).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a worktree whose .git is a file", async () => {
    // `git worktree` and submodules write `.git` as a *file* holding a gitdir:
    // pointer. The filter deliberately tests only for existence, so these are
    // found — a future `.isDirectory()` "tidy-up" would silently drop every
    // worktree on the machine.
    const root = tempRoot("worktree");
    const dir = join(root, "linked");
    mkdirSync(dir);
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n");

    const found = await scanRoot(root);
    expect(found).toHaveLength(1);
    expect(basename(found[0]!.path)).toBe("linked");
    // git cannot resolve a remote through a dangling gitdir pointer, so it
    // arrives remote-less — exactly the case the store now keeps.
    expect(found[0]!.url).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("follows a symlinked checkout", async () => {
    // A projects folder full of symlinks into an external drive is a normal
    // layout. The path stored is the link; canonicalization at the call site
    // resolves it.
    const root = tempRoot("symlink");
    const real = makeRepo(root, "real", "git@github.com:agitri/real.git");
    symlinkSync(real, join(root, "via-link"));

    const found = await scanRoot(root);
    expect(found.map((f) => basename(f.path)).sort()).toEqual(["real", "via-link"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("yields nothing for a root that is missing or is a file, rather than erroring", async () => {
    // A scan root the user deleted, or picked wrongly, is an empty result —
    // `repo_scan` checks isDir and reports, so this layer stays total.
    const root = tempRoot("bad-root");
    expect(await scanRoot(join(root, "does-not-exist"))).toEqual([]);
    const file = join(root, "a-file.txt");
    writeFileSync(file, "x");
    expect(await scanRoot(file)).toEqual([]);
    expect(candidates(file)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("inferProtocol", () => {
  const found = (...urls: (string | null)[]): Found[] => urls.map((url, i) => ({ path: `/p${i}`, url }));

  it("infers the protocol the user actually uses", () => {
    expect(
      inferProtocol(
        found("git@github.com:a/b.git", "git@github.com:c/d.git", "https://github.com/e/f.git", null),
      ),
    ).toBe("ssh");
    expect(inferProtocol([])).toBeNull();
  });

  it("infers nothing from a root of remote-less checkouts", () => {
    // The same answer as an empty root, and for the same reason: nothing to
    // infer from.
    expect(inferProtocol(found(null, null))).toBeNull();
  });

  it("breaks ties towards ssh", () => {
    // Exactly half SSH is the boundary `ssh * 2 >= len` decides. An HTTPS clone
    // of a private repo fails confusingly without a credential helper, where
    // SSH at least fails at a key the user recognises.
    expect(inferProtocol(found("git@github.com:a/b.git", "https://github.com/c/d.git"))).toBe("ssh");
    expect(
      inferProtocol(found("git@github.com:a/b.git", "https://github.com/c/d.git", "https://github.com/e/f.git")),
    ).toBe("https");
  });

  it("counts ssh urls in both spellings", () => {
    expect(inferProtocol(found("ssh://git@github.com/a/b.git", "git@github.com:c/d.git"))).toBe("ssh");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/repos/links.test.ts src/core/repos/scan.test.ts` — expected: the links tests fail on `remove is not a function` (and the import of `canonicalPath`/`findWithTier`), the scan tests fail to resolve `./scan`.

- [ ] **Step 3: Write the modules**

Append to `src/core/repos/links.ts` (keep everything already in the file; add `realpathSync` from `node:fs` and `fallbackKey` from `./remote` to the imports):

```ts
import { realpathSync } from "node:fs";
import { fallbackKey } from "./remote";
```

```ts
export function remove(env: EnvRoot, remote: string): void {
  const stored = load(env);
  stored.links = stored.links.filter((existing) => existing.remote !== remote);
  save(env, stored);
}

/** Drop the record at `path`. How a local-only checkout is forgotten, since it
 *  may have no remote to name it by. */
export function removeByPath(env: EnvRoot, path: string): void {
  const stored = load(env);
  stored.links = stored.links.filter((existing) => existing.path !== path);
  save(env, stored);
}

/** The exact-tier lookup. Skips records with no remote by construction (`null`
 *  never equals the wanted string): a local-only checkout must never satisfy a
 *  GitHub row's join. */
export function find(links: RepoLinks, wanted: string): RepoLink | null {
  return links.links.find((link) => link.remote === wanted) ?? null;
}

/**
 * Find a link for a repo, and report **which tier matched**.
 *
 * Two tiers: the full normalized remote including host, then `owner/repo`
 * alone. The fallback exists because a stored link may have been made from a
 * remote we can no longer reproduce exactly (an SSH alias, a host that moved, a
 * link created by hand with no `remote:` ref at all).
 *
 * When the two disagree the caller must report the *weaker* of them, because
 * the guess was made here, in this join, not when the link was stored.
 * Reporting the link's own stored confidence would show a guess as a certainty
 * — exactly what the two-tier design exists to prevent.
 */
export function findWithTier(links: RepoLinks, normalized: string, https: string): { link: RepoLink; confidence: Confidence } | null {
  const exact = find(links, normalized);
  if (exact !== null) return { link: exact, confidence: "exact" };
  const wanted = fallbackKey(https);
  if (wanted === null) return null;
  // A checkout with no remote has nothing to fall back *to*; it must never
  // satisfy a GitHub row's join at either tier.
  const match = links.links.find((l) => l.remote !== null && fallbackKey(l.remote) === wanted);
  return match === undefined ? null : { link: match, confidence: "fallback" };
}

/**
 * Canonicalize a path for storage in the link store.
 *
 * The canonical form `projects.register` always stores for a `ProjectRef.path`.
 * `repos_list` resolves a row's `projectId` by comparing a stored link's `path`
 * against that registry with plain string equality — so a path stored in any
 * other form (the raw string the user picked, a trailing slash, through a
 * symlink) would never compare equal, and `projectId` would silently stay null
 * forever: the row would show as linked but never connect to its project card.
 *
 * Every write into the link store must go through this so that join keeps
 * working. A path that vanished between being found and being stored (a race
 * with the picker, or a scan racing a delete) is a real error, not something to
 * paper over by falling back to the raw path.
 */
export function canonicalPath(path: string): string {
  try {
    // Rust's `canonicalize` yields a `\\?\` prefix on Windows; `realpathSync`
    // does not — the same deviation `projects.register` already documents.
    return realpathSync(path);
  } catch (e) {
    throw DddError.io(e);
  }
}
```

`src/core/repos/scan.ts`:

```ts
/**
 * Walking a folder the user nominated, reading each checkout's origin. Port of
 * `repos/scan.rs`.
 *
 * One level deep and read-only. Depth one is not a limitation to work around —
 * it is what makes the walk fast and predictable, and it matches how people
 * actually lay out a projects folder.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitRemote } from "../projects";

/** One git checkout directly inside a scan root, with its raw origin url. */
export interface Found {
  path: string;
  url: string | null;
}

function isDir(path: string): boolean {
  try {
    // `statSync` follows symlinks, as Rust's `is_dir()` does — a projects
    // folder full of symlinks is a normal layout.
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every git checkout directly inside `root`, sorted, without asking git
 * anything. Split out from `scanRoot` because it is the whole filesystem half
 * and stays synchronous and pure — the Rust does both in one iterator chain,
 * but `gitRemote` is async in this port.
 */
export function candidates(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found = entries
    .map((name) => join(root, name))
    // Existence only, never `.isDirectory()`: `git worktree` and submodules
    // write `.git` as a *file* holding a gitdir: pointer, and those are real
    // checkouts.
    .filter((path) => isDir(path) && existsSync(join(path, ".git")));
  // The Rust sorts the (path, url) pairs after collecting; paths are unique, so
  // sorting them before the lookups is the same order.
  found.sort();
  return found;
}

/**
 * `(directory, raw origin url)` for every git checkout directly inside `root`.
 *
 * The origin is optional and a `null` is kept, not dropped. A checkout with no
 * resolvable origin — a scratch repo, an SSH alias git cannot expand, one whose
 * remote was never added — is still a repository, and discarding it here is how
 * two thirds of a real projects folder became invisible.
 */
export async function scanRoot(root: string): Promise<Found[]> {
  const found: Found[] = [];
  // Sequential, like the Rust's iterator: the order is the stored order, and a
  // scan root is a handful of folders, not a fan-out worth parallelising.
  for (const path of candidates(root)) found.push({ path, url: await gitRemote(path) });
  return found;
}

/**
 * Which protocol the user's existing clones use, so a new clone matches.
 *
 * An HTTPS clone of a private repo fails confusingly without a credential
 * helper, and SSH fails just as confusingly without keys — so guess from
 * evidence rather than from a default.
 */
export function inferProtocol(found: Found[]): string | null {
  // Only checkouts with a readable remote are evidence. A root of entirely
  // remote-less checkouts yields null, the same answer as an empty root and for
  // the same reason: nothing to infer from.
  const urls = found.map((f) => f.url).filter((url): url is string => url !== null);
  if (urls.length === 0) return null;
  const ssh = urls.filter((url) => url.startsWith("git@") || url.startsWith("ssh://")).length;
  return ssh * 2 >= urls.length ? "ssh" : "https";
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/core/repos/links.test.ts src/core/repos/scan.test.ts` — expected: PASS (the scan tests shell out to the real `git`, which is allowed).

- [ ] **Step 5: Commit**

```bash
git add src/core/repos/links.ts src/core/repos/links.test.ts src/core/repos/scan.ts src/core/repos/scan.test.ts
git commit -m "feat(repos): link lookup with match tiers, canonical paths, and the scan walk"
```

### Task 5: Cloning, detached

**Files:**
- Create: `src/core/repos/clone.ts`
- Test: `src/core/repos/clone.test.ts`

**Interfaces:**
- Consumes: `canonicalPath`, `upsert`, `RepoLink` from `src/core/repos/links.ts` (Task 4); `register`, `GIT_EXEC_OPTIONS` from `src/core/projects.ts`; `DddError` from `src/core/error.ts`; `EnvRoot` from `src/core/paths.ts`; `scratchEnv` from `src/core/testing.ts`.
- Produces: `Progress { phase: string; percent: number; done: boolean; error: string | null }`, `SpawnLike`, `prepare(parent: string, remote: string): string`, `targetDir(parent: string, remote: string): string`, `parseProgress(line: string): { phase: string; percent: number } | null`, `run(env, remote, cloneUrl, target, onProgress: (p: Progress) => void, spawnFn?: SpawnLike): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`src/core/repos/clone.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registry } from "../projects";
import { scratchEnv } from "../testing";
import { parseProgress, prepare, run, targetDir, type Progress } from "./clone";
import { canonicalPath, find, load } from "./links";

const scratch = (name: string) => mkdtempSync(join(tmpdir(), `ddd-clone-${name}-`));

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

/**
 * A bare repository with one commit in it, to clone from. Cloning from a
 * `file://` URL is a real clone over git's transport layer: git forks
 * git-upload-pack and emits the same carriage-return progress stream a network
 * clone does. The scheme is what forces it — handed a bare path, git shortcuts
 * a same-filesystem clone to a hardlink copy and prints no progress at all,
 * which would leave the stderr parsing (the most fragile part of this module)
 * untested while still passing.
 */
function originRepo(root: string): string {
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-q"]);
  git(seed, ["config", "user.email", "test@example.dev"]);
  git(seed, ["config", "user.name", "Test"]);
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "first"]);
  const bare = join(root, "origin.git");
  execFileSync("git", ["clone", "--bare", "-q", seed, bare], { stdio: "ignore" });
  return bare;
}

describe("parseProgress", () => {
  it("reads percentages out of git progress lines", () => {
    expect(parseProgress("Receiving objects:  41% (4100/10000), 1.2 MiB")).toEqual({ phase: "Receiving objects", percent: 41 });
    expect(parseProgress("Resolving deltas: 100% (500/500), done.")).toEqual({ phase: "Resolving deltas", percent: 100 });
  });

  it("ignores lines that are not progress", () => {
    expect(parseProgress("Cloning into 'ddd'...")).toBeNull();
    expect(parseProgress("")).toBeNull();
  });

  it("clamps over 100 and rejects unparseable numbers", () => {
    // git never actually emits these, but a hostile or truncated line must not
    // panic — clamp what parses, reject what does not.
    expect(parseProgress("Counting objects: 150% (150/100), done.")).toEqual({ phase: "Counting objects", percent: 100 });
    expect(parseProgress("Counting objects: abc% (0/0)")).toBeNull();
    // The Rust parses into a u8 before clamping, so anything over 255 is not a
    // number it accepts at all.
    expect(parseProgress("Counting objects: 300% (1/1)")).toBeNull();
  });
});

describe("prepare and targetDir", () => {
  it("puts the clone at the repo name under the parent, ignoring a trailing slash", () => {
    expect(targetDir("/tmp", "github.com/agitri/ddd")).toBe(join("/tmp", "ddd"));
    expect(targetDir("/tmp", "github.com/agitri/ddd/")).toBe(join("/tmp", "ddd"));
  });

  it("refuses a missing parent and a non-empty target, but allows an empty one", () => {
    const root = scratch("prepare");
    expect(() => prepare(join(root, "nowhere"), "github.com/a/b")).toThrow(`${join(root, "nowhere")} is not a directory`);

    const occupied = join(root, "b");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "something"), "x");
    expect(() => prepare(root, "github.com/a/b")).toThrow(`${occupied} already exists and is not empty`);

    // An *empty* directory is fine — that is a picker artefact, not a repo.
    mkdirSync(join(root, "c"));
    expect(prepare(root, "github.com/a/c")).toBe(join(root, "c"));
    rmSync(root, { recursive: true, force: true });
  });
});

describe("run", () => {
  it(
    "clones for real, and links and registers the result",
    async () => {
      const home = scratchEnv("clone-e2e");
      const root = scratch("e2e");
      const origin = originRepo(root);
      const parent = join(root, "into");
      mkdirSync(parent, { recursive: true });

      const remote = "github.com/agitri/origin";
      const target = prepare(parent, remote);
      const ticks: Progress[] = [];
      await run(home.env, remote, `file://${origin}`, target, (p) => ticks.push(p));

      const last = ticks[ticks.length - 1]!;
      expect(last).toEqual({ phase: "Done", percent: 100, done: true, error: null });
      expect(ticks[0]).toEqual({ phase: "Starting", percent: 0, done: false, error: null });

      // The point of the exercise: git's carriage-return progress stream was
      // parsed, not merely survived. If this ever fails because the fixture is
      // too small for git to bother reporting, the parser is untested again and
      // the fixture needs to grow — not this assertion.
      expect(ticks.some((t) => t.phase !== "Starting" && t.phase !== "Done")).toBe(true);

      // The checkout is really there.
      expect(existsSync(join(target, "README.md"))).toBe(true);

      // …and the link store and project registry both know about it, at the
      // canonical path the projectId join depends on.
      const link = find(load(home.env), remote);
      expect(link).not.toBeNull();
      expect(link!.path).toBe(canonicalPath(target));
      expect(link!.source).toBe("manual");
      expect(link!.confidence).toBe("exact");
      expect(registry(home.env).projects.some((p) => p.path === link!.path)).toBe(true);

      rmSync(root, { recursive: true, force: true });
    },
    30000,
  );

  it(
    "reports git's own words when the clone fails, and stores nothing",
    async () => {
      const home = scratchEnv("clone-fails");
      const root = scratch("fail");
      const parent = join(root, "into");
      mkdirSync(parent, { recursive: true });

      const remote = "github.com/agitri/nope";
      const target = prepare(parent, remote);
      const ticks: Progress[] = [];
      await run(home.env, remote, `file://${join(root, "does-not-exist")}`, target, (p) => ticks.push(p));

      const last = ticks[ticks.length - 1]!;
      expect(last.done).toBe(true);
      expect(last.phase).toBe("Failed");
      expect(last.percent).toBe(0);
      // git's own tail, not a message of ours.
      expect(last.error).toContain("does not appear to be a git repository");

      // Nothing half-linked: a failed clone leaves the store as it found it.
      expect(load(home.env).links).toEqual([]);
      expect(registry(home.env).projects).toEqual([]);

      rmSync(root, { recursive: true, force: true });
    },
    30000,
  );

  it("reports a git that will not start, through the injected spawn", async () => {
    const home = scratchEnv("clone-no-git");
    const never = join(tmpdir(), "ddd-clone-never-created");
    const ticks: Progress[] = [];
    await run(home.env, "github.com/a/b", "file:///nowhere", never, (p) => ticks.push(p), () => {
      throw new Error("spawn git ENOENT");
    });
    expect(ticks[ticks.length - 1]).toEqual({ phase: "Failed", percent: 0, done: true, error: "could not start git: spawn git ENOENT" });
    expect(existsSync(never)).toBe(false);
    expect(load(home.env).links).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/repos/clone.test.ts` — expected: cannot resolve `./clone`.

- [ ] **Step 3: Write the module**

`src/core/repos/clone.ts`:

```ts
/**
 * Cloning, detached. Port of `repos/clone.rs`.
 *
 * A large clone takes minutes, and a command that blocks that long looks like a
 * hung app. So the work is spawned and progress is pushed over the same event
 * channel the file watcher already uses — the row updates itself exactly the
 * way a todo does.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DddError } from "../error";
import type { EnvRoot } from "../paths";
import { GIT_EXEC_OPTIONS, register } from "../projects";
import { canonicalPath, upsert } from "./links";

/**
 * One progress tick. Deliberately not the IPC event payload: the caller maps
 * this into whatever it emits, so the clone itself knows nothing about windows
 * or serialization — which is also what lets a test run a real clone and simply
 * collect these.
 */
export interface Progress {
  phase: string;
  percent: number;
  done: boolean;
  error: string | null;
}

const step = (phase: string, percent: number): Progress => ({ phase, percent, done: false, error: null });
const finished = (): Progress => ({ phase: "Done", percent: 100, done: true, error: null });
const failed = (error: string): Progress => ({ phase: "Failed", percent: 0, done: true, error });

/** How many trailing stderr lines to keep for a failure message. */
const TAIL_LINES = 20;

/** The subprocess runner, injectable so a test can make `git` fail to start.
 *  The default is the real `node:child_process` `spawn`. */
export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check a clone can start, and say where it would land.
 *
 * Separate from `run` because this is the part the caller must do *before*
 * detaching: a refusal has to reach the user as a failed command, not as a
 * progress event nobody is listening for yet.
 */
export function prepare(parent: string, remote: string): string {
  if (!isDir(parent)) throw DddError.notFound(`${parent} is not a directory`);
  const target = targetDir(parent, remote);
  // Refuse rather than merge into something that is already there — a
  // half-finished checkout that showed up some other way is not ours to
  // overwrite silently.
  let occupied = false;
  if (existsSync(target)) {
    try {
      occupied = readdirSync(target).length > 0;
    } catch {
      // The Rust's `.unwrap_or(false)`: unreadable is not "occupied".
      occupied = false;
    }
  }
  if (occupied) throw DddError.config(`${target} already exists and is not empty`);
  return target;
}

/**
 * Where a clone of `remote` lands under `parent`.
 *
 * `remote` is a normalized `host/owner/repo` string, sometimes with a trailing
 * slash depending on where it came from — trim it before taking the last
 * segment, or a trailing slash would name the folder "".
 */
export function targetDir(parent: string, remote: string): string {
  const trimmed = remote.replace(/\/+$/, "");
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return join(parent, last === "" ? "repo" : last);
}

/**
 * `Receiving objects:  41% (…)` → `{ phase: "Receiving objects", percent: 41 }`.
 *
 * A percentage git never actually emits (over 100, or too big to fit a `u8` at
 * all) must not blow up: it clamps what parses and rejects what doesn't, same
 * as any other malformed line.
 */
export function parseProgress(line: string): { phase: string; percent: number } | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const phase = line.slice(0, colon);
  const rest = line.slice(colon + 1);
  const percentIndex = rest.indexOf("%");
  if (percentIndex < 0) return null;
  const head = rest.slice(0, percentIndex);
  let i = head.length;
  while (i > 0 && head[i - 1]! >= "0" && head[i - 1]! <= "9") i--;
  const digits = head.slice(i);
  if (digits === "") return null;
  const percent = Number(digits);
  // The Rust parses into a `u8` first: anything over 255 is not a number it
  // accepts, and only what parses is then clamped to 100.
  if (percent > 255) return null;
  return { phase: phase.trim(), percent: Math.min(percent, 100) };
}

/**
 * Run the clone to completion, reporting progress as it goes.
 *
 * On success the repo is linked and registered as a project, because a clone is
 * just a link plus the fetch that makes it true.
 */
export function run(
  env: EnvRoot,
  remote: string,
  cloneUrl: string,
  target: string,
  onProgress: (p: Progress) => void,
  spawnFn: SpawnLike = nodeSpawn,
): Promise<void> {
  return new Promise((resolve) => {
    onProgress(step("Starting", 0));

    let child: ChildProcess;
    try {
      child = spawnFn("git", ["clone", "--progress", cloneUrl, target], {
        stdio: ["ignore", "ignore", "pipe"],
        // The Rust inherits the environment; this port shares `projects.ts`'s
        // GIT_TERMINAL_PROMPT=0 so a credential prompt fails instead of hanging
        // a clone forever behind a window that cannot answer it.
        env: GIT_EXEC_OPTIONS.env,
      });
    } catch (e) {
      onProgress(failed(`could not start git: ${e instanceof Error ? e.message : String(e)}`));
      return resolve();
    }

    // git writes progress to stderr, one carriage-return-delimited chunk at a
    // time rather than one line at a time — reading by line would sit blocked
    // until the whole clone finished.
    const tail: string[] = [];
    let buffer = "";
    const take = (chunk: string): void => {
      const line = chunk.trim();
      if (line === "") return;
      const parsed = parseProgress(line);
      if (parsed !== null) onProgress(step(parsed.phase, parsed.percent));
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (data: string) => {
      buffer += data;
      const parts = buffer.split("\r");
      // The last piece may be half a chunk; hold it until more arrives.
      buffer = parts.pop() ?? "";
      for (const part of parts) take(part);
    });

    // Node reports a failure to start asynchronously, where Rust's `spawn()`
    // returns the error directly — same message, later.
    let spawnError: Error | null = null;
    child.once("error", (e: Error) => {
      spawnError = e;
    });

    child.once("close", (code: number | null) => {
      take(buffer);
      buffer = "";
      if (spawnError !== null) {
        onProgress(failed(`could not start git: ${(spawnError as Error).message}`));
        return resolve();
      }
      if (code === 0) {
        let canonical: string;
        try {
          // See `links.canonicalPath`: the link's path must be canonical or
          // `repos_list`'s projectId join against the registry's canonicalized
          // `ProjectRef.path` never fires for this repo. The target didn't
          // exist before the clone, so this is the first point canonicalizing
          // it is even possible.
          canonical = canonicalPath(target);
        } catch (e) {
          onProgress(failed(`clone finished but ${e instanceof Error ? e.message : String(e)}`));
          return resolve();
        }
        try {
          upsert(env, { remote, path: canonical, source: "manual", confidence: "exact" });
        } catch {
          // The Rust's `let _ =`: a store that will not take the link does not
          // un-clone the repo.
        }
        try {
          // `projects.register` does its own canonicalization of `path`,
          // independently of the one above — the same split `repo_link` uses.
          register(env, target);
        } catch {
          /* see above */
        }
        onProgress(finished());
        return resolve();
      }
      // A partial checkout is reported, never deleted — destroying a
      // half-finished download of a large repo is worse than leaving a folder
      // to clean up.
      onProgress(failed(tail.join("\n")));
      resolve();
    });
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/repos/clone.test.ts` — expected: PASS. The two end-to-end tests run the real `git` against a `file://` URL on the local disk; there is no network access anywhere in them.

- [ ] **Step 5: Commit**

```bash
git add src/core/repos/clone.ts src/core/repos/clone.test.ts
git commit -m "feat(repos): clone with carriage-return progress, linking and registering on success"
```

### Task 6: The seven repo commands

**Files:**
- Modify: `src/main/commands.ts`
- Modify: `src/main/commands.test.ts`

**Interfaces:**
- Consumes: `links.load/save/upsert/remove/removeByPath/findWithTier/canonicalPath` from `src/core/repos/links.ts`; `scan.scanRoot/inferProtocol` from `src/core/repos/scan.ts`; `clone.prepare/run/Progress` from `src/core/repos/clone.ts`; `normalize` from `src/core/repos/remote.ts`; `repoFilterFromJson` from `src/core/repos/filter.ts`; `cache.query` from `src/core/sync/cache.ts`; `projects.registry/register/gitRemote` from `src/core/projects.ts`; `deps.emit` (`Emitter`).
- Produces: commands `repos_list`, `repo_scan`, `repo_link`, `repo_unlink`, `repo_add_local`, `repo_forget`, `repo_clone`, and the `ddd://repo-progress` event with payload `{ remote, phase, percent, done, error }`.

- [ ] **Step 1: Write the failing tests**

In `src/main/commands.test.ts`, first remove these seven names from `NOT_YET_PORTED`: `repos_list`, `repo_scan`, `repo_link`, `repo_unlink`, `repo_add_local`, `repo_forget`, `repo_clone`. The set keeps its other entries exactly as they are.

Then extend the existing imports (add `execFileSync`, `rmSync`, `Item`, the cache writer and the link store):

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Item } from "../core/models";
import { replaceForConnection } from "../core/sync/cache";
import * as links from "../core/repos/links";
import { normalize } from "../core/repos/remote";
```

and append at the end of the file:

```ts
const repoTemp = (name: string) => mkdtempSync(join(tmpdir(), `ddd-cmd-repo-${name}-`));

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

function makeRepo(root: string, name: string, remote: string | null): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  if (remote !== null) git(dir, ["remote", "add", "origin", remote]);
  return dir;
}

/** A GitHub repo item exactly as `sync/github.ts`'s `toRepoItem` writes one. */
function repoItem(name: string, url: string, sshUrl: string, pushedAt: string): Item {
  const normalized = normalize(url);
  const refs = [`repo:${name}`];
  if (normalized !== null) refs.push(`remote:${normalized}`);
  refs.push(`https:${url}`);
  if (sshUrl !== "") refs.push(`ssh:${sshUrl}`);
  return {
    id: `gh-1:repo-${name}`,
    environmentId: "default",
    connectionId: "gh-1",
    source: "github",
    kind: "repo",
    project: name,
    title: name,
    body: "private · typescript",
    url,
    refs,
    actions: [{ id: "open", label: "Open on GitHub", outbound: false }],
    updatedAt: pushedAt,
    unread: false,
  };
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

interface RepoListing {
  rows: { nameWithOwner: string; url: string; remote: string; cloneUrl: string; facts: string; pushedAt: string; localPath: string | null; matchConfidence: string | null; missing: boolean; projectId: string | null }[];
  localOnly: { path: string; name: string; origin: string | null; originHost: string | null; missing: boolean; projectId: string | null }[];
  capped: boolean;
  total: number;
}

describe("repos_list", () => {
  it("joins the cache with the link store, reports the tier its own join used, and derives local-only", async () => {
    const { env } = scratchEnv("cmd-repos-list");
    const root = repoTemp("list");
    const here = realpathSync(makeRepo(root, "ddd", "git@github.com:agitri/ddd.git"));
    const loose = realpathSync(makeRepo(root, "loose", null));

    replaceForConnection(env, "gh-1", [
      repoItem("agitri/ddd", "https://github.com/agitri/ddd", "git@github.com:agitri/ddd.git", daysAgo(2)),
      repoItem("agitri/forked", "https://github.com/agitri/forked", "git@github.com:agitri/forked.git", daysAgo(3)),
      repoItem("agitri/ancient", "https://github.com/agitri/ancient", "", daysAgo(400)),
      // An `updatedAt` nothing can parse counts as fresh rather than vanishing.
      repoItem("agitri/undated", "https://github.com/agitri/undated", "", ""),
    ]);

    links.save(env, {
      links: [
        { remote: "github.com/agitri/ddd", path: here, source: "scan", confidence: "exact" },
        // Same owner/repo, different host: the weak tier is the only one that
        // can match this, so the row must say "fallback".
        { remote: "gitlab.com/agitri/forked", path: "/nowhere/forked", source: "manual", confidence: "exact" },
        { remote: null, path: loose, source: "manual", confidence: "exact" },
      ],
      scanRoots: [],
      preferredProtocol: "ssh",
    });
    const project = register(env, here);

    const recent = (await commands.repos_list!({ env: "default", filter: {} })) as RepoListing;
    expect(recent.total).toBe(4);
    expect(recent.capped).toBe(false);
    expect(recent.rows.map((r) => r.nameWithOwner)).toEqual(["agitri/ddd", "agitri/forked", "agitri/undated"]);

    const ddd = recent.rows[0]!;
    expect(ddd).toMatchObject({
      url: "https://github.com/agitri/ddd",
      remote: "github.com/agitri/ddd",
      // preferredProtocol "ssh" and an ssh ref present.
      cloneUrl: "git@github.com:agitri/ddd.git",
      facts: "private · typescript",
      localPath: here,
      matchConfidence: "exact",
      missing: false,
      projectId: project.id,
    });

    const forked = recent.rows[1]!;
    expect(forked.matchConfidence).toBe("fallback");
    expect(forked.localPath).toBe("/nowhere/forked");
    // Linked, but the folder is not there right now.
    expect(forked.missing).toBe(true);
    expect(forked.projectId).toBeNull();

    // No ssh ref: the https URL, whatever the preferred protocol says.
    expect(recent.rows[2]!.cloneUrl).toBe("https://github.com/agitri/undated");

    // Everything DDD knows is a checkout, minus what the rows took.
    expect(recent.localOnly).toEqual([
      { path: loose, name: "loose", origin: null, originHost: null, missing: false, projectId: null },
    ]);

    const all = (await commands.repos_list!({ env: "default", filter: { scope: "all" } })) as RepoListing;
    expect(all.rows.map((r) => r.nameWithOwner)).toEqual(["agitri/ddd", "agitri/forked", "agitri/ancient", "agitri/undated"]);

    // The query narrows rows by title and local-only rows by name or remote.
    const narrowed = (await commands.repos_list!({ env: "default", filter: { scope: "all", query: "LOOSE" } })) as RepoListing;
    expect(narrowed.rows).toEqual([]);
    expect(narrowed.localOnly.map((l) => l.name)).toEqual(["loose"]);
    expect(narrowed.total).toBe(4);

    rmSync(root, { recursive: true, force: true });
  });

  it("reports the origin host of a local-only checkout for the badge", async () => {
    const { env } = scratchEnv("cmd-repos-local-host");
    links.save(env, {
      links: [{ remote: "gitlab.com/agitri/thing", path: "/p/thing", source: "manual", confidence: "exact" }],
      scanRoots: [],
      preferredProtocol: null,
    });
    const listing = (await commands.repos_list!({ env: "default", filter: {} })) as RepoListing;
    expect(listing.rows).toEqual([]);
    expect(listing.localOnly[0]).toEqual({ path: "/p/thing", name: "thing", origin: "gitlab.com/agitri/thing", originHost: "gitlab.com", missing: true, projectId: null });
  });
});

describe("repo_scan, repo_link, repo_unlink, repo_add_local, repo_forget", () => {
  it("scans a root, counting distinct persisted links and storing canonical paths", async () => {
    const { env } = scratchEnv("cmd-scan");
    const root = repoTemp("scan");
    const withRemote = realpathSync(makeRepo(root, "ddd", "git@github.com:agitri/ddd.git"));
    const without = realpathSync(makeRepo(root, "scratch", null));
    mkdirSync(join(root, "just-a-folder"));

    expect(await commands.repo_scan!({ env: "default", rootDir: root })).toBe(2);
    const stored = links.load(env);
    expect(stored.scanRoots).toEqual([root]);
    // Inferred from the evidence: one ssh remote, no https ones.
    expect(stored.preferredProtocol).toBe("ssh");
    expect(stored.links.map((l) => [l.remote, l.path, l.source, l.confidence]).sort()).toEqual(
      [
        ["github.com/agitri/ddd", withRemote, "scan", "exact"],
        [null, without, "scan", "exact"],
      ].sort(),
    );

    await expect(commands.repo_scan!({ env: "default", rootDir: join(root, "nope") })).rejects.toThrow(`${join(root, "nope")} is not a directory`);
    rmSync(root, { recursive: true, force: true });
  });

  it("counts unique remotes, not loop iterations, when two checkouts share one", async () => {
    // A worktree, or two clones for two IDE windows, both legitimate. The live
    // run this regression came from reported 27 while only 26 links existed.
    const { env } = scratchEnv("cmd-scan-shared");
    const root = repoTemp("shared");
    makeRepo(root, "ddd-a", "git@github.com:agitri/ddd.git");
    makeRepo(root, "ddd-b", "git@github.com:agitri/ddd.git");

    expect(await commands.repo_scan!({ env: "default", rootDir: root })).toBe(1);
    expect(links.load(env).links).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("links manually with a tier, registers the project, and never lets a rescan clobber that", async () => {
    const { env } = scratchEnv("cmd-link");
    const root = repoTemp("link");
    const matching = realpathSync(makeRepo(root, "matching", "git@github.com:agitri/ddd.git"));
    const forked = realpathSync(makeRepo(root, "forked", "git@github.com:someone-else/ddd.git"));

    await commands.repo_link!({ env: "default", remote: "github.com/agitri/ddd", path: matching });
    expect(links.find(links.load(env), "github.com/agitri/ddd")).toMatchObject({ path: matching, source: "manual", confidence: "exact" });
    expect(registry(env).projects.some((p) => p.path === matching)).toBe(true);

    // A fork's remote legitimately differs from the repo being linked — allowed,
    // just flagged as a guess rather than refused. A trailing slash must still
    // store the canonical path, or the projectId join never fires.
    await commands.repo_link!({ env: "default", remote: "github.com/agitri/ddd", path: `${forked}/` });
    expect(links.find(links.load(env), "github.com/agitri/ddd")).toMatchObject({ path: forked, confidence: "fallback" });

    // A scan of the folder holding both must not override that manual decision.
    expect(await commands.repo_scan!({ env: "default", rootDir: root })).toBe(0);
    expect(links.find(links.load(env), "github.com/agitri/ddd")!.source).toBe("manual");

    await expect(commands.repo_link!({ env: "default", remote: "github.com/a/b", path: join(root, "nope") })).rejects.toThrow(`${join(root, "nope")} is not a directory`);
    rmSync(root, { recursive: true, force: true });
  });

  it("adds a local checkout, refuses a plain folder, and forgets by path", async () => {
    const { env } = scratchEnv("cmd-add-local");
    const root = repoTemp("add");
    const repo = realpathSync(makeRepo(root, "thing", "git@github.com:agitri/thing.git"));
    const plain = join(root, "plain");
    mkdirSync(plain);

    await commands.repo_add_local!({ env: "default", path: repo });
    expect(links.load(env).links).toEqual([{ remote: "github.com/agitri/thing", path: repo, source: "manual", confidence: "exact" }]);
    expect(registry(env).projects.some((p) => p.path === repo)).toBe(true);

    await expect(commands.repo_add_local!({ env: "default", path: plain })).rejects.toThrow(
      `${plain} is not a git repository — use the Projects widget to add a plain folder`,
    );
    await expect(commands.repo_add_local!({ env: "default", path: join(root, "nope") })).rejects.toThrow("is not a directory");

    // Forgetting touches neither the folder nor the project registry.
    await commands.repo_forget!({ env: "default", path: repo });
    expect(links.load(env).links).toEqual([]);
    expect(registry(env).projects.some((p) => p.path === repo)).toBe(true);
    expect(existsSync(repo)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("unlinks by remote", async () => {
    const { env } = scratchEnv("cmd-unlink");
    links.upsert(env, { remote: "github.com/agitri/ddd", path: "/tmp/ddd", source: "manual", confidence: "exact" });
    await commands.repo_unlink!({ env: "default", remote: "github.com/agitri/ddd" });
    expect(links.load(env).links).toEqual([]);
  });
});

describe("repo_clone", () => {
  it(
    "returns the target at once and pushes progress to ddd://repo-progress until done",
    async () => {
      const { env } = scratchEnv("cmd-clone");
      const root = repoTemp("clone");
      const seed = join(root, "seed");
      mkdirSync(seed);
      git(seed, ["init", "-q"]);
      git(seed, ["config", "user.email", "test@example.dev"]);
      git(seed, ["config", "user.name", "Test"]);
      writeFileSync(join(seed, "README.md"), "hello\n");
      git(seed, ["add", "."]);
      git(seed, ["commit", "-q", "-m", "first"]);
      const origin = join(root, "origin.git");
      // A `file://` URL forces a real clone over git's transport layer, which
      // is what makes it emit the progress stream at all — no network.
      execFileSync("git", ["clone", "--bare", "-q", seed, origin], { stdio: "ignore" });
      const parent = join(root, "into");
      mkdirSync(parent);

      const before = emitter.events.length;
      const remote = "github.com/agitri/origin";
      const target = await commands.repo_clone!({ env: "default", remote, cloneUrl: `file://${origin}`, parentDir: parent });
      expect(target).toBe(join(parent, "origin"));

      const ours = () => emitter.events.slice(before).filter((e) => e.name === "ddd://repo-progress");
      await until(() => ours().some((e) => (e.payload as { done: boolean }).done), 20000);
      const payloads = ours().map((e) => e.payload as { remote: string; phase: string; percent: number; done: boolean; error: string | null });
      expect(payloads[0]).toEqual({ remote, phase: "Starting", percent: 0, done: false, error: null });
      expect(payloads[payloads.length - 1]).toEqual({ remote, phase: "Done", percent: 100, done: true, error: null });
      expect(payloads.every((p) => p.remote === remote)).toBe(true);

      expect(existsSync(join(target as string, "README.md"))).toBe(true);
      expect(links.find(links.load(env), remote)!.path).toBe(realpathSync(target as string));
      expect(registry(env).projects.some((p) => p.path === realpathSync(target as string))).toBe(true);

      rmSync(root, { recursive: true, force: true });
    },
    30000,
  );

  it("refuses before detaching when the parent is missing or the target is occupied", async () => {
    scratchEnv("cmd-clone-refuse");
    const root = repoTemp("clone-refuse");
    await expect(
      commands.repo_clone!({ env: "default", remote: "github.com/a/b", cloneUrl: "file:///nowhere", parentDir: join(root, "nope") }),
    ).rejects.toThrow(`${join(root, "nope")} is not a directory`);

    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "b", "something"), "x");
    await expect(
      commands.repo_clone!({ env: "default", remote: "github.com/a/b", cloneUrl: "file:///nowhere", parentDir: root }),
    ).rejects.toThrow(`${join(root, "b")} already exists and is not empty`);
    rmSync(root, { recursive: true, force: true });
  });
});
```

Note the appended tests use `registry` from `../core/projects` (extend the existing `import { register } from "../core/projects";` line to `import { register, registry } from "../core/projects";`) and the module-level `until` helper already defined in this file.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/commands.test.ts` — expected: the contract test fails (seven names neither registered nor listed) and the new tests fail with `commands.repos_list is not a function`.

- [ ] **Step 3: Add the commands**

In `src/main/commands.ts`, extend the `node:fs` import to `import { existsSync, statSync } from "node:fs";` and the `node:path` import to `import { basename, join } from "node:path";`, and add:

```ts
import * as clone from "../core/repos/clone";
import { repoFilterFromJson } from "../core/repos/filter";
import * as links from "../core/repos/links";
import { normalize } from "../core/repos/remote";
import * as scan from "../core/repos/scan";
```

Above `createCommands` (next to the existing `root` and `findProject` helpers), add the row shapes and two helpers. The interfaces mirror `repos/mod.rs` field for field — the field order is the serialization order, so keep it:

```ts
/** One repo, joined with what we know about it locally. Port of `RepoRow`. */
interface RepoRow {
  nameWithOwner: string;
  url: string;
  /** Normalized remote — the key everything else uses. */
  remote: string;
  cloneUrl: string;
  facts: string;
  pushedAt: string;
  localPath: string | null;
  /** `exact` or `fallback`. A fallback match is a guess and is shown as one. */
  matchConfidence: string | null;
  /** Linked, but the folder is not there right now. */
  missing: boolean;
  projectId: string | null;
}

/** A checkout on disk that no fetched repo claims. Not a stored category: it is
 *  whatever is left after the GitHub rows have taken their links, so a repo
 *  changes section on its own the moment the facts change. */
interface LocalRepoRow {
  path: string;
  name: string;
  origin: string | null;
  originHost: string | null;
  missing: boolean;
  projectId: string | null;
}

interface RepoListing {
  rows: RepoRow[];
  localOnly: LocalRepoRow[];
  capped: boolean;
  total: number;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The last path component — what the user calls this repo. */
const leaf = (path: string): string => basename(path) || path;
```

Then add the handlers inside `createCommands`, after the `items_query` / `cache_clear` pair:

```ts
    // --- repos: the bridge between what GitHub knows and what is on disk ---

    /** Repos joined with local state. Reads the cache and the link store; makes
     *  no network call of its own. */
    repos_list: async ({ env, filter }): Promise<RepoListing> => {
      const r = root(env);
      const f = repoFilterFromJson(filter ?? {});
      const items = cache.query(r, { source: "github", kind: "repo", limit: 1000 });
      const stored = links.load(r);
      const reg = projects.registry(r);

      const scope = f.scope ?? "recent";
      const cutoff = Date.now() - 183 * 24 * 60 * 60 * 1000;
      const needle = f.query === undefined ? null : f.query.toLowerCase();

      const total = items.length;
      const rows: RepoRow[] = [];
      // Which stored checkouts a GitHub row consumed. Whatever is left over is
      // local-only — derived here, never stored as a category.
      const claimed = new Set<string>();

      for (const item of items) {
        if (scope === "recent") {
          // The Rust's `parse_from_rfc3339(..).map(..).unwrap_or(true)`: a
          // timestamp that cannot be parsed counts as fresh. `Date.parse` is
          // laxer than chrono, which only shows on strings chrono would reject.
          const at = Date.parse(item.updatedAt);
          const fresh = Number.isNaN(at) ? true : at > cutoff;
          if (!fresh) continue;
        }
        if (needle !== null && !item.title.toLowerCase().includes(needle)) continue;

        const pick = (prefix: string): string => {
          const ref = item.refs.find((x) => x.startsWith(prefix));
          return ref === undefined ? "" : ref.slice(prefix.length);
        };
        const normalized = pick("remote:");
        const https = pick("https:");
        const ssh = pick("ssh:");

        // Which tier matched, not what the stored link's own confidence says —
        // see `links.findWithTier`.
        const matched = links.findWithTier(stored, normalized, https);
        const cloneUrl = stored.preferredProtocol === "ssh" && ssh !== "" ? ssh : https;

        let localPath: string | null = null;
        let matchConfidence: string | null = null;
        let missing = false;
        if (matched !== null) {
          claimed.add(matched.link.path);
          localPath = matched.link.path;
          matchConfidence = matched.confidence;
          missing = !isDir(matched.link.path);
        }
        const projectId = localPath === null ? null : (reg.projects.find((p) => p.path === localPath)?.id ?? null);

        rows.push({
          nameWithOwner: item.title,
          url: item.url ?? "",
          remote: normalized,
          cloneUrl,
          facts: item.body ?? "",
          pushedAt: item.updatedAt,
          localPath,
          matchConfidence,
          missing,
          projectId,
        });
      }

      // Everything DDD knows is a checkout, minus what the rows above took. The
      // scope switch deliberately does not apply: it filters on `pushedAt`,
      // which a local checkout does not have.
      const localOnly: LocalRepoRow[] = stored.links
        .filter((link) => !claimed.has(link.path))
        .filter((link) => {
          if (needle === null) return true;
          return leaf(link.path).toLowerCase().includes(needle) || (link.remote !== null && link.remote.toLowerCase().includes(needle));
        })
        .map((link) => ({
          path: link.path,
          name: leaf(link.path),
          origin: link.remote,
          // `normalize` produces `host/owner/repo`, so the host is the first
          // segment — parsed here so the badge has nothing to do.
          originHost: link.remote === null ? null : (link.remote.split("/")[0] ?? null),
          missing: !isDir(link.path),
          projectId: reg.projects.find((p) => p.path === link.path)?.id ?? null,
        }));

      // 300 is the fetch cap from the spec; hitting it exactly means there are
      // probably more.
      return { rows, localOnly, capped: total >= 300, total };
    },

    /** Walk a folder the user nominated and link every checkout it finds.
     *  Read-only against those repos, and it does **not** register them as
     *  projects — filling the projects list uninvited is presumptuous. */
    repo_scan: async ({ env, rootDir }) => {
      const r = root(env);
      const dir = String(rootDir);
      if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);

      const found = await scan.scanRoot(dir);
      const stored = links.load(r);

      if (stored.preferredProtocol === null) stored.preferredProtocol = scan.inferProtocol(found);
      if (!stored.scanRoots.includes(dir)) stored.scanRoots.push(dir);

      // A set of normalized remotes, not a counter: two checkouts on disk can
      // share one remote (a worktree, two clones for two IDE windows), and the
      // loop below then touches that remote twice — only the later one survives
      // in `stored.links`. Counting loop passes instead of distinct remotes
      // reports N when only N-1 (or fewer) links actually end up persisted.
      const touched = new Set<string>();
      for (const { path, url } of found) {
        // A checkout with no resolvable origin is still a checkout. It is stored
        // with `remote: null` and shows in the local-only section rather than
        // being dropped on the floor.
        const normalized = url === null ? null : normalize(url);
        // See `links.canonicalPath`: stored path must be canonical or the
        // projectId join in `repos_list` never fires. A scan is best-effort and
        // freely re-runnable, so a repo that cannot be canonicalized
        // (permissions, a symlink race) is skipped rather than costing the whole
        // scan its roots.
        let canonical: string;
        try {
          canonical = links.canonicalPath(path);
        } catch {
          continue;
        }
        // A manual record is the user's decision and a scan never overrides it —
        // by *either* identifier. Path alone is not enough: a user who manually
        // pointed this remote at a different folder would have that decision
        // evicted the next time the scan walked past the original checkout.
        // Remote alone is not enough either, since a remote-less checkout has no
        // remote to check by.
        if (stored.links.some((l) => l.source === "manual" && (l.path === canonical || (normalized !== null && l.remote === normalized)))) continue;
        // Hold both store invariants inline: one record per path, one per
        // non-null remote.
        stored.links = stored.links.filter((l) => l.path !== canonical && !(normalized !== null && l.remote === normalized));
        stored.links.push({ remote: normalized, path: canonical, source: "scan", confidence: "exact" });
        // Key by remote when there is one, by path otherwise.
        touched.add(normalized ?? canonical);
      }

      links.save(r, stored);
      return touched.size;
    },

    /** Point a repo at a folder, and register that folder as a project. A
     *  different remote at that path is allowed with the link flagged rather
     *  than refused — forks and worktrees are legitimate. */
    repo_link: async ({ env, remote, path }) => {
      const r = root(env);
      const dir = String(path);
      if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);

      const url = await projects.gitRemote(dir);
      const actual = url === null ? null : normalize(url);
      const confidence = actual === remote ? "exact" : "fallback";

      // See `links.canonicalPath`: stored path must be canonical or the
      // projectId join in `repos_list` never fires.
      const canonical = links.canonicalPath(dir);
      links.upsert(r, { remote: String(remote), path: canonical, source: "manual", confidence });

      // You clicked, so registering is the point. `projects.register` does its
      // own canonicalization of `path`, independently of the one above.
      projects.register(r, dir);
    },

    /** Add a checkout DDD has not discovered, and register it as a project. The
     *  scan finds what is under a nominated root; this is for everything else. */
    repo_add_local: async ({ env, path }) => {
      const r = root(env);
      const dir = String(path);
      if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);
      if (!existsSync(join(dir, ".git"))) {
        // This is the Repositories widget; a folder that is not a repository
        // does not belong in it, and the message says where it does belong.
        throw DddError.invalid(`${dir} is not a git repository — use the Projects widget to add a plain folder`);
      }

      const canonical = links.canonicalPath(dir);
      const url = await projects.gitRemote(dir);
      const remote = url === null ? null : normalize(url);

      // Whatever remote was recorded was read out of the checkout itself, not
      // guessed at. (`confidence` on a stored record is informational;
      // `repos_list` reports the tier its own join used.)
      links.upsert(r, { remote, path: canonical, source: "manual", confidence: "exact" });
      projects.register(r, dir);
    },

    /** Forget a checkout by path. Touches neither the folder nor the project
     *  registry — the same rule `repo_unlink` follows, by the other identifier. */
    repo_forget: async ({ env, path }) => {
      links.removeByPath(root(env), String(path));
    },

    /** Drop a link. Unlinking a repo from its folder says nothing about whether
     *  that folder still belongs in the projects list. */
    repo_unlink: async ({ env, remote }) => {
      links.remove(root(env), String(remote));
    },

    /** Clone a repo into a parent directory, detached. Returns as soon as the
     *  work is spawned; the row follows along via `ddd://repo-progress`, the
     *  same event channel the file watcher uses. */
    repo_clone: async ({ env, remote, cloneUrl, parentDir }) => {
      const r = root(env);
      // Prepared before detaching: a refusal must reach the user as a failed
      // command, not as a progress event nobody is listening for yet.
      const target = clone.prepare(String(parentDir), String(remote));
      void clone
        .run(r, String(remote), String(cloneUrl), target, (p: clone.Progress) => {
          deps.emit.emit("ddd://repo-progress", { remote: String(remote), phase: p.phase, percent: p.percent, done: p.done, error: p.error });
        })
        .catch(() => {
          // `run` reports its own failures as a final tick; this only catches a
          // bug in the runner itself, which must not become an unhandled
          // rejection that takes the app down.
        });
      return target;
    },
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/main/commands.test.ts` — expected: PASS, including both contract tests. Then `npm run typecheck` and `npx vitest run` — expected: the whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/main/commands.ts src/main/commands.test.ts
git commit -m "feat(repos): repos_list, scan, link, unlink, add_local, forget and detached clone"
```

<!-- deps/notes for the assembler

New npm dependencies: none. Everything used is Node built-ins (`node:child_process`, `node:fs`, `node:os`, `node:path`) plus what phase 0–3 already ship.

Exported names other sections may consume:
- `src/core/repos/links.ts` (Modify) gains `remove(env, remote)`, `removeByPath(env, path)`, `find(links, wanted): RepoLink | null`, `findWithTier(links, normalized, https): { link, confidence } | null`, `canonicalPath(path): string` (throws `DddError.io`).
- `src/core/repos/scan.ts` (new): `Found { path, url }`, `candidates(root): string[]`, `scanRoot(root): Promise<Found[]>`, `inferProtocol(found): string | null`.
- `src/core/repos/clone.ts` (new): `Progress { phase, percent, done, error }`, `SpawnLike`, `prepare(parent, remote)`, `targetDir(parent, remote)`, `parseProgress(line)`, `run(env, remote, cloneUrl, target, onProgress, spawnFn?)`.
- `src/main/commands.ts` gains module-level `isDir(path)` and `leaf(path)` helpers plus the `RepoRow` / `LocalRepoRow` / `RepoListing` interfaces (declared locally, mirroring `repos/mod.rs`; the renderer's `types/index.ts` already has structurally identical ones and is deliberately not imported). A later section adding `dev_servers_*` will want its own `isDir`/`leaf` — reuse these rather than redeclaring.
- The `ddd://repo-progress` event, payload `{ remote, phase, percent, done, error }`, joins `ddd://project-changed` on the emitter.
- Task 6 removes exactly these from `NOT_YET_PORTED`: repos_list, repo_scan, repo_link, repo_unlink, repo_add_local, repo_forget, repo_clone.

Rust behaviour deliberately not reproduced, and how it is flagged in the code:
1. `clone::run` spawns git with the environment inherited in the Rust; this port passes `GIT_EXEC_OPTIONS.env` (GIT_TERMINAL_PROMPT=0), because a credential prompt in a windowed app hangs the clone forever. Flagged with a comment at the `spawnFn` call, and it follows the note `projects.ts` already carries ("phase 4's repos/* … should reuse this").
2. `repos_list`'s freshness check uses `Date.parse`, which accepts strings chrono's strict `parse_from_rfc3339` would reject (e.g. `2024-01-01`). Both treat an unparseable value as fresh, so the difference only shows for loosely-formatted timestamps GitHub does not emit. Flagged with a comment at the check.
3. `links.canonicalPath` uses `realpathSync`, which does not produce Rust's `\\?\` Windows prefix — the same deviation `projects.register` already documents; flagged with a one-line comment there too.
4. Rust's `found.sort()` in `scan_root` sorts `PathBuf`s by OS-string bytes; `candidates` sorts JS strings by UTF-16 code unit. Identical for ASCII names, different only for non-ASCII folder names. Flagged in the comment above the sort.
5. `run` is async where the Rust blocks; the caller (`repo_clone`) detaches it instead of `spawn_blocking`. Same observable sequence of ticks.
-->

### Task 7: What is listening, where it runs, and what Docker composed

**Files:**
- Create: `src/core/dev/run.ts`, `src/core/dev/listen.ts`, `src/core/dev/cwd.ts`, `src/core/dev/containers.ts`
- Test: `src/core/dev/run.test.ts`, `src/core/dev/listen.test.ts`, `src/core/dev/cwd.test.ts`, `src/core/dev/containers.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Node built-ins only (`node:child_process`, `node:fs`).
- Produces:
  - `run.ts`: `RunResult { stdout: string; ok: boolean }`, `Runner = (file: string, args: string[]) => Promise<RunResult>`, `execFileRunner: Runner`, `lines(output: string): string[]`.
  - `listen.ts`: `Listener { port: number; address: string; pid: number | null; process: string }`, `key(l)`, `family(l)`, `foreign(l)`, `normalizeAddress(address)`, `parseLsof(output)`, `parseNetstat(output)`, `order(found)`, `enumerate(runner?, platform?): Promise<Listener[]>`, `LSOF_ARGS`, `NETSTAT_ARGS`.
  - `cwd.ts`: `parseLsof(output): Map<number, string>`, `forPids(pids, runner?, platform?, readLink?): Promise<Map<number, string>>`.
  - `containers.ts`: `DevContainer { name; project; status; running; unhealthy; ports }`, `DOCKER_ARGS`, `parse(output): Map<string, DevContainer[]>`, `parsePorts(ports): number[]`, `byProjectDir(runner?): Promise<Map<string, DevContainer[]>>`.

The Rust enumerates listening sockets with the `listeners` crate (`dev/listen.rs`). Node has no equivalent, so this port shells out on every platform: `lsof` on macOS and Linux, `netstat` on Windows. Everything above `listen.ts` speaks DDD's own `Listener`, exactly as the Rust intends, so the substitution stays inside this one file.

- [ ] **Step 1: Write the failing tests**

`src/core/dev/run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execFileRunner, lines } from "./run";

describe("the process runner", () => {
  it("returns what the process wrote", async () => {
    const out = await execFileRunner("echo", ["hello"]);
    expect(out.ok).toBe(true);
    expect(out.stdout.trim()).toBe("hello");
  });

  it("never rejects when the program is missing — an enumeration that cannot read finds less", async () => {
    const out = await execFileRunner("ddd-no-such-program", ["--version"]);
    expect(out).toEqual({ stdout: "", ok: false });
  });

  it("keeps the output of a process that exited non-zero, the way Command::output does", async () => {
    // `lsof -p` exits 1 when one of the PIDs has gone and still prints the
    // rest, and the Rust parses that stdout regardless of the status.
    const out = await execFileRunner("sh", ["-c", "echo partial; exit 1"]);
    expect(out.stdout.trim()).toBe("partial");
    expect(out.ok).toBe(false);
  });

  it("splits like Rust's str::lines(): no trailing empty, \\r stripped", () => {
    expect(lines("a\nb\n")).toEqual(["a", "b"]);
    expect(lines("a\r\nb")).toEqual(["a", "b"]);
    expect(lines("")).toEqual([]);
    expect(lines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });
});
```

`src/core/dev/listen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { enumerate, family, foreign, key, normalizeAddress, order, parseLsof, parseNetstat, type Listener } from "./listen";
import type { Runner } from "./run";

/** Real `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` output from a Mac: `f` lines
 *  appear even though only `pcn` was asked for, and a dual-stack bind is
 *  reported once per file descriptor. */
const LSOF = [
  "p958",
  "crapportd",
  "f8",
  "n*:59527",
  "f9",
  "n*:59527",
  "p1191",
  "cControlCenter",
  "f8",
  "n*:7000",
  "f10",
  "n0.0.0.0:5000",
  "p24845",
  "cnode",
  "f21",
  "n[::1]:5199",
  "p25197",
  "csymfony",
  "f16",
  "n127.0.0.1:8005",
  "p6756",
  "cphp-fpm",
  "f16",
  "n127.0.0.1:64639",
  "",
].join("\n");

/** Real `netstat -ano` output, header and all. */
const NETSTAT = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044",
  "  TCP    127.0.0.1:5199         0.0.0.0:0              LISTENING       17532",
  "  TCP    [::]:135               [::]:0                 LISTENING       1044",
  "  TCP    127.0.0.1:49670        127.0.0.1:49671        ESTABLISHED     9612",
  "  UDP    0.0.0.0:5353           *:*                                    3444",
  "",
].join("\n");

function fixture(stdout: string, ok = true): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout, ok };
  };
  return { runner, calls };
}

const listener = (address: string, port: number, pid: number | null): Listener => ({
  port,
  address,
  pid,
  process: pid === null ? "" : "node",
});

describe("a listener", () => {
  it("is identified by address and port, so two families on one port are two rows", () => {
    // The reason identity is address+port. These are two processes, and a
    // port-keyed list would collapse them and lose one.
    expect(key(listener("127.0.0.1", 8000, 1))).toBe("tcp:127.0.0.1:8000");
    expect(key(listener("::1", 8000, 2))).toBe("tcp:::1:8000");
    expect(key(listener("127.0.0.1", 8000, 1))).not.toBe(key(listener("::1", 8000, 2)));
  });

  it("reads its family from the bound address", () => {
    expect(family(listener("::1", 5199, 1))).toBe("v6");
    expect(family(listener("127.0.0.1", 8000, 1))).toBe("v4");
    // A wildcard has a colon in neither spelling we normalise it to.
    expect(family(listener("*", 3000, 1))).toBe("v4");
  });

  it("is foreign when it has no pid", () => {
    // Another UID's. Not ours to probe, project or stop — and no permission
    // exists that would change that.
    expect(foreign(listener("*", 631, null))).toBe(true);
    expect(foreign(listener("*", 3000, 42))).toBe(false);
  });

  it("normalises every spelling of a wildcard to one", () => {
    expect(normalizeAddress("0.0.0.0")).toBe("*");
    expect(normalizeAddress("::")).toBe("*");
    expect(normalizeAddress("[::]")).toBe("*");
    expect(normalizeAddress("*")).toBe("*");
    expect(normalizeAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeAddress("::1")).toBe("::1");
    expect(normalizeAddress("[::1]")).toBe("::1");
  });
});

describe("parsing lsof's machine-readable form", () => {
  it("reads a listener per n line, carrying the pid and command down from the p and c lines", () => {
    const found = parseLsof(LSOF);
    expect(found.filter((l) => l.port === 8005)).toEqual([
      { port: 8005, address: "127.0.0.1", pid: 25197, process: "symfony" },
    ]);
    expect(found.find((l) => l.port === 5199)).toEqual({ port: 5199, address: "::1", pid: 24845, process: "node" });
    // f lines are emitted even though only `pcn` was asked for.
    expect(found.every((l) => l.pid !== null)).toBe(true);
  });

  it("drops a path with no pid before it rather than guessing an association", () => {
    expect(parseLsof("n*:3000\n")).toEqual([]);
  });

  it("ignores what it cannot read as a socket", () => {
    expect(parseLsof("p1\ncnode\nn*:*\nn127.0.0.1\nnfoo:bar\n")).toEqual([]);
    // An established socket would carry an arrow; -sTCP:LISTEN should already
    // have excluded it, and this is the belt to that braces.
    expect(parseLsof("p1\ncnode\nn127.0.0.1:8005->127.0.0.1:9\n")).toEqual([]);
  });
});

describe("parsing netstat", () => {
  it("takes only TCP rows in LISTENING, with the pid from the last column", () => {
    const found = parseNetstat(NETSTAT);
    expect(found).toEqual([
      { port: 135, address: "*", pid: 1044, process: "" },
      { port: 5199, address: "127.0.0.1", pid: 17532, process: "" },
      { port: 135, address: "*", pid: 1044, process: "" },
    ]);
    // netstat never names the process, and inventing one would be worse.
    expect(found.every((l) => l.process === "")).toBe(true);
  });
});

describe("enumerate", () => {
  it("runs lsof on a Mac, sorted by port then address, with duplicates collapsed", async () => {
    const { runner, calls } = fixture(LSOF);
    const found = await enumerate(runner, "darwin");
    expect(calls).toEqual([["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"]]);
    expect(found.map((l) => l.port)).toEqual([5000, 5199, 7000, 8005, 59527, 64639]);
    // The same socket reported on two descriptors is one socket.
    expect(found.filter((l) => l.port === 59527)).toHaveLength(1);
    expect(found.find((l) => l.port === 5000)!.address).toBe("*");
  });

  it("runs netstat on Windows and collapses a dual-stack bind", async () => {
    const { runner, calls } = fixture(NETSTAT);
    const found = await enumerate(runner, "win32");
    expect(calls).toEqual([["netstat", "-ano"]]);
    // 0.0.0.0:135 and [::]:135 normalise to the same socket under the same pid.
    expect(found).toEqual([
      { port: 135, address: "*", pid: 1044, process: "" },
      { port: 5199, address: "127.0.0.1", pid: 17532, process: "" },
    ]);
  });

  it("finds nothing rather than throwing when the tool is not there", async () => {
    const { runner } = fixture("", false);
    expect(await enumerate(runner, "darwin")).toEqual([]);
  });

  it("keeps rows with the same port and different processes — a forked pool is collapsed later, not here", () => {
    const pool = order([
      { port: 8005, address: "127.0.0.1", pid: 102, process: "php-fpm" },
      { port: 8005, address: "127.0.0.1", pid: 100, process: "php-fpm" },
      { port: 8005, address: "127.0.0.1", pid: 100, process: "php-fpm" },
    ]);
    expect(pool.map((l) => l.pid)).toEqual([102, 100]);
  });

  it("never throws against this machine, and comes back ordered", async () => {
    // Runs against the real machine: whatever is or is not listening, this
    // must return and must be sorted, because an unstable order reshuffles the
    // board under the user's cursor on every refresh.
    const found = await enumerate();
    const sorted = [...found].sort((a, b) => a.port - b.port || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    expect(found).toEqual(sorted);
  }, 30_000);
});
```

`src/core/dev/cwd.test.ts`:

```ts
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forPids, parseLsof } from "./cwd";
import type { Runner } from "./run";

function fixture(stdout: string): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout, ok: true };
  };
  return { runner, calls };
}

describe("parsing lsof's cwd form", () => {
  it("parses the machine-readable form", () => {
    const out = parseLsof("p14577\nn/Users/rene/Projects/InstallonlineOrderPortal\np25197\nn/Users/rene/Projects/climate4u\n");
    expect(out.size).toBe(2);
    expect(out.get(25197)).toBe("/Users/rene/Projects/climate4u");
  });

  it("ignores lines it does not understand", () => {
    // lsof emits header and descriptor lines we did not ask about; they must
    // not become entries or shift the pid association.
    const out = parseLsof("f cwd\np1\nfcwd\nn/tmp\nCOMMAND\n");
    expect(out.get(1)).toBe("/tmp");
    expect(out.size).toBe(1);
  });

  it("drops a path with no pid before it", () => {
    // Never guess an association. A path with no owner is worse than absent,
    // because it would attach a project to the wrong row.
    expect(parseLsof("n/tmp/orphan\n").size).toBe(0);
  });

  it("keeps the first path when a process reports several", () => {
    expect(parseLsof("p7\nn/first\nn/second\n").get(7)).toBe("/first");
  });
});

describe("resolving working directories", () => {
  it("does no work for an empty pid list", async () => {
    const { runner, calls } = fixture("p1\nn/tmp\n");
    expect((await forPids([], runner, "darwin")).size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("asks lsof for every pid at once on a Mac", async () => {
    // Process spawn is ~30ms on macOS and dominates the actual work, so eight
    // servers asked separately would be a quarter of a second of overhead.
    const { runner, calls } = fixture("p1\nn/p/one\np2\nn/p/two\n");
    const out = await forPids([1, 2], runner, "darwin");
    expect(calls).toEqual([["lsof", "-a", "-d", "cwd", "-Fpn", "-p", "1,2"]]);
    expect([...out]).toEqual([
      [1, "/p/one"],
      [2, "/p/two"],
    ]);
  });

  it("reads procfs on Linux, with no process to spawn at all", async () => {
    const { runner, calls } = fixture("");
    const seen: string[] = [];
    const readLink = (path: string) => {
      seen.push(path);
      if (path === "/proc/2/cwd") throw new Error("ESRCH");
      return "/p/one";
    };
    const out = await forPids([1, 2], runner, "linux", readLink);
    expect(seen).toEqual(["/proc/1/cwd", "/proc/2/cwd"]);
    expect([...out]).toEqual([[1, "/p/one"]]);
    expect(calls).toEqual([]);
  });

  it("answers nothing on Windows", async () => {
    // Reading another process's PEB is undocumented, and the executable path
    // would name the Node installation rather than the project — worse than
    // nothing, because it looks like an answer.
    const { runner, calls } = fixture("p1\nn/p/one\n");
    expect((await forPids([1], runner, "win32")).size).toBe(0);
    expect(calls).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")("resolves this very process", async () => {
    // The end-to-end check that needs no fixture: we know our own cwd.
    const found = await forPids([process.pid]);
    expect(realpathSync(found.get(process.pid)!)).toBe(realpathSync(process.cwd()));
  }, 30_000);
});
```

`src/core/dev/containers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DOCKER_ARGS, byProjectDir, parse, parsePorts } from "./containers";
import type { Runner } from "./run";

/** Real `docker ps` output in the format below: working dir, name, status,
 *  ports, compose project — tab separated. */
const REAL =
  "/Users/rene/Projects/climate4u\tclimate4u-database-1\tUp 2 hours\t0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp\n" +
  "/Users/rene/Projects/climate4u\tclimate4u-redis-1\tUp 2 hours (healthy)\t\n" +
  "/Users/rene/Projects/firstklas\tfirstklas-traefik-1\tUp 5 months (unhealthy)\t0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\n" +
  "/Users/rene/Projects/old\told-api-1\tExited (255) 5 months ago\t\n";

describe("docker containers", () => {
  it("groups containers by the project they were composed from", () => {
    const byDir = parse(REAL);
    expect(byDir.size).toBe(3);
    expect(byDir.get("/Users/rene/Projects/climate4u")).toHaveLength(2);
  });

  it("treats running and unhealthy as separate facts", () => {
    const byDir = parse(REAL);
    const traefik = byDir.get("/Users/rene/Projects/firstklas")![0]!;
    // The real case this came from: up for five months *and* failing its
    // healthcheck. Collapsing the two would have hidden it.
    expect(traefik.running).toBe(true);
    expect(traefik.unhealthy).toBe(true);

    const exited = byDir.get("/Users/rene/Projects/old")![0]!;
    expect(exited.running).toBe(false);
    expect(exited.unhealthy).toBe(false);
  });

  it("does not call a restarting container running", () => {
    // Crash-looping is not a state you can use, and "Restarting" does not start
    // with "Up" — asserted so a later loosening cannot call it running.
    expect(parse("/p\tapi-1\tRestarting (1) 3 seconds ago\t\n").get("/p")![0]!.running).toBe(false);
  });

  it("reads host ports and ignores container ports", () => {
    const byDir = parse(REAL);
    expect(byDir.get("/Users/rene/Projects/climate4u")![0]!.ports).toEqual([5433]);
    // Both families publish the same host port; it is one port, not two.
    expect(byDir.get("/Users/rene/Projects/firstklas")![0]!.ports).toEqual([80, 443]);
    // An exposed-but-unpublished port has no host side and is not a collision.
    expect(parsePorts("3306/tcp")).toEqual([]);
    expect(parsePorts("")).toEqual([]);
  });

  it("gives a container with no published ports none", () => {
    expect(parse(REAL).get("/Users/rene/Projects/climate4u")![1]!.ports).toEqual([]);
  });

  it("skips a container without the label rather than grouping it under the empty string", () => {
    // `--filter` should prevent this, but an unlabelled row must never create a
    // project keyed on "".
    expect(parse("\tstray-1\tUp 2 hours\t\n").size).toBe(0);
  });

  it("does not let a malformed line take the rest with it", () => {
    expect(parse("garbage\n/p\tapi-1\tUp\t\n").size).toBe(1);
  });

  it("names the compose project from the label, falling back to the directory's basename", () => {
    const labelled = parse("/Users/rene/Projects/onderwijscatalogus/backend\tonderwijscatalogus-nginx-1\tUp\t\tonderwijscatalogus\n");
    expect(labelled.get("/Users/rene/Projects/onderwijscatalogus/backend")![0]!.project).toBe("onderwijscatalogus");
    // Older output, and any hand-written fixture, may stop at the ports.
    expect(parse(REAL).get("/Users/rene/Projects/climate4u")![0]!.project).toBe("climate4u");
  });

  it("sorts each project's containers by name", () => {
    const byDir = parse("/p\tb-1\tUp\t\n/p\ta-1\tUp\t\n");
    expect(byDir.get("/p")!.map((c) => c.name)).toEqual(["a-1", "b-1"]);
  });

  it("runs one docker ps with the format the parser expects, and finds nothing when Docker is absent", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: REAL, ok: true };
    };
    expect((await byProjectDir(runner)).size).toBe(3);
    expect(calls).toEqual([
      [
        "docker",
        "ps",
        "--all",
        "--filter",
        "label=com.docker.compose.project",
        "--format",
        '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}',
      ],
    ]);
    expect(DOCKER_ARGS[0]).toBe("ps");

    // No Docker, no daemon, or a permission problem all mean the same thing: a
    // dashboard that fails to render because Docker is not installed would be
    // absurd.
    expect((await byProjectDir(async () => ({ stdout: "", ok: false }))).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/dev/` — expected: four files fail to collect, `Failed to resolve import "./run"`, `"./listen"`, `"./cwd"`, `"./containers"`.

- [ ] **Step 3: Write the modules**

`src/core/dev/run.ts`:

```ts
/**
 * The one way anything under `src/core/dev/` starts a process.
 *
 * The Rust reads listening sockets through the `listeners` crate and shells out
 * only for `lsof -d cwd` and `docker ps`. Node has no equivalent crate, so this
 * port shells out for the enumeration too — and every enumerator takes its
 * runner as an argument, so a test feeds it fixture output instead of whatever
 * happens to be running on the machine.
 */
import { execFile } from "node:child_process";

export interface RunResult {
  /** What the process wrote, even when it exited non-zero: `lsof -p` exits 1
   *  when one of the PIDs has gone and still prints the rest, and the Rust's
   *  `Command::output()` ignores the status the same way. Callers parse
   *  `stdout` regardless of `ok`; a spawn failure yields "" anyway. */
  stdout: string;
  /** False when the process could not be started, exited non-zero, or timed out. */
  ok: boolean;
}

export type Runner = (file: string, args: string[]) => Promise<RunResult>;

/** Big enough for `lsof` on a busy machine, and short enough that a wedged
 *  `docker` cannot hang a refresh. */
const RUN_OPTIONS = { encoding: "utf8" as const, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 };

/** Never rejects: an enumeration that cannot read simply finds less, and a
 *  dashboard that fails to render because one command was missing is worse
 *  than one showing fewer rows. */
export const execFileRunner: Runner = (file, args) =>
  new Promise((resolve) => {
    try {
      execFile(file, args, RUN_OPTIONS, (error, stdout) => {
        resolve({ stdout: stdout ?? "", ok: error === null });
      });
    } catch {
      resolve({ stdout: "", ok: false });
    }
  });

/** Split the way Rust's `str::lines()` does: `\r` stripped, no trailing empty. */
export function lines(output: string): string[] {
  const all = output.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all;
}
```

`src/core/dev/listen.ts`:

```ts
/**
 * What is listening, and who owns it. Port of `dev/listen.rs`.
 *
 * The only file that names the enumeration tool. Everything above this speaks
 * DDD's own `Listener`, so replacing `lsof` with libproc or
 * `GetExtendedTcpTable` is a day's work in one file rather than a rewrite.
 */
import { execFileRunner, lines, type Runner } from "./run";

/** One listening socket, in our terms rather than the tool's. */
export interface Listener {
  port: number;
  /** As bound, verbatim: `127.0.0.1`, `::1`, `*`. */
  address: string;
  /**
   * `null` when the socket belongs to another UID.
   *
   * On macOS this is not a permission we can request: the kernel simply does
   * not attribute other users' sockets to a non-root caller. It is **not** TCC
   * — no prompt, entitlement or plist changes it. Only root does, and a
   * dashboard should not be root.
   */
  pid: number | null;
  /** `""` where the Rust has `None`: netstat cannot name a process, and
   *  inventing one would be worse than admitting we do not know. */
  process: string;
}

/**
 * `tcp:127.0.0.1:8005` — identity, React key, and the handle the probe and
 * stop commands take.
 *
 * Keyed on address *and* port because two sockets can share a port across
 * families: `127.0.0.1:8000` and `[::1]:8000` are two processes, and a
 * port-keyed list would silently collapse them into one row.
 */
export function key(l: Listener): string {
  return `tcp:${l.address}:${l.port}`;
}

/** `v4` · `v6`, for a badge — the family is load-bearing here, so it is shown
 *  rather than inferred by the reader. */
export function family(l: Listener): "v4" | "v6" {
  return l.address.includes(":") && l.address !== "*" ? "v6" : "v4";
}

/** No PID means another UID's socket: not ours to probe, project or stop. */
export function foreign(l: Listener): boolean {
  return l.pid === null;
}

/** Wildcard binds arrive spelled several ways; the rest pass through verbatim,
 *  unbracketed so the key matches the Rust's `SocketAddr` spelling. */
export function normalizeAddress(address: string): string {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  return bare === "0.0.0.0" || bare === "::" || bare === "*" ? "*" : bare;
}

/** `-F pcn` is lsof's machine-readable mode: `p<pid>`, `c<command>`, `n<addr>`.
 *  `f<fd>` lines come anyway and are ignored. */
export const LSOF_ARGS = ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"];
export const NETSTAT_ARGS = ["-ano"];

/** Every TCP socket in LISTEN state this user can see.
 *
 *  Never rejects: an enumeration that cannot read simply finds less. */
export async function enumerate(runner: Runner = execFileRunner, platform: NodeJS.Platform = process.platform): Promise<Listener[]> {
  const found =
    platform === "win32"
      ? parseNetstat((await runner("netstat", NETSTAT_ARGS)).stdout)
      : parseLsof((await runner("lsof", LSOF_ARGS)).stdout);
  return order(found);
}

/** Stable order so a refresh does not reshuffle the board under the cursor,
 *  then Rust's `Vec::dedup`: consecutive identical sockets collapse (lsof
 *  reports a dual-descriptor bind twice), different processes on one socket do
 *  not — that collapse belongs to the join, which counts them as workers. */
export function order(found: Listener[]): Listener[] {
  const sorted = [...found].sort((a, b) => a.port - b.port || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return sorted.filter((l, i) => {
    const previous = sorted[i - 1];
    return previous === undefined || !(previous.port === l.port && previous.address === l.address && previous.pid === l.pid && previous.process === l.process);
  });
}

export function parseLsof(output: string): Listener[] {
  const out: Listener[] = [];
  let pid: number | null = null;
  let command = "";
  for (const line of lines(output)) {
    const tag = line.slice(0, 1);
    const value = line.slice(1).trim();
    if (tag === "p") {
      pid = integer(value);
      command = "";
    } else if (tag === "c") {
      command = value;
    } else if (tag === "n") {
      // Never guess an association: a socket with no owner above it is dropped.
      if (pid === null) continue;
      // An established socket carries an arrow. `-sTCP:LISTEN` should already
      // have excluded it; this is the belt to that braces.
      if (value.includes("->")) continue;
      const socket = splitHostPort(value);
      if (socket === null) continue;
      out.push({ port: socket.port, address: normalizeAddress(socket.host), pid, process: command });
    }
  }
  return out;
}

/** `  TCP    0.0.0.0:135   0.0.0.0:0   LISTENING   1044`. The process name is
 *  not in this output, so Windows rows carry port, PID and no name. */
export function parseNetstat(output: string): Listener[] {
  const out: Listener[] = [];
  for (const line of lines(output)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP" || parts[3] !== "LISTENING") continue;
    const socket = splitHostPort(parts[1]!);
    if (socket === null) continue;
    out.push({ port: socket.port, address: normalizeAddress(socket.host), pid: integer(parts[4]!), process: "" });
  }
  return out;
}

/** `127.0.0.1:8005`, `*:3000`, `[::1]:5199` — split at the last colon, which is
 *  why the v6 literal keeps its brackets until `normalizeAddress`. */
function splitHostPort(value: string): { host: string; port: number } | null {
  const at = value.lastIndexOf(":");
  if (at <= 0) return null;
  const port = integer(value.slice(at + 1));
  if (port === null || port > 65535) return null;
  return { host: value.slice(0, at), port };
}

/** Rust's `str::parse::<u32>()`: whole string, digits only. */
function integer(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}
```

`src/core/dev/cwd.ts`:

```ts
/**
 * Which directory a process is running in — the step that turns a port number
 * into a project name. Port of `dev/cwd.rs`.
 *
 * One call for every PID at once, not one per PID. Process spawn is ~30ms on
 * macOS (dyld plus code-signing) and dominates the actual work, so eight
 * servers would be a quarter of a second of pure overhead if asked separately.
 */
import { readlinkSync } from "node:fs";
import { execFileRunner, lines, type Runner } from "./run";

/**
 * Working directory for each PID we could resolve.
 *
 * A PID missing from the result is not an error: the process may have exited
 * between enumeration and this call, or belong to another user. Both mean the
 * same thing to a caller — no project for that row.
 */
export async function forPids(
  pids: number[],
  runner: Runner = execFileRunner,
  platform: NodeJS.Platform = process.platform,
  readLink: (path: string) => string = readlinkSync,
): Promise<Map<number, string>> {
  if (platform === "linux") {
    // procfs answers directly, with no process to spawn at all.
    const out = new Map<number, string>();
    for (const pid of pids) {
      try {
        out.set(pid, readLink(`/proc/${pid}/cwd`));
      } catch {
        // Gone, or another user's. Both mean no project for that row.
      }
    }
    return out;
  }
  if (platform !== "darwin") {
    // Windows: reading another process's PEB is undocumented, and the
    // executable path would name the Node installation rather than the project
    // — worse than nothing, because it looks like an answer. Windows rows carry
    // port, PID and process name, and no project.
    return new Map();
  }
  if (pids.length === 0) return new Map();
  // `-Fpn` is lsof's machine-readable mode: `p<pid>` then `n<path>` lines.
  // `-d cwd` restricts it to the one descriptor we want.
  const out = await runner("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]);
  return parseLsof(out.stdout);
}

/** `p1234\nn/path/to/dir\n` repeating. Pure, so the parsing is testable without
 *  a machine to run `lsof` on. */
export function parseLsof(output: string): Map<number, string> {
  const out = new Map<number, string>();
  let current: number | null = null;
  for (const line of lines(output)) {
    const tag = line.slice(0, 1);
    const value = line.slice(1).trim();
    if (tag === "p") {
      current = /^\d+$/.test(value) ? Number(value) : null;
    } else if (tag === "n") {
      // A process can report several cwd lines across threads; the first is the
      // one that answers "where is this running".
      if (current !== null && !out.has(current)) out.set(current, value);
    }
  }
  return out;
}
```

`src/core/dev/containers.ts`:

```ts
/**
 * Containers, grouped by the project they belong to. Port of
 * `dev/containers.rs`.
 *
 * Docker Compose labels every container it starts with
 * `com.docker.compose.project.working_dir` — the absolute path of the directory
 * the compose file was run from. That is a direct join key to a project on
 * disk, which is what lets a row for "the server on 3000" expand into the
 * containers that server talks to.
 *
 * Shelling out to `docker` rather than speaking to the socket: this runs once
 * per refresh at most, the CLI handles context selection, and a missing Docker
 * must be an empty list rather than an error.
 */
import { execFileRunner, lines, type Runner } from "./run";

export interface DevContainer {
  name: string;
  /** The compose project name. Usually the directory's basename, but not
   *  always — and when it differs, this is the name the containers themselves
   *  are prefixed with, so it is the one a human recognises. */
  project: string;
  /** `running`, `exited (255)`, `restarting` — verbatim from Docker. */
  status: string;
  /** True only for `Up …`. Anything else, including `restarting`, is not. */
  running: boolean;
  /** Whether Docker's own healthcheck is failing, when the image defines one. */
  unhealthy: boolean;
  /** Host ports this container publishes, for the port-conflict question. */
  ports: number[];
}

// Tab-separated rather than JSON: one format string, no parser, and container
// names cannot contain tabs.
const FORMAT = [
  '{{.Label "com.docker.compose.project.working_dir"}}',
  "{{.Names}}",
  "{{.Status}}",
  "{{.Ports}}",
  '{{.Label "com.docker.compose.project"}}',
].join("\t");

export const DOCKER_ARGS = ["ps", "--all", "--filter", "label=com.docker.compose.project", "--format", FORMAT];

/** Containers keyed by the project directory they were composed from.
 *
 *  Never rejects: no Docker, no daemon, or a permission problem all mean the
 *  same thing to a caller — no containers to show. */
export async function byProjectDir(runner: Runner = execFileRunner): Promise<Map<string, DevContainer[]>> {
  const out = await runner("docker", DOCKER_ARGS);
  return parse(out.stdout);
}

export function parse(output: string): Map<string, DevContainer[]> {
  const out = new Map<string, DevContainer[]>();
  for (const line of lines(output)) {
    const parts = line.split("\t");
    const [rawDir, rawName, rawStatus] = parts;
    if (rawDir === undefined || rawName === undefined || rawStatus === undefined) continue;
    const dir = rawDir.trim();
    if (dir === "" || rawName.trim() === "") continue;
    const ports = parts[3] === undefined ? [] : parsePorts(parts[3]);
    // Older output, and any hand-written fixture, may stop at the ports. The
    // directory's basename is the same answer in the common case.
    const labelled = parts[4]?.trim();
    const project = labelled !== undefined && labelled !== "" ? labelled : leaf(dir);
    const list = out.get(dir) ?? [];
    list.push({
      name: rawName.trim(),
      project,
      status: rawStatus.trim(),
      // "Up 5 months (unhealthy)" is running; "Restarting" is not, because a
      // crash-looping container is not something you can use.
      running: rawStatus.trimStart().startsWith("Up"),
      unhealthy: rawStatus.includes("unhealthy"),
      ports,
    });
    out.set(dir, list);
  }
  for (const list of out.values()) list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** `0.0.0.0:3306->3306/tcp, [::]:3306->3306/tcp` → `[3306]`.
 *
 *  Host ports only — the left side of the arrow. A container's internal port is
 *  not something anything on this machine can collide with. */
export function parsePorts(ports: string): number[] {
  const found: number[] = [];
  for (const mapping of ports.split(",")) {
    const host = mapping.split("->")[0]!;
    const last = host.slice(host.lastIndexOf(":") + 1).trim();
    // Rust parses a u16 here, so `3306/tcp` (exposed, not published) fails.
    if (!/^\d+$/.test(last)) continue;
    const port = Number(last);
    if (port > 65535 || found.includes(port)) continue;
    found.push(port);
  }
  return found.sort((a, b) => a - b);
}

function leaf(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/core/dev/` — expected: PASS (the `resolves this very process` test is skipped off macOS).

- [ ] **Step 5: Commit**

```bash
git add src/core/dev/run.ts src/core/dev/run.test.ts src/core/dev/listen.ts src/core/dev/listen.test.ts src/core/dev/cwd.ts src/core/dev/cwd.test.ts src/core/dev/containers.ts src/core/dev/containers.test.ts
git commit -m "feat(dev): enumerate listeners, working directories and compose containers"
```

### Task 8: The probe, the stop guard, and the board join

**Files:**
- Create: `src/core/dev/probe.ts`, `src/core/dev/stop.ts`, `src/core/dev/board.ts`
- Test: `src/core/dev/probe.test.ts`, `src/core/dev/stop.test.ts`, `src/core/dev/board.test.ts`

**Interfaces:**
- Consumes: `Listener`, `key`, `family`, `foreign`, `enumerate` from `src/core/dev/listen.ts`; `forPids` from `src/core/dev/cwd.ts`; `DevContainer`, `byProjectDir` from `src/core/dev/containers.ts`; `Runner`, `execFileRunner` from `src/core/dev/run.ts`; `DddError` from `src/core/error.ts`; `record`, `isArray`, `isBoolean`, `isString` from `src/core/json.ts`.
- Produces:
  - `probe.ts`: `UP_MS`, `DEADLINE_MS`, `Health`, `Probe { health; latencyMs }`, `DevProbe { health; latencyMs; checkedAt }`, `Target { host; port }`, `BatchTarget { key; target; http }`, `classify(connected, firstByteMs)`, `target(address, port)`, `browserUrl(address, port)`, `HTTP_PROCESSES`, `speaksHttp(process, allowlist)`, `httpRequest(target)`, `run(target, http, deadlineMs)`, `batch(targets, deadlineMs)`.
  - `stop.ts`: `Refusal`, `refusalMessage(r)`, `mayStop(key, pid, process, fresh): Refusal | null`, `signal(pid, platform?, kill?)`.
  - `board.ts`: `KnownProject { path; id; isRepoLink }`, `DevServerFilter`, `devServerFilterFromJson(raw)`, `DevServerRow`, `DevServerListing`, `Snapshot`, `emptySnapshot()`, `MEMO_FLOOR_MS`, `EPHEMERAL`, `Memo`, `readMachine(runner?, platform?)`, `join(listeners, cwds, known, byDir, filter)`, `ProbeRunner`, `list(snapshot, known, filter, probeRunner?)`.

- [ ] **Step 1: Write the failing tests**

`src/core/dev/probe.test.ts`:

```ts
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HTTP_PROCESSES, browserUrl, batch, classify, httpRequest, run, speaksHttp, target } from "./probe";

/** A server this test owns. `answer` is what it writes back, if anything. */
function listening(host: string, answer: string | null): Promise<{ port: number; seen: string[]; close: () => void }> {
  const sockets: net.Socket[] = [];
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    // Replies only once it has been asked, so `seen` is always populated before
    // the client sees a byte — no race between the two assertions.
    socket.on("data", (chunk) => {
      seen.push(chunk.toString());
      if (answer !== null) socket.write(answer);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        seen,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

const closing: (() => void)[] = [];
afterEach(() => {
  while (closing.length > 0) closing.pop()!();
});

async function server(host: string, answer: string | null) {
  const s = await listening(host, answer);
  closing.push(s.close);
  return s;
}

describe("classifying a probe", () => {
  it("calls a timeout slow and never down", () => {
    // The rule the whole widget rests on. A cold Next compile takes fifteen
    // seconds; reporting it dead would tell you to kill what you are waiting for.
    expect(classify(true, null).health).toBe("slow");
    expect(classify(true, 1400).health).toBe("slow");
  });

  it("calls only a refused connect down", () => {
    expect(classify(false, null)).toEqual({ health: "down", latencyMs: null });
  });

  it("puts the measured values where they were intended", () => {
    // 5ms symfony and 978ms next-server, the two real measurements the boundary
    // was chosen between.
    expect(classify(true, 5)).toEqual({ health: "up", latencyMs: 5 });
    expect(classify(true, 978).health).toBe("slow");
    expect(classify(true, 249).health).toBe("up");
    expect(classify(true, 250).health).toBe("slow");
  });

  it("never returns unknown — there is no path from `not probed` to a verdict", () => {
    // Claiming a server is healthy because nobody asked is the one lie this
    // widget must not tell, so `unknown` is only ever the initial value.
    for (const p of [classify(false, null), classify(true, null), classify(true, 5)]) {
      expect(p.health).not.toBe("unknown");
    }
  });
});

describe("choosing what to dial", () => {
  it("probes a v6 bind on v6", () => {
    // The bug that was actually hit: DDD's own dev server binds [::1]:5199 and
    // an IPv4 probe reports it dead.
    expect(target("::1", 5199)).toEqual({ host: "::1", port: 5199 });
    expect(target("[::1]", 5199).host).toBe("::1");
    // A v6 wildcard answers on ::1.
    expect(target("::", 5199).host).toBe("::1");
    expect(target("[::]", 5199).host).toBe("::1");
  });

  it("probes a v4 bind on v4", () => {
    expect(target("127.0.0.1", 8000).host).toBe("127.0.0.1");
    expect(target("0.0.0.0", 8000).host).toBe("127.0.0.1");
    expect(target("*", 8000).host).toBe("127.0.0.1");
  });

  it("probes a specific address verbatim, and never a name", () => {
    expect(target("192.168.1.10", 80).host).toBe("192.168.1.10");
    // `localhost` resolves through the system resolver, whose family preference
    // is not ours to predict — a name would make the family bug intermittent
    // rather than fixed.
    expect(target("localhost", 80).host).toBe("127.0.0.1");
  });

  it("offers a browser url that is deliberately not the probe target", () => {
    expect(browserUrl("::1", 5199)).toBe("http://localhost:5199");
    expect(browserUrl("127.0.0.1", 8000)).toBe("http://localhost:8000");
    expect(browserUrl("*", 3000)).toBe("http://localhost:3000");
    // A real bound address stays itself, bracketed when it must be.
    expect(browserUrl("192.168.1.10", 80)).toBe("http://192.168.1.10:80");
    expect(browserUrl("fe80::1", 8080)).toBe("http://[fe80::1]:8080");
  });
});

describe("the http allowlist", () => {
  it("is the bundled list, verbatim", () => {
    expect(HTTP_PROCESSES).toEqual([
      "node", "next-server", "next", "vite", "esbuild", "webpack", "bun", "deno",
      "symfony", "php", "php-fpm", "caddy", "nginx", "httpd", "traefik",
      "python", "python3", "gunicorn", "uvicorn", "flask", "django",
      "ruby", "rails", "puma", "cargo", "rustc", "dotnet", "java", "gradle",
    ]);
  });

  it("sends http bytes only to processes it vouches for", () => {
    expect(speaksHttp("next-server", [])).toBe(true);
    expect(speaksHttp("Python", [])).toBe(true);
    // The point of the allowlist: a database must never be sent HEAD /.
    expect(speaksHttp("postgres", [])).toBe(false);
    expect(speaksHttp("mysqld", [])).toBe(false);
    expect(speaksHttp("redis-server", [])).toBe(false);
    // Another UID's socket has no process name at all.
    expect(speaksHttp(null, [])).toBe(false);
    expect(speaksHttp("", [])).toBe(false);
  });

  it("lets a widget's own allowlist replace the default", () => {
    expect(speaksHttp("postgres", ["postgres"])).toBe(true);
    expect(speaksHttp("next-server", ["postgres"])).toBe(false);
  });
});

describe("the transport, against sockets this test owns", () => {
  it("connects to a socket that exists and calls a closed port down", async () => {
    const s = await server("127.0.0.1", null);
    // Tier 1 only: it accepted, and we asked it nothing.
    expect(await run({ host: "127.0.0.1", port: s.port }, false, 500)).toEqual({ health: "up", latencyMs: null });

    // Port 1 rather than a freed ephemeral one: the kernel hands those straight
    // to the next thing that binds :0, which in a parallel run is another test.
    expect((await run({ host: "127.0.0.1", port: 1 }, false, 500)).health).toBe("down");
  });

  it("calls a listener that accepts but never answers slow, not down", async () => {
    // Twenty lines of compiling Next.js. The kernel completes the handshake and
    // the process says nothing.
    const s = await server("127.0.0.1", null);
    const probe = await run({ host: "127.0.0.1", port: s.port }, true, 300);
    expect(probe).toEqual({ health: "slow", latencyMs: null });
  });

  it("times a server that answers, and sends exactly the bytes the Rust sends", async () => {
    const s = await server("127.0.0.1", "HTTP/1.0 200 OK\r\n\r\n");
    const probe = await run({ host: "127.0.0.1", port: s.port }, true, 1000);
    expect(probe.health).toBe("up");
    expect(typeof probe.latencyMs).toBe("number");
    expect(s.seen.join("")).toBe(
      `HEAD / HTTP/1.0\r\nHost: 127.0.0.1:${s.port}\r\nUser-Agent: DDD-dev-board\r\nConnection: close\r\n\r\n`,
    );
    expect(httpRequest({ host: "::1", port: 5199 })).toBe(
      "HEAD / HTTP/1.0\r\nHost: [::1]:5199\r\nUser-Agent: DDD-dev-board\r\nConnection: close\r\n\r\n",
    );
  });

  it("reaches a v6 bind on v6", async () => {
    // The live half of the [::1]:5199 regression. CI containers routinely have
    // no IPv6 loopback, and a silent pass would be worse than a skip.
    let s: Awaited<ReturnType<typeof server>>;
    try {
      s = await server("::1", null);
    } catch {
      return; // no IPv6 loopback on this machine
    }
    expect((await run({ host: "::1", port: s.port }, false, 500)).health).toBe("up");
  });

  it("resolves every target a batch was given", async () => {
    const s = await server("127.0.0.1", null);
    const out = await batch(
      [
        { key: "a", target: { host: "127.0.0.1", port: s.port }, http: false },
        { key: "b", target: { host: "127.0.0.1", port: 1 }, http: false },
      ],
      500,
    );
    expect(out.get("a")!.health).toBe("up");
    expect(out.get("b")!.health).toBe("down");
  });
});
```

`src/core/dev/stop.test.ts`:

```ts
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Listener } from "./listen";
import { mayStop, refusalMessage, signal } from "./stop";

const listener = (port: number, pid: number | null, process: string): Listener => ({ port, address: "127.0.0.1", pid, process });

describe("the stop guard", () => {
  it("passes the same process on the same socket", () => {
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "node", [listener(3000, 4821, "node")])).toBeNull();
    // The name comparison ignores case, as the Rust's eq_ignore_ascii_case does.
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "Node", [listener(3000, 4821, "node")])).toBeNull();
  });

  it("refuses a recycled pid by name", () => {
    // The race this exists for: node exited, the PID came back as something
    // else entirely.
    const refusal = mayStop("tcp:127.0.0.1:3000", 4821, "node", [listener(3000, 4821, "postgres")])!;
    expect(refusal.kind).toBe("reused");
    // The refusal names what is there now.
    expect(refusalMessage(refusal)).toBe("declined: that port now belongs to postgres (pid 4821), not the process you clicked");
  });

  it("refuses a different pid on the same port", () => {
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "node", [listener(3000, 9999, "node")])!.kind).toBe("reused");
  });

  it("refuses a socket that is gone rather than signalling", () => {
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "node", [])).toEqual({ kind: "notListening" });
  });

  it("treats the same port in the other family as a different socket", () => {
    // Keyed by address and port, so [::1]:3000 never satisfies a guard drawn
    // for 127.0.0.1:3000.
    const v6 = { ...listener(3000, 4821, "node"), address: "::1" };
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "node", [v6])).toEqual({ kind: "notListening" });
  });

  it("refuses a nameless row before anything is enumerated", () => {
    // Checked first: with no name there is nothing to compare, so the guard
    // cannot run and must not be skipped.
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "  ", [listener(3000, 4821, "node")])).toEqual({ kind: "unnamed" });
  });

  it("refuses another user's socket", () => {
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "node", [listener(3000, null, "")])).toEqual({ kind: "foreign" });
  });

  it("gives every refusal a sentence the widget can show as it stands", () => {
    expect(refusalMessage({ kind: "notListening" })).toBe("it already exited — nothing is on that port now");
    expect(refusalMessage({ kind: "foreign" })).toBe("not your process — DDD will not ask for privilege to stop it");
    expect(refusalMessage({ kind: "unnamed" })).toBe("no process name to verify against, so the reuse guard cannot run");
    for (const r of [{ kind: "notListening" }, { kind: "reused", now: "postgres (pid 1)" }, { kind: "foreign" }, { kind: "unnamed" }] as const) {
      expect(refusalMessage(r).length).toBeGreaterThan(20);
    }
  });
});

describe("signalling", () => {
  it("sends SIGTERM to a process this test owns", async () => {
    const child = spawn("sleep", ["30"]);
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const ended = new Promise<string | null>((resolve) => child.once("exit", (_code, sig) => resolve(sig)));
    signal(child.pid!);
    expect(await ended).toBe("SIGTERM");
  }, 15_000);

  it("maps a refused signal to the sentence that says why", () => {
    const eperm = () => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    };
    expect(() => signal(1, "darwin", eperm)).toThrow("not your process — DDD will not ask for privilege to stop it");

    const esrch = () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    expect(() => signal(4821, "darwin", esrch)).toThrow("could not stop pid 4821: kill ESRCH");
  });

  it("offers nothing at all on Windows", () => {
    // `TerminateProcess` is SIGKILL-equivalent and `GenerateConsoleCtrlEvent`
    // does not cross sessions reliably, so offering the only available
    // primitive would quietly break the no-force rule.
    let killed = 0;
    expect(() => signal(4821, "win32", () => void killed++)).toThrow(
      "could not stop pid 4821: stopping a process is not offered on Windows: the only primitive available is a force kill",
    );
    expect(killed).toBe(0);
  });
});
```

`src/core/dev/board.test.ts`:

```ts
import net from "node:net";
import { describe, expect, it } from "vitest";
import type { DevContainer } from "./containers";
import type { Listener } from "./listen";
import {
  EPHEMERAL,
  MEMO_FLOOR_MS,
  Memo,
  devServerFilterFromJson,
  emptySnapshot,
  join,
  list,
  readMachine,
  type DevServerFilter,
  type KnownProject,
  type Snapshot,
} from "./board";
import type { Runner } from "./run";

const l = (address: string, port: number, pid: number | null, process: string): Listener => ({
  port,
  address,
  pid,
  process: pid === null ? "" : process,
});

const project = (path: string, id: string | null): KnownProject => ({ path, id, isRepoLink: false });

const container = (name: string, running: boolean, ports: number[]): DevContainer => ({
  name,
  // Compose names containers `<project>-<service>-<n>`, so this mirrors what a
  // real `docker ps` would report.
  project: name.split("-")[0]!,
  status: running ? "Up 2 hours" : "Exited (0)",
  running,
  unhealthy: false,
  ports,
});

/** The measured reality: a handful of dev servers among hundreds of listeners
 *  belonging to Spotify, Sonos, Chrome and Control Centre. */
const machine = (): Listener[] => [
  l("*", 3000, 81631, "node"),
  l("127.0.0.1", 8005, 25197, "symfony"),
  l("::1", 5199, 24845, "node"),
  l("*", 1900, 1378, "Spotify"),
  l("*", 5000, 1191, "ControlCenter"),
  l("*", 5353, 87611, "Google Chrome Helper"),
  l("*", 631, null, ""),
  l("*", 0, 1013, "sharingd"),
];

const known = (): KnownProject[] => [
  project("/Users/rene/Projects/vanbeurden", "p1"),
  project("/Users/rene/Projects/climate4u", null),
  project("/Users/rene/Projects/DDD", "p2"),
];

const cwds = (): Map<number, string> =>
  new Map([
    [81631, "/Users/rene/Projects/vanbeurden"],
    [25197, "/Users/rene/Projects/climate4u"],
    [24845, "/Users/rene/Projects/DDD"],
    // The noise has a working directory too — it is just never a project.
    [1378, "/"],
    [1191, "/"],
    [87611, "/"],
  ]);

const NO_CONTAINERS = new Map<string, DevContainer[]>();
const ALL: DevServerFilter = { knownOnly: false };

describe("the join", () => {
  it("is the filter", () => {
    // 311 listeners of which 237 are noise was the measurement that decided this
    // default. A dev server runs inside a project; Spotify does not.
    const out = join(machine(), cwds(), known(), NO_CONTAINERS, {});
    // Ordered by port, which is how anyone hunting one reads the board.
    expect(out.rows.map((r) => r.projectName)).toEqual(["vanbeurden", "DDD", "climate4u"]);
    expect(out.rows.map((r) => r.port)).toEqual([3000, 5199, 8005]);
  });

  it("counts what is hidden rather than silently eating it", () => {
    const out = join(machine(), cwds(), known(), NO_CONTAINERS, {});
    // Spotify, ControlCenter, Chrome and the foreign socket — port 0 is not
    // counted, because it was never a candidate.
    expect(out.hidden).toBe(4);
    expect(out.foreignCount).toBe(1);
  });

  it("never makes a row of port zero, even showing everything", () => {
    // It appears in the table for sockets bound without a port. Nothing can
    // connect to it and it is pure noise.
    const out = join(machine(), cwds(), known(), NO_CONTAINERS, ALL);
    expect(out.rows.every((r) => r.port !== 0)).toBe(true);
    expect(out.rows).toHaveLength(7);
    expect(out.hidden).toBe(0);
  });

  it("keeps a v6 row's family and gives it a row of its own", () => {
    const ddd = join(machine(), cwds(), known(), NO_CONTAINERS, {}).rows.find((r) => r.port === 5199)!;
    expect(ddd.family).toBe("v6");
    expect(ddd.key).toBe("tcp:::1:5199");
    // The URL offered to a human is localhost; the probe target is not.
    expect(ddd.url).toBe("http://localhost:5199");
  });

  it("rolls a monorepo server up to its nearest project, and says that it did", () => {
    const dirs = cwds();
    dirs.set(81631, "/Users/rene/Projects/vanbeurden/packages/web");
    const out = join(machine(), dirs, known(), NO_CONTAINERS, {});
    expect(out.rows.find((r) => r.port === 3000)!.projectName).toBe("vanbeurden");
    expect(out.rows.find((r) => r.port === 3000)!.matchedAncestor).toBe(true);
    expect(out.rows.find((r) => r.port === 8005)!.matchedAncestor).toBe(false);
  });

  it("lets a nested project win over its parent", () => {
    // Longest match, so a project inside another is attributed to the nearer one
    // rather than swallowed by the outer.
    const out = join(
      [l("*", 3000, 81631, "node")],
      new Map([[81631, "/Users/rene/Projects/vanbeurden"]]),
      [project("/Users/rene/Projects", null), project("/Users/rene/Projects/vanbeurden", "p1")],
      NO_CONTAINERS,
      {},
    );
    expect(out.rows[0]!.projectId).toBe("p1");
  });

  it("does not treat a sibling directory as a prefix match", () => {
    // "/p/app" must not claim "/p/app-legacy". String prefixing without the
    // separator is the classic way this goes wrong.
    const out = join([l("*", 3000, 1, "node")], new Map([[1, "/p/app-legacy"]]), [project("/p/app", "p1")], NO_CONTAINERS, {});
    expect(out.rows).toEqual([]);
  });

  it("carries a project row's containers", () => {
    // The drill-down: the server on 8005 expands into what it talks to.
    const byDir = new Map([["/Users/rene/Projects/climate4u", [container("climate4u-database-1", true, [5433])]]]);
    const out = join(machine(), cwds(), known(), byDir, {});
    expect(out.rows.find((r) => r.port === 8005)!.containers.map((c) => c.name)).toEqual(["climate4u-database-1"]);
    // A project with no containers gets an empty list, not a missing field.
    expect(out.rows.find((r) => r.port === 3000)!.containers).toEqual([]);
  });

  it("attributes a docker-published port by which compose file published it", () => {
    // The daemon's cwd is Docker's own, never a project, so the port itself has
    // to do the attributing.
    const byDir = new Map([["/Users/rene/Projects/climate4u", [container("climate4u-database-1", true, [5433])]]]);
    const out = join([l("*", 5433, 79631, "com.docker.backend")], new Map(), known(), byDir, {});
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.projectName).toBe("climate4u");
    expect(out.rows[0]!.docker).toBe(true);
  });

  it("never gives a docker row a url to probe", () => {
    // Shown because it answers "what has 5432"; never probed, because a
    // dashboard must not send HEAD / to Postgres on a timer.
    const byDir = new Map([["/p", [container("db-1", true, [5432])]]]);
    const out = join([l("*", 5432, 1, "com.docker.backend")], new Map(), [project("/p", null)], byDir, {});
    expect(out.rows[0]!.url).toBeNull();
  });

  it("does not let a stopped container claim a port", () => {
    const byDir = new Map([["/p", [container("db-1", false, [5432])]]]);
    const out = join([l("*", 5432, 1, "com.docker.backend")], new Map(), [project("/p", null)], byDir, ALL);
    expect(out.rows[0]!.projectName).toBeNull();
  });

  it("names a docker row by its compose project, not its directory", () => {
    // The real case from this machine: a compose file in
    // `…/onderwijscatalogus/backend` publishes 8062. The directory's basename is
    // "backend", which matches nothing the user sees in `docker ps`.
    const dir = "/Users/rene/Projects/onderwijscatalogus/backend";
    const byDir = new Map([[dir, [container("onderwijscatalogus-nginx-1", true, [8062])]]]);
    const out = join([l("*", 8062, 1, "com.docker.backend")], new Map(), [project(dir, null)], byDir, {});
    expect(out.rows[0]!.projectName).toBe("onderwijscatalogus");
  });

  it("lets a registered project keep its own name even with containers", () => {
    // The registry is the user's own naming. Compose does not get to overrule
    // it — only to fill in where there is nothing.
    const byDir = new Map([["/Users/rene/Projects/climate4u", [container("c4u-database-1", true, [5433])]]]);
    const out = join(machine(), cwds(), known(), byDir, {});
    expect(out.rows.find((r) => r.port === 8005)!.projectName).toBe("climate4u");
  });

  it("never gives a foreign socket a project or a url", () => {
    const foreign = join(machine(), cwds(), known(), NO_CONTAINERS, ALL).rows.find((r) => r.foreign)!;
    expect(foreign.projectName).toBeNull();
    expect(foreign.url).toBeNull();
    expect(foreign.pid).toBeNull();
    expect(foreign.process).toBeNull();
  });

  it("never births a row healthy", () => {
    // Unknown until probed. Claiming health because nobody asked is the one lie
    // this widget must not tell.
    const out = join(machine(), cwds(), known(), NO_CONTAINERS, {});
    expect(out.rows.every((r) => r.health === "unknown" && r.latencyMs === null && r.checkedAt === null)).toBe(true);
  });

  it("searches port, process and project", () => {
    for (const [query, port] of [["8005", 8005], ["symfony", 8005], ["climate", 8005], ["NODE", 3000]] as const) {
      const out = join(machine(), cwds(), known(), NO_CONTAINERS, { query });
      expect(out.rows.map((r) => r.port)).toContain(port);
    }
    expect(join(machine(), cwds(), known(), NO_CONTAINERS, { query: "symfony" }).rows).toHaveLength(1);
  });

  it("collapses a forked pool into one server rather than four rows", () => {
    // php-fpm workers and a JVM's children inherit the parent's listening
    // socket, so the OS reports one row per process. Measured on this machine:
    // 16 rows collapse.
    const out = join(
      [l("127.0.0.1", 8005, 100, "php-fpm"), l("127.0.0.1", 8005, 101, "php-fpm"), l("127.0.0.1", 8005, 102, "php-fpm")],
      new Map([[100, "/p"], [101, "/p"], [102, "/p"]]),
      [project("/p", null)],
      NO_CONTAINERS,
      {},
    );
    expect(out.rows).toHaveLength(1);
    // The first process on the socket represents it; the others are counted,
    // not discarded.
    expect(out.rows[0]!.pid).toBe(100);
    expect(out.rows[0]!.workers).toBe(2);
  });

  it("keeps the same port in two families as two rows", () => {
    // Deduplication is by socket, and 127.0.0.1:8000 and [::1]:8000 are two
    // sockets with two processes. Collapsing them would hide one.
    const out = join(
      [l("127.0.0.1", 8000, 1, "node"), l("::1", 8000, 2, "node")],
      new Map([[1, "/p"], [2, "/p"]]),
      [project("/p", null)],
      NO_CONTAINERS,
      {},
    );
    expect(out.rows).toHaveLength(2);
    expect(out.rows.every((r) => r.workers === 0)).toBe(true);
  });

  it("does not call a kernel-assigned port a dev server, but brings it back when asked", () => {
    // 142 of this machine's rows sit at or above 49152: PhpStorm helpers, junie,
    // and the php-fpm workers behind a symfony server. Every one of the 21 below
    // it was real. Nobody types localhost:62662.
    const listeners = [l("127.0.0.1", 8005, 1, "symfony"), l("127.0.0.1", 62662, 2, "php-fpm")];
    const dirs = new Map([[1, "/p"], [2, "/p"]]);
    const out = join(listeners, dirs, [project("/p", null)], NO_CONTAINERS, {});
    expect(out.rows.map((r) => r.port)).toEqual([8005]);
    expect(out.hidden).toBe(1);

    const all = join(listeners, dirs, [project("/p", null)], NO_CONTAINERS, { ephemeral: true });
    expect(all.rows).toHaveLength(2);
  });

  it("puts the boundary where the IANA range starts", () => {
    for (const [port, shown] of [[49151, 1], [EPHEMERAL, 0]] as const) {
      const out = join([l("127.0.0.1", port, 1, "node")], new Map([[1, "/p"]]), [project("/p", null)], NO_CONTAINERS, {});
      expect(out.rows).toHaveLength(shown);
    }
  });

  it("marks a repo-link match with its path and leaves a registry-only match without one", () => {
    const out = join(
      [l("127.0.0.1", 8005, 1, "symfony"), l("127.0.0.1", 8006, 2, "symfony")],
      new Map([[1, "/p/linked"], [2, "/p/registered"]]),
      [{ path: "/p/linked", id: null, isRepoLink: true }, project("/p/registered", "p9")],
      NO_CONTAINERS,
      {},
    );
    expect(out.rows[0]!.repoPath).toBe("/p/linked");
    expect(out.rows[0]!.projectId).toBeNull();
    expect(out.rows[1]!.repoPath).toBeNull();
    expect(out.rows[1]!.projectId).toBe("p9");
  });
});

describe("the filter shape", () => {
  it("keeps only what is present", () => {
    expect(devServerFilterFromJson({})).toEqual({});
    expect(devServerFilterFromJson({ knownOnly: false, query: "node", http: ["node"], ephemeral: true, probe: true })).toEqual({
      knownOnly: false,
      query: "node",
      http: ["node"],
      ephemeral: true,
      probe: true,
    });
    expect(devServerFilterFromJson({ query: null })).toEqual({});
  });

  it("refuses a malformed filter", () => {
    expect(() => devServerFilterFromJson({ knownOnly: "yes" })).toThrow(/^json: /);
    expect(() => devServerFilterFromJson({ http: "node" })).toThrow(/^json: /);
    expect(() => devServerFilterFromJson({ http: [1] })).toThrow(/^json: /);
    expect(() => devServerFilterFromJson("nope")).toThrow(/^json: /);
  });
});

describe("the memo", () => {
  const counting = (reads: { n: number }) => async (): Promise<Snapshot> => {
    reads.n += 1;
    return { ...emptySnapshot(), scanMs: 7 };
  };

  it("reads the machine once for two calls inside the floor", async () => {
    // Two widgets on one board, or a manual refresh landing on a poll, must not
    // mean two lsof calls and two docker ps.
    const reads = { n: 0 };
    const memo = new Memo();
    const first = await memo.get(1_000, MEMO_FLOOR_MS, counting(reads));
    const second = await memo.get(1_500, MEMO_FLOOR_MS, counting(reads));
    expect(reads.n).toBe(1);
    // The cached read is handed back whole.
    expect(second.scanMs).toBe(first.scanMs);
  });

  it("reads again outside the floor", async () => {
    const reads = { n: 0 };
    const memo = new Memo();
    await memo.get(1_000, MEMO_FLOOR_MS, counting(reads));
    await memo.get(1_000 + MEMO_FLOOR_MS, MEMO_FLOOR_MS, counting(reads));
    // The floor must not make the board stale.
    expect(reads.n).toBe(2);
  });

  it("makes a second caller wait for the read already in flight rather than starting its own", async () => {
    const reads = { n: 0 };
    const memo = new Memo();
    const slow = async (): Promise<Snapshot> => {
      reads.n += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ...emptySnapshot(), scanMs: 20 };
    };
    const [a, b] = await Promise.all([memo.get(1_000, MEMO_FLOOR_MS, slow), memo.get(1_001, MEMO_FLOOR_MS, slow)]);
    expect(reads.n).toBe(1);
    expect(a).toBe(b);
  });
});

describe("reading the machine", () => {
  it("asks lsof for listeners, lsof for their working directories, and docker once", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (file, args) => {
      calls.push([file, ...args]);
      if (file === "docker") return { stdout: "/p\tapi-1\tUp\t\n", ok: true };
      if (args.includes("-d")) return { stdout: "p1\nn/p\n", ok: true };
      return { stdout: "p1\ncnode\nf8\nn127.0.0.1:3000\n", ok: true };
    };
    const snapshot = await readMachine(runner, "darwin");
    expect(calls.map((c) => c[0])).toEqual(["lsof", "lsof", "docker"]);
    expect(snapshot.listeners).toEqual([{ port: 3000, address: "127.0.0.1", pid: 1, process: "node" }]);
    expect(snapshot.cwds.get(1)).toBe("/p");
    expect(snapshot.containers.get("/p")).toHaveLength(1);
    expect(typeof snapshot.scanMs).toBe("number");
  });
});

describe("listing, including the probe pass", () => {
  const snapshot = (): Snapshot => ({ listeners: machine(), cwds: cwds(), containers: NO_CONTAINERS, scanMs: 42 });

  it("does no socket work on the first paint", async () => {
    // probe defaults false: rows appear before anything is dialled.
    const out = await list(snapshot(), known(), {});
    expect(out.rows.every((r) => r.health === "unknown" && r.checkedAt === null)).toBe(true);
    expect(out.partial).toBe(false);
    // The scan cost is reported, not invented.
    expect(out.scanMs).toBe(42);
  });

  it("reaches a real socket and reports the others down", async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const snap: Snapshot = {
        // Not in the HTTP allowlist on purpose: this test is about the connect
        // tier reaching the right rows, and tier 2 against a listener that never
        // accepts is `slow` by design.
        listeners: [l("127.0.0.1", port, 1, "myserver"), l("127.0.0.1", 1, 2, "myserver")],
        cwds: new Map([[1, "/p"], [2, "/p"]]),
        containers: NO_CONTAINERS,
        scanMs: 1,
      };
      // A kernel-assigned port is exactly what bind(:0) hands back, so this test
      // has to ask for the range it is testing in.
      const out = await list(snap, [project("/p", "p1")], { probe: true, ephemeral: true });
      const live = out.rows.find((r) => r.port === port)!;
      expect(live.health).toBe("up");
      // A verdict carries when it was reached.
      expect(Number.isNaN(Date.parse(live.checkedAt!))).toBe(false);
      expect(out.rows.find((r) => r.port === 1)!.health).toBe("down");
      expect(out.partial).toBe(false);
    } finally {
      server.close();
    }
  }, 15_000);

  it("never dials a docker row, even when probing", async () => {
    // The rule stated once in join as "no url" and again here as "no packet".
    const byDir = new Map([["/p", [container("db-1", true, [5432])]]]);
    const snap: Snapshot = {
      listeners: [l("127.0.0.1", 5432, 1, "com.docker.backend")],
      cwds: new Map(),
      containers: byDir,
      scanMs: 1,
    };
    const out = await list(snap, [project("/p", null)], { probe: true });
    // Nothing is on 5432 here, so a probe would have said "down" — staying
    // unknown is the evidence that no packet was sent.
    expect(out.rows[0]!.health).toBe("unknown");
    expect(out.rows[0]!.checkedAt).toBeNull();
  });

  it("never dials a foreign socket", async () => {
    const snap: Snapshot = { listeners: [l("127.0.0.1", 1, null, "")], cwds: new Map(), containers: NO_CONTAINERS, scanMs: 1 };
    const out = await list(snap, [], { probe: true, knownOnly: false });
    expect(out.rows[0]!.health).toBe("unknown");
  });

  it("marks a listing partial when the probe batch came back short", async () => {
    // Nothing resolved, so every row keeps `unknown` and gets another chance
    // next cycle — never a fabricated verdict.
    const snap: Snapshot = {
      listeners: [l("127.0.0.1", 8005, 1, "symfony")],
      cwds: new Map([[1, "/p"]]),
      containers: NO_CONTAINERS,
      scanMs: 1,
    };
    const out = await list(snap, [project("/p", null)], { probe: true }, async () => new Map());
    expect(out.partial).toBe(true);
    expect(out.rows[0]!.health).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/dev/probe.test.ts src/core/dev/stop.test.ts src/core/dev/board.test.ts` — expected: three files fail to collect, `Failed to resolve import "./probe"`, `"./stop"`, `"./board"`.

- [ ] **Step 3: Write the modules**

`src/core/dev/probe.ts`:

```ts
/**
 * Is the thing on this port actually answering? Port of `dev/probe.rs`.
 *
 * Two tiers, because a bare TCP connect cannot tell a healthy server from a
 * wedged one: the kernel completes the handshake into the accept backlog
 * whether or not the process is in a state to accept it. A compiling Next.js
 * server connects instantly and then says nothing for fifteen seconds.
 *
 * So: connect always (safe against anything, and the only thing that can
 * produce `Down`), and time-to-first-byte only for processes we have reason to
 * believe speak HTTP. Sending `HEAD /` at Postgres every five seconds would be
 * antisocial.
 */
import net from "node:net";

/**
 * First byte under this and the server is fine.
 *
 * A loopback round trip is sub-millisecond of kernel work, so a quarter of a
 * second of it means the accept loop is busy — which for a dev server means
 * compiling. Measured: 5ms healthy, 978ms mid-compile. Two orders of magnitude
 * apart, so the boundary sits in an empty region.
 */
export const UP_MS = 250;

/** How long one probe may take before its answer is "slow", not "dead". */
export const DEADLINE_MS = 1500;

/** `unknown` is "not probed this cycle". It renders neutral and **never renders
 *  as up** — claiming a server is healthy because nobody asked is the one lie
 *  this widget must not tell. */
export type Health = "unknown" | "up" | "slow" | "down";

export interface Probe {
  health: Health;
  latencyMs: number | null;
}

/** What one on-demand probe answers — the Check button's return. */
export interface DevProbe {
  health: Health;
  latencyMs: number | null;
  checkedAt: string;
}

/** Where to dial. A host, never a name — see `target`. */
export interface Target {
  host: string;
  port: number;
}

export interface BatchTarget {
  key: string;
  target: Target;
  http: boolean;
}

/**
 * Turn a raw outcome into a verdict. Pure, and separated from the socket work
 * precisely so the rule that matters can be tested without one.
 *
 * **A timeout is never `down`.** Refused or reset is down; connected with no
 * bytes by the deadline is slow. A cold compile exceeds any sane deadline, and
 * calling that dead would be the tool confidently telling you to kill the thing
 * you are waiting for.
 */
export function classify(connected: boolean, firstByteMs: number | null): Probe {
  if (!connected) return { health: "down", latencyMs: null };
  // Connected, and nothing came back in time. Busy, not dead.
  if (firstByteMs === null) return { health: "slow", latencyMs: null };
  return { health: firstByteMs < UP_MS ? "up" : "slow", latencyMs: firstByteMs };
}

/**
 * Which address to probe, given how the socket was bound.
 *
 * **Never a name.** `localhost` resolves through the system resolver, whose
 * family preference is not ours to predict — and a family mismatch is the exact
 * bug this function exists to avoid. Anything that is not an IP literal falls
 * back to the v4 loopback, as the Rust's `parse().unwrap_or(LOCALHOST)` does.
 */
export function target(address: string, port: number): Target {
  // A wildcard bind in each family answers on that family's loopback.
  if (address === "0.0.0.0" || address === "*") return { host: "127.0.0.1", port };
  if (address === "::" || address === "[::]") return { host: "::1", port };
  const bare = address.replace(/^\[/, "").replace(/\]$/, "");
  return { host: net.isIP(bare) === 0 ? "127.0.0.1" : bare, port };
}

/**
 * What to put in a browser, which is deliberately *not* what we probe.
 *
 * For a loopback or wildcard bind that is `localhost`: it is what a developer
 * wants pasted into a browser, and browsers try both families themselves. For a
 * specific non-loopback bind it is the literal, bracketed for v6.
 */
export function browserUrl(address: string, port: number): string {
  const loopback = ["0.0.0.0", "*", "::", "[::]", "127.0.0.1", "::1", "[::1]"];
  const host = loopback.includes(address)
    ? "localhost"
    : address.includes(":")
      ? `[${address.replace(/^\[/, "").replace(/\]$/, "")}]`
      : address;
  return `http://${host}:${port}`;
}

/**
 * Process names we will send HTTP bytes to.
 *
 * An allowlist rather than a guess: a database or a message broker should never
 * receive `HEAD /` from a dashboard, and "it is on a high port" is not evidence
 * of anything. Overridable per widget.
 */
export const HTTP_PROCESSES: readonly string[] = [
  "node", "next-server", "next", "vite", "esbuild", "webpack", "bun", "deno",
  "symfony", "php", "php-fpm", "caddy", "nginx", "httpd", "traefik",
  "python", "python3", "gunicorn", "uvicorn", "flask", "django",
  "ruby", "rails", "puma", "cargo", "rustc", "dotnet", "java", "gradle",
];

export function speaksHttp(process: string | null, allowlist: readonly string[]): boolean {
  if (process === null) return false;
  const name = process.toLowerCase();
  // A widget's own list replaces the default rather than extending it.
  const list = allowlist.length > 0 ? allowlist : HTTP_PROCESSES;
  return list.some((p) => name.includes(p.toLowerCase()));
}

/**
 * The request bytes, verbatim from the Rust.
 *
 * HTTP/1.0 so the server closes rather than holding the connection open, and
 * HEAD so nothing large is ever sent back. `Host` because a vhosted server may
 * otherwise answer 400 — which is still a first byte, and a first byte is the
 * whole measurement. The host is the Rust's `SocketAddr` display: a v6 literal
 * is bracketed.
 */
export function httpRequest(t: Target): string {
  const addr = t.host.includes(":") ? `[${t.host}]:${t.port}` : `${t.host}:${t.port}`;
  return `HEAD / HTTP/1.0\r\nHost: ${addr}\r\nUser-Agent: DDD-dev-board\r\nConnection: close\r\n\r\n`;
}

/**
 * Probe one socket, in at most `deadlineMs`.
 *
 * Tier 1 is the connect: safe to point at anything, and the only thing that can
 * produce `down`. Tier 2 asks for a byte, and only of processes the allowlist
 * vouched for. A deadline that lands before the handshake is `down` (the Rust's
 * `connect_timeout` returns an error); one that lands after it is `slow`.
 */
export function run(t: Target, http: boolean, deadlineMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    const started = Date.now();
    let connected = false;
    let settled = false;
    const socket = net.connect({ host: t.host, port: t.port });
    const finish = (probe: Probe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(probe);
    };
    const timer = setTimeout(() => finish(classify(connected, null)), deadlineMs);
    // Refused, reset, or unreachable before the handshake is the one honest
    // `down`; anything after it is busy, not dead.
    socket.on("error", () => finish(classify(connected, null)));
    // A closed connection with no reply is still an answer we did not get.
    socket.on("end", () => finish(classify(connected, null)));
    socket.on("close", () => finish(classify(connected, null)));
    socket.on("connect", () => {
      connected = true;
      if (!http) {
        // It accepted a connection and we never asked it for anything, so we
        // have no evidence about its accept loop. `classify(true, null)` would
        // say `slow`, which would be inventing a symptom we did not observe —
        // hence not reusing it here. Up, with no latency: "listening".
        finish({ health: "up", latencyMs: null });
        return;
      }
      socket.once("data", () => finish(classify(true, Date.now() - started)));
      // It took the connection and would not take the request: busy, not dead.
      socket.write(httpRequest(t), (error) => {
        if (error) finish(classify(true, null));
      });
    });
  });
}

/**
 * Probe every row of a batch concurrently, under one deadline for the batch.
 *
 * Returns what resolved, keyed by row key. What is missing stayed `unknown` and
 * gets another chance next cycle: there is no retry inside a cycle, because
 * retrying inside a poll is how a five-second poll becomes twenty.
 */
export async function batch(targets: BatchTarget[], deadlineMs: number): Promise<Map<string, Probe>> {
  const settled = await Promise.all(targets.map(async (t) => [t.key, await run(t.target, t.http, deadlineMs)] as const));
  return new Map(settled);
}
```

`src/core/dev/stop.ts`:

```ts
/**
 * Asking a process to stop, and the guard that makes it defensible. Port of
 * `dev/stop.rs`.
 *
 * The instinct is to refuse this outright. The argument for shipping it is that
 * the alternative is worse: the user with an `EADDRINUSE` will copy the PID out
 * of this very widget and type `kill -9` at a shell, where the PID can be
 * mistyped and the reflex `-9` skips the shutdown the process was going to do.
 * Showing someone a PID and then declining to act on it is not caution.
 *
 * `SIGTERM` only. There is no force option at any depth of menu.
 */
import { DddError } from "../error";
import { key as keyOf, type Listener } from "./listen";

/** Why a stop was refused. Every variant is a sentence the widget can show as
 *  it stands — a refusal that cannot explain itself reads as a bug. */
export type Refusal =
  /** The socket is gone. Between the scan and the click, it exited on its own. */
  | { kind: "notListening" }
  /** Something is still on that port, and it is not what you clicked. This is
   *  the reuse guard firing, and it is the reason any of this is defensible. */
  | { kind: "reused"; now: string }
  /** No PID: another user's socket. There is no `sudo` path here, ever. */
  | { kind: "foreign" }
  /** A PID with no process name. The guard needs a name to compare, and a guard
   *  that cannot check is not a guard. */
  | { kind: "unnamed" };

export function refusalMessage(refusal: Refusal): string {
  switch (refusal.kind) {
    case "notListening":
      return "it already exited — nothing is on that port now";
    case "reused":
      return `declined: that port now belongs to ${refusal.now}, not the process you clicked`;
    case "foreign":
      return "not your process — DDD will not ask for privilege to stop it";
    case "unnamed":
      return "no process name to verify against, so the reuse guard cannot run";
  }
}

/**
 * May we signal this PID? `null` is yes.
 *
 * Re-enumerated listeners are the second half: between the scan that drew the
 * row and the click, ten seconds can pass, and a PID freed in that window gets
 * reassigned. Requiring the same PID on the same port under the same name turns
 * "silently killed the wrong process" into "declined, and here is what changed".
 *
 * Pure over its inputs, so the guard is tested without signalling anything.
 */
export function mayStop(key: string, pid: number, process: string, fresh: Listener[]): Refusal | null {
  if (process.trim() === "") return { kind: "unnamed" };
  const now = fresh.find((l) => keyOf(l) === key);
  if (now === undefined) return { kind: "notListening" };
  if (now.pid === null) return { kind: "foreign" };
  // The Rust compares with eq_ignore_ascii_case; process names are ASCII.
  if (now.pid !== pid || now.process.toLowerCase() !== process.toLowerCase()) {
    return { kind: "reused", now: `${now.process} (pid ${now.pid})` };
  }
  return null;
}

/** Injected only by tests, so the mapping below can be exercised without a
 *  process to refuse us. */
export type Kill = (pid: number, signal: "SIGTERM") => void;

/**
 * Send `SIGTERM`, and turn a refusal into the sentence the widget shows. The
 * PID has just been verified by `mayStop` against a fresh enumeration.
 *
 * Windows has no `SIGTERM`: `TerminateProcess` is `SIGKILL`-equivalent and
 * `GenerateConsoleCtrlEvent` does not cross sessions reliably, so offering the
 * only available primitive would quietly break the no-force rule. The widget
 * hides the button and says why rather than pretending.
 */
export function signal(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  kill: Kill = (target, sig) => {
    process.kill(target, sig);
  },
): void {
  if (platform === "win32") {
    throw DddError.invalid(
      `could not stop pid ${pid}: stopping a process is not offered on Windows: the only primitive available is a force kill`,
    );
  }
  try {
    kill(pid, "SIGTERM");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") {
      throw DddError.invalid("not your process — DDD will not ask for privilege to stop it");
    }
    // The Rust prints strerror here ("No such process (os error 3)"); Node's
    // message is "kill ESRCH". Same fact, different words — nothing reads it.
    throw DddError.invalid(`could not stop pid ${pid}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

`src/core/dev/board.ts`:

```ts
/**
 * What is running on this machine, which project it belongs to, and whether it
 * is answering. Port of `dev/mod.rs`.
 *
 * A live read, not an `Item`: the item cache is deliberately allowed to be
 * stale, which is fine for a pull request and fatal for liveness. So this looks
 * like `repos_list` — read the world, join it against what this environment
 * knows, return rows — and writes nothing at all.
 */
import { DddError } from "../error";
import { isArray, isBoolean, isString, record } from "../json";
import * as containers from "./containers";
import type { DevContainer } from "./containers";
import * as cwd from "./cwd";
import * as listen from "./listen";
import type { Listener } from "./listen";
import * as probe from "./probe";
import { execFileRunner, type Runner } from "./run";

export type { DevContainer };

export interface DevServerFilter {
  /**
   * Show only rows that map to a project on disk.
   *
   * Default **true**, and the measurement is why: this machine has 311
   * listening sockets, of which 237 are Spotify, Sonos, Chrome, Control Centre
   * and other things nobody wants on a dev board. The join is the filter — a
   * dev server runs inside a project directory and Spotify does not.
   */
  knownOnly?: boolean;
  /** Substring over process name, project name and port. */
  query?: string;
  /** Process names eligible for an HTTP probe. Bundled default when absent. */
  http?: string[];
  /**
   * Include ports the kernel assigned rather than a human chose.
   *
   * Default **false**, and measured: this machine has 142 listeners at or above
   * 49152 against 21 below it, every one of which is a real dev server or a
   * Docker publish. Nobody types `localhost:62662`.
   */
  ephemeral?: boolean;
  /** Probe inline during this listing. Default **false**: the first paint
   *  should show rows before any socket work happens. */
  probe?: boolean;
}

export function devServerFilterFromJson(raw: unknown): DevServerFilter {
  const o = record(raw, "filter");
  const out: DevServerFilter = {};
  for (const field of ["knownOnly", "ephemeral", "probe"] as const) {
    const v = o[field];
    if (v === undefined || v === null) continue;
    if (!isBoolean(v)) throw DddError.json(`invalid type for field \`${field}\``);
    out[field] = v;
  }
  if (o.query !== undefined && o.query !== null) {
    if (!isString(o.query)) throw DddError.json("invalid type for field `query`");
    out.query = o.query;
  }
  if (o.http !== undefined && o.http !== null) {
    if (!isArray(o.http)) throw DddError.json("invalid type for field `http`");
    out.http = o.http.map((p) => {
      if (!isString(p)) throw DddError.json("invalid type for field `http`");
      return p;
    });
  }
  return out;
}

/** One listening socket, joined against what this environment knows. Field
 *  order is the Rust struct's, because that is the JSON the widget reads. */
export interface DevServerRow {
  /** `tcp:127.0.0.1:8005` — identity, React key, and the handle the probe and
   *  stop commands take. */
  key: string;
  port: number;
  /** As bound, verbatim. The family is load-bearing, so it is shown. */
  address: string;
  family: string;
  pid: number | null;
  process: string | null;
  cwd: string | null;
  /** Basename of the matched project directory. */
  projectName: string | null;
  /** Set only when *this* environment's registry claims it. */
  projectId: string | null;
  /** Set when the link store claims it — enables IDE and terminal on a checkout
   *  that was never registered as a project. */
  repoPath: string | null;
  /** The match came from an ancestor rather than the cwd itself, so a monorepo
   *  row can say which project it rolled up to. */
  matchedAncestor: boolean;
  /** What to paste into a browser. `null` when we have no reason to think it
   *  speaks HTTP — a fabricated link to a database is worse than no link. */
  url: string | null;
  health: probe.Health;
  latencyMs: number | null;
  checkedAt: string | null;
  /** Another UID's socket: no PID, not ours to probe, project or stop. */
  foreign: boolean;
  /** A Docker-published port. Shown, because it answers "what has 5432", and
   *  never probed, because a dashboard should not send HEAD / to Postgres. */
  docker: boolean;
  /** Containers composed from this row's project directory. */
  containers: DevContainer[];
  /** Extra processes sharing this exact listening socket. A forked pool —
   *  php-fpm workers, a JVM's children — inherits the parent's listening socket,
   *  so the OS reports one row per process. They are one server. */
  workers: number;
}

export interface DevServerListing {
  rows: DevServerRow[];
  /** Listeners that exist but are not shown, so the filter carries a number
   *  rather than silently eating three quarters of the machine. */
  hidden: number;
  /** Sockets belonging to another user, counted so the "your processes" caveat
   *  is honest rather than a vibe. */
  foreignCount: number;
  scanMs: number;
  /** The probe deadline landed with rows unresolved. They stay `unknown` and
   *  get another chance next cycle — never a fabricated verdict. */
  partial: boolean;
}

/** A project this environment knows about, from either store. */
export interface KnownProject {
  path: string;
  id: string | null;
  isRepoLink: boolean;
}

// --- reading the machine ----------------------------------------------------

/** One read of the machine: what is listening, where those processes are, and
 *  what Docker composed from where. */
export interface Snapshot {
  listeners: Listener[];
  cwds: Map<number, string>;
  containers: Map<string, DevContainer[]>;
  scanMs: number;
}

export function emptySnapshot(): Snapshot {
  return { listeners: [], cwds: new Map(), containers: new Map(), scanMs: 0 };
}

/**
 * The floor under how often the OS is actually read.
 *
 * Two widgets on one board, or a manual refresh landing on top of a poll,
 * should not mean two `lsof` calls and two `docker ps`. Well under the 5s poll,
 * so it never makes the board stale — it only collapses bursts.
 */
export const MEMO_FLOOR_MS = 2000;

/**
 * Last read of the machine, and the single-flight around it.
 *
 * Deliberately not a module-level singleton: tests get their own instance, so a
 * memo test can never be made flaky by whatever else the suite is doing. The
 * Rust holds a mutex across the read; a second caller here awaits the read
 * already in flight instead, which is the same guarantee in a language with no
 * blocking lock.
 */
export class Memo {
  private last: { at: number; snapshot: Snapshot } | null = null;
  private inFlight: Promise<Snapshot> | null = null;

  async get(now: number, floorMs: number, read: () => Promise<Snapshot>): Promise<Snapshot> {
    if (this.last !== null && now - this.last.at < floorMs) return this.last.snapshot;
    if (this.inFlight !== null) return await this.inFlight;
    const reading = read().then(
      (snapshot) => {
        this.last = { at: now, snapshot };
        this.inFlight = null;
        return snapshot;
      },
      (e) => {
        this.inFlight = null;
        throw e;
      },
    );
    this.inFlight = reading;
    return await reading;
  }
}

/** Read the machine: listeners, then the working directory of every PID among
 *  them in one call, then Docker. */
export async function readMachine(runner: Runner = execFileRunner, platform: NodeJS.Platform = process.platform): Promise<Snapshot> {
  const started = Date.now();
  const listeners = await listen.enumerate(runner, platform);
  const pids = [...new Set(listeners.map((l) => l.pid).filter((pid): pid is number => pid !== null))].sort((a, b) => a - b);
  const cwds = await cwd.forPids(pids, runner, platform);
  const byDir = await containers.byProjectDir(runner);
  return { listeners, cwds, containers: byDir, scanMs: Date.now() - started };
}

/** The probe pass, injectable so a listing can be tested without sockets. */
export type ProbeRunner = (targets: probe.BatchTarget[], deadlineMs: number) => Promise<Map<string, probe.Probe>>;

/**
 * The whole command, minus the environment lookup: snapshot, join, probe.
 *
 * Split from `join` so the join stays pure and this stays the only part that
 * touches a socket.
 */
export async function list(
  snapshot: Snapshot,
  known: KnownProject[],
  filter: DevServerFilter,
  probeRunner: ProbeRunner = probe.batch,
): Promise<DevServerListing> {
  const http = filter.http ?? [];
  const listing = join(snapshot.listeners, snapshot.cwds, known, snapshot.containers, filter);
  listing.scanMs = snapshot.scanMs;

  if (!(filter.probe ?? false)) return listing;

  // Never a foreign socket — not ours to touch — and never a Docker-published
  // port, because a dashboard must not send HEAD / to Postgres on a timer.
  const targets: probe.BatchTarget[] = listing.rows
    .filter((r) => !r.foreign && !r.docker)
    .map((r) => ({ key: r.key, target: probe.target(r.address, r.port), http: probe.speaksHttp(r.process, http) }));
  if (targets.length === 0) return listing;

  const wanted = targets.length;
  const results = await probeRunner(targets, probe.DEADLINE_MS);
  const now = new Date().toISOString();
  for (const row of listing.rows) {
    const found = results.get(row.key);
    if (found === undefined) continue;
    row.health = found.health;
    row.latencyMs = found.latencyMs;
    row.checkedAt = now;
  }
  listing.partial = results.size < wanted;
  return listing;
}

/** The first port of the IANA dynamic range. At or above this, the kernel
 *  picked the number, which means no human ever typed it. */
export const EPHEMERAL = 49152;

/**
 * Join listeners against what this environment knows.
 *
 * Pure over its inputs so every rule below is testable without a socket, a
 * process table, or Docker.
 */
export function join(
  listeners: Listener[],
  cwds: Map<number, string>,
  known: KnownProject[],
  byDir: Map<string, DevContainer[]>,
  filter: DevServerFilter,
): DevServerListing {
  const knownOnly = filter.knownOnly ?? true;
  const ephemeral = filter.ephemeral ?? false;
  const needle = filter.query === undefined ? null : filter.query.toLowerCase();
  const http = filter.http ?? [];

  let foreignCount = 0;
  let hidden = 0;
  const rows: DevServerRow[] = [];

  // Collapse a forked pool to one row before anything else looks at the list:
  // every rule below is about a socket, and a socket is what a key names.
  const workers = new Map<string, number>();
  const first = listeners.filter((l) => {
    const seen = (workers.get(listen.key(l)) ?? 0) + 1;
    workers.set(listen.key(l), seen);
    return seen === 1;
  });
  // Stable, so ties keep the order the enumeration produced.
  first.sort((a, b) => a.port - b.port);

  for (const l of first) {
    // Port 0 is not something anything can connect to; it appears in the table
    // for sockets bound without a port and is pure noise.
    if (l.port === 0) continue;
    if (!ephemeral && l.port >= EPHEMERAL) {
      hidden += 1;
      continue;
    }
    if (listen.foreign(l)) foreignCount += 1;

    const dir = l.pid === null ? null : (cwds.get(l.pid) ?? null);
    const matched = dir === null ? null : matchProject(dir, known);
    // Recorded here, while the cwd is still in hand, so a monorepo row can say
    // it rolled up rather than silently renaming itself.
    const matchedAncestor = matched !== null && dir !== null && matched.path !== dir;
    const docker = l.process.toLowerCase().includes("docker");

    // A Docker-published port has the daemon as its process, so its cwd is
    // Docker's own — never a project. Attribute it by which project's compose
    // file published that port instead.
    const projectDir = matched !== null ? matched.path : docker ? dirPublishing(l.port, byDir) : null;
    const rowContainers = projectDir === null ? [] : (byDir.get(projectDir)?.slice() ?? []);
    // A Docker row is named by its compose project rather than by the
    // directory's basename: a compose file living in `…/foo/backend` gives every
    // container a `foo-` prefix, and "backend" matches nothing the user sees in
    // `docker ps`.
    const projectName =
      matched === null && docker && rowContainers[0] !== undefined
        ? rowContainers[0].project
        : projectDir === null
          ? null
          : leaf(projectDir);

    if (knownOnly && projectName === null) {
      hidden += 1;
      continue;
    }
    if (needle !== null) {
      const haystack = `${l.port} ${l.process} ${projectName ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }

    const probesHttp = !docker && probe.speaksHttp(l.process, http);

    rows.push({
      key: listen.key(l),
      port: l.port,
      address: l.address,
      family: listen.family(l),
      pid: l.pid,
      // `""` is this port's spelling of the Rust's `None`: a socket with no name.
      process: l.process === "" ? null : l.process,
      cwd: dir,
      projectName,
      projectId: matched?.id ?? null,
      repoPath: matched !== null && matched.isRepoLink ? matched.path : null,
      matchedAncestor,
      url: probesHttp ? probe.browserUrl(l.address, l.port) : null,
      health: "unknown",
      latencyMs: null,
      checkedAt: null,
      foreign: listen.foreign(l),
      docker,
      containers: rowContainers,
      workers: Math.max((workers.get(listen.key(l)) ?? 1) - 1, 0),
    });
  }

  return { rows, hidden, foreignCount, scanMs: 0, partial: false };
}

/**
 * The project a directory belongs to: itself, or the nearest ancestor.
 *
 * Ancestor matching is what makes a monorepo work — a dev server started in
 * `myapp/packages/web` belongs to `myapp`. Longest match wins, so a nested
 * project inside another is attributed to the nearer one.
 */
function matchProject(dir: string, known: KnownProject[]): KnownProject | null {
  let best: KnownProject | null = null;
  for (const p of known) {
    if (dir !== p.path && !dir.startsWith(`${p.path}/`)) continue;
    // `>=` so the last of equal-length matches wins, as Rust's max_by_key does.
    if (best === null || p.path.length >= best.path.length) best = p;
  }
  return best;
}

/** Which project's compose file published this host port. */
function dirPublishing(port: number, byDir: Map<string, DevContainer[]>): string | null {
  for (const [dir, list] of byDir) {
    if (list.some((c) => c.running && c.ports.includes(port))) return dir;
  }
  return null;
}

function leaf(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/core/dev/` — expected: PASS (the IPv6 probe test returns early on a machine with no v6 loopback).

- [ ] **Step 5: Commit**

```bash
git add src/core/dev/probe.ts src/core/dev/probe.test.ts src/core/dev/stop.ts src/core/dev/stop.test.ts src/core/dev/board.ts src/core/dev/board.test.ts
git commit -m "feat(dev): probe tiers, the stop guard, and the dev board join"
```

### Task 9: The three dev server commands

**Files:**
- Modify: `src/main/commands.ts`, `src/main/commands.test.ts`

**Interfaces:**
- Consumes: `Memo`, `MEMO_FLOOR_MS`, `readMachine`, `list`, `devServerFilterFromJson`, `KnownProject` from `src/core/dev/board.ts`; `enumerate` from `src/core/dev/listen.ts`; `run`, `target`, `DEADLINE_MS`, `DevProbe` from `src/core/dev/probe.ts`; `mayStop`, `refusalMessage`, `signal` from `src/core/dev/stop.ts`; `load` from `src/core/repos/links.ts`; `registry` from `src/core/projects.ts`; `events.log`; `DddError`.
- Produces: commands `dev_servers_list`, `dev_server_probe`, `dev_server_stop`. No new entry in `CommandDeps` — the enumeration uses the default `execFileRunner`, exactly as the Rust uses the real OS.

- [ ] **Step 1: Write the failing tests**

In `src/main/commands.test.ts`, add to the imports at the top of the file:

```ts
import net from "node:net";
```

and remove these three names from `NOT_YET_PORTED`: `dev_servers_list`, `dev_server_probe`, `dev_server_stop`.

Then append:

```ts
describe("dev server commands", () => {
  it("lists what is really listening on this machine, and dials none of it", async () => {
    scratchEnv("cmd-dev-list");
    const listing = (await commands.dev_servers_list!({ env: "default", filter: { knownOnly: false, ephemeral: true } })) as {
      rows: { key: string; port: number; address: string; health: string; checkedAt: string | null; containers: unknown[] }[];
      hidden: number;
      foreignCount: number;
      scanMs: number;
      partial: boolean;
    };
    expect(Array.isArray(listing.rows)).toBe(true);
    expect(typeof listing.hidden).toBe("number");
    expect(typeof listing.foreignCount).toBe("number");
    expect(typeof listing.scanMs).toBe("number");
    expect(listing.partial).toBe(false);
    for (const row of listing.rows) {
      expect(row.key).toBe(`tcp:${row.address}:${row.port}`);
      // probe defaults false: the first paint shows rows before any socket work.
      expect(row.health).toBe("unknown");
      expect(row.checkedAt).toBeNull();
      expect(Array.isArray(row.containers)).toBe(true);
    }
  }, 30_000);

  it("refuses a filter it cannot read, before reading the machine", async () => {
    scratchEnv("cmd-dev-filter");
    await expect(commands.dev_servers_list!({ env: "default", filter: { knownOnly: "yes" } })).rejects.toThrow(/^json: /);
  });

  it("probes a socket this test owns, and calls a closed port down", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => socket.end("HTTP/1.0 200 OK\r\n\r\n"));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const up = (await commands.dev_server_probe!({ address: "127.0.0.1", port, http: true })) as {
        health: string;
        latencyMs: number | null;
        checkedAt: string;
      };
      expect(up.health).toBe("up");
      expect(typeof up.latencyMs).toBe("number");
      expect(Number.isNaN(Date.parse(up.checkedAt))).toBe(false);

      const down = (await commands.dev_server_probe!({ address: "127.0.0.1", port: 1, http: false })) as {
        health: string;
        latencyMs: number | null;
      };
      expect(down).toMatchObject({ health: "down", latencyMs: null });
    } finally {
      server.close();
    }
  }, 15_000);

  it("re-reads the machine before signalling, and refuses when the row is stale", async () => {
    scratchEnv("cmd-dev-stop");
    // Port 1 is privileged, so nothing in the suite can be on it: the guard
    // sees an empty socket and declines rather than signalling pid 999999.
    await expect(
      commands.dev_server_stop!({ env: "default", key: "tcp:127.0.0.1:1", pid: 999_999, process: "node" }),
    ).rejects.toThrow("it already exited — nothing is on that port now");

    // And with nothing to compare against, the guard cannot run at all.
    await expect(
      commands.dev_server_stop!({ env: "default", key: "tcp:127.0.0.1:1", pid: 999_999, process: "" }),
    ).rejects.toThrow("no process name to verify against, so the reuse guard cannot run");
  }, 30_000);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/commands.test.ts` — expected: the contract test fails (three names neither registered nor listed) and the new tests fail with `commands.dev_servers_list is not a function`.

- [ ] **Step 3: Add the commands**

In `src/main/commands.ts`, add these imports (skip any the file already has):

```ts
import { MEMO_FLOOR_MS, Memo, devServerFilterFromJson, list as devServerList, readMachine, type KnownProject } from "../core/dev/board";
import * as listen from "../core/dev/listen";
import * as probe from "../core/dev/probe";
import { mayStop, refusalMessage, signal } from "../core/dev/stop";
import * as links from "../core/repos/links";
```

Below `const root = (env: string) => EnvRoot.open(env);`, add the process-wide memo and the join input:

```ts
/**
 * One read of the machine for the whole process, mirroring the Rust's
 * `static MEMO`. Two widgets on one board, or a manual refresh landing on top
 * of a poll, must not mean two `lsof` calls and two `docker ps`.
 */
const machine = new Memo();

/**
 * Every project this environment knows about, from both stores.
 *
 * The registry and the link store answer different questions — "is this a
 * project card" and "is this a checkout on disk" — and a dev server's cwd might
 * be in either. Registry entries come second so that when both claim a path,
 * the longest-match join sees the one carrying the id.
 */
function knownProjects(env: EnvRoot): KnownProject[] {
  const known: KnownProject[] = links.load(env).links.map((l) => ({ path: l.path, id: null, isRepoLink: true }));
  for (const p of projects.registry(env).projects) {
    // A path in both stores keeps its repo-link status: the terminal and IDE
    // actions key off the path either way, and the id is what the + Project
    // affordance checks.
    const existing = known.find((k) => k.path === p.path);
    if (existing !== undefined) existing.id = p.id;
    else known.push({ path: p.path, id: p.id, isRepoLink: false });
  }
  return known;
}
```

and, inside `createCommands`, the handlers:

```ts
    // --- dev servers: a live read of the machine. Writes nothing. ---

    /** What is listening, joined against this environment's projects and repo
     *  links. Reads the OS and two JSON stores; makes no network call, touches
     *  no item cache, and writes nothing at all. */
    dev_servers_list: async ({ env, filter }) => {
      const wanted = devServerFilterFromJson(filter ?? {});
      const known = knownProjects(root(env));
      const snapshot = await machine.get(Date.now(), MEMO_FLOOR_MS, readMachine);
      return await devServerList(snapshot, known, wanted);
    },

    /** Probe one row on demand — the Check button, and the only way to get a
     *  latency for a process that is not in the HTTP list. */
    dev_server_probe: async ({ address, port, http }) => {
      const found = await probe.run(probe.target(String(address), Number(port)), Boolean(http), probe.DEADLINE_MS);
      const out: probe.DevProbe = { health: found.health, latencyMs: found.latencyMs, checkedAt: new Date().toISOString() };
      return out;
    },

    /** `SIGTERM`, behind the PID-reuse guard. The only destructive thing on
     *  this board, and the reason it is defensible is that it re-reads the
     *  machine *now* rather than trusting a row that may be ten seconds old.
     *
     *  There is no force option at any depth of menu, and no `sudo` path. */
    dev_server_stop: async ({ env, key, pid, process: processName }) => {
      const r = root(env);
      // Deliberately not the memo: a two-second-old snapshot is exactly what
      // the guard exists to distrust.
      const fresh = await listen.enumerate();
      const refusal = mayStop(String(key), Number(pid), String(processName), fresh);
      if (refusal !== null) throw DddError.invalid(refusalMessage(refusal));

      signal(Number(pid));

      // Logged because it is destructive and irreversible, in the same table
      // the rest of the board's actions are already visible in. The Rust
      // ignores a failure here too: the signal has already been sent.
      try {
        events.log(r, {
          kind: "dev.stop",
          source: "local",
          project: null,
          tokensIn: null,
          tokensOut: null,
          costMicros: null,
          meta: { key: String(key), pid: Number(pid), process: String(processName) },
        });
      } catch {
        // Nothing to do: the process is already stopping.
      }
    },
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/main/commands.test.ts` — expected: PASS, including the contract test with the three names gone from `NOT_YET_PORTED`.

Then run the whole suite and the typecheck: `npx vitest run && npm run typecheck` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/commands.ts src/main/commands.test.ts
git commit -m "feat(dev): dev_servers_list, dev_server_probe and dev_server_stop"
```

<!-- deps/notes for the assembler -->
<!--
New npm dependencies: none. Everything uses node:child_process, node:net and node:fs.

Exported names other sections may consume:
  - src/core/dev/run.ts: `Runner`, `RunResult`, `execFileRunner`, `lines`. If another
    section needs to shell out from core, reuse `Runner` rather than inventing one.
  - src/core/dev/board.ts: `KnownProject`, `DevServerFilter`, `DevServerRow`,
    `DevServerListing`, `DevContainer` (re-exported from containers.ts), `Snapshot`,
    `Memo`, `MEMO_FLOOR_MS`, `EPHEMERAL`, `readMachine`, `join`, `list`,
    `devServerFilterFromJson`.
  - Task 9 adds `import * as links from "../core/repos/links";` to src/main/commands.ts.
    The repos section adds the same import; keep one.
  - Task 9 adds a module-level `const machine = new Memo();` and a module-level
    `function knownProjects(env: EnvRoot)` to src/main/commands.ts. `machine` is a
    short name at module scope — if the repos section wants that identifier, rename
    this one to `machineMemo`.
  - CommandDeps is NOT extended: no `runner` dep was added. The commands use the
    default `execFileRunner`, and the command tests exercise the real machine the way
    the Rust's own tests do. Every core module still takes its runner as an argument,
    so a later main-process test can inject one without touching the command bodies.

Rust behaviour deliberately not reproduced (each flagged in a code comment where it
lands):
  1. Enumeration. The Rust uses the `listeners` crate (libproc / netlink /
     GetExtendedTcpTable). Node has no equivalent, so listen.ts shells out to
     `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` (macOS, Linux) and `netstat -ano`
     (Windows). Consequences: (a) Windows rows carry no process name — `Listener.process`
     is `""` there, and the row's `process` field becomes `null`, which also means
     `speaksHttp` is false and the stop guard refuses with `unnamed`; (b) `Listener.process`
     is a `string` rather than the Rust's `Option<String>`, with `""` standing in for
     `None` (join maps `"" -> null` so the JSON is unchanged); (c) lsof reports a
     dual-descriptor bind twice, which `order()` collapses with the Rust's `dedup`.
  2. `stop::signal`'s error text. The Rust prints `strerror` ("No such process (os
     error 3)"); Node's message for the same failure is "kill ESRCH". The EPERM branch
     and the Windows sentence are verbatim; only this fallback wording differs, and
     nothing parses it. Commented in stop.ts.
  3. `Memo` single-flight. The Rust holds a mutex across the read, so a second caller
     blocks and then re-checks the floor against the first caller's timestamp. The TS
     Memo has no blocking lock: a second caller awaits the read already in flight and
     gets its snapshot even if its own `now` is outside the floor. Same guarantee (one
     read per burst), commented on the class. Both Rust memo tests are ported and pass,
     plus one for the concurrent case.
  4. `dirPublishing` iterates a `HashMap` in the Rust (arbitrary order) and a `Map`
     here (insertion order). Deterministic rather than arbitrary; no test depended on
     the Rust's order.
  5. `probe::batch` runs OS threads in the Rust and `Promise.all` here; `run` is
     blocking there and event-driven here. The deadline semantics are preserved exactly,
     including "a deadline before the handshake is `down`, after it is `slow`".
  6. No command test performs a successful `dev_server_stop`: signalling a real process
     from the suite would need a child listening on a port that `lsof` can also see, and
     the guard's own unit tests cover every branch. The `dev.stop` event row is therefore
     written but not asserted in a test, exactly as in the Rust, which has no command
     test for it either.
-->

### Task 10: EOL detection and support verdicts

**Files:**
- Create: `src/core/eol/detect.ts`, `src/core/eol/status.ts`
- Test: `src/core/eol/detect.test.ts`, `src/core/eol/status.test.ts`

**Interfaces:**
- Consumes: `record`, `required`, `optional`, `isString`, `isArray`, `isPlainRecord` from `src/core/json.ts`; `DddError` from `src/core/error.ts`.
- Produces: `detect.ts`: `Confidence`, `CONFIDENCE_RANK`, `Declaration`, `Granularity`, `granularity(product)`, `parseConstraint(raw, product)`, `cycleFrom(version, product)`, `parseComposerJson(text)`, `parsePackageJson(text)`, `parseVersionFile(name, text)`, `parseDockerfile(text)`, `parseTomlLike(name, text)`, `FILES`, `forDir(dir)`, `collapseAgreement(sorted)`. `status.ts`: `HORIZON_DAYS`, `Support`, `severity(support)`, `Milestone`, `milestoneDate(m)`, `Cycle`, `defaultCycle()`, `cycleFromApi(raw)`, `cycleFromJson(raw)`, `supportOn(cycle, today)`, `find(cycles, wanted)`, `daysBetween(from, to)`.

- [ ] **Step 1: Write the failing tests**

`src/core/eol/detect.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_RANK,
  cycleFrom,
  forDir,
  parseComposerJson,
  parseDockerfile,
  parsePackageJson,
  parseTomlLike,
  parseVersionFile,
  type Declaration,
} from "./detect";

function tempCheckout(): string {
  return mkdtempSync(join(tmpdir(), "ddd-eol-detect-"));
}

describe("reading what a checkout says it is built on", () => {
  it("the real symfony projects on this machine are read correctly", () => {
    // Verbatim from four of this machine's projects. The 8.0 line is the one
    // whose support ended on 2026-07-31, which is the whole reason this widget
    // exists.
    const declarations = parseComposerJson(
      '{"require": {"php": ">=8.4", "symfony/framework-bundle": "8.0.*"}}',
    );
    const symfony = declarations.find((d) => d.product === "symfony")!;
    expect(symfony.cycle).toBe("8.0");
    expect(symfony.confidence).toBe("exact"); // `8.0.*` pins a release line

    const php = declarations.find((d) => d.product === "php")!;
    expect(php.cycle).toBe("8.4");
    // `>=8.4` says what the code claims to run on, not what is running.
    expect(php.confidence).toBe("floor");
    expect(php.raw).toContain(">=8.4"); // the file's own words are kept
  });

  it("the lts project reads as its own line", () => {
    // toneelPetra, on 7.4 — the LTS, supported until 2029. A "newest version"
    // widget would call this the neglected one.
    const d = parseComposerJson('{"require": {"symfony/framework-bundle": "7.4.*"}}');
    expect(d[0]!.cycle).toBe("7.4");
  });

  it("a platform pin beats the constraint beside it", () => {
    const d = parseComposerJson(
      '{"require": {"php": ">=8.4"}, "config": {"platform": {"php": "8.1.29"}}}',
    );
    const php = d.filter((x) => x.product === "php");
    expect(php).toHaveLength(1); // one answer, the trustworthy one
    expect(php[0]!.cycle).toBe("8.1");
    expect(php[0]!.confidence).toBe("exact");
    expect(php[0]!.raw).toBe("config.platform.php: 8.1.29");
  });

  it("a dev dependency never speaks for production", () => {
    const d = parseComposerJson('{"require-dev": {"symfony/framework-bundle": "6.4.*"}}');
    expect(d[0]!.cycle).toBe("6.4"); // still read when nothing else said anything

    const both = parseComposerJson(
      '{"require": {"symfony/framework-bundle": "8.0.*"}, "require-dev": {"symfony/framework-bundle": "6.4.*"}}',
    );
    const symfony = both.filter((x) => x.product === "symfony");
    expect(symfony).toHaveLength(1);
    expect(symfony[0]!.cycle).toBe("8.0");
  });

  it("an nvmrc is read as a node major", () => {
    // dedesignwinkel, verbatim: a file containing `24`.
    const d = parseVersionFile(".nvmrc", "24\n");
    expect(d[0]!.product).toBe("nodejs");
    expect(d[0]!.cycle).toBe("24"); // Node numbers its cycles by major alone
    expect(d[0]!.confidence).toBe("exact");

    expect(parseVersionFile(".nvmrc", "v20.11.1")[0]!.cycle).toBe("20");
    // A named line is not a number, and inventing one would be worse than
    // saying nothing.
    expect(parseVersionFile(".nvmrc", "lts/hydrogen")).toEqual([]);
  });

  it("a dockerfile pin and a composer floor both survive", () => {
    const all: Declaration[] = parseDockerfile("FROM php:8.1-fpm-alpine AS base\nRUN echo hi\n");
    all.push(...parseComposerJson('{"require": {"php": ">=8.4"}}'));
    expect(all).toHaveLength(2);
    const docker = all.find((d) => d.source === "Dockerfile")!;
    expect(docker.cycle).toBe("8.1");
    expect(docker.confidence).toBe("exact");
    expect(docker.raw).toBe("FROM php:8.1-fpm-alpine");
    // Exact must outrank a floor.
    expect(CONFIDENCE_RANK.exact).toBeGreaterThan(CONFIDENCE_RANK.floor);
    expect(CONFIDENCE_RANK.range).toBeGreaterThan(CONFIDENCE_RANK.floor);
  });

  it("a registry qualified image is still recognised", () => {
    const d = parseDockerfile("FROM docker.io/library/node:22-alpine\n");
    expect(d[0]!.product).toBe("nodejs");
    expect(d[0]!.cycle).toBe("22");
    expect(d[0]!.raw).toBe("FROM node:22-alpine");
  });

  it("an untagged or unrelated image is not a declaration", () => {
    expect(parseDockerfile("FROM alpine:3.19\nFROM scratch\nFROM node\n")).toEqual([]);
  });

  it("node engine ranges read as their floor", () => {
    const d = parsePackageJson('{"engines": {"node": ">=20 <23"}}');
    expect(d[0]!.cycle).toBe("20");
    expect(d[0]!.confidence).toBe("floor"); // the oldest thing it permits
    expect(d[0]!.raw).toBe("engines.node: >=20 <23");

    const caret = parsePackageJson('{"dependencies": {"next": "^16.2.7"}}');
    expect(caret[0]!.product).toBe("nextjs");
    expect(caret[0]!.cycle).toBe("16");
    expect(caret[0]!.confidence).toBe("range");
  });

  it("the toml like files each yield their one key", () => {
    expect(parseTomlLike("go.mod", "module x\n\ngo 1.23\n")[0]!.cycle).toBe("1.23");
    expect(parseTomlLike("go.mod", "module x\n\ngo 1.23\n")[0]!.raw).toBe("go: 1.23");
    expect(parseTomlLike("Cargo.toml", '[package]\nrust-version = "1.80"\n')[0]!.cycle).toBe("1.80");
    const py = parseTomlLike("pyproject.toml", '[project]\nrequires-python = ">=3.11"\n');
    expect(py[0]!.cycle).toBe("3.11");
    expect(py[0]!.confidence).toBe("floor");
    expect(py[0]!.raw).toBe("requires-python: >=3.11");
    expect(parseTomlLike("unknown.toml", "go 1.23")).toEqual([]);
  });

  it("a cycle is asked for in the granularity the product publishes", () => {
    // Asking endoflife.date about Node "24.20" finds nothing, and about PHP "8"
    // finds nothing either. Each of these was read off the real API.
    expect(cycleFrom("24.20.0", "nodejs")).toBe("24");
    expect(cycleFrom("8.4.3", "php")).toBe("8.4");
    expect(cycleFrom("13.0", "laravel")).toBe("13");
    expect(cycleFrom("1.27.1", "go")).toBe("1.27");
    // A bare major where a minor is expected is not a cycle anyone knows.
    expect(cycleFrom("8", "php")).toBeNull();
  });

  it("junk never becomes a declaration", () => {
    expect(parseComposerJson("not json at all")).toEqual([]);
    expect(parsePackageJson("{")).toEqual([]);
    expect(parseComposerJson('{"require": {"php": "*"}}')).toEqual([]);
    expect(parseComposerJson('{"require": {"php": "dev-main"}}')).toEqual([]);
    expect(parseVersionFile(".nvmrc", "\n# a comment\n")).toEqual([]);
    expect(parseVersionFile("unknown-file", "24")).toEqual([]);
  });

  it("a checkout is read whole and ordered by trust", () => {
    const dir = tempCheckout();
    writeFileSync(join(dir, "composer.json"), '{"require": {"php": ">=8.4"}}');
    writeFileSync(join(dir, "Dockerfile"), "FROM php:8.1-fpm\n");
    writeFileSync(join(dir, ".nvmrc"), "24\n");

    const found = forDir(dir);
    expect(found).toHaveLength(3);
    // Same product, most trustworthy first.
    expect(found[0]!.product).toBe("nodejs");
    expect(found[1]!.source).toBe("Dockerfile");
    expect(found[2]!.source).toBe("composer.json");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a directory with nothing in it reads as nothing rather than failing", () => {
    expect(forDir("/nonexistent-checkout-xyz")).toEqual([]);
  });

  it("two files that agree are one finding naming both", () => {
    // A Dockerfile pinning php 8.4 and a composer.json claiming >=8.4. One fact
    // stated twice — showing it twice makes a tidy repo look like a messy one.
    const dir = tempCheckout();
    writeFileSync(join(dir, "composer.json"), '{"require": {"php": ">=8.4"}}');
    writeFileSync(join(dir, "Dockerfile"), "FROM php:8.4-cli-alpine\n");

    const found = forDir(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.source).toBe("Dockerfile"); // the trustworthy one survives
    expect(found[0]!.confidence).toBe("exact");
    expect(found[0]!.also).toEqual(["composer.json"]); // the other is still named
    rmSync(dir, { recursive: true, force: true });
  });

  it("two files that disagree stay two findings", () => {
    const dir = tempCheckout();
    writeFileSync(join(dir, "composer.json"), '{"require": {"php": ">=8.4"}}');
    writeFileSync(join(dir, "Dockerfile"), "FROM php:8.1-fpm\n");

    const found = forDir(dir);
    expect(found).toHaveLength(2);
    expect(found[0]!.cycle).toBe("8.1");
    expect(found[1]!.cycle).toBe("8.4");
    expect(found[0]!.also).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

`src/core/eol/status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  cycleFromApi,
  cycleFromJson,
  daysBetween,
  find,
  severity,
  supportOn,
  type Cycle,
  type Milestone,
  type Support,
} from "./status";

function cycle(name: string, support: string | null, eol: string | null): Cycle {
  const at = (d: string | null): Milestone => (d === null ? { kind: "absent" } : { kind: "date", date: d });
  return { cycle: name, support: at(support), eol: at(eol), latest: null };
}

describe("dates in, verdict out", () => {
  it("the symfony line this machine runs on reads as ended", () => {
    // Real data: Symfony 8.0, security support ended 2026-07-31.
    const c = cycle("8.0", "2026-07-31", "2026-07-31");
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "ended" });
  });

  it("the lts beside it reads as supported", () => {
    // Symfony 7.4: supported to 2029. The older line is the safe one, which is
    // the entire argument for EOL over newest-version.
    const c = cycle("7.4", "2028-11-30", "2029-11-30");
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "active" });
  });

  it("support that ends today has already ended", () => {
    const c = cycle("8.0", null, "2026-09-04");
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "ended" });
    expect(supportOn(c, "2026-09-03")).toEqual({ state: "endingSoon", days: 1 });
    expect(supportOn(c, "2026-09-05")).toEqual({ state: "ended" });
  });

  it("the horizon is ninety days and the boundary is tested on both sides", () => {
    const c = cycle("24", null, "2026-12-03"); // 90 days out
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "endingSoon", days: 90 });
    expect(supportOn(c, "2026-09-03")).toEqual({ state: "active" }); // 91 days is not soon
  });

  it("losing active support is not losing security support", () => {
    // Node 22: active ended 2025-10-21, security runs to 2027-04-30.
    const c = cycle("22", "2025-10-21", "2027-04-30");
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "securityOnly" });
  });

  it("active support ending soon warns before security support does", () => {
    // Node 24: active ends 2026-10-20, security 2028-04-30.
    const c = cycle("24", "2026-10-20", "2028-04-30");
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "endingSoon", days: 46 });
  });

  it("a cycle with no schedule is unknown and never ended", () => {
    expect(supportOn(cycle("99", null, null), "2026-09-04")).toEqual({ state: "unknown" });
    expect(supportOn(cycle("99", null, null), "2026-09-04")).not.toEqual({ state: "ended" });
  });

  it("a cycle that is not in the list is not matched loosely", () => {
    // `8.0` is not `8`.
    const cycles = [cycle("8.0", null, null), cycle("8.1", null, null)];
    expect(find(cycles, "8")).toBeNull();
    expect(find(cycles, "8.0")).not.toBeNull();
  });

  it("the two booleans have opposite polarity and both are read correctly", () => {
    // Every one of these is a verbatim shape from a live response, and reading
    // the booleans uniformly gets two of them backwards.
    const cycles = (
      JSON.parse(
        `[{"cycle": 24, "support": "2026-10-20", "eol": "2028-04-30", "latest": "24.20.0"},
          {"cycle": "16", "eol": false, "latest": "16.3.4"},
          {"cycle": "3", "eol": true, "support": false},
          {"cycle": "3.5", "support": false, "eol": "2020-09-30"},
          {"cycle": "9.9"}]`,
      ) as unknown[]
    ).map(cycleFromApi);

    // A number where a string was expected.
    expect(cycles[0]!.cycle).toBe("24");
    expect(cycles[0]!.latest).toBe("24.20.0");

    // Next.js 16: `eol: false` means *not* end-of-life.
    expect(cycles[1]!.eol).toEqual({ kind: "pending" });
    expect(supportOn(cycles[1]!, "2026-09-04")).toEqual({ state: "active" });

    // Node 3: `eol: true` means it *is* end-of-life. This is the dangerous one.
    expect(cycles[2]!.eol).toEqual({ kind: "reached" });
    expect(supportOn(cycles[2]!, "2026-09-04")).toEqual({ state: "ended" });

    // Python 3.5: `support: false` means active support is *over* — the
    // opposite polarity, in the same document.
    expect(cycles[3]!.support).toEqual({ kind: "reached" });
    expect(supportOn(cycles[3]!, "2026-09-04")).toEqual({ state: "ended" });

    // Nothing said at all is the only Unknown.
    expect(cycles[4]!.support).toEqual({ kind: "absent" });
    expect(cycles[4]!.eol).toEqual({ kind: "absent" });
    expect(supportOn(cycles[4]!, "2026-09-04")).toEqual({ state: "unknown" });
  });

  it("active support still running with no end date is active", () => {
    const c: Cycle = { cycle: "1.27", support: { kind: "absent" }, eol: { kind: "pending" }, latest: null };
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "active" });
  });

  it("severity puts the dangerous rows on top", () => {
    const states: Support[] = [
      { state: "active" },
      { state: "unknown" },
      { state: "ended" },
      { state: "securityOnly" },
      { state: "endingSoon", days: 3 },
    ];
    states.sort((a, b) => severity(b) - severity(a));
    expect(states[0]).toEqual({ state: "ended" });
    expect(states[1]).toEqual({ state: "endingSoon", days: 3 });
    expect(states.at(-1)).toEqual({ state: "unknown" });
  });

  it("days between refuses anything that is not a date", () => {
    expect(daysBetween("2026-09-04", "2026-09-05")).toBe(1);
    expect(daysBetween("2026-09-04T10:00:00Z", "2026-12-03")).toBe(90);
    expect(daysBetween("not a date", "2026-09-05")).toBeNull();
    expect(daysBetween("2026-13-45", "2026-09-05")).toBeNull();
    expect(daysBetween("2026-09", "2026-09-05")).toBeNull();
  });

  it("the on-disk shape round-trips through the tagged decoder", () => {
    // What `writeJson` put in `eol-cache.json` is the *tagged* Milestone, not
    // the API's bare string — a different decoder, and the one the cache uses.
    const onDisk = {
      cycle: "8.0",
      support: { kind: "date", date: "2026-07-31" },
      eol: { kind: "reached" },
      latest: "8.0.16",
    };
    const c = cycleFromJson(onDisk);
    expect(c).toEqual({
      cycle: "8.0",
      support: { kind: "date", date: "2026-07-31" },
      eol: { kind: "reached" },
      latest: "8.0.16",
    });
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "ended" });
    expect(cycleFromJson({ cycle: "9.9", support: { kind: "absent" }, eol: { kind: "pending" }, latest: null })).toEqual(
      { cycle: "9.9", support: { kind: "absent" }, eol: { kind: "pending" }, latest: null },
    );
    expect(() => cycleFromJson({ cycle: "8.0", support: { kind: "maybe" } })).toThrow(/^json: /);
    expect(() => cycleFromJson([])).toThrow(/^json: /);
    expect(() => cycleFromApi("nope")).toThrow(/^json: /);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/eol` — expected: cannot resolve `./detect` and `./status`.

- [ ] **Step 3: Write the modules**

`src/core/eol/detect.ts`:

```ts
/**
 * What a checkout says it is built on. Port of `eol/detect.rs`.
 *
 * Pure over file contents: every function here takes text and returns
 * declarations, so the whole detection story is testable without a repository,
 * a network, or a clock. `forDir` is the only part that touches the disk.
 *
 * Nothing here guesses. A declaration always names the file it came from and
 * how much that file can be believed — a `Dockerfile` pinning `php:8.1` and a
 * `composer.json` claiming `>=8.4` are not a contradiction to resolve silently.
 * That disagreement is the finding.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainRecord } from "../json";

/**
 * How much a declaration can be believed. `CONFIDENCE_RANK` is the Rust's
 * derived `Ord` (declared worst to best) made explicit, because TS enums do not
 * carry an order.
 */
export type Confidence = "floor" | "range" | "exact";

export const CONFIDENCE_RANK: Record<Confidence, number> = { floor: 0, range: 1, exact: 2 };

export interface Declaration {
  /**
   * Other files that said the same thing. Agreement is not a finding, so they
   * are folded into one row and listed here.
   *
   * The Rust is `#[serde(skip_serializing_if = "Vec::is_empty")]`. In-process
   * this is always a plain array; the key is omitted at the one boundary that
   * serialises it, `eol/board.ts`'s `Finding`, which is where the Rust's
   * `skip_serializing_if` would fire.
   */
  also: string[];
  /** An endoflife.date product slug. Only ever one from `PRODUCTS`. */
  product: string;
  /** The cycle, in the granularity that product publishes. */
  cycle: string;
  /** The file this came from, relative to the checkout. */
  source: string;
  confidence: Confidence;
  /** What the file actually said, verbatim. */
  raw: string;
}

/**
 * How a product numbers its releases. Not cosmetic: asking endoflife.date about
 * Node cycle `24.20` finds nothing, and about PHP cycle `8` finds nothing
 * either.
 */
export type Granularity = "major" | "majorMinor";

export function granularity(product: string): Granularity {
  switch (product) {
    case "nodejs":
    case "laravel":
    case "nextjs":
    case "dotnet":
      return "major";
    default:
      return "majorMinor";
  }
}

/** Composer packages worth a support date, mapped to their product slug. */
const COMPOSER_PRODUCTS: readonly (readonly [string, string])[] = [
  ["symfony/framework-bundle", "symfony"],
  ["symfony/symfony", "symfony"],
  ["laravel/framework", "laravel"],
  ["php", "php"],
];

/** npm packages worth a support date. */
const NPM_PRODUCTS: readonly (readonly [string, string])[] = [["next", "nextjs"]];

/**
 * Take the version out of a constraint, and say how much it can be believed.
 *
 * `"8.0.*"` is a pin to a line; `">=8.4"` is a floor; `"^16.2.7"` is a range.
 */
export function parseConstraint(raw: string, product: string): { cycle: string; confidence: Confidence } | null {
  const text = raw.trim();
  if (text === "" || text === "*") return null;
  // The first version-looking token. A compound like ">=20 <23" is read as its
  // floor, which is the honest reading: the oldest thing it permits.
  const token = text.split(/[|,\s]/).find((t) => /[0-9]/.test(t));
  if (token === undefined) return null;

  const confidence: Confidence = token.startsWith(">=") || token.startsWith(">")
    ? "floor"
    : token.startsWith("^") || token.startsWith("~")
      ? "range"
      : "exact";

  // Rust's `trim_start_matches(['>', '=', '<', '^', '~', 'v', 'V'])`.
  const digits = token.replace(/^[>=<^~vV]+/, "");
  const cycle = cycleFrom(digits, product);
  if (cycle === null) return null;
  return { cycle, confidence };
}

/** `8.4.3` → `8.4` for PHP, `24.20.0` → `24` for Node. */
export function cycleFrom(version: string, product: string): string | null {
  const parts = version
    .split(/[.\-+]/)
    .map((p) => p.replace(/\*+$/, "")) // Rust's `trim_end_matches('*')`
    .filter((p) => p !== "");
  const major = parts[0];
  if (major === undefined) return null;
  if (!/^[0-9]+$/.test(major)) return null;
  if (granularity(product) === "major") return major;
  const minor = parts[1];
  // A bare major where a minor is expected is not a cycle this API knows.
  // Better no verdict than a verdict about "8".
  if (minor === undefined || !/^[0-9]+$/.test(minor)) return null;
  return `${major}.${minor}`;
}

/** `serde_json::from_str::<Value>` — `undefined` where the Rust gets an `Err`. */
function parseValue(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `Value::pointer`, for the two paths this file needs. */
function at(json: unknown, ...path: string[]): unknown {
  let node = json;
  for (const key of path) {
    if (!isPlainRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asObject = (v: unknown): Record<string, unknown> | null => (isPlainRecord(v) ? v : null);

export function parseComposerJson(text: string): Declaration[] {
  const json = parseValue(text);
  if (json === undefined) return [];
  const out: Declaration[] = [];

  // `config.platform.php` is what Composer actually resolves against, so it
  // beats the `require` constraint whenever both are present.
  const platform = asString(at(json, "config", "platform", "php"));
  if (platform !== null) {
    const pinned = cycleFrom(platform, "php");
    if (pinned !== null) {
      out.push({
        also: [],
        product: "php",
        cycle: pinned,
        source: "composer.json",
        confidence: "exact",
        raw: `config.platform.php: ${platform}`,
      });
    }
  }

  for (const section of ["require", "require-dev"]) {
    const map = asObject(at(json, section));
    if (map === null) continue;
    for (const [pkg, product] of COMPOSER_PRODUCTS) {
      // `require-dev` is what the tests run on, not what production runs on.
      // Read it only when `require` said nothing.
      if (section === "require-dev" && out.some((d) => d.product === product)) continue;
      const raw = asString(map[pkg]);
      if (raw === null) continue;
      if (out.some((d) => d.product === product && d.confidence === "exact")) continue;
      const parsed = parseConstraint(raw, product);
      if (parsed === null) continue;
      out.push({
        also: [],
        product,
        cycle: parsed.cycle,
        source: "composer.json",
        confidence: parsed.confidence,
        raw: `${pkg}: ${raw}`,
      });
    }
  }
  return out;
}

export function parsePackageJson(text: string): Declaration[] {
  const json = parseValue(text);
  if (json === undefined) return [];
  const out: Declaration[] = [];

  const engine = asString(at(json, "engines", "node"));
  if (engine !== null) {
    const parsed = parseConstraint(engine, "nodejs");
    if (parsed !== null) {
      out.push({
        also: [],
        product: "nodejs",
        cycle: parsed.cycle,
        source: "package.json",
        confidence: parsed.confidence,
        raw: `engines.node: ${engine}`,
      });
    }
  }
  for (const section of ["dependencies", "devDependencies"]) {
    const map = asObject(at(json, section));
    if (map === null) continue;
    for (const [pkg, product] of NPM_PRODUCTS) {
      if (out.some((d) => d.product === product)) continue;
      const raw = asString(map[pkg]);
      if (raw === null) continue;
      const parsed = parseConstraint(raw, product);
      if (parsed === null) continue;
      out.push({
        also: [],
        product,
        cycle: parsed.cycle,
        source: "package.json",
        confidence: parsed.confidence,
        raw: `${pkg}: ${raw}`,
      });
    }
  }
  return out;
}

/** Rust's `str::lines`: split on `\n`, drop a trailing `\r`. */
function lines(text: string): string[] {
  return text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/**
 * `.nvmrc`, `.python-version`, `.ruby-version` — a pinned toolchain, and the
 * most trustworthy thing in a repository because a human wrote one number.
 */
export function parseVersionFile(name: string, text: string): Declaration[] {
  const product = name === ".nvmrc" ? "nodejs" : name === ".python-version" ? "python" : name === ".ruby-version" ? "ruby" : null;
  if (product === null) return [];
  const line = lines(text)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  if (line === undefined) return [];
  // `lts/hydrogen` and friends name a line without numbering it.
  const cycle = cycleFrom(line.replace(/^v+/, ""), product);
  if (cycle === null) return [];
  return [{ also: [], product, cycle, source: name, confidence: "exact", raw: line }];
}

/** `FROM php:8.3-fpm` — the runtime that actually ships. */
export function parseDockerfile(text: string): Declaration[] {
  const images: readonly (readonly [string, string])[] = [
    ["php", "php"],
    ["node", "nodejs"],
    ["python", "python"],
    ["ruby", "ruby"],
    ["golang", "go"],
    ["rust", "rust"],
  ];
  const out: Declaration[] = [];
  for (const raw of lines(text)) {
    const line = raw.trim();
    const rest = line.startsWith("FROM ") ? line.slice(5) : line.startsWith("from ") ? line.slice(5) : null;
    if (rest === null) continue;
    // `FROM x AS builder`, and registry-qualified names.
    let image = rest.trim().split(/\s+/)[0] ?? "";
    image = image.slice(image.lastIndexOf("/") + 1);
    const colon = image.indexOf(":");
    if (colon < 0) continue;
    const name = image.slice(0, colon);
    const tag = image.slice(colon + 1);
    for (const [prefix, product] of images) {
      if (name !== prefix) continue;
      if (out.some((d) => d.product === product)) continue;
      const cycle = cycleFrom(tag, product);
      if (cycle === null) continue;
      out.push({ also: [], product, cycle, source: "Dockerfile", confidence: "exact", raw: `FROM ${image}` });
    }
  }
  return out;
}

/**
 * `requires-python = ">=3.11"`, `go 1.23`, `rust-version = "1.80"`.
 *
 * Read line-wise rather than with a TOML parser: one key from each file, and a
 * dependency for it would be a dependency for three lines of matching.
 */
export function parseTomlLike(name: string, text: string): Declaration[] {
  const pair: [string, string] | null =
    name === "pyproject.toml"
      ? ["requires-python", "python"]
      : name === "Cargo.toml"
        ? ["rust-version", "rust"]
        : name === "go.mod"
          ? ["go", "go"]
          : null;
  if (pair === null) return [];
  const [key, product] = pair;
  for (const raw of lines(text)) {
    const line = raw.trim();
    let value: string | null = null;
    if (name === "go.mod") {
      // `go 1.23` — a directive, not an assignment.
      value = line.startsWith("go ") ? line.slice(3).trim() : null;
    } else if (line.startsWith(key)) {
      const after = line.slice(key.length).trimStart();
      // Rust's `trim_matches('"')`: strip every leading and trailing quote.
      value = after.startsWith("=") ? after.slice(1).trim().replace(/^"+/, "").replace(/"+$/, "") : null;
    }
    if (value === null) continue;
    const parsed = parseConstraint(value, product);
    if (parsed === null) continue;
    return [
      { also: [], product, cycle: parsed.cycle, source: name, confidence: parsed.confidence, raw: `${key}: ${value}` },
    ];
  }
  return [];
}

/**
 * Every file this reads. Kept in one list so the widget can say what it looked
 * at when it found nothing.
 */
export const FILES: readonly string[] = [
  "composer.json",
  "package.json",
  ".nvmrc",
  ".python-version",
  ".ruby-version",
  "Dockerfile",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
];

/** Byte-wise, like Rust's `String::cmp`. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Read a checkout. The only function here that touches the disk.
 *
 * Declarations are sorted by product, then most-trustworthy first, so a
 * `Dockerfile` pin leads and the `composer.json` floor that disagrees with it
 * is still right underneath.
 */
export function forDir(dir: string): Declaration[] {
  const out: Declaration[] = [];
  for (const name of FILES) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (name === "composer.json") out.push(...parseComposerJson(text));
    else if (name === "package.json") out.push(...parsePackageJson(text));
    else if (name === "Dockerfile") out.push(...parseDockerfile(text));
    else if (name === ".nvmrc" || name === ".python-version" || name === ".ruby-version")
      out.push(...parseVersionFile(name, text));
    else out.push(...parseTomlLike(name, text));
  }
  // `Array.prototype.sort` is stable, as Rust's `sort_by` is.
  out.sort(
    (a, b) =>
      byteCompare(a.product, b.product) ||
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      byteCompare(a.source, b.source),
  );
  return collapseAgreement(out);
}

/**
 * Fold declarations that name the same product *and* the same cycle.
 *
 * A `Dockerfile` pinning PHP 8.1 under a `composer.json` claiming `>=8.4` is
 * the finding and stays two rows. A Dockerfile and a composer file that both
 * say 8.4 are one fact stated twice. The already-sorted order means the
 * survivor is the most trustworthy of the group.
 */
export function collapseAgreement(sorted: Declaration[]): Declaration[] {
  const out: Declaration[] = [];
  for (const declaration of sorted) {
    const kept = out.find((d) => d.product === declaration.product && d.cycle === declaration.cycle);
    if (kept !== undefined) kept.also.push(declaration.source);
    // The Rust moves the declaration in; copying keeps a caller's array from
    // being mutated through the result.
    else out.push({ ...declaration, also: [...declaration.also] });
  }
  return out;
}
```

`src/core/eol/status.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/core/eol` — expected: PASS (two files, all tests green). Then `npx tsc --noEmit` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/eol/detect.ts src/core/eol/detect.test.ts src/core/eol/status.ts src/core/eol/status.test.ts
git commit -m "feat(eol): detect what a checkout declares and decide whether it is supported"
```

---

### Task 11: Support schedules, liveness, and the watchlist

**Files:**
- Create: `src/core/eol/schedule.ts`, `src/core/eol/live.ts`, `src/core/eol/watchlist.ts`
- Test: `src/core/eol/schedule.test.ts`, `src/core/eol/live.test.ts`, `src/core/eol/watchlist.test.ts`

**Interfaces:**
- Consumes: `Cycle`, `cycleFromApi`, `cycleFromJson` from `./status`; `EnvRoot` (`watchlistFile()`, `eolCacheFile()`) from `src/core/paths.ts`; `readJson`, `writeJson` from `src/core/store.ts`; `DddError` from `src/core/error.ts`; `record`, `required`, `optional`, `isString`, `isArray`, `isPlainRecord`, `isNumber` from `src/core/json.ts`; `statusLabel` from `src/core/sync/adapter.ts`; `scratchEnv` from `src/core/testing.ts`.
- Produces: `schedule.ts`: `TTL_SECONDS`, `PRODUCTS`, `isKnownProduct`, `API`, `urlFor`, `urlForBase`, `Entry`, `Cache`, `defaultCache()`, `entryFromJson`, `cacheFromJson`, `load(env)`, `save(env, cache)`, `isFresh(entry, now)`, `ageDays(entry, now)`, `refresh(fetch, cache, wanted, now)`, `refreshFrom(base, fetch, cache, wanted, now)`, `fetchOne(fetch, url)`. `live.ts`: `TTL_SECONDS`, `Liveness`, `isServing`, `Checked`, `Checks`, `checkedFromJson`, `checksFromJson`, `isFresh(checked, now)`, `classify(status, timedOut, error)`, `check(fetch, url)`, `short(e)`, `refresh(fetch, checks, urls, now)`. `watchlist.ts`: `Watched`, `Watchlist`, `defaultWatchlist()`, `watchedFromJson`, `watchlistFromJson`, `load(env)`, `save(env, list)`, `validateUrl(url)`, `add(env, path, url, note)`, `remove(env, path)`.

- [ ] **Step 1: Write the failing tests**

`src/core/eol/watchlist.test.ts`:

```ts
import { mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvRoot } from "../paths";
import { scratchEnv } from "../testing";
import { add, load, remove, validateUrl, watchlistFromJson } from "./watchlist";

function checkout(name: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `ddd-eol-${name}-`)));
}

describe("the watchlist", () => {
  it("a repo round trips with its url", () => {
    const { env } = scratchEnv("eol-watchlist");
    const path = checkout("a");
    add(env, path, "https://example.com", "client site");

    const list = load(env);
    expect(list.watched).toHaveLength(1);
    expect(list.watched[0]!.url).toBe("https://example.com");
    expect(list.watched[0]!.note).toBe("client site");
    expect(list.watched[0]!.path).toBe(path);
    expect(Number.isNaN(Date.parse(list.watched[0]!.addedAt))).toBe(false);
  });

  it("assigning twice updates rather than duplicating", () => {
    const { env } = scratchEnv("eol-twice");
    const path = checkout("b");
    add(env, path, null, null);
    const list = add(env, path, "https://later.example", null);
    expect(list.watched).toHaveLength(1);
    expect(list.watched[0]!.url).toBe("https://later.example");

    // And a later add with no URL does not silently forget the one there.
    const again = add(env, path, null, null);
    expect(again.watched[0]!.url).toBe("https://later.example");
  });

  it("only a real web address is accepted", () => {
    // This value becomes an outbound request, so what is refused here is what
    // can never be fetched.
    expect(validateUrl("https://example.com/app")).toBe("https://example.com/app");
    expect(validateUrl("  http://example.com  ")).toBe("http://example.com");
    expect(() => validateUrl("  ")).toThrow("no address given");
    expect(() => validateUrl("file:///etc/passwd")).toThrow("file:///etc/passwd is not an http or https address");
    expect(() => validateUrl("localhost:3000")).toThrow("localhost:3000 is not an http or https address");
    expect(() => validateUrl("javascript:alert(1)")).toThrow("javascript:alert(1) is not an http or https address");
    expect(() => validateUrl("example.com")).toThrow("example.com is not an http or https address");
    expect(() => validateUrl("https://")).toThrow("https:// has no host to reach");
    expect(() => validateUrl("https://localhost/app")).toThrow("https://localhost/app has no host to reach");
  });

  it("a bad url is refused before anything is written", () => {
    const { env } = scratchEnv("eol-badurl");
    const path = checkout("c");
    expect(() => add(env, path, "file:///etc/passwd", null)).toThrow(/is not an http or https address/);
    expect(load(env).watched).toEqual([]); // nothing was stored
  });

  it("a path that is not a directory is refused", () => {
    const { env } = scratchEnv("eol-nodir");
    expect(() => add(env, "/nonexistent-checkout-xyz", null, null)).toThrow(
      "/nonexistent-checkout-xyz is not a directory",
    );
  });

  it("removing forgets the record and leaves the folder alone", () => {
    const { env } = scratchEnv("eol-remove");
    const path = checkout("d");
    add(env, path, null, null);
    const list = remove(env, path);
    expect(list.watched).toEqual([]);
    expect(statSync(path).isDirectory()).toBe(true); // the checkout is never touched
  });

  it("one environment's watchlist never reaches another", () => {
    const { env } = scratchEnv("eol-envwall");
    const work = EnvRoot.open("work");
    const path = checkout("e");
    add(env, path, null, null);
    expect(load(work).watched).toEqual([]);
  });

  it("writes the Rust's field order and fills serde's per-field defaults", () => {
    const { env } = scratchEnv("eol-shape");
    const path = checkout("f");
    add(env, path, "https://example.com", null);
    const text = readFileSync(env.watchlistFile(), "utf8");
    expect(text.indexOf('"path"')).toBeLessThan(text.indexOf('"url"'));
    expect(text.indexOf('"url"')).toBeLessThan(text.indexOf('"note"'));
    expect(text.indexOf('"note"')).toBeLessThan(text.indexOf('"addedAt"'));
    expect(text).toContain('"note": null');

    expect(watchlistFromJson({})).toEqual({ watched: [] });
    expect(watchlistFromJson({ watched: [{ path: "/p", addedAt: "t" }] })).toEqual({
      watched: [{ path: "/p", url: null, note: null, addedAt: "t" }],
    });
    expect(() => watchlistFromJson({ watched: [{ path: "/p" }] })).toThrow(/^json: /);
    expect(() => watchlistFromJson([])).toThrow(/^json: /);
  });
});
```

`src/core/eol/live.test.ts`:

```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { check, checksFromJson, classify, isFresh, isServing, refresh, short, type Checks } from "./live";

/** A fetch that never reaches a network. Records what was asked of it. */
function fakeFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    calls.push({ url: String(url), method: init?.method ?? "GET", headers });
    return reply(String(url), init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function timeoutError(): Error {
  // What `AbortSignal.timeout(ms)` aborts with, and what `check` looks for.
  return new DOMException("The operation was aborted due to timeout", "TimeoutError") as unknown as Error;
}

describe("is the thing at that URL still answering", () => {
  it("a timeout is never reported as gone", () => {
    // Someone else's server being slow, or a CDN that dislikes HEAD, is not
    // evidence that the site is down.
    expect(classify(null, true, null)).toEqual({ state: "noAnswer", detail: "no reply within the deadline" });
    expect(classify(null, true, null).state).not.toBe("unreachable");
  });

  it("any status code at all counts as answering", () => {
    // A 403 from a server means a server is there, which is the entire question
    // being asked.
    for (const code of [200, 301, 403, 500]) {
      expect(isServing(classify(code, false, null))).toBe(true);
    }
  });

  it("a refused connection is the one that means gone", () => {
    const v = classify(null, false, "connection refused");
    expect(v).toEqual({ state: "unreachable", detail: "connection refused" });
    expect(isServing(v)).toBe(false);
    expect(classify(null, false, null)).toEqual({ state: "unreachable", detail: "could not connect" });
  });

  it("a url that was never valid is never requested", async () => {
    // Belt and braces: the watchlist refuses these on entry, and this is the
    // last point before an outbound request.
    const { fetch, calls } = fakeFetch(() => new Response("", { status: 200 }));
    for (const bad of ["file:///etc/passwd", "localhost:3000", "javascript:alert(1)"]) {
      expect(await check(fetch, bad)).toEqual({ state: "unreachable", detail: "not an http address" });
    }
    expect(calls).toEqual([]);
  });

  it("check sends a HEAD with the named user agent, and reads a 200 and a 404 alike", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith("/missing") ? new Response("", { status: 404, statusText: "Not Found" }) : new Response("", { status: 200 }),
    );
    expect(await check(fetch, "https://serving.example")).toEqual({ state: "answering", detail: 200 });
    expect(await check(fetch, "https://serving.example/missing")).toEqual({ state: "answering", detail: 404 });
    expect(calls[0]!.method).toBe("HEAD");
    expect(calls[0]!.headers["user-agent"]).toBe("DDD-dashboard (support watch)");
  });

  it("a thrown timeout is noAnswer and a network error is unreachable", async () => {
    const slow = fakeFetch(() => {
      throw timeoutError();
    });
    expect(await check(slow.fetch, "https://slow.example")).toEqual({
      state: "noAnswer",
      detail: "no reply within the deadline",
    });

    const dead = fakeFetch(() => {
      throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:1");
    });
    expect(await check(dead.fetch, "https://gone.example")).toEqual({ state: "unreachable", detail: "fetch failed" });
  });

  it("short keeps a reason, not a stack", () => {
    expect(short(new Error("error sending request for url (https://x): connection refused"))).toBe(
      "error sending request for url (https://x) ",
    );
    expect(short("plain")).toBe("plain");
  });

  it("a real socket answers and a dead port does not", async () => {
    // A listener this test owns, so no external host is involved. (The Rust
    // test stops at `classify` because it believed `127.0.0.1` would fail
    // `validate_url`; it does not — the host has dots — so the port can do the
    // whole round trip here.)
    const server: Server = createServer((_req, res) => res.end());
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    expect(await check(globalThis.fetch, url)).toEqual({ state: "answering", detail: 200 });
    await new Promise<void>((done) => server.close(() => done()));
    expect((await check(globalThis.fetch, url)).state).toBe("unreachable");
  });

  it("a fresh check is not repeated", async () => {
    const checked = { at: "2026-09-04T09:30:00Z", liveness: { state: "answering", detail: 200 } } as const;
    expect(isFresh(checked, "2026-09-04T10:00:00Z")).toBe(true); // half an hour old
    expect(isFresh(checked, "2026-09-04T11:00:00Z")).toBe(false); // an hour is the boundary
    expect(isFresh(checked, "2026-09-03T09:00:00Z")).toBe(false); // a clock that went backwards
    expect(isFresh({ at: "not a date", liveness: { state: "answering", detail: 200 } }, "2026-09-04T10:00:00Z")).toBe(false);

    const checks: Checks = { "https://a.example": { ...checked } };
    const { fetch, calls } = fakeFetch(() => new Response("", { status: 500 }));
    await refresh(fetch, checks, ["https://a.example", "https://b.example"], "2026-09-04T10:00:00Z");
    expect(calls.map((c) => c.url)).toEqual(["https://b.example"]);
    expect(checks["https://a.example"]!.liveness).toEqual({ state: "answering", detail: 200 });
    expect(checks["https://b.example"]).toEqual({
      at: "2026-09-04T10:00:00Z",
      liveness: { state: "answering", detail: 500 },
    });
  });

  it("reads the stored shape back", () => {
    expect(checksFromJson({ "https://a.example": { at: "t", liveness: { state: "noAnswer", detail: "slow" } } })).toEqual({
      "https://a.example": { at: "t", liveness: { state: "noAnswer", detail: "slow" } },
    });
    expect(() => checksFromJson({ x: { at: "t", liveness: { state: "sideways", detail: "x" } } })).toThrow(/^json: /);
    expect(() => checksFromJson({ x: { at: "t", liveness: { state: "answering", detail: "200" } } })).toThrow(/^json: /);
  });
});
```

`src/core/eol/schedule.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scratchEnv } from "../testing";
import { defaultCycle, type Cycle } from "./status";
import {
  ageDays,
  cacheFromJson,
  defaultCache,
  fetchOne,
  isFresh,
  isKnownProduct,
  load,
  PRODUCTS,
  refreshFrom,
  save,
  urlFor,
  type Cache,
  type Entry,
} from "./schedule";

function entry(fetchedAt: string, cycles: Cycle[] = []): Entry {
  return { fetchedAt, cycles };
}

/** A fetch that never reaches a network. */
function fakeFetch(reply: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()) });
    return reply(String(url));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const NOW = "2026-09-04T10:00:00Z";

describe("support schedules and the cache in front of them", () => {
  it("only products on the allowlist are ever requested", () => {
    // A crafted composer.json naming `../../evil` must not become a URL.
    expect(urlFor("symfony")).toBe("https://endoflife.date/api/symfony.json");
    expect(urlFor("../../etc/passwd")).toBeNull();
    expect(urlFor("https://evil.example/x")).toBeNull();
    expect(urlFor("")).toBeNull();
    // And the URL is built, never taken.
    expect(urlFor("php")).toBe("https://endoflife.date/api/php.json");
    expect(PRODUCTS).toEqual([
      "php", "nodejs", "symfony", "laravel", "python", "django", "ruby", "rails", "go", "rust", "nextjs", "dotnet",
    ]);
    expect(isKnownProduct("dotnet")).toBe(true);
    expect(isKnownProduct("cobol")).toBe(false);
  });

  it("a fresh entry is not refetched and an old one is", () => {
    expect(isFresh(entry("2026-09-01T10:00:00Z"), NOW)).toBe(true); // three days old
    expect(isFresh(entry("2026-08-01T10:00:00Z"), NOW)).toBe(false); // a month old
    // Exactly at the TTL is stale: the boundary belongs to the refetch.
    expect(isFresh(entry("2026-08-28T10:00:00Z"), NOW)).toBe(false);
    expect(isFresh(entry("2026-08-28T10:00:01Z"), NOW)).toBe(true);
  });

  it("an entry from the future is not trusted", () => {
    // A clock that moved backwards, or a hand-edited file.
    expect(isFresh(entry("2027-01-01T00:00:00Z"), NOW)).toBe(false);
    expect(isFresh(entry("not a date"), NOW)).toBe(false);
    expect(isFresh(entry("2026-09-04"), NOW)).toBe(false); // no offset is not rfc3339
  });

  it("age is reported in days for the as-of line", () => {
    expect(ageDays(entry("2026-08-30T10:00:00Z"), NOW)).toBe(5);
    expect(ageDays(entry("not a date"), NOW)).toBeNull();
  });

  it("a failed fetch leaves the stale entry standing", async () => {
    // Offline with week-old dates is a working widget; offline with no dates is
    // a broken one.
    const cache = defaultCache();
    cache.products["php"] = entry("2020-01-01T00:00:00Z", [{ ...defaultCycle(), cycle: "8.1" }]);
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });

    const failed = await refreshFrom("http://127.0.0.1:1", fetch, cache, ["php"], NOW);

    expect(failed).toEqual(["php"]); // the failure is reported, not swallowed
    // Six-year-old dates beat no dates — a schedule does not rot that fast.
    expect(cache.products["php"]!.cycles).toHaveLength(1);
    expect(cache.products["php"]!.fetchedAt).toBe("2020-01-01T00:00:00Z");
  });

  it("a fresh entry is not fetched at all", async () => {
    const cache = defaultCache();
    cache.products["php"] = entry("2026-09-03T10:00:00Z", [defaultCycle()]);
    const { fetch, calls } = fakeFetch(() => {
      throw new Error("must not be called");
    });
    const failed = await refreshFrom("http://127.0.0.1:1", fetch, cache, ["php"], NOW);
    // One request per product per week, and this week is spent.
    expect(failed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an unknown product is never fetched or recorded", async () => {
    const cache = defaultCache();
    const { fetch, calls } = fakeFetch(() => {
      throw new Error("must not be called");
    });
    const failed = await refreshFrom("http://127.0.0.1:1", fetch, cache, ["not-a-product"], NOW);
    expect(failed).toEqual([]);
    expect(cache.products).toEqual({});
    expect(calls).toEqual([]);
  });

  it("a good answer replaces the entry, and an empty list never does", async () => {
    const cache = defaultCache();
    cache.products["php"] = entry("2020-01-01T00:00:00Z", [{ ...defaultCycle(), cycle: "8.1" }]);
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith("/php.json")
        ? new Response(JSON.stringify([{ cycle: "8.4", support: "2026-12-31", eol: false, latest: "8.4.3" }]), {
            status: 200,
          })
        : new Response("[]", { status: 200 }),
    );
    const failed = await refreshFrom("https://endoflife.date/api", fetch, cache, ["php", "go"], NOW);
    expect(failed).toEqual(["go"]); // an empty list has told us nothing
    expect(cache.products["go"]).toBeUndefined();
    expect(cache.products["php"]).toEqual({
      fetchedAt: NOW,
      cycles: [{ cycle: "8.4", support: { kind: "date", date: "2026-12-31" }, eol: { kind: "pending" }, latest: "8.4.3" }],
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://endoflife.date/api/php.json",
      "https://endoflife.date/api/go.json",
    ]);
  });

  it("fetchOne names itself, asks for JSON, and says exactly what went wrong", async () => {
    const ok = fakeFetch(() => new Response(JSON.stringify([{ cycle: "1.27" }]), { status: 200 }));
    expect(await fetchOne(ok.fetch, "https://endoflife.date/api/go.json")).toEqual([
      { cycle: "1.27", support: { kind: "absent" }, eol: { kind: "absent" }, latest: null },
    ]);
    // A free service is owed the ability to see who is calling it.
    expect(ok.calls[0]!.headers["user-agent"]).toBe("DDD-dashboard (https://github.com/agitri/ddd)");
    expect(ok.calls[0]!.headers["accept"]).toBe("application/json");

    const missing = fakeFetch(() => new Response("", { status: 404, statusText: "Not Found" }));
    await expect(fetchOne(missing.fetch, "https://endoflife.date/api/go.json")).rejects.toThrow(
      "endoflife.date answered 404 Not Found",
    );

    const offline = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchOne(offline.fetch, "https://endoflife.date/api/go.json")).rejects.toThrow(
      "could not reach endoflife.date: fetch failed",
    );

    const junk = fakeFetch(() => new Response("not json", { status: 200 }));
    await expect(fetchOne(junk.fetch, "https://endoflife.date/api/go.json")).rejects.toThrow(/^unreadable schedule: /);

    const wrongShape = fakeFetch(() => new Response('{"cycles": []}', { status: 200 }));
    await expect(fetchOne(wrongShape.fetch, "https://endoflife.date/api/go.json")).rejects.toThrow(
      /^unreadable schedule: /,
    );
  });

  it("the cache file is written with sorted keys and read back with its milestones intact", () => {
    const { env } = scratchEnv("eol-cache");
    expect(load(env)).toEqual({ products: {}, live: {} });

    const cache: Cache = {
      products: {
        symfony: {
          fetchedAt: "2026-09-04T09:00:00Z",
          cycles: [
            { cycle: "8.0", support: { kind: "date", date: "2026-07-31" }, eol: { kind: "reached" }, latest: "8.0.16" },
          ],
        },
        nodejs: { fetchedAt: "2026-09-04T09:00:00Z", cycles: [] },
      },
      live: {
        "https://z.example": { at: NOW, liveness: { state: "unreachable", detail: "refused" } },
        "https://a.example": { at: NOW, liveness: { state: "answering", detail: 200 } },
      },
    };
    save(env, cache);
    const text = readFileSync(env.eolCacheFile(), "utf8");
    // BTreeMap: sorted keys, both maps.
    expect(text.indexOf('"nodejs"')).toBeLessThan(text.indexOf('"symfony"'));
    expect(text.indexOf('"https://a.example"')).toBeLessThan(text.indexOf('"https://z.example"'));
    expect(text.indexOf('"products"')).toBeLessThan(text.indexOf('"live"'));
    expect(text).toContain('"kind": "reached"');

    // The round trip is the point: an entry read back must still carry a verdict.
    expect(load(env)).toEqual(cache);
    expect(cacheFromJson({})).toEqual({ products: {}, live: {} });
    expect(() => cacheFromJson({ products: { php: { cycles: [] } } })).toThrow(/^json: /);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/eol` — expected: cannot resolve `./schedule`, `./live`, `./watchlist`.

- [ ] **Step 3: Write the modules**

`src/core/eol/watchlist.ts`:

```ts
/**
 * What you asked the watcher to watch. Port of `eol/watchlist.rs`.
 *
 * User-authored, so it lives outside the item cache for the same reason
 * `repo-links.json` does: `replaceForConnection` deletes and reinserts every
 * item on each sync, and anything you wrote there would be destroyed by the
 * next refresh.
 *
 * Explicit by design. A project you are working in gets its dependencies bumped
 * as a matter of course; the one that rots is the one that was built, shipped
 * and set aside.
 */
import { realpathSync, statSync } from "node:fs";
import { DddError } from "../error";
import { isArray, isString, optional, record, required } from "../json";
import type { EnvRoot } from "../paths";
import { readJson, writeJson } from "../store";

export interface Watched {
  /** Canonical path of the checkout. The identity of the record. */
  path: string;
  /**
   * Where it is serving, if it is. **Only ever typed by the user** — never
   * inferred from GitHub's `homepage`, from DNS, or from a compose file.
   */
  url: string | null;
  note: string | null;
  addedAt: string;
}

export interface Watchlist {
  watched: Watched[];
}

export function defaultWatchlist(): Watchlist {
  return { watched: [] };
}

export function watchedFromJson(raw: unknown): Watched {
  const o = record(raw, "a watched checkout");
  return {
    path: required(o, "path", isString),
    url: optional(o, "url", isString, null as string | null),
    note: optional(o, "note", isString, null as string | null),
    addedAt: required(o, "addedAt", isString),
  };
}

export function watchlistFromJson(raw: unknown): Watchlist {
  const o = record(raw, "a watchlist");
  return { watched: optional(o, "watched", isArray, [] as unknown[]).map(watchedFromJson) };
}

export function load(env: EnvRoot): Watchlist {
  return readJson(env.watchlistFile(), watchlistFromJson, defaultWatchlist);
}

export function save(env: EnvRoot, list: Watchlist): void {
  writeJson(env.watchlistFile(), { watched: list.watched.map((w) => ({ path: w.path, url: w.url, note: w.note, addedAt: w.addedAt })) });
}

/**
 * A URL that is safe to fetch later.
 *
 * http(s) only, and a host is required. This value ends up in an outbound
 * request, so what is refused here is what can never be requested — a `file://`
 * or a bare word must not become a fetch of something local.
 */
export function validateUrl(raw: string): string {
  const url = raw.trim();
  if (url === "") throw DddError.invalid("no address given");
  const rest = url.startsWith("https://") ? url.slice(8) : url.startsWith("http://") ? url.slice(7) : null;
  if (rest === null) throw DddError.invalid(`${url} is not an http or https address`);
  const host = rest.split(/[/?#]/)[0] ?? "";
  if (host === "" || !host.includes(".")) throw DddError.invalid(`${url} has no host to reach`);
  return url;
}

/**
 * Add a checkout, or update the one already there.
 *
 * Idempotent on path: assigning a repo twice sets its URL rather than producing
 * a second row that disagrees with the first. Synchronous end to end, so the
 * read and the write cannot interleave with another command.
 */
export function add(env: EnvRoot, rawPath: string, rawUrl: string | null, note: string | null): Watchlist {
  if (!isDirectory(rawPath)) throw DddError.notFound(`${rawPath} is not a directory`);
  let path: string;
  try {
    path = realpathSync(rawPath);
  } catch (e) {
    throw DddError.io(e);
  }
  const trimmed = rawUrl === null ? null : rawUrl.trim();
  const url = trimmed === null || trimmed === "" ? null : validateUrl(trimmed);

  const list = load(env);
  const existing = list.watched.find((w) => w.path === path);
  if (existing !== undefined) {
    // A later add with no URL must not silently forget the one already
    // recorded — clearing is its own action.
    if (url !== null) existing.url = url;
    if (note !== null) existing.note = note;
  } else {
    list.watched.push({ path, url, note, addedAt: new Date().toISOString() });
  }
  save(env, list);
  return list;
}

/**
 * Stop watching. Removes the record and nothing else — the checkout on disk is
 * untouched, as it is everywhere else in DDD.
 */
export function remove(env: EnvRoot, path: string): Watchlist {
  const list = load(env);
  list.watched = list.watched.filter((w) => w.path !== path);
  save(env, list);
  return list;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
```

`src/core/eol/live.ts`:

```ts
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
  // reason, not a stack.
  const message = e instanceof Error ? e.message : String(e);
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
```

`src/core/eol/schedule.ts`:

```ts
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
  "php", "nodejs", "symfony", "laravel", "python", "django", "ruby", "rails", "go", "rust",
  "nextjs", "dotnet",
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
  for (const [product, value] of Object.entries(optional(o, "products", isPlainRecord, {} as Record<string, unknown>))) {
    products[product] = entryFromJson(value);
  }
  return { products, live: checksFromJson(optional(o, "live", isPlainRecord, {} as Record<string, unknown>)) };
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
export async function refresh(
  fetch: typeof globalThis.fetch,
  cache: Cache,
  wanted: string[],
  now: string,
): Promise<string[]> {
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
    let cycles: Cycle[] | null = null;
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/core/eol` — expected: PASS (five files). Then `npx tsc --noEmit` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/eol/schedule.ts src/core/eol/schedule.test.ts src/core/eol/live.ts src/core/eol/live.test.ts src/core/eol/watchlist.ts src/core/eol/watchlist.test.ts
git commit -m "feat(eol): schedules with a week-long cache, liveness that never calls a timeout dead, and the watchlist"
```

---

### Task 12: The EOL board and its four commands

**Files:**
- Create: `src/core/eol/board.ts`
- Modify: `src/main/commands.ts`, `src/main/commands.test.ts`
- Test: `src/core/eol/board.test.ts`

**Interfaces:**
- Consumes: `Confidence`, `Declaration`, `forDir` from `./detect`; `Support`, `Cycle`, `severity`, `supportOn`, `find`, `milestoneDate` from `./status`; `Cache`, `Entry`, `ageDays`, `isKnownProduct`, `load`, `save`, `refresh` from `./schedule`; `Checks`, `Liveness`, `refresh` from `./live`; `Watched`, `add`, `remove`, `load` from `./watchlist`; `deps.sync.fetch` in `src/main/commands.ts`.
- Produces: `board.ts`: `Finding`, `Row`, `Board`, `build(watched, declarations, cache, checks, today, now, stale)`, `rank(row)`, `productsNeeded(declarations)`, `urlsToCheck(watched)`, `Declarations`. Commands `eol_board`, `eol_watch`, `eol_unwatch`, `eol_watchlist`.

- [ ] **Step 1: Write the failing tests**

`src/core/eol/board.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { build, productsNeeded, rank, urlsToCheck, type Declarations } from "./board";
import type { Declaration } from "./detect";
import type { Checks } from "./live";
import type { Cache } from "./schedule";
import { severity, type Cycle } from "./status";
import type { Watched } from "./watchlist";

function watched(path: string, url: string | null): Watched {
  return { path, url, note: null, addedAt: "2026-09-01T00:00:00Z" };
}

function declaration(product: string, cycle: string): Declaration {
  return { also: [], product, cycle, source: "composer.json", confidence: "exact", raw: `${product}: ${cycle}` };
}

function dated(cycle: string, support: string, eol: string, latest: string): Cycle {
  return { cycle, support: { kind: "date", date: support }, eol: { kind: "date", date: eol }, latest };
}

/** The real schedules, as endoflife.date publishes them today. */
function cache(): Cache {
  return {
    products: {
      symfony: {
        fetchedAt: "2026-09-04T09:00:00Z",
        cycles: [dated("8.0", "2026-07-31", "2026-07-31", "8.0.16"), dated("7.4", "2028-11-30", "2029-11-30", "7.4.18")],
      },
      nodejs: { fetchedAt: "2026-09-04T09:00:00Z", cycles: [dated("24", "2026-10-20", "2028-04-30", "24.20.0")] },
    },
    live: {},
  };
}

const TODAY = "2026-09-04";
const NOW = "2026-09-04T10:00:00Z";
const NO_CHECKS: Checks = {};

describe("the board", () => {
  it("this machine's real projects come out in the order that matters", () => {
    // Four Symfony 8.0 projects (support ended 2026-07-31), one on the 7.4 LTS,
    // one on Node 24 (active support ends in 46 days). The LTS one is on the
    // *older* line and is the healthy one.
    const list = [
      watched("/p/toneelPetra", null),
      watched("/p/dedesignwinkel", null),
      watched("/p/climate4u", "https://climate4u.example"),
      watched("/p/zzplanner", null),
    ];
    const declarations: Declarations = [
      ["/p/toneelPetra", [declaration("symfony", "7.4")]],
      ["/p/dedesignwinkel", [declaration("nodejs", "24")]],
      ["/p/climate4u", [declaration("symfony", "8.0")]],
      ["/p/zzplanner", [declaration("symfony", "8.0")]],
    ];

    const board = build(list, declarations, cache(), NO_CHECKS, TODAY, NOW, []);
    // Ended-and-live, then ended, then ending soon, then the healthy one.
    expect(board.rows.map((r) => r.name)).toEqual(["climate4u", "zzplanner", "dedesignwinkel", "toneelPetra"]);
    expect(board.rows[0]!.worst).toEqual({ state: "ended" });
    expect(board.rows[2]!.worst).toEqual({ state: "endingSoon", days: 46 });
    expect(board.rows[3]!.worst).toEqual({ state: "active" });
    expect(board.rows[3]!.findings[0]).toEqual({
      product: "symfony",
      cycle: "7.4",
      source: "composer.json",
      confidence: "exact",
      raw: "symfony: 7.4",
      support: { state: "active" },
      eolDate: "2029-11-30",
      supportDate: "2028-11-30",
      latest: "7.4.18",
      scheduleAgeDays: 0,
    });
    // `also` is omitted entirely when empty, as the Rust's
    // `skip_serializing_if` does.
    expect("also" in board.rows[3]!.findings[0]!).toBe(false);
  });

  it("a live url promotes a row over an identical dormant one", () => {
    const list = [watched("/p/dormant", null), watched("/p/serving", "https://serving.example")];
    const declarations: Declarations = [
      ["/p/dormant", [declaration("symfony", "8.0")]],
      ["/p/serving", [declaration("symfony", "8.0")]],
    ];
    const board = build(list, declarations, cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.name).toBe("serving"); // unattended and exposed is the dangerous one
  });

  it("a dead runtime in a folder still outranks a live one expiring next month", () => {
    const list = [watched("/p/expiring", "https://expiring.example"), watched("/p/dead", null)];
    const declarations: Declarations = [
      ["/p/expiring", [declaration("nodejs", "24")]],
      ["/p/dead", [declaration("symfony", "8.0")]],
    ];
    const board = build(list, declarations, cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.name).toBe("dead");
  });

  it("a row is ranked by its worst finding", () => {
    const list = [watched("/p/mixed", null)];
    const declarations: Declarations = [
      ["/p/mixed", [declaration("symfony", "7.4"), declaration("symfony", "8.0")]],
    ];
    const board = build(list, declarations, cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.worst).toEqual({ state: "ended" });
    expect(board.rows[0]!.findings).toHaveLength(2); // and both are still shown
  });

  it("a cycle the schedule has never heard of is unknown not ended", () => {
    const list = [watched("/p/future", null)];
    const declarations: Declarations = [["/p/future", [declaration("symfony", "9.9")]]];
    const board = build(list, declarations, cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.findings[0]!.support).toEqual({ state: "unknown" });
    expect(board.rows[0]!.findings[0]!.support).not.toEqual({ state: "ended" });
  });

  it("a product with no schedule at all yields no verdict", () => {
    // Offline on a first run: the reading is still worth showing.
    const list = [watched("/p/offline", null)];
    const declarations: Declarations = [["/p/offline", [declaration("php", "8.4")]]];
    const board = build(list, declarations, { products: {}, live: {} }, NO_CHECKS, TODAY, NOW, ["php"]);
    expect(board.rows[0]!.findings[0]!.support).toEqual({ state: "unknown" });
    expect(board.rows[0]!.findings[0]!.cycle).toBe("8.4"); // what the file said is still shown
    expect(board.rows[0]!.findings[0]!.scheduleAgeDays).toBeNull();
    expect(board.stale).toEqual(["php"]);
  });

  it("a verdict carries the age of the schedule it came from", () => {
    const c = cache();
    c.products["symfony"]!.fetchedAt = "2026-08-30T10:00:00Z";
    const board = build([watched("/p/a", null)], [["/p/a", [declaration("symfony", "8.0")]]], c, NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.findings[0]!.scheduleAgeDays).toBe(5);
  });

  it("a watched repo that vanished is kept and marked", () => {
    // A watched thing disappearing is information, not a reason to go quiet.
    const board = build([watched("/p/gone-xyz", null)], [], cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]!.missing).toBe(true);
    expect(board.rows[0]!.unreadable).toBe(false); // missing and unreadable are different answers
  });

  it("a repo with nothing to read says so rather than looking healthy", () => {
    const board = build([watched("/", null)], [["/", []]], cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.unreadable).toBe(true);
    expect(board.rows[0]!.missing).toBe(false);
    expect(board.rows[0]!.worst).toEqual({ state: "unknown" });
  });

  it("the fetch list is one entry per product however many repos use it", () => {
    // Six Symfony projects are one request.
    const declarations: Declarations = Array.from({ length: 6 }, (_, i) => [
      `/p/${i}`,
      [declaration("symfony", "8.0"), declaration("php", "8.4")],
    ]);
    expect(productsNeeded(declarations)).toEqual(["php", "symfony"]);
  });

  it("a product nobody publishes a schedule for is never requested", () => {
    expect(productsNeeded([["/p/a", [declaration("cobol", "85")]]])).toEqual([]);
  });

  it("a url confirmed unreachable stops promoting its row", () => {
    // The user said it was live; we checked, and it is not. It is a folder
    // again, and a folder does not outrank a site with traffic on it.
    const list = [watched("/p/gone", "https://gone.example"), watched("/p/serving", "https://serving.example")];
    const declarations: Declarations = [
      ["/p/gone", [declaration("symfony", "8.0")]],
      ["/p/serving", [declaration("symfony", "8.0")]],
    ];
    const checks: Checks = {
      "https://gone.example": { at: NOW, liveness: { state: "unreachable", detail: "refused" } },
      "https://serving.example": { at: NOW, liveness: { state: "answering", detail: 200 } },
    };

    const board = build(list, declarations, cache(), checks, TODAY, NOW, []);
    expect(board.rows[0]!.name).toBe("serving");
    expect(board.rows[0]!.live).toEqual({ state: "answering", detail: 200 });
  });

  it("a url that merely timed out keeps its promotion", () => {
    // A slow server is not a gone server, and demoting a row on a timeout would
    // quietly hide the dangerous case.
    const list = [watched("/p/slow", "https://slow.example")];
    const declarations: Declarations = [["/p/slow", [declaration("symfony", "8.0")]]];
    const checks: Checks = { "https://slow.example": { at: NOW, liveness: { state: "noAnswer", detail: "timeout" } } };
    const board = build(list, declarations, cache(), checks, TODAY, NOW, []);
    expect(rank(board.rows[0]!)).toBe(severity({ state: "ended" }) * 2 + 1);
  });

  it("only urls that exist are ever checked", () => {
    expect(urlsToCheck([watched("/p/a", "https://a.example"), watched("/p/b", null)])).toEqual(["https://a.example"]);
  });

  it("agreement is carried through as `also`", () => {
    const d: Declaration = { ...declaration("symfony", "8.0"), also: ["Dockerfile"] };
    const board = build([watched("/p/a", null)], [["/p/a", [d]]], cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.findings[0]!.also).toEqual(["Dockerfile"]);
    // Product first, then `also` — the Rust's struct order.
    expect(Object.keys(board.rows[0]!.findings[0]!).slice(0, 2)).toEqual(["product", "also"]);
  });
});
```

Then, in `src/main/commands.test.ts`, remove these four names from `NOT_YET_PORTED`: `eol_board`, `eol_watch`, `eol_unwatch`, `eol_watchlist`. (No new imports are needed — `mkdtempSync`, `realpathSync`, `writeFileSync`, `readFileSync`, `tmpdir`, `join` and `basename` are already imported at the top of the file.) Then append:

```ts
/**
 * A fetch that answers endoflife.date with a canned schedule and refuses every
 * HEAD with a timeout — the honest shape of "someone else's slow server".
 */
function eolCommands() {
  const calls: { url: string; method: string }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method });
    if (method === "HEAD") {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    if (u === "https://endoflife.date/api/nodejs.json") {
      return new Response(
        JSON.stringify([
          // A numeric cycle, as the real API sends for Node.
          { cycle: 24, support: "2026-10-20", eol: "2028-04-30", latest: "24.20.0" },
          { cycle: "20", support: "2025-10-22", eol: "2026-04-30", latest: "20.19.5" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("", { status: 404, statusText: "Not Found" });
  }) as typeof globalThis.fetch;
  const eolSync = { ...sync, fetch };
  return {
    commands: createCommands({ emit: emitter, watcher, scheduler: new Scheduler(eolSync), sync: eolSync }),
    calls,
  };
}

interface BoardShape {
  rows: {
    path: string;
    name: string;
    url: string | null;
    missing: boolean;
    unreadable: boolean;
    live: { state: string; detail: unknown } | null;
    findings: Record<string, unknown>[];
    worst: { state: string };
  }[];
  stale: string[];
}

describe("EOL commands", () => {
  it("watch, board, unwatch — one request per product, and a timeout is never `unreachable`", async () => {
    const { home } = scratchEnv("cmd-eol");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-eol-")));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: ">=20 <23" } }));

    const { commands: eol, calls } = eolCommands();
    const list = (await eol.eol_watch!({
      env: "default",
      path: dir,
      url: "https://watched.example",
      note: "a client site",
    })) as { watched: { path: string; url: string | null; note: string | null }[] };
    expect(list.watched).toHaveLength(1);
    expect(list.watched[0]!.path).toBe(dir);
    expect(list.watched[0]!.url).toBe("https://watched.example");
    expect(list.watched[0]!.note).toBe("a client site");

    const board = (await eol.eol_board!({ env: "default" })) as BoardShape;
    expect(board.stale).toEqual([]);
    expect(board.rows).toHaveLength(1);
    const row = board.rows[0]!;
    expect(row.name).toBe(basename(dir));
    expect(row.path).toBe(dir);
    expect(row.missing).toBe(false);
    expect(row.unreadable).toBe(false);
    // A slow server is not a gone server.
    expect(row.live).toEqual({ state: "noAnswer", detail: "no reply within the deadline" });
    expect(row.findings).toEqual([
      {
        product: "nodejs",
        cycle: "20",
        source: "package.json",
        confidence: "floor",
        raw: "engines.node: >=20 <23",
        support: { state: "ended" },
        eolDate: "2026-04-30",
        supportDate: "2025-10-22",
        latest: "20.19.5",
        scheduleAgeDays: 0,
      },
    ]);
    expect(row.worst).toEqual({ state: "ended" });

    // One request for the schedule, one HEAD for the live URL.
    expect(calls).toEqual([
      { url: "https://endoflife.date/api/nodejs.json", method: "GET" },
      { url: "https://watched.example", method: "HEAD" },
    ]);

    // Written back, with its milestones in the tagged on-disk shape.
    const onDisk = JSON.parse(readFileSync(`${home}/environments/default/eol-cache.json`, "utf8")) as {
      products: Record<string, { fetchedAt: string; cycles: { cycle: string; eol: unknown }[] }>;
      live: Record<string, { liveness: { state: string } }>;
    };
    expect(Object.keys(onDisk.products)).toEqual(["nodejs"]);
    expect(onDisk.products["nodejs"]!.cycles.map((c) => c.cycle)).toEqual(["24", "20"]);
    expect(onDisk.products["nodejs"]!.cycles[1]!.eol).toEqual({ kind: "date", date: "2026-04-30" });
    expect(onDisk.live["https://watched.example"]!.liveness.state).toBe("noAnswer");

    // The second call asks nothing: the schedule is good for a week and the
    // liveness answer for an hour — and the verdict survives the round trip.
    const again = (await eol.eol_board!({ env: "default" })) as BoardShape;
    expect(calls).toHaveLength(2);
    expect(again.rows[0]!.findings[0]).toMatchObject({ support: { state: "ended" }, eolDate: "2026-04-30" });

    expect(await eol.eol_watchlist!({ env: "default" })).toEqual(list);
    expect(await eol.eol_unwatch!({ env: "default", path: dir })).toEqual({ watched: [] });
    expect(await eol.eol_watchlist!({ env: "default" })).toEqual({ watched: [] });
  });

  it("refuses a path that is not a checkout and a url that could never be fetched", async () => {
    scratchEnv("cmd-eol-bad");
    const { commands: eol } = eolCommands();
    await expect(eol.eol_watch!({ env: "default", path: "/nonexistent-checkout-xyz" })).rejects.toThrow(
      "/nonexistent-checkout-xyz is not a directory",
    );
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-eol-bad-")));
    await expect(eol.eol_watch!({ env: "default", path: dir, url: "file:///etc/passwd" })).rejects.toThrow(
      "file:///etc/passwd is not an http or https address",
    );
    expect(await eol.eol_watchlist!({ env: "default" })).toEqual({ watched: [] });
  });

  it("a watched checkout that vanished is kept, marked, and asks the network for nothing", async () => {
    scratchEnv("cmd-eol-gone");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-eol-gone-")));
    const { commands: eol, calls } = eolCommands();
    await eol.eol_watch!({ env: "default", path: dir });
    rmSync(dir, { recursive: true, force: true });

    const board = (await eol.eol_board!({ env: "default" })) as BoardShape;
    expect(board.rows[0]!.missing).toBe(true);
    expect(board.rows[0]!.unreadable).toBe(false);
    expect(board.rows[0]!.findings).toEqual([]);
    expect(board.rows[0]!.worst).toEqual({ state: "unknown" });
    expect(calls).toEqual([]);
  });
});
```

Add `rmSync` to the existing `node:fs` import at the top of `src/main/commands.test.ts`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/core/eol/board.test.ts src/main/commands.test.ts` — expected: cannot resolve `./board`, and in `commands.test.ts` the contract test fails (four names neither registered nor listed) plus `commands.eol_watch is not a function`.

- [ ] **Step 3: Write the module**

`src/core/eol/board.ts`:

```ts
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
        support: cycle === null ? ({ state: "unknown" } as Support) : supportOn(cycle, today),
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
```

- [ ] **Step 4: Add the commands**

In `src/main/commands.ts`, add these imports beside the other core imports:

```ts
import * as eolBoard from "../core/eol/board";
import * as eolDetect from "../core/eol/detect";
import * as eolLive from "../core/eol/live";
import * as eolSchedule from "../core/eol/schedule";
import * as eolWatchlist from "../core/eol/watchlist";
```

and, inside `createCommands`, after the widget-instruction block and before the closing `};`, add:

```ts
    // --- the EOL watcher ---

    /**
     * The board: what you assigned, what each checkout declares, and whether it
     * is still supported.
     *
     * Reads the watchlist and the checkouts on every call; goes to the network
     * only for a product whose schedule is missing or over a week old. Six
     * Symfony projects are one request, and a week later it is still one.
     */
    eol_board: async ({ env }) => {
      const r = root(env);
      const watched = eolWatchlist.load(r).watched;

      // Reading manifests is blocking file work; the fetch after it is not.
      const declarations: eolBoard.Declarations = watched.map((w) => [w.path, eolDetect.forDir(w.path)]);

      const now = new Date().toISOString();
      // The one store read-modify-written across `await`s, as the Rust does:
      // `eol-cache.json` is derived and safe to lose, and the alternative is
      // holding the whole app still for a network round trip.
      const cache = eolSchedule.load(r);
      const wanted = eolBoard.productsNeeded(declarations);
      const stale = await eolSchedule.refresh(deps.sync.fetch, cache, wanted, now);

      // The live URLs, at most once an hour each. Someone else's server, so
      // this is deliberately the slowest thing on the board.
      await eolLive.refresh(deps.sync.fetch, cache.live, eolBoard.urlsToCheck(watched), now);

      // Written back even when some products failed: whatever did refresh is
      // worth keeping, and the ones that did not kept their old entries.
      eolSchedule.save(r, cache);

      // `now.format("%Y-%m-%d")` on a UTC instant is the first ten characters.
      return eolBoard.build(watched, declarations, cache, cache.live, now.slice(0, 10), now, stale);
    },

    /** Assign a checkout to the watcher, with the live URL you typed for it. */
    eol_watch: async ({ env, path, url, note }) =>
      eolWatchlist.add(
        root(env),
        String(path),
        url === undefined || url === null ? null : String(url),
        note === undefined || note === null ? null : String(note),
      ),

    /** Stop watching. Forgets the record; the checkout on disk is untouched. */
    eol_unwatch: async ({ env, path }) => eolWatchlist.remove(root(env), String(path)),

    eol_watchlist: async ({ env }) => eolWatchlist.load(root(env)),
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run` — expected: PASS, including the registry contract test now that the four names are handlers rather than `NOT_YET_PORTED` entries. Then `npx tsc --noEmit` and `npm run lint` — expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/eol/board.ts src/core/eol/board.test.ts src/main/commands.ts src/main/commands.test.ts
git commit -m "feat(eol): the board and its four commands"
```

<!-- deps/notes for the assembler

NEW NPM DEPENDENCIES: none. `chrono` is replaced by hand-rolled strict date/RFC3339
parsing (`parseDate` in status.ts, `instant()` in schedule.ts and live.ts — the Rust
duplicates the same parse in both modules, so the port does too). `reqwest` is replaced
by the injected `fetch` plus `AbortSignal.timeout`.

EXPORTS OTHER SECTIONS MAY CONSUME:
- `src/core/eol/detect.ts`: `Confidence`, `CONFIDENCE_RANK`, `Declaration`, `Granularity`,
  `granularity`, `parseConstraint`, `cycleFrom`, `parseComposerJson`, `parsePackageJson`,
  `parseVersionFile`, `parseDockerfile`, `parseTomlLike`, `FILES`, `forDir`, `collapseAgreement`.
- `src/core/eol/status.ts`: `HORIZON_DAYS`, `Support`, `severity`, `Milestone`, `milestoneDate`,
  `Cycle`, `defaultCycle`, `cycleFromApi`, `cycleFromJson`, `supportOn`, `find`, `daysBetween`.
- `src/core/eol/schedule.ts`: `TTL_SECONDS`, `PRODUCTS`, `isKnownProduct`, `API`, `urlFor`,
  `urlForBase`, `Entry`, `Cache`, `defaultCache`, `entryFromJson`, `cacheFromJson`, `load`,
  `save`, `isFresh`, `ageDays`, `refresh`, `refreshFrom`, `fetchOne`.
- `src/core/eol/live.ts`: `TTL_SECONDS`, `Liveness`, `isServing`, `Checked`, `Checks`,
  `checkedFromJson`, `checksFromJson`, `isFresh`, `classify`, `check`, `short`, `refresh`.
- `src/core/eol/watchlist.ts`: `Watched`, `Watchlist`, `defaultWatchlist`, `watchedFromJson`,
  `watchlistFromJson`, `load`, `save`, `validateUrl`, `add`, `remove`.
- `src/core/eol/board.ts`: `Declarations`, `Finding`, `Row`, `Board`, `build`, `rank`,
  `urlsToCheck`, `productsNeeded`.
- `schedule.ts` imports `statusLabel` from `src/core/sync/adapter.ts` (conventions rule).
- Commands added: `eol_board`, `eol_watch`, `eol_unwatch`, `eol_watchlist`; those four names
  are removed from `NOT_YET_PORTED` in Task 12.

RUST BEHAVIOUR NOT REPRODUCED EXACTLY (all flagged in code comments):
1. **The Rust cannot read back its own cache.** `Cycle` has a hand-written `Deserialize` that
   expects the *API* shape (bare strings/booleans), while `Serialize` writes `Milestone`
   adjacently tagged (`{"kind":"date","date":"…"}`). So on the Rust side every milestone in
   `eol-cache.json` reloads as `Absent` and every cached verdict degrades to `Unknown` until
   the weekly refetch. The port keeps the API decoder verbatim as `cycleFromApi` and adds
   `cycleFromJson` for the on-disk shape; `schedule.entryFromJson` uses the latter. This is a
   deliberate bug fix, documented in the doc comment on `cycleFromJson`, and it is what the
   commands test's "second call" assertion pins.
2. **Timeout detection.** `reqwest::Error::is_timeout` becomes "the thrown error's `name` is
   `TimeoutError`", which is what `AbortSignal.timeout` aborts with. A connect-phase failure
   that undici reports as a generic `TypeError: fetch failed` classifies as `unreachable`, the
   same bucket reqwest's non-timeout errors land in.
3. **`live::check` never falls back to GET.** The Rust doc comment promises "`HEAD`, then `GET`
   if the server dislikes `HEAD`" but the body only ever sends `HEAD`. The port matches the
   body, not the comment.
4. **Numeric cycles.** `serde_json::Number::to_string` would render a JSON `8.0` as `"8.0"`;
   `JSON.parse` collapses it to `8` and the port writes `"8"`. Noted in `status.ts`'s `text()`.
   No observed endoflife.date response publishes a fractional numeric cycle.
5. **`eol_board` awaits between `schedule.load` and `schedule.save`**, violating the plan's
   synchronous read-modify-write rule. The Rust command does exactly this and the file is
   derived cache data; the exception is called out in a comment on the handler.
6. **The live test `a real socket answers and a dead port does not`** is stronger than the
   Rust's, which stops at `classify` on a mistaken belief that `validate_url` refuses
   `127.0.0.1` (it does not — the host has dots). The port drives a real loopback server
   through `check`, which conventions explicitly allow. Noted in the test comment.
7. **`Declaration.also`** is a plain `string[]` in-process (never optional), because the Rust's
   `skip_serializing_if` only matters at a serialisation boundary and `Declaration` is never
   serialised on its own. The key is dropped in `board.build` when constructing `Finding`, which
   is the one place the Rust would emit it; `Finding.also` is therefore `also?: string[]` and
   matches the renderer's `EolFinding`.
-->

---

### Task 13: Smoke, README, contract check

**Files:**
- Modify: `src/main/index.ts`, `README.md`, `src/main/commands.test.ts`

**Interfaces:**
- Consumes: every command from Tasks 3, 6, 9 and 12.

- [ ] **Step 1: Confirm the contract test is exact**

Run: `npx vitest run src/main/commands.test.ts` — expected: PASS, and `NOT_YET_PORTED` in `src/main/commands.test.ts` now contains exactly these nine names and nothing else: `products_list`, `product_approve`, `product_revoke`, `product_start`, `product_stop`, `product_log`, `mcp_consent`, `mcp_probe`, plus whichever of the phase 4 names a previous task forgot to remove (there must be none — if one is left, remove it here and note it in the report). If the set has extra names, fix it.

- [ ] **Step 2: Smoke**

In `src/main/index.ts`, inside `smoke()`, directly after `console.log("ddd: smoke ai ok");` and before the CSP probe, add a block that exercises every phase 4 subsystem without network or docker assumptions:

```ts
      // Phase 4: calendar, repos, dev servers, EOL — no network, no model.
      const saved = (await invoke("calendar_event_save", {
        env: "default",
        event: { id: "", title: "Smoke", start: "2026-09-11T09:00:00Z", end: "2026-09-11T10:00:00Z", allDay: false, rrule: "FREQ=DAILY;COUNT=3", notes: null },
      })) as { id: string };
      if (!saved.id.startsWith("ev-")) throw new Error(`calendar_event_save: unexpected id ${saved.id}`);
      const occurrences = (await invoke("calendar_list", { env: "default", from: "2026-09-11T00:00:00Z", to: "2026-09-14T00:00:00Z" })) as { id: string; title: string }[];
      if (occurrences.length !== 3) throw new Error(`calendar_list: expected 3 occurrences, got ${occurrences.length}`);
      await invoke("calendar_event_delete", { env: "default", id: saved.id });
      const after = (await invoke("calendar_list", { env: "default", from: "2026-09-11T00:00:00Z", to: "2026-09-14T00:00:00Z" })) as unknown[];
      if (after.length !== 0) throw new Error(`calendar_event_delete: ${after.length} left`);

      const listing = (await invoke("repos_list", { env: "default", filter: {} })) as { rows: unknown[]; localOnly: unknown[]; total: number };
      if (!Array.isArray(listing.rows) || !Array.isArray(listing.localOnly)) throw new Error("repos_list: bad shape");
      const scanned = (await invoke("repo_scan", { env: "default", rootDir: home })) as number;
      if (typeof scanned !== "number") throw new Error("repo_scan: expected a count");

      const servers = (await invoke("dev_servers_list", { env: "default", filter: { probe: false } })) as { rows: unknown[]; scanMs: number };
      if (!Array.isArray(servers.rows)) throw new Error("dev_servers_list: bad shape");

      const watchlist = (await invoke("eol_watch", { env: "default", path: home, note: "smoke" })) as { watched: { path: string }[] };
      if (watchlist.watched.length !== 1) throw new Error(`eol_watch: ${watchlist.watched.length} watched`);
      const unwatched = (await invoke("eol_unwatch", { env: "default", path: watchlist.watched[0]!.path })) as { watched: unknown[] };
      if (unwatched.watched.length !== 0) throw new Error("eol_unwatch: still watched");
      console.log("ddd: smoke phase4 ok");
```

(`home` is the scratch home already in scope in `smoke()`.) Do not call `eol_board` in the smoke: it would reach endoflife.date. Extend the final ok line so it ends with `…, ai (actions/context/instructions round trip), calendar/repos/dev/eol (local round trips), csp enforced`.

Run: `npm run smoke 2>&1 | grep '^ddd:'` — expected: `ddd: smoke phase4 ok` and the extended ok line, exit 0.

- [ ] **Step 3: README**

In `README.md`'s phase table, mark phase 4 done with: `Calendar (ICS feeds + local events, recurrence expansion), repos (scan/link/clone with progress), dev servers (list/probe/stop), end-of-life board (endoflife.date, cached)`. Add a short "Platform notes" line under it: dev-server cwd resolution needs `lsof` on macOS and `/proc` on Linux; stopping a process is not offered on Windows; docker containers appear when the `docker` CLI is on `PATH`.

- [ ] **Step 4: Full verification and commit**

Run: `npm test` and `npm run typecheck` — expected: all green (a single watcher union-test flake under full-suite load is the known sandbox artifact; re-run that file alone).

```bash
git add src/main/index.ts README.md src/main/commands.test.ts
git commit -m "feat(main): phase 4 smoke and README — calendar, repos, dev servers, EOL complete"
```
