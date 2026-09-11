/**
 * The IPC surface, keyed by the Tauri command names so `lib/ipc.ts` needs no
 * renaming. Deliberately dumb, like `commands.rs`: resolve an `EnvRoot`, hand
 * off to core, return. No `electron` import here — the registry is testable
 * as a plain map, and `ipc.ts` is what wires it to a window.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { EnvRoot, pathsInfo } from "../core/paths";
import {
  environmentCreate,
  environmentDelete,
  environmentSetActive,
  environmentUpdate,
  globalAppearanceSave,
  globalLoad,
} from "../core/global";
import { layoutFileRead, layoutFileWrite, layoutLoad, layoutSave } from "../core/layout";
import { layoutFromJson } from "../core/models";
import { appearanceRequired, settingsFromJson, settingsLoad, settingsSave } from "../core/settings";
import { keymapLoad, keymapSave } from "../core/keymap";
import * as events from "../core/events";
import * as secrets from "../core/secrets";
import * as projects from "../core/projects";
import * as launcher from "../core/launcher";
import * as cache from "../core/sync/cache";
import * as oauth from "../core/sync/oauth";
import { forProvider } from "../core/sync/providers";
import type { FetchContext, SyncDeps } from "../core/sync/adapter";
import type { Scheduler } from "../core/sync/scheduler";
import { itemFilterFromJson } from "../core/models";
import { DddError } from "../core/error";
import type { Emitter } from "../core/emitter";
import type { ProjectWatcher } from "../core/watcher";
import type { EventInput } from "../core/models";
import * as actions from "../core/ai/actions";
import * as icm from "../core/ai/icm";
import { projectDirFor } from "../core/ai/project";
import { route } from "../core/ai/router";
import * as instructions from "../core/instructions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (args: Record<string, any>) => unknown;

/** What the stateful commands need from the host. Main builds one of these;
 *  tests build one with a recording emitter. */
export interface CommandDeps {
  emit: Emitter;
  /** One watcher for the whole app: the set of watched paths is the union
   *  across environments, even though the registries themselves are not. */
  watcher: ProjectWatcher;
  /** One scheduler for the whole app: the only writer of every item cache. */
  scheduler: Scheduler;
  /** The host's network, keychain and browser. */
  sync: SyncDeps;
}

/** Commands the host adds on top of the Tauri set (dialogs and the shell,
 *  which were Tauri plugins). Kept here so the contract test knows them. */
export const HOST_COMMANDS: readonly string[] = [
  "dialog_save",
  "dialog_open_file",
  "dialog_pick_directory",
  "open_external",
  "reveal_path",
] as const;

const root = (env: string) => EnvRoot.open(env);

function findProject(env: EnvRoot, id: string) {
  const entry = projects.registry(env).projects.find((p) => p.id === id);
  if (!entry) throw DddError.notFound(`project ${JSON.stringify(id)}`);
  return entry;
}

