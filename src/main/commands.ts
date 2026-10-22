/**
 * The IPC surface, keyed by the Tauri command names so `lib/ipc.ts` needs no
 * renaming. Deliberately dumb, like `commands.rs`: resolve an `EnvRoot`, hand
 * off to core, return. No `electron` import here — the registry is testable
 * as a plain map, and `ipc.ts` is what wires it to a window.
 */
import { existsSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvRoot, pathsInfo } from "../core/paths";
import {
  environmentCreate,
  environmentDelete,
  environmentSetActive,
  environmentUpdate,
  globalAppearanceSave,
  globalLoad,
  globalWizardSave,
} from "../core/global";
import { layoutFileRead, layoutFileWrite, layoutLoad, layoutSave } from "../core/layout";
import { layoutFromJson } from "../core/models";
import { appearanceRequired, defaultSettings, settingsFromJson, settingsLoad, settingsSave } from "../core/settings";
import { keymapLoad, keymapSave } from "../core/keymap";
import * as events from "../core/events";
import * as secrets from "../core/secrets";
import * as projects from "../core/projects";
import * as launcher from "../core/launcher";
import * as cache from "../core/sync/cache";
import * as oauth from "../core/sync/oauth";
import { forProvider } from "../core/sync/providers";
import type { FetchContext, SyncDeps } from "../core/sync/adapter";
import { fetchContext } from "../core/sync/adapter";
import { McpAdapter } from "../core/sync/mcp/adapter";
import { consentToken, parseArgv } from "../core/sync/mcp/transport";
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
import * as sitrep from "../core/ai/sitrep";
import * as calendar from "../core/calendar/store";
import { expand, type EventSpec, type Override } from "../core/calendar/expand";
import * as clone from "../core/repos/clone";
import { changesSince } from "../core/repos/changes";
import { repoFilterFromJson } from "../core/repos/filter";
import * as links from "../core/repos/links";
import { normalize } from "../core/repos/remote";
import * as scan from "../core/repos/scan";
import { MEMO_FLOOR_MS, Memo, devServerFilterFromJson, list as devServerList, readMachine, type KnownProject } from "../core/dev/board";
import { execFileRunner } from "../core/dev/run";
import * as listen from "../core/dev/listen";
import * as probe from "../core/dev/probe";
import { mayStop, refusalMessage, signal } from "../core/dev/stop";
import * as eolBoard from "../core/eol/board";
import * as eolDetect from "../core/eol/detect";
import * as eolLive from "../core/eol/live";
import * as eolSchedule from "../core/eol/schedule";
import * as eolWatchlist from "../core/eol/watchlist";
import { itemId as makeItemId } from "../core/sync/adapter";
import * as supervise from "../core/products/supervise";
import * as productLog from "../core/products/log";
import * as mediaControl from "../core/media/control";
import * as modelScan from "../core/models/scan";
import * as modelMove from "../core/models/move";
import type { Item, ItemFilter, Product, Settings } from "../core/models";

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
  /** How `dev_servers_list` reads the machine. Overridable only so a test can
   *  make the read throw — `vi.spyOn` on a bare named import does not reach a
   *  call site that already closed over the binding. Defaults to the real
   *  `readMachine`. */
  machineRead?: typeof readMachine;
  /** Where the local-model runtimes keep their downloads. Overridable so a
   *  test scans a scratch tree instead of the developer's own 50 GB. Defaults
   *  to the runtimes' well-known folders plus their env overrides. */
  modelRoots?: modelScan.StoreRoots;
}

/** Commands the host adds on top of the Tauri set: dialogs and the shell
 *  (which were Tauri plugins), plus nodeDDD-only additions with no Rust
 *  counterpart. Kept here so the contract test knows them. */
export const HOST_COMMANDS: readonly string[] = [
  "dialog_save",
  "dialog_open_file",
  "dialog_pick_directory",
  "open_external",
  "reveal_path",
  // nodeDDD-only: no Rust counterpart (Appearance → UI scale, applied as browser zoom).
  "window_set_zoom",
  // nodeDDD-only: no Rust counterpart (the per-tab sitrep widget's git delta).
  "repo_changes_since",
  // nodeDDD-only: no Rust counterpart (the per-tab sitrep widget's AI summary).
  "tab_sitrep_generate",
  // nodeDDD-only: no Rust counterpart (the media widget's playback state and controls).
  "media_state",
  "media_command",
  // nodeDDD-only: no Rust counterpart (the local-models widget's scan and per-model move).
  "models_scan",
  "models_move",
  // nodeDDD-only: no Rust counterpart (the onboarding wizard's progress).
  "global_wizard_save",
] as const;

