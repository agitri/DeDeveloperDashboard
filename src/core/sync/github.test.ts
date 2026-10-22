import { describe, expect, it } from "vitest";
import { fetchContext } from "./adapter";
import { GitHubAdapter, selfRef, toItem, toRepoItem } from "./github";

const cx = (fetch?: typeof globalThis.fetch) =>
  fetchContext({ environmentId: "e", connection: { id: "c", provider: "github" }, token: "tok", fetch });

// nameWithOwner tracks the url's owner/repo (falling back to "agitri/ddd" for
// a url that isn't a github.com path) so two different urls produce two
// distinct repo items, the way real GraphQL nodes do.
const repoNode = (url: string, sshUrl: string) => ({
  nameWithOwner: url.match(/github\.com\/([^/]+\/[^/]+)$/)?.[1] ?? "agitri/ddd",
  url,
  sshUrl,
  pushedAt: "2026-08-18T00:00:00Z",
  isPrivate: false,
  isArchived: false,
  isFork: false,
  primaryLanguage: { name: "Rust" },
});

describe("self references", () => {
  const withRefs = (refs: string[]) => ({
    ...toItem(cx(), { number: 1, title: "t", url: "u", updatedAt: "now", repository: { nameWithOwner: "x/y" } }, "pull_request")!,
    refs,
  });
  it("parses the self reference", () => {
    expect(selfRef(withRefs(["github:agitri/ddd#142"]))).toEqual(["agitri/ddd", 142]);
  });
  it("refuses to guess when there is no reference", () => {
    expect(() => selfRef(withRefs([]))).toThrow("has no GitHub reference");
    expect(() => selfRef(withRefs(["github-thread:99"]))).toThrow("has no GitHub reference");
  });
  it("refuses a missing issue number rather than treating it as zero", () => {
    expect(() => selfRef(withRefs(["github:owner/repo#"]))).toThrow("has no GitHub reference");
  });
  it("only ever looks at the first github: ref, malformed or not", () => {
    expect(() => selfRef(withRefs(["github:bad", "github:o/r#3"]))).toThrow("has no GitHub reference");
  });
});

describe("pull requests and issues", () => {
  it("folds the status line into body and adds approve only for review requests", () => {
    const node = {
      number: 142,
      title: "Normalize",
      url: "https://github.com/agitri/ddd/pull/142",
      updatedAt: "2026-08-18T00:00:00Z",
      isDraft: true,
      reviewDecision: "CHANGES_REQUESTED",
      repository: { nameWithOwner: "agitri/ddd" },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    };
    const pr = toItem(cx(), node, "pull_request")!;
    expect(pr.id).toBe("c:agitri/ddd#142");
    expect(pr.title).toBe("agitri/ddd#142 Normalize");
    expect(pr.body).toBe("draft · ci success · changes requested");
    expect(pr.refs).toEqual(["github:agitri/ddd#142"]);
    expect(pr.actions.map((a) => a.id)).toEqual(["comment", "open"]);
    const review = toItem(cx(), node, "review_request")!;
    expect(review.actions.map((a) => a.id)).toEqual(["approve", "comment", "open"]);
    expect(toItem(cx(), { title: "no number" }, "issue")).toBeNull();
  });
});

describe("repositories", () => {
  it("carries the repo ref, the normalized remote and both raw urls", () => {
    const item = toRepoItem(cx(), repoNode("https://github.com/agitri/ddd", "git@github.com:agitri/ddd.git"))!;
    expect(item.id).toBe("c:repo-agitri/ddd");
    expect(item.kind).toBe("repo");
    expect(item.body).toBe("public · rust");
    expect(item.refs).toEqual([
      "repo:agitri/ddd",
      "remote:github.com/agitri/ddd",
      "https:https://github.com/agitri/ddd",
      "ssh:git@github.com:agitri/ddd.git",
    ]);
  });
  it("still yields an item when the url does not normalize, without a remote ref", () => {
    const item = toRepoItem(cx(), repoNode("not-a-remote", ""))!;
    expect(item.refs).toEqual(["repo:agitri/ddd", "https:not-a-remote"]);
  });
  it("cannot be mistaken for a PR self reference", () => {
    expect(() => selfRef(toRepoItem(cx(), repoNode("https://github.com/agitri/ddd", ""))!)).toThrow();
  });
});

