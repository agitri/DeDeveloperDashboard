// The shapes on this side of the IPC boundary mirror `src-tauri/src/models.rs`
// exactly. Keep them in lockstep: the JSON on disk is the contract, and people
// are expected to open and edit those files by hand.

export interface Environment {
  id: string;
  name: string;
  /** Every tab in this environment carries this colour. */
  color: string;
  hidden: boolean;
  /** Its tabs are folded away in the strip. Distinct from `hidden`, which
   *  removes the environment from the strip entirely. */
  collapsed?: boolean;
}

/** The onboarding tour's progress — app-global, like appearance. */
export interface WizardState {
  completed: boolean;
  step: number;
}

export interface Global {
  /** One appearance for the whole app, not one per environment. */
  appearance: AppearanceSettings;
  version: number;
  environments: Environment[];
  activeEnvironmentId: string;
  wizard?: WizardState | null;
}

export interface GridPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A widget is a data source, a filter over it, and a view. Nothing else. */
export interface Widget {
  id: string;
  /** Registry key of the view: `clock`, `notes`, `projects`, `github.pulls`… */
  kind: string;
  title?: string | null;
  /**
   * Which connection feeds it. A widget may only bind to a connection from its
   * tab's environment — that rule is what makes the isolation real.
   */
  connectionId?: string | null;
  /** Scope: as wide as "all my PRs" or as narrow as "PRs of repo X". */
  filter: Record<string, unknown>;
  config: Record<string, unknown>;
  /** What the widget asks the central scheduler for. Never its own poll loop. */
  refreshSeconds?: number | null;
  layout: GridPos;
}

export interface TabGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
}

export interface Tab {
  id: string;
  name: string;
  color?: string | null;
  groupId?: string | null;
  widgets: Widget[];
  /** ISO time the user last switched away from this tab; drives the sitrep "away" banner. */
  lastVisitedAt?: string | null;
}

export interface Layout {
  version: number;
  groups: TabGroup[];
  tabs: Tab[];
}

/** A tab plus the environment it came from — the frontend's working unit. */
export interface EnvTab extends Tab {
  environmentId: string;
}

export interface ItemAction {
  id: string;
  label: string;
  /** True when invoking it sends something outward: the approval gate applies. */
  outbound: boolean;
}

/** The one normalized shape every adapter produces (§6). */
export interface Item {
  id: string;
  environmentId: string;
  connectionId: string;
  source: string;
  kind: string;
  project?: string | null;
  title: string;
  body?: string | null;
  url?: string | null;
  refs: string[];
  actions: ItemAction[];
  updatedAt: string;
  unread: boolean;
}

/** Mirrors `sync::cache::ItemFilter`. Every field optional — that is what lets
 *  one widget serve "all my PRs" and "PRs of repo X" (§5.2). */
export interface ItemFilter {
  connectionId?: string | null;
  source?: string | null;
  kind?: string | null;
  project?: string | null;
  query?: string | null;
  unreadOnly?: boolean | null;
  limit?: number | null;
  excludeKinds?: string[] | null;
}

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt?: string | null;
  source?: string | null;
}

export interface Deployment {
  name: string;
  url: string;
}

export interface ProjectConfig {
  name?: string | null;
  repos: string[];
  deployments: Deployment[];
  terminal?: string | null;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string | null;
  dirtyFiles: number;
  ahead: number;
  behind: number;
  lastCommitSummary?: string | null;
  lastCommitAt?: string | null;
}

export interface Project {
  id: string;
  path: string;
  name: string;
  exists: boolean;
  config: ProjectConfig;
  git: GitStatus;
  /** `.ddd/recap.md`, written by the Claude Code SessionEnd hook. */
  recap?: string | null;
  recapUpdatedAt?: string | null;
  todos: Todo[];
  icmFiles: string[];
}

export interface Occurrence {
  id: string;
  title: string;
  /** RFC 3339, UTC. Render it in local time; never slice the string. */
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
  color: string;
  /** Only your own events. Subscribed feeds are read-only. */
  editable: boolean;
  location: string | null;
  url: string | null;
  /** The rule could not be expanded; this stands in for the whole series. */
  recurringUnexpanded: boolean;
}

export interface LocalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  rrule?: string | null;
  notes?: string | null;
}

export interface LocalRepoRow {
  path: string;
  name: string;
  origin: string | null;
  /** Host segment of `origin`; null renders "no remote". */
  originHost: string | null;
  missing: boolean;
  projectId: string | null;
}

export type ConnectionStatus = "disconnected" | "connected" | "expired" | "error";

export interface Connection {
  id: string;
  provider: string;
  label: string;
  status: ConnectionStatus;
  scopes: string[];
  /** Adapter-specific settings (Jira site URL, account email). Never secrets. */
  config: Record<string, string>;
  lastSyncAt?: string | null;
  error?: string | null;
}

/** How the app looks and behaves, for every environment at once. */
/** An installed app DDD found: an editor or a terminal. */
export interface FoundApp {
  id: string;
  name: string;
  /** What to store in settings — opaque on purpose. */
  target: string;
}

