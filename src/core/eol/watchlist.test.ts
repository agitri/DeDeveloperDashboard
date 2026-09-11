import { mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvRoot } from "../paths";
import { scratchEnv } from "../testing";
import { add, load, remove, validateUrl, watchlistFromJson } from "./watchlist";

function checkout(name: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `ddd-eol-${name}-`)));
}

describe("the watchlist", () => {
  it("a repo round trips with its url", () => {
    const { env } = scratchEnv("eol-watchlist");
    const path = checkout("a");
    add(env, path, "https://example.com", "client site");

    const list = load(env);
    expect(list.watched).toHaveLength(1);
    expect(list.watched[0]!.url).toBe("https://example.com");
    expect(list.watched[0]!.note).toBe("client site");
    expect(list.watched[0]!.path).toBe(path);
    expect(Number.isNaN(Date.parse(list.watched[0]!.addedAt))).toBe(false);
  });

  it("assigning twice updates rather than duplicating", () => {
    const { env } = scratchEnv("eol-twice");
    const path = checkout("b");
    add(env, path, null, null);
    const list = add(env, path, "https://later.example", null);
    expect(list.watched).toHaveLength(1);
    expect(list.watched[0]!.url).toBe("https://later.example");

    // And a later add with no URL does not silently forget the one there.
    const again = add(env, path, null, null);
    expect(again.watched[0]!.url).toBe("https://later.example");
  });

  it("only a real web address is accepted", () => {
    // This value becomes an outbound request, so what is refused here is what
    // can never be fetched.
    expect(validateUrl("https://example.com/app")).toBe("https://example.com/app");
    expect(validateUrl("  http://example.com  ")).toBe("http://example.com");
    expect(() => validateUrl("  ")).toThrow("no address given");
    expect(() => validateUrl("file:///etc/passwd")).toThrow("file:///etc/passwd is not an http or https address");
    expect(() => validateUrl("localhost:3000")).toThrow("localhost:3000 is not an http or https address");
    expect(() => validateUrl("javascript:alert(1)")).toThrow("javascript:alert(1) is not an http or https address");
    expect(() => validateUrl("example.com")).toThrow("example.com is not an http or https address");
    expect(() => validateUrl("https://")).toThrow("https:// has no host to reach");
    expect(() => validateUrl("https://localhost/app")).toThrow("https://localhost/app has no host to reach");
  });

  it("a bad url is refused before anything is written", () => {
    const { env } = scratchEnv("eol-badurl");
    const path = checkout("c");
    expect(() => add(env, path, "file:///etc/passwd", null)).toThrow(/is not an http or https address/);
    expect(load(env).watched).toEqual([]); // nothing was stored
  });

  it("a path that is not a directory is refused", () => {
    const { env } = scratchEnv("eol-nodir");
    expect(() => add(env, "/nonexistent-checkout-xyz", null, null)).toThrow(
      "/nonexistent-checkout-xyz is not a directory",
    );
  });

  it("removing forgets the record and leaves the folder alone", () => {
    const { env } = scratchEnv("eol-remove");
    const path = checkout("d");
    add(env, path, null, null);
    const list = remove(env, path);
    expect(list.watched).toEqual([]);
    expect(statSync(path).isDirectory()).toBe(true); // the checkout is never touched
  });

  it("one environment's watchlist never reaches another", () => {
    const { env } = scratchEnv("eol-envwall");
    const work = EnvRoot.open("work");
    const path = checkout("e");
    add(env, path, null, null);
    expect(load(work).watched).toEqual([]);
  });

  it("writes the Rust's field order and fills serde's per-field defaults", () => {
    const { env } = scratchEnv("eol-shape");
    const path = checkout("f");
    add(env, path, "https://example.com", null);
    const text = readFileSync(env.watchlistFile(), "utf8");
    expect(text.indexOf('"path"')).toBeLessThan(text.indexOf('"url"'));
    expect(text.indexOf('"url"')).toBeLessThan(text.indexOf('"note"'));
    expect(text.indexOf('"note"')).toBeLessThan(text.indexOf('"addedAt"'));
    expect(text).toContain('"note": null');

    expect(watchlistFromJson({})).toEqual({ watched: [] });
    expect(watchlistFromJson({ watched: [{ path: "/p", addedAt: "t" }] })).toEqual({
      watched: [{ path: "/p", url: null, note: null, addedAt: "t" }],
    });
    expect(() => watchlistFromJson({ watched: [{ path: "/p" }] })).toThrow(/^json: /);
    expect(() => watchlistFromJson([])).toThrow(/^json: /);
  });
});
