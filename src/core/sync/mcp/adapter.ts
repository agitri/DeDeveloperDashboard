/**
 * `McpAdapter` — one more implementation of an existing port. Port of
 * `sync/mcp/adapter.rs`.
 *
 * Nothing in the sync engine, the cache, the scheduler or any widget learns
 * that MCP exists. That is the anti-corruption layer doing its job: this file
 * turns a protocol into `Item[]` and stops.
 *
 * `perform` is deliberately not implemented. The default politely refuses,
 * which is exactly right until tools become actions — and when they do, they go
 * through `item_action` like every other outbound thing, behind the approval
 * gate and unreachable from the AI layer.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DddError } from "../../error";
import type { Item } from "../../models";
import { configOf, refuse, requireConfig, type ActionRequest, type FetchContext, type SourceAdapter } from "../adapter";
import { run, type SyncReport } from "./client";
import { DEFAULT_KIND, type Mapping } from "./map";
import { checkConsent, openTransport, parseArgv, validateEndpoint } from "./transport";

/** Config keys this adapter reads. Named here so Settings and the adapter
 *  cannot drift apart silently. */
export const config = {
  /** `stdio` (default) or `http`. */
  TRANSPORT: "transport",
  /** A JSON array — never a shell string. See `parseArgv`. */
  COMMAND: "command",
  /** The token recorded when the user approved this exact command. */
  CONSENT: "consent",
  /** The environment variable the connection's secret is injected as. */
  TOKEN_ENV: "tokenEnv",
  /** Streamable HTTP endpoint. */
  ENDPOINT: "endpoint",
  /** What DDD's kinds should call these resources. */
  KIND: "kind",
} as const;

/** What the Rust read from `CARGO_PKG_VERSION`; core cannot import
 *  `package.json` under this tsconfig, so it is spelled out. */
const CLIENT_VERSION = "0.1.0";

export class McpAdapter implements SourceAdapter {
  readonly source = "mcp";

  async fetch(cx: FetchContext): Promise<Item[]> {
    return (await session(cx)).items;
  }

  /**
   * Probe a connection without writing anything: handshake, capabilities, tool
   * list, and a count of what one sync would produce.
   *
   * This is what the Settings card calls, and it is deliberately the same code
   * path as a real sync — a "test connection" that tests something else is
   * worse than none.
   */
  async probe(cx: FetchContext): Promise<SyncReport> {
    return (await session(cx)).report;
  }

  async perform(_cx: FetchContext, request: ActionRequest): Promise<string> {
    return refuse(this.source, request.action);
  }
}

/**
 * One connection, opened, synced and closed.
 *
 * The Rust had this twice, once in `fetch` and once in `probe`, and the two
 * copies had already drifted (the probe accepted an empty `kind` and treated an
 * unknown transport as stdio). One helper, with `fetch`'s stricter behaviour.
 */
async function session(cx: FetchContext): Promise<{ items: Item[]; report: SyncReport }> {
  const now = new Date().toISOString();
  const kind = configOf(cx, config.KIND);
  const mapping: Mapping = {
    environmentId: cx.environmentId,
    connectionId: cx.connection.id,
    kind: kind !== null && kind !== "" ? kind : DEFAULT_KIND,
    serverName: cx.connection.label,
    now,
  };
  const sync = { mapping, wantTools: true };

  const binding = configOf(cx, config.TRANSPORT) ?? "stdio";
  let transport;
  if (binding === "http") {
    const endpoint = validateEndpoint(requireConfig(cx, config.ENDPOINT));
    transport = openTransport({ kind: "http", endpoint, token: cx.token === "" ? null : cx.token });
  } else if (binding === "stdio") {
    const argv = parseArgv(requireConfig(cx, config.COMMAND));
    // The secret is injected at spawn and never written anywhere — which is why
    // the argv beside it can be stored in the clear.
    const tokenEnv = configOf(cx, config.TOKEN_ENV);
    const env = tokenEnv !== null && tokenEnv !== "" && cx.token !== "" ? { [tokenEnv]: cx.token } : {};
    // Before the transport exists, let alone a process: a scheduler tick must
    // never be the thing that starts a program.
    checkConsent(argv, configOf(cx, config.CONSENT));
    transport = openTransport({ kind: "stdio", argv, env });
  } else {
    throw DddError.config(`${binding} is not an MCP transport — use stdio or http`);
  }

  // No sampling, no roots, no elicitation: DDD reads, and declaring a
  // capability it does not implement would be a lie the server might act on.
  const client = new Client({ name: "DDD", version: CLIENT_VERSION }, { capabilities: {} });
  try {
    // The SDK's `connect` is the handshake: initialize, then
    // `notifications/initialized`, which the specification requires first.
    await client.connect(transport);
    return await run(client, sync);
  } finally {
    // Owned lifecycle: the server does not outlive the sync that started it,
    // whether or not that sync succeeded.
    await client.close();
  }
}
