import { EventEmitter } from "node:events";
import type { FetchMessageObject, FetchQueryObject } from "imapflow";
import { describe, expect, it } from "vitest";
import { defaultSettings, settingsSave } from "../settings";
import type { Item } from "../models";
import { scratchEnv } from "../testing";
import { fetchContext, memorySecrets, type FetchContext } from "./adapter";
import {
  BODY_PREVIEW_BYTES,
  ImapAdapter,
  WANTED_HEADERS,
  buildSession,
  fetchMessages,
  isValidHostname,
  refineWithModel,
  toItem,
  type FetchSpec,
  type FetchedMessage,
  type ImapClientLike,
  type ImapSession,
  type RawMessage,
} from "./imap";
import { forProvider } from "./providers";

// The live imapflow connection is NOT tested: there is no IMAP server in the
// suite, exactly as the Rust says of `fetch_messages`. Everything either side of
// the socket — the mapping, the range arithmetic, the adapter, the escalation —
// runs here against fixtures and a fake session.

function raw(headers: string, body: string): RawMessage {
  return { raw: Buffer.from(`${headers}\r\n\r\n${body}`, "utf8"), seen: false, uid: 42, uidValidity: 1 };
}

async function map(message: RawMessage): Promise<Item> {
  const item = await toItem(message, { address: "rene@example.dev" }, "conn-1", "default");
  expect(item, "message should map").not.toBeNull();
  return item!;
}

function refsOf(item: Item, prefix: string): string[] {
  return item.refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));
}

