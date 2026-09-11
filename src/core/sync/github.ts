/**
 * GitHub, the first real adapter. Port of `sync/github.rs`.
 *
 * Everything the board needs about pull requests and issues comes back in a
 * single GraphQL request, including the CI rollup. One more REST call fetches
 * notifications, and a paginated GraphQL call lists repositories. That budget
 * is the whole reason the scheduler is central.
 */
import { DddError } from "../error";
import type { Item, ItemAction } from "../models";
import { normalize } from "../repos/remote";
import { itemId, statusLabel, type ActionRequest, type FetchContext, type SourceAdapter } from "./adapter";

export const API = "https://api.github.com";
const UA = "ddd-dashboard";
const TIMEOUT_MS = 30_000;

export const QUERY = `
query {
  authored: search(query: "is:pr is:open author:@me", type: ISSUE, first: 30) { nodes { ...pr } }
  review:   search(query: "is:pr is:open review-requested:@me", type: ISSUE, first: 30) { nodes { ...pr } }
  issues:   search(query: "is:issue is:open assignee:@me", type: ISSUE, first: 30) { nodes { ...iss } }
}
fragment pr on PullRequest {
  number title url updatedAt isDraft reviewDecision
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
fragment iss on Issue {
  number title url updatedAt
  repository { nameWithOwner }
}
`;

export const REPOS_QUERY = `
query($cursor: String) {
  viewer {
    repositories(first: 100, after: $cursor,
                 orderBy: {field: PUSHED_AT, direction: DESC},
                 affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner url sshUrl pushedAt isPrivate isArchived isFork
        primaryLanguage { name }
      }
    }
  }
}
`;

/** Pages of 100. Three is the stated cap from the spec. */
export const REPO_PAGES = 3;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
/** `a.b.c` lookup over untyped JSON. A numeric segment indexes into an array
 *  (`commits.nodes.0.commit...`), everything else is an object-key lookup. */
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

function headers(cx: FetchContext): Record<string, string> {
  return { authorization: `Bearer ${cx.token}`, "user-agent": UA, accept: "application/vnd.github+json" };
}

function net(e: unknown): DddError {
  return DddError.config(`github request failed: ${e instanceof Error ? e.message : String(e)}`);
}

async function send(cx: FetchContext, url: string, init: RequestInit): Promise<Response> {
  try {
    return await cx.fetch(url, { ...init, headers: { ...headers(cx), ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw net(e);
  }
}

/** Turn a non-2xx into a message a human can act on. GitHub puts the useful
 *  part in the body, and a bare status code helps nobody. */
async function check(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    let detail = text.slice(0, 200);
    try {
      const m = str(obj(JSON.parse(text))?.message);
      if (m !== null) detail = m;
    } catch {
      /* not JSON */
    }
    throw DddError.config(`github ${statusLabel(response)}: ${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** GraphQL with an optional pagination cursor bound to `$cursor`. GraphQL
 *  answers 200 with an `errors` array, so a happy status proves nothing. */
async function graphql(cx: FetchContext, query: string, cursor: string | null = null): Promise<unknown> {
  const response = await send(cx, `${API}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables: { cursor } }) });
  const body = await check(response);
  const errors = at(body, "errors");
  if (Array.isArray(errors) && errors.length > 0) {
    const message = errors.map((e) => str(obj(e)?.message)).filter((m): m is string => m !== null).join("; ");
    throw DddError.config(`github graphql: ${message}`);
  }
  return at(body, "data") ?? null;
}

