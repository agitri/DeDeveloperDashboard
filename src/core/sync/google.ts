/**
 * Gmail and Google Calendar (§5.5), behind one connection. Port of
 * `sync/google.rs`.
 *
 * One consent, one token, two feeds: mail and calendar share a Google account,
 * so making them two connections would mean two OAuth dances for one login.
 * The adapter emits three kinds — `mail`, `mail_bulk` and `event` — and the
 * widgets filter. "Inbox (real mail only)" is `kind = mail`.
 *
 * Cost per sync: profile + inbox list + sent list + one metadata GET per
 * message (bounded concurrency) + calendar.
 */
import { DddError } from "../error";
import type { Item } from "../models";
import { itemId, refuse, statusLabel, type ActionRequest, type FetchContext, type SourceAdapter } from "./adapter";
import { rfc3339 } from "./ics";
import { classify, kindFor, type MailSignals } from "./signal";

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
export const CALENDAR = "https://www.googleapis.com/calendar/v3";

/** One page of inbox. Beyond this it stops being a board. */
const INBOX_PAGE = 40;
/** Concurrent metadata fetches. Enough to be quick, few enough to be polite. */
const FANOUT = 8;
const DAY_MS = 86_400_000;

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

/** `str::eq_ignore_ascii_case`: folds A–Z only. */
function eqIgnoreAsciiCase(a: string, b: string): boolean {
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  return fold(a) === fold(b);
}

/** The Rust spawns one `JoinSet` per `chunks(FANOUT)` and drains it before the
 *  next chunk, so at most FANOUT requests are ever outstanding. Same shape
 *  here; `Promise.all` additionally keeps the chunk's results in input order,
 *  where `join_next` yields them as they finish. */
async function fanOut<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(run))));
  }
  return out;
}

// --- plumbing ---------------------------------------------------------------

function net(e: unknown): DddError {
  return DddError.config(`google request failed: ${e instanceof Error ? e.message : String(e)}`);
}

