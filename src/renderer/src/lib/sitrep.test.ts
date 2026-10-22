import { describe, expect, it } from "vitest";
import { awayInfo, buildDigest, extractDelta, newestRelevantTs, sitrepBanner, sitrepCacheKey } from "./sitrep";
import type { SitrepInput } from "./sitrep";
import type { EventRow, Product } from "../types";

const day = 86_400_000;
const now = Date.parse("2026-09-16T00:00:00.000Z");

describe("awayInfo", () => {
  it("is not away when never left", () => {
    expect(awayInfo(null, now, 14).away).toBe(false);
  });
  it("is away past the threshold", () => {
    const r = awayInfo(new Date(now - 20 * day).toISOString(), now, 14);
    expect(r.away).toBe(true);
    expect(r.days).toBe(20);
  });
  it("is not away within the threshold", () => {
    expect(awayInfo(new Date(now - 3 * day).toISOString(), now, 14).away).toBe(false);
  });
});

describe("extractDelta", () => {
  const products = [
    { projectId: "p1", productId: "api", name: "api", state: { state: "stopped" } },
    { projectId: "p1", productId: "web", name: "web", state: { state: "running" } },
  ] as unknown as Product[];
  const events = [
    { id: 3, ts: "2026-09-10T00:00:00Z", kind: "ai.mail.draft", project: "acme" },
    { id: 2, ts: "2026-09-09T00:00:00Z", kind: "ai.mail.draft", project: "acme" },
    { id: 1, ts: "2026-09-08T00:00:00Z", kind: "product.stop", project: "acme" },
  ] as EventRow[];

  it("summarizes processes, repo changes and AI actions", () => {
    const d = extractDelta({
      projectName: "acme",
      projectId: "p1",
      awayDays: 15,
      products,
      events,
      changes: { commits: 4, filesChanged: 12, messages: ["fix"] },
    });
    expect(d.processesRunning).toBe(1);
    expect(d.processesStopped).toContain("api");
    expect(d.commits).toBe(4);
    expect(d.filesChanged).toBe(12);
    expect(d.aiActions).toEqual([{ action: "mail.draft", count: 2 }]);
  });

  it("excludes the widget's own ai.tab.sitrep event from aiActions", () => {
    // Counting the sitrep's own generation event here would be self-referential
    // noise ("AI: tab.sitrep ×N") — and could make an otherwise-empty delta
    // look non-empty purely because the widget generated a summary for itself,
    // which is the same feedback shape newestRelevantTs guards against below.
    const withSelfEvent = [...events, { id: 4, ts: "2026-09-11T00:00:00Z", kind: "ai.tab.sitrep", project: "acme" }] as EventRow[];
    const d = extractDelta({
      projectName: "acme",
      projectId: "p1",
      awayDays: 15,
      products,
      events: withSelfEvent,
      changes: { commits: 4, filesChanged: 12, messages: ["fix"] },
    });
    expect(d.aiActions).toEqual([{ action: "mail.draft", count: 2 }]);
    expect(d.aiActions.some((a) => a.action === "tab.sitrep")).toBe(false);
  });
});

describe("newestRelevantTs", () => {
  it("returns the newest timestamp among the events", () => {
    const events = [
      { id: 1, ts: "2026-09-08T00:00:00Z", kind: "product.stop", project: "acme" },
      { id: 2, ts: "2026-09-10T00:00:00Z", kind: "ai.mail.draft", project: "acme" },
    ] as EventRow[];
    expect(newestRelevantTs(events)).toBe("2026-09-10T00:00:00Z");
  });

  it("returns empty for no events", () => {
    expect(newestRelevantTs([])).toBe("");
  });

  it("ignores ai.tab.sitrep events, even when one is the newest", () => {
    // The bug this guards against: tab_sitrep_generate logs ai.tab.sitrep
    // stamped with the current time. If that event could set the newest
    // timestamp, every generation would advance the cache key, invalidating
    // the summary just cached and triggering another generation — forever,
    // on an away tab left open.
    const events = [
      { id: 1, ts: "2026-09-08T00:00:00Z", kind: "ai.mail.draft", project: "acme" },
      { id: 2, ts: "2026-09-15T00:00:00Z", kind: "ai.tab.sitrep", project: "acme" },
    ] as EventRow[];
    expect(newestRelevantTs(events)).toBe("2026-09-08T00:00:00Z");
  });

  it("returns empty when only ai.tab.sitrep events are present", () => {
    const events = [{ id: 1, ts: "2026-09-15T00:00:00Z", kind: "ai.tab.sitrep", project: "acme" }] as EventRow[];
    expect(newestRelevantTs(events)).toBe("");
  });
});

describe("buildDigest", () => {
  it("renders counts and handles an empty delta", () => {
    const text = buildDigest({
      projectName: "acme",
      awayDays: 15,
      processesStopped: ["api"],
      processesRunning: 1,
      commits: 4,
      filesChanged: 12,
      commitMessages: [],
      aiActions: [],
    });
    expect(text).toContain("12");
    expect(text).toContain("api");
    const empty = buildDigest({
      projectName: "acme",
      awayDays: 15,
      processesStopped: [],
      processesRunning: 0,
      commits: 0,
      filesChanged: 0,
      commitMessages: [],
      aiActions: [],
    });
    expect(empty.toLowerCase()).toContain("nothing");
  });
});

