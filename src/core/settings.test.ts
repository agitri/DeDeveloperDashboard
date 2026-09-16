import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DddError } from "./error";
import { scratchEnv } from "./testing";
import {
  appearanceFromJson,
  defaultAppearance,
  defaultSettings,
  settingsFromJson,
  settingsLoad,
  settingsSave,
  withDefaultRouting,
} from "./settings";

describe("settings defaults", () => {
  it("ships the routing split the README describes", () => {
    const s = defaultSettings();
    expect(s.ai.routing).toEqual({
      "code.propose_fix": "anthropic",
      "issue.tasks": "anthropic",
      "mail.classify": "local",
      "mail.draft": "anthropic",
      "tab.sitrep": "local",
      "thread.summarize": "local",
      "widget.instructions": "local",
    });
    expect(s.ai.anthropicModel).toBe("claude-opus-5");
    expect(s.ai.localModel).toBe("llama3.1:8b");
    expect(s.ai.ollamaUrl).toBe("http://localhost:11434");
    expect(s.data.statsLoggingEnabled).toBe(true);
    expect(s.voice.sttModel).toBe("base");
    expect(s.connections).toEqual([]);
  });

  it("fills every missing section and field, as serde(default) does", () => {
    const s = settingsFromJson({ version: 1, connections: [] });
    expect(s).toEqual(defaultSettings());
    const partial = settingsFromJson({ ai: { defaultProvider: "ollama" } });
    expect(partial.ai.defaultProvider).toBe("ollama");
    expect(partial.ai.ollamaUrl).toBe("");
    expect(partial.ai.anthropicModel).toBe("claude-opus-5");
  });

  it("requires defaultProvider when the ai block is present, as serde would", () => {
    expect(() => settingsFromJson({ ai: {} })).toThrow(/missing field `defaultProvider`/);
  });

  it("requires sttMode (and the other undefaulted fields) when the voice block is present", () => {
    expect(() => settingsFromJson({ voice: { enabled: true } })).toThrow(/missing field `sttMode`/);
  });

  it("refuses connections that are not an array, as serde would", () => {
    let error: unknown;
    try {
      settingsFromJson({ connections: "x" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DddError);
    expect((error as DddError).kind).toBe("json");
  });

  it("reads a legacy appearance block, falling back to defaults when it is unusable", () => {
    expect(appearanceFromJson({ theme: "dark", defaultRefreshSeconds: 120 })).toEqual({
      theme: "dark",
      look: "classic",
      terminalApp: null,
      editor: null,
      launchCommand: "claude",
      defaultRefreshSeconds: 120,
      showShortcutHints: false,
    });
    expect(appearanceFromJson({ theme: "dark" }).theme).toBe("system");
    expect(appearanceFromJson(null).theme).toBe("system");
  });

  it("discards the whole legacy block, not just the bad field, on any failure", () => {
    // `showShortcutHints` is the wrong type — `serde_json::from_value(..).ok()`
    // fails the whole struct, so even the otherwise-valid theme is dropped.
    expect(
      appearanceFromJson({ theme: "dark", defaultRefreshSeconds: 60, showShortcutHints: "yes" }),
    ).toEqual(defaultAppearance());
  });
});

describe("with_default_routing", () => {
  it("an action shipped after your settings file still routes local", () => {
    const stored = defaultSettings();
    stored.ai.defaultProvider = "anthropic";
    delete stored.ai.routing["widget.instructions"];
    expect(withDefaultRouting(stored).ai.routing["widget.instructions"]).toBe("local");
  });

  it("a choice the user made is never overwritten", () => {
    const stored = defaultSettings();
    stored.ai.routing["mail.classify"] = "anthropic";
    expect(withDefaultRouting(stored).ai.routing["mail.classify"]).toBe("anthropic");
  });
});

describe("connections on disk", () => {
  it("fills scopes, config, lastSyncAt and error when omitted", () => {
    const s = settingsFromJson({
      connections: [{ id: "c1", provider: "github", label: "GitHub", status: "connected" }],
    });
    expect(s.connections).toEqual([
      {
        id: "c1",
        provider: "github",
        label: "GitHub",
        status: "connected",
        scopes: [],
        config: {},
        lastSyncAt: null,
        error: null,
      },
    ]);
  });

  it("refuses a connection missing a required field, as serde would", () => {
    expect(() =>
      settingsFromJson({ connections: [{ id: "c1", provider: "github", status: "connected" }] }),
    ).toThrow(/missing field `label`/);
  });

  it("refuses a status outside the enum, as serde would", () => {
    let error: unknown;
    try {
      settingsFromJson({
        connections: [{ id: "c1", provider: "github", label: "GitHub", status: "weird" }],
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DddError);
    expect((error as DddError).kind).toBe("json");
  });
});

describe("settings on disk", () => {
  it("loads defaults for a fresh environment and round-trips a save", () => {
    const { env } = scratchEnv("settings");
    expect(settingsLoad(env)).toEqual(defaultSettings());
    const s = defaultSettings();
    s.ai.defaultProvider = "ollama";
    settingsSave(env, s);
    expect(settingsLoad(env).ai.defaultProvider).toBe("ollama");
    expect(readFileSync(env.settingsFile(), "utf8")).toContain('"defaultProvider": "ollama"');
  });
});
