import { describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { scratchEnv } from "./testing";
import { DddFolder, EnvRoot, dddHome, globalFile, globalKeymapFile, pathsInfo, validateEnvId } from "./paths";
import { DddError } from "./error";

describe("paths", () => {
  it("honours DDD_HOME", () => {
    const { home } = scratchEnv("home");
    expect(dddHome()).toBe(home);
    expect(globalFile()).toBe(join(home, "global.json"));
    expect(globalKeymapFile()).toBe(join(home, "keymap.json"));
  });

  it("opens an environment root and creates its directory", () => {
    const { home, env } = scratchEnv("root");
    expect(env.id).toBe("default");
    expect(env.dir).toBe(join(home, "environments", "default"));
    expect(existsSync(env.dir)).toBe(true);
    expect(env.settingsFile()).toBe(join(env.dir, "settings.json"));
    expect(env.layoutFile()).toBe(join(env.dir, "layout.json"));
    expect(env.keymapFile()).toBe(join(env.dir, "keymap.json"));
    expect(env.projectsFile()).toBe(join(env.dir, "projects.json"));
    expect(env.eventsDb()).toBe(join(env.dir, "events.sqlite"));
    expect(env.cacheDb()).toBe(join(env.dir, "cache.sqlite"));
    expect(env.keychainService()).toBe("ddd:default");
  });

  it("rejects ids that would not be boring directory names", () => {
    expect(() => validateEnvId("")).toThrow(/invalid environment id/);
    expect(() => validateEnvId("../x")).toThrow(/invalid environment id/);
    expect(() => validateEnvId("a".repeat(65))).toThrow(/invalid environment id/);
    expect(() => validateEnvId("work_2-b")).not.toThrow();
    expect(() => EnvRoot.open("no spaces")).toThrow(/use letters, digits, - and _ \(max 64\)/);
  });

  it("knows the .ddd contract folder", () => {
    const f = DddFolder.of("/p");
    expect(f.config()).toBe("/p/.ddd/config.json");
    expect(f.todos()).toBe("/p/.ddd/todos.json");
    expect(f.recap()).toBe("/p/.ddd/recap.md");
    expect(f.icm()).toBe("/p/.ddd/icm");
  });

  it("describes where an environment lives, for Settings → Data", () => {
    const { home, env } = scratchEnv("info");
    expect(pathsInfo(env)).toEqual({
      home,
      environmentDir: env.dir,
      settingsFile: env.settingsFile(),
      layoutFile: env.layoutFile(),
      keymapFile: env.keymapFile(),
      projectsFile: env.projectsFile(),
      eventsDb: env.eventsDb(),
    });
  });

  it("wraps mkdir failures in DddError.io", () => {
    // Create a temp directory and write a file to it
    const tempDir = mkdtempSync(join(tmpdir(), "ddd-test-mkdir-"));
    const filePath = join(tempDir, "not-a-dir");
    writeFileSync(filePath, "content");

    // Set DDD_HOME to that file's path so mkdir will fail
    process.env.DDD_HOME = filePath;

    // Try to open an environment, which should fail when trying to create directories
    let error: unknown;
    try {
      EnvRoot.open("default");
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(DddError);
    expect((error as DddError).kind).toBe("io");
    expect((error as DddError).message).toMatch(/^io: /);

    // Restore DDD_HOME to a valid scratch environment for subsequent tests
    scratchEnv("restore");
  });
});