describe("sitrepCacheKey", () => {
  it("keys off the newest event timestamp when there is one", () => {
    const key = sitrepCacheKey({
      lastVisitedAt: "2026-09-01T00:00:00Z",
      newestEventTs: "2026-09-10T00:00:00Z",
      commits: 1,
      filesChanged: 2,
    });
    expect(key).toContain("2026-09-10T00:00:00Z");
  });

  it("falls back to lastVisitedAt when there are no events", () => {
    const key = sitrepCacheKey({ lastVisitedAt: "2026-09-01T00:00:00Z", newestEventTs: "", commits: 0, filesChanged: 0 });
    expect(key).toContain("2026-09-01T00:00:00Z");
  });

  it("changes when the commit count changes, even with identical timestamps", () => {
    const a = sitrepCacheKey({ lastVisitedAt: "2026-09-01T00:00:00Z", newestEventTs: "", commits: 1, filesChanged: 2 });
    const b = sitrepCacheKey({ lastVisitedAt: "2026-09-01T00:00:00Z", newestEventTs: "", commits: 2, filesChanged: 2 });
    expect(a).not.toBe(b);
  });

  it("changes when the file count changes, even with identical timestamps and commit count", () => {
    const a = sitrepCacheKey({ lastVisitedAt: "2026-09-01T00:00:00Z", newestEventTs: "", commits: 1, filesChanged: 2 });
    const b = sitrepCacheKey({ lastVisitedAt: "2026-09-01T00:00:00Z", newestEventTs: "", commits: 1, filesChanged: 9 });
    expect(a).not.toBe(b);
  });
});

describe("sitrepBanner", () => {
  const delta: SitrepInput = {
    projectName: "acme",
    awayDays: 20,
    processesStopped: [],
    processesRunning: 0,
    commits: 3,
    filesChanged: 5,
    commitMessages: [],
    aiActions: [],
  };
  const empty: SitrepInput = { ...delta, commits: 0, processesStopped: [], aiActions: [] };
  const base = { away: true, delta, currentKey: "k2", genError: false };

  it("hides when not away", () => {
    expect(sitrepBanner({ ...base, away: false })).toEqual({ show: false, source: "none", text: "" });
  });

  it("hides on an empty delta", () => {
    expect(sitrepBanner({ ...base, delta: empty }).source).toBe("none");
  });

  it("hides when dismissed for this exact range", () => {
    expect(sitrepBanner({ ...base, dismissedKey: "k2" }).show).toBe(false);
  });

  it("does not hide when the dismissed range is older than the current one", () => {
    expect(sitrepBanner({ ...base, dismissedKey: "k1" }).show).toBe(true);
  });

  it("does not treat a dismissal at a lower commit count as covering a higher one across a digit boundary", () => {
    // A composite key embeds unpadded integers, so lexicographic comparison is
    // not monotonic at a digit-count boundary: "...::9::5" >= "...::10::6" is
    // true in JS even though 10 commits is strictly newer than 9. Dismissal
    // must be exact-match only, never an ordering comparison.
    const lastVisitedAt = "2026-09-01T00:00:00Z";
    const nineCommits = sitrepCacheKey({ lastVisitedAt, newestEventTs: "", commits: 9, filesChanged: 5 });
    const tenCommits = sitrepCacheKey({ lastVisitedAt, newestEventTs: "", commits: 10, filesChanged: 6 });
    expect(nineCommits >= tenCommits).toBe(true); // sanity check: the trap this guards against is real

    const dismissedAtNine = { ...base, currentKey: tenCommits, dismissedKey: nineCommits };
    expect(sitrepBanner(dismissedAtNine).show).toBe(true); // a new commit — must show again

    const stillAtNine = { ...base, currentKey: nineCommits, dismissedKey: nineCommits };
    expect(sitrepBanner(stillAtNine).show).toBe(false); // the exact dismissed range — stays hidden
  });

  it("shows the cached text when its key matches the current range", () => {
    expect(sitrepBanner({ ...base, cached: { text: "Summary of the week", key: "k2" } })).toEqual({
      show: true,
      source: "cached",
      text: "Summary of the week",
    });
  });

  it("treats a stale cached key as nothing cached yet, asking the caller to generate", () => {
    const r = sitrepBanner({ ...base, cached: { text: "Old summary", key: "k1" } });
    expect(r).toEqual({ show: true, source: "generated", text: "" });
  });

  it("falls back to the digest on a generation error", () => {
    const r = sitrepBanner({ ...base, genError: true });
    expect(r.source).toBe("digest");
    expect(r.text).toBe(buildDigest(delta));
  });

  it("falls back to the digest on a resolved-but-empty cached summary for this range", () => {
    const r = sitrepBanner({ ...base, cached: { text: "", key: "k2" } });
    expect(r.source).toBe("digest");
  });

  it("asks the caller to generate when nothing is cached yet and there is no error", () => {
    expect(sitrepBanner(base)).toEqual({ show: true, source: "generated", text: "" });
  });
});
