/**
 * `settings.json` per environment: AI routing, voice, data, and the connection
 * records (never secrets). Port of `settings.rs`.
 */
import type { Settings, AppearanceSettings, Connection } from "../renderer/src/types";
import type { EnvRoot } from "./paths";
import { readJson, writeJson } from "./store";
import { isBoolean, isNumber, isString, optional, record } from "./json";

export type { Settings, AppearanceSettings, Connection };

export type ConnectionStatus = "disconnected" | "connected" | "expired" | "error";

export function defaultAppearance(): AppearanceSettings {
  return {
    theme: "system",
    look: "classic",
    terminalApp: null,
    editor: null,
    launchCommand: "claude",
    defaultRefreshSeconds: 300,
    showShortcutHints: true,
  };
}

export function defaultAiSettings(): Settings["ai"] {
  return {
    defaultProvider: "anthropic",
    ollamaUrl: "http://localhost:11434",
    openaiCompatibleUrl: null,
    // Cheap/private work local, drafting and code to Claude. `widget.instructions`
    // is local and pinned there by a test in the Rust; keep it so.
    routing: {
      "code.propose_fix": "anthropic",
      "issue.tasks": "anthropic",
      "mail.classify": "local",
      "mail.draft": "anthropic",
      "thread.summarize": "local",
      "widget.instructions": "local",
    },
    monthlyBudgetUsd: null,
    anthropicModel: "claude-opus-5",
    localModel: "llama3.1:8b",
    openaiModel: "",
    classifyMailLocally: false,
  };
}

export function defaultVoiceSettings(): Settings["voice"] {
  return { enabled: false, sttMode: "local", sttModel: "base", ttsEngine: "os", ttsVoice: null, microphone: null };
}

export function defaultDataSettings(): Settings["data"] {
  return { statsLoggingEnabled: true };
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    ai: defaultAiSettings(),
    voice: defaultVoiceSettings(),
    data: defaultDataSettings(),
    connections: [],
  };
}

/**
 * The Rust reads a legacy `appearance` block with `serde_json::from_value(..).ok()
 * .unwrap_or_default()`: a block missing a field without a default (`theme`,
 * `defaultRefreshSeconds`) is discarded whole, not patched.
 */
export function appearanceFromJson(raw: unknown): AppearanceSettings {
  if (typeof raw !== "object" || raw === null) return defaultAppearance();
  const o = raw as Record<string, unknown>;
  if (!isString(o.theme) || !isNumber(o.defaultRefreshSeconds)) return defaultAppearance();
  return {
    theme: o.theme as AppearanceSettings["theme"],
    look: optional(o, "look", isString, "classic") as AppearanceSettings["look"],
    terminalApp: optional(o, "terminalApp", isString, null as string | null),
    editor: optional(o, "editor", isString, null as string | null),
    launchCommand: optional(o, "launchCommand", isString, "claude"),
    defaultRefreshSeconds: o.defaultRefreshSeconds,
    showShortcutHints: optional(o, "showShortcutHints", isBoolean, false),
  };
}

function isStringMap(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isString);
}

function aiFromJson(raw: unknown): Settings["ai"] {
  const d = defaultAiSettings();
  if (raw === undefined || raw === null) return d;
  const o = record(raw, "ai");
  return {
    defaultProvider: optional(o, "defaultProvider", isString, d.defaultProvider),
    ollamaUrl: optional(o, "ollamaUrl", isString, ""),
    openaiCompatibleUrl: optional(o, "openaiCompatibleUrl", isString, null as string | null),
    routing: optional(o, "routing", isStringMap, {}),
    monthlyBudgetUsd: optional(o, "monthlyBudgetUsd", isNumber, null as number | null),
    anthropicModel: optional(o, "anthropicModel", isString, d.anthropicModel),
    localModel: optional(o, "localModel", isString, d.localModel),
    openaiModel: optional(o, "openaiModel", isString, ""),
    classifyMailLocally: optional(o, "classifyMailLocally", isBoolean, false),
  };
}

function voiceFromJson(raw: unknown): Settings["voice"] {
  const d = defaultVoiceSettings();
  if (raw === undefined || raw === null) return d;
  const o = record(raw, "voice");
  return {
    enabled: optional(o, "enabled", isBoolean, d.enabled),
    sttMode: optional(o, "sttMode", isString, d.sttMode),
    sttModel: optional(o, "sttModel", isString, d.sttModel),
    ttsEngine: optional(o, "ttsEngine", isString, d.ttsEngine),
    ttsVoice: optional(o, "ttsVoice", isString, null as string | null),
    microphone: optional(o, "microphone", isString, null as string | null),
  };
}

function dataFromJson(raw: unknown): Settings["data"] {
  if (raw === undefined || raw === null) return defaultDataSettings();
  const o = record(raw, "data");
  return { statsLoggingEnabled: optional(o, "statsLoggingEnabled", isBoolean, true) };
}

function connectionFromJson(raw: unknown): Connection {
  const o = record(raw, "connection");
  return {
    id: String(o.id),
    provider: String(o.provider),
    label: String(o.label),
    status: (o.status as ConnectionStatus) ?? "disconnected",
    scopes: Array.isArray(o.scopes) ? (o.scopes as string[]) : [],
    config: isStringMap(o.config) ? o.config : {},
    lastSyncAt: optional(o, "lastSyncAt", isString, null as string | null),
    error: optional(o, "error", isString, null as string | null),
  };
}

export function settingsFromJson(raw: unknown): Settings {
  const o = record(raw, "settings");
  return {
    version: optional(o, "version", isNumber, 1),
    ai: aiFromJson(o.ai),
    voice: voiceFromJson(o.voice),
    data: dataFromJson(o.data),
    connections: Array.isArray(o.connections) ? o.connections.map(connectionFromJson) : [],
  };
}

/**
 * Fill in routing entries this file has never heard of. A key already present
 * is never touched — an explicit choice is a choice. Nothing is written back.
 */
export function withDefaultRouting(settings: Settings): Settings {
  const routing = { ...settings.ai.routing };
  for (const [action, provider] of Object.entries(defaultAiSettings().routing)) {
    if (!(action in routing)) routing[action] = provider;
  }
  return { ...settings, ai: { ...settings.ai, routing } };
}

export function settingsLoad(env: EnvRoot): Settings {
  return withDefaultRouting(readJson(env.settingsFile(), settingsFromJson, defaultSettings));
}

export function settingsSave(env: EnvRoot, settings: Settings): void {
  writeJson(env.settingsFile(), settings);
}
