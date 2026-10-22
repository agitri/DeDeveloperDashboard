import { describe, expect, it } from "vitest";
import { COMMANDS } from "../shared/commands";
import { parseArgs } from "./args";

describe("parseArgs", () => {
  it("passes typed fields through", () => {
    expect(parseArgs("environment_create", { id: "work", name: "Work", color: "#000" })).toEqual({
      id: "work",
      name: "Work",
      color: "#000",
    });
  });

  it("rejects a missing required field, naming the command", () => {
    expect(() => parseArgs("environment_create", { id: "work", color: "#000" })).toThrow(/^json: environment_create: missing field `name`/);
  });

  it("rejects a wrong type rather than coercing it", () => {
    expect(() => parseArgs("dev_server_probe", { address: "127.0.0.1", port: "3000", http: true })).toThrow(
      /^json: dev_server_probe: invalid type for field `port`, expected number/,
    );
    expect(() => parseArgs("global_wizard_save", { completed: "yes" })).toThrow(/expected boolean/);
  });

  it("treats null and absence the same for optional fields, and leaves them undefined", () => {
    expect(parseArgs("sync_now", { env: "default", connectionId: null })).toEqual({ env: "default", connectionId: undefined });
    expect(parseArgs("sync_now", { env: "default" })).toEqual({ env: "default", connectionId: undefined });
  });

  it("still type-checks an optional field when it is present", () => {
    expect(() => parseArgs("events_query", { env: "default", limit: "many" })).toThrow(/invalid type for field `limit`/);
  });

  it("hands a json field over untouched for the command's own parser", () => {
    const layout = { tabs: [{ id: "t" }] };
    expect(parseArgs("layout_save", { env: "default", layout }).layout).toBe(layout);
    expect(() => parseArgs("layout_save", { env: "default" })).toThrow(/missing field `layout`/);
  });

  it("ignores fields the command does not declare", () => {
    expect(parseArgs("paths_info", { env: "default", extra: 1 })).toEqual({ env: "default" });
  });

  it("accepts no arguments at all for a command that takes none", () => {
    expect(parseArgs("global_load", undefined)).toEqual({});
    expect(parseArgs("global_load", null)).toEqual({});
  });

  it("rejects arguments that are not an object", () => {
    expect(() => parseArgs("paths_info", "default")).toThrow(/^json: /);
  });

  it("every declared field kind is one the parser knows", () => {
    const kinds = new Set(["string", "string?", "number", "number?", "boolean", "boolean?", "json", "json?"]);
    for (const [cmd, shape] of Object.entries(COMMANDS)) {
      for (const [field, kind] of Object.entries(shape)) {
        expect(kinds.has(kind), `${cmd}.${field}: ${kind}`).toBe(true);
      }
    }
  });
});