export function createCommands(deps: CommandDeps): Record<string, Handler> {
  return {
    // --- environments ---
    global_load: () => globalLoad(),
    global_appearance_save: ({ appearance }) => globalAppearanceSave(appearanceRequired(appearance)),
    environment_create: ({ id, name, color }) => environmentCreate(id, name, color),
    environment_update: ({ id, name, color, hidden, collapsed }) =>
      environmentUpdate(id, { name, color, hidden, collapsed }),
    environment_set_active: ({ id }) => environmentSetActive(id),
    environment_delete: ({ id }) => environmentDelete(id),

    // --- layout, settings, keymap ---
    layout_load: ({ env }) => layoutLoad(root(env)),
    layout_save: ({ env, layout }) => layoutSave(root(env), layoutFromJson(layout)),
    layout_file_write: ({ path, contents }) => layoutFileWrite(path, contents),
    layout_file_read: ({ path }) => layoutFileRead(path),
    settings_load: ({ env }) => settingsLoad(root(env)),
    settings_save: ({ env, settings }) => settingsSave(root(env), settingsFromJson(settings)),
    keymap_load: () => keymapLoad(),
    keymap_save: ({ keymap }) => keymapSave(keymap),

    // --- events ---
    event_log: ({ env, event }) => events.eventLog(root(env), event),
    events_query: ({ env, since, kindPrefix, limit }) =>
      events.query(root(env), { since, kindPrefix, limit: limit ?? 500 }),
    events_clear: ({ env }) => events.clear(root(env)),

    // --- secrets: set, status, delete. Never get. ---
    secret_set: ({ env, key, value }) => secrets.set(root(env), key, value),
    secret_exists: ({ env, key }) => secrets.exists(root(env), key),
    secret_delete: ({ env, key }) => secrets.del(root(env), key),

    // --- paths ---
    paths_info: ({ env }) => pathsInfo(root(env)),
    path_exists: ({ path }) => existsSync(path),

    // --- projects ---
    /** Listing also re-points the file watcher. Doing it here means the watch
     *  set can never drift from what the board is actually showing. */
    projects_list: async ({ env }) => {
      const r = root(env);
      const reg = projects.registry(r);
      try {
        deps.watcher.sync(r.id, reg.projects);
      } catch {
        // A watch that cannot be set up must not take the list with it.
      }
      return projects.loadAll(reg.projects);
    },
    project_register: async ({ env, path }) => {
      const r = root(env);
      const entry = projects.register(r, path);
      try {
        deps.watcher.sync(r.id, projects.registry(r).projects);
      } catch {
        /* see projects_list */
      }
      return projects.load(entry.id, entry.path);
    },
    project_unregister: ({ env, id }) => {
      const r = root(env);
      projects.unregister(r, id);
      try {
        deps.watcher.sync(r.id, projects.registry(r).projects);
      } catch {
        /* see projects_list */
      }
    },
    project_reload: async ({ env, id }) => {
      const entry = findProject(root(env), id);
      return projects.load(entry.id, entry.path);
    },
    /** Open the configured terminal in the project and start Claude Code.
     *  The project's own `.ddd/config.json` wins over the global setting. */
    project_launch: async ({ env, id }) => {
      const r = root(env);
      const entry = findProject(r, id);
      const project = await projects.load(entry.id, entry.path);
      const appearance = globalLoad().appearance;
      const terminal = launcher.resolveTerminal(project.config.terminal, appearance.terminalApp);
      await launcher.launch(entry.path, terminal, appearance.launchCommand);
      const event: EventInput = { kind: "project.launch", source: "local", project: project.name };
      events.log(r, event);
    },
    /** The path-based sibling of `project_launch`, for the launcher widget. */
    launch_path: ({ path }) => {
      const appearance = globalLoad().appearance;
      return launcher.launch(path, appearance.terminalApp, appearance.launchCommand);
    },
    editors_list: () => launcher.detectEditors(),
    terminals_list: () => launcher.detectTerminals(),
    /** An explicit choice wins; otherwise the global default. */
    open_in_editor: ({ path, editor }) => {
      const configured = globalLoad().appearance.editor;
      const explicit = typeof editor === "string" ? editor.trim() : "";
      return launcher.openInEditor(path, explicit !== "" ? explicit : configured);
    },

    // --- items: reads the cache and nothing else ---
    items_query: async ({ env, filter }) => cache.query(root(env), itemFilterFromJson(filter ?? {})),
    cache_clear: ({ env }) => cache.clear(root(env)),

    /** Manual refresh. The scheduler owns the cadence; this is the nudge. */
    sync_now: async ({ env, connectionId }) => {
      const r = root(env);
      let total = 0;
      for (const connection of settingsLoad(r).connections) {
        if (typeof connectionId === "string" && connectionId !== connection.id) continue;
        deps.scheduler.invalidate(connection.id);
        total += await deps.scheduler.syncConnection(r, connection);
      }
      return total;
    },

    /** The approval gate. Every outbound action funnels through here, and it is
     *  reachable only from an explicit click or keypress in the UI. */
    item_action: async ({ env, itemId, action, input }) => {
      const r = root(env);
      const item = cache.find(r, itemId);
      if (!item) throw DddError.notFound(`item ${JSON.stringify(itemId)}`);
      const connection = settingsLoad(r).connections.find((c) => c.id === item.connectionId);
      if (!connection) throw DddError.notFound(`connection ${JSON.stringify(item.connectionId)}`);
      const adapter = forProvider(connection.provider);
      if (!adapter) throw DddError.config(`no adapter for ${connection.provider}`);
      const token = await oauth.accessToken(r, connection, deps.sync);
      const cx: FetchContext = { environmentId: r.id, connection, token, fetch: deps.sync.fetch };
      const outcome = await adapter.perform(cx, { action, item, input: typeof input === "string" ? input : null });
      events.log(r, { kind: `item.${action}`, source: item.source, project: item.project });
      // The item just changed on the other end; make the board catch up.
      deps.scheduler.invalidate(connection.id);
      return outcome;
    },

    /** OAuth consent: opens the system browser and waits on a loopback listener. */
    connection_connect: async ({ env, connectionId }) => {
      const r = root(env);
      const connection = settingsLoad(r).connections.find((c) => c.id === connectionId);
      if (!connection) throw DddError.notFound(`connection ${JSON.stringify(connectionId)}`);
      await oauth.connect(r, connection, deps.sync);
      deps.scheduler.invalidate(connectionId);
    },
    connection_uses_oauth: ({ provider }) => oauth.providerFor(provider) !== null,

    // --- AI: proposals only. Nothing here can send; item_action is the gate. ---

    /** Which AI actions apply to this item. The UI asks rather than guessing. */
    ai_actions_for: ({ env, itemId }) => {
      const item = cache.find(root(env), String(itemId));
      if (item === null) return [];
      return actions.availableFor(item).map((a) => ({ id: a.id, label: a.label, target: a.target }));
    },

    /** What an AI action on this item would be given, before it is given.
     *  Read-only and free: no model is contacted, nothing is logged. */
    ai_context_for: async ({ env, itemId }) => {
      const r = root(env);
      const item = cache.find(r, String(itemId));
      if (item === null) throw DddError.notFound(`item ${JSON.stringify(itemId)}`);
      const dir = projectDirFor(r, item);
      // No project behind this item at all — distinct from a project with no
      // ICM, and the panel says so rather than showing an empty list.
      if (dir === null) return { project: item.project ?? null, plan: null };
      return { project: basename(dir), plan: icm.planFor(dir) };
    },

    /** Run an AI action over an item and return a **proposal**. Its output
     *  lands in the composer, and a human presses Send. */
    ai_draft: async ({ env, itemId, action }) => {
      const r = root(env);
      const item = cache.find(r, String(itemId));
      if (item === null) throw DddError.notFound(`item ${JSON.stringify(itemId)}`);
      const definition = actions.action(String(action));
      if (definition === null) throw DddError.notFound(`AI action ${JSON.stringify(action)}`);

      // ICM is a mandatory input, not an optional extra.
      const dir = projectDirFor(r, item);
      const context = dir === null ? "" : icm.contextFor(dir);
      const usedProjectContext = context.trim() !== "";

      const settings = settingsLoad(r);
      const chosen = route(r, settings, String(action), deps.sync);
      const draft = await chosen.provider.complete({
        system: actions.systemPrompt(definition, context),
        prompt: actions.userPrompt(definition, item),
        // Room for the answer plus thinking, which shares this budget.
        maxTokens: 4096,
        model: chosen.model,
      });

      // Tokens and cost land in the events table, the substance of the stats
      // board. Nothing leaves the machine.
      events.log(r, {
        kind: `ai.${action}`,
        source: chosen.provider.id,
        project: item.project ?? null,
        tokensIn: draft.usage.inputTokens,
        tokensOut: draft.usage.outputTokens,
        costMicros: draft.usage.costMicros,
        meta: { model: draft.model, usedProjectContext, refused: draft.refusal !== null },
      });

      return {
        text: draft.text,
        model: draft.model,
        target: definition.target,
        inputTokens: draft.usage.inputTokens,
        outputTokens: draft.usage.outputTokens,
        costMicros: draft.usage.costMicros,
        refusal: draft.refusal,
        usedProjectContext,
      };
    },

    // --- widget instructions ---

    widget_instructions_load: async ({ env, widgetId }) => instructions.load(root(env), String(widgetId)),
    widget_instructions_save: ({ env, widgetId, text }) => instructions.save(root(env), String(widgetId), String(text)),
    widget_instructions_clear: ({ env, widgetId }) => {
      instructions.clear(root(env), String(widgetId));
    },
    widget_instructions_template: ({ kind }) => instructions.template(String(kind)),

    /** Compile prose into a filter, once, with a local model by default. Every
     *  failure surfaces as an error and the caller keeps its last good filter. */
    widget_instructions_compile: async ({ env, widgetId, kind }) => {
      const r = root(env);
      const prose = instructions.load(r, String(widgetId));
      if (prose.text.trim() === "") throw DddError.invalid("there is nothing written to compile");

      const settings = settingsLoad(r);
      const chosen = route(r, settings, instructions.ACTION, deps.sync);
      const draft = await chosen.provider.complete(instructions.completionFor(String(kind), prose.text, chosen.model));
      if (draft.refusal !== null) throw DddError.invalid(draft.refusal);

      const parsed = instructions.parseResponse(draft.text);
      const compiled = instructions.compileValue(String(kind), parsed.filter);
      const unmet = [...parsed.unmet, ...compiled.unmet];

      events.log(r, {
        kind: "ai.widget.instructions",
        source: chosen.provider.id,
        project: null,
        tokensIn: draft.usage.inputTokens,
        tokensOut: draft.usage.outputTokens,
        costMicros: draft.usage.costMicros,
        meta: { widgetKind: kind, unmet: unmet.length },
      });

      return instructions.record(compiled.filter, prose.hash, unmet, chosen.model, new Date().toISOString());
    },
  };
}