describe("toItem", () => {
  it("decodes an encoded-word subject", async () => {
    const m = raw(
      "From: Marjolein <marjolein@example.com>\r\nTo: rene@example.dev\r\nSubject: =?UTF-8?B?RmFjdHV1ciB2b29yIGrDunVuaQ==?=",
      "Hoi Rene,",
    );
    expect((await map(m)).title).toBe("Factuur voor júuni");
  });

  it("decodes a quoted-printable body", async () => {
    const m = raw(
      "From: a@example.com\r\nTo: rene@example.dev\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable",
      "Kosten =E2=82=AC40 per uur",
    );
    expect((await map(m)).body).toBe("Kosten €40 per uur");
  });

  it("prefers the plain part of a multipart message", async () => {
    const m = raw(
      'From: a@example.com\r\nTo: rene@example.dev\r\nSubject: Hi\r\nContent-Type: multipart/alternative; boundary="b"',
      "--b\r\nContent-Type: text/plain\r\n\r\nplain wins\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>html loses</p>\r\n--b--",
    );
    expect((await map(m)).body).toBe("plain wins");
  });

  it("strips an html-only body rather than dropping it", async () => {
    const m = raw(
      "From: a@example.com\r\nTo: rene@example.dev\r\nSubject: Hi\r\nContent-Type: text/html",
      "<div><p>Hello&nbsp;<b>there</b></p></div>",
    );
    const body = (await map(m)).body!;
    expect(body).toBe("Hello there");
    // The hard requirement: no markup survives into something a view renders.
    expect(body).not.toContain("<");
  });

  it("seen maps to unread in both directions", async () => {
    const m = raw("From: a@example.com\r\nSubject: Hi", "x");
    expect((await map(m)).unread).toBe(true);
    expect((await map({ ...m, seen: true })).unread).toBe(false);
  });

  it("keys on message id so a uidvalidity change cannot duplicate a mailbox", async () => {
    const headers = "From: a@example.com\r\nSubject: Hi\r\nMessage-ID: <abc@example.com>";
    const first = await map(raw(headers, "x"));
    const second = await map({ ...raw(headers, "x"), uid: 9001, uidValidity: 2 });
    expect(first.id).toBe(second.id);
    expect(first.id, first.id).toContain("abc@example.com");
  });

  it("falls back to uid when a message has no id", async () => {
    const item = await map(raw("From: a@example.com\r\nSubject: Hi", "x"));
    expect(item.id, item.id).toContain("uid:1:42");
  });

  it("a newsletter is classified as bulk and a person is not", async () => {
    const bulk = raw(
      "From: newsletter@shop.example\r\nTo: rene@example.dev\r\nSubject: 20% off this week\r\nList-Unsubscribe: <https://shop.example/u>",
      "deals",
    );
    expect((await map(bulk)).kind).toBe("mail_bulk");

    const person = raw("From: Marjolein <marjolein@example.com>\r\nTo: rene@example.dev\r\nSubject: Invoice question", "Could you check?");
    expect((await map(person)).kind).toBe("mail");
  });

  it("records which layer decided and why", async () => {
    const item = await map(raw("From: noreply@ci.example\r\nTo: rene@example.dev\r\nSubject: Build passed", "ok"));
    expect(refsOf(item, "verdict:")).toEqual(["rules"]);
    expect(refsOf(item, "reason:"), JSON.stringify(item.refs)).not.toHaveLength(0);
    expect(refsOf(item, "score:")).toHaveLength(1);
    expect(item.source).toBe("mail.imap");
    expect(item.actions).toEqual([]);
  });

  it("a long body is truncated on a char boundary", async () => {
    const body = "é".repeat(BODY_PREVIEW_BYTES);
    const m = raw("From: a@example.com\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8", body);
    const mapped = (await map(m)).body!;
    expect(mapped.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(mapped, "utf8")).toBeLessThanOrEqual(BODY_PREVIEW_BYTES + 4);
    expect(mapped).not.toContain("�");
  });

  it("a message with no subject still renders", async () => {
    expect((await map(raw("From: a@example.com", "x"))).title).toBe("(no subject)");
  });

  it("keeps only the first address in a non-group multi-mailbox From, because postal-mime does", async () => {
    // `From: a <a@x>, b <b@x>` is valid RFC 5322 (a mailbox-list, not a group),
    // and the Rust would join both. postal-mime's `from` is typed as a single
    // `Address`, and in practice it keeps only the first mailbox it parses —
    // asserted here rather than assumed, per the mapping's own comment.
    const m = raw("From: a <a@x>, b <b@x>\r\nSubject: Hi", "x");
    expect(refsOf(await map(m), "from:")).toEqual(["a@x"]);
  });

  it("joins every member of an RFC 5322 group From with the Rust's ', '", async () => {
    // `Team: a <a@x>, b <b@x>;` — the group syntax, distinct from a plain
    // mailbox-list. postal-mime hands this back as `{ name, group: [...] }`
    // with no `address` of its own; every member must still reach the ref.
    const m = raw("From: Team: a <a@x>, b <b@x>;\r\nSubject: Hi", "x");
    expect(refsOf(await map(m), "from:")).toEqual(["a@x, b@x"]);
  });

  it("unparseable bytes are skipped rather than fatal", async () => {
    const junk: RawMessage = { raw: Buffer.from([0xff, 0xfe, 0x00]), seen: false, uid: 1, uidValidity: 1 };
    // One bad message in two hundred must cost that message, not the sync.
    await expect(toItem(junk, { address: "rene@example.dev" }, "c", "default")).resolves.toBeDefined();
  });
});

// --- the fetch layer, against a fake session -----------------------------------

interface FakeCall {
  range: string;
  spec: FetchSpec;
}

function fakeSession(exists: number, messages: FetchedMessage[]): ImapSession & { calls: FakeCall[]; loggedOut: boolean } {
  const session = {
    calls: [] as FakeCall[],
    loggedOut: false,
    select: async () => ({ exists, uidValidity: 7 }),
    fetchRange(range: string, spec: FetchSpec): AsyncIterable<FetchedMessage> {
      session.calls.push({ range, spec });
      return (async function* () {
        for (const m of messages) yield m;
      })();
    },
    logout: async () => {
      session.loggedOut = true;
    },
  };
  return session;
}

