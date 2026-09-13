/**
 * Slack (§5.5) — signal, not the firehose. Port of `sync/slack.rs`.
 *
 * Scope is deliberately narrow: DMs and mentions, not channel history. A
 * dashboard that mirrors all of Slack has reproduced the problem it exists to
 * solve. Everything a person is *actually* waiting on you for shows up in one
 * of those two places.
 *
 * Unverified in the Rust too: written against the documented API with no
 * workspace to point it at.
 */
import { DddError } from "../error";
import type { Item } from "../models";
import { itemId, refuse, type ActionRequest, type FetchContext, type SourceAdapter } from "./adapter";
import { rfc3339 } from "./ics";

export const API = "https://slack.com/api";
/** Most recent direct conversations to look at. Older DMs are archaeology. */
const DM_CONVERSATIONS = 12;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function at(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const key of path.split(".")) {
    const o = obj(cur);
    if (!o) return undefined;
    cur = o[key];
  }
  return cur;
}

function net(e: unknown): DddError {
  return DddError.config(`slack request failed: ${e instanceof Error ? e.message : String(e)}`);
}

/** Slack answers 200 with `ok: false`, so the status code proves nothing. */
async function ok(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    // The Rust's `.json().await.map_err(net)` — a body that is not JSON is a
    // transport failure, not a rejection.
    body = await response.json();
  } catch (e) {
    throw net(e);
  }
  if (at(body, "ok") !== true) {
    throw DddError.config(`slack: ${str(at(body, "error")) ?? "rejected"}`);
  }
  return body;
}

async function get(cx: FetchContext, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await cx.fetch(`${API}/${path}`, { method: "GET", headers: { authorization: `Bearer ${cx.token}` } });
  } catch (e) {
    throw net(e);
  }
  return ok(response);
}

async function call(cx: FetchContext, method: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await cx.fetch(`${API}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cx.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw net(e);
  }
  return ok(response);
}

async function whoami(cx: FetchContext): Promise<string> {
  return str(at(await get(cx, "auth.test"), "user_id")) ?? "";
}

async function directMessages(cx: FetchContext, me: string): Promise<Item[]> {
  const conversations = await get(cx, "conversations.list?types=im,mpim&limit=100&exclude_archived=true");
  const listed = at(conversations, "channels");
  const channels: string[] = [];
  if (Array.isArray(listed)) {
    for (const c of listed) {
      const id = str(at(c, "id"));
      if (id === null) continue; // `filter_map` first, `take` after
      channels.push(id);
      if (channels.length === DM_CONVERSATIONS) break;
    }
  }

  const items: Item[] = [];
  for (const channel of channels) {
    let history: unknown;
    try {
      history = await get(cx, `conversations.history?channel=${channel}&limit=3`);
    } catch {
      continue; // one dead conversation is not a dead sync
    }
    const messages = at(history, "messages");
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      // Your own messages are not something waiting on you.
      if (str(at(message, "user")) === me) continue;
      const item = toItem(cx, message, channel, "dm");
      if (item) items.push(item);
    }
  }
  return items;
}

async function mentions(cx: FetchContext, me: string): Promise<Item[]> {
  if (me === "") return [];
  // The Rust encodes only `<@` and concatenates the raw id and `>`.
  const query = `${encodeURIComponent("<@")}${me}>`;
  const found = await get(cx, `search.messages?query=${query}&count=25&sort=timestamp`);

  const matches = at(found, "messages.matches");
  if (!Array.isArray(matches)) return [];
  const items: Item[] = [];
  for (const m of matches) {
    const channel = str(at(m, "channel.id"));
    if (channel === null) continue;
    const item = toItem(cx, m, channel, "mention");
    if (item) items.push(item);
  }
  return items;
}

export function toItem(cx: FetchContext, message: unknown, channel: string, flavour: string): Item | null {
  const ts = str(at(message, "ts"));
  if (ts === null) return null;
  const text = str(at(message, "text")) ?? "";
  // `get("username").or_else(|| get("user"))`: a present-but-non-string
  // `username` shadows `user` and falls through to "someone".
  const o = obj(message) ?? {};
  const user = str("username" in o ? o.username : o.user) ?? "someone";

  // Slack timestamps are `1723999999.000200` seconds-with-microseconds.
  const head = ts.split(".")[0] ?? "";
  // `parse::<i64>()` accepts a whole signed integer and nothing else.
  const seconds = /^[+-]?\d+$/.test(head) ? Number(head) : Number.NaN;
  const parsed = new Date(seconds * 1000);
  // Whole seconds, matching the parsed branch: `rfc3339` only strips an exact
  // `.000Z`, so a millisecond-precision `now()` would leak fractional seconds.
  const when = Number.isNaN(parsed.getTime()) ? new Date(Math.floor(Date.now() / 1000) * 1000) : parsed;

  return {
    id: itemId(cx.connection.id, `${channel}-${ts}`),
    environmentId: cx.environmentId,
    connectionId: cx.connection.id,
    source: "slack",
    kind: flavour === "dm" ? "message" : "mention",
    project: null,
    title: `${user}: ${firstLine(text)}`,
    body: flavour,
    url: str(at(message, "permalink")),
    refs: [`slack:${channel}:${ts}`],
    actions: [
      { id: "reply", label: "Reply", outbound: true },
      { id: "open", label: "Open in Slack", outbound: false },
    ],
    // chrono's `to_rfc3339()` writes `+00:00`; the port uses the whole-second
    // `Z` form every other adapter here uses (phase 5 convention).
    updatedAt: rfc3339(when),
    unread: true,
  };
}

export function firstLine(text: string): string {
  const line = (text.split("\n")[0] ?? "").trim();
  const chars = [...line]; // `chars().count()`, not UTF-16 units
  return chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : line;
}

/** `Vec::dedup_by`: removes only *consecutive* duplicates, keeping the first
 *  of each run. A set over the whole list would drop more than the Rust does. */
export function dedupAdjacent(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    if (out.length > 0 && out[out.length - 1]!.id === item.id) continue;
    out.push(item);
  }
  return out;
}

export function locate(item: Item): [string, string] {
  // `find_map(strip_prefix)` takes the first `slack:` ref; a malformed one is
  // not a licence to keep looking.
  const first = item.refs.find((r) => r.startsWith("slack:"));
  if (first !== undefined) {
    const rest = first.slice("slack:".length);
    const colon = rest.indexOf(":");
    if (colon >= 0) return [rest.slice(0, colon), rest.slice(colon + 1)];
  }
  throw DddError.config(`${item.title} has no Slack reference`);
}

export class SlackAdapter implements SourceAdapter {
  readonly source = "slack";

  async fetch(cx: FetchContext): Promise<Item[]> {
    const me = await whoami(cx).catch(() => "");
    const items = await directMessages(cx, me).catch(() => [] as Item[]);
    // search:read is not granted on every plan; mentions are a bonus, not a
    // reason for the whole sync to fail.
    items.push(...(await mentions(cx, me).catch(() => [] as Item[])));
    return dedupAdjacent(items);
  }

  async perform(cx: FetchContext, request: ActionRequest): Promise<string> {
    switch (request.action) {
      case "reply": {
        const [channel, ts] = locate(request.item);
        if (request.input === null) throw DddError.config("a reply needs text");
        await call(cx, "chat.postMessage", {
          channel,
          // Replying in-thread rather than to the channel is almost always
          // what was meant.
          thread_ts: ts,
          text: request.input,
        });
        return "Replied in Slack";
      }
      default:
        return refuse("slack", request.action);
    }
  }
}
