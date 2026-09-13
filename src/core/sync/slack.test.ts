import { describe, expect, it } from "vitest";
import type { Item } from "../models";
import { fetchContext } from "./adapter";
import { forProvider } from "./providers";
import { API, dedupAdjacent, firstLine, locate, SlackAdapter, toItem } from "./slack";

const cx = (fetch?: typeof globalThis.fetch) =>
  fetchContext({ environmentId: "e", connection: { id: "c", provider: "slack", label: "Work Slack" }, token: "tok", fetch });

const AUTH = `${API}/auth.test`;
const LIST = `${API}/conversations.list?types=im,mpim&limit=100&exclude_archived=true`;
const history = (channel: string) => `${API}/conversations.history?channel=${channel}&limit=3`;
/** `urlencoding::encode("<@") + me + ">"` — the `>` is deliberately raw. */
const SEARCH = `${API}/search.messages?query=%3C%40U1>&count=25&sort=timestamp`;
const POST = `${API}/chat.postMessage`;

type Call = { url: string; method: string; body: string | null; auth: string | null };

/** A fake Slack: answers by exact URL, records every call. */
function fakeSlack(handlers: Record<string, (body: string | null) => Response> = {}) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method: init?.method ?? "GET", body, auth: new Headers(init?.headers).get("authorization") });
    const handler = handlers[url];
    if (!handler) return new Response(JSON.stringify({ ok: false, error: "no_handler" }), { status: 200 });
    return handler(body);
  };
  return { fetch, calls };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const message = (ts: string, user: string, text: string) => ({ ts, user, text });

// --- ported from the Rust's own tests -------------------------------------------

const stub = (refs: string[], title = "t"): Item => ({
  id: "x",
  environmentId: "e",
  connectionId: "c",
  source: "slack",
  kind: "message",
  project: null,
  title,
  body: null,
  url: null,
  refs,
  actions: [],
  updatedAt: "now",
  unread: true,
});

describe("references", () => {
  it("splits the channel and timestamp reference", () => {
    expect(locate(stub(["slack:D123ABC:1723999999.000200"]))).toEqual(["D123ABC", "1723999999.000200"]);
  });

  it("refuses when there is no usable reference", () => {
    expect(() => locate(stub([], "Some row"))).toThrow("Some row has no Slack reference");
    // A `slack:` ref with no second colon is not a licence to look at the next.
    expect(() => locate(stub(["slack:D1", "slack:D2:1.0"], "Some row"))).toThrow("Some row has no Slack reference");
  });
});

describe("row text", () => {
  it("truncates long messages for the row", () => {
    const long = "x".repeat(400);
    expect([...firstLine(long)].length).toBeLessThanOrEqual(121);
    expect(firstLine(long).endsWith("…")).toBe(true);
    expect(firstLine("hello\nworld")).toBe("hello");
    expect(firstLine("  padded  ")).toBe("padded");
    expect(firstLine("")).toBe("");
    // Exactly 120 is not truncated.
    expect(firstLine("y".repeat(120))).toBe("y".repeat(120));
  });
});

describe("consecutive dedupe", () => {
  it("removes adjacent duplicates only, keeping the first of each run", () => {
    const of = (id: string) => ({ ...stub([]), id });
    expect(dedupAdjacent([of("a"), of("a"), of("b"), of("a")]).map((i) => i.id)).toEqual(["a", "b", "a"]);
    expect(dedupAdjacent([]).map((i) => i.id)).toEqual([]);
  });
});

describe("messages", () => {
  it("turns a Slack timestamp into a whole second and carries the reply action", () => {
    const item = toItem(cx(), { ts: "1723999999.000200", user: "U2", text: "ping", permalink: "https://slack.com/p/1" }, "D1", "dm")!;
    expect(item.id).toBe("c:D1-1723999999.000200");
    expect(item.source).toBe("slack");
    expect(item.kind).toBe("message");
    expect(item.project).toBeNull();
    expect(item.title).toBe("U2: ping");
    expect(item.body).toBe("dm");
    expect(item.url).toBe("https://slack.com/p/1");
    expect(item.refs).toEqual(["slack:D1:1723999999.000200"]);
    expect(item.actions).toEqual([
      { id: "reply", label: "Reply", outbound: true },
      { id: "open", label: "Open in Slack", outbound: false },
    ]);
    expect(item.updatedAt).toBe("2024-08-18T16:53:19Z");
    expect(item.unread).toBe(true);
  });

  it("prefers username, falls back to user, then to someone", () => {
    expect(toItem(cx(), { ts: "1.0", username: "bot", user: "U2", text: "x" }, "D1", "dm")!.title).toBe("bot: x");
    expect(toItem(cx(), { ts: "1.0", user: "U2", text: "x" }, "D1", "dm")!.title).toBe("U2: x");
    expect(toItem(cx(), { ts: "1.0", text: "x" }, "D1", "dm")!.title).toBe("someone: x");
    // `username` present but not a string never falls through to `user`.
    expect(toItem(cx(), { ts: "1.0", username: null, user: "U2", text: "x" }, "D1", "dm")!.title).toBe("someone: x");
  });

  it("is a mention when the flavour says so, and has no url without a permalink", () => {
    const item = toItem(cx(), { ts: "1.0", user: "U2", text: "x" }, "C9", "mention")!;
    expect(item.kind).toBe("mention");
    expect(item.body).toBe("mention");
    expect(item.url).toBeNull();
  });

  it("falls back to now when the timestamp is not a number, and drops a message with no ts", () => {
    const item = toItem(cx(), { ts: "not-a-number", user: "U2", text: "x" }, "D1", "dm")!;
    expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(toItem(cx(), { user: "U2", text: "x" }, "D1", "dm")).toBeNull();
  });
});

