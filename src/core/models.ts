/**
 * Data model shared by every subsystem. Port of `models.rs`.
 *
 * The shapes are the renderer's — `types/index.ts` mirrors `models.rs` field
 * for field — so they are re-exported rather than written twice. What is added
 * here is what serde did implicitly: defaults for missing fields, errors for
 * missing required ones, and the Rust field order on the way out.
 */
import { DddError } from "./error";
import { isArray, isBoolean, isNumber, isString, isPlainRecord, optional, record, required } from "./json";
import { appearanceRequired, defaultAppearance } from "./settings";
import type {
  AppearanceSettings,
  Connection,
  Deployment,
  Environment,
  EventInput,
  EventRow,
  FoundApp,
  Global,
  GitStatus,
  GridPos,
  Item,
  ItemAction,
  ItemFilter,
  Layout,
  Product,
  ProductDecl,
  Settings,
  Tab,
  TabGroup,
  Todo,
  Widget,
} from "../renderer/src/types";

export type {
  AppearanceSettings,
  Connection,
  Deployment,
  Environment,
  EventInput,
  EventRow,
  FoundApp,
  Global,
  GitStatus,
  GridPos,
  Item,
  ItemAction,
  ItemFilter,
  Layout,
  Product,
  ProductDecl,
  Settings,
  Tab,
  TabGroup,
  Todo,
  Widget,
};

/** `global.json` as it may be on disk: `appearance` is absent in files written
 *  before it became global. `globalLoad` migrates and never returns null. */
export interface StoredGlobal {
  version: number;
  environments: Environment[];
  activeEnvironmentId: string;
  appearance: AppearanceSettings | null;
}

// --- environments --------------------------------------------------------------

export function environmentFromJson(raw: unknown): Environment {
  const o = record(raw, "environment");
  return {
    id: required(o, "id", isString),
    name: required(o, "name", isString),
    color: required(o, "color", isString),
    hidden: optional(o, "hidden", isBoolean, false),
    collapsed: optional(o, "collapsed", isBoolean, false),
  };
}

export function defaultGlobal(): Global {
  return {
    version: 1,
    environments: [{ id: "default", name: "Default", color: "#2f6ae8", hidden: false, collapsed: false }],
    activeEnvironmentId: "default",
    appearance: defaultAppearance(),
  };
}

export function globalFromJson(raw: unknown): StoredGlobal {
  const o = record(raw, "global");
  const environments = required(o, "environments", isArray).map(environmentFromJson);
  const appearance = o.appearance === undefined || o.appearance === null ? null : appearanceRequired(o.appearance);
  return {
    version: optional(o, "version", isNumber, 1),
    environments,
    activeEnvironmentId: required(o, "activeEnvironmentId", isString),
    appearance,
  };
}

// --- layout --------------------------------------------------------------------

export function gridPosFromJson(raw: unknown): GridPos {
  const o = record(raw, "layout");
  return {
    x: required(o, "x", isNumber),
    y: required(o, "y", isNumber),
    w: required(o, "w", isNumber),
    h: required(o, "h", isNumber),
  };
}

export function widgetFromJson(raw: unknown): Widget {
  const o = record(raw, "widget");
  if (o.layout === undefined) throw DddError.json("missing field `layout`");
  return {
    id: required(o, "id", isString),
    kind: required(o, "kind", isString),
    title: optional(o, "title", isString, null as string | null),
    connectionId: optional(o, "connectionId", isString, null as string | null),
    filter: optional(o, "filter", isPlainRecord, {}),
    config: optional(o, "config", isPlainRecord, {}),
    refreshSeconds: optional(o, "refreshSeconds", isNumber, null as number | null),
    layout: gridPosFromJson(o.layout),
  };
}

export function tabFromJson(raw: unknown): Tab {
  const o = record(raw, "tab");
  return {
    id: required(o, "id", isString),
    name: required(o, "name", isString),
    color: optional(o, "color", isString, null as string | null),
    groupId: optional(o, "groupId", isString, null as string | null),
    widgets: optional(o, "widgets", isArray, [] as unknown[]).map(widgetFromJson),
    lastVisitedAt: optional(o, "lastVisitedAt", isString, null as string | null),
  };
}

export function tabGroupFromJson(raw: unknown): TabGroup {
  const o = record(raw, "group");
  return {
    id: required(o, "id", isString),
    name: required(o, "name", isString),
    color: required(o, "color", isString),
    collapsed: optional(o, "collapsed", isBoolean, false),
  };
}

export function defaultLayout(): Layout {
  return { version: 1, groups: [], tabs: [] };
}

export function layoutFromJson(raw: unknown): Layout {
  const o = record(raw, "layout");
  return {
    version: optional(o, "version", isNumber, 1),
    groups: optional(o, "groups", isArray, [] as unknown[]).map(tabGroupFromJson),
    tabs: optional(o, "tabs", isArray, [] as unknown[]).map(tabFromJson),
  };
}

// --- projects ------------------------------------------------------------------

/** `<project>/.ddd/todos.json` */
export interface TodoFile {
  todos: Todo[];
}

/** `<project>/.ddd/config.json` — written by whoever registers the project.
 *  The renderer's type lacks `products`; the Rust struct has it. */
export interface ProjectConfig {
  name: string | null;
  repos: string[];
  deployments: Deployment[];
  terminal: string | null;
  products: ProductDecl[];
}

export interface ProjectRef {
  id: string;
  path: string;
}

export interface ProjectRegistry {
  projects: ProjectRef[];
}

/** Everything the project card needs, assembled on demand. Same shape as the
 *  renderer's `Project` with core's `ProjectConfig`. */
