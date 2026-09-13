import { describe, expect, it } from "vitest";
import { fetchContext } from "./adapter";
import { CALENDAR, GMAIL, GoogleAdapter, header, messageId, senderName, toEventItem, toMailItem } from "./google";
import { forProvider } from "./providers";

const cx = (fetch?: typeof globalThis.fetch) =>
  fetchContext({ environmentId: "e", connection: { id: "c", provider: "mail.gmail", label: "Work mail" }, token: "tok", fetch });

const PROFILE = `${GMAIL}/profile`;
const SENT = `${GMAIL}/messages?q=in%3Asent%20newer_than%3A30d&maxResults=100`;
const INBOX = `${GMAIL}/messages?q=in%3Ainbox%20newer_than%3A14d&maxResults=40`;
const meta = (id: string) =>
  `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Id&metadataHeaders=Auto-Submitted&metadataHeaders=Precedence`;
const replyMeta = (id: string) => `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`;
const modify = (id: string) => `${GMAIL}/messages/${id}/modify`;
const SEND = `${GMAIL}/messages/send`;
const EVENTS = `${CALENDAR}/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=`;

type Call = { url: string; method: string; body: string | null; auth: string | null };

/**
 * A fake Google: exact-URL handlers first, then prefix handlers (the calendar
 * URL carries a moving `timeMin`). Counts concurrent in-flight requests so a
 * test can prove the fan-out stays bounded.
 */
function fakeGoogle(handlers: Record<string, (body: string | null) => Response | Promise<Response>> = {}) {
  const calls: Call[] = [];
  const state = { inFlight: 0, peak: 0 };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method: init?.method ?? "GET", body, auth: new Headers(init?.headers).get("authorization") });
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      // A real await point, so overlapping requests really do overlap.
      await new Promise((resolve) => setTimeout(resolve, 1));
      const key = handlers[url] ? url : Object.keys(handlers).find((k) => url.startsWith(k));
      if (key === undefined) return new Response(JSON.stringify({ error: { message: "no handler" } }), { status: 404, statusText: "Not Found" });
      return await handlers[key]!(body);
    } finally {
      state.inFlight--;
    }
  };
  return { fetch, calls, state };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const headers = (pairs: [string, string][]) => ({ payload: { headers: pairs.map(([name, value]) => ({ name, value })) } });

const human = {
  id: "m1",
  threadId: "t1",
  internalDate: "1723999999000",
  snippet: "quick question",
  labelIds: ["INBOX", "UNREAD"],
  ...headers([
    ["From", "Jordy <jordy@example.com>"],
    ["To", "Me@Example.com"],
    ["Subject", "Ping"],
  ]),
};

const newsletter = {
  id: "m2",
  threadId: "t2",
  internalDate: "1723999999000",
  snippet: "this week",
  labelIds: ["INBOX"],
  ...headers([
    ["From", "news@acme.io"],
    ["To", "list@example.com"],
    ["Subject", "Weekly digest"],
    ["List-Unsubscribe", "<https://acme.io/u>"],
    ["List-Id", "acme"],
  ]),
};

// --- ported from the Rust's own tests -------------------------------------------

describe("senders", () => {
  it("reads the person out of a from header", () => {
    expect(senderName("Jordy <jordy@example.com>")).toBe("Jordy");
    expect(senderName('"Van Beurden, K" <k@vb.nl>')).toBe("Van Beurden, K");
    expect(senderName("plain@example.com")).toBe("plain");
  });
});

describe("headers", () => {
  it("finds headers case insensitively", () => {
    // Gmail returns canonical casing, but RFC 5322 does not require it.
    expect(header({ payload: { headers: [{ name: "from", value: "a@b.c" }] } }, "From")).toBe("a@b.c");
    expect(header({ payload: { headers: [] } }, "From")).toBeNull();
    expect(header({}, "From")).toBeNull();
  });
});

// --- the rest ------------------------------------------------------------------