/** A fake GitHub: answers by URL and records what was asked. */
function fakeGitHub(overrides: Partial<Record<string, (body: string | null) => Response>> = {}) {
  const calls: { url: string; method: string; body: string | null; auth: string | null }[] = [];
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const graphql = (body: string | null) => {
    const { query, variables } = JSON.parse(body ?? "{}") as { query: string; variables: { cursor: string | null } };
    if (query.includes("viewer")) {
      // Page 1 then a stalled cursor: the same endCursor twice must stop the loop.
      const page =
        variables.cursor === null ?
          { nodes: [repoNode("https://github.com/agitri/ddd", "")], pageInfo: { hasNextPage: true, endCursor: "C1" } }
        : { nodes: [repoNode("https://github.com/agitri/other", "")], pageInfo: { hasNextPage: true, endCursor: "C1" } };
      return json({ data: { viewer: { repositories: page } } });
    }
    const pr = (n: number) => ({
      number: n,
      title: `t${n}`,
      url: `u${n}`,
      updatedAt: "2026-08-18T00:00:00Z",
      repository: { nameWithOwner: "agitri/ddd" },
    });
    return json({ data: { authored: { nodes: [pr(1), pr(2)] }, review: { nodes: [pr(2)] }, issues: { nodes: [pr(3)] } } });
  };
  const handlers: Record<string, (body: string | null) => Response> = {
    "https://api.github.com/graphql": graphql,
    "https://api.github.com/notifications?participating=true&per_page=50": () =>
      json([
        {
          id: "77",
          subject: { title: "Please review", url: "https://api.github.com/repos/agitri/ddd/pulls/2" },
          repository: { full_name: "agitri/ddd" },
          updated_at: "2026-08-18T00:00:00Z",
          reason: "review_requested",
          unread: true,
        },
      ]),
    ...overrides,
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : null;
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", body, auth: headers.get("authorization") });
    const h = handlers[url];
    if (!h) return json({ message: "Not Found" }, 404);
    return h(body);
  };
  return { fetch, calls };
}

