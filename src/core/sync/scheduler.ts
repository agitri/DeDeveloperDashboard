/**
 * The central scheduler. Port of `sync/scheduler.rs`.
 *
 * One loop for the whole app. Widgets declare what they need and read from
 * the cache; they never poll. Twelve widgets over one GitHub connection cost
 * exactly what one widget costs, which is the only way this survives contact
 * with API rate limits. This is the only writer of the item cache.
 */
import * as events from "../events";
import { globalLoad } from "../global";
import { EnvRoot } from "../paths";
import { settingsLoad, settingsSave, type Connection, type ConnectionStatus } from "../settings";
import type { Item } from "../models";
import type { FetchContext, SyncDeps } from "./adapter";
import { forProvider } from "./providers";
import * as cache from "./cache";
import { accessToken } from "./oauth";

/** How often the loop wakes to see what is due. Not how often anything syncs —
 *  that is per connection, from settings. */
export const TICK_MS = 20_000;

/** Write sync outcome back onto the connection record. */
export function record(env: EnvRoot, connectionId: string, status: ConnectionStatus, error: string | null): void {
  const settings = settingsLoad(env);
  const connection = settings.connections.find((c) => c.id === connectionId);
  if (!connection) return;
  connection.status = status;
  connection.error = error;
  if (status === "connected") connection.lastSyncAt = new Date().toISOString();
  settingsSave(env, settings);
}

export class Scheduler {
  /** Connection id → when it last completed a fetch (ms since epoch). */
  private lastRun = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: SyncDeps) {}

  due(connectionId: string, everyMs: number): boolean {
    const last = this.lastRun.get(connectionId);
    // Never run: due immediately, so a freshly connected account fills the
    // board rather than making you wait out a refresh interval.
    if (last === undefined) return true;
    return Date.now() - last >= everyMs;
  }

  mark(connectionId: string): void {
    this.lastRun.set(connectionId, Date.now());
  }

  /** Force the next tick to treat this connection as due. */
  invalidate(connectionId: string): void {
    this.lastRun.delete(connectionId);
  }

  /** Sync one connection now and write the result into the cache. Returns how
   *  many items it contributed. Errors are recorded on the connection rather
   *  than thrown away, because "expired" is something the Connections page has
   *  to be able to show — and then rethrown, as the Rust's `Err(e)` is. */
  async syncConnection(env: EnvRoot, connection: Connection): Promise<number> {
    const adapter = forProvider(connection.provider);
    if (!adapter) return 0;

    // OAuth connections refresh here, transparently: an adapter never learns
    // whether its credential came from a consent flow or from a pasted token.
    const token = await accessToken(env, connection, this.deps).catch(() => "");
    // The mock adapter is the one source that needs no credential.
    if (token === "" && connection.provider !== "mock") {
      record(env, connection.id, "disconnected", "no token stored");
      return 0;
    }

    const cx: FetchContext = { environmentId: env.id, connection, token, fetch: this.deps.fetch };
    const payload = { environmentId: env.id, connectionId: connection.id };
    // Only the fetch itself is covered by the failure handling below: once it
    // has succeeded, a local disk/sqlite problem is not the adapter's fault
    // and must not be relabeled expired/error from an unrelated message, nor
    // overwrite the connection a second time.
    let items: Item[];
    try {
      items = await adapter.fetch(cx);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 401/403 means the credential is the problem, which is a different
      // thing for the user to do about it than a network blip.
      const status: ConnectionStatus = message.includes("401") || message.includes("403") ? "expired" : "error";
      record(env, connection.id, status, message);
      this.deps.emit.emit("ddd://items-changed", payload);
      throw e;
    }
    cache.replaceForConnection(env, connection.id, items);
    record(env, connection.id, "connected", null);
    try {
      events.log(env, { kind: "sync.fetch", source: connection.provider, meta: { items: items.length } });
    } catch {
      /* a dropped stat never interrupts a sync */
    }
    this.deps.emit.emit("ddd://items-changed", payload);
    return items.length;
  }

  /** One pass over every environment's connections. */
  async tick(): Promise<void> {
    const global = globalLoad();
    // Refresh cadence is global: it is about how hard you want the machine
    // hitting the network, not about which environment you are looking at.
    const everyMs = Math.max(global.appearance.defaultRefreshSeconds, 30) * 1000;
    for (const environment of global.environments) {
      const env = EnvRoot.open(environment.id);
      const settings = settingsLoad(env);
      for (const connection of settings.connections) {
        if (!this.due(connection.id, everyMs)) continue;
        // Marked before the fetch, not after: a slow or failing connection
        // must not be retried on every tick.
        this.mark(connection.id);
        await this.syncConnection(env, connection).catch(() => undefined);
      }
    }
  }

  /** The loop. Started once at app setup and left running. */
  start(): void {
    if (this.timer) return;
    const run = () => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick()
        .catch((e) => console.error(`ddd: scheduler tick failed: ${e instanceof Error ? e.message : e}`))
        .finally(() => {
          this.ticking = false;
        });
    };
    run();
    this.timer = setInterval(run, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
