import { describe, expect, it } from "vitest";
import { build, productsNeeded, rank, urlsToCheck, type Declarations } from "./board";
import type { Declaration } from "./detect";
import type { Checks } from "./live";
import type { Cache } from "./schedule";
import { severity, type Cycle } from "./status";
import type { Watched } from "./watchlist";

function watched(path: string, url: string | null): Watched {
  return { path, url, note: null, addedAt: "2026-09-01T00:00:00Z" };
}

function declaration(product: string, cycle: string): Declaration {
  return { also: [], product, cycle, source: "composer.json", confidence: "exact", raw: `${product}: ${cycle}` };
}

function dated(cycle: string, support: string, eol: string, latest: string): Cycle {
  return { cycle, support: { kind: "date", date: support }, eol: { kind: "date", date: eol }, latest };
}

/** The real schedules, as endoflife.date publishes them today. */
function cache(): Cache {
  return {
    products: {
      symfony: {
        fetchedAt: "2026-09-04T09:00:00Z",
        cycles: [dated("8.0", "2026-07-31", "2026-07-31", "8.0.16"), dated("7.4", "2028-11-30", "2029-11-30", "7.4.18")],
      },
      nodejs: { fetchedAt: "2026-09-04T09:00:00Z", cycles: [dated("24", "2026-10-20", "2028-04-30", "24.20.0")] },
    },
    live: {},
  };
}

const TODAY = "2026-09-04";
const NOW = "2026-09-04T10:00:00Z";
const NO_CHECKS: Checks = {};