export interface AppearanceSettings {
  theme: "system" | "light" | "dark";
  /** Which visual system renders the app. Applied on the next window load. */
  look?: "classic" | "console";
  terminalApp?: string | null;
  /** Editor for "Open in IDE". A bundle name, a CLI, or a `{dir}` template. */
  editor?: string | null;
  launchCommand: string;
  defaultRefreshSeconds: number;
  showShortcutHints: boolean;
}

export interface Settings {
  version: number;
  ai: {
    defaultProvider: string;
    ollamaUrl: string;
    openaiCompatibleUrl?: string | null;
    routing: Record<string, string>;
    monthlyBudgetUsd?: number | null;
    anthropicModel: string;
    localModel: string;
    openaiModel: string;
    /** Let the local model settle mail the rule scorer is unsure about. */
    classifyMailLocally: boolean;
  };
  voice: {
    enabled: boolean;
    sttMode: string;
    sttModel: string;
    ttsEngine: string;
    ttsVoice?: string | null;
    microphone?: string | null;
  };
  data: { statsLoggingEnabled: boolean };
  connections: Connection[];
}

export interface AiActionInfo {
  id: string;
  label: string;
  /** `composer` pre-fills an outbound action; `panel` is read-only output. */
  target: "composer" | "panel";
}

/** A proposal. Never sent — it lands in the composer for a human to approve. */
export interface AiDraft {
  text: string;
  model: string;
  target: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  refusal?: string | null;
  usedProjectContext: boolean;
}

export interface EventInput {
  kind: string;
  source?: string | null;
  project?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costMicros?: number | null;
  meta?: unknown;
}

export interface EventRow extends EventInput {
  id: number;
  ts: string;
}

export interface RepoRow {
  nameWithOwner: string;
  url: string;
  remote: string;
  cloneUrl: string;
  facts: string;
  pushedAt: string;
  localPath?: string | null;
  /** `exact` or `fallback` — a fallback match is a guess, shown as one. */
  matchConfidence?: string | null;
  missing: boolean;
  projectId?: string | null;
}

export interface RepoListing {
  rows: RepoRow[];
  /** Checkouts DDD knows about that no fetched repo matched. */
  localOnly: LocalRepoRow[];
  capped: boolean;
  total: number;
}

/** The repos widget's own filter shape — distinct from `ItemFilter`, not a variant of it. */
export interface RepoFilter {
  scope?: string;
  query?: string;
}

/** One listening socket, joined against what this environment knows. */
export interface DevServerRow {
  /** `tcp:127.0.0.1:8005` — identity, React key, and the handle for stop. */
  key: string;
  port: number;
  address: string;
  /** `v4` | `v6` — the family is load-bearing here, so it is rendered. */
  family: string;
  pid: number | null;
  process: string | null;
  cwd: string | null;
  projectName: string | null;
  projectId: string | null;
  repoPath: string | null;
  /** The match came from an ancestor: a monorepo row rolled up to its project. */
  matchedAncestor: boolean;
  /** Null when we have no reason to think it speaks HTTP. No fabricated links. */
  url: string | null;
  health: "unknown" | "up" | "slow" | "down";
  latencyMs: number | null;
  checkedAt: string | null;
  /** Another UID's socket: no PID, not ours to probe or stop. */
  foreign: boolean;
  /** A Docker-published port. Shown, marked, and never probed. */
  docker: boolean;
  /** The drill-down: containers composed from this row's project directory. */
  containers: DevContainer[];
  /** Extra processes sharing this exact socket — a forked pool is one server. */
  workers: number;
}

export interface DevContainer {
  name: string;
  /** The compose project — what `docker ps` prefixes every container with. */
  project: string;
  status: string;
  running: boolean;
  unhealthy: boolean;
  ports: number[];
}

export interface DevServerListing {
  rows: DevServerRow[];
  /** Listeners that exist but are filtered out — a number, not a vibe. */
  hidden: number;
  foreignCount: number;
  scanMs: number;
  partial: boolean;
}

export interface DevServerFilter {
  knownOnly?: boolean;
  /** Ports the kernel assigned rather than a human chose. Default false. */
  ephemeral?: boolean;
  query?: string;
  http?: string[];
  probe?: boolean;
}

export interface DevProbe {
  health: DevServerRow["health"];
  latencyMs: number | null;
  checkedAt: string;
}

/** The prose for one widget, as it is on disk. */
export interface Instructions {
  text: string;
  /** Of the text. Stored beside the compiled filter to detect outside edits. */
  hash: string;
  path: string;
  exists: boolean;
}

/** The cache in `widget.config.instructions` — never the source of truth. */
export interface Compiled {
  sourceHash: string;
  filter: Record<string, unknown>;
  compiledAt: string;
  /** What the schema could not express, in the user's own words. */
  unmet: string[];
  model: string;
}