async function post(cx: FetchContext, url: string, body: unknown): Promise<unknown> {
  const response = await send(cx, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return check(response);
}

export function toItem(cx: FetchContext, node: unknown, kind: string): Item | null {
  const repo = str(at(node, "repository.nameWithOwner"));
  const number = num(at(node, "number"));
  const title = str(at(node, "title"));
  const updated = str(at(node, "updatedAt"));
  if (repo === null || number === null || title === null || updated === null) return null;
  const url = str(at(node, "url"));

  const ci = str(at(node, "commits.nodes.0.commit.statusCheckRollup.state"));
  const review = str(at(node, "reviewDecision"));
  const draft = bool(at(node, "isDraft"), false);

  // The status line is folded into `body` so every view gets it for free and
  // the Item model does not sprout source-specific columns.
  const status: string[] = [];
  if (draft) status.push("draft");
  if (ci !== null) status.push(`ci ${ci.toLowerCase()}`);
  if (review !== null) status.push(review.toLowerCase().replaceAll("_", " "));

  const actions: ItemAction[] = [
    { id: "comment", label: "Comment", outbound: true },
    { id: "open", label: "Open on GitHub", outbound: false },
  ];
  if (kind === "review_request") actions.unshift({ id: "approve", label: "Approve", outbound: true });

  return {
    id: itemId(cx.connection.id, `${repo}#${number}`),
    environmentId: cx.environmentId,
    connectionId: cx.connection.id,
    source: "github",
    kind,
    project: repo,
    title: `${repo}#${number} ${title}`,
    body: status.length > 0 ? status.join(" · ") : null,
    url,
    // The self-ref is what `perform` parses to know where to post back to.
    refs: [`github:${repo}#${number}`],
    actions,
    updatedAt: updated,
    unread: false,
  };
}

/** Notifications are the closest thing GitHub has to "someone is waiting on you". */
async function notifications(cx: FetchContext): Promise<Item[]> {
  const response = await send(cx, `${API}/notifications?participating=true&per_page=50`, { method: "GET" });
  const body = await check(response);
  if (!Array.isArray(body)) return [];
  const items: Item[] = [];
  for (const thread of body) {
    const id = str(at(thread, "id"));
    const title = str(at(thread, "subject.title"));
    const repo = str(at(thread, "repository.full_name"));
    const updated = str(at(thread, "updated_at"));
    if (id === null || title === null || repo === null || updated === null) continue;
    const reason = str(at(thread, "reason")) ?? "";
    const unread = bool(at(thread, "unread"), true);
    // The API URL is not clickable; the web URL is derivable from the number.
    const subjectUrl = str(at(thread, "subject.url"));
    const number = subjectUrl?.split("/").pop();
    items.push({
      id: itemId(cx.connection.id, `thread-${id}`),
      environmentId: cx.environmentId,
      connectionId: cx.connection.id,
      source: "github",
      kind: "comment",
      project: repo,
      title: `${repo}: ${title}`,
      body: reason.replaceAll("_", " "),
      url: number ? `https://github.com/${repo}/pull/${number}` : null,
      refs: [`github-thread:${id}`],
      actions: [
        { id: "mark_read", label: "Mark read", outbound: true },
        { id: "open", label: "Open on GitHub", outbound: false },
      ],
      updatedAt: updated,
      unread,
    });
  }
  return items;
}

/** Repositories as items, so they ride the same cache and scheduler. */
async function repositories(cx: FetchContext): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < REPO_PAGES; page++) {
    const data = await graphql(cx, REPOS_QUERY, cursor);
    const repos = at(data, "viewer.repositories");
    const nodes = at(repos, "nodes");
    if (Array.isArray(nodes)) for (const node of nodes) { const item = toRepoItem(cx, node); if (item) items.push(item); }
    const hasNext = bool(at(repos, "pageInfo.hasNextPage"), false);
    const next = str(at(repos, "pageInfo.endCursor"));
    // A missing or unchanged cursor means the API cannot advance, even if it
    // still claims hasNextPage — looping again would refetch page one.
    if (next !== null && hasNext && next !== cursor) cursor = next;
    else break;
  }
  return items;
}

