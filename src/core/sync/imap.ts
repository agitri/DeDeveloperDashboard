/**
 * Mail over IMAP, read-only. Port of `sync/imap.rs`.
 *
 * The path that needs no OAuth client, no cloud project and no administrator:
 * the credential is an app password the user mints themselves. One adapter
 * covers Gmail, Fastmail, Proton bridge and any company server.
 *
 * Read-only on purpose. `perform` keeps the port's default refusal, so archive
 * and reply are *absent* rather than offered and broken.
 *
 * Three layers, kept apart so the interesting two are testable without a
 * server: `toItem` (pure mapping over raw RFC 5322 bytes), `ImapSession` (the
 * socket seam), and `ImapAdapter` (config, then mapping, then escalation).
 */
import { ImapFlow } from "imapflow";
import PostalMime, { type Email } from "postal-mime";
import { route } from "../ai/router";
import { DddError } from "../error";
import type { Item } from "../models";
import { EnvRoot } from "../paths";
import { settingsLoad, withDefaultRouting } from "../settings";
import {
  configOf,
  itemId,
  refuse,
  requireConfig,
  type ActionRequest,
  type FetchContext,
  type SecretStore,
  type SourceAdapter,
} from "./adapter";
import { BAND, BUDGET, completionFor, parseAnswer } from "./classify";
import { rfc3339 } from "./ics";
import { classify, kindFor } from "./signal";

/** Newest-N messages fetched from the folder, unless the connection says
 *  otherwise. A dashboard is a view of what is recent, not a mail archive. */
const DEFAULT_LIMIT = 200;
/** Refused above this, so a typo in the config cannot ask for a million. */
const MAX_LIMIT = 1000;

/** How much of a body we keep as a preview. */
export const BODY_PREVIEW_BYTES = 2048;

/** Headers the rule scorer looks at. Fetched explicitly so the server sends
 *  what we need and nothing else. */
export const WANTED_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  "Message-ID",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
  "X-Auto-Response-Suppress",
] as const;

/** What the fetch layer hands the mapper for one message. */
export interface RawMessage {
  /** The raw RFC 5322 bytes: headers, and as much body as was fetched. */
  raw: Buffer;
  /** `\Seen` was set on the server. */
  seen: boolean;
  /** Server-side UID, and the generation it belongs to. */
  uid: number;
  uidValidity: number;
}

/** The address the account owns, used to tell "written to me" from "cc'd on a
 *  thread" — the strongest signal the rule scorer has. */
export interface Mailbox {
  address: string;
}

// --- mapping (no socket, no clock beyond `now`) ---------------------------------

/**
 * One message becomes one `Item`, or nothing if it cannot be parsed at all.
 *
 * Never throws: one unparseable message in a mailbox of two hundred must cost
 * that message, not the sync.
 */
export async function toItem(
  raw: RawMessage,
  mailbox: Mailbox,
  connectionId: string,
  environmentId: string,
): Promise<Item | null> {
  let parsed: Email;
  try {
    parsed = await PostalMime.parse(raw.raw);
  } catch {
    return null;
  }

  const subject = parsed.subject ?? "";
  const from = addressOf(parsed, "from");
  const to = addressOf(parsed, "to");
  const cc = addressOf(parsed, "cc");

  // Header *names* are what the scorer reasons about, lowercased because that
  // is the shape it expects. postal-mime already lowercases `key`; the explicit
  // call mirrors the Rust and costs nothing.
  const headers = parsed.headers.map((h) => h.key.toLowerCase());

  const addressedDirectly = to.toLowerCase().includes(mailbox.address.toLowerCase());

  const verdict = classify({
    from,
    subject,
    headers,
    addressedDirectly,
    // IMAP alone cannot tell us we replied before: that needs the Sent folder,
    // which this read-only first cut does not open.
    repliedBefore: false,
  });

  const body = preview(parsed);

  const refs = [
    `from:${from}`,
    `uid:${raw.uidValidity}:${raw.uid}`,
    "verdict:rules",
    // The score, so escalation can ask "was this in the band?" without
    // recomputing a verdict that might drift from the one recorded.
    `score:${verdict.score}`,
  ];
  if (to !== "") refs.push(`to:${to}`);
  if (cc !== "") refs.push(`cc:${cc}`);
  const messageId = messageIdOf(parsed);
  if (messageId !== null) refs.push(`messageid:${messageId}`);
  for (const reason of verdict.reasons) refs.push(`reason:${reason}`);

  return {
    // Message-ID is globally unique and survives a UIDVALIDITY change, which
    // reassigns every UID on the server.
    id: itemId(connectionId, stableKey(parsed, raw)),
    environmentId,
    connectionId,
    source: "mail.imap",
    kind: kindFor(verdict),
    project: null,
    title: subject === "" ? "(no subject)" : subject,
    body: body === "" ? null : body,
    url: null,
    refs,
    actions: [],
    updatedAt: dateOf(parsed),
    unread: !raw.seen,
  };
}