const fetched = (uid: number, header: string, text: string, seen = false): FetchedMessage => ({
  uid,
  flags: new Set(seen ? ["\\Seen"] : []),
  headerBytes: Buffer.from(header, "utf8"),
  textBytes: Buffer.from(text, "utf8"),
});

describe("fetchMessages", () => {
  it("asks for the newest N by sequence number and peeks the wanted headers", async () => {
    const session = fakeSession(500, [fetched(1, "From: a@example.com\r\nSubject: Hi", "body")]);
    const messages = await fetchMessages(session, "INBOX", 200);
    expect(session.calls[0]!.range).toBe("301:500");
    expect(session.calls[0]!.spec.headers).toEqual([...WANTED_HEADERS]);
    expect(session.calls[0]!.spec.textBytes).toBe(BODY_PREVIEW_BYTES);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.raw.toString("utf8")).toBe("From: a@example.com\r\nSubject: Hi\r\nbody");
    expect(messages[0]!.uidValidity).toBe(7);
  });

  it("never asks below sequence one", async () => {
    const session = fakeSession(3, []);
    await fetchMessages(session, "INBOX", 200);
    expect(session.calls[0]!.range).toBe("1:3");
  });

  it("fetches nothing at all from an empty folder, and still logs out", async () => {
    const session = fakeSession(0, [fetched(1, "From: a@example.com", "x")]);
    expect(await fetchMessages(session, "INBOX", 10)).toEqual([]);
    expect(session.calls).toEqual([]);
    expect(session.loggedOut).toBe(true);
  });

  it("skips an empty message and reads the Seen flag", async () => {
    const session = fakeSession(2, [
      { uid: 1, flags: new Set(), headerBytes: Buffer.alloc(0), textBytes: Buffer.alloc(0) },
      fetched(2, "From: a@example.com\r\nSubject: Hi", "x", true),
    ]);
    const messages = await fetchMessages(session, "INBOX", 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.uid).toBe(2);
    expect(messages[0]!.seen).toBe(true);
    expect(session.loggedOut).toBe(true);
  });

  it("still logs out when select rejects, so a bad folder cannot leak the connection", async () => {
    let loggedOut = 0;
    const session: ImapSession = {
      select: async () => {
        throw new Error(`could not open "Bogus": no such mailbox`);
      },
      fetchRange: () => {
        throw new Error("must not be called: select already failed");
      },
      logout: async () => {
        loggedOut += 1;
      },
    };
    await expect(fetchMessages(session, "Bogus", 10)).rejects.toThrow(`could not open "Bogus": no such mailbox`);
    expect(loggedOut).toBe(1);
  });
});

// --- the session wrapper, against a stub ImapFlow-shaped client ----------------

/** `ImapFlow`-shaped enough for `buildSession`: a real `EventEmitter` (so
 *  emitting 'error' with no listener would throw, same as the live client),
 *  `mailboxOpen`, `fetch` and `logout`. */
class FakeImapClient extends EventEmitter implements ImapClientLike {
  loggedOut = false;
  constructor(
    private readonly mailbox: { exists: number; uidValidity?: unknown },
    private readonly messages: FetchMessageObject[] = [],
  ) {
    super();
  }

  async mailboxOpen(_path: string): Promise<{ exists: number; uidValidity: unknown }> {
    return { exists: this.mailbox.exists, uidValidity: this.mailbox.uidValidity };
  }

  fetch(_range: string, _query: FetchQueryObject): AsyncIterable<FetchMessageObject> {
    const messages = this.messages;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  }

  async logout(): Promise<void> {
    this.loggedOut = true;
  }
}

const clientFetched = (uid: number, header: string, text: string): FetchMessageObject => ({
  seq: uid,
  uid,
  flags: new Set<string>(),
  headers: Buffer.from(header, "utf8"),
  bodyParts: new Map([["text", Buffer.from(text, "utf8")]]),
});

