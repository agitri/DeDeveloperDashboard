import { describe, expect, it } from "vitest";
import { DddError } from "./error";
import {
  defaultGlobal,
  defaultLayout,
  defaultProjectConfig,
  deploymentFromJson,
  globalFromJson,
  layoutFromJson,
  productDeclFromJson,
  projectConfigFromJson,
  todoFileFromJson,
  todoFromJson,
} from "./models";

describe("global.json", () => {
  it("defaults to one Default environment with the shipped blue", () => {
    const g = defaultGlobal();
    expect(g.environments).toEqual([
      { id: "default", name: "Default", color: "#2f6ae8", hidden: false, collapsed: false },
    ]);
    expect(g.activeEnvironmentId).toBe("default");
    expect(g.appearance?.theme).toBe("system");
    // Field order is the Rust struct order, so the two apps write diffable files.
    expect(Object.keys(g)).toEqual(["version", "environments", "activeEnvironmentId", "appearance"]);
  });

  it("fills serde's defaults: version, hidden, collapsed, appearance", () => {
    const g = globalFromJson({
      environments: [{ id: "work", name: "Work", color: "#000" }],
      activeEnvironmentId: "work",
    });
    expect(g.version).toBe(1);
    expect(g.environments[0]).toEqual({ id: "work", name: "Work", color: "#000", hidden: false, collapsed: false });
    expect(g.appearance).toBeNull();
  });

  it("refuses a file missing a required field, as serde would", () => {
    expect(() => globalFromJson({ environments: [] })).toThrow(DddError);
    expect(() => globalFromJson({ environments: [] })).toThrow(/missing field `activeEnvironmentId`/);
  });

  it("reads a present appearance block strictly, in Rust field order", () => {
    const g = globalFromJson({
      environments: [],
      activeEnvironmentId: "default",
      appearance: { theme: "dark", defaultRefreshSeconds: 60 },
    });
    expect(Object.keys(g.appearance!)).toEqual([
      "theme",
      "look",
      "terminalApp",
      "editor",
      "launchCommand",
      "defaultRefreshSeconds",
      "showShortcutHints",
    ]);
    expect(g.appearance).toEqual({
      theme: "dark",
      look: "classic",
      terminalApp: null,
      editor: null,
      launchCommand: "claude",
      defaultRefreshSeconds: 60,
      showShortcutHints: false,
    });
  });

  it("errors on an appearance block missing a required field, unlike the legacy migration reader", () => {
    expect(() =>
      globalFromJson({ environments: [], activeEnvironmentId: "default", appearance: { theme: "dark" } }),
    ).toThrow(/missing field `defaultRefreshSeconds`/);
  });
});

describe("layout.json", () => {
  it("defaults to nothing", () => {
    expect(defaultLayout()).toEqual({ version: 1, groups: [], tabs: [] });
  });

  it("fills widget and tab defaults", () => {
    const l = layoutFromJson({
      tabs: [{ id: "t", name: "T", widgets: [{ id: "w", kind: "clock", layout: { x: 0, y: 0, w: 3, h: 4 } }] }],
    });
    expect(l).toEqual({
      version: 1,
      groups: [],
      tabs: [
        {
          id: "t",
          name: "T",
          color: null,
          groupId: null,
          widgets: [
            {
              id: "w",
              kind: "clock",
              title: null,
              connectionId: null,
              filter: {},
              config: {},
              refreshSeconds: null,
              layout: { x: 0, y: 0, w: 3, h: 4 },
            },
          ],
        },
      ],
    });
  });
});

