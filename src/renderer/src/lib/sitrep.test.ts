import { describe, expect, it } from "vitest";
import { awayInfo, buildDigest, extractDelta } from "./sitrep";
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
});

describe("buildDigest", () => {
  it("renders counts and handles an empty delta", () => {
    const text = buildDigest({ projectName: "acme", awayDays: 15, processesStopped: ["api"], processesRunning: 1, commits: 4, filesChanged: 12, commitMessages: [], aiActions: [] });
    expect(text).toContain("12");
    expect(text).toContain("api");
    const empty = buildDigest({ projectName: "acme", awayDays: 15, processesStopped: [], processesRunning: 0, commits: 0, filesChanged: 0, commitMessages: [], aiActions: [] });
    expect(empty.toLowerCase()).toContain("nothing");
  });
});