export interface Project {
  id: string;
  path: string;
  name: string;
  exists: boolean;
  config: ProjectConfig;
  git: GitStatus;
  recap: string | null;
  recapUpdatedAt: string | null;
  todos: Todo[];
  icmFiles: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

export function todoFromJson(raw: unknown): Todo {
  const o = record(raw, "todo");
  return {
    id: required(o, "id", isString),
    text: required(o, "text", isString),
    done: optional(o, "done", isBoolean, false),
    createdAt: optional(o, "createdAt", isString, null as string | null),
    source: optional(o, "source", isString, null as string | null),
  };
}

export function defaultTodoFile(): TodoFile {
  return { todos: [] };
}

export function todoFileFromJson(raw: unknown): TodoFile {
  const o = record(raw, "todos");
  return { todos: optional(o, "todos", isArray, [] as unknown[]).map(todoFromJson) };
}

export function deploymentFromJson(raw: unknown): Deployment {
  const o = record(raw, "deployment");
  return { name: required(o, "name", isString), url: required(o, "url", isString) };
}

// `ProductDecl.port` is `Option<u16>` in the Rust; `serde_json` refuses a
// fraction, a negative, and anything past u16::MAX. Mirrors `isU32` for
// `ItemFilter.limit` — `isNumber` alone would accept all three.
const isU16 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 65_535;

/** Every field is read defensively: a config.json arrives with a repo, and a
 *  repo can come from anyone. Nothing here runs until approved (phase 6). */
export function productDeclFromJson(raw: unknown): ProductDecl {
  const o = record(raw, "product");
  return {
    id: required(o, "id", isString),
    name: optional(o, "name", isString, null as string | null),
    run: required(o, "run", isString),
    dir: optional(o, "dir", isString, null as string | null),
    port: optional(o, "port", isU16, null as number | null),
  };
}

export function defaultProjectConfig(): ProjectConfig {
  return { name: null, repos: [], deployments: [], terminal: null, products: [] };
}

export function projectConfigFromJson(raw: unknown): ProjectConfig {
  const o = record(raw, "config");
  return {
    name: optional(o, "name", isString, null as string | null),
    repos: optional(o, "repos", isStringArray, [] as string[]),
    deployments: optional(o, "deployments", isArray, [] as unknown[]).map(deploymentFromJson),
    terminal: optional(o, "terminal", isString, null as string | null),
    products: optional(o, "products", isArray, [] as unknown[]).map(productDeclFromJson),
  };
}

export function projectRefFromJson(raw: unknown): ProjectRef {
  const o = record(raw, "project");
  return { id: required(o, "id", isString), path: required(o, "path", isString) };
}

export function defaultProjectRegistry(): ProjectRegistry {
  return { projects: [] };
}

export function projectRegistryFromJson(raw: unknown): ProjectRegistry {
  const o = record(raw, "registry");
  return { projects: optional(o, "projects", isArray, [] as unknown[]).map(projectRefFromJson) };
}

export function defaultGitStatus(): GitStatus {
  return { isRepo: false, branch: null, dirtyFiles: 0, ahead: 0, behind: 0, lastCommitSummary: null, lastCommitAt: null };
}

// --- items -----------------------------------------------------------------

export function itemActionFromJson(raw: unknown): ItemAction {
  const o = record(raw, "action");
  return {
    id: required(o, "id", isString),
    label: required(o, "label", isString),
    outbound: optional(o, "outbound", isBoolean, false),
  };
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

export function itemFromJson(raw: unknown): Item {
  const o = record(raw, "item");
  return {
    id: required(o, "id", isString),
    environmentId: required(o, "environmentId", isString),
    connectionId: required(o, "connectionId", isString),
    source: required(o, "source", isString),
    kind: required(o, "kind", isString),
    project: optional(o, "project", isString, null as string | null),
    title: required(o, "title", isString),
    body: optional(o, "body", isString, null as string | null),
    url: optional(o, "url", isString, null as string | null),
    refs: optional(o, "refs", isStringList, [] as string[]),
    actions: optional(o, "actions", isArray, [] as unknown[]).map(itemActionFromJson),
    updatedAt: required(o, "updatedAt", isString),
    unread: optional(o, "unread", isBoolean, false),
  };
}

// `ItemFilter.limit` is `Option<u32>` in the Rust (`sync/cache.rs`), so
// `serde_json::from_value` refuses a fraction, a negative number and anything
// past u32::MAX. `isNumber` alone would accept all of those, and node:sqlite
// binding them into `LIMIT ?` either throws (fraction, too large) or SQLite
// silently treats a negative limit as unlimited — permanently, since the
// prose hash still matches and nothing recompiles.
const isU32 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4_294_967_295;

/** Every field optional (`#[serde(default)]`); `null` and absent both mean
 *  "not narrowing on this", and only present fields are kept — a stored
 *  filter reads as what it narrows and nothing else. */
export function itemFilterFromJson(raw: unknown): ItemFilter {
  const o = record(raw, "filter");
  const out: ItemFilter = {};
  const take = <K extends keyof ItemFilter>(key: K, guard: (v: unknown) => v is NonNullable<ItemFilter[K]>) => {
    const v = o[key];
    if (v === undefined || v === null) return;
    if (!guard(v)) throw DddError.json(`invalid type for field \`${key}\``);
    out[key] = v;
  };
  take("connectionId", isString);
  take("source", isString);
  take("kind", isString);
  take("project", isString);
  take("query", isString);
  take("unreadOnly", isBoolean);
  take("limit", isU32);
  take("excludeKinds", isStringList);
  return out;
}