describe("mail items", () => {
  it("carries the verdict's reasons in refs and the whole Gmail shape", () => {
    const item = toMailItem(cx(), human, "me@example.com", new Set(["t1"]))!;
    expect(item.id).toBe("c:m1");
    expect(item.source).toBe("google");
    expect(item.kind).toBe("mail");
    expect(item.project).toBeNull();
    expect(item.title).toBe("Jordy — Ping");
    expect(item.body).toBe("quick question");
    expect(item.url).toBe("https://mail.google.com/mail/u/0/#inbox/m1");
    expect(item.refs).toEqual(["gmail:m1", "thread:t1", "signal:addressed-to-me", "signal:in-my-thread"]);
    expect(item.actions.map((a) => a.id)).toEqual(["reply", "archive", "mark_read", "open"]);
    expect(item.actions.map((a) => a.outbound)).toEqual([true, true, true, false]);
    expect(item.updatedAt).toBe("2024-08-18T16:53:19Z");
    expect(item.unread).toBe(true);
  });

  it("classifies a list mail as bulk and says why", () => {
    const item = toMailItem(cx(), newsletter, "me@example.com", new Set())!;
    expect(item.kind).toBe("mail_bulk");
    // `news@…` is a robot local part, so the sender reason comes first.
    expect(item.refs).toEqual([
      "gmail:m2",
      "thread:t2",
      "noise:sender-news",
      "noise:list-unsubscribe",
      "noise:list-id",
      "noise:subject-weekly-digest",
    ]);
    expect(item.unread).toBe(false);
  });

  it("is not addressed to me when the profile lookup failed", () => {
    const item = toMailItem(cx(), human, "", new Set())!;
    expect(item.refs).toEqual(["gmail:m1", "thread:t1"]);
    expect(item.kind).toBe("mail_bulk");
  });

  it("falls back to the id as the thread, to (no subject), and to now", () => {
    const item = toMailItem(cx(), { id: "m3", ...headers([["From", "a@b.c"]]) }, "", new Set())!;
    expect(item.title).toBe("a — (no subject)");
    expect(item.refs[1]).toBe("thread:m3");
    expect(item.body).toBe("");
    expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(toMailItem(cx(), { threadId: "t" }, "", new Set())).toBeNull();
  });
});

describe("event items", () => {
  it("sorts forward on the raw start string", () => {
    const item = toEventItem(cx(), {
      id: "e1",
      summary: "Standup",
      location: "Room 2",
      htmlLink: "https://calendar.google.com/e1",
      start: { dateTime: "2026-09-14T09:00:00+02:00" },
    })!;
    expect(item.id).toBe("c:event-e1");
    expect(item.kind).toBe("event");
    expect(item.title).toBe("Standup");
    expect(item.body).toBe("Room 2");
    expect(item.url).toBe("https://calendar.google.com/e1");
    expect(item.refs).toEqual(["gcal:e1"]);
    expect(item.actions).toEqual([{ id: "open", label: "Open", outbound: false }]);
    expect(item.updatedAt).toBe("2026-09-14T09:00:00+02:00");
    expect(item.unread).toBe(false);
  });

  it("takes an all-day event's date and drops one with no start", () => {
    expect(toEventItem(cx(), { id: "e2", start: { date: "2026-09-14" } })!.updatedAt).toBe("2026-09-14");
    expect(toEventItem(cx(), { id: "e2", start: { date: "2026-09-14" } })!.title).toBe("(no title)");
    expect(toEventItem(cx(), { id: "e3" })).toBeNull();
    expect(toEventItem(cx(), { start: { date: "2026-09-14" } })).toBeNull();
  });
});