describe("buildSession", () => {
  it("attaches its own 'error' listener, so a socket failure cannot go uncaught", () => {
    const client = new FakeImapClient({ exists: 0 });
    buildSession(client);
    // A Node EventEmitter with zero 'error' listeners throws synchronously on
    // emit; buildSession's own listener is what stands between a dead socket
    // and an uncaught exception in the Electron main process.
    expect(() => client.emit("error", new Error("socket reset"))).not.toThrow();
  });

  it("reports a socket error through fetchRange when the iterator ends early because of it", async () => {
    const client = new FakeImapClient({ exists: 0 });
    const session = buildSession(client);
    client.emit("error", new Error("socket reset"));

    const drain = async () => {
      for await (const _ of session.fetchRange("1:1", { headers: [], textBytes: 0 })) {
        // never reached — the fetch itself yields nothing.
      }
    };
    await expect(drain()).rejects.toThrow("fetch failed: socket reset");
  });

  it("reports a socket error through logout too, when nothing else already consumed it", async () => {
    const client = new FakeImapClient({ exists: 0 });
    const session = buildSession(client);
    client.emit("error", new Error("socket reset"));

    await expect(session.logout()).rejects.toThrow("fetch failed: socket reset");
    expect(client.loggedOut).toBe(true); // still logs out before reporting
  });

  it("does not repeat the same error a second time, once it has been reported once", async () => {
    const client = new FakeImapClient({ exists: 0 });
    const session = buildSession(client);
    client.emit("error", new Error("socket reset"));

    const drain = async () => {
      for await (const _ of session.fetchRange("1:1", { headers: [], textBytes: 0 })) {
        // never reached
      }
    };
    await expect(drain()).rejects.toThrow("fetch failed: socket reset");
    await expect(session.logout()).resolves.toBeUndefined(); // already consumed
  });

  it("treats a missing UIDVALIDITY as 0 rather than NaN", async () => {
    const client = new FakeImapClient({ exists: 1, uidValidity: undefined }, [
      clientFetched(42, "From: a@example.com\r\nSubject: Hi", "x"),
    ]);
    const session = buildSession(client);
    const messages = await fetchMessages(session, "INBOX", 10);
    expect(messages[0]!.uidValidity).toBe(0);
    const item = await map(messages[0]!);
    expect(item.refs).toContain("uid:0:42");
  });
});

describe("hostnames", () => {
  it("accepts a name or an address and refuses a URL", () => {
    expect(isValidHostname("imap.gmail.com")).toBe(true);
    expect(isValidHostname("127.0.0.1")).toBe(true);
    expect(isValidHostname("imaps://imap.gmail.com")).toBe(false);
    expect(isValidHostname("imap gmail com")).toBe(false);
    expect(isValidHostname("")).toBe(false);
  });
});

// --- the adapter ---------------------------------------------------------------

const connection = {
  id: "conn-1",
  provider: "mail.imap",
  label: "Work mail",
  config: { host: "imap.example.dev", username: "rene@example.dev" },
};

