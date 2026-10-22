import { mkdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { scratchEnv } from "../testing";
import { recordingEmitter } from "../emitter";
import { DddError } from "../error";
import { globalAppearanceSave, globalLoad } from "../global";
import { defaultSettings, settingsLoad, settingsSave, type Connection } from "../settings";
import { memorySecrets } from "./adapter";
import { query } from "./cache";
import * as events from "../events";
import { Scheduler, TICK_MS } from "./scheduler";

const conn = (extra: Partial<Connection> = {}): Connection => ({
  id: "mock-1",
  provider: "mock",
  label: "Mock",
  status: "disconnected",
  scopes: [],
  config: {},
  lastSyncAt: null,
  error: null,
  ...extra,
});

function deps(fetch?: typeof globalThis.fetch) {
  const emitter = recordingEmitter();
  const secrets = memorySecrets();
  return {
    deps: {
      fetch: fetch ?? (async () => new Response("{}", { status: 500, statusText: "Internal Server Error" })),
      secrets,
      openUrl: async () => {},
      emit: emitter,
    },
    emitter,
    secrets,
  };
}

describe("due", () => {
  it("is due immediately when never run, then after the interval, and again after invalidate", () => {
    const s = new Scheduler(deps().deps);
    expect(s.due("c", 1000)).toBe(true);
    s.mark("c");
    expect(s.due("c", 1000)).toBe(false);
    expect(s.due("c", 0)).toBe(true);
    s.invalidate("c");
    expect(s.due("c", 1000)).toBe(true);
  });
  it("ticks every twenty seconds", () => {
    expect(TICK_MS).toBe(20_000);
  });
});

describe("syncing one connection", () => {
  it("fills the cache, records the outcome, logs sync.fetch and emits items-changed", async () => {
    const { env } = scratchEnv("sync-ok");
    const s = defaultSettings();
    s.connections.push(conn());
    settingsSave(env, s);
    const d = deps();
    const count = await new Scheduler(d.deps).syncConnection(env, conn());
    expect(count).toBe(10);
    expect(query(env, { connectionId: "mock-1" })).toHaveLength(10);
    const stored = settingsLoad(env).connections[0]!;
    expect(stored.status).toBe("connected");
    expect(stored.error).toBeNull();
    expect(stored.lastSyncAt).toMatch(/^\d{4}-/);
    expect(events.query(env, { kindPrefix: "sync.", limit: 10 })[0]).toMatchObject({
      kind: "sync.fetch",
      source: "mock",
      meta: { items: 10 },
    });
    expect(d.emitter.events).toEqual([{ name: "ddd://items-changed", payload: { environmentId: "default", connectionId: "mock-1" } }]);
  });

  it("records disconnected when there is no token, for every provider but mock", async () => {
    const { env } = scratchEnv("sync-notoken");
    const s = defaultSettings();
    s.connections.push(conn({ id: "gh", provider: "github" }));
    settingsSave(env, s);
    const d = deps();
    expect(await new Scheduler(d.deps).syncConnection(env, conn({ id: "gh", provider: "github" }))).toBe(0);
    const stored = settingsLoad(env).connections[0]!;
    expect(stored.status).toBe("disconnected");
    expect(stored.error).toBe("no token stored");
    expect(d.emitter.events).toEqual([]);
  });

  it("marks 401/403 as expired and anything else as error, keeps the old snapshot, and still emits", async () => {
    const { env } = scratchEnv("sync-fail");
    const s = defaultSettings();
    s.connections.push(conn({ id: "gh", provider: "github" }));
    settingsSave(env, s);
    const d = deps(async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, statusText: "Unauthorized" }));
    d.secrets.set(env, "gh", "PAT");
    await expect(new Scheduler(d.deps).syncConnection(env, conn({ id: "gh", provider: "github" }))).rejects.toThrow(
      "github 401 Unauthorized: Bad credentials",
    );
    expect(settingsLoad(env).connections[0]).toMatchObject({ status: "expired", error: "github 401 Unauthorized: Bad credentials" });
    expect(d.emitter.events.map((e) => e.name)).toEqual(["ddd://items-changed"]);
    const d2 = deps(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" }));
    d2.secrets.set(env, "gh", "PAT");
    await expect(new Scheduler(d2.deps).syncConnection(env, conn({ id: "gh", provider: "github" }))).rejects.toThrow();
    expect(settingsLoad(env).connections[0]!.status).toBe("error");
  });

  it("skips a provider with no adapter", async () => {
    const { env } = scratchEnv("sync-noadapter");
    expect(await new Scheduler(deps().deps).syncConnection(env, conn({ id: "j", provider: "jira" }))).toBe(0);
  });

  it("does not relabel or re-emit when a local cache write fails after a successful fetch", async () => {
    const { env } = scratchEnv("sync-cache-fail");
    const s = defaultSettings();
    s.connections.push(conn());
    settingsSave(env, s);
    // A directory where cache.sqlite should be: DatabaseSync cannot open it.
    mkdirSync(env.cacheDb(), { recursive: true });
    const d = deps();
    let caught: unknown;
    try {
      await new Scheduler(d.deps).syncConnection(env, conn());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DddError);
    expect((caught as DddError).kind).toBe("sqlite");
    const stored = settingsLoad(env).connections[0]!;
    expect(stored.status).toBe("disconnected");
    expect(stored.error).toBeNull();
    expect(d.emitter.events).toEqual([]);
  });
});

describe("the tick", () => {
  it("syncs every due connection of every environment at the global cadence, marking before fetching", async () => {
    const { env } = scratchEnv("tick");
    globalLoad();
    const s = defaultSettings();
    s.connections.push(conn(), conn({ id: "mock-2" }));
    settingsSave(env, s);
    const d = deps();
    const sched = new Scheduler(d.deps);
    await sched.tick();
    expect(query(env, {})).toHaveLength(20);
    expect(d.emitter.events).toHaveLength(2);
    // Cadence is global appearance.defaultRefreshSeconds, floored at 30 s: nothing is due again.
    await sched.tick();
    expect(d.emitter.events).toHaveLength(2);
    sched.invalidate("mock-2");
    await sched.tick();
    expect(d.emitter.events).toHaveLength(3);
    expect(d.emitter.events[2]!.payload).toEqual({ environmentId: "default", connectionId: "mock-2" });
    // A refresh setting below 30 s is still 30 s.
    globalAppearanceSave({ ...globalLoad().appearance, defaultRefreshSeconds: 1 });
    await sched.tick();
    expect(d.emitter.events).toHaveLength(3);
  });

  it("start and stop own the timer", () => {
    scratchEnv("start-stop");
    vi.useFakeTimers();
    try {
      const sched = new Scheduler(deps().deps);
      sched.start();
      expect(vi.getTimerCount()).toBe(1);
      // Starting again must not install a second timer.
      sched.start();
      expect(vi.getTimerCount()).toBe(1);
      sched.stop();
      expect(vi.getTimerCount()).toBe(0);
      // Stopping an already-stopped scheduler is a no-op, not an error.
      sched.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