describe("fetching", () => {
  const inbox = (n: number) => ({ messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) });
  const metaHandlers = (n: number) => {
    const out: Record<string, () => Response> = {};
    for (let i = 0; i < n; i++) {
      out[meta(`m${i}`)] = () =>
        json({ id: `m${i}`, threadId: `t${i}`, internalDate: "1723999999000", snippet: "s", labelIds: ["INBOX"], ...headers([["From", `p${i}@x.io`], ["Subject", `S${i}`]]) });
    }
    return out;
  };

  it("fans out over the inbox eight at a time and never more", async () => {
    const google = fakeGoogle({
      [PROFILE]: () => json({ emailAddress: "Me@Example.com" }),
      [SENT]: () => json({ messages: [{ threadId: "t1" }] }),
      [INBOX]: () => json(inbox(20)),
      ...metaHandlers(20),
      [EVENTS]: () => json({ items: [] }),
    });
    const items = await new GoogleAdapter().fetch(cx(google.fetch));
    expect(items).toHaveLength(20);
    expect(google.state.peak).toBe(8);
    expect(google.calls.filter((call) => call.url.includes("format=metadata"))).toHaveLength(20);
    expect(google.calls.every((call) => call.auth === "Bearer tok")).toBe(true);
    // The metadata URL is exactly the Rust's, repeated params and all.
    expect(google.calls.find((call) => call.url.includes("format=metadata"))!.url).toBe(meta("m0"));
  });

  it("asks in the Rust's order and window", async () => {
    const google = fakeGoogle({
      [PROFILE]: () => json({ emailAddress: "me@example.com" }),
      [SENT]: () => json({ messages: [{ threadId: "t1" }] }),
      [INBOX]: () => json({ messages: [{ id: "m1" }] }),
      [meta("m1")]: () => json(human),
      [EVENTS]: () => json({ items: [{ id: "e1", summary: "Standup", start: { dateTime: "2026-09-14T09:00:00+02:00" } }] }),
    });
    const items = await new GoogleAdapter().fetch(cx(google.fetch));
    expect(items.map((i) => i.id)).toEqual(["c:m1", "c:event-e1"]);
    // The sent-thread lookup is what makes this one "mail" rather than bulk.
    expect(items[0]!.refs).toContain("signal:in-my-thread");
    expect(google.calls.map((call) => call.url.split("?")[0])).toEqual([
      `${GMAIL}/profile`,
      `${GMAIL}/messages`,
      `${GMAIL}/messages`,
      `${GMAIL}/messages/m1`,
      `${CALENDAR}/calendars/primary/events`,
    ]);
    const calendar = new URL(google.calls.at(-1)!.url);
    expect(calendar.searchParams.get("maxResults")).toBe("25");
    expect(calendar.searchParams.get("singleEvents")).toBe("true");
    expect(calendar.searchParams.get("orderBy")).toBe("startTime");
    const min = Date.parse(calendar.searchParams.get("timeMin")!);
    const max = Date.parse(calendar.searchParams.get("timeMax")!);
    expect(max - min).toBe(7 * 86_400_000);
    expect(calendar.searchParams.get("timeMin")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
  });

  it("swallows the profile, the sent list and the calendar, but never the inbox", async () => {
    const partial = fakeGoogle({
      [PROFILE]: () => new Response("nope", { status: 500 }),
      [SENT]: () => new Response("nope", { status: 500 }),
      [INBOX]: () => json({ messages: [{ id: "m1" }] }),
      [meta("m1")]: () => json(human),
      [EVENTS]: () => new Response("nope", { status: 500 }),
    });
    const items = await new GoogleAdapter().fetch(cx(partial.fetch));
    expect(items.map((i) => i.id)).toEqual(["c:m1"]);
    // No profile and no sent threads: the same mail reads as bulk.
    expect(items[0]!.kind).toBe("mail_bulk");

    const dead = fakeGoogle({ [PROFILE]: () => json({}), [SENT]: () => json({}), [INBOX]: () => new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401, statusText: "Unauthorized" }) });
    await expect(new GoogleAdapter().fetch(cx(dead.fetch))).rejects.toThrow("google 401 Unauthorized: Invalid Credentials");

    const html = `<html>${"x".repeat(400)}</html>`;
    const broken = fakeGoogle({ [PROFILE]: () => json({}), [SENT]: () => json({}), [INBOX]: () => new Response(html, { status: 500 }) });
    await expect(new GoogleAdapter().fetch(cx(broken.fetch))).rejects.toThrow(`google 500: ${[...html].slice(0, 200).join("")}`);

    const down = cx(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(new GoogleAdapter().fetch(down)).rejects.toThrow("google request failed: ECONNRESET");
  });

  it("drops one message whose metadata fetch fails and keeps the rest", async () => {
    const google = fakeGoogle({
      [PROFILE]: () => json({ emailAddress: "me@example.com" }),
      [SENT]: () => json({}),
      [INBOX]: () => json({ messages: [{ id: "m1" }, { id: "m2" }] }),
      [meta("m1")]: () => new Response("<html>", { status: 200 }),
      [meta("m2")]: () => json(newsletter),
      [EVENTS]: () => json({ items: [] }),
    });
    expect((await new GoogleAdapter().fetch(cx(google.fetch))).map((i) => i.id)).toEqual(["c:m2"]);
  });
});

