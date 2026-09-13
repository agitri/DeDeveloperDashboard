/**
 * The sync itself: list, read, map. Port of `sync/mcp/client.rs`.
 *
 * Written against the SDK's `Client`, so every rule below — pagination, the
 * read budget, the audience filter, what happens when one resource fails — is
 * tested against an in-process server rather than a live one. That is the
 * point: Jira and Slack are implemented and unverifiable, and this must not
 * join them.
 *
 * The handshake the Rust performed by hand (`initialize`, then
 * `notifications/initialized`) is `Client.connect`'s job here, so `run` starts
 * from an already-connected client and reads the outcome back off it.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Item } from "../../models";
import { toItem, type Mapping } from "./map";
import {
  PAGE_CAP,
  READ_BUDGET,
  isForHumans,
  parseContents,
  parseInitialize,
  parsePage,
  parseTools,
  shouldRead,
  type Resource,
  type ServerInfo,
  type Tool,
} from "./protocol";
import { negotiatedVersion } from "./transport";

/** What one sync learned, beyond the items themselves. */
export interface SyncReport {
  server: ServerInfo;
  tools: Tool[];
  /** Resources annotated for models alone.
   *
   *  Worth showing rather than hiding: it is the difference between "this
   *  server has nothing for me" and "this server is talking to models, not to
   *  you." */
  skippedForModels: number;
  /** The page cap ended the listing, so there is more the board is not showing. */
  capped: boolean;
  /** Resources whose bodies were left unread because the budget ran out. */
  unreadBodies: number;
  /** Resources that failed to read. Skipped, so the rest of the sync survives. */
  failedReads: number;
}

export interface Sync {
  mapping: Mapping;
  /** Whether to ask for the tool list. Discovered, listed, and not callable. */
  wantTools: boolean;
}

/** List, then read what is worth reading. `client` must already be connected. */
export async function run(client: Client, sync: Sync): Promise<{ items: Item[]; report: SyncReport }> {
  const report: SyncReport = {
    server: parseInitialize(client.getServerCapabilities(), client.getServerVersion(), negotiatedVersion(client.transport)),
    tools: [],
    skippedForModels: 0,
    capped: false,
    unreadBodies: 0,
    failedReads: 0,
  };

  if (report.server.hasTools && sync.wantTools) {
    try {
      report.tools = parseTools(await client.listTools());
    } catch {
      // A server that says it has tools and then fails to list them is not a
      // reason to lose the resources.
    }
  }

  // A server without resources is a valid connection that yields nothing.
  if (!report.server.hasResources) return { items: [], report };

  const resources: Resource[] = [];
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < PAGE_CAP; pageNumber++) {
    const page = parsePage(await client.listResources(cursor === null ? undefined : { cursor }));
    resources.push(...page.resources);
    cursor = page.nextCursor;
    if (cursor === null) break;
    // A cursor that never terminates is a server bug to survive, not hang on —
    // so the cap ends it, and the fact that it capped is reported.
    if (pageNumber + 1 === PAGE_CAP) report.capped = true;
  }

  const before = resources.length;
  const forHumans = resources.filter(isForHumans);
  report.skippedForModels = before - forHumans.length;

  const items: Item[] = [];
  let reads = 0;
  for (const resource of forHumans) {
    let body: string | null = null;
    if (shouldRead(resource)) {
      if (reads < READ_BUDGET) {
        reads += 1;
        try {
          body = parseContents(await client.readResource({ uri: resource.uri }));
        } catch {
          // One resource failing to read must not cost the sync.
          report.failedReads += 1;
        }
      } else {
        // Past the budget the item still exists, without a body — a smaller
        // loss than a sync that takes a minute.
        report.unreadBodies += 1;
      }
    }
    items.push(toItem(resource, body, sync.mapping));
  }

  return { items, report };
}
