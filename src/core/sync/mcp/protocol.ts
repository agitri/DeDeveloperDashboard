/**
 * The shapes DDD actually reads. Port of `sync/mcp/protocol.rs`.
 *
 * Deliberately not a full MCP client. DDD is not an agent, so it uses the half
 * of the protocol the agents ignore — **resources**, which are addressable data
 * a person is meant to see — and leaves prompts and tool invocation alone.
 * Everything here is pure over JSON, so the whole protocol story is testable
 * without a server, which is the failure Jira and Slack demonstrate.
 *
 * The parsers stay tolerant even though the SDK has already validated what it
 * hands over: the tolerance is the ported behaviour, and it is the thing that
 * keeps one malformed entry from costing a page.
 */
import type { Implementation, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { isArray, isNumber, isPlainRecord, isString, optional, record, required } from "../../json";

/**
 * The version DDD speaks. The SDK sends its own latest in `initialize` and
 * negotiates from there; a server that answers with a different one is not
 * refused — the specification allows negotiation, and refusing would make DDD
 * the brittle end of every pairing.
 */
export const PROTOCOL_VERSION = "2025-06-18";

/**
 * How many `resources/list` pages one sync will follow.
 *
 * A cursor that never terminates is a server bug DDD must survive rather than
 * hang on, so the cap exists to end the loop, and the fact that it capped is
 * reported like GitHub's is.
 */
export const PAGE_CAP = 20;

/**
 * How many `resources/read` calls one sync may make.
 *
 * Listing is cheap and reading is not: a server with two thousand resources
 * must not cost two thousand round trips per scheduler tick. Everything past
 * the budget still becomes an item — with no body, which is a smaller loss than
 * a sync that takes a minute.
 */
export const READ_BUDGET = 40;

/** The largest body DDD will pull into an item. */
export const BODY_CAP = 64 * 1024;

/** What came back from `initialize`, reduced to what Settings shows. */
export interface ServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  /** Whether the server said it has resources at all. A server without them is
   *  a valid connection that yields nothing, and Settings says so plainly
   *  rather than looking broken. */
  hasResources: boolean;
  hasTools: boolean;
  subscribe: boolean;
  listChanged: boolean;
}

/**
 * The Rust read this out of the `initialize` result; the SDK performs the
 * handshake itself and exposes the same three things afterwards, so the
 * arguments are what `Client.getServerCapabilities()`, `getServerVersion()` and
 * `negotiatedVersion(client.transport)` return.
 */
export function parseInitialize(
  capabilities: ServerCapabilities | undefined,
  serverVersion: Implementation | undefined,
  protocolVersion: string,
): ServerInfo {
  return {
    name: serverVersion?.name ?? "unnamed server",
    version: serverVersion?.version ?? "",
    protocolVersion,
    // Presence, not truthiness: `"resources": {}` is a server that has them.
    hasResources: capabilities?.resources !== undefined,
    hasTools: capabilities?.tools !== undefined,
    subscribe: capabilities?.resources?.subscribe === true,
    listChanged: capabilities?.resources?.listChanged === true,
  };
}

/** One resource, as a server describes it in `resources/list`. */
export interface Resource {
  uri: string;
  name: string | null;
  /** The display name, when the server distinguishes it from `name`. */
  title: string | null;
  description: string | null;
  mimeType: string | null;
  size: number | null;
  annotations: Annotations | null;
}

export interface Annotations {
  /** `"user"`, `"assistant"`, or both. **The line this whole adapter draws.** */
  audience: string[] | null;
  priority: number | null;
  lastModified: string | null;
}

/**
 * Is this resource meant for a person?
 *
 * A resource annotated for the assistant alone is model context — it exists to
 * be fed into a prompt, not read. DDD syncs the human half and skips the model
 * half, which is one line of filtering and the product thesis in miniature.
 *
 * No annotation means yes: the specification makes `audience` optional, and
 * treating silence as "for models" would empty most boards.
 */
