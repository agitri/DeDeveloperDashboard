import { describe, expect, it } from "vitest";
import { badge, confidenceNote, headline, liveNote, scheduleNote, severity, sources } from "./eol";
import type { EolFinding } from "../types";

const finding = (over: Partial<EolFinding> = {}): EolFinding => ({
  product: "php",
  cycle: "8.4",
  source: "composer.json",
  confidence: "floor",
  raw: "php: >=8.4",
  support: { state: "active" },
  eolDate: null,
  supportDate: null,
  latest: null,
  scheduleAgeDays: null,
  ...over,
});

describe("badge", () => {
  it("never renders an unknown schedule as healthy", () => {
    const unknown = badge({ state: "unknown" });
    expect(unknown.color).toBe("var(--ink-3)");
    expect(unknown.color).not.toBe("var(--ok)");
    expect(unknown.title).toContain("Not a verdict");
  });

  it("puts the date in the label for the state that needs proving", () => {
    // "ended" is the claim someone will argue with, so it carries its date.
    expect(badge({ state: "ended" }, { eolDate: "2026-07-31" }).label).toBe("ended 2026-07-31");
    expect(badge({ state: "ended" }).label).toBe("out of support");
  });

  it("counts days for the ending-soon window", () => {
    expect(badge({ state: "endingSoon", days: 46 }).label).toBe("ends in 46 days");
    expect(badge({ state: "endingSoon", days: 1 }).label).toBe("ends tomorrow");
  });

  it("treats security-only as a normal place to be, not a failure", () => {
    const b = badge({ state: "securityOnly" }, { eolDate: "2026-12-31" });
    expect(b.color).not.toBe("var(--err)");
    expect(b.color).not.toBe("var(--warn)");
    expect(b.label).toBe("security only to 2026-12-31");
  });

  it("reads as supported with or without a published end date", () => {
    // Next.js 16 has no support date and is current — it must not read as a gap.
    expect(badge({ state: "active" }).label).toBe("supported");
    expect(badge({ state: "active" }, { supportDate: "2028-11-30" }).label).toBe(
      "supported to 2028-11-30",
    );
  });
});

describe("confidenceNote", () => {
  it("says plainly that a floor is not what is running", () => {
    expect(confidenceNote(finding({ confidence: "floor" }))).toContain("not what is running");
    expect(confidenceNote(finding({ confidence: "exact" }))).toBe("pinned");
  });
});

describe("sources", () => {
  it("names every file that agreed", () => {
    expect(sources(finding())).toBe("composer.json");
    expect(sources(finding({ source: "Dockerfile", also: ["composer.json"] }))).toBe(
      "Dockerfile (also composer.json)",
    );
  });
});

describe("headline", () => {
  it("leads with what is out of support and serving traffic", () => {
    expect(
      headline([
        { worst: { state: "ended" }, url: "https://a.example" },
        { worst: { state: "ended" }, url: null },
        { worst: { state: "endingSoon", days: 46 }, url: null },
      ]),
    ).toBe("2 out of support, 1 of them serving · 1 ending soon");
  });

  it("says nothing alarming when nothing is wrong", () => {
    expect(headline([{ worst: { state: "active" }, url: null }])).toBe(
      "Everything watched is still supported.",
    );
    expect(headline([])).toBe("Nothing assigned yet.");
  });
});

describe("severity", () => {
  it("orders the states by consequence", () => {
    const states: Parameters<typeof severity>[0][] = [
      { state: "unknown" },
      { state: "ended" },
      { state: "active" },
      { state: "endingSoon", days: 2 },
      { state: "securityOnly" },
    ];
    const sorted = [...states].sort((a, b) => severity(b) - severity(a));
    expect(sorted[0]!.state).toBe("ended");
    expect(sorted[sorted.length - 1]!.state).toBe("unknown");
  });
});

describe("scheduleNote", () => {
  it("admits to old data and stays quiet about fresh data", () => {
    expect(scheduleNote(2)).toBeNull();
    expect(scheduleNote(null)).toBeNull();
    expect(scheduleNote(30)).toBe("dates are 30 days old");
  });
});

describe("liveNote", () => {
  it("does not treat a timeout as gone", () => {
    // The same rule as the dev board: someone else's slow server is not a dead
    // one, and colouring it as dead would make the board cry wolf.
    const slow = liveNote({ state: "noAnswer", detail: "no reply within the deadline" })!;
    expect(slow.label).not.toContain("not serving");
    expect(slow.title).toContain("Not the same as gone");
  });

  it("separates answering from not serving", () => {
    expect(liveNote({ state: "answering", detail: 403 })!.color).toBe("var(--ok)");
    expect(liveNote({ state: "unreachable", detail: "connection refused" })!.label).toBe(
      "○ not serving",
    );
  });

  it("has nothing to say about a URL that was never checked", () => {
    expect(liveNote(null)).toBeNull();
  });
});