export function toRepoItem(cx: FetchContext, node: unknown): Item | null {
  const name = str(at(node, "nameWithOwner"));
  const url = str(at(node, "url"));
  if (name === null || url === null) return null;
  const sshUrl = str(at(node, "sshUrl")) ?? "";
  const pushed = str(at(node, "pushedAt")) ?? "";
  const isPrivate = bool(at(node, "isPrivate"), false);
  const archived = bool(at(node, "isArchived"), false);
  const fork = bool(at(node, "isFork"), false);
  const language = str(at(node, "primaryLanguage.name"));

  const facts = [isPrivate ? "private" : "public"];
  if (language !== null) facts.push(language.toLowerCase());
  if (fork) facts.push("fork");
  if (archived) facts.push("archived");

  // Both raw forms are kept so a local clone matches whichever the user used.
  const refs = [`repo:${name}`];
  const normalized = normalize(url);
  if (normalized !== null) refs.push(`remote:${normalized}`);
  refs.push(`https:${url}`);
  if (sshUrl !== "") refs.push(`ssh:${sshUrl}`);

  return {
    id: itemId(cx.connection.id, `repo-${name}`),
    environmentId: cx.environmentId,
    connectionId: cx.connection.id,
    source: "github",
    kind: "repo",
    project: name,
    title: name,
    body: facts.join(" · "),
    url,
    refs,
    actions: [{ id: "open", label: "Open on GitHub", outbound: false }],
    updatedAt: pushed,
    unread: false,
  };
}

/** Pull `owner/repo` and the number back out of the self-ref. */
export function selfRef(item: Item): [string, number] {
  // Only the first `github:` ref counts, exactly as Rust's `self_ref` reads
  // `refs.iter().find(...)`: a malformed one is not a license to keep
  // looking at the rest.
  const first = item.refs.find((r) => r.startsWith("github:"));
  if (first) {
    const [repo, n] = first.slice("github:".length).split("#");
    if (repo && n !== undefined && /^-?\d+$/.test(n)) return [repo, Number(n)];
  }
  throw DddError.config(`${item.title} has no GitHub reference`);
}

export class GitHubAdapter implements SourceAdapter {
  readonly source = "github";

  async fetch(cx: FetchContext): Promise<Item[]> {
    const items: Item[] = [];
    const data = await graphql(cx, QUERY);
    for (const [list, kind] of [["authored", "pull_request"], ["review", "review_request"], ["issues", "issue"]] as const) {
      const nodes = at(data, `${list}.nodes`);
      if (Array.isArray(nodes)) for (const node of nodes) { const item = toItem(cx, node, kind); if (item) items.push(item); }
    }
    items.push(...(await notifications(cx).catch(() => [] as Item[])));
    // A repo listing is not urgent; a failure here must not cost you your PRs.
    items.push(...(await repositories(cx).catch(() => [] as Item[])));
    // Duplicates are not guaranteed adjacent: a set over the whole result is
    // what actually guarantees first-writer-wins.
    const seen = new Set<string>();
    return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  }

  async perform(cx: FetchContext, request: ActionRequest): Promise<string> {
    switch (request.action) {
      case "comment": {
        const [repo, number] = selfRef(request.item);
        if (request.input === null) throw DddError.config("a comment needs a body");
        await post(cx, `${API}/repos/${repo}/issues/${number}/comments`, { body: request.input });
        return `Commented on ${repo}#${number}`;
      }
      case "approve": {
        const [repo, number] = selfRef(request.item);
        await post(cx, `${API}/repos/${repo}/pulls/${number}/reviews`, { event: "APPROVE", body: request.input ?? "" });
        return `Approved ${repo}#${number}`;
      }
      case "mark_read": {
        const thread = request.item.refs.map((r) => (r.startsWith("github-thread:") ? r.slice("github-thread:".length) : null)).find((t) => t !== null);
        if (!thread) throw DddError.config("not a notification");
        const response = await send(cx, `${API}/notifications/threads/${thread}`, { method: "PATCH" });
        await check(response);
        return "Marked read";
      }
      default:
        throw DddError.config(`github cannot ${request.action}`);
    }
  }
}
