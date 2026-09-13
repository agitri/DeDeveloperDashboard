/**
 * Resource → `Item`. The anti-corruption layer, at its narrowest. Port of
 * `sync/mcp/map.rs`.
 *
 * Pure over its inputs, because this is where a third party's data becomes
 * DDD's data and every rule about what is allowed through belongs somewhere it
 * can be read and tested.
 */
import type { Item } from "../../models";
import { itemId } from "../adapter";
import type { Resource } from "./protocol";

/**
 * What an MCP resource becomes when a connection does not say otherwise.
 *
 * DDD's kinds are a product vocabulary — `pull_request`, `issue`, `mail` — and
 * a generic server cannot know them, so the default is deliberately generic and
 * the connection can override it.
 */
export const DEFAULT_KIND = "resource";

export interface Mapping {
  environmentId: string;
  connectionId: string;
  /** `Connection.config["kind"]`, so a user pointing DDD at an issue-tracker
   *  server can label its output `issue` and have existing widget filters work
   *  unchanged. */
  kind: string;
  /** The server's declared name, kept in `refs` so an item can say where it
   *  came from without the widget learning what MCP is. */
  serverName: string;
  /** Fallback for `updatedAt` when the resource does not date itself. */
  now: string;
}

export function toItem(resource: Resource, body: string | null, mapping: Mapping): Item {
  const refs = [`mcp:${resource.uri}`];
  if (resource.mimeType !== null && resource.mimeType !== "") refs.push(`mime:${resource.mimeType}`);
  const priority = resource.annotations?.priority ?? null;
  if (priority !== null) refs.push(`priority:${priority}`);
  if (mapping.serverName !== "") refs.push(`server:${mapping.serverName}`);

  // `title` is the display name when a server distinguishes it; `name` is the
  // programmatic one. Falling back to the URI keeps a nameless resource
  // addressable rather than blank.
  const named = resource.title ?? resource.name;
  const chosenBody = body ?? resource.description;
  const lastModified = resource.annotations?.lastModified ?? null;

  return {
    id: itemId(mapping.connectionId, resource.uri),
    environmentId: mapping.environmentId,
    connectionId: mapping.connectionId,
    source: "mcp",
    kind: mapping.kind,
    project: null,
    title: named !== null && named.trim() !== "" ? named : resource.uri,
    body: chosenBody !== null && chosenBody.trim() !== "" ? chosenBody : null,
    url: clickable(resource.uri),
    refs,
    actions: [],
    updatedAt: lastModified !== null && lastModified !== "" ? lastModified : mapping.now,
    // An MCP server has no concept of your having read anything.
    unread: false,
  };
}

/**
 * Which URIs become clickable links.
 *
 * A resource URI may be `file://`, `git://`, or any custom scheme, and it
 * arrives from a third-party server. Only `http` and `https` become a `url`;
 * everything else stays in `refs`, where it is data rather than something a
 * click hands to the operating system. The same rule the calendar applies to
 * `webcal://` and the notes parser to `javascript:`, for the same reason.
 */
export function clickable(uri: string): string | null {
  const trimmed = uri.trim();
  const lower = trimmed.toLowerCase();
  return lower.startsWith("https://") || lower.startsWith("http://") ? trimmed : null;
}
