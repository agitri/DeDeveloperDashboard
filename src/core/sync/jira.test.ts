import { describe, expect, it } from "vitest";
import { fetchContext } from "./adapter";
import { encode, issueKey, JiraAdapter, JQL, toItem } from "./jira";
import { forProvider } from "./providers";

const cx = (fetch?: typeof globalThis.fetch, config: Record<string, string> = { siteUrl: "https://acme.atlassian.net", email: "me@x.io" }) =>
  fetchContext({ environmentId: "e", connection: { id: "c", provider: "jira", label: "Work Jira", config }, token: "tok", fetch });

/** The exact URL the Rust builds: `urlencoding::encode` percent-encodes the
 *  parentheses and the `!` that `encodeURIComponent` would leave alone. */
const SEARCH =
  "https://acme.atlassian.net/rest/api/3/search/jql?jql=assignee%20%3D%20currentUser%28%29%20AND%20statusCategory%20%21%3D%20Done%20ORDER%20BY%20updated%20DESC&maxResults=50&fields=summary,updated,project,status,priority";
/** `base64("me@x.io:tok")`. */
const BASIC = "Basic bWVAeC5pbzp0b2s=";

const issue = {
  key: "ENG-1",
  fields: {
    summary: "Ship it",
    updated: "2026-08-18T19:00:00.000+0200",
    status: { name: "In Progress" },
    priority: { name: "High" },
    project: { key: "ENG" },
  },
};

type Call = { url: string; method: string; body: string | null; auth: string | null; accept: string | null; contentType: string | null };

