import { afterAll, describe, expect, it, vi } from "vitest";
import * as probe from "../core/dev/probe";
import { MEMO_FLOOR_MS } from "../core/dev/board";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve, join } from "node:path";
import { scratchEnv } from "../core/testing";
import { HOST_COMMANDS, createCommands } from "./commands";
import { recordingEmitter } from "../core/emitter";
import { ProjectWatcher, type ProjectChanged } from "../core/watcher";
import { EnvRoot } from "../core/paths";
import { Scheduler } from "../core/sync/scheduler";
import { memorySecrets } from "../core/sync/adapter";
import { defaultSettings, settingsSave, type Connection } from "../core/settings";
import { register, registry } from "../core/projects";
import type { Item } from "../core/models";
import { replaceForConnection } from "../core/sync/cache";
import { toItems } from "../core/sync/ics";
import { load as calendarLoad } from "../core/calendar/store";
import * as links from "../core/repos/links";
import { normalize } from "../core/repos/remote";
import { consentToken, parseArgv } from "../core/sync/mcp/transport";

const emitter = recordingEmitter();
const sync = { fetch: (async () => new Response("{}", { status: 500 })) as typeof globalThis.fetch, secrets: memorySecrets(), openUrl: async () => {}, emit: emitter };
const scheduler = new Scheduler(sync);
const watcher = new ProjectWatcher(emitter);
const commands = createCommands({ emit: emitter, watcher, scheduler, sync });
afterAll(() => watcher.close());

const TAURI_LIB = resolve(__dirname, "../../../DDD/src-tauri/src/lib.rs");

/** The names Tauri registers, read from the source of truth when it is around. */
function tauriHandlers(): string[] | null {
  if (!existsSync(TAURI_LIB)) return null;
  const src = readFileSync(TAURI_LIB, "utf8");
  const block = src.slice(src.indexOf("generate_handler![") + "generate_handler![".length);
  const body = block.slice(0, block.indexOf("]"));
  return [...body.matchAll(/commands::(\w+)/g)].map((m) => m[1]!);
}

/**
 * Every Tauri command phase 0 has deliberately not ported yet. Built from the
 * diff of the two lists at the time of writing — a NEW command landing in
 * `lib.rs` is not in this set, so it fails the test below until someone
 * acknowledges it here (by porting it, or by adding it to this list).
 */
const NOT_YET_PORTED = new Set([
  "products_list",
  "product_approve",
  "product_revoke",
  "product_start",
  "product_stop",
  "product_log",
]);

describe("the command registry", () => {
  it.skipIf(tauriHandlers() === null)("only registers names the Tauri app has, so the frontend contract holds", () => {
    const known = new Set(tauriHandlers()!);
    const invented = Object.keys(commands).filter((name) => !known.has(name) && !HOST_COMMANDS.includes(name));
    expect(invented).toEqual([]);
  });

  it.skipIf(tauriHandlers() === null)(
    "every Tauri command is either registered or acknowledged as not yet ported",
    () => {
      const unaccountedFor = tauriHandlers()!.filter(
        (name) => !(name in commands) && !NOT_YET_PORTED.has(name),
      );
      expect(unaccountedFor).toEqual([]);
    },
  );

  it("dispatches with the Tauri argument keys", async () => {
    const { home } = scratchEnv("registry");
    const g = (await commands.global_load!({})) as { activeEnvironmentId: string };
    expect(g.activeEnvironmentId).toBe("default");
    await commands.environment_create!({ id: "work", name: "Work", color: "#000" });
    await commands.layout_save!({ env: "work", layout: { version: 1, groups: [], tabs: [] } });
    expect(await commands.path_exists!({ path: `${home}/environments/work/layout.json` })).toBe(true);
    await commands.event_log!({ env: "work", event: { kind: "tab.switch" } });
    const rows = (await commands.events_query!({ env: "work", kindPrefix: "tab." })) as unknown[];
    expect(rows).toHaveLength(1);
    const info = (await commands.paths_info!({ env: "work" })) as { environmentDir: string };
    expect(info.environmentDir).toBe(`${home}/environments/work`);
  });

  it("validates layout_save's input instead of writing it as-is", async () => {
    const { home } = scratchEnv("registry-layout-validate");
    expect(() =>
      commands.layout_save!({ env: "default", layout: { tabs: [{ id: "t" }] } }),
    ).toThrow(/missing field `name`/);

    await commands.layout_save!({ env: "default", layout: { tabs: [{ id: "t", name: "T" }] } });
    const onDisk = JSON.parse(readFileSync(`${home}/environments/default/layout.json`, "utf8"));
    expect(onDisk.tabs[0].widgets).toEqual([]);
    expect(onDisk.groups).toEqual([]);
  });
});

describe("project commands", () => {
  it("register, list, reload, unregister — with the Tauri argument keys", async () => {
    scratchEnv("registry-projects");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-proj-")));
    mkdirSync(join(dir, ".ddd"));
    writeFileSync(join(dir, ".ddd", "config.json"), JSON.stringify({ name: "Cmd" }));

    expect(await commands.projects_list!({ env: "default" })).toEqual([]);
    const card = (await commands.project_register!({ env: "default", path: dir })) as { id: string; name: string; exists: boolean };
    expect(card.name).toBe("Cmd");
    expect(card.exists).toBe(true);
    const listed = (await commands.projects_list!({ env: "default" })) as { id: string }[];
    expect(listed.map((p) => p.id)).toEqual([card.id]);
    const reloaded = (await commands.project_reload!({ env: "default", id: card.id })) as { name: string };
    expect(reloaded.name).toBe("Cmd");
    await expect(commands.project_reload!({ env: "default", id: "nope" })).rejects.toThrow('project "nope"');
    await commands.project_unregister!({ env: "default", id: card.id });
    expect(await commands.projects_list!({ env: "default" })).toEqual([]);
  });

  it("lists editors and terminals without throwing", async () => {
    expect(Array.isArray(await commands.editors_list!({}))).toBe(true);
    expect(Array.isArray(await commands.terminals_list!({}))).toBe(true);
  });

  it("launching a project logs an event and honours a project's own terminal template", async () => {
    const { env } = scratchEnv("registry-launch");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-launch-")));
    const proof = join(dir, "proof.txt");
    mkdirSync(join(dir, ".ddd"));
    // The project's config wins over the global terminal, and a template is
    // a full command — so this launches nothing visible.
    writeFileSync(join(dir, ".ddd", "config.json"), JSON.stringify({ terminal: `/bin/sh -c "echo {cmd} > ${proof}"` }));
    const card = (await commands.project_register!({ env: "default", path: dir })) as { id: string };
    await commands.project_launch!({ env: "default", id: card.id });
    for (let i = 0; i < 50 && !existsSync(proof); i++) await new Promise((r) => setTimeout(r, 20));
    expect(readFileSync(proof, "utf8").trim()).toBe("claude");
    const rows = (await commands.events_query!({ env: "default", kindPrefix: "project." })) as { kind: string; project: string }[];
    expect(rows[0]).toMatchObject({ kind: "project.launch", project: basename(dir) });
    void env;
  });

  it("refuses to launch or open what is not there", async () => {
    await expect(commands.launch_path!({ path: "/nowhere/at/all" })).rejects.toThrow("is not a directory");
    await expect(commands.open_in_editor!({ path: "/nowhere/at/all" })).rejects.toThrow("is not a directory");
  });
});

