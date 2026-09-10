import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalFile } from "./paths";
import { scratchEnv } from "./testing";
import { layoutLoad } from "./layout";
import { bootstrap, starterLayout } from "./bootstrap";
import { writeJson } from "./store";

describe("first run", () => {
  it("creates global.json, the default environment, and a starter board", () => {
    const { home, env } = scratchEnv("bootstrap");
    bootstrap();
    expect(existsSync(globalFile())).toBe(true);
    expect(existsSync(join(home, "environments", "default", "settings.json"))).toBe(true);
    const layout = layoutLoad(env);
    expect(layout.tabs.map((t) => t.id)).toEqual(["tab-board", "tab-projects"]);
    expect(layout.tabs[0]!.widgets.map((w) => w.kind)).toEqual(["clock", "notes"]);
    expect(layout.tabs[1]!.widgets.map((w) => w.kind)).toEqual(["projects"]);
  });

  it("never overwrites a board that already exists", () => {
    const { env } = scratchEnv("bootstrap-twice");
    bootstrap();
    const mine = { ...starterLayout(), tabs: [] };
    // Write it the way the app would, then boot again.
    writeJson(env.layoutFile(), mine);
    bootstrap();
    expect(JSON.parse(readFileSync(env.layoutFile(), "utf8")).tabs).toEqual([]);
  });
});