/** A fake Jira: answers by exact URL and records what was asked. */
function fakeJira(handlers: Record<string, (body: string | null) => Response> = {}) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : null;
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body,
      auth: headers.get("authorization"),
      accept: headers.get("accept"),
      contentType: headers.get("content-type"),
    });
    const handler = handlers[url];
    if (!handler) return new Response(JSON.stringify({ errorMessages: ["no handler"] }), { status: 404, statusText: "Not Found" });
    return handler(body);
  };
  return { fetch, calls };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("the query", () => {
  it("is the JQL the Rust sends, verbatim", () => {
    expect(JQL).toBe("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
  });

  it("encodes the four characters encodeURIComponent spares", () => {
    expect(encode("!'()*")).toBe("%21%27%28%29%2A");
    expect(encode(JQL)).toBe("assignee%20%3D%20currentUser%28%29%20AND%20statusCategory%20%21%3D%20Done%20ORDER%20BY%20updated%20DESC");
  });
});

describe("issues", () => {
  it("folds status and priority into body and keeps Jira's own timestamp", () => {
    const item = toItem(cx(), "https://acme.atlassian.net", issue)!;
    expect(item.id).toBe("c:ENG-1");
    expect(item.environmentId).toBe("e");
    expect(item.connectionId).toBe("c");
    expect(item.source).toBe("jira");
    expect(item.kind).toBe("issue");
    expect(item.project).toBe("ENG");
    expect(item.title).toBe("ENG-1 Ship it");
    expect(item.body).toBe("in progress · high");
    expect(item.url).toBe("https://acme.atlassian.net/browse/ENG-1");
    expect(item.refs).toEqual(["jira:ENG-1"]);
    expect(item.actions).toEqual([
      { id: "comment", label: "Comment", outbound: true },
      { id: "transition", label: "Move to…", outbound: true },
      { id: "open", label: "Open in Jira", outbound: false },
    ]);
    expect(item.updatedAt).toBe("2026-08-18T19:00:00.000+0200");
    expect(item.unread).toBe(false);
  });

  it("leaves body null with no status and no priority, and project null with no project", () => {
    const bare = toItem(cx(), "https://acme.atlassian.net", { key: "ENG-2", fields: { summary: "s", updated: "u" } })!;
    expect(bare.body).toBeNull();
    expect(bare.project).toBeNull();
  });

  it("drops an issue missing a key, a summary or an updated stamp", () => {
    expect(toItem(cx(), "s", { fields: { summary: "s", updated: "u" } })).toBeNull();
    expect(toItem(cx(), "s", { key: "E-1", fields: { updated: "u" } })).toBeNull();
    expect(toItem(cx(), "s", { key: "E-1", fields: { summary: "s" } })).toBeNull();
  });
});

describe("the issue key", () => {
  const withRefs = (refs: string[]) => ({ ...toItem(cx(), "s", issue)!, refs, title: "ENG-1 Ship it" });

  it("comes out of the self reference", () => {
    expect(issueKey(withRefs(["jira:ENG-1"]))).toBe("ENG-1");
  });

  it("refuses to guess when there is none", () => {
    expect(() => issueKey(withRefs([]))).toThrow("ENG-1 Ship it has no Jira key");
    expect(() => issueKey(withRefs(["github:o/r#1"]))).toThrow("ENG-1 Ship it has no Jira key");
  });
});

describe("fetching", () => {
  it("asks once, with Basic auth and an Accept header, and maps the issues", async () => {
    const jira = fakeJira({ [SEARCH]: () => json({ issues: [issue, { key: "ENG-9" }] }) });
    const items = await new JiraAdapter().fetch(cx(jira.fetch));
    expect(items.map((i) => i.id)).toEqual(["c:ENG-1"]); // the malformed one is dropped
    expect(jira.calls).toHaveLength(1);
    expect(jira.calls[0]!.url).toBe(SEARCH);
    expect(jira.calls[0]!.method).toBe("GET");
    expect(jira.calls[0]!.auth).toBe(BASIC);
    expect(jira.calls[0]!.accept).toBe("application/json");
  });

  it("trims every trailing slash off the site url", async () => {
    const jira = fakeJira({ [SEARCH]: () => json({ issues: [] }) });
    const items = await new JiraAdapter().fetch(cx(jira.fetch, { siteUrl: "https://acme.atlassian.net///", email: "me@x.io" }));
    expect(items).toEqual([]);
    expect(jira.calls[0]!.url).toBe(SEARCH);
  });

  it("returns nothing when the body has no issues array", async () => {
    const jira = fakeJira({ [SEARCH]: () => json({}) });
    expect(await new JiraAdapter().fetch(cx(jira.fetch))).toEqual([]);
  });

  it("names the missing setting and the connection", async () => {
    const jira = fakeJira();
    await expect(new JiraAdapter().fetch(cx(jira.fetch, { email: "me@x.io" }))).rejects.toThrow("siteUrl is not set for Work Jira");
    await expect(new JiraAdapter().fetch(cx(jira.fetch, { siteUrl: "https://acme.atlassian.net" }))).rejects.toThrow("email is not set for Work Jira");
    await expect(new JiraAdapter().fetch(cx(jira.fetch, { siteUrl: "", email: "me@x.io" }))).rejects.toThrow("siteUrl is not set for Work Jira");
    expect(jira.calls).toHaveLength(0);
  });

  it("turns a failure into a message a human can act on", async () => {
    const unauthorized = fakeJira({ [SEARCH]: () => new Response(JSON.stringify({ errorMessages: ["Bad token", "second"] }), { status: 401, statusText: "Unauthorized" }) });
    await expect(new JiraAdapter().fetch(cx(unauthorized.fetch))).rejects.toThrow("jira 401 Unauthorized: Bad token");

    // Not JSON, and no reason phrase: the clipped body is the detail.
    const html = `<html>${"x".repeat(400)}</html>`;
    const broken = fakeJira({ [SEARCH]: () => new Response(html, { status: 500 }) });
    await expect(new JiraAdapter().fetch(cx(broken.fetch))).rejects.toThrow(`jira 500: ${[...html].slice(0, 200).join("")}`);

    // JSON, but nothing at /errorMessages/0.
    const odd = fakeJira({ [SEARCH]: () => new Response(JSON.stringify({ errors: { x: "y" } }), { status: 400, statusText: "Bad Request" }) });
    await expect(new JiraAdapter().fetch(cx(odd.fetch))).rejects.toThrow(`jira 400 Bad Request: ${JSON.stringify({ errors: { x: "y" } })}`);

    const down = cx(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(new JiraAdapter().fetch(down)).rejects.toThrow("jira request failed: ECONNRESET");
  });
});

describe("performing", () => {
  const item = toItem(fetchContext({ connection: { id: "c", label: "Work Jira" } }), "https://acme.atlassian.net", issue)!;
  const COMMENT = "https://acme.atlassian.net/rest/api/3/issue/ENG-1/comment";
  const TRANSITIONS = "https://acme.atlassian.net/rest/api/3/issue/ENG-1/transitions";

  it("posts a comment as Atlassian Document Format", async () => {
    const jira = fakeJira({ [COMMENT]: () => json({ id: "1" }, 201) });
    const c = cx(jira.fetch);
    expect(await new JiraAdapter().perform(c, { action: "comment", item, input: "on it" })).toBe("Commented on ENG-1");
    expect(jira.calls[0]!.method).toBe("POST");
    expect(jira.calls[0]!.auth).toBe(BASIC);
    expect(jira.calls[0]!.contentType).toBe("application/json");
    expect(JSON.parse(jira.calls[0]!.body!)).toEqual({
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "on it" }] }] },
    });
  });

  it("refuses a comment with no body", async () => {
    const jira = fakeJira();
    await expect(new JiraAdapter().perform(cx(jira.fetch), { action: "comment", item, input: null })).rejects.toThrow("a comment needs a body");
    expect(jira.calls).toHaveLength(0);
  });

  it("looks the transition id up by name, case insensitively, then posts it", async () => {
    const jira = fakeJira({
      [TRANSITIONS]: (body) => (body === null ? json({ transitions: [{ id: "11", name: "Backlog" }, { id: "31", name: "Done" }] }) : json({})),
    });
    const c = cx(jira.fetch);
    expect(await new JiraAdapter().perform(c, { action: "transition", item, input: "done" })).toBe("Moved ENG-1 to done");
    expect(jira.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(jira.calls[0]!.auth).toBe(BASIC);
    expect(jira.calls[1]!.body).toBe(JSON.stringify({ transition: { id: "31" } }));
  });

  it("says which transition it could not find, quoted", async () => {
    const jira = fakeJira({ [TRANSITIONS]: () => json({ transitions: [{ id: "11", name: "Backlog" }] }) });
    await expect(new JiraAdapter().perform(cx(jira.fetch), { action: "transition", item, input: "nope" })).rejects.toThrow(
      'ENG-1 has no transition called "nope"',
    );
  });

  it("refuses a transition with no name, and an action it does not have", async () => {
    const jira = fakeJira();
    const c = cx(jira.fetch);
    await expect(new JiraAdapter().perform(c, { action: "transition", item, input: null })).rejects.toThrow("which transition?");
    await expect(new JiraAdapter().perform(c, { action: "dance", item, input: null })).rejects.toThrow("jira cannot dance");
    expect(jira.calls).toHaveLength(0);
  });

  it("refuses an item that is not a Jira issue", async () => {
    const jira = fakeJira();
    const stray = { ...item, refs: [], title: "Some row" };
    await expect(new JiraAdapter().perform(cx(jira.fetch), { action: "comment", item: stray, input: "x" })).rejects.toThrow("Some row has no Jira key");
  });
});

describe("registration", () => {
  it("is the adapter for the jira provider", () => {
    expect(forProvider("jira")).toBeInstanceOf(JiraAdapter);
    expect(forProvider("jira")!.source).toBe("jira");
  });
});