export function isForHumans(resource: Resource): boolean {
  const audience = resource.annotations?.audience ?? null;
  if (audience !== null && audience.length > 0) return audience.some((a) => a === "user");
  return true;
}

export interface Page {
  resources: Resource[];
  nextCursor: string | null;
}

export function parsePage(result: unknown): Page {
  const o = isPlainRecord(result) ? result : {};
  const raw = isArray(o.resources) ? o.resources : [];
  const cursor = isString(o.nextCursor) && o.nextCursor !== "" ? o.nextCursor : null;
  return {
    resources: raw
      // A malformed entry is skipped rather than failing the page: one bad
      // resource must not cost a whole sync.
      .map(toResource)
      .filter((r): r is Resource => r !== null && r.uri.trim() !== ""),
    nextCursor: cursor,
  };
}

/** `serde_json::from_value::<Resource>(..).ok()`: a wrong type anywhere in the
 *  entry means the entry is skipped, not that the sync fails. */
function toResource(raw: unknown): Resource | null {
  if (!isPlainRecord(raw)) return null;
  try {
    return {
      uri: required(raw, "uri", isString),
      name: optional(raw, "name", isString, null),
      title: optional(raw, "title", isString, null),
      description: optional(raw, "description", isString, null),
      mimeType: optional(raw, "mimeType", isString, null),
      size: optional(raw, "size", isNumber, null),
      annotations: toAnnotations(raw.annotations),
    };
  } catch {
    return null;
  }
}

function toAnnotations(raw: unknown): Annotations | null {
  if (raw === undefined || raw === null) return null;
  const o = record(raw, "annotations");
  return {
    audience: optional(o, "audience", isStringArray, null),
    priority: optional(o, "priority", isNumber, null),
    lastModified: optional(o, "lastModified", isString, null),
  };
}

const isStringArray = (v: unknown): v is string[] => isArray(v) && v.every(isString);

/**
 * The text of a `resources/read` reply, if it has any.
 *
 * Binary content (`blob`) yields `null`: the item still exists, and its MIME
 * type is in `refs`, but there is nothing a text view could show.
 */
export function parseContents(result: unknown): string | null {
  if (!isPlainRecord(result) || !isArray(result.contents)) return null;
  let text = "";
  for (const part of result.contents) {
    if (!isPlainRecord(part) || !isString(part.text)) continue;
    if (text !== "") text += "\n\n";
    text += part.text;
  }
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return truncate(trimmed, BODY_CAP);
}

/** Cut on a character boundary, and say so rather than ending mid-sentence in
 *  silence. Bytes, because the Rust's `String::len` is bytes. */
export function truncate(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  let end = Math.min(cap, buf.length);
  // Back off any UTF-8 continuation byte (10xxxxxx) so the cut lands between
  // characters — `is_char_boundary` in the Rust.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf8")}\n\n… truncated`;
}

/**
 * Whether a resource is worth spending a `resources/read` on.
 *
 * Only when there is no description to use instead, the type is textual, and
 * the declared size is inside the cap. A server that declares no MIME type is
 * given the benefit of the doubt — plenty do not.
 */
export function shouldRead(resource: Resource): boolean {
  if (resource.description !== null && resource.description.trim() !== "") return false;
  if (resource.size !== null && resource.size > BODY_CAP) return false;
  if (resource.mimeType === null) return true;
  const mime = resource.mimeType.toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("yaml") ||
    mime.includes("markdown")
  );
}

/**
 * One tool a server offers. Discovered, listed, and **not callable** in this
 * version — the day they become actions they go through `item_action` like
 * every other outbound thing, behind the approval gate.
 */
export interface Tool {
  name: string;
  description: string | null;
}

export function parseTools(result: unknown): Tool[] {
  if (!isPlainRecord(result) || !isArray(result.tools)) return [];
  const tools: Tool[] = [];
  for (const raw of result.tools) {
    if (!isPlainRecord(raw) || !isString(raw.name)) continue; // nameless, therefore not a tool
    tools.push({ name: raw.name, description: isString(raw.description) ? raw.description : null });
  }
  return tools;
}
