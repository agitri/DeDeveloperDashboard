/**
 * Jira (§5.5). Port of `sync/jira.rs`.
 *
 * Basic auth with an API token, which is what Atlassian Cloud expects from a
 * desktop app that is not a registered OAuth integration — and it keeps
 * self-hosting simple: paste a token, done.
 */
import { DddError } from "../error";
import type { Item } from "../models";
import { itemId, refuse, requireConfig, statusLabel, type ActionRequest, type FetchContext, type SourceAdapter } from "./adapter";

/** Open work assigned to me, freshest first. `statusCategory != Done` rather
 *  than a status name, because every Jira project renames its statuses. */
export const JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** `serde_json`'s `pointer("/a/b/0")`, spelled `a.b.0` here: a numeric segment
 *  indexes an array, anything else is an object key. */
function at(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const key of path.split(".")) {
    if (Array.isArray(cur)) {
      const index = Number(key);
      cur = Number.isInteger(index) ? cur[index] : undefined;
      continue;
    }
    const o = obj(cur);
    if (!o) return undefined;
    cur = o[key];
  }
  return cur;
}

/** Rust's `urlencoding::encode` leaves only ALPHA / DIGIT / `-._~` alone;
 *  `encodeURIComponent` also spares `!'()*`, and the JQL contains `!` and a
 *  pair of parentheses. Encode those four by hand so the URL Jira sees is
 *  byte-identical to the Rust's. */
export function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `str::eq_ignore_ascii_case`: folds A–Z only, never the Unicode cases. */
function eqIgnoreAsciiCase(a: string, b: string): boolean {
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  return fold(a) === fold(b);
}

function site(cx: FetchContext): string {
  // `trim_end_matches('/')` strips every trailing slash, not just one.
  return requireConfig(cx, "siteUrl").replace(/\/+$/, "");
}

function basic(cx: FetchContext): string {
  const email = requireConfig(cx, "email");
  return `Basic ${Buffer.from(`${email}:${cx.token}`, "utf8").toString("base64")}`;
}

function net(e: unknown): DddError {
  return DddError.config(`jira request failed: ${e instanceof Error ? e.message : String(e)}`);
}

async function send(cx: FetchContext, url: string, init: RequestInit): Promise<Response> {
  try {
    return await cx.fetch(url, init);
  } catch (e) {
    throw net(e);
  }
}

/** Jira puts the useful part in `errorMessages`; a bare status helps nobody. */
async function check(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    // `chars().take(200)`: code points, not UTF-16 units.
    let detail = Array.from(text).slice(0, 200).join("");
    try {
      const m = str(at(JSON.parse(text), "errorMessages.0"));
      if (m !== null) detail = m;
    } catch {
      /* not JSON: the clipped body is the detail */
    }
    throw DddError.config(`jira ${statusLabel(response)}: ${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function toItem(cx: FetchContext, site: string, issue: unknown): Item | null {
  const key = str(at(issue, "key"));
  const summary = str(at(issue, "fields.summary"));
  const updated = str(at(issue, "fields.updated"));
  if (key === null || summary === null || updated === null) return null;
  const status = str(at(issue, "fields.status.name"));
  const priority = str(at(issue, "fields.priority.name"));
  const project = str(at(issue, "fields.project.key"));

  const meta: string[] = [];
  if (status !== null) meta.push(status.toLowerCase());
  if (priority !== null) meta.push(priority.toLowerCase());

  return {
    id: itemId(cx.connection.id, key),
    environmentId: cx.environmentId,
    connectionId: cx.connection.id,
    source: "jira",
    kind: "issue",
    project,
    title: `${key} ${summary}`,
    body: meta.length > 0 ? meta.join(" · ") : null,
    url: `${site}/browse/${key}`,
    refs: [`jira:${key}`],
    actions: [
      { id: "comment", label: "Comment", outbound: true },
      { id: "transition", label: "Move to…", outbound: true },
      { id: "open", label: "Open in Jira", outbound: false },
    ],
    // Jira stamps `2026-08-18T19:00:00.000+0200`, which is valid RFC 3339 and
    // sorts correctly as a string only because the offset is fixed per site —
    // good enough for ordering one connection's own items. Kept verbatim.
    updatedAt: updated,
    unread: false,
  };
}

export function issueKey(item: Item): string {
  const ref = item.refs.find((r) => r.startsWith("jira:"));
  if (ref !== undefined) return ref.slice("jira:".length);
  throw DddError.config(`${item.title} has no Jira key`);
}

export class JiraAdapter implements SourceAdapter {
  readonly source = "jira";

  async fetch(cx: FetchContext): Promise<Item[]> {
    const base = site(cx);
    const url = `${base}/rest/api/3/search/jql?jql=${encode(JQL)}&maxResults=50&fields=summary,updated,project,status,priority`;
    const response = await send(cx, url, { method: "GET", headers: { authorization: basic(cx), accept: "application/json" } });
    const body = await check(response);

    const issues = at(body, "issues");
    if (!Array.isArray(issues)) return [];
    const items: Item[] = [];
    for (const issue of issues) {
      const item = toItem(cx, base, issue);
      if (item) items.push(item);
    }
    return items;
  }

  async perform(cx: FetchContext, request: ActionRequest): Promise<string> {
    // Both in the Rust's order: a missing siteUrl is reported before a
    // missing Jira key.
    const base = site(cx);
    const key = issueKey(request.item);

    switch (request.action) {
      case "comment": {
        if (request.input === null) throw DddError.config("a comment needs a body");
        const response = await send(cx, `${base}/rest/api/3/issue/${key}/comment`, {
          method: "POST",
          headers: { authorization: basic(cx), "content-type": "application/json" },
          // Jira Cloud wants Atlassian Document Format, not a string.
          body: JSON.stringify({
            body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: request.input }] }] },
          }),
        });
        await check(response);
        return `Commented on ${key}`;
      }
      case "transition": {
        const wanted = request.input;
        if (wanted === null) throw DddError.config("which transition?");

        // Transition ids are per-project and per-workflow, so the name the
        // user asked for has to be looked up on the issue itself.
        const listed = await check(
          await send(cx, `${base}/rest/api/3/issue/${key}/transitions`, { method: "GET", headers: { authorization: basic(cx) } }),
        );
        const transitions = at(listed, "transitions");
        const found = Array.isArray(transitions)
          ? transitions.find((t) => {
              const name = str(at(t, "name"));
              return name !== null && eqIgnoreAsciiCase(name, wanted);
            })
          : undefined;
        const id = str(at(found, "id"));
        if (id === null) throw DddError.config(`${key} has no transition called ${JSON.stringify(wanted)}`);

        const response = await send(cx, `${base}/rest/api/3/issue/${key}/transitions`, {
          method: "POST",
          headers: { authorization: basic(cx), "content-type": "application/json" },
          body: JSON.stringify({ transition: { id } }),
        });
        await check(response);
        return `Moved ${key} to ${wanted}`;
      }
      default:
        // Same text as the Rust's inline `jira cannot {other}`.
        return refuse("jira", request.action);
    }
  }
}