describe("project files", () => {
  it("fills todo defaults, in Rust field order", () => {
    const t = todoFromJson({ id: "t", text: "x" });
    expect(t).toEqual({ id: "t", text: "x", done: false, createdAt: null, source: null });
    expect(Object.keys(t)).toEqual(["id", "text", "done", "createdAt", "source"]);
  });

  it("requires a todo's text", () => {
    expect(() => todoFromJson({ id: "t" })).toThrow(/missing field `text`/);
  });

  it("defaults an empty todos.json to no todos", () => {
    expect(todoFileFromJson({})).toEqual({ todos: [] });
  });

  it("requires a deployment's url", () => {
    expect(() => deploymentFromJson({ name: "prod" })).toThrow(/missing field `url`/);
  });

  it("fills product defaults", () => {
    expect(productDeclFromJson({ id: "web", run: "npm start" })).toEqual({
      id: "web",
      name: null,
      run: "npm start",
      dir: null,
      port: null,
    });
  });

  it("requires a product's run command", () => {
    expect(() => productDeclFromJson({ id: "web" })).toThrow(/missing field `run`/);
  });

  it("defaults an empty config.json to defaultProjectConfig, in Rust field order", () => {
    const c = projectConfigFromJson({});
    expect(c).toEqual(defaultProjectConfig());
    expect(Object.keys(c)).toEqual(["name", "repos", "deployments", "terminal", "products"]);
  });

  it("rejects a repos field of the wrong type", () => {
    expect(() => projectConfigFromJson({ repos: "x" })).toThrow(DddError);
    try {
      projectConfigFromJson({ repos: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DddError);
      expect((e as DddError).kind).toBe("json");
    }
  });

  it("defaults a product's port when omitted", () => {
    const c = projectConfigFromJson({ products: [{ id: "a", run: "r" }] });
    expect(c.products[0].port).toBeNull();
  });

  it("rejects a non-u16 product port", () => {
    // The Rust is `Option<u16>`: a fraction, a negative, or anything past
    // 65535 is refused rather than silently coerced.
    expect(() => productDeclFromJson({ id: "web", run: "r", port: 65536 })).toThrow(/invalid type for field `port`/);
    expect(() => productDeclFromJson({ id: "web", run: "r", port: -1 })).toThrow(/invalid type for field `port`/);
    expect(() => productDeclFromJson({ id: "web", run: "r", port: 1.5 })).toThrow(/invalid type for field `port`/);
    expect(productDeclFromJson({ id: "web", run: "r", port: 8080 }).port).toBe(8080);
  });
});

import { itemFilterFromJson, itemFromJson } from "./models";

describe("items", () => {
  it("normalizes an item with defaults in Rust field order", () => {
    const i = itemFromJson({ id: "c:1", environmentId: "e", connectionId: "c", source: "mock", kind: "issue", title: "t", updatedAt: "2026-01-01T00:00:00Z" });
    expect(Object.keys(i)).toEqual(["id", "environmentId", "connectionId", "source", "kind", "project", "title", "body", "url", "refs", "actions", "updatedAt", "unread"]);
    expect(i.refs).toEqual([]);
    expect(i.actions).toEqual([]);
    expect(i.unread).toBe(false);
    expect(() => itemFromJson({ id: "x" })).toThrow(/missing field `environmentId`/);
  });

  it("normalizes a filter, keeping only what was given", () => {
    expect(itemFilterFromJson({})).toEqual({});
    expect(itemFilterFromJson({ kind: "mail", limit: 5, excludeKinds: ["repo"] })).toEqual({ kind: "mail", limit: 5, excludeKinds: ["repo"] });
    expect(itemFilterFromJson({ kind: "mail", source: null })).toEqual({ kind: "mail" });
    expect(() => itemFilterFromJson({ limit: "5" })).toThrow(/^json: /);
    expect(() => itemFilterFromJson({ excludeKinds: [1] })).toThrow(/^json: /);
  });

  it("limit is a u32: fractional, negative and out-of-range values are refused", () => {
    for (const bad of [10.5, -5, 1e20]) {
      expect(() => itemFilterFromJson({ limit: bad }), String(bad)).toThrow("json: invalid type for field `limit`");
    }
    expect(itemFilterFromJson({ limit: 0 })).toEqual({ limit: 0 });
    expect(itemFilterFromJson({ limit: 10 })).toEqual({ limit: 10 });
  });
});
