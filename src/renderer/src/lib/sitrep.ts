import type { EventRow, Product } from "../types";
import { filterByProject } from "./products";

// Structural twin of core's SitrepInput (src/core/ai/sitrep.ts). Declared here
// rather than imported so the renderer TS project does not reach across the
// core/renderer boundary — the same both-sides-declare convention the port uses
// for Product/ProductState. The command casts the object it receives.
export interface SitrepInput {
  projectName: string;
  awayDays: number;
  processesStopped: string[];
  processesRunning: number;
  commits: number;
  filesChanged: number;
  commitMessages: string[];
  aiActions: { action: string; count: number }[];
}

export function awayInfo(lastVisitedAt: string | null | undefined, now: number, thresholdDays: number): { away: boolean; days: number } {
  if (!lastVisitedAt) return { away: false, days: 0 };
  const ms = now - Date.parse(lastVisitedAt);
  if (!Number.isFinite(ms) || ms < 0) return { away: false, days: 0 };
  const days = Math.floor(ms / 86_400_000);
  return { away: days >= thresholdDays, days };
}

export function extractDelta(args: {
  projectName: string;
  projectId: string;
  awayDays: number;
  products: Product[];
  events: EventRow[];
  changes: { commits: number; filesChanged: number; messages: string[] };
}): SitrepInput {
  const mine = filterByProject(args.products, args.projectId);
  const processesStopped = mine.filter((p) => p.state.state !== "running").map((p) => p.name || p.productId);
  const processesRunning = mine.filter((p) => p.state.state === "running").length;
  const forProject = args.events.filter((e) => e.project === args.projectName || e.project === args.projectId);
  const counts = new Map<string, number>();
  for (const e of forProject) {
    if (e.kind.startsWith("ai.")) {
      const action = e.kind.slice(3);
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
  }
  const aiActions = [...counts.entries()].map(([action, count]) => ({ action, count }));
  return {
    projectName: args.projectName,
    awayDays: args.awayDays,
    processesStopped,
    processesRunning,
    commits: args.changes.commits,
    filesChanged: args.changes.filesChanged,
    commitMessages: args.changes.messages,
    aiActions,
  };
}

export function isEmptyDelta(d: SitrepInput): boolean {
  return d.commits === 0 && d.processesStopped.length === 0 && d.aiActions.length === 0;
}

export function buildDigest(d: SitrepInput): string {
  if (isEmptyDelta(d)) return `Nothing changed in ${d.projectName} while you were away.`;
  const parts: string[] = [];
  if (d.commits > 0) parts.push(`${d.commits} commit${d.commits === 1 ? "" : "s"} touched ${d.filesChanged} file${d.filesChanged === 1 ? "" : "s"}`);
  if (d.processesStopped.length > 0) parts.push(`${d.processesStopped.join(", ")} stopped`);
  if (d.aiActions.length > 0) parts.push("AI: " + d.aiActions.map((a) => `${a.action} ×${a.count}`).join(", "));
  return parts.join(". ") + ".";
}

/**
 * The covered-range / cache-invalidation key for a sitrep's AI summary.
 *
 * Events carry timestamps; `repoChangesSince`'s commit and file counts do
 * not, so on their own they can never move `newestEventTs` forward. A summary
 * cached against an old commit count must still invalidate the moment a new
 * commit lands — even with no new `ai.`/`product.` event in between — so
 * `commits` and `filesChanged` are folded into the key rather than deriving
 * it from timestamps alone (the bug this closes: the cached banner disagreeing
 * with the always-on digest line right below it).
 */
export function sitrepCacheKey(input: {
  lastVisitedAt: string | null | undefined;
  newestEventTs: string;
  commits: number;
  filesChanged: number;
}): string {
  const base = input.newestEventTs || input.lastVisitedAt || "";
  return `${base}::${input.commits}::${input.filesChanged}`;
}

/**
 * What the "while you were away" banner shows — decided without touching the
 * network or the store, so the widget only calls `ipc.tabSitrepGenerate` when
 * this returns `source: "generated"`, and caches the result under
 * `currentKey` (built by `sitrepCacheKey`).
 *
 * `source`:
 * - `"none"`: show no banner — not away, nothing changed, or the viewer
 *   already dismissed exactly this range.
 * - `"cached"`: a summary already covers `currentKey` — show it verbatim.
 * - `"digest"`: the model failed, or resolved with nothing usable, for this
 *   range — show the deterministic digest and offer a retry. Never gets
 *   stuck: an empty `cached.text` for the current key counts as a failure
 *   here too, the same as a thrown error.
 * - `"generated"`: nothing has been tried yet for this range — the caller
 *   should call `tabSitrepGenerate` and cache what comes back.
 */
export function sitrepBanner(args: {
  away: boolean;
  delta: SitrepInput;
  cached?: { text: string; key: string };
  currentKey: string;
  genError: boolean;
  dismissedKey?: string;
}): { show: boolean; source: "cached" | "generated" | "digest" | "none"; text: string } {
  if (!args.away || isEmptyDelta(args.delta)) {
    return { show: false, source: "none", text: "" };
  }
  if (args.dismissedKey && args.dismissedKey >= args.currentKey) {
    return { show: false, source: "none", text: "" };
  }

  const cacheForRange = args.cached && args.cached.key === args.currentKey ? args.cached : undefined;

  if (cacheForRange && cacheForRange.text) {
    return { show: true, source: "cached", text: cacheForRange.text };
  }
  if (args.genError || (cacheForRange && !cacheForRange.text)) {
    return { show: true, source: "digest", text: buildDigest(args.delta) };
  }
  return { show: true, source: "generated", text: "" };
}