describe("performing", () => {
  const item = toMailItem(cx(), human, "me@example.com", new Set())!;

  it("archives and marks read by removing a label", async () => {
    const google = fakeGoogle({ [modify("m1")]: () => json({}) });
    const c = cx(google.fetch);
    expect(await new GoogleAdapter().perform(c, { action: "archive", item, input: null })).toBe("Archived");
    expect(google.calls[0]!.method).toBe("POST");
    expect(google.calls[0]!.body).toBe(JSON.stringify({ removeLabelIds: ["INBOX"] }));
    expect(await new GoogleAdapter().perform(c, { action: "mark_read", item, input: null })).toBe("Marked read");
    expect(google.calls[1]!.body).toBe(JSON.stringify({ removeLabelIds: ["UNREAD"] }));
  });

  it("replies into the thread with an RFC 822 message", async () => {
    const google = fakeGoogle({
      [replyMeta("m1")]: () =>
        json(headers([
          ["From", "Jordy <jordy@example.com>"],
          ["Subject", "Ping"],
          ["Message-ID", "<m1@mail>"],
        ])),
      [SEND]: () => json({ id: "sent" }),
    });
    expect(await new GoogleAdapter().perform(cx(google.fetch), { action: "reply", item, input: "On it." })).toBe("Replied to Jordy");
    const sent = JSON.parse(google.calls[1]!.body!) as { raw: string; threadId: string };
    expect(sent.threadId).toBe("t1");
    expect(sent.raw).not.toMatch(/[+/=]/); // base64url, unpadded
    expect(Buffer.from(sent.raw, "base64url").toString("utf8")).toBe(
      "To: Jordy <jordy@example.com>\r\nSubject: Re: Ping\r\nIn-Reply-To: <m1@mail>\r\nReferences: <m1@mail>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOn it.",
    );
  });

  it("does not stack a second Re:, whatever its case", async () => {
    const google = fakeGoogle({
      [replyMeta("m1")]: () => json(headers([["From", "a@b.c"], ["Subject", "re: Ping"], ["Message-ID", "<m1@mail>"]])),
      [SEND]: () => json({}),
    });
    expect(await new GoogleAdapter().perform(cx(google.fetch), { action: "reply", item, input: "x" })).toBe("Replied to a");
    const sent = JSON.parse(google.calls[1]!.body!) as { raw: string };
    expect(Buffer.from(sent.raw, "base64url").toString("utf8")).toContain("Subject: re: Ping\r\n");
  });

  it("refuses a reply with no body, an item that is not mail, and an action it does not have", async () => {
    const google = fakeGoogle();
    const c = cx(google.fetch);
    await expect(new GoogleAdapter().perform(c, { action: "reply", item, input: null })).rejects.toThrow("a reply needs a body");
    await expect(new GoogleAdapter().perform(c, { action: "archive", item: { ...item, refs: [], title: "Some row" }, input: null })).rejects.toThrow(
      "Some row is not a Gmail message",
    );
    await expect(new GoogleAdapter().perform(c, { action: "dance", item, input: null })).rejects.toThrow("google cannot dance");
    expect(google.calls).toHaveLength(0);
  });

  it("reads the message id out of the refs", () => {
    expect(messageId(item)).toBe("m1");
    expect(() => messageId({ ...item, refs: ["thread:t1"], title: "Some row" })).toThrow("Some row is not a Gmail message");
  });
});

describe("registration", () => {
  it("is the adapter for the mail.gmail provider, under the source google", () => {
    expect(forProvider("mail.gmail")).toBeInstanceOf(GoogleAdapter);
    expect(forProvider("mail.gmail")!.source).toBe("google");
    expect(forProvider("google")).toBeNull();
  });
});
