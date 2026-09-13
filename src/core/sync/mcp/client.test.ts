import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  LATEST_PROTOCOL_VERSION,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { run } from "./client";
import { DEFAULT_KIND, type Mapping } from "./map";
import { PAGE_CAP, READ_BUDGET } from "./protocol";
import { rememberProtocolVersion } from "./transport";

function mapping(): Mapping {
  return {
    environmentId: "default",
    connectionId: "c1",
    kind: DEFAULT_KIND,
    serverName: "files",
    now: "2026-09-04T10:00:00Z",
  };
}

const sync = () => ({ mapping: mapping(), wantTools: true });

/**
 * A server that exists only in this process — the SDK's own `Server` over its
 * in-memory transport pair. The whole reason the client is written against the
 * SDK's `Client`: an integration that cannot be tested without an instance is
 * the failure Jira and Slack already demonstrate.
 */
async function fake(options: {
  capabilities: ServerCapabilities;
  /** `resources/list` replies, in order; the last one repeats, so a single
   *  scripted answer serves any number of calls. */
  pages?: unknown[];
  /** The `tools/list` reply, or nothing at all for a server that declares
   *  tools and then cannot list them. */
  tools?: unknown;
  unreadable?: string[];
}): Promise<{ client: Client; server: Server; calls: string[]; initializedBefore: number; close: () => Promise<void> }> {
  const calls: string[] = [];
  const server = new Server({ name: "files", version: "1.0.0" }, { capabilities: options.capabilities });
  const state = { initializedBefore: -1 };
  server.oninitialized = () => {
    state.initializedBefore = calls.length;
  };

  if (options.capabilities.resources !== undefined) {
    let page = 0;
    server.setRequestHandler(ListResourcesRequestSchema, () => {
      calls.push("resources/list");
      const pages = options.pages ?? [{ resources: [] }];
      const reply = pages[Math.min(page, pages.length - 1)];
      page += 1;
      return reply as { resources: [] };
    });
    server.setRequestHandler(ReadResourceRequestSchema, (request) => {
      calls.push("resources/read");
      const uri = request.params.uri;
      if ((options.unreadable ?? []).includes(uri)) throw new Error("Resource not found (-32002)");
      return { contents: [{ uri, text: `body of ${uri}` }] };
    });
  }
  if (options.tools !== undefined) {
    server.setRequestHandler(ListToolsRequestSchema, () => {
      calls.push("tools/list");
      return options.tools as { tools: [] };
    });
  }

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "DDD", version: "0.1.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverSide), client.connect(rememberProtocolVersion(clientSide))]);
  return {
    client,
    server,
    calls,
    get initializedBefore() {
      return state.initializedBefore;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const callsTo = (calls: string[], method: string) => calls.filter((c) => c === method).length;

const RESOURCES: ServerCapabilities = { resources: {} };
const RESOURCES_AND_TOOLS: ServerCapabilities = { resources: {}, tools: {} };

describe("one sync", () => {
  it("syncs the human half and counts the model half", async () => {
    const f = await fake({
      capabilities: RESOURCES,
      pages: [
        {
          resources: [
            { uri: "https://x/1", name: "For you", description: "a summary", annotations: { audience: ["user"] } },
            { uri: "x://2", name: "For the model", description: "context", annotations: { audience: ["assistant"] } },
            { uri: "x://3", name: "Unannotated", description: "still yours" },
          ],
        },
      ],
    });
    const { items, report } = await run(f.client, sync());
    expect(items).toHaveLength(2);
    expect(report.skippedForModels).toBe(1); // counted, not hidden
    expect(items[0]!.title).toBe("For you");
    expect(items[0]!.url).toBe("https://x/1");
    expect(items[1]!.url).toBeNull(); // a custom scheme is not a link
    await f.close();
  });

  it("completes the handshake before anything is asked for, declaring no capability DDD does not implement", async () => {
    // The SDK performs the handshake inside `connect`, so this asserts what the
    // server saw: the client arrived, said who it was, and claimed nothing —
    // declaring sampling or roots would be a lie a server might act on.
    const f = await fake({ capabilities: RESOURCES });
    expect(f.initializedBefore).toBe(0); // initialized before the first request
    expect(f.server.getClientVersion()).toEqual({ name: "DDD", version: "0.1.0" });
    expect(f.server.getClientCapabilities()).toEqual({});
    const { report } = await run(f.client, sync());
    expect(report.server.name).toBe("files");
    expect(report.server.version).toBe("1.0.0");
    // The version the server answered, recovered from the transport.
    expect(report.server.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    await f.close();
  });

  it("treats a server with no resources as valid, yielding nothing", async () => {
    const f = await fake({ capabilities: { tools: {} }, tools: { tools: [] } });
    const { items, report } = await run(f.client, sync());
    expect(items).toEqual([]);
    expect(report.server.hasResources).toBe(false);
    expect(callsTo(f.calls, "resources/list")).toBe(0); // and it is not even asked
    await f.close();
  });

  it("follows the cursor and stops at the cap", async () => {
    // A cursor that never terminates: the cap ends it, and says it did.
    const f = await fake({
      capabilities: RESOURCES,
      pages: [{ resources: [{ uri: "x://loop", name: "Loop", description: "d" }], nextCursor: "always-more" }],
    });
    const { items, report } = await run(f.client, sync());
    expect(callsTo(f.calls, "resources/list")).toBe(PAGE_CAP);
    expect(report.capped).toBe(true); // a board must say when it is not showing everything
    expect(items).toHaveLength(PAGE_CAP);
    await f.close();
  });

  it("does not report a cap for a finished listing", async () => {
    const f = await fake({
      capabilities: RESOURCES,
      pages: [
        { resources: [{ uri: "x://1", name: "One", description: "d" }], nextCursor: "p2" },
        { resources: [{ uri: "x://2", name: "Two", description: "d" }] },
      ],
    });
    const { items, report } = await run(f.client, sync());
    expect(items).toHaveLength(2);
    expect(callsTo(f.calls, "resources/list")).toBe(2);
    expect(report.capped).toBe(false);
    await f.close();
  });

  it("spends no round trip on a described resource", async () => {
    // Listing is cheap and reading is not. A description is already a body.
    const f = await fake({
      capabilities: RESOURCES,
      pages: [{ resources: [{ uri: "x://1", name: "One", description: "already a body" }] }],
    });
    const { items } = await run(f.client, sync());
    expect(callsTo(f.calls, "resources/read")).toBe(0);
    expect(items[0]!.body).toBe("already a body");
    await f.close();
  });

  it("bounds the round trips by the read budget and still returns every item", async () => {
    const many = Array.from({ length: READ_BUDGET + 15 }, (_, i) => ({
      uri: `x://${i}`,
      name: `r${i}`,
      mimeType: "text/plain",
    }));
    const f = await fake({ capabilities: RESOURCES, pages: [{ resources: many }] });
    const { items, report } = await run(f.client, sync());
    expect(items).toHaveLength(READ_BUDGET + 15); // nothing is dropped
    expect(callsTo(f.calls, "resources/read")).toBe(READ_BUDGET);
    expect(report.unreadBodies).toBe(15);
    expect(items[0]!.body).not.toBeNull();
    expect(items.at(-1)!.body).toBeNull(); // past the budget: an item, no body
    await f.close();
  });

  it("does not lose the sync to one resource that will not read", async () => {
    const f = await fake({
      capabilities: RESOURCES,
      pages: [
        {
          resources: [
            { uri: "x://broken", name: "Broken", mimeType: "text/plain" },
            { uri: "x://fine", name: "Fine", mimeType: "text/plain" },
          ],
        },
      ],
      unreadable: ["x://broken"],
    });
    const { items, report } = await run(f.client, sync());
    expect(items).toHaveLength(2); // the item survives without its body
    expect(report.failedReads).toBe(1);
    expect(items[0]!.body).toBeNull();
    expect(items[1]!.body).toBe("body of x://fine");
    await f.close();
  });

  it("lists tools and never turns them into actions", async () => {
    const f = await fake({
      capabilities: RESOURCES_AND_TOOLS,
      pages: [{ resources: [{ uri: "x://1", name: "One", description: "d" }] }],
      tools: { tools: [{ name: "search", description: "find things", inputSchema: { type: "object" } }] },
    });
    const { items, report } = await run(f.client, sync());
    expect(report.tools).toHaveLength(1);
    expect(report.tools[0]!.name).toBe("search");
    // Discovered and inert: an item offering one would be offering something
    // that cannot be performed.
    expect(items.every((i) => i.actions.length === 0)).toBe(true);
    await f.close();
  });

  it("does not ask for tools when the sync does not want them", async () => {
    const f = await fake({
      capabilities: RESOURCES_AND_TOOLS,
      pages: [{ resources: [] }],
      tools: { tools: [{ name: "search", inputSchema: { type: "object" } }] },
    });
    const { report } = await run(f.client, { mapping: mapping(), wantTools: false });
    expect(report.tools).toEqual([]);
    expect(callsTo(f.calls, "tools/list")).toBe(0);
    await f.close();
  });

  it("still delivers resources for a server that cannot list its tools", async () => {
    // Declared `tools`, no handler: the SDK answers "Method not found", which
    // is not a reason to lose the resources.
    const f = await fake({
      capabilities: RESOURCES_AND_TOOLS,
      pages: [{ resources: [{ uri: "x://1", name: "One", description: "d" }] }],
    });
    const { items, report } = await run(f.client, sync());
    expect(items).toHaveLength(1);
    expect(report.tools).toEqual([]);
    await f.close();
  });

  it("fails the sync on a handshake that fails, and writes nothing", async () => {
    // The SDK handshakes inside `connect`, so the failure surfaces there and
    // `run` is never reached — which is the same guarantee, one step earlier.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    serverSide.onmessage = (message) => {
      if ("id" in message && message.id !== undefined) {
        void serverSide.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "connection refused" } });
      }
    };
    await serverSide.start();
    const client = new Client({ name: "DDD", version: "0.1.0" }, { capabilities: {} });
    await expect(client.connect(rememberProtocolVersion(clientSide))).rejects.toThrow("connection refused");
    await client.close();
  });
});