describe("ImapAdapter", () => {
  it("names the connection in every configuration failure, verbatim", async () => {
    const never = async () => {
      throw new Error("the adapter must not connect");
    };
    const adapter = new ImapAdapter(never);

    await expect(adapter.fetch(fetchContext({ connection: { ...connection, config: { username: "rene@example.dev" } } }))).rejects.toThrow(
      "host is not set for Work mail",
    );

    await expect(adapter.fetch(fetchContext({ connection: { ...connection, config: { host: "imap.example.dev" } } }))).rejects.toThrow(
      "username is not set for Work mail",
    );

    await expect(adapter.fetch(fetchContext({ connection, token: "" }))).rejects.toThrow("Work mail has no app password set");
  });

  it("reads port, folder and limit from the connection, with the Rust's defaults", async () => {
    let opened: { folder: string; limit: number; port: number } | null = null;
    const session = fakeSession(1000, []);
    const connect = async (opts: { host: string; port: number; username: string; password: string }) => {
      opened = { folder: "", limit: 0, port: opts.port };
      return {
        ...session,
        select: async (folder: string) => {
          opened!.folder = folder;
          return { exists: 1000, uidValidity: 7 };
        },
        fetchRange(range: string, spec: FetchSpec) {
          opened!.limit = 1000 - Number(range.split(":")[0]) + 1;
          return session.fetchRange(range, spec);
        },
      };
    };

    await new ImapAdapter(connect).fetch(fetchContext({ connection }));
    expect(opened).toEqual({ folder: "INBOX", limit: 200, port: 993 });

    await new ImapAdapter(connect).fetch(
      fetchContext({ connection: { ...connection, config: { ...connection.config, port: "1993", folder: "Archive", limit: "5" } } }),
    );
    expect(opened).toEqual({ folder: "Archive", limit: 5, port: 1993 });

    // Garbage falls back; a huge limit is clamped rather than refused.
    await new ImapAdapter(connect).fetch(
      fetchContext({ connection: { ...connection, config: { ...connection.config, port: "nope", limit: "99999" } } }),
    );
    expect(opened).toEqual({ folder: "INBOX", limit: 1000, port: 993 });
  });

  it("maps what the session returns", async () => {
    const session = fakeSession(2, [
      fetched(
        1,
        "From: newsletter@shop.example\r\nTo: rene@example.dev\r\nSubject: 20% off\r\nList-Unsubscribe: <https://shop.example/u>",
        "deals",
      ),
      fetched(2, "From: Marjolein <marjolein@example.com>\r\nTo: rene@example.dev\r\nSubject: Invoice question", "Could you check?"),
    ]);
    const items = await new ImapAdapter(async () => session).fetch(fetchContext({ environmentId: "default", connection }));
    expect(items.map((i) => i.kind)).toEqual(["mail_bulk", "mail"]);
    expect(items[0]!.connectionId).toBe("conn-1");
    expect(items[0]!.source).toBe("mail.imap");
  });

  it("refuses every outbound action: read-only means absent, not broken", async () => {
    const item = await map(raw("From: a@example.com\r\nSubject: Hi", "x"));
    await expect(new ImapAdapter().perform(fetchContext({ connection }), { action: "archive", item, input: null })).rejects.toThrow(
      "mail.imap cannot archive",
    );
  });

  it("is what providers.forProvider builds for mail.imap", () => {
    expect(forProvider("mail.imap")).toBeInstanceOf(ImapAdapter);
    expect(forProvider("mail.imap")!.source).toBe("mail.imap");
  });
});

// --- escalation ----------------------------------------------------------------

function ambiguous(score: number, overrides: Partial<Item> = {}): Item {
  return {
    id: `conn-1:x${score}`,
    environmentId: "default",
    connectionId: "conn-1",
    source: "mail.imap",
    kind: "mail_bulk",
    project: null,
    title: "Your invoice is ready",
    body: "Could you confirm the amount?",
    url: null,
    refs: ["from:hello@studio.example", "uid:1:42", "verdict:rules", `score:${score}`, "reason:noise:subject-invoice"],
    actions: [],
    updatedAt: "2026-08-19T09:00:00Z",
    unread: true,
    ...overrides,
  };
}