/** `{ state: "endingSoon", days: 46 }` — the days ride along with the state. */
export type Support =
  | { state: "active" }
  | { state: "securityOnly" }
  | { state: "endingSoon"; days: number }
  | { state: "ended" }
  | { state: "unknown" };

export interface EolFinding {
  product: string;
  /** Other files that said the same thing. Agreement is one finding. */
  also?: string[];
  cycle: string;
  source: string;
  /** `exact` | `range` | `floor` — how much the file can be believed. */
  confidence: "exact" | "range" | "floor";
  /** What the file literally said. */
  raw: string;
  support: Support;
  eolDate: string | null;
  supportDate: string | null;
  latest: string | null;
  scheduleAgeDays: number | null;
}

/** What a watched live URL answered. A timeout is `noAnswer`, never `unreachable`. */
export type Liveness =
  | { state: "answering"; detail: number }
  | { state: "noAnswer"; detail: string }
  | { state: "unreachable"; detail: string };

export interface EolRow {
  path: string;
  name: string;
  url: string | null;
  note: string | null;
  /** The checkout is gone. Kept and marked — that is information. */
  missing: boolean;
  /** Nothing readable was found. Distinct from healthy. */
  unreadable: boolean;
  /** What the live URL answered, if there is one and it has been checked. */
  live: Liveness | null;
  findings: EolFinding[];
  worst: Support;
}

export interface EolBoard {
  rows: EolRow[];
  /** Products whose schedule could not be refreshed; rows keep their old dates. */
  stale: string[];
}

export interface Watched {
  path: string;
  url: string | null;
  note: string | null;
  addedAt: string;
}

export interface Watchlist {
  watched: Watched[];
}

/** What one MCP sync learned, beyond the items themselves. */
export interface McpReport {
  server: {
    name: string;
    version: string;
    protocolVersion: string;
    hasResources: boolean;
    hasTools: boolean;
    subscribe: boolean;
    listChanged: boolean;
  };
  /** Discovered and listed. Not callable in this version. */
  tools: { name: string; description: string | null }[];
  /** Resources annotated for a model rather than a person. */
  skippedForModels: number;
  capped: boolean;
  unreadBodies: number;
  failedReads: number;
}

/** One ICM file, and what actually reaches the model. */
export interface IcmFile {
  name: string;
  path: string;
  /** Size on disk. */
  bytes: number;
  /** How much of it is sent. Less than `bytes` when clipped. */
  used: number;
  truncated: boolean;
}

/** What an AI action would be given, before it is given. */
export interface IcmPlan {
  files: IcmFile[];
  /** Files that exist but did not fit — named rather than silently dropped. */
  skipped: string[];
  totalUsed: number;
  budget: number;
  dir: string;
  /** The folder is not there at all. Distinct from there and empty. */
  missing: boolean;
}

export interface AiContext {
  project: string | null;
  /** Null when no project could be resolved for the item. */
  plan: IcmPlan | null;
}

export interface PathsInfo {
  home: string;
  environmentDir: string;
  settingsFile: string;
  layoutFile: string;
  keymapFile: string;
  projectsFile: string;
  eventsDb: string;
}

// --- Products ---------------------------------------------------------------

/** What a repo declares it can run, in `<repo>/.ddd/config.json`. */
export interface ProductDecl {
  id: string;
  name?: string | null;
  run: string;
  dir?: string | null;
  port?: number | null;
}

/**
 * How a product is doing. `unknown` is a first-class answer: a supervision
 * record whose PID no longer verifies is not a running product, and the app
 * never claims health it has not checked.
 */
export type ProductState =
  | { state: "running"; pid: number; since: string }
  | { state: "stopped" }
  | { state: "exited"; since: string }
  | { state: "unknown"; why: string };

export interface Product {
  /** `<projectId>/<productId>`. */
  key: string;
  projectId: string;
  productId: string;
  name: string;
  run: string;
  dir: string;
  port?: number | null;
  dirExists: boolean;
  /** A sentence while it may not run yet, `null` once approved. */
  needsApproval?: string | null;
  state: ProductState;
  /** The last few lines it printed. */
  log: string;
}

// --- media widget: OS-level playback control (renderer twin of core/media/control.ts) ---

export interface Track {
  title: string;
  artist: string;
  album: string;
  /** A `data:` URL by the time it reaches the renderer — the host inlines it. */
  artUrl?: string;
  positionMs?: number;
  durationMs?: number;
}

export interface PlayerState {
  player: string;
  label: string;
  playing: boolean;
  /** 0-100, or null when unknown. */
  volume: number | null;
  track?: Track;
}

export interface MediaState {
  supported: boolean;
  players: PlayerState[];
  active: string | null;
}

/** Renderer twin of `core/media/control.ts`'s `MediaAction` — keeping the two
 *  unions in sync means a stray `"play"`/`"pause"` (the API has only a single
 *  `"playpause"` toggle) fails to compile at the `ipc.mediaCommand` boundary
 *  instead of silently falling through to the volume branch. */
export type MediaAction = "playpause" | "next" | "previous" | "setVolume";