describe("fetching", () => {
  it("assembles PRs, review requests, issues, notifications and repos, deduped, with the token on every call", async () => {
    const gh = fakeGitHub();
    const items = await new GitHubAdapter().fetch(cx(gh.fetch));
    const ids = items.map((i) => i.id);
    // pr 2 appears as authored and review-requested: first writer wins, once.
    expect(ids).toEqual(["c:agitri/ddd#1", "c:agitri/ddd#2", "c:agitri/ddd#3", "c:thread-77", "c:repo-agitri/ddd", "c:repo-agitri/other"]);
    expect(items.find((i) => i.id === "c:agitri/ddd#2")!.kind).toBe("pull_request");
    const thread = items.find((i) => i.id === "c:thread-77")!;
    expect(thread.kind).toBe("comment");
    expect(thread.title).toBe("agitri/ddd: Please review");
    expect(thread.body).toBe("review requested");
    expect(thread.url).toBe("https://github.com/agitri/ddd/pull/2");
    expect(thread.refs).toEqual(["github-thread:77"]);
    expect(thread.unread).toBe(true);
    // The stalled cursor stopped pagination after page two, not at REPO_PAGES.
    expect(gh.calls.filter((c) => c.url.endsWith("/graphql") && c.body!.includes("viewer"))).toHaveLength(2);
    expect(gh.calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("a failed repo listing or notifications call costs nothing but those items", async () => {
    const gh = fakeGitHub({
      "https://api.github.com/notifications?participating=true&per_page=50": () => new Response("nope", { status: 500 }),
    });
    const items = await new GitHubAdapter().fetch(cx(gh.fetch));
    expect(items.some((i) => i.kind === "comment")).toBe(false);
    expect(items.some((i) => i.kind === "pull_request")).toBe(true);
  });

  it("turns a non-2xx and a GraphQL errors array into messages a human can act on", async () => {
    const unauthorized = fakeGitHub({
      "https://api.github.com/graphql": () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, statusText: "Unauthorized" }),
    });
    await expect(new GitHubAdapter().fetch(cx(unauthorized.fetch))).rejects.toThrow("github 401 Unauthorized: Bad credentials");
    const gqlErrors = fakeGitHub({
      "https://api.github.com/graphql": () =>
        new Response(JSON.stringify({ errors: [{ message: "Field x" }, { message: "Field y" }] }), { status: 200 }),
    });
    await expect(new GitHubAdapter().fetch(cx(gqlErrors.fetch))).rejects.toThrow("github graphql: Field x; Field y");
    const down = cx(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(new GitHubAdapter().fetch(down)).rejects.toThrow("github request failed: ECONNRESET");
  });

  it("never rewrites a colon inside the detail, only the status prefix", async () => {
    // A colon that happens to sit inside the detail must survive untouched —
    // an unanchored `.replace(/\s+:/, ":")` would eat this one instead of the
    // (absent) one before an empty statusText.
    const unprocessable = fakeGitHub({
      "https://api.github.com/graphql": () =>
        new Response(JSON.stringify({ message: "Validation failed : name" }), { status: 422, statusText: "Unprocessable Entity" }),
    });
    await expect(new GitHubAdapter().fetch(cx(unprocessable.fetch))).rejects.toThrow(
      "github 422 Unprocessable Entity: Validation failed : name",
    );
    // No reason phrase from the server: no dangling space before the colon.
    const noReason = fakeGitHub({ "https://api.github.com/graphql": () => new Response("nope", { status: 500 }) });
    await expect(new GitHubAdapter().fetch(cx(noReason.fetch))).rejects.toThrow("github 500: nope");
  });
});

describe("performing", () => {
  it("comments, approves and marks read through the self reference, and refuses the rest", async () => {
    const gh = fakeGitHub({
      "https://api.github.com/repos/agitri/ddd/issues/142/comments": (b) =>
        new Response(JSON.stringify({ echoed: JSON.parse(b!) }), { status: 201 }),
      "https://api.github.com/repos/agitri/ddd/pulls/142/reviews": () => new Response("{}", { status: 200 }),
      // Node's fetch rejects a non-null body on a null-body status (205); a
      // real 205 has no body either, so `null` is the honest fixture here.
      "https://api.github.com/notifications/threads/77": () => new Response(null, { status: 205 }),
    });
    const a = new GitHubAdapter();
    const pr = toItem(
      cx(),
      { number: 142, title: "t", url: "u", updatedAt: "now", repository: { nameWithOwner: "agitri/ddd" } },
      "review_request",
    )!;
    const c = cx(gh.fetch);
    expect(await a.perform(c, { action: "comment", item: pr, input: "LGTM" })).toBe("Commented on agitri/ddd#142");
    expect(gh.calls.at(-1)!.body).toBe(JSON.stringify({ body: "LGTM" }));
    await expect(a.perform(c, { action: "comment", item: pr, input: null })).rejects.toThrow("a comment needs a body");
    expect(await a.perform(c, { action: "approve", item: pr, input: null })).toBe("Approved agitri/ddd#142");
    expect(gh.calls.at(-1)!.body).toBe(JSON.stringify({ event: "APPROVE", body: "" }));
    const thread = { ...pr, refs: ["github-thread:77"] };
    expect(await a.perform(c, { action: "mark_read", item: thread, input: null })).toBe("Marked read");
    expect(gh.calls.at(-1)!.method).toBe("PATCH");
    await expect(a.perform(c, { action: "mark_read", item: pr, input: null })).rejects.toThrow("not a notification");
    await expect(a.perform(c, { action: "dance", item: pr, input: null })).rejects.toThrow("github cannot dance");
  });
});