async function check(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    // `chars().take(200)`: code points, not UTF-16 units.
    let detail = Array.from(text).slice(0, 200).join("");
    try {
      const m = str(at(JSON.parse(text), "error.message"));
      if (m !== null) detail = m;
    } catch {
      /* not JSON: the clipped body is the detail */
    }
    throw DddError.config(`google ${statusLabel(response)}: ${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function get(cx: FetchContext, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await cx.fetch(url, { method: "GET", headers: { authorization: `Bearer ${cx.token}` } });
  } catch (e) {
    throw net(e);
  }
  return check(response);
}

async function post(cx: FetchContext, url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await cx.fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${cx.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw net(e);
  }
  return check(response);
}

async function profile(cx: FetchContext): Promise<string> {
  return (str(at(await get(cx, `${GMAIL}/profile`), "emailAddress")) ?? "").toLowerCase();
}

/** Thread ids you have written into. One call, and it is the strongest signal
 *  the filter has — a thread you answered is yours regardless of who sends the
 *  follow-ups. (The Rust keeps a Vec and scans it; a Set is the same answer.) */
async function sentThreads(cx: FetchContext): Promise<Set<string>> {
  const url = `${GMAIL}/messages?q=${encodeURIComponent("in:sent newer_than:30d")}&maxResults=100`;
  const list = at(await get(cx, url), "messages");
  const threads = new Set<string>();
  if (Array.isArray(list)) {
    for (const m of list) {
      const t = str(at(m, "threadId"));
      if (t !== null) threads.add(t);
    }
  }
  return threads;
}

async function mail(cx: FetchContext, me: string, replied: Set<string>): Promise<Item[]> {
  // None of `in:inbox newer_than:14d` contains a character where
  // `encodeURIComponent` and `urlencoding::encode` disagree.
  const url = `${GMAIL}/messages?q=${encodeURIComponent("in:inbox newer_than:14d")}&maxResults=${INBOX_PAGE}`;
  const listed = at(await get(cx, url), "messages");
  const ids: string[] = [];
  if (Array.isArray(listed)) {
    for (const m of listed) {
      const id = str(at(m, "id"));
      if (id !== null) ids.push(id);
    }
  }

  // Gmail has no bulk metadata endpoint short of multipart batching, so this
  // fans out — bounded, because a burst of 40 is how you get rate limited.
  const fetched = await fanOut(ids, FANOUT, async (id) => {
    const metadataUrl =
      `${GMAIL}/messages/${id}?format=metadata` +
      `&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject` +
      `&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Id` +
      `&metadataHeaders=Auto-Submitted&metadataHeaders=Precedence`;
    try {
      // The Rust does not status-check these: `.ok()?` only drops a transport
      // failure or a body that is not JSON.
      const response = await cx.fetch(metadataUrl, { method: "GET", headers: { authorization: `Bearer ${cx.token}` } });
      return await response.json();
    } catch {
      return null;
    }
  });

  const items: Item[] = [];
  for (const message of fetched) {
    if (message === null) continue;
    const item = toMailItem(cx, message, me, replied);
    if (item) items.push(item);
  }
  return items;
}

export function header(message: unknown, name: string): string | null {
  const list = at(message, "payload.headers");
  if (!Array.isArray(list)) return null;
  const found: unknown = list.find((h: unknown) => {
    const n = str(at(h, "name"));
    return n !== null && eqIgnoreAsciiCase(n, name);
  });
  return str(at(found, "value"));
}

export function toMailItem(cx: FetchContext, message: unknown, me: string, replied: Set<string>): Item | null {
  const id = str(at(message, "id"));
  if (id === null) return null;
  const thread = str(at(message, "threadId")) ?? id;
  const from = header(message, "From") ?? "";
  const subject = header(message, "Subject") ?? "(no subject)";
  const to = (header(message, "To") ?? "").toLowerCase();
  const snippet = str(at(message, "snippet")) ?? "";

  const rawLabels = at(message, "labelIds");
  const labels: string[] = Array.isArray(rawLabels) ? rawLabels.filter((l): l is string => typeof l === "string") : [];

  // Which of the headers the filter cares about are actually present.
  const present = ["List-Unsubscribe", "List-Id", "Auto-Submitted", "Precedence"]
    .filter((name) => header(message, name) !== null)
    .map((name) => name.toLowerCase());

  const signals: MailSignals = {
    from,
    subject,
    headers: present,
    addressedDirectly: me !== "" && to.includes(me),
    repliedBefore: replied.has(thread),
  };
  const verdict = classify(signals);

  const stamp = str(at(message, "internalDate"));
  // `parse::<i64>()` then `from_timestamp_millis`.
  const ms = stamp !== null && /^[+-]?\d+$/.test(stamp) ? Number(stamp) : Number.NaN;
  const parsed = new Date(ms);
  const internal = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  return {
    id: itemId(cx.connection.id, id),
    environmentId: cx.environmentId,
    connectionId: cx.connection.id,
    source: "google",
    // The verdict *is* the kind, so "real mail only" is a filter (§5.5).
    kind: kindFor(verdict),
    project: null,
    title: `${senderName(from)} — ${subject}`,
    body: snippet,
    url: `https://mail.google.com/mail/u/0/#inbox/${id}`,
    // Why it was classified this way, so a wrong call is inspectable rather
    // than mysterious.
    refs: [`gmail:${id}`, `thread:${thread}`, ...verdict.reasons],
    actions: [
      { id: "reply", label: "Reply", outbound: true },
      { id: "archive", label: "Archive", outbound: true },
      { id: "mark_read", label: "Mark read", outbound: true },
      { id: "open", label: "Open in Gmail", outbound: false },
    ],
    // chrono's `to_rfc3339()` writes `+00:00`; the port uses the whole-second
    // `Z` form every other adapter here uses (phase 5 convention).
    updatedAt: rfc3339(internal),
    unread: labels.includes("UNREAD"),
  };
}

/** `Jordy <jordy@example.com>` → `Jordy`. A board is easier to scan by person
 *  than by address. */
export function senderName(from: string): string {
  const trimmed = from.trim();
  const angle = trimmed.indexOf("<");
  if (angle >= 0) {
    const name = trimmed.slice(0, angle);
    // `split_once('<')` with the non-empty guard; `trim_matches('"')` strips
    // quotes at both ends and does not re-trim whitespace afterwards.
    if (name.trim() !== "") return name.trim().replace(/^"+|"+$/g, "");
  }
  return trimmed.split("@")[0] ?? trimmed;
}

