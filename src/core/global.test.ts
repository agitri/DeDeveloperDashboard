import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { globalFile } from "./paths";
import { scratchEnv } from "./testing";
import {
  environmentCreate,
  environmentDelete,
  environmentSetActive,
  environmentUpdate,
  globalAppearanceSave,
  globalLoad,
} from "./global";
import type { AppearanceSettings } from "./models";

describe("appearance on global.json", () => {
  it("is adopted from the active environment once", () => {
    const { env } = scratchEnv("appearance-migration");
    // A settings.json as the previous version wrote it.
    writeFileSync(
      env.settingsFile(),
      JSON.stringify({
        version: 1,
        appearance: {
          theme: "dark",
          terminalApp: "iTerm",
          launchCommand: "claude --continue",
          defaultRefreshSeconds: 120,
          showShortcutHints: true,
        },
        connections: [],
      }),
    );
    // A global.json from before the field existed.
    writeFileSync(
      globalFile(),
      JSON.stringify({
        version: 1,
        environments: [{ id: "default", name: "Default", color: "#2f6ae8", hidden: false }],
        activeEnvironmentId: "default",
      }),
    );

    const g = globalLoad();
    expect(g.appearance.theme).toBe("dark");
    expect(g.appearance.terminalApp).toBe("iTerm");
    expect(g.appearance.defaultRefreshSeconds).toBe(120);

    // Written back, so it never migrates twice and the user can read it.
    const onDisk = JSON.parse(readFileSync(globalFile(), "utf8"));
    expect(onDisk.appearance.theme).toBe("dark");

    // Changing the old per-environment file now has no effect.
    writeFileSync(env.settingsFile(), JSON.stringify({ version: 1, connections: [] }));
    expect(globalLoad().appearance.theme).toBe("dark");
  });

  it("a fresh install gets defaults rather than none", () => {
    scratchEnv("appearance-fresh");
    const g = globalLoad();
    expect(g.appearance.theme).toBe("system");
    expect(existsSync(globalFile())).toBe(true);
  });

  it("saving appearance persists it globally", () => {
    scratchEnv("appearance-save");
    const appearance: AppearanceSettings = { ...globalLoad().appearance, theme: "light" };
    globalAppearanceSave(appearance);
    expect(globalLoad().appearance.theme).toBe("light");
  });
});

describe("environments", () => {
  it("creates one, with its directory, and refuses a duplicate", () => {
    const { home } = scratchEnv("env-create");
    const g = environmentCreate("work", "Work", "#00a99f");
    expect(g.environments.map((e) => e.id)).toEqual(["default", "work"]);
    expect(g.environments[1]).toEqual({ id: "work", name: "Work", color: "#00a99f", hidden: false, collapsed: false });
    expect(existsSync(`${home}/environments/work`)).toBe(true);
    expect(() => environmentCreate("work", "Again", "#000")).toThrow('environment "work" already exists');
  });

  it("updates only the fields given", () => {
    scratchEnv("env-update");
    environmentCreate("work", "Work", "#00a99f");
    const g = environmentUpdate("work", { name: "Client", hidden: true });
    const work = g.environments.find((e) => e.id === "work")!;
    expect(work).toEqual({ id: "work", name: "Client", color: "#00a99f", hidden: true, collapsed: false });
    expect(() => environmentUpdate("nope", { name: "x" })).toThrow('environment "nope"');
  });

  it("switches the active one, if it exists", () => {
    scratchEnv("env-active");
    environmentCreate("work", "Work", "#00a99f");
    expect(environmentSetActive("work").activeEnvironmentId).toBe("work");
    expect(() => environmentSetActive("nope")).toThrow('environment "nope"');
  });

  it("deletes an environment and its directory, never the last one", () => {
    const { home } = scratchEnv("env-delete");
    expect(() => environmentDelete("default")).toThrow("cannot delete the last environment");
    environmentCreate("work", "Work", "#00a99f");
    environmentSetActive("work");
    const g = environmentDelete("work");
    expect(g.environments.map((e) => e.id)).toEqual(["default"]);
    expect(g.activeEnvironmentId).toBe("default");
    expect(existsSync(`${home}/environments/work`)).toBe(false);
  });
});
