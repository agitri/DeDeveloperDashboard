import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { scratchEnv } from "./testing";
import { defaultSettings, settingsSave } from "./settings";
import { clear, eventLog, log, query } from "./events";

describe("events", () => {
  it("logs rows and reads them newest first, with a null for every absent field", () => {
    const { env } = scratchEnv("events");
    const first = log(env, { kind: "tab.switch" });
    const second = log(env, { kind: "ai.mail.draft", source: "anthropic", project: "ddd", tokensIn: 10, tokensOut: 5, costMicros: 175, meta: { model: "x" } });
    expect(second).toBe(first + 1);
    expect(existsSync(env.eventsDb())).toBe(true);

    const rows = query(env, { limit: 500 });
    expect(rows.map((r) => r.kind)).toEqual(["ai.mail.draft", "tab.switch"]);
    expect(rows[1]).toEqual({ id: first, ts: rows[1]!.ts, kind: "tab.switch", source: null, project: null, tokensIn: null, tokensOut: null, costMicros: null, meta: null });
    expect(rows[0]!.meta).toEqual({ model: "x" });
    expect(rows[0]!.costMicros).toBe(175);
    expect(rows[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("filters by kind prefix, lower bound and limit", () => {
    const { env } = scratchEnv("events-filter");
    log(env, { kind: "tab.switch" });
    log(env, { kind: "ai.draft" });
    log(env, { kind: "ai.summarize" });
    expect(query(env, { kindPrefix: "ai.", limit: 500 }).map((r) => r.kind)).toEqual(["ai.summarize", "ai.draft"]);
    expect(query(env, { limit: 1 }).map((r) => r.kind)).toEqual(["ai.summarize"]);
    expect(query(env, { since: "2999-01-01T00:00:00Z", limit: 500 })).toEqual([]);
    expect(query(env, { since: "2000-01-01T00:00:00Z", limit: 500 })).toHaveLength(3);
  });

  it("clears the table", () => {
    const { env } = scratchEnv("events-clear");
    log(env, { kind: "tab.switch" });
    clear(env);
    expect(query(env, { limit: 500 })).toEqual([]);
  });

  it("the command respects the stats opt-out", () => {
    const { env } = scratchEnv("events-optout");
    eventLog(env, { kind: "tab.switch" });
    expect(query(env, { limit: 500 })).toHaveLength(1);
    const s = defaultSettings();
    s.data.statsLoggingEnabled = false;
    settingsSave(env, s);
    eventLog(env, { kind: "tab.switch" });
    expect(query(env, { limit: 500 })).toHaveLength(1);
  });
});
