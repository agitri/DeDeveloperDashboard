import { describe, expect, it } from "vitest";
import {
  cycleFromApi,
  cycleFromJson,
  daysBetween,
  find,
  severity,
  supportOn,
  type Cycle,
  type Milestone,
  type Support,
} from "./status";

function cycle(name: string, support: string | null, eol: string | null): Cycle {
  const at = (d: string | null): Milestone => (d === null ? { kind: "absent" } : { kind: "date", date: d });
  return { cycle: name, support: at(support), eol: at(eol), latest: null };
}

describe("dates in, verdict out", () => {
  it("the symfony line this machine runs on reads as ended", () => {
    // Real data: Symfony 8.0, security support ended 2026-07-31.
    const c = cycle("8.0", "2026-07-31", "2026-07-31");
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "ended" });
  });

  it("the lts beside it reads as supported", () => {
    // Symfony 7.4: supported to 2029. The older line is the safe one, which is
    // the entire argument for EOL over newest-version.
    const c = cycle("7.4", "2028-11-30", "2029-11-30");
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "active" });
  });

  it("support that ends today has already ended", () => {
    const c = cycle("8.0", null, "2026-09-04");
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "ended" });
    expect(supportOn(c, "2026-09-03")).toEqual({ state: "endingSoon", days: 1 });
    expect(supportOn(c, "2026-09-05")).toEqual({ state: "ended" });
  });

  it("the horizon is ninety days and the boundary is tested on both sides", () => {
    const c = cycle("24", null, "2026-12-03"); // 90 days out
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "endingSoon", days: 90 });
    expect(supportOn(c, "2026-09-03")).toEqual({ state: "active" }); // 91 days is not soon
  });

  it("losing active support is not losing security support", () => {
    // Node 22: active ended 2025-10-21, security runs to 2027-04-30.
    const c = cycle("22", "2025-10-21", "2027-04-30");
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "securityOnly" });
  });

  it("active support ending soon warns before security support does", () => {
    // Node 24: active ends 2026-10-20, security 2028-04-30.
    const c = cycle("24", "2026-10-20", "2028-04-30");
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "endingSoon", days: 46 });
  });

  it("a cycle with no schedule is unknown and never ended", () => {
    expect(supportOn(cycle("99", null, null), "2026-09-04")).toEqual({ state: "unknown" });
    expect(supportOn(cycle("99", null, null), "2026-09-04")).not.toEqual({ state: "ended" });
  });

  it("a cycle that is not in the list is not matched loosely", () => {
    // `8.0` is not `8`.
    const cycles = [cycle("8.0", null, null), cycle("8.1", null, null)];
    expect(find(cycles, "8")).toBeNull();
    expect(find(cycles, "8.0")).not.toBeNull();
  });

  it("the two booleans have opposite polarity and both are read correctly", () => {
    // Every one of these is a verbatim shape from a live response, and reading
    // the booleans uniformly gets two of them backwards.
    const cycles = (
      JSON.parse(
        `[{"cycle": 24, "support": "2026-10-20", "eol": "2028-04-30", "latest": "24.20.0"},
          {"cycle": "16", "eol": false, "latest": "16.3.4"},
          {"cycle": "3", "eol": true, "support": false},
          {"cycle": "3.5", "support": false, "eol": "2020-09-30"},
          {"cycle": "9.9"}]`,
      ) as unknown[]
    ).map(cycleFromApi);

    // A number where a string was expected.
    expect(cycles[0]!.cycle).toBe("24");
    expect(cycles[0]!.latest).toBe("24.20.0");

    // Next.js 16: `eol: false` means *not* end-of-life.
    expect(cycles[1]!.eol).toEqual({ kind: "pending" });
    expect(supportOn(cycles[1]!, "2026-09-04")).toEqual({ state: "active" });

    // Node 3: `eol: true` means it *is* end-of-life. This is the dangerous one.
    expect(cycles[2]!.eol).toEqual({ kind: "reached" });
    expect(supportOn(cycles[2]!, "2026-09-04")).toEqual({ state: "ended" });

    // Python 3.5: `support: false` means active support is *over* — the
    // opposite polarity, in the same document.
    expect(cycles[3]!.support).toEqual({ kind: "reached" });
    expect(supportOn(cycles[3]!, "2026-09-04")).toEqual({ state: "ended" });

    // Nothing said at all is the only Unknown.
    expect(cycles[4]!.support).toEqual({ kind: "absent" });
    expect(cycles[4]!.eol).toEqual({ kind: "absent" });
    expect(supportOn(cycles[4]!, "2026-09-04")).toEqual({ state: "unknown" });
  });

  it("active support still running with no end date is active", () => {
    const c: Cycle = { cycle: "1.27", support: { kind: "absent" }, eol: { kind: "pending" }, latest: null };
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "active" });
  });

  it("severity puts the dangerous rows on top", () => {
    const states: Support[] = [
      { state: "active" },
      { state: "unknown" },
      { state: "ended" },
      { state: "securityOnly" },
      { state: "endingSoon", days: 3 },
    ];
    states.sort((a, b) => severity(b) - severity(a));
    expect(states[0]).toEqual({ state: "ended" });
    expect(states[1]).toEqual({ state: "endingSoon", days: 3 });
    expect(states.at(-1)).toEqual({ state: "unknown" });
  });

  it("days between refuses anything that is not a date", () => {
    expect(daysBetween("2026-09-04", "2026-09-05")).toBe(1);
    expect(daysBetween("2026-09-04T10:00:00Z", "2026-12-03")).toBe(90);
    expect(daysBetween("not a date", "2026-09-05")).toBeNull();
    expect(daysBetween("2026-13-45", "2026-09-05")).toBeNull();
    expect(daysBetween("2026-09", "2026-09-05")).toBeNull();
  });

  it("the on-disk shape round-trips through the tagged decoder", () => {
    // What `writeJson` put in `eol-cache.json` is the *tagged* Milestone, not
    // the API's bare string — a different decoder, and the one the cache uses.
    const onDisk = {
      cycle: "8.0",
      support: { kind: "date", date: "2026-07-31" },
      eol: { kind: "reached" },
      latest: "8.0.16",
    };
    const c = cycleFromJson(onDisk);
    expect(c).toEqual({
      cycle: "8.0",
      support: { kind: "date", date: "2026-07-31" },
      eol: { kind: "reached" },
      latest: "8.0.16",
    });
    expect(supportOn(c, "2026-09-04")).toEqual({ state: "ended" });
    expect(cycleFromJson({ cycle: "9.9", support: { kind: "absent" }, eol: { kind: "pending" }, latest: null })).toEqual(
      { cycle: "9.9", support: { kind: "absent" }, eol: { kind: "pending" }, latest: null },
    );
    expect(() => cycleFromJson({ cycle: "8.0", support: { kind: "maybe" } })).toThrow(/^json: /);
    expect(() => cycleFromJson([])).toThrow(/^json: /);
    expect(() => cycleFromApi("nope")).toThrow(/^json: /);
  });
});