const root = (env: string) => EnvRoot.open(env);

/**
 * One read of the machine for the whole process, mirroring the Rust's
 * `static MEMO`. Two widgets on one board, or a manual refresh landing on top
 * of a poll, must not mean two `lsof` calls and two `docker ps`.
 */
const machine = new Memo();

/**
 * Every project this environment knows about, from both stores.
 *
 * The registry and the link store answer different questions — "is this a
 * project card" and "is this a checkout on disk" — and a dev server's cwd might
 * be in either. Registry entries come second so that when both claim a path,
 * the longest-match join sees the one carrying the id.
 */
function knownProjects(env: EnvRoot): KnownProject[] {
  const known: KnownProject[] = links.load(env).links.map((l) => ({ path: l.path, id: null, isRepoLink: true }));
  for (const p of projects.registry(env).projects) {
    // A path in both stores keeps its repo-link status: the terminal and IDE
    // actions key off the path either way, and the id is what the + Project
    // affordance checks.
    const existing = known.find((k) => k.path === p.path);
    if (existing !== undefined) existing.id = p.id;
    else known.push({ path: p.path, id: p.id, isRepoLink: false });
  }
  return known;
}

function findProject(env: EnvRoot, id: string) {
  const entry = projects.registry(env).projects.find((p) => p.id === id);
  if (!entry) throw DddError.notFound(`project ${JSON.stringify(id)}`);
  return entry;
}

/** One repo, joined with what we know about it locally. Port of `RepoRow`. */
interface RepoRow {
  nameWithOwner: string;
  url: string;
  /** Normalized remote — the key everything else uses. */
  remote: string;
  cloneUrl: string;
  facts: string;
  pushedAt: string;
  localPath: string | null;
  /** `exact` or `fallback`. A fallback match is a guess and is shown as one. */
  matchConfidence: string | null;
  /** Linked, but the folder is not there right now. */
  missing: boolean;
  projectId: string | null;
}

/** A checkout on disk that no fetched repo claims. Not a stored category: it is
 *  whatever is left after the GitHub rows have taken their links, so a repo
 *  changes section on its own the moment the facts change. */
interface LocalRepoRow {
  path: string;
  name: string;
  origin: string | null;
  originHost: string | null;
  missing: boolean;
  projectId: string | null;
}

interface RepoListing {
  rows: RepoRow[];
  localOnly: LocalRepoRow[];
  capped: boolean;
  total: number;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The last path component — what the user calls this repo. */
const leaf = (path: string): string => basename(path) || path;

function parseInstant(value: string, field: string): Date {
  const at = calendar.parseRfc3339(value);
  // Note the message has no value in it — unlike `calendar/store.ts`'s.
  if (at === null) throw DddError.config(`${field} is not an RFC 3339 timestamp`);
  return at;
}

/** Rebuild an expandable event from what the adapter put in `refs`. */
function specFromItem(item: Item, settings: Settings): EventSpec | null {
  const pick = (prefix: string): string | null => {
    for (const r of item.refs) if (r.startsWith(prefix)) return r.slice(prefix.length);
    return null;
  };
  const all = (prefix: string): string[] =>
    item.refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));

  const connection = settings.connections.find((c) => c.id === item.connectionId);

  const startRef = pick("dtstart:");
  const endRef = pick("dtend:");
  if (startRef === null || endRef === null) return null;
  const start = calendar.parseRfc3339(startRef);
  const end = calendar.parseRfc3339(endRef);
  if (start === null || end === null) return null;

  const series = pick("series:");
  const recurrenceRef = pick("recurrenceid:");
  const recurrenceId = recurrenceRef === null ? null : calendar.parseRfc3339(recurrenceRef);
  const overrides: Override | null =
    series !== null && recurrenceId !== null
      ? // The series id must be the *item* id the series was stored under, not
        // the bare UID, or the override never matches anything.
        { seriesId: makeItemId(item.connectionId, series), recurrenceId }
      : null;

  return {
    id: item.id,
    title: item.title,
    start,
    end,
    allDay: pick("allday:") === "true",
    tzid: pick("tzid:"),
    rrule: pick("rrule:"),
    exdates: all("exdate:")
      .map((v) => calendar.parseRfc3339(v))
      .filter((d): d is Date => d !== null),
    overrides,
    calendar: pick("calendar:") ?? connection?.label ?? "Calendar",
    color: connection?.config.color ?? "#00a99f",
    // A subscribed feed is read-only. Offering an edit that the next sync
    // silently reverts would be worse than offering none.
    editable: false,
    location: pick("location:"),
    url: item.url ?? null,
  };
}