export function toEventItem(cx: FetchContext, event: unknown): Item | null {
  const id = str(at(event, "id"));
  if (id === null) return null;
  const summary = str(at(event, "summary")) ?? "(no title)";
  // All-day events carry `date`; timed ones carry `dateTime`.
  const start = str(at(event, "start.dateTime")) ?? str(at(event, "start.date"));
  if (start === null) return null;

  return {
    id: itemId(cx.connection.id, `event-${id}`),
    environmentId: cx.environmentId,
    connectionId: cx.connection.id,
    source: "google",
    kind: "event",
    project: null,
    title: summary,
    body: str(at(event, "location")),
    url: str(at(event, "htmlLink")),
    refs: [`gcal:${id}`],
    actions: [{ id: "open", label: "Open", outbound: false }],
    // Calendar sorts forward, not backward: the next thing is the interesting
    // thing. The raw start string, exactly as Google wrote it.
    updatedAt: start,
    unread: false,
  };
}

async function events(cx: FetchContext): Promise<Item[]> {
  const now = new Date();
  const url =
    `${CALENDAR}/calendars/primary/events?singleEvents=true&orderBy=startTime` +
    `&timeMin=${encodeURIComponent(rfc3339(now))}&timeMax=${encodeURIComponent(rfc3339(new Date(now.getTime() + 7 * DAY_MS)))}` +
    `&maxResults=25`;

  const list = at(await get(cx, url), "items");
  if (!Array.isArray(list)) return [];
  const items: Item[] = [];
  for (const event of list) {
    const item = toEventItem(cx, event);
    if (item) items.push(item);
  }
  return items;
}

async function modify(cx: FetchContext, id: string, body: unknown): Promise<unknown> {
  return post(cx, `${GMAIL}/messages/${id}/modify`, body);
}

/** Send a reply into the same thread.
 *
 *  This is the endpoint the AI quick-reply lands on — and it is reachable only
 *  through `item_action`, which a human has to press. The draft is a proposal
 *  until then. */
async function reply(cx: FetchContext, item: Item, id: string, body: string): Promise<string> {
  const message = await get(
    cx,
    `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`,
  );

  const to = header(message, "From") ?? "";
  const original = header(message, "Subject") ?? "";
  const inReplyTo = header(message, "Message-ID") ?? "";
  const threadRef = item.refs.find((r) => r.startsWith("thread:"));
  const thread = threadRef === undefined ? "" : threadRef.slice("thread:".length);

  const subject = original.toLowerCase().startsWith("re:") ? original : `Re: ${original}`;

  // In-Reply-To and References are what keep the reply inside the thread in
  // every client, not just Gmail's.
  const raw = `To: ${to}\r\nSubject: ${subject}\r\nIn-Reply-To: ${inReplyTo}\r\nReferences: ${inReplyTo}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  // `URL_SAFE_NO_PAD` — Node's base64url is unpadded.
  const encoded = Buffer.from(raw, "utf8").toString("base64url");

  await post(cx, `${GMAIL}/messages/send`, { raw: encoded, threadId: thread });
  return `Replied to ${senderName(to)}`;
}

export function messageId(item: Item): string {
  const ref = item.refs.find((r) => r.startsWith("gmail:"));
  if (ref !== undefined) return ref.slice("gmail:".length);
  throw DddError.config(`${item.title} is not a Gmail message`);
}

export class GoogleAdapter implements SourceAdapter {
  readonly source = "google";

  async fetch(cx: FetchContext): Promise<Item[]> {
    const me = await profile(cx).catch(() => "");
    const replied = await sentThreads(cx).catch(() => new Set<string>());

    const items = await mail(cx, me, replied);
    // A calendar outage must not take the inbox down with it.
    items.push(...(await events(cx).catch(() => [] as Item[])));
    return items;
  }

  async perform(cx: FetchContext, request: ActionRequest): Promise<string> {
    // The Rust resolves the id before it looks at the action.
    const id = messageId(request.item);
    switch (request.action) {
      case "archive":
        await modify(cx, id, { removeLabelIds: ["INBOX"] });
        return "Archived";
      case "mark_read":
        await modify(cx, id, { removeLabelIds: ["UNREAD"] });
        return "Marked read";
      case "reply": {
        if (request.input === null) throw DddError.config("a reply needs a body");
        return reply(cx, request.item, id, request.input);
      }
      default:
        return refuse("google", request.action);
    }
  }
}