// Gives up loudly on timeout instead of quietly returning — see watcher.test.ts.
const until = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 >= ms) throw new Error(`until: condition not met within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

// `fs.watch({ recursive: true })` on macOS becomes live asynchronously —
// FSEvents startup latency — and libuv only streams changes from "now", so a
// write made before the watch is actually live is never delivered. The retry
// re-runs the whole test with a fresh temp dir and the same strict
// assertions, so a genuinely broken end-to-end path still fails every time.
describe("the .ddd contract through the commands", { retry: 2 }, () => {
  it(
    "project_register's watch notices a real todos.json write, end to end",
    async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-e2e-")));
      mkdirSync(join(dir, ".ddd"));
      const card = (await commands.project_register!({ env: "default", path: dir })) as { id: string };
      await new Promise((r) => setTimeout(r, 500));
      writeFileSync(join(dir, ".ddd", "todos.json"), '{"todos":[]}');
      // Filtered to this test's own project: earlier tests in this file leave
      // their (already-populated) .ddd folders under the same, never-closed
      // watcher, and re-registering rebuilds every watch wholesale — a fresh
      // recursive watch on a directory that already has content can itself
      // replay one startup event for that content, same family of FSEvents
      // quirk as watcher.ts's isSelfNamedReplay, just for a different project.
      const isOurs = (e: { name: string; payload: unknown }) =>
        e.name === "ddd://project-changed" && (e.payload as ProjectChanged).projectId === card.id;
      await until(() => emitter.events.some(isOurs), 8000);
      const event = emitter.events.find(isOurs)!;
      expect(event.payload).toEqual({ environmentId: "default", projectId: card.id });
    },
    15000,
  );
});

describe("sync commands", () => {
  const mock = (): Connection => ({ id: "mock-1", provider: "mock", label: "Mock", status: "disconnected", scopes: [], config: {}, lastSyncAt: null, error: null });

  it("sync_now fills the cache, items_query reads it, cache_clear empties it", async () => {
    scratchEnv("cmd-sync");
    const s = defaultSettings();
    s.connections.push(mock());
    settingsSave(EnvRoot.open("default"), s);
    expect(await commands.sync_now!({ env: "default", connectionId: null })).toBe(10);
    const all = (await commands.items_query!({ env: "default", filter: {} })) as { kind: string }[];
    expect(all).toHaveLength(10);
    const mail = (await commands.items_query!({ env: "default", filter: { kind: "mail" } })) as unknown[];
    expect(mail).toHaveLength(2);
    await expect(commands.items_query!({ env: "default", filter: { limit: "x" } })).rejects.toThrow(/^json: /);
    expect(await commands.sync_now!({ env: "default", connectionId: "other" })).toBe(0);
    await commands.cache_clear!({ env: "default" });
    expect(await commands.items_query!({ env: "default", filter: {} })).toEqual([]);
  });

  it("item_action is the gate: performs through the adapter, logs item.<action>, invalidates the connection", async () => {
    scratchEnv("cmd-action");
    const s = defaultSettings();
    s.connections.push(mock());
    settingsSave(EnvRoot.open("default"), s);
    await commands.sync_now!({ env: "default" });
    const [first] = (await commands.items_query!({ env: "default", filter: { kind: "pull_request" } })) as { id: string; title: string }[];
    const out = await commands.item_action!({ env: "default", itemId: first!.id, action: "comment", input: "hi" });
    expect(out).toBe(`mock: comment on ${first!.title} (hi)`);
    const rows = (await commands.events_query!({ env: "default", kindPrefix: "item." })) as { kind: string; source: string; project: string }[];
    expect(rows[0]).toMatchObject({ kind: "item.comment", source: "mock", project: "ddd" });
    expect(scheduler.due("mock-1", 1_000_000)).toBe(true);
    await expect(commands.item_action!({ env: "default", itemId: "nope", action: "comment" })).rejects.toThrow('item "nope"');
  });

  it("connection_connect needs a known connection; connection_uses_oauth knows the providers", async () => {
    scratchEnv("cmd-connect");
    settingsSave(EnvRoot.open("default"), defaultSettings());
    await expect(commands.connection_connect!({ env: "default", connectionId: "nope" })).rejects.toThrow('connection "nope"');
    expect(await commands.connection_uses_oauth!({ provider: "mail.gmail" })).toBe(true);
    expect(await commands.connection_uses_oauth!({ provider: "github" })).toBe(false);
  });
});

/** A fetch that answers Anthropic and Ollama with canned bodies, by URL. */
function aiFetch(answers: { anthropic?: unknown; ollama?: unknown; status?: number }) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    const body = u.startsWith("https://api.anthropic.com") ? answers.anthropic : u.includes("/api/chat") ? answers.ollama : undefined;
    if (body === undefined) return new Response("{}", { status: 500, statusText: "Internal Server Error" });
    return new Response(JSON.stringify(body), { status: answers.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function aiCommands(answers: Parameters<typeof aiFetch>[0]) {
  const { fetch, calls } = aiFetch(answers);
  const aiSync = { ...sync, fetch, secrets: memorySecrets() };
  return { commands: createCommands({ emit: emitter, watcher, scheduler: new Scheduler(aiSync), sync: aiSync }), calls, secrets: aiSync.secrets };
}

async function seedMock(name: string): Promise<{ id: string; kind: string; title: string; project: string | null }[]> {
  scratchEnv(name);
  const s = defaultSettings();
  s.connections.push({ id: "mock-1", provider: "mock", label: "Mock", status: "disconnected", scopes: [], config: {}, lastSyncAt: null, error: null });
  settingsSave(EnvRoot.open("default"), s);
  await commands.sync_now!({ env: "default" });
  return (await commands.items_query!({ env: "default", filter: {} })) as { id: string; kind: string; title: string; project: string | null }[];
}

describe("AI commands", () => {
  it("ai_actions_for offers by kind, and answers [] for an unknown item", async () => {
    const items = await seedMock("cmd-ai-actions");
    const pr = items.find((i) => i.kind === "pull_request")!;
    const mail = items.find((i) => i.kind === "mail")!;
    expect(((await commands.ai_actions_for!({ env: "default", itemId: pr.id })) as { id: string }[]).map((a) => a.id)).toEqual(["thread.summarize", "issue.tasks"]);
    expect((await commands.ai_actions_for!({ env: "default", itemId: mail.id })) as unknown[]).toEqual([
      { id: "mail.draft", label: "Draft a reply", target: "composer" },
      { id: "thread.summarize", label: "Summarize", target: "panel" },
    ]);
    expect(await commands.ai_actions_for!({ env: "default", itemId: "nope" })).toEqual([]);
  });

  it("ai_context_for reports the resolved project and its plan, or null without one", async () => {
    const items = await seedMock("cmd-ai-context");
    const pr = items.find((i) => i.kind === "pull_request")!;
    // The mock's items say project "ddd"; nothing is registered under that name yet.
    expect(await commands.ai_context_for!({ env: "default", itemId: pr.id })).toEqual({ project: pr.project, plan: null });

    const parent = mkdtempSync(join(tmpdir(), "ddd-cmd-icm-"));
    const dir = realpathSync((mkdirSync(join(parent, "ddd"), { recursive: true }), join(parent, "ddd")));
    mkdirSync(join(dir, ".ddd", "icm"), { recursive: true });
    writeFileSync(join(dir, ".ddd", "icm", "conventions.md"), "tabs");
    register(EnvRoot.open("default"), dir);
    const ctx = (await commands.ai_context_for!({ env: "default", itemId: pr.id })) as { project: string; plan: { files: { name: string }[]; missing: boolean } };
    expect(ctx.project).toBe("ddd");
    expect(ctx.plan.missing).toBe(false);
    expect(ctx.plan.files.map((f) => f.name)).toEqual(["conventions.md"]);
    await expect(commands.ai_context_for!({ env: "default", itemId: "nope" })).rejects.toThrow('item "nope"');
  });

  it("ai_draft routes local by default, returns the proposal, and logs tokens and cost", async () => {
    const items = await seedMock("cmd-ai-draft");
    const pr = items.find((i) => i.kind === "pull_request")!;
    const { commands: ai, calls } = aiCommands({ ollama: { message: { content: "TLDR: merge it." }, prompt_eval_count: 30, eval_count: 5 } });
    const draft = await ai.ai_draft!({ env: "default", itemId: pr.id, action: "thread.summarize" });
    expect(draft).toEqual({ text: "TLDR: merge it.", model: "llama3.1:8b", target: "panel", inputTokens: 30, outputTokens: 5, costMicros: 0, refusal: null, usedProjectContext: false });
    expect(calls).toEqual(["http://localhost:11434/api/chat"]);
    const rows = (await ai.events_query!({ env: "default", kindPrefix: "ai." })) as { kind: string; source: string; project: string; tokensIn: number; tokensOut: number; costMicros: number; meta: unknown }[];
    expect(rows[0]).toMatchObject({ kind: "ai.thread.summarize", source: "local", project: pr.project, tokensIn: 30, tokensOut: 5, costMicros: 0 });
    expect(rows[0]!.meta).toEqual({ model: "llama3.1:8b", usedProjectContext: false, refused: false });
  });

  it("ai_draft to Anthropic needs a key, prices the reply, and passes a refusal through", async () => {
    const items = await seedMock("cmd-ai-anthropic");
    const mail = items.find((i) => i.kind === "mail")!;
    const { commands: ai, secrets } = aiCommands({
      anthropic: { model: "claude-opus-5", stop_reason: "refusal", stop_details: { explanation: "Not this." }, usage: { input_tokens: 1000, output_tokens: 0 }, content: [] },
    });
    await expect(ai.ai_draft!({ env: "default", itemId: mail.id, action: "mail.draft" })).rejects.toThrow("No Anthropic API key. Add one in Settings → AI.");
    secrets.set(EnvRoot.open("default"), "ai:anthropic", "sk-test");
    const draft = (await ai.ai_draft!({ env: "default", itemId: mail.id, action: "mail.draft" })) as { refusal: string; costMicros: number; target: string; text: string };
    expect(draft).toMatchObject({ refusal: "Not this.", costMicros: 5000, target: "composer", text: "" });
    const rows = (await ai.events_query!({ env: "default", kindPrefix: "ai.mail" })) as { source: string; meta: { refused: boolean } }[];
    expect(rows[0]!.source).toBe("anthropic");
    expect(rows[0]!.meta.refused).toBe(true);
    await expect(ai.ai_draft!({ env: "default", itemId: mail.id, action: "nope" })).rejects.toThrow('AI action "nope"');
    await expect(ai.ai_draft!({ env: "default", itemId: "nope", action: "mail.draft" })).rejects.toThrow('item "nope"');
  });
});

describe("widget instruction commands", () => {
  it("template, save, load, clear — with the Tauri argument keys", async () => {
    scratchEnv("cmd-instr");
    expect(await commands.widget_instructions_template!({ kind: "repos" })).toContain("recent repositories");
    const before = (await commands.widget_instructions_load!({ env: "default", widgetId: "w-1" })) as { exists: boolean };
    expect(before.exists).toBe(false);
    const saved = (await commands.widget_instructions_save!({ env: "default", widgetId: "w-1", text: "Only mail from people." })) as { hash: string; exists: boolean };
    expect(saved.exists).toBe(true);
    expect((await commands.widget_instructions_load!({ env: "default", widgetId: "w-1" })) as object).toMatchObject({ text: "Only mail from people.", hash: saved.hash });
    await commands.widget_instructions_clear!({ env: "default", widgetId: "w-1" });
    expect(((await commands.widget_instructions_load!({ env: "default", widgetId: "w-1" })) as { exists: boolean }).exists).toBe(false);
    await expect(commands.widget_instructions_load!({ env: "default", widgetId: "../x" })).rejects.toThrow('not a widget id: "../x"');
  });

  it("compile: nothing written is an error; a fenced local answer becomes a narrowed record and an event", async () => {
    scratchEnv("cmd-compile");
    settingsSave(EnvRoot.open("default"), defaultSettings());
    const { commands: ai } = aiCommands({ ollama: { message: { content: 'Sure:\n```json\n{"filter": {"kind": "mail", "limit": 10, "mood": "calm"}, "unmet": ["only nice ones"]}\n```' }, prompt_eval_count: 200, eval_count: 40 } });
    await expect(ai.widget_instructions_compile!({ env: "default", widgetId: "w-2", kind: "items" })).rejects.toThrow("there is nothing written to compile");
    await ai.widget_instructions_save!({ env: "default", widgetId: "w-2", text: "Only nice mail, latest 10." });
    const compiled = (await ai.widget_instructions_compile!({ env: "default", widgetId: "w-2", kind: "items" })) as { sourceHash: string; filter: unknown; unmet: string[]; model: string; compiledAt: string };
    const loaded = (await ai.widget_instructions_load!({ env: "default", widgetId: "w-2" })) as { hash: string };
    expect(compiled.sourceHash).toBe(loaded.hash);
    expect(compiled.filter).toEqual({ kind: "mail", limit: 10 });
    expect(compiled.unmet).toEqual(["only nice ones", "mood is not something this widget can filter on"]);
    expect(compiled.model).toBe("llama3.1:8b");
    expect(Number.isNaN(Date.parse(compiled.compiledAt))).toBe(false);
    const rows = (await ai.events_query!({ env: "default", kindPrefix: "ai.widget" })) as { kind: string; source: string; tokensIn: number; meta: unknown }[];
    expect(rows[0]).toMatchObject({ kind: "ai.widget.instructions", source: "local", tokensIn: 200 });
    expect(rows[0]!.meta).toEqual({ widgetKind: "items", unmet: 2 });
    await expect(ai.widget_instructions_compile!({ env: "default", widgetId: "w-2", kind: "clock" })).rejects.toThrow("clock widgets cannot be given instructions");
  });

  it("compile passes a refusal and a non-JSON answer through as errors, keeping the last good filter the caller's business", async () => {
    scratchEnv("cmd-compile-bad");
    settingsSave(EnvRoot.open("default"), defaultSettings());
    const { commands: ai } = aiCommands({ ollama: { message: { content: "I would rather not." } } });
    await ai.widget_instructions_save!({ env: "default", widgetId: "w-3", text: "something" });
    await expect(ai.widget_instructions_compile!({ env: "default", widgetId: "w-3", kind: "items" })).rejects.toThrow("the model did not answer with JSON");
  });
});

describe("calendar commands", () => {
  /** A one-event feed run through the real adapter, so the refs the command
   *  reads are the refs the adapter actually writes. */
  function icsItems(connectionId: string) {
    const feed =
      "BEGIN:VCALENDAR\r\nX-WR-CALNAME:Work\r\nBEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Daily standup\r\n" +
      "DTSTART:20260819T090000Z\r\nDTEND:20260819T093000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    return toItems(feed, connectionId, "default");
  }

  const mine = { id: "mine", title: "Dentist", start: "2026-08-19T14:00:00Z", end: "2026-08-19T15:00:00Z" };

  it("keeps your own events when a sync wipes the subscribed ones", async () => {
    // The regression `repo-links.json` exists to prevent, pinned for the
    // calendar too: a sync deletes and reinserts every item for a connection,
    // so anything the user authored must live outside the cache or it is gone
    // on the next refresh.
    const { env } = scratchEnv("cmd-calendar-survives-sync");
    replaceForConnection(env, "conn-1", icsItems("conn-1"));
    await commands.calendar_event_save!({ env: "default", event: mine });

    const before = (await commands.calendar_list!({
      env: "default",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-31T00:00:00Z",
    })) as { title: string; editable: boolean }[];
    expect(before.map((o) => o.title)).toEqual(["Daily standup", "Dentist"]);

    // The feed went empty — an unshared calendar, a revoked URL, a bad day.
    replaceForConnection(env, "conn-1", []);

    const after = (await commands.calendar_list!({
      env: "default",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-31T00:00:00Z",
    })) as { title: string; editable: boolean }[];
    expect(after).toHaveLength(1);
    expect(after[0]!.title).toBe("Dentist");
    expect(after[0]!.editable).toBe(true);
  });

  it("never marks a subscribed occurrence editable, and dresses it from the connection", async () => {
    const { env } = scratchEnv("cmd-calendar-readonly");
    const settings = defaultSettings();
    settings.connections.push({
      id: "conn-1",
      provider: "calendar.ics",
      label: "Work calendar",
      status: "connected",
      scopes: [],
      config: { color: "#ff8800" },
      lastSyncAt: null,
      error: null,
    } as Connection);
    settingsSave(env, settings);
    replaceForConnection(env, "conn-1", icsItems("conn-1"));
    await commands.calendar_event_save!({ env: "default", event: mine });

    const out = (await commands.calendar_list!({
      env: "default",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-31T00:00:00Z",
    })) as { id: string; title: string; editable: boolean; calendar: string; color: string; start: string; end: string }[];
    expect(out.map((o) => o.editable)).toEqual([false, true]);
    // The feed's own X-WR-CALNAME wins over the label the user typed.
    expect(out[0]).toMatchObject({
      id: "conn-1:standup@2026-08-19T09:00:00Z",
      calendar: "Work",
      color: "#ff8800",
      start: "2026-08-19T09:00:00Z",
      end: "2026-08-19T09:30:00Z",
    });
    // Your own events borrow the ICS connection's colour and say whose they are.
    expect(out[1]).toMatchObject({ calendar: "My calendar", color: "#ff8800" });
  });

  it("falls back to the default colour and calendar name with no connection", async () => {
    scratchEnv("cmd-calendar-defaults");
    replaceForConnection(EnvRoot.open("default"), "conn-1", icsItems("conn-1"));
    const out = (await commands.calendar_list!({
      env: "default",
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-31T00:00:00Z",
    })) as { color: string }[];
    expect(out[0]!.color).toBe("#00a99f");
  });

  it("makes a bad window an error, not an empty calendar", async () => {
    scratchEnv("cmd-calendar-bad-window");
    await expect(
      commands.calendar_list!({ env: "default", from: "yesterday", to: "2026-08-31T00:00:00Z" }),
    ).rejects.toThrow("from is not an RFC 3339 timestamp");
    await expect(
      commands.calendar_list!({ env: "default", from: "2026-08-01T00:00:00Z", to: "soon" }),
    ).rejects.toThrow("to is not an RFC 3339 timestamp");
  });

  it("mints an id when one is saved without it, and deletes by id", async () => {
    const { env } = scratchEnv("cmd-calendar-mints-id");
    const saved = (await commands.calendar_event_save!({
      env: "default",
      event: { id: "", title: "Dentist", start: "2026-08-19T09:00:00Z", end: "2026-08-19T10:00:00Z" },
    })) as { id: string; allDay: boolean; rrule: string | null; notes: string | null };
    expect(saved.id.startsWith("ev-")).toBe(true);
    // serde's defaults come back filled in, not absent.
    expect(saved).toMatchObject({ allDay: false, rrule: null, notes: null });

    await commands.calendar_event_delete!({ env: "default", id: saved.id });
    expect(calendarLoad(env).events).toEqual([]);
  });

  it("validates the event it is handed instead of writing it as-is", async () => {
    scratchEnv("cmd-calendar-validate");
    await expect(commands.calendar_event_save!({ env: "default", event: { id: "x", title: "T" } })).rejects.toThrow(
      /^json: missing field `start`$/,
    );
    await expect(
      commands.calendar_event_save!({
        env: "default",
        event: { id: "x", title: "T", start: "2026-08-19T10:00:00Z", end: "2026-08-19T09:00:00Z" },
      }),
    ).rejects.toThrow("an event cannot end before it starts");
  });
});

const repoTemp = (name: string) => mkdtempSync(join(tmpdir(), `ddd-cmd-repo-${name}-`));

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

function makeRepo(root: string, name: string, remote: string | null): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  if (remote !== null) git(dir, ["remote", "add", "origin", remote]);
  return dir;
}

/** A GitHub repo item exactly as `sync/github.ts`'s `toRepoItem` writes one. */
function repoItem(name: string, url: string, sshUrl: string, pushedAt: string): Item {
  const normalized = normalize(url);
  const refs = [`repo:${name}`];
  if (normalized !== null) refs.push(`remote:${normalized}`);
  refs.push(`https:${url}`);
  if (sshUrl !== "") refs.push(`ssh:${sshUrl}`);
  return {
    id: `gh-1:repo-${name}`,
    environmentId: "default",
    connectionId: "gh-1",
    source: "github",
    kind: "repo",
    project: name,
    title: name,
    body: "private · typescript",
    url,
    refs,
    actions: [{ id: "open", label: "Open on GitHub", outbound: false }],
    updatedAt: pushedAt,
    unread: false,
  };
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

interface RepoListing {
  rows: { nameWithOwner: string; url: string; remote: string; cloneUrl: string; facts: string; pushedAt: string; localPath: string | null; matchConfidence: string | null; missing: boolean; projectId: string | null }[];
  localOnly: { path: string; name: string; origin: string | null; originHost: string | null; missing: boolean; projectId: string | null }[];
  capped: boolean;
  total: number;
}

describe("repos_list", () => {
  it("joins the cache with the link store, reports the tier its own join used, and derives local-only", async () => {
    const { env } = scratchEnv("cmd-repos-list");
    const root = repoTemp("list");
    const here = realpathSync(makeRepo(root, "ddd", "git@github.com:agitri/ddd.git"));
    const loose = realpathSync(makeRepo(root, "loose", null));

    replaceForConnection(env, "gh-1", [
      repoItem("agitri/ddd", "https://github.com/agitri/ddd", "git@github.com:agitri/ddd.git", daysAgo(2)),
      repoItem("agitri/forked", "https://github.com/agitri/forked", "git@github.com:agitri/forked.git", daysAgo(3)),
      repoItem("agitri/ancient", "https://github.com/agitri/ancient", "", daysAgo(400)),
      // An `updatedAt` nothing can parse counts as fresh rather than vanishing.
      repoItem("agitri/undated", "https://github.com/agitri/undated", "", ""),
    ]);

    links.save(env, {
      links: [
        { remote: "github.com/agitri/ddd", path: here, source: "scan", confidence: "exact" },
        // Same owner/repo, different host: the weak tier is the only one that
        // can match this, so the row must say "fallback".
        { remote: "gitlab.com/agitri/forked", path: "/nowhere/forked", source: "manual", confidence: "exact" },
        { remote: null, path: loose, source: "manual", confidence: "exact" },
      ],
      scanRoots: [],
      preferredProtocol: "ssh",
    });
    const project = register(env, here);

    const recent = (await commands.repos_list!({ env: "default", filter: {} })) as RepoListing;
    expect(recent.total).toBe(4);
    expect(recent.capped).toBe(false);
    expect(recent.rows.map((r) => r.nameWithOwner)).toEqual(["agitri/ddd", "agitri/forked", "agitri/undated"]);

    const ddd = recent.rows[0]!;
    expect(ddd).toMatchObject({
      url: "https://github.com/agitri/ddd",
      remote: "github.com/agitri/ddd",
      // preferredProtocol "ssh" and an ssh ref present.
      cloneUrl: "git@github.com:agitri/ddd.git",
      facts: "private · typescript",
      localPath: here,
      matchConfidence: "exact",
      missing: false,
      projectId: project.id,
    });

    const forked = recent.rows[1]!;
    expect(forked.matchConfidence).toBe("fallback");
    expect(forked.localPath).toBe("/nowhere/forked");
    // Linked, but the folder is not there right now.
    expect(forked.missing).toBe(true);
    expect(forked.projectId).toBeNull();

    // No ssh ref: the https URL, whatever the preferred protocol says.
    expect(recent.rows[2]!.cloneUrl).toBe("https://github.com/agitri/undated");

    // Everything DDD knows is a checkout, minus what the rows took.
    expect(recent.localOnly).toEqual([
      { path: loose, name: "loose", origin: null, originHost: null, missing: false, projectId: null },
    ]);

    const all = (await commands.repos_list!({ env: "default", filter: { scope: "all" } })) as RepoListing;
    expect(all.rows.map((r) => r.nameWithOwner)).toEqual(["agitri/ddd", "agitri/forked", "agitri/ancient", "agitri/undated"]);

    // The query narrows rows by title and local-only rows by name or remote.
    const narrowed = (await commands.repos_list!({ env: "default", filter: { scope: "all", query: "LOOSE" } })) as RepoListing;
    expect(narrowed.rows).toEqual([]);
    expect(narrowed.localOnly.map((l) => l.name)).toEqual(["loose"]);
    expect(narrowed.total).toBe(4);

    rmSync(root, { recursive: true, force: true });
  });

  it("reports the origin host of a local-only checkout for the badge", async () => {
    const { env } = scratchEnv("cmd-repos-local-host");
    links.save(env, {
      links: [{ remote: "gitlab.com/agitri/thing", path: "/p/thing", source: "manual", confidence: "exact" }],
      scanRoots: [],
      preferredProtocol: null,
    });
    const listing = (await commands.repos_list!({ env: "default", filter: {} })) as RepoListing;
    expect(listing.rows).toEqual([]);
    expect(listing.localOnly[0]).toEqual({ path: "/p/thing", name: "thing", origin: "gitlab.com/agitri/thing", originHost: "gitlab.com", missing: true, projectId: null });
  });
});

describe("repo_scan, repo_link, repo_unlink, repo_add_local, repo_forget", () => {
  it("scans a root, counting distinct persisted links and storing canonical paths", async () => {
    const { env } = scratchEnv("cmd-scan");
    const root = repoTemp("scan");
    const withRemote = realpathSync(makeRepo(root, "ddd", "git@github.com:agitri/ddd.git"));
    const without = realpathSync(makeRepo(root, "scratch", null));
    mkdirSync(join(root, "just-a-folder"));

    expect(await commands.repo_scan!({ env: "default", rootDir: root })).toBe(2);
    const stored = links.load(env);
    expect(stored.scanRoots).toEqual([root]);
    // Inferred from the evidence: one ssh remote, no https ones.
    expect(stored.preferredProtocol).toBe("ssh");
    expect(stored.links.map((l) => [l.remote, l.path, l.source, l.confidence]).sort()).toEqual(
      [
        ["github.com/agitri/ddd", withRemote, "scan", "exact"],
        [null, without, "scan", "exact"],
      ].sort(),
    );

    await expect(commands.repo_scan!({ env: "default", rootDir: join(root, "nope") })).rejects.toThrow(`${join(root, "nope")} is not a directory`);
    rmSync(root, { recursive: true, force: true });
  });

  it("counts unique remotes, not loop iterations, when two checkouts share one", async () => {
    // A worktree, or two clones for two IDE windows, both legitimate. The live
    // run this regression came from reported 27 while only 26 links existed.
    const { env } = scratchEnv("cmd-scan-shared");
    const root = repoTemp("shared");
    makeRepo(root, "ddd-a", "git@github.com:agitri/ddd.git");
    makeRepo(root, "ddd-b", "git@github.com:agitri/ddd.git");

    expect(await commands.repo_scan!({ env: "default", rootDir: root })).toBe(1);
    expect(links.load(env).links).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("links manually with a tier, registers the project, and never lets a rescan clobber that", async () => {
    const { env } = scratchEnv("cmd-link");
    const root = repoTemp("link");
    const matching = realpathSync(makeRepo(root, "matching", "git@github.com:agitri/ddd.git"));
    const forked = realpathSync(makeRepo(root, "forked", "git@github.com:someone-else/ddd.git"));

    await commands.repo_link!({ env: "default", remote: "github.com/agitri/ddd", path: matching });
    expect(links.find(links.load(env), "github.com/agitri/ddd")).toMatchObject({ path: matching, source: "manual", confidence: "exact" });
    expect(registry(env).projects.some((p) => p.path === matching)).toBe(true);

    // A fork's remote legitimately differs from the repo being linked — allowed,
    // just flagged as a guess rather than refused. A trailing slash must still
    // store the canonical path, or the projectId join never fires.
    await commands.repo_link!({ env: "default", remote: "github.com/agitri/ddd", path: `${forked}/` });
    expect(links.find(links.load(env), "github.com/agitri/ddd")).toMatchObject({ path: forked, confidence: "fallback" });

    // A scan of the folder holding both must not override that manual decision.
    expect(await commands.repo_scan!({ env: "default", rootDir: root })).toBe(0);
    expect(links.find(links.load(env), "github.com/agitri/ddd")!.source).toBe("manual");

    await expect(commands.repo_link!({ env: "default", remote: "github.com/a/b", path: join(root, "nope") })).rejects.toThrow(`${join(root, "nope")} is not a directory`);
    rmSync(root, { recursive: true, force: true });
  });

  it("adds a local checkout, refuses a plain folder, and forgets by path", async () => {
    const { env } = scratchEnv("cmd-add-local");
    const root = repoTemp("add");
    const repo = realpathSync(makeRepo(root, "thing", "git@github.com:agitri/thing.git"));
    const plain = join(root, "plain");
    mkdirSync(plain);

    await commands.repo_add_local!({ env: "default", path: repo });
    expect(links.load(env).links).toEqual([{ remote: "github.com/agitri/thing", path: repo, source: "manual", confidence: "exact" }]);
    expect(registry(env).projects.some((p) => p.path === repo)).toBe(true);

    await expect(commands.repo_add_local!({ env: "default", path: plain })).rejects.toThrow(
      `${plain} is not a git repository — use the Projects widget to add a plain folder`,
    );
    await expect(commands.repo_add_local!({ env: "default", path: join(root, "nope") })).rejects.toThrow("is not a directory");

    // Forgetting touches neither the folder nor the project registry.
    await commands.repo_forget!({ env: "default", path: repo });
    expect(links.load(env).links).toEqual([]);
    expect(registry(env).projects.some((p) => p.path === repo)).toBe(true);
    expect(existsSync(repo)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("unlinks by remote", async () => {
    const { env } = scratchEnv("cmd-unlink");
    links.upsert(env, { remote: "github.com/agitri/ddd", path: "/tmp/ddd", source: "manual", confidence: "exact" });
    await commands.repo_unlink!({ env: "default", remote: "github.com/agitri/ddd" });
    expect(links.load(env).links).toEqual([]);
  });
});

describe("repo_clone", () => {
  it(
    "returns the target at once and pushes progress to ddd://repo-progress until done",
    async () => {
      const { env } = scratchEnv("cmd-clone");
      const root = repoTemp("clone");
      const seed = join(root, "seed");
      mkdirSync(seed);
      git(seed, ["init", "-q"]);
      git(seed, ["config", "user.email", "test@example.dev"]);
      git(seed, ["config", "user.name", "Test"]);
      writeFileSync(join(seed, "README.md"), "hello\n");
      git(seed, ["add", "."]);
      git(seed, ["commit", "-q", "-m", "first"]);
      const origin = join(root, "origin.git");
      // A `file://` URL forces a real clone over git's transport layer, which
      // is what makes it emit the progress stream at all — no network.
      execFileSync("git", ["clone", "--bare", "-q", seed, origin], { stdio: "ignore" });
      const parent = join(root, "into");
      mkdirSync(parent);

      const before = emitter.events.length;
      const remote = "github.com/agitri/origin";
      const target = await commands.repo_clone!({ env: "default", remote, cloneUrl: `file://${origin}`, parentDir: parent });
      expect(target).toBe(join(parent, "origin"));

      // The command returns its target before any progress tick reaches the
      // emitter — the clone body is deferred, not fired synchronously inside
      // the command handler.
      const ours = () => emitter.events.slice(before).filter((e) => e.name === "ddd://repo-progress");
      expect(ours()).toEqual([]);
      await until(() => ours().some((e) => (e.payload as { done: boolean }).done), 20000);
      const payloads = ours().map((e) => e.payload as { remote: string; phase: string; percent: number; done: boolean; error: string | null });
      expect(payloads[0]).toEqual({ remote, phase: "Starting", percent: 0, done: false, error: null });
      expect(payloads[payloads.length - 1]).toEqual({ remote, phase: "Done", percent: 100, done: true, error: null });
      expect(payloads.every((p) => p.remote === remote)).toBe(true);

      expect(existsSync(join(target as string, "README.md"))).toBe(true);
      expect(links.find(links.load(env), remote)!.path).toBe(realpathSync(target as string));
      expect(registry(env).projects.some((p) => p.path === realpathSync(target as string))).toBe(true);

      rmSync(root, { recursive: true, force: true });
    },
    30000,
  );

  it("refuses before detaching when the parent is missing or the target is occupied", async () => {
    scratchEnv("cmd-clone-refuse");
    const root = repoTemp("clone-refuse");
    await expect(
      commands.repo_clone!({ env: "default", remote: "github.com/a/b", cloneUrl: "file:///nowhere", parentDir: join(root, "nope") }),
    ).rejects.toThrow(`${join(root, "nope")} is not a directory`);

    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "b", "something"), "x");
    await expect(
      commands.repo_clone!({ env: "default", remote: "github.com/a/b", cloneUrl: "file:///nowhere", parentDir: root }),
    ).rejects.toThrow(`${join(root, "b")} already exists and is not empty`);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("dev server commands", () => {
  it("lists what is really listening on this machine, and dials none of it", async () => {
    scratchEnv("cmd-dev-list");
    const listing = (await commands.dev_servers_list!({ env: "default", filter: { knownOnly: false, ephemeral: true } })) as {
      rows: { key: string; port: number; address: string; health: string; checkedAt: string | null; containers: unknown[] }[];
      hidden: number;
      foreignCount: number;
      scanMs: number;
      partial: boolean;
    };
    expect(Array.isArray(listing.rows)).toBe(true);
    expect(typeof listing.hidden).toBe("number");
    expect(typeof listing.foreignCount).toBe("number");
    expect(typeof listing.scanMs).toBe("number");
    expect(listing.partial).toBe(false);
    for (const row of listing.rows) {
      expect(row.key).toBe(`tcp:${row.address}:${row.port}`);
      // probe defaults false: the first paint shows rows before any socket work.
      expect(row.health).toBe("unknown");
      expect(row.checkedAt).toBeNull();
      expect(Array.isArray(row.containers)).toBe(true);
    }
  }, 30_000);

  it("refuses a filter it cannot read, before reading the machine", async () => {
    scratchEnv("cmd-dev-filter");
    await expect(commands.dev_servers_list!({ env: "default", filter: { knownOnly: "yes" } })).rejects.toThrow(/^json: /);
  });

  it("probes a socket this test owns, and calls a closed port down", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => socket.end("HTTP/1.0 200 OK\r\n\r\n"));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const up = (await commands.dev_server_probe!({ address: "127.0.0.1", port, http: true })) as {
        health: string;
        latencyMs: number | null;
        checkedAt: string;
      };
      expect(up.health).toBe("up");
      expect(typeof up.latencyMs).toBe("number");
      expect(Number.isNaN(Date.parse(up.checkedAt))).toBe(false);

      const down = (await commands.dev_server_probe!({ address: "127.0.0.1", port: 1, http: false })) as {
        health: string;
        latencyMs: number | null;
      };
      expect(down).toMatchObject({ health: "down", latencyMs: null });
    } finally {
      server.close();
    }
  }, 15_000);

  it("wraps a machine-read failure as a scan failure, the Rust's spawn_blocking().map_err()", async () => {
    scratchEnv("cmd-dev-list-throws");
    // The process-wide memo (`MEMO_FLOOR_MS`) may still be holding a snapshot
    // from an earlier test in this file; outlast it so this call really does
    // reach `machineRead`.
    await new Promise((r) => setTimeout(r, MEMO_FLOOR_MS + 100));
    const failing = createCommands({
      emit: emitter,
      watcher,
      scheduler,
      sync,
      machineRead: () => {
        throw new Error("lsof exploded");
      },
    });
    await expect(failing.dev_servers_list!({ env: "default", filter: {} })).rejects.toThrow(
      "dev server scan failed: lsof exploded",
    );
  });

  it("wraps a probe failure as a probe failure", async () => {
    scratchEnv("cmd-dev-probe-throws");
    const spy = vi.spyOn(probe, "run").mockImplementation(() => {
      throw new Error("socket exploded");
    });
    try {
      await expect(commands.dev_server_probe!({ address: "127.0.0.1", port: 1, http: false })).rejects.toThrow(
        "probe failed: socket exploded",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("re-reads the machine before signalling, and refuses when the row is stale", async () => {
    scratchEnv("cmd-dev-stop");
    // Port 1 is privileged, so nothing in the suite can be on it: the guard
    // sees an empty socket and declines rather than signalling pid 999999.
    await expect(
      commands.dev_server_stop!({ env: "default", key: "tcp:127.0.0.1:1", pid: 999_999, process: "node" }),
    ).rejects.toThrow("it already exited — nothing is on that port now");

    // And with nothing to compare against, the guard cannot run at all.
    await expect(
      commands.dev_server_stop!({ env: "default", key: "tcp:127.0.0.1:1", pid: 999_999, process: "" }),
    ).rejects.toThrow("no process name to verify against, so the reuse guard cannot run");
  }, 30_000);
});

/**
 * A fetch that answers endoflife.date with a canned schedule and refuses every
 * HEAD with a timeout — the honest shape of "someone else's slow server".
 */
function eolCommands() {
  const calls: { url: string; method: string }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method });
    if (method === "HEAD") {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    if (u === "https://endoflife.date/api/nodejs.json") {
      return new Response(
        JSON.stringify([
          // A numeric cycle, as the real API sends for Node.
          { cycle: 24, support: "2026-10-20", eol: "2028-04-30", latest: "24.20.0" },
          { cycle: "20", support: "2025-10-22", eol: "2026-04-30", latest: "20.19.5" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("", { status: 404, statusText: "Not Found" });
  }) as typeof globalThis.fetch;
  const eolSync = { ...sync, fetch };
  return {
    commands: createCommands({ emit: emitter, watcher, scheduler: new Scheduler(eolSync), sync: eolSync }),
    calls,
  };
}

interface BoardShape {
  rows: {
    path: string;
    name: string;
    url: string | null;
    missing: boolean;
    unreadable: boolean;
    live: { state: string; detail: unknown } | null;
    findings: Record<string, unknown>[];
    worst: { state: string };
  }[];
  stale: string[];
}

describe("EOL commands", () => {
  it("watch, board, unwatch — one request per product, and a timeout is never `unreachable`", async () => {
    const { home } = scratchEnv("cmd-eol");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-eol-")));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: ">=20 <23" } }));

    const { commands: eol, calls } = eolCommands();
    const list = (await eol.eol_watch!({
      env: "default",
      path: dir,
      url: "https://watched.example",
      note: "a client site",
    })) as { watched: { path: string; url: string | null; note: string | null }[] };
    expect(list.watched).toHaveLength(1);
    expect(list.watched[0]!.path).toBe(dir);
    expect(list.watched[0]!.url).toBe("https://watched.example");
    expect(list.watched[0]!.note).toBe("a client site");

    const board = (await eol.eol_board!({ env: "default" })) as BoardShape;
    expect(board.stale).toEqual([]);
    expect(board.rows).toHaveLength(1);
    const row = board.rows[0]!;
    expect(row.name).toBe(basename(dir));
    expect(row.path).toBe(dir);
    expect(row.missing).toBe(false);
    expect(row.unreadable).toBe(false);
    // A slow server is not a gone server.
    expect(row.live).toEqual({ state: "noAnswer", detail: "no reply within the deadline" });
    expect(row.findings).toEqual([
      {
        product: "nodejs",
        cycle: "20",
        source: "package.json",
        confidence: "floor",
        raw: "engines.node: >=20 <23",
        support: { state: "ended" },
        eolDate: "2026-04-30",
        supportDate: "2025-10-22",
        latest: "20.19.5",
        scheduleAgeDays: 0,
      },
    ]);
    expect(row.worst).toEqual({ state: "ended" });

    // One request for the schedule, one HEAD for the live URL.
    expect(calls).toEqual([
      { url: "https://endoflife.date/api/nodejs.json", method: "GET" },
      { url: "https://watched.example", method: "HEAD" },
    ]);

    // Written back, with its milestones in the tagged on-disk shape.
    const onDisk = JSON.parse(readFileSync(`${home}/environments/default/eol-cache.json`, "utf8")) as {
      products: Record<string, { fetchedAt: string; cycles: { cycle: string; eol: unknown }[] }>;
      live: Record<string, { liveness: { state: string } }>;
    };
    expect(Object.keys(onDisk.products)).toEqual(["nodejs"]);
    expect(onDisk.products["nodejs"]!.cycles.map((c) => c.cycle)).toEqual(["24", "20"]);
    expect(onDisk.products["nodejs"]!.cycles[1]!.eol).toEqual({ kind: "date", date: "2026-04-30" });
    expect(onDisk.live["https://watched.example"]!.liveness.state).toBe("noAnswer");

    // The second call asks nothing: the schedule is good for a week and the
    // liveness answer for an hour — and the verdict survives the round trip.
    const again = (await eol.eol_board!({ env: "default" })) as BoardShape;
    expect(calls).toHaveLength(2);
    expect(again.rows[0]!.findings[0]).toMatchObject({ support: { state: "ended" }, eolDate: "2026-04-30" });

    expect(await eol.eol_watchlist!({ env: "default" })).toEqual(list);
    expect(await eol.eol_unwatch!({ env: "default", path: dir })).toEqual({ watched: [] });
    expect(await eol.eol_watchlist!({ env: "default" })).toEqual({ watched: [] });
  });

  it("refuses a path that is not a checkout and a url that could never be fetched", async () => {
    scratchEnv("cmd-eol-bad");
    const { commands: eol } = eolCommands();
    await expect(eol.eol_watch!({ env: "default", path: "/nonexistent-checkout-xyz" })).rejects.toThrow(
      "/nonexistent-checkout-xyz is not a directory",
    );
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-eol-bad-")));
    await expect(eol.eol_watch!({ env: "default", path: dir, url: "file:///etc/passwd" })).rejects.toThrow(
      "file:///etc/passwd is not an http or https address",
    );
    expect(await eol.eol_watchlist!({ env: "default" })).toEqual({ watched: [] });
  });

  it("a watched checkout that vanished is kept, marked, and asks the network for nothing", async () => {
    scratchEnv("cmd-eol-gone");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddd-cmd-eol-gone-")));
    const { commands: eol, calls } = eolCommands();
    await eol.eol_watch!({ env: "default", path: dir });
    rmSync(dir, { recursive: true, force: true });

    const board = (await eol.eol_board!({ env: "default" })) as BoardShape;
    expect(board.rows[0]!.missing).toBe(true);
    expect(board.rows[0]!.unreadable).toBe(false);
    expect(board.rows[0]!.findings).toEqual([]);
    expect(board.rows[0]!.worst).toEqual({ state: "unknown" });
    expect(calls).toEqual([]);
  });
});

describe("mcp commands", () => {
  const FIXTURE = resolve(__dirname, "../core/sync/mcp/fixtures/echo-server.mjs");

  it("records consent against the exact argv", async () => {
    // The token the Settings card stores. Twelve bytes of SHA-256 over the argv
    // joined on NUL, so editing the command voids the approval.
    expect(await commands.mcp_consent!({ command: `["npx", "-y", "server"]` })).toBe("fcc4c8cdd12fb9c6b3149580");
    expect(await commands.mcp_consent!({ command: `  ["npx","-y","server"]  ` })).toBe("fcc4c8cdd12fb9c6b3149580");
    expect(await commands.mcp_consent!({ command: `["npx", "-y", "other"]` })).not.toBe("fcc4c8cdd12fb9c6b3149580");
  });

  it("surfaces the four argv refusals verbatim", async () => {
    await expect(commands.mcp_consent!({ command: "not json" })).rejects.toThrow(
      `the command must be a JSON array, e.g. ["npx", "-y", "server"]`,
    );
    await expect(commands.mcp_consent!({ command: `"npx -y server"` })).rejects.toThrow(
      "the command must be a JSON array, not a single string",
    );
    await expect(commands.mcp_consent!({ command: "[]" })).rejects.toThrow("the command is empty");
    await expect(commands.mcp_consent!({ command: `["npx", 42]` })).rejects.toThrow(
      "every part of the command must be a string",
    );
    await expect(commands.mcp_consent!({ command: `["npx", ""]` })).rejects.toThrow(
      "a command cannot contain an empty argument",
    );
  });

  it("probes a consented server and reports what it offers", async () => {
    scratchEnv("cmd-mcp");
    const argv = [process.execPath, FIXTURE];
    const s = defaultSettings();
    s.connections.push({
      id: "mcp-1",
      provider: "mcp",
      label: "files",
      status: "connected",
      scopes: [],
      config: { command: JSON.stringify(argv), consent: consentToken(parseArgv(JSON.stringify(argv))) },
      lastSyncAt: null,
      error: null,
    });
    settingsSave(EnvRoot.open("default"), s);

    const report = (await commands.mcp_probe!({ env: "default", connectionId: "mcp-1" })) as {
      server: { name: string; version: string; hasResources: boolean; hasTools: boolean; protocolVersion: string };
      tools: { name: string; description: string | null }[];
      skippedForModels: number;
      capped: boolean;
      unreadBodies: number;
      failedReads: number;
    };
    expect(report.server.name).toBe("echo");
    expect(report.server.version).toBe("9.9.9");
    expect(report.server.hasResources && report.server.hasTools).toBe(true);
    expect(report.server.protocolVersion).not.toBe("");
    expect(report.tools).toEqual([{ name: "echo", description: "echoes its argument" }]);
    expect(report.skippedForModels).toBe(1); // the model-only resource, counted not hidden
    expect(report).toMatchObject({ capped: false, unreadBodies: 0, failedReads: 0 });
  }, 20000);

  it("refuses to probe a connection that does not exist, and one that was never approved", async () => {
    scratchEnv("cmd-mcp-missing");
    await expect(commands.mcp_probe!({ env: "default", connectionId: "nope" })).rejects.toThrow(`connection "nope"`);

    const s = defaultSettings();
    s.connections.push({
      id: "mcp-2",
      provider: "mcp",
      label: "files",
      status: "connected",
      scopes: [],
      config: { command: JSON.stringify([process.execPath, FIXTURE]) },
      lastSyncAt: null,
      error: null,
    });
    settingsSave(EnvRoot.open("default"), s);
    await expect(commands.mcp_probe!({ env: "default", connectionId: "mcp-2" })).rejects.toThrow(
      "this server has not been approved to run — approve it in Settings first",
    );
  });
});
