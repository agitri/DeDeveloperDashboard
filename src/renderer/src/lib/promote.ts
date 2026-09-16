import type { Tab, Widget } from "../types";

export interface PromoteInput {
  projectId: string;
  name: string;
  path: string;
  remote?: string;
}

/** Build a tab pre-filled for one repo. Pure: the store supplies the id minter. */
export function buildPromotedTab(input: PromoteInput, mintId: (prefix: string) => string): Tab {
  const widget = (
    kind: string,
    layout: Widget["layout"],
    extra: { title?: string; filter?: Record<string, unknown>; config?: Record<string, unknown> },
  ): Widget => ({
    id: mintId("w"),
    kind,
    title: extra.title ?? null,
    connectionId: null,
    filter: extra.filter ?? {},
    config: extra.config ?? {},
    refreshSeconds: null,
    layout,
  });

  const launcher = widget("launcher", { x: 0, y: 0, w: 4, h: 4 }, {
    title: input.name,
    config: {
      targets: [
        { id: mintId("t"), label: "Terminal", path: input.path, open: "terminal" },
        { id: mintId("t"), label: "Editor", path: input.path, open: "ide" },
      ],
    },
  });
  const about = widget("about", { x: 4, y: 0, w: 8, h: 4 }, {
    title: input.name,
    config: { projectId: input.projectId, name: input.name, path: input.path, remote: input.remote },
  });
  const products = widget("products", { x: 0, y: 4, w: 6, h: 6 }, {
    // A project-scoped Products widget looks identical to an unscoped one
    // unless it says so — the title is that label.
    title: input.name,
    filter: { projectId: input.projectId },
  });
  const notes = widget("notes", { x: 6, y: 4, w: 6, h: 6 }, { config: { text: "" } });

  return {
    id: mintId("tab"),
    name: input.name,
    color: null,
    groupId: null,
    widgets: [launcher, about, products, notes],
  };
}