describe("the board", () => {
  it("this machine's real projects come out in the order that matters", () => {
    // Four Symfony 8.0 projects (support ended 2026-07-31), one on the 7.4 LTS,
    // one on Node 24 (active support ends in 46 days). The LTS one is on the
    // *older* line and is the healthy one.
    const list = [
      watched("/p/toneelPetra", null),
      watched("/p/dedesignwinkel", null),
      watched("/p/climate4u", "https://climate4u.example"),
      watched("/p/zzplanner", null),
    ];
    const declarations: Declarations = [
      ["/p/toneelPetra", [declaration("symfony", "7.4")]],
      ["/p/dedesignwinkel", [declaration("nodejs", "24")]],
      ["/p/climate4u", [declaration("symfony", "8.0")]],
      ["/p/zzplanner", [declaration("symfony", "8.0")]],
    ];

    const board = build(list, declarations, cache(), NO_CHECKS, TODAY, NOW, []);
    // Ended-and-live, then ended, then ending soon, then the healthy one.
    expect(board.rows.map((r) => r.name)).toEqual(["climate4u", "zzplanner", "dedesignwinkel", "toneelPetra"]);
    expect(board.rows[0]!.worst).toEqual({ state: "ended" });
    expect(board.rows[2]!.worst).toEqual({ state: "endingSoon", days: 46 });
    expect(board.rows[3]!.worst).toEqual({ state: "active" });
    expect(board.rows[3]!.findings[0]).toEqual({
      product: "symfony",
      cycle: "7.4",
      source: "composer.json",
      confidence: "exact",
      raw: "symfony: 7.4",
      support: { state: "active" },
      eolDate: "2029-11-30",
      supportDate: "2028-11-30",
      latest: "7.4.18",
      scheduleAgeDays: 0,
    });
    // `also` is omitted entirely when empty, as the Rust's
    // `skip_serializing_if` does.
    expect("also" in board.rows[3]!.findings[0]!).toBe(false);
  });

  it("a live url promotes a row over an identical dormant one", () => {
    const list = [watched("/p/dormant", null), watched("/p/serving", "https://serving.example")];
    const declarations: Declarations = [
      ["/p/dormant", [declaration("symfony", "8.0")]],
      ["/p/serving", [declaration("symfony", "8.0")]],
    ];
    const board = build(list, declarations, cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.name).toBe("serving"); // unattended and exposed is the dangerous one
  });

  it("a dead runtime in a folder still outranks a live one expiring next month", () => {
    const list = [watched("/p/expiring", "https://expiring.example"), watched("/p/dead", null)];
    const declarations: Declarations = [
      ["/p/expiring", [declaration("nodejs", "24")]],
      ["/p/dead", [declaration("symfony", "8.0")]],
    ];
    const board = build(list, declarations, cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.name).toBe("dead");
  });

  it("a row is ranked by its worst finding", () => {
    const list = [watched("/p/mixed", null)];
    const declarations: Declarations = [
      ["/p/mixed", [declaration("symfony", "7.4"), declaration("symfony", "8.0")]],
    ];
    const board = build(list, declarations, cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.worst).toEqual({ state: "ended" });
    expect(board.rows[0]!.findings).toHaveLength(2); // and both are still shown
  });

  it("a cycle the schedule has never heard of is unknown not ended", () => {
    const list = [watched("/p/future", null)];
    const declarations: Declarations = [["/p/future", [declaration("symfony", "9.9")]]];
    const board = build(list, declarations, cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.findings[0]!.support).toEqual({ state: "unknown" });
    expect(board.rows[0]!.findings[0]!.support).not.toEqual({ state: "ended" });
  });

  it("a product with no schedule at all yields no verdict", () => {
    // Offline on a first run: the reading is still worth showing.
    const list = [watched("/p/offline", null)];
    const declarations: Declarations = [["/p/offline", [declaration("php", "8.4")]]];
    const board = build(list, declarations, { products: {}, live: {} }, NO_CHECKS, TODAY, NOW, ["php"]);
    expect(board.rows[0]!.findings[0]!.support).toEqual({ state: "unknown" });
    expect(board.rows[0]!.findings[0]!.cycle).toBe("8.4"); // what the file said is still shown
    expect(board.rows[0]!.findings[0]!.scheduleAgeDays).toBeNull();
    expect(board.stale).toEqual(["php"]);
  });

  it("a verdict carries the age of the schedule it came from", () => {
    const c = cache();
    c.products["symfony"]!.fetchedAt = "2026-08-30T10:00:00Z";
    const board = build([watched("/p/a", null)], [["/p/a", [declaration("symfony", "8.0")]]], c, NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.findings[0]!.scheduleAgeDays).toBe(5);
  });

  it("a watched repo that vanished is kept and marked", () => {
    // A watched thing disappearing is information, not a reason to go quiet.
    const board = build([watched("/p/gone-xyz", null)], [], cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]!.missing).toBe(true);
    expect(board.rows[0]!.unreadable).toBe(false); // missing and unreadable are different answers
  });

  it("a repo with nothing to read says so rather than looking healthy", () => {
    const board = build([watched("/", null)], [["/", []]], cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.unreadable).toBe(true);
    expect(board.rows[0]!.missing).toBe(false);
    expect(board.rows[0]!.worst).toEqual({ state: "unknown" });
  });

  it("the fetch list is one entry per product however many repos use it", () => {
    // Six Symfony projects are one request.
    const declarations: Declarations = Array.from({ length: 6 }, (_, i) => [
      `/p/${i}`,
      [declaration("symfony", "8.0"), declaration("php", "8.4")],
    ]);
    expect(productsNeeded(declarations)).toEqual(["php", "symfony"]);
  });

  it("a product nobody publishes a schedule for is never requested", () => {
    expect(productsNeeded([["/p/a", [declaration("cobol", "85")]]])).toEqual([]);
  });

  it("a url confirmed unreachable stops promoting its row", () => {
    // The user said it was live; we checked, and it is not. It is a folder
    // again, and a folder does not outrank a site with traffic on it.
    const list = [watched("/p/gone", "https://gone.example"), watched("/p/serving", "https://serving.example")];
    const declarations: Declarations = [
      ["/p/gone", [declaration("symfony", "8.0")]],
      ["/p/serving", [declaration("symfony", "8.0")]],
    ];
    const checks: Checks = {
      "https://gone.example": { at: NOW, liveness: { state: "unreachable", detail: "refused" } },
      "https://serving.example": { at: NOW, liveness: { state: "answering", detail: 200 } },
    };

    const board = build(list, declarations, cache(), checks, TODAY, NOW, []);
    expect(board.rows[0]!.name).toBe("serving");
    expect(board.rows[0]!.live).toEqual({ state: "answering", detail: 200 });
  });

  it("a url that merely timed out keeps its promotion", () => {
    // A slow server is not a gone server, and demoting a row on a timeout would
    // quietly hide the dangerous case.
    const list = [watched("/p/slow", "https://slow.example")];
    const declarations: Declarations = [["/p/slow", [declaration("symfony", "8.0")]]];
    const checks: Checks = { "https://slow.example": { at: NOW, liveness: { state: "noAnswer", detail: "timeout" } } };
    const board = build(list, declarations, cache(), checks, TODAY, NOW, []);
    expect(rank(board.rows[0]!)).toBe(severity({ state: "ended" }) * 2 + 1);
  });

  it("only urls that exist are ever checked", () => {
    expect(urlsToCheck([watched("/p/a", "https://a.example"), watched("/p/b", null)])).toEqual(["https://a.example"]);
  });

  it("agreement is carried through as `also`", () => {
    const d: Declaration = { ...declaration("symfony", "8.0"), also: ["Dockerfile"] };
    const board = build([watched("/p/a", null)], [["/p/a", [d]]], cache(), NO_CHECKS, TODAY, NOW, []);
    expect(board.rows[0]!.findings[0]!.also).toEqual(["Dockerfile"]);
    // Product first, then `also` — the Rust's struct order.
    expect(Object.keys(board.rows[0]!.findings[0]!).slice(0, 2)).toEqual(["product", "also"]);
  });
});
