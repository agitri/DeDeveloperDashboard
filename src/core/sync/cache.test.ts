import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { scratchEnv } from "../testing";
import type { Item } from "../models";
import { clear, find, query, replaceForConnection } from "./cache";

const item = (id: string, kind: string, extra: Partial<Item> = {}): Item => ({
  id,
  environmentId: "",
  connectionId: "conn",
  source: "github",
  kind,
  project: null,
  title: `${id} title`,
  body: null,
  url: null,
  refs: [],
  actions: [],
  updatedAt: "2026-08-18T00:00:00Z",
  unread: false,
  ...extra,
});

describe("the item cache", () => {
  it("excludeKinds drops matching rows but keeps the rest", () => {
    const { env } = scratchEnv("exclude-kinds");
    replaceForConnection(env, "conn", [item("1", "repo"), item("2", "pull_request"), item("3", "repo")]);
    const rows = query(env, { excludeKinds: ["repo"] });
    expect(rows.map((r) => r.id)).toEqual(["2"]);
    expect(existsSync(env.cacheDb())).toBe(true);
  });

  it("excludeKinds is applied before the limit", () => {
    // Regression for the exact "Everything" collapse: filter-after-LIMIT would
    // let five repo rows eat a limit of 3 and return nothing.
    const { env } = scratchEnv("exclude-before-limit");
    replaceForConnection(env, "conn", [
      item("r1", "repo"),
      item("r2", "repo"),
      item("r3", "repo"),
      item("r4", "repo"),
      item("r5", "repo"),
      item("p1", "pull_request"),
      item("p2", "pull_request"),
    ]);
    const rows = query(env, { limit: 3, excludeKinds: ["repo"] });
    expect(rows.map((r) => r.id).sort()).toEqual(["p1", "p2"]);
  });

  it("is a snapshot per connection: what the adapter no longer returns is gone, other connections untouched", () => {
    const { env } = scratchEnv("snapshot");
    replaceForConnection(env, "a", [item("a:1", "issue", { connectionId: "a" }), item("a:2", "issue", { connectionId: "a" })]);
    replaceForConnection(env, "b", [item("b:1", "issue", { connectionId: "b" })]);
    replaceForConnection(env, "a", [item("a:2", "issue", { connectionId: "a" })]);
    expect(
      query(env, {})
        .map((r) => r.id)
        .sort(),
    ).toEqual(["a:2", "b:1"]);
    // A duplicate id from a misbehaving adapter costs that row, not the sync.
    replaceForConnection(env, "b", [
      item("b:1", "issue", { connectionId: "b" }),
      item("b:1", "issue", { connectionId: "b", title: "second" }),
    ]);
    expect(query(env, { connectionId: "b" }).map((r) => r.title)).toEqual(["second"]);
  });

  it("filters on every field and stamps the environment id", () => {
    const { env } = scratchEnv("filters");
    replaceForConnection(env, "conn", [
      item("1", "pull_request", { project: "ddd", title: "Fix the retry backoff", unread: true, updatedAt: "2026-08-18T02:00:00Z" }),
      item("2", "issue", { project: "ddd", body: "backoff again", updatedAt: "2026-08-18T01:00:00Z" }),
      item("3", "issue", { project: "other", source: "mock", updatedAt: "2026-08-18T03:00:00Z" }),
    ]);
    expect(query(env, {}).map((r) => r.id)).toEqual(["3", "1", "2"]); // newest first
    expect(query(env, { kind: "issue" }).map((r) => r.id)).toEqual(["3", "2"]);
    expect(query(env, { source: "mock" }).map((r) => r.id)).toEqual(["3"]);
    expect(query(env, { project: "ddd" }).map((r) => r.id)).toEqual(["1", "2"]);
    expect(query(env, { query: "backoff" }).map((r) => r.id)).toEqual(["1", "2"]); // title or body
    expect(query(env, { unreadOnly: true }).map((r) => r.id)).toEqual(["1"]);
    expect(query(env, { unreadOnly: false }).map((r) => r.id)).toEqual(["3", "1", "2"]);
    expect(query(env, { limit: 1 }).map((r) => r.id)).toEqual(["3"]);
    expect(query(env, {})[0]!.environmentId).toBe("default");
  });

  it("finds one item by id, round-tripping refs and actions", () => {
    const { env } = scratchEnv("find");
    replaceForConnection(env, "conn", [
      item("x", "issue", { refs: ["github:a/b#1"], actions: [{ id: "open", label: "Open", outbound: false }] }),
    ]);
    const found = find(env, "x")!;
    expect(found.refs).toEqual(["github:a/b#1"]);
    expect(found.actions).toEqual([{ id: "open", label: "Open", outbound: false }]);
    expect(found.environmentId).toBe("default");
    expect(find(env, "nope")).toBeNull();
  });

  it("clears everything", () => {
    const { env } = scratchEnv("clear");
    replaceForConnection(env, "conn", [item("1", "issue")]);
    clear(env);
    expect(query(env, {})).toEqual([]);
  });
});
