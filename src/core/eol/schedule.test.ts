import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scratchEnv } from "../testing";
import { defaultCycle, type Cycle } from "./status";
import {
  ageDays,
  cacheFromJson,
  defaultCache,
  fetchOne,
  isFresh,
  isKnownProduct,
  load,
  PRODUCTS,
  refreshFrom,
  save,
  urlFor,
  type Cache,
  type Entry,
} from "./schedule";

function entry(fetchedAt: string, cycles: Cycle[] = []): Entry {
  return { fetchedAt, cycles };
}

/** A fetch that never reaches a network. */
function fakeFetch(reply: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()) });
    return reply(String(url));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const NOW = "2026-09-04T10:00:00Z";

describe("support schedules and the cache in front of them", () => {
  it("only products on the allowlist are ever requested", () => {
    // A crafted composer.json naming `../../evil` must not become a URL.
    expect(urlFor("symfony")).toBe("https://endoflife.date/api/symfony.json");
    expect(urlFor("../../etc/passwd")).toBeNull();
    expect(urlFor("https://evil.example/x")).toBeNull();
    expect(urlFor("")).toBeNull();
    // And the URL is built, never taken.
    expect(urlFor("php")).toBe("https://endoflife.date/api/php.json");
    expect(PRODUCTS).toEqual([
      "php",
      "nodejs",
      "symfony",
      "laravel",
      "python",
      "django",
      "ruby",
      "rails",
      "go",
      "rust",
      "nextjs",
      "dotnet",
    ]);
    expect(isKnownProduct("dotnet")).toBe(true);
    expect(isKnownProduct("cobol")).toBe(false);
  });

  it("a fresh entry is not refetched and an old one is", () => {
    expect(isFresh(entry("2026-09-01T10:00:00Z"), NOW)).toBe(true); // three days old
    expect(isFresh(entry("2026-08-01T10:00:00Z"), NOW)).toBe(false); // a month old
    // Exactly at the TTL is stale: the boundary belongs to the refetch.
    expect(isFresh(entry("2026-08-28T10:00:00Z"), NOW)).toBe(false);
    expect(isFresh(entry("2026-08-28T10:00:01Z"), NOW)).toBe(true);
  });

  it("an entry from the future is not trusted", () => {
    // A clock that moved backwards, or a hand-edited file.
    expect(isFresh(entry("2027-01-01T00:00:00Z"), NOW)).toBe(false);
    expect(isFresh(entry("not a date"), NOW)).toBe(false);
    expect(isFresh(entry("2026-09-04"), NOW)).toBe(false); // no offset is not rfc3339
  });

  it("age is reported in days for the as-of line", () => {
    expect(ageDays(entry("2026-08-30T10:00:00Z"), NOW)).toBe(5);
    expect(ageDays(entry("not a date"), NOW)).toBeNull();
  });

  it("a failed fetch leaves the stale entry standing", async () => {
    // Offline with week-old dates is a working widget; offline with no dates is
    // a broken one.
    const cache = defaultCache();
    cache.products["php"] = entry("2020-01-01T00:00:00Z", [{ ...defaultCycle(), cycle: "8.1" }]);
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });

    const failed = await refreshFrom("http://127.0.0.1:1", fetch, cache, ["php"], NOW);

    expect(failed).toEqual(["php"]); // the failure is reported, not swallowed
    // Six-year-old dates beat no dates — a schedule does not rot that fast.
    expect(cache.products["php"].cycles).toHaveLength(1);
    expect(cache.products["php"].fetchedAt).toBe("2020-01-01T00:00:00Z");
  });

  it("a fresh entry is not fetched at all", async () => {
    const cache = defaultCache();
    cache.products["php"] = entry("2026-09-03T10:00:00Z", [defaultCycle()]);
    const { fetch, calls } = fakeFetch(() => {
      throw new Error("must not be called");
    });
    const failed = await refreshFrom("http://127.0.0.1:1", fetch, cache, ["php"], NOW);
    // One request per product per week, and this week is spent.
    expect(failed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an unknown product is never fetched or recorded", async () => {
    const cache = defaultCache();
    const { fetch, calls } = fakeFetch(() => {
      throw new Error("must not be called");
    });
    const failed = await refreshFrom("http://127.0.0.1:1", fetch, cache, ["not-a-product"], NOW);
    expect(failed).toEqual([]);
    expect(cache.products).toEqual({});
    expect(calls).toEqual([]);
  });

  it("a good answer replaces the entry, and an empty list never does", async () => {
    const cache = defaultCache();
    cache.products["php"] = entry("2020-01-01T00:00:00Z", [{ ...defaultCycle(), cycle: "8.1" }]);
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith("/php.json") ?
        new Response(JSON.stringify([{ cycle: "8.4", support: "2026-12-31", eol: false, latest: "8.4.3" }]), {
          status: 200,
        })
      : new Response("[]", { status: 200 }),
    );
    const failed = await refreshFrom("https://endoflife.date/api", fetch, cache, ["php", "go"], NOW);
    expect(failed).toEqual(["go"]); // an empty list has told us nothing
    expect(cache.products["go"]).toBeUndefined();
    expect(cache.products["php"]).toEqual({
      fetchedAt: NOW,
      cycles: [{ cycle: "8.4", support: { kind: "date", date: "2026-12-31" }, eol: { kind: "pending" }, latest: "8.4.3" }],
    });
    expect(calls.map((c) => c.url)).toEqual(["https://endoflife.date/api/php.json", "https://endoflife.date/api/go.json"]);
  });

  it("fetchOne names itself, asks for JSON, and says exactly what went wrong", async () => {
    const ok = fakeFetch(() => new Response(JSON.stringify([{ cycle: "1.27" }]), { status: 200 }));
    expect(await fetchOne(ok.fetch, "https://endoflife.date/api/go.json")).toEqual([
      { cycle: "1.27", support: { kind: "absent" }, eol: { kind: "absent" }, latest: null },
    ]);
    // A free service is owed the ability to see who is calling it.
    expect(ok.calls[0]!.headers["user-agent"]).toBe("DDD-dashboard (https://github.com/agitri/ddd)");
    expect(ok.calls[0]!.headers["accept"]).toBe("application/json");

    const missing = fakeFetch(() => new Response("", { status: 404, statusText: "Not Found" }));
    await expect(fetchOne(missing.fetch, "https://endoflife.date/api/go.json")).rejects.toThrow("endoflife.date answered 404 Not Found");

    const offline = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchOne(offline.fetch, "https://endoflife.date/api/go.json")).rejects.toThrow(
      "could not reach endoflife.date: fetch failed",
    );

    const junk = fakeFetch(() => new Response("not json", { status: 200 }));
    await expect(fetchOne(junk.fetch, "https://endoflife.date/api/go.json")).rejects.toThrow(/^unreadable schedule: /);

    const wrongShape = fakeFetch(() => new Response('{"cycles": []}', { status: 200 }));
    await expect(fetchOne(wrongShape.fetch, "https://endoflife.date/api/go.json")).rejects.toThrow(/^unreadable schedule: /);
  });

  it("the cache file is written with sorted keys and read back with its milestones intact", () => {
    const { env } = scratchEnv("eol-cache");
    expect(load(env)).toEqual({ products: {}, live: {} });

    const cache: Cache = {
      products: {
        symfony: {
          fetchedAt: "2026-09-04T09:00:00Z",
          cycles: [{ cycle: "8.0", support: { kind: "date", date: "2026-07-31" }, eol: { kind: "reached" }, latest: "8.0.16" }],
        },
        nodejs: { fetchedAt: "2026-09-04T09:00:00Z", cycles: [] },
      },
      live: {
        "https://z.example": { at: NOW, liveness: { state: "unreachable", detail: "refused" } },
        "https://a.example": { at: NOW, liveness: { state: "answering", detail: 200 } },
      },
    };
    save(env, cache);
    const text = readFileSync(env.eolCacheFile(), "utf8");
    // BTreeMap: sorted keys, both maps.
    expect(text.indexOf('"nodejs"')).toBeLessThan(text.indexOf('"symfony"'));
    expect(text.indexOf('"https://a.example"')).toBeLessThan(text.indexOf('"https://z.example"'));
    expect(text.indexOf('"products"')).toBeLessThan(text.indexOf('"live"'));
    expect(text).toContain('"kind": "reached"');

    // The round trip is the point: an entry read back must still carry a verdict.
    expect(load(env)).toEqual(cache);
    expect(cacheFromJson({})).toEqual({ products: {}, live: {} });
    expect(() => cacheFromJson({ products: { php: { cycles: [] } } })).toThrow(/^json: /);
  });
});