function specFromLocal(event: calendar.LocalEvent, color: string): EventSpec | null {
  const start = calendar.parseRfc3339(event.start);
  const end = calendar.parseRfc3339(event.end);
  if (start === null || end === null) return null;
  return {
    id: event.id,
    title: event.title,
    start,
    end,
    allDay: event.allDay,
    tzid: null,
    rrule: event.rrule,
    exdates: [],
    overrides: null,
    calendar: "My calendar",
    color,
    editable: true,
    location: null,
    url: null,
  };
}

/** Enough entropy for a local id. Not a security boundary — it only has to not
 *  collide inside one user's calendar file. The Rust formats nanoseconds since
 *  the epoch as hex; JS has milliseconds, so the sub-millisecond digits come
 *  from a random draw, which serves the same purpose. */
function uuidIsh(): string {
  return (BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000))).toString(16);
}

/** Best guess at a MIME type when the source did not give one: by extension,
 *  falling back to JPEG — the common case for album art. */
function artMime(contentType: string | null, url: string): string {
  if (contentType) return contentType.split(";")[0]!.trim();
  const ext = url.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/** Cap on the `artDataUrl` cache: one track's worth of headroom per player,
 *  not a general-purpose image cache. */
const ART_CACHE_MAX = 4;
const artCache = new Map<string, string>();

/** Album art is a small cover thumbnail; anything bigger is refused rather
 *  than read into memory — bounds both a huge/stalled `file://` source (a
 *  hung mount, a multi-GB file) and a large or slow-loris-style http body. */
const ART_MAX_BYTES = 8 * 1024 * 1024;

function isImageContentType(contentType: string | null): boolean {
  if (!contentType) return true; // undetermined — artMime falls back to a guess by extension
  return contentType.split(";")[0]!.trim().toLowerCase().startsWith("image/");
}

/**
 * An `http(s)` or `file://` album-art URL, inlined as a `data:` URL so the
 * renderer never makes its own network or filesystem request. Art is
 * best-effort: any failure (network, timeout, missing file, oversize, wrong
 * content type) returns `null` rather than surfacing an error, and the
 * caller just keeps the old art.
 *
 * Cached by source URL for `http(s)` sources — capped at a handful of
 * entries — so a 3-second poll of an unchanged track re-fetches nothing.
 * `file://` sources are never served from cache: some MPRIS players reuse a
 * fixed path (e.g. `/tmp/…coverart`) whose bytes change per track, so caching
 * by URL would show a stale cover.
 */
async function artDataUrl(url: string, fetchFn: typeof globalThis.fetch): Promise<string | null> {
  const isFile = url.startsWith("file://");
  if (!isFile && !url.startsWith("http://") && !url.startsWith("https://")) return null;

  if (!isFile) {
    const cached = artCache.get(url);
    if (cached) return cached;
  }

  try {
    let dataUrl: string;
    if (isFile) {
      // Trust boundary: this path comes from local MPRIS/media-app metadata
      // (playerctl / osascript output), not from the network — still capped
      // below because "local" doesn't mean "small" (a hung mount, a
      // multi-GB file).
      const path = fileURLToPath(url);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        return null;
      }
      if (size > ART_MAX_BYTES) return null;
      const buf = await readFile(path);
      if (buf.byteLength > ART_MAX_BYTES) return null;
      dataUrl = `data:${artMime(null, url)};base64,${buf.toString("base64")}`;
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      let res: Response;
      try {
        res = await fetchFn(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      const contentType = res.headers.get("content-type");
      if (!isImageContentType(contentType)) return null;
      const lenHeader = res.headers.get("content-length");
      if (lenHeader && Number(lenHeader) > ART_MAX_BYTES) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > ART_MAX_BYTES) return null;
      dataUrl = `data:${artMime(contentType, url)};base64,${buf.toString("base64")}`;
    }
    if (!isFile) {
      artCache.set(url, dataUrl);
      if (artCache.size > ART_CACHE_MAX) {
        const oldest = artCache.keys().next().value;
        if (oldest !== undefined) artCache.delete(oldest);
      }
    }
    return dataUrl;
  } catch {
    return null;
  }
}

export function createCommands(deps: CommandDeps): Record<string, Handler> {
  return {
    // --- environments ---
    global_load: () => globalLoad(),
    global_appearance_save: ({ appearance }) => globalAppearanceSave(appearanceRequired(appearance)),
    global_wizard_save: ({ completed, step }) => globalWizardSave(Boolean(completed), Number(step ?? 0)),
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

    /** A per-tab "what happened while I was away" summary, once, with a local
     *  model by default. Every failure surfaces as an error and the caller
     *  falls back to its deterministic digest. */
    tab_sitrep_generate: async ({ env, input }) => {
      const r = root(env);
      const settings = settingsLoad(r);
      const chosen = route(r, settings, sitrep.ACTION, deps.sync);
      const si = input as sitrep.SitrepInput;
      const draft = await chosen.provider.complete(sitrep.completionFor(si, chosen.model));
      if (draft.refusal !== null) throw DddError.invalid(draft.refusal);
      events.log(r, {
        kind: "ai.tab.sitrep",
        source: chosen.provider.id,
        project: si.projectName,
        tokensIn: draft.usage.inputTokens,
        tokensOut: draft.usage.outputTokens,
        costMicros: draft.usage.costMicros,
        meta: { away: si.awayDays },
      });
      return { text: draft.text, model: chosen.model };
    },

    // --- calendar -----------------------------------------------------------

    /** Everything on the calendar in a window, from both sources at once.
     *
     *  Subscribed events come from the item cache like every other widget's
     *  data; your own come from `calendar.json`, which exists because the cache
     *  is wiped and replaced on each sync. Recurrence is expanded here, on read
     *  — a weekly rule with no end has infinitely many occurrences and cannot
     *  be stored. */
    calendar_list: async ({ env, from, to }) => {
      const r = root(env);
      const start = parseInstant(String(from), "from");
      const end = parseInstant(String(to), "to");

      // `settings_load(...).unwrap_or_default()` in the Rust: a broken
      // settings file must not empty the calendar.
      let settings: Settings;
      try {
        settings = settingsLoad(r);
      } catch {
        settings = defaultSettings();
      }

      const filter: ItemFilter = { kind: "event", limit: 5000 };
      const specs: EventSpec[] = [];
      for (const item of cache.query(r, filter)) {
        const spec = specFromItem(item, settings);
        if (spec !== null) specs.push(spec);
      }

      const colour = settings.connections.find((c) => c.provider === "calendar.ics")?.config.color ?? "#00a99f";

      for (const event of calendar.load(r).events) {
        const spec = specFromLocal(event, colour);
        if (spec !== null) specs.push(spec);
      }

      return expand(specs, start, end);
    },

    calendar_event_save: async ({ env, event }) => {
      const r = root(env);
      const parsed = calendar.localEventFromJson(event);
      const withId =
        parsed.id.trim() === "" ? { ...parsed, id: `ev-${uuidIsh()}` } : parsed;
      return calendar.upsert(r, withId);
    },

    calendar_event_delete: async ({ env, id }) => {
      calendar.remove(root(env), String(id));
    },

    // --- repos: the bridge between what GitHub knows and what is on disk ---

    /** Repos joined with local state. Reads the cache and the link store; makes
     *  no network call of its own. */
    repos_list: async ({ env, filter }): Promise<RepoListing> => {
      const r = root(env);
      const f = repoFilterFromJson(filter ?? {});
      const items = cache.query(r, { source: "github", kind: "repo", limit: 1000 });
      const stored = links.load(r);
      const reg = projects.registry(r);

      const scope = f.scope ?? "recent";
      const cutoff = Date.now() - 183 * 24 * 60 * 60 * 1000;
      const needle = f.query === undefined ? null : f.query.toLowerCase();

      const total = items.length;
      const rows: RepoRow[] = [];
      // Which stored checkouts a GitHub row consumed. Whatever is left over is
      // local-only — derived here, never stored as a category.
      const claimed = new Set<string>();

      for (const item of items) {
        if (scope === "recent") {
          // The Rust's `parse_from_rfc3339(..).map(..).unwrap_or(true)`: a
          // timestamp that cannot be parsed counts as fresh. `Date.parse` is
          // laxer than chrono, which only shows on strings chrono would reject.
          const at = Date.parse(item.updatedAt);
          const fresh = Number.isNaN(at) ? true : at > cutoff;
          if (!fresh) continue;
        }
        if (needle !== null && !item.title.toLowerCase().includes(needle)) continue;

        const pick = (prefix: string): string => {
          const ref = item.refs.find((x) => x.startsWith(prefix));
          return ref === undefined ? "" : ref.slice(prefix.length);
        };
        const normalized = pick("remote:");
        const https = pick("https:");
        const ssh = pick("ssh:");

        // Which tier matched, not what the stored link's own confidence says —
        // see `links.findWithTier`.
        const matched = links.findWithTier(stored, normalized, https);
        const cloneUrl = stored.preferredProtocol === "ssh" && ssh !== "" ? ssh : https;

        let localPath: string | null = null;
        let matchConfidence: string | null = null;
        let missing = false;
        if (matched !== null) {
          claimed.add(matched.link.path);
          localPath = matched.link.path;
          matchConfidence = matched.confidence;
          missing = !isDir(matched.link.path);
        }
        const projectId = localPath === null ? null : (reg.projects.find((p) => p.path === localPath)?.id ?? null);

        rows.push({
          nameWithOwner: item.title,
          url: item.url ?? "",
          remote: normalized,
          cloneUrl,
          facts: item.body ?? "",
          pushedAt: item.updatedAt,
          localPath,
          matchConfidence,
          missing,
          projectId,
        });
      }

      // Everything DDD knows is a checkout, minus what the rows above took. The
      // scope switch deliberately does not apply: it filters on `pushedAt`,
      // which a local checkout does not have.
      const localOnly: LocalRepoRow[] = stored.links
        .filter((link) => !claimed.has(link.path))
        .filter((link) => {
          if (needle === null) return true;
          return leaf(link.path).toLowerCase().includes(needle) || (link.remote !== null && link.remote.toLowerCase().includes(needle));
        })
        .map((link) => ({
          path: link.path,
          name: leaf(link.path),
          origin: link.remote,
          // `normalize` produces `host/owner/repo`, so the host is the first
          // segment — parsed here so the badge has nothing to do.
          originHost: link.remote === null ? null : (link.remote.split("/")[0] ?? null),
          missing: !isDir(link.path),
          projectId: reg.projects.find((p) => p.path === link.path)?.id ?? null,
        }));

      // 300 is the fetch cap from the spec; hitting it exactly means there are
      // probably more.
      return { rows, localOnly, capped: total >= 300, total };
    },

    /** Walk a folder the user nominated and link every checkout it finds.
     *  Read-only against those repos, and it does **not** register them as
     *  projects — filling the projects list uninvited is presumptuous. */
    repo_scan: async ({ env, rootDir }) => {
      const r = root(env);
      const dir = String(rootDir);
      if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);

      const found = await scan.scanRoot(dir);
      const stored = links.load(r);

      if (stored.preferredProtocol === null) stored.preferredProtocol = scan.inferProtocol(found);
      if (!stored.scanRoots.includes(dir)) stored.scanRoots.push(dir);

      // A set of normalized remotes, not a counter: two checkouts on disk can
      // share one remote (a worktree, two clones for two IDE windows), and the
      // loop below then touches that remote twice — only the later one survives
      // in `stored.links`. Counting loop passes instead of distinct remotes
      // reports N when only N-1 (or fewer) links actually end up persisted.
      const touched = new Set<string>();
      for (const { path, url } of found) {
        // A checkout with no resolvable origin is still a checkout. It is stored
        // with `remote: null` and shows in the local-only section rather than
        // being dropped on the floor.
        const normalized = url === null ? null : normalize(url);
        // See `links.canonicalPath`: stored path must be canonical or the
        // projectId join in `repos_list` never fires. A scan is best-effort and
        // freely re-runnable, so a repo that cannot be canonicalized
        // (permissions, a symlink race) is skipped rather than costing the whole
        // scan its roots.
        let canonical: string;
        try {
          canonical = links.canonicalPath(path);
        } catch {
          continue;
        }
        // A manual record is the user's decision and a scan never overrides it —
        // by *either* identifier. Path alone is not enough: a user who manually
        // pointed this remote at a different folder would have that decision
        // evicted the next time the scan walked past the original checkout.
        // Remote alone is not enough either, since a remote-less checkout has no
        // remote to check by.
        if (stored.links.some((l) => l.source === "manual" && (l.path === canonical || (normalized !== null && l.remote === normalized)))) continue;
        // Hold both store invariants inline: one record per path, one per
        // non-null remote.
        stored.links = stored.links.filter((l) => l.path !== canonical && !(normalized !== null && l.remote === normalized));
        stored.links.push({ remote: normalized, path: canonical, source: "scan", confidence: "exact" });
        // Key by remote when there is one, by path otherwise.
        touched.add(normalized ?? canonical);
      }

      links.save(r, stored);
      return touched.size;
    },

    /** Point a repo at a folder, and register that folder as a project. A
     *  different remote at that path is allowed with the link flagged rather
     *  than refused — forks and worktrees are legitimate. */
    repo_link: async ({ env, remote, path }) => {
      const r = root(env);
      const dir = String(path);
      if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);

      const url = await projects.gitRemote(dir);
      const actual = url === null ? null : normalize(url);
      const confidence = actual === remote ? "exact" : "fallback";

      // See `links.canonicalPath`: stored path must be canonical or the
      // projectId join in `repos_list` never fires.
      const canonical = links.canonicalPath(dir);
      links.upsert(r, { remote: String(remote), path: canonical, source: "manual", confidence });

      // You clicked, so registering is the point. `projects.register` does its
      // own canonicalization of `path`, independently of the one above.
      projects.register(r, dir);
    },

    /** Add a checkout DDD has not discovered, and register it as a project. The
     *  scan finds what is under a nominated root; this is for everything else. */
    repo_add_local: async ({ env, path }) => {
      const r = root(env);
      const dir = String(path);
      if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);
      if (!existsSync(join(dir, ".git"))) {
        // This is the Repositories widget; a folder that is not a repository
        // does not belong in it, and the message says where it does belong.
        throw DddError.invalid(`${dir} is not a git repository — use the Projects widget to add a plain folder`);
      }

      const canonical = links.canonicalPath(dir);
      const url = await projects.gitRemote(dir);
      const remote = url === null ? null : normalize(url);

      // Whatever remote was recorded was read out of the checkout itself, not
      // guessed at. (`confidence` on a stored record is informational;
      // `repos_list` reports the tier its own join used.)
      links.upsert(r, { remote, path: canonical, source: "manual", confidence: "exact" });
      projects.register(r, dir);
    },

    /** Forget a checkout by path. Touches neither the folder nor the project
     *  registry — the same rule `repo_unlink` follows, by the other identifier. */
    repo_forget: async ({ env, path }) => {
      links.removeByPath(root(env), String(path));
    },

    /** Drop a link. Unlinking a repo from its folder says nothing about whether
     *  that folder still belongs in the projects list. */
    repo_unlink: async ({ env, remote }) => {
      links.remove(root(env), String(remote));
    },

    /** Clone a repo into a parent directory, detached. Returns as soon as the
     *  work is spawned; the row follows along via `ddd://repo-progress`, the
     *  same event channel the file watcher uses. */
    repo_clone: async ({ env, remote, cloneUrl, parentDir }) => {
      const r = root(env);
      // Prepared before detaching: a refusal must reach the user as a failed
      // command, not as a progress event nobody is listening for yet.
      const target = clone.prepare(String(parentDir), String(remote));
      void clone
        .run(r, String(remote), String(cloneUrl), target, (p: clone.Progress) => {
          deps.emit.emit("ddd://repo-progress", { remote: String(remote), phase: p.phase, percent: p.percent, done: p.done, error: p.error });
        })
        .catch(() => {
          // `run` reports its own failures as a final tick; this only catches a
          // bug in the runner itself, which must not become an unhandled
          // rejection that takes the app down.
        });
      return target;
    },

    /** What landed in a repo since a timestamp — the sitrep widget's git
     *  delta. nodeDDD-only: there is no Rust counterpart. */
    repo_changes_since: async ({ env, path, since }) => {
      void env;
      return changesSince(execFileRunner, String(path), String(since));
    },

    // --- dev servers: a live read of the machine. Writes nothing. ---

    /** What is listening, joined against this environment's projects and repo
     *  links. Reads the OS and two JSON stores; makes no network call, touches
     *  no item cache, and writes nothing at all. */
    dev_servers_list: async ({ env, filter }) => {
      // Parsed outside the guard: a bad filter is the caller's mistake, not a
      // scan failure, and must keep surfacing as the `json: ` error it is —
      // same as the Rust, whose filter is deserialized before this function
      // body (the `spawn_blocking` closure) ever runs.
      const wanted = devServerFilterFromJson(filter ?? {});
      try {
        const known = knownProjects(root(env));
        const snapshot = await machine.get(Date.now(), MEMO_FLOOR_MS, deps.machineRead ?? readMachine);
        return await devServerList(snapshot, known, wanted);
      } catch (e) {
        throw DddError.invalid(`dev server scan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    /** Probe one row on demand — the Check button, and the only way to get a
     *  latency for a process that is not in the HTTP list. */
    dev_server_probe: async ({ address, port, http }) => {
      try {
        const found = await probe.run(probe.target(String(address), Number(port)), Boolean(http), probe.DEADLINE_MS);
        const out: probe.DevProbe = { health: found.health, latencyMs: found.latencyMs, checkedAt: new Date().toISOString() };
        return out;
      } catch (e) {
        throw DddError.invalid(`probe failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    /** `SIGTERM`, behind the PID-reuse guard. The only destructive thing on
     *  this board, and the reason it is defensible is that it re-reads the
     *  machine *now* rather than trusting a row that may be ten seconds old.
     *
     *  There is no force option at any depth of menu, and no `sudo` path. */
    dev_server_stop: async ({ env, key, pid, process: processName }) => {
      const r = root(env);
      // Deliberately not the memo: a two-second-old snapshot is exactly what
      // the guard exists to distrust.
      const fresh = await listen.enumerate();
      const refusal = mayStop(String(key), Number(pid), String(processName), fresh);
      if (refusal !== null) throw DddError.invalid(refusalMessage(refusal));

      signal(Number(pid));

      // Logged because it is destructive and irreversible, in the same table
      // the rest of the board's actions are already visible in. The Rust
      // ignores a failure here too: the signal has already been sent.
      try {
        events.log(r, {
          kind: "dev.stop",
          source: "local",
          project: null,
          tokensIn: null,
          tokensOut: null,
          costMicros: null,
          meta: { key: String(key), pid: Number(pid), process: String(processName) },
        });
      } catch {
        // Nothing to do: the process is already stopping.
      }
    },

    // --- the EOL watcher ---

    /**
     * The board: what you assigned, what each checkout declares, and whether it
     * is still supported.
     *
     * Reads the watchlist and the checkouts on every call; goes to the network
     * only for a product whose schedule is missing or over a week old. Six
     * Symfony projects are one request, and a week later it is still one.
     */
    eol_board: async ({ env }) => {
      const r = root(env);
      const watched = eolWatchlist.load(r).watched;

      // Reading manifests is blocking file work; the fetch after it is not.
      const declarations: eolBoard.Declarations = watched.map((w) => [w.path, eolDetect.forDir(w.path)]);

      const now = new Date().toISOString();
      // The one store read-modify-written across `await`s, as the Rust does:
      // `eol-cache.json` is derived and safe to lose, and the alternative is
      // holding the whole app still for a network round trip.
      const cache = eolSchedule.load(r);
      const wanted = eolBoard.productsNeeded(declarations);
      const stale = await eolSchedule.refresh(deps.sync.fetch, cache, wanted, now);

      // The live URLs, at most once an hour each. Someone else's server, so
      // this is deliberately the slowest thing on the board.
      await eolLive.refresh(deps.sync.fetch, cache.live, eolBoard.urlsToCheck(watched), now);

      // Written back even when some products failed: whatever did refresh is
      // worth keeping, and the ones that did not kept their old entries.
      eolSchedule.save(r, cache);

      // `now.format("%Y-%m-%d")` on a UTC instant is the first ten characters.
      return eolBoard.build(watched, declarations, cache, cache.live, now.slice(0, 10), now, stale);
    },

    /** Assign a checkout to the watcher, with the live URL you typed for it. */
    eol_watch: async ({ env, path, url, note }) =>
      eolWatchlist.add(
        root(env),
        String(path),
        url === undefined || url === null ? null : String(url),
        note === undefined || note === null ? null : String(note),
      ),

    /** Stop watching. Forgets the record; the checkout on disk is untouched. */
    eol_unwatch: async ({ env, path }) => eolWatchlist.remove(root(env), String(path)),

    eol_watchlist: async ({ env }) => eolWatchlist.load(root(env)),

    // --- products: what a repo declares it can run, behind a consent gate ---

    /** Every product every registered project declares, with its live state.
     *  `configOf`, not `load`: this refreshes on a timer and must run no git;
     *  an unreadable config declares nothing rather than failing the board. */
    products_list: async ({ env }) => {
      const r = root(env);
      const reg = projects.registry(r);
      const all: Product[] = [];
      for (const entry of reg.projects) {
        const config = projects.configOf(entry.path);
        if (config.products.length === 0) continue;
        all.push(...(await supervise.assemble(r, entry.id, entry.path, config.products)));
      }
      return all;
    },

    /** Approve exactly what the caller is looking at — the command and directory
     *  passed, not a re-read of a file that may have changed since the render. */
    product_approve: ({ env, key, run, dir }) =>
      supervise.approve(root(env), String(key), String(run), String(dir)),
    product_revoke: ({ env, key }) => supervise.revoke(root(env), String(key)),

    /** Start a product. Refuses unless this exact command has been approved. */
    product_start: async ({ env, key, run, dir }) => {
      const r = root(env);
      const record = await supervise.start(r, String(key), String(run), String(dir));
      events.log(r, {
        kind: "product.start",
        source: "local",
        project: record.projectId,
        tokensIn: null,
        tokensOut: null,
        costMicros: null,
        meta: { product: record.productId, pid: record.pid },
      });
    },

    /** Ask a product to stop: `SIGTERM`, only after the guard passes. Returns
     *  the resulting state. */
    product_stop: async ({ env, key }) => {
      const r = root(env);
      const state = await supervise.stop(r, String(key));
      events.log(r, {
        kind: "product.stop",
        source: "local",
        project: String(key).split("/")[0] ?? "",
        tokensIn: null,
        tokensOut: null,
        costMicros: null,
        meta: null,
      });
      return state;
    },

    /** The whole captured log, for the panel behind "output". */
    product_log: async ({ env, key }) => {
      const r = root(env);
      return productLog.tail(productLog.file(r.productsLogDir(), String(key)), 400);
    },

    // --- MCP: one gate, and one probe that goes through it ---

    /**
     * The token a user's approval of a command is recorded against.
     *
     * Bound to the exact argv, so editing the command in Settings voids the
     * approval: what you agreed to run is no longer what would run.
     */
    mcp_consent: async ({ command }) => consentToken(parseArgv(String(command))),

    /**
     * Handshake with a server and report what it offers, without writing
     * anything.
     *
     * Deliberately the same code path a real sync takes: a "test connection"
     * that tests something else is worse than none — including the consent
     * check, so a server the user has not approved is refused here too.
     */
    mcp_probe: async ({ env, connectionId }) => {
      const r = root(env);
      const connection = settingsLoad(r).connections.find((c) => c.id === connectionId);
      if (!connection) throw DddError.notFound(`connection ${JSON.stringify(connectionId)}`);
      const token = await oauth.accessToken(r, connection, deps.sync);
      const cx = fetchContext({ environmentId: r.id, connection, token, fetch: deps.sync.fetch });
      return new McpAdapter().probe(cx);
    },

    // --- media: OS-level playback control, for the media widget ---

    /** Every player found, and which one the widget follows. Every player's
     *  album art (if any) is inlined as a `data:` URL — not just the active
     *  one — because the widget can be pinned to a non-active player, and a
     *  raw `https://`/`file://` URL would be blocked by the renderer's CSP.
     *  nodeDDD-only: there is no Rust counterpart. */
    media_state: async () => {
      const s = await mediaControl.state();
      await Promise.all(
        s.players.map(async (p) => {
          const track = p.track;
          const url = track?.artUrl;
          if (!track || !url) return;
          const dataUrl = await artDataUrl(url, deps.sync.fetch);
          if (dataUrl) track.artUrl = dataUrl;
        }),
      );
      return s;
    },

    /** Play/pause, skip, or set volume on one player. nodeDDD-only: there is
     *  no Rust counterpart. */
    media_command: async ({ player, action, value }) => {
      await mediaControl.command(
        String(player),
        action as mediaControl.MediaAction,
        value === undefined ? undefined : Number(value),
      );
    },

    // --- local models: what the runtimes downloaded, and moving one out ---

    /** Every runtime store and the models inside it. nodeDDD-only. */
    models_scan: async () => modelScan.scan(deps.modelRoots ?? modelScan.defaultRoots()),

    /** Physically move one model (by its scan id) into `dest`, streaming
     *  `ddd://models-progress` while it copies. The model is looked up fresh
     *  so the path used is always what is on disk now, never what the widget
     *  remembered. nodeDDD-only. */
    models_move: async ({ id, dest }) => {
      const roots = deps.modelRoots ?? modelScan.defaultRoots();
      const wanted = String(id);
      const found = (await modelScan.scan(roots)).stores.flatMap((s) => s.models).find((m) => m.id === wanted);
      if (!found) throw DddError.notFound(`no model ${JSON.stringify(wanted)} in any store`);
      return modelMove.moveModel(found, roots, String(dest), (p) => deps.emit.emit("ddd://models-progress", p));
    },
  };
}
