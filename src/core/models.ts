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
import { defaultAppearance } from "./settings";
import type {
  AppearanceSettings,
  Connection,
  Environment,
  EventInput,
  EventRow,
  Global,
  GridPos,
  Layout,
  Settings,
  Tab,
  TabGroup,
  Widget,
} from "../renderer/src/types";

export type {
  AppearanceSettings,
  Connection,
  Environment,
  EventInput,
  EventRow,
  Global,
  GridPos,
  Layout,
  Settings,
  Tab,
  TabGroup,
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
  const appearance = o.appearance === undefined || o.appearance === null ? null : (o.appearance as AppearanceSettings);
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
