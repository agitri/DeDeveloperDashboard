import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
import { register } from "../core/projects";
import { replaceForConnection } from "../core/sync/cache";
import { toItems } from "../core/sync/ics";
import { load as calendarLoad } from "../core/calendar/store";

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
  "repos_list",
  "repo_add_local",
  "repo_forget",
  "repo_scan",
  "repo_link",
  "repo_unlink",
  "repo_clone",
  "dev_servers_list",
  "dev_server_probe",
  "dev_server_stop",
  "eol_board",
  "eol_watch",
  "eol_unwatch",
  "eol_watchlist",
  "products_list",
  "product_approve",
  "product_revoke",
  "product_start",
  "product_stop",
  "product_log",
  "mcp_consent",
  "mcp_probe",
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