/** mail_parser's `message_id()` hands back the id without its angle brackets;
 *  postal-mime keeps the raw header value, so they come off here. */
function messageIdOf(parsed: Email): string | null {
  const raw = parsed.messageId;
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/^</, "").replace(/>$/, "");
  return trimmed === "" ? null : trimmed;
}

export function stableKey(parsed: Email, raw: RawMessage): string {
  return messageIdOf(parsed) ?? `uid:${raw.uidValidity}:${raw.uid}`;
}

/** Every address on the header, joined — "am I in the To line" is a question
 *  about all of them. Empty when the header is absent. */
function addressOf(parsed: Email, header: "from" | "to" | "cc"): string {
  const list = header === "from" ? (parsed.from === undefined ? [] : [parsed.from]) : (parsed[header] ?? []);
  return list
    .map((a) => (a as { address?: string }).address)
    .filter((a): a is string => a !== undefined && a !== "")
    .join(", ");
}

function dateOf(parsed: Email): string {
  const raw = parsed.date;
  if (raw !== undefined) {
    const date = new Date(raw);
    // The Rust keeps the header's own offset; chrono-style rfc3339 here is the
    // whole-second `Z` form every other adapter writes.
    if (!Number.isNaN(date.getTime())) return rfc3339(date);
  }
  return rfc3339(new Date());
}

/**
 * A plain-text preview, capped.
 *
 * `text/plain` is preferred; an HTML-only message is stripped rather than
 * dropped, and the result is text — nothing downstream ever renders a mail body
 * as markup.
 */