describe("fetching", () => {
  const workspace = () =>
    fakeSlack({
      [AUTH]: () => json({ ok: true, user_id: "U1" }),
      [LIST]: () => json({ ok: true, channels: [{ id: "D1" }, { id: "D2" }] }),
      [history("D1")]: () => json({ ok: true, messages: [message("1.0", "U2", "ping"), message("2.0", "U1", "mine")] }),
      [history("D2")]: () => json({ ok: true, messages: [message("3.0", "U3", "hoi")] }),
      [SEARCH]: () => json({ ok: true, messages: { matches: [{ ts: "4.0", user: "U4", text: "hey <@U1>", channel: { id: "C9" } }] } }),
    });

  it("assembles DMs and mentions, skips my own messages, and bearers the token", async () => {
    const slack = workspace();
    const items = await new SlackAdapter().fetch(cx(slack.fetch));
    expect(items.map((i) => i.id)).toEqual(["c:D1-1.0", "c:D2-3.0", "c:C9-4.0"]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message", "mention"]);
    expect(slack.calls.map((call) => call.url)).toEqual([AUTH, LIST, history("D1"), history("D2"), SEARCH]);
    expect(slack.calls.every((call) => call.auth === "Bearer tok")).toBe(true);
    expect(slack.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("looks at twelve conversations and no more", async () => {
    const channels = Array.from({ length: 15 }, (_, i) => ({ id: `D${i}` }));
    const handlers: Record<string, (body: string | null) => Response> = {
      [AUTH]: () => json({ ok: true, user_id: "U1" }),
      [LIST]: () => json({ ok: true, channels }),
      [SEARCH]: () => json({ ok: true, messages: { matches: [] } }),
    };
    for (const c of channels) handlers[history(c.id)] = () => json({ ok: true, messages: [] });
    const slack = fakeSlack(handlers);
    await new SlackAdapter().fetch(cx(slack.fetch));
    expect(slack.calls.filter((call) => call.url.includes("conversations.history"))).toHaveLength(12);
  });

  it("keeps going when one conversation fails", async () => {
    const slack = fakeSlack({
      [AUTH]: () => json({ ok: true, user_id: "U1" }),
      [LIST]: () => json({ ok: true, channels: [{ id: "D1" }, { id: "D2" }] }),
      [history("D1")]: () => json({ ok: false, error: "channel_not_found" }),
      [history("D2")]: () => json({ ok: true, messages: [message("3.0", "U3", "hoi")] }),
      [SEARCH]: () => json({ ok: true, messages: { matches: [] } }),
    });
    const items = await new SlackAdapter().fetch(cx(slack.fetch));
    expect(items.map((i) => i.id)).toEqual(["c:D2-3.0"]);
  });

  it("drops mentions entirely when auth.test fails, without asking for them", async () => {
    const slack = fakeSlack({
      [AUTH]: () => json({ ok: false, error: "invalid_auth" }),
      [LIST]: () => json({ ok: true, channels: [{ id: "D1" }] }),
      [history("D1")]: () => json({ ok: true, messages: [message("1.0", "U2", "ping")] }),
    });
    const items = await new SlackAdapter().fetch(cx(slack.fetch));
    expect(items.map((i) => i.id)).toEqual(["c:D1-1.0"]);
    expect(slack.calls.some((call) => call.url.includes("search.messages"))).toBe(false);
  });

  it("loses nothing but the mentions when search:read is not granted", async () => {
    const noSearch = fakeSlack({
      [AUTH]: () => json({ ok: true, user_id: "U1" }),
      [LIST]: () => json({ ok: true, channels: [{ id: "D1" }] }),
      [history("D1")]: () => json({ ok: true, messages: [message("1.0", "U2", "ping")] }),
      [SEARCH]: () => json({ ok: false, error: "missing_scope" }),
    });
    expect((await new SlackAdapter().fetch(cx(noSearch.fetch))).map((i) => i.id)).toEqual(["c:D1-1.0"]);
  });

  it("survives a conversations.list failure without losing the mentions", async () => {
    const noList = fakeSlack({
      [AUTH]: () => json({ ok: true, user_id: "U1" }),
      [SEARCH]: () => json({ ok: true, messages: { matches: [{ ts: "4.0", user: "U4", text: "hey <@U1>", channel: { id: "C9" } }] } }),
    });
    expect((await new SlackAdapter().fetch(cx(noList.fetch))).map((i) => i.id)).toEqual(["c:C9-4.0"]);
  });

  it("drops only an adjacent duplicate, the way Vec::dedup_by does", async () => {
    // The mention repeats the last DM (adjacent → dropped) and the first DM
    // (not adjacent → kept).
    const slack = fakeSlack({
      [AUTH]: () => json({ ok: true, user_id: "U1" }),
      [LIST]: () => json({ ok: true, channels: [{ id: "D1" }] }),
      [history("D1")]: () => json({ ok: true, messages: [message("1.0", "U2", "a"), message("2.0", "U2", "b")] }),
      [SEARCH]: () =>
        json({
          ok: true,
          messages: {
            matches: [
              { ts: "2.0", user: "U2", text: "b", channel: { id: "D1" } },
              { ts: "1.0", user: "U2", text: "a", channel: { id: "D1" } },
            ],
          },
        }),
    });
    expect((await new SlackAdapter().fetch(cx(slack.fetch))).map((i) => i.id)).toEqual(["c:D1-1.0", "c:D1-2.0", "c:D1-1.0"]);
  });
});

describe("performing", () => {
  const item = toItem(cx(), { ts: "1723999999.000200", user: "U2", text: "ping" }, "D123ABC", "dm")!;

  it("replies in the thread", async () => {
    const slack = fakeSlack({ [POST]: () => json({ ok: true }) });
    expect(await new SlackAdapter().perform(cx(slack.fetch), { action: "reply", item, input: "on it" })).toBe("Replied in Slack");
    expect(slack.calls[0]!.method).toBe("POST");
    expect(slack.calls[0]!.auth).toBe("Bearer tok");
    expect(JSON.parse(slack.calls[0]!.body!)).toEqual({ channel: "D123ABC", thread_ts: "1723999999.000200", text: "on it" });
  });

  it("refuses a reply with no text, an item with no reference, and an action it does not have", async () => {
    const slack = fakeSlack();
    const c = cx(slack.fetch);
    await expect(new SlackAdapter().perform(c, { action: "reply", item, input: null })).rejects.toThrow("a reply needs text");
    await expect(new SlackAdapter().perform(c, { action: "reply", item: { ...item, refs: [], title: "Some row" }, input: "x" })).rejects.toThrow(
      "Some row has no Slack reference",
    );
    await expect(new SlackAdapter().perform(c, { action: "dance", item, input: null })).rejects.toThrow("slack cannot dance");
    expect(slack.calls).toHaveLength(0);
  });

  it("reads ok:false out of a 200 and names the error, or says rejected", async () => {
    const refused = fakeSlack({ [POST]: () => json({ ok: false, error: "not_in_channel" }) });
    await expect(new SlackAdapter().perform(cx(refused.fetch), { action: "reply", item, input: "x" })).rejects.toThrow("slack: not_in_channel");
    const silent = fakeSlack({ [POST]: () => json({ ok: false }) });
    await expect(new SlackAdapter().perform(cx(silent.fetch), { action: "reply", item, input: "x" })).rejects.toThrow("slack: rejected");
  });

  it("turns a transport failure into a message a human can act on", async () => {
    const down = cx(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(new SlackAdapter().perform(down, { action: "reply", item, input: "x" })).rejects.toThrow("slack request failed: ECONNRESET");
    // A non-JSON body is a transport-level failure too, exactly as `.json()` is in the Rust.
    const html = fakeSlack({ [POST]: () => new Response("<html>", { status: 200 }) });
    await expect(new SlackAdapter().perform(cx(html.fetch), { action: "reply", item, input: "x" })).rejects.toThrow("slack request failed:");
  });
});

describe("registration", () => {
  it("is the adapter for the slack provider", () => {
    expect(forProvider("slack")).toBeInstanceOf(SlackAdapter);
    expect(forProvider("slack")!.source).toBe("slack");
  });
});