/** Ollama's `/api/chat` shape, answering with whatever the test wants. */
function ollama(answer: string): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    void init;
    return new Response(JSON.stringify({ message: { content: answer }, prompt_eval_count: 1, eval_count: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

function classifyingContext(fetch: typeof globalThis.fetch, environmentId: string): FetchContext {
  return { ...fetchContext({ environmentId, connection, fetch }), secrets: memorySecrets() };
}

describe("refineWithModel", () => {
  it("flips an ambiguous verdict when the model says PERSON, and says the model did it", async () => {
    const { env } = scratchEnv("imap-person");
    const settings = defaultSettings();
    settings.ai.classifyMailLocally = true;
    settingsSave(env, settings);

    const { fetch, calls } = ollama("PERSON");
    const items = [ambiguous(-2)];
    await refineWithModel(classifyingContext(fetch, env.id), items);

    expect(calls).toEqual(["http://localhost:11434/api/chat"]);
    expect(items[0]!.kind).toBe("mail");
    expect(items[0]!.refs).not.toContain("verdict:rules");
    expect(items[0]!.refs).toContain("verdict:model");
    expect(items[0]!.refs).toContain("reason:model:person");
    // The rule's own reason is kept: the model added an opinion, it did not
    // erase the evidence.
    expect(items[0]!.refs).toContain("reason:noise:subject-invoice");
  });

  it("flips the other way on AUTOMATED", async () => {
    const { env } = scratchEnv("imap-automated");
    const settings = defaultSettings();
    settings.ai.classifyMailLocally = true;
    settingsSave(env, settings);

    const items = [ambiguous(2, { kind: "mail" })];
    await refineWithModel(classifyingContext(ollama("automated.").fetch, env.id), items);
    expect(items[0]!.kind).toBe("mail_bulk");
    expect(items[0]!.refs).toContain("reason:model:automated");
  });

  it("leaves the rule verdict standing when the model answers with nonsense", async () => {
    const { env } = scratchEnv("imap-garbage");
    const settings = defaultSettings();
    settings.ai.classifyMailLocally = true;
    settingsSave(env, settings);

    const before = ambiguous(-2);
    const items = [ambiguous(-2)];
    await refineWithModel(classifyingContext(ollama("Ja hoor, misschien").fetch, env.id), items);
    expect(items[0]).toEqual(before);
  });

  it("never asks about a message outside the band", async () => {
    const { env } = scratchEnv("imap-band");
    const settings = defaultSettings();
    settings.ai.classifyMailLocally = true;
    settingsSave(env, settings);

    const { fetch, calls } = ollama("PERSON");
    const items = [ambiguous(-8), ambiguous(4), ambiguous(-4), { ...ambiguous(0), refs: ["from:x@y.dev"] }];
    await refineWithModel(classifyingContext(fetch, env.id), items);
    expect(calls).toEqual([]);
    expect(items.map((i) => i.kind)).toEqual(["mail_bulk", "mail_bulk", "mail_bulk", "mail_bulk"]);
  });

  it("stops at the budget so one refresh cannot become a thousand inferences", async () => {
    const { env } = scratchEnv("imap-budget");
    const settings = defaultSettings();
    settings.ai.classifyMailLocally = true;
    settingsSave(env, settings);

    const { fetch, calls } = ollama("PERSON");
    const items = Array.from({ length: 40 }, () => ambiguous(-2));
    await refineWithModel(classifyingContext(fetch, env.id), items);
    expect(calls).toHaveLength(25);
    expect(items.filter((i) => i.kind === "mail")).toHaveLength(25);
  });

  it("does nothing at all on a fresh install, where classification is off", async () => {
    const { env } = scratchEnv("imap-off");
    settingsSave(env, defaultSettings());

    const { fetch, calls } = ollama("PERSON");
    const items = [ambiguous(-2)];
    await refineWithModel(classifyingContext(fetch, env.id), items);
    expect(calls).toEqual([]);
    expect(items[0]!.kind).toBe("mail_bulk");
  });

  it("leaves every item untouched when the provider fails", async () => {
    const { env } = scratchEnv("imap-provider-down");
    const settings = defaultSettings();
    settings.ai.classifyMailLocally = true;
    settingsSave(env, settings);

    const dead = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    const before = ambiguous(-2);
    const items = [ambiguous(-2)];
    await refineWithModel(classifyingContext(dead, env.id), items);
    expect(items[0]).toEqual(before);
  });
});
