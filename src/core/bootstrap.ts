/**
 * First run: make sure `~/.ddd/global.json` and the default environment exist,
 * and drop a starter board in so the app never opens on an empty void. Port of
 * `bootstrap` and `starter_layout` in `lib.rs`.
 */
import { existsSync } from "node:fs";
import { EnvRoot } from "./paths";
import { writeJson } from "./store";
import { globalLoad } from "./global";
import { defaultSettings } from "./settings";
import type { Layout, Widget } from "./models";

export function bootstrap(): void {
  const global = globalLoad();
  for (const env of global.environments) {
    const root = EnvRoot.open(env.id);
    if (!existsSync(root.settingsFile())) writeJson(root.settingsFile(), defaultSettings());
    if (!existsSync(root.layoutFile())) writeJson(root.layoutFile(), starterLayout());
  }
}

/** Two widgets with no integrations behind them, which is exactly the point:
 *  if the clock and the notepad work, the widget contract works. */
export function starterLayout(): Layout {
  const widget = (id: string, kind: string, x: number, y: number, w: number, h: number): Widget => ({
    id,
    kind,
    title: null,
    connectionId: null,
    filter: {},
    config: {},
    refreshSeconds: null,
    layout: { x, y, w, h },
  });
  return {
    version: 1,
    groups: [],
    tabs: [
      {
        id: "tab-board",
        name: "Board",
        color: "#2f6ae8",
        groupId: null,
        widgets: [widget("w-clock", "clock", 0, 0, 3, 4), widget("w-notes", "notes", 3, 0, 5, 8)],
      },
      {
        id: "tab-projects",
        name: "Projects",
        color: "#00a99f",
        groupId: null,
        widgets: [widget("w-projects", "projects", 0, 0, 8, 10)],
      },
    ],
  };
}