function preview(parsed: Email): string {
  const source = parsed.text ?? parsed.html ?? "";
  const cleaned = collapse(stripTags(source)).trim();
  if (Buffer.byteLength(cleaned, "utf8") <= BODY_PREVIEW_BYTES) return cleaned;
  // Cut on a char boundary, as the Rust's `is_char_boundary` loop does.
  const bytes = Buffer.from(cleaned, "utf8");
  let end = BODY_PREVIEW_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

/**
 * Tags out, entities for the handful that matter.
 *
 * Deliberately not an HTML parser: the output is a preview line, and the only
 * hard requirement is that no markup survives into it.
 */
export function stripTags(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

/** One space between words, whatever kind of space it started as. JS `\s`
 *  covers U+00A0 too, which the Rust splits on explicitly. */
export function collapse(text: string): string {
  return text
    .split(/[\s ]+/)
    .filter((s) => s !== "")
    .join(" ");
}

// --- the socket seam -----------------------------------------------------------

export interface FetchSpec {
  /** Header names for `BODY.PEEK[HEADER.FIELDS (...)]`. */
  headers: readonly string[];
  /** Bytes of `BODY.PEEK[TEXT]<0.N>`. */
  textBytes: number;
}

export interface FetchedMessage {
  uid: number;
  flags: Set<string>;
  headerBytes: Buffer;
  textBytes: Buffer;
}

/** Everything the adapter needs from a live IMAP session, and nothing more. */
export interface ImapSession {
  select(folder: string): Promise<{ exists: number; uidValidity: number }>;
  fetchRange(range: string, spec: FetchSpec): AsyncIterable<FetchedMessage>;
  logout(): Promise<void>;
}

export interface ImapConnectOptions {
  host: string;
  port: number;
  username: string;
  password: string;
}

const EMPTY = Buffer.alloc(0);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What rustls' `ServerName::try_from` accepts: an IP literal or a DNS name. */
export function isValidHostname(host: string): boolean {
  if (host === "" || host.length > 253) return false;
  // An IPv4/IPv6 literal, loosely — the connect below rejects a malformed one.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^[0-9a-fA-F:]+$/.test(host)) return true;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.?$/.test(host);
}

/**
 * Connect, authenticate, and hand back a session.
 *
 * Implicit TLS on connect. STARTTLS on 143 is not supported: it is a downgrade
 * path, every provider worth using offers 993, and supporting both doubles the
 * failure modes for no benefit.
 *
 * NOT covered by tests — there is no IMAP server in the suite, exactly as the
 * Rust says of `fetch_messages`. Everything above and below this function is.
 */
export async function connectImap(opts: ImapConnectOptions): Promise<ImapSession> {
  if (!isValidHostname(opts.host)) {
    throw DddError.config(`${opts.host} is not a valid hostname`);
  }

  const client = new ImapFlow({
    host: opts.host,
    port: opts.port,
    secure: true,
    tls: { servername: opts.host },
    auth: { user: opts.username, pass: opts.password },
    logger: false,
    disableAutoIdle: true,
  });

  try {
    // imapflow does TCP, TLS and LOGIN in one call; the Rust's three separate
    // failures are told apart by the flags imapflow stamps on the error.
    await client.connect();
  } catch (e) {
    const err = e as { authenticationFailed?: boolean; tlsFailed?: boolean };
    const message = errorText(e);
    client.close();
    if (err.authenticationFailed === true) {
      throw DddError.config(
        `${opts.host} rejected the login (${message}). Gmail and most providers need an app password with 2-step verification on, not your account password.`,
      );
    }
    if (err.tlsFailed === true) throw DddError.config(`TLS to ${opts.host} failed: ${message}`);
    throw DddError.config(`could not reach ${opts.host}:${opts.port}: ${message}`);
  }

  return {
    async select(folder: string) {
      try {
        const mailbox = await client.mailboxOpen(folder);
        return { exists: mailbox.exists, uidValidity: Number(mailbox.uidValidity) };
      } catch (e) {
        throw DddError.config(`could not open ${JSON.stringify(folder)}: ${errorText(e)}`);
      }
    },

    fetchRange(range: string, spec: FetchSpec): AsyncIterable<FetchedMessage> {
      async function* iterate(): AsyncGenerator<FetchedMessage> {
        try {
          // `headers: [...]` compiles to BODY.PEEK[HEADER.FIELDS (...)] and
          // `bodyParts: [{key, start, maxLength}]` to BODY.PEEK[TEXT]<0.2048>.
          // PEEK, never BODY: a dashboard that marks your mail read merely by
          // looking at it is one you uninstall.
          for await (const message of client.fetch(range, {
            uid: true,
            flags: true,
            internalDate: true,
            headers: [...spec.headers],
            bodyParts: [{ key: "TEXT", start: 0, maxLength: spec.textBytes }],
          })) {
            yield {
              uid: message.uid,
              flags: message.flags ?? new Set<string>(),
              headerBytes: message.headers ?? EMPTY,
              // imapflow lowercases the part key and strips the `<0>` suffix.
              textBytes: message.bodyParts?.get("text") ?? EMPTY,
            };
          }
        } catch (e) {
          // The Rust skips a single unreadable message and only labels the
          // FETCH command itself; imapflow surfaces both as one throw.
          throw DddError.config(`fetch failed: ${errorText(e)}`);
        }
      }
      return iterate();
    },

    async logout() {
      await client.logout();
    },
  };
}

/** Pull the newest `limit` messages from `folder`. */
export async function fetchMessages(session: ImapSession, folder: string, limit: number): Promise<RawMessage[]> {
  const { exists: total, uidValidity } = await session.select(folder);
  const out: RawMessage[] = [];
  try {
    if (total > 0) {
      // Newest N by sequence number. `1:*` on a large mailbox would drag the
      // whole thing across the wire.
      const first = Math.max(1, total - (limit - 1));
      const range = `${first}:${total}`;
      for await (const fetched of session.fetchRange(range, {
        headers: WANTED_HEADERS,
        textBytes: BODY_PREVIEW_BYTES,
      })) {
        const parts: Buffer[] = [];
        if (fetched.headerBytes.length > 0) parts.push(fetched.headerBytes);
        if (fetched.textBytes.length > 0) parts.push(Buffer.from("\r\n", "ascii"), fetched.textBytes);
        const raw = Buffer.concat(parts);
        if (raw.length === 0) continue;
        out.push({ raw, seen: fetched.flags.has("\\Seen"), uid: fetched.uid, uidValidity });
      }
    }
  } finally {
    // Politeness, and it frees the server's session slot. In a `finally` rather
    // than after the loop as the Rust has it: dropping a Rust session closes
    // the socket, a live ImapFlow would leak it.
    await session.logout().catch(() => undefined);
  }
  return out;
}

// --- the adapter ---------------------------------------------------------------

/** Rust's `parse::<u16>()`/`parse::<usize>()`: digits only, or nothing. */
function intOr(value: string | null, fallback: number, max: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n <= max ? n : fallback;
}

export class ImapAdapter implements SourceAdapter {
  readonly source = "mail.imap";

  /** The socket is a seam so the adapter is testable; production uses the real
   *  one by default. */
  constructor(private readonly connect: (opts: ImapConnectOptions) => Promise<ImapSession> = connectImap) {}

  async fetch(cx: FetchContext): Promise<Item[]> {
    const host = requireConfig(cx, "host");
    const username = requireConfig(cx, "username");
    const port = intOr(configOf(cx, "port"), 993, 65535);
    const folder = configOf(cx, "folder") ?? "INBOX";
    const limit = Math.min(Math.max(intOr(configOf(cx, "limit"), DEFAULT_LIMIT, Number.MAX_SAFE_INTEGER), 1), MAX_LIMIT);

    // The app password. Same shape as every other credential: read from the
    // keychain at fetch time and never handed anywhere else.
    const password = cx.token;
    if (password === "") {
      throw DddError.config(`${cx.connection.label} has no app password set`);
    }

    const session = await this.connect({ host, port, username, password });
    const messages = await fetchMessages(session, folder, limit);

    const items: Item[] = [];
    for (const message of messages) {
      const item = await toItem(message, { address: username }, cx.connection.id, cx.environmentId);
      if (item !== null) items.push(item);
    }

    // Ask the local model about the handful the rules could not settle.
    // Deliberately after mapping and deliberately fallible.
    await refineWithModel(cx, items);
    return items;
  }

  /** The port's default refusal: read-only means absent, not broken. */
  async perform(_cx: FetchContext, request: ActionRequest): Promise<string> {
    return refuse(this.source, request.action);
  }
}

/** A store with nothing in it, for a host that passed no keychain. Local
 *  routing needs no secret; a cloud route fails at `complete` and the rule
 *  verdict stands, which is the same outcome as every other failure here. */
const NO_SECRETS: SecretStore = { get: () => null, set: () => undefined };

/**
 * Let a local model settle the ambiguous band, if the user asked for it.
 *
 * Every early return is a supported outcome, not an error path: the rule
 * verdicts already in `items` are what ships when any of this does not work.
 */
export async function refineWithModel(cx: FetchContext, items: Item[]): Promise<void> {
  let root: EnvRoot;
  try {
    root = EnvRoot.open(cx.environmentId);
  } catch {
    return;
  }

  let settings;
  try {
    // `settingsLoad` already fills routing in; the explicit call mirrors the
    // Rust, where reading the file and defaulting are two steps.
    settings = withDefaultRouting(settingsLoad(root));
  } catch {
    return;
  }
  if (!settings.ai.classifyMailLocally) return;

  let routed;
  try {
    routed = route(root, settings, "mail.classify", { fetch: cx.fetch, secrets: cx.secrets ?? NO_SECRETS });
  } catch {
    return;
  }

  let escalated = 0;
  for (const item of items) {
    if (escalated >= BUDGET) break;
    // The verdict is reconstructed from what the mapping recorded rather than
    // recomputed, so the model sees exactly the decision the rules made.
    const scoreRef = item.refs.find((r) => r.startsWith("score:"));
    if (scoreRef === undefined) continue;
    const raw = scoreRef.slice("score:".length);
    if (!/^-?\d+$/.test(raw)) continue;
    const score = Number(raw);
    if (Math.abs(score) >= BAND) continue;
    escalated += 1;

    const fromRef = item.refs.find((r) => r.startsWith("from:"));
    const completion = completionFor(
      {
        from: fromRef === undefined ? "" : fromRef.slice("from:".length),
        subject: item.title,
        bodyExcerpt: item.body ?? "",
      },
      routed.model,
    );

    let draft;
    try {
      draft = await routed.provider.complete(completion);
    } catch {
      continue;
    }
    const isPerson = parseAnswer(draft.text);
    if (isPerson === null) continue;

    item.kind = isPerson ? "mail" : "mail_bulk";
    item.refs = item.refs.filter((r) => r !== "verdict:rules");
    item.refs.push("verdict:model");
    item.refs.push(isPerson ? "reason:model:person" : "reason:model:automated");
  }
}
