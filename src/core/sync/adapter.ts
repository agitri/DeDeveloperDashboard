/**
 * The adapter contract. Port of `sync/adapter.rs`.
 *
 * One interface, one normalized `Item`, one place where a new integration
 * plugs in. Adapters convert *into* the shared shape and nothing downstream
 * ever learns which service an item came from. Instantiated per connection,
 * not per provider — work GitHub and personal GitHub are two instances.
 *
 * What the Rust took from Tauri's managed state (the HTTP client) and the OS
 * (keychain, browser) arrives here as `SyncDeps`, so core stays free of
 * Electron and every adapter is testable with a fake `fetch`.
 *
 * Deliberately imports no adapter: `./providers` builds adapters from this
 * port, so this module stays a leaf and no cycle is possible at
 * module-evaluation time.
 */
import { DddError } from "../error";
import type { Emitter } from "../emitter";
import type { EnvRoot } from "../paths";
import type { Connection } from "../settings";
import type { Item } from "../models";

export interface SecretStore {
  get(env: EnvRoot, key: string): string | null;
  set(env: EnvRoot, key: string, value: string): void;
}

/** What the sync engine needs from the host. */
export interface SyncDeps {
  fetch: typeof globalThis.fetch;
  secrets: SecretStore;
  openUrl(url: string): Promise<void>;
  emit: Emitter;
}

export interface FetchContext {
  environmentId: string;
  connection: Connection;
  /** Read from the keychain at fetch time and never handed to anything else. */
  token: string;
  fetch: typeof globalThis.fetch;
  /** Only the adapters that route an AI action need it (IMAP classification);
   *  optional so every existing test context stays valid. */
  secrets?: SecretStore;
}

/** Connection-specific settings the user typed in, kept as loose strings so a
 *  new adapter never needs a change to the settings schema. */
export function configOf(cx: FetchContext, key: string): string | null {
  const v = cx.connection.config[key];
  return v === undefined ? null : v;
}

export function requireConfig(cx: FetchContext, key: string): string {
  const v = configOf(cx, key);
  if (v === null || v === "") throw DddError.config(`${key} is not set for ${cx.connection.label}`);
  return v;
}

/** `"400 Bad Request"`, or just `"400"` when the server sent no reason phrase
 *  — Rust's `StatusCode` Display always has one, `fetch`'s `statusText` is
 *  free to be empty. Never rewrite whatever comes after this in a message: a
 *  regex on the whole string risks eating a colon that belongs to the detail. */
export function statusLabel(response: { status: number; statusText: string }): string {
  return response.statusText ? `${response.status} ${response.statusText}` : `${response.status}`;
}

/** What the user is asking the adapter to do to one item. Every outbound
 *  variant is reachable only from an explicit click or keypress. */
export interface ActionRequest {
  action: string;
  item: Item;
  /** Comment body, transition name — whatever the action needs. */
  input: string | null;
}

export interface SourceAdapter {
  /** Matches `Item.source`, e.g. `github`. */
  readonly source: string;
  /** Pull everything this connection contributes, already normalized. */
  fetch(cx: FetchContext): Promise<Item[]>;
  /** Perform a user-approved action. Default: politely refuse. */
  perform(cx: FetchContext, request: ActionRequest): Promise<string>;
}

export function refuse(source: string, action: string): never {
  throw DddError.config(`${source} cannot ${action}`);
}

/** Stable, collision-proof item id: the connection prefix keeps work PR #142
 *  and personal PR #142 apart in one cache. */
export function itemId(connectionId: string, sourceKey: string): string {
  return `${connectionId}:${sourceKey}`;
}

// --- test helpers (no fs, no network) ------------------------------------------

export function memorySecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (env, key) => map.get(`${env.id}/${key}`) ?? null,
    set: (env, key, value) => {
      map.set(`${env.id}/${key}`, value);
    },
  };
}

export function fetchContext(partial: {
  environmentId?: string;
  connection?: Partial<Connection>;
  token?: string;
  fetch?: typeof globalThis.fetch;
}): FetchContext {
  return {
    environmentId: partial.environmentId ?? "e",
    connection: {
      id: "c",
      provider: "mock",
      label: "test",
      status: "connected",
      scopes: [],
      config: {},
      lastSyncAt: null,
      error: null,
      ...partial.connection,
    } as Connection,
    token: partial.token ?? "t",
    fetch: partial.fetch ?? (() => Promise.reject(new Error("no network in tests"))),
  };
}
