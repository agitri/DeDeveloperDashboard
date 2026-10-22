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
    // `ai.tab.sitrep` is this widget's own generation event, logged by
    // `tab_sitrep_generate` for the stats board. Counting it here would be
    // self-referential noise at best ("AI: tab.sitrep ×N") — and, worse, it
    // is also excluded from `newestRelevantTs` below to break a feedback
    // loop, so a delta that still counted it here could look non-empty
    // (and re-trigger the generate effect) purely because of a summary the
    // widget generated for itself.
    if (e.kind.startsWith("ai.") && e.kind !== "ai.tab.sitrep") {
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
  if (d.commits > 0)
    parts.push(`${d.commits} commit${d.commits === 1 ? "" : "s"} touched ${d.filesChanged} file${d.filesChanged === 1 ? "" : "s"}`);
  if (d.processesStopped.length > 0) parts.push(`${d.processesStopped.join(", ")} stopped`);
  if (d.aiActions.length > 0) parts.push("AI: " + d.aiActions.map((a) => `${a.action} ×${a.count}`).join(", "));
  return parts.join(". ") + ".";
}

/**
 * The newest timestamp among events worth invalidating the cache key over —
 * every event EXCEPT `ai.tab.sitrep`, which `tab_sitrep_generate` logs for
 * itself each time it runs.
 *
 * This exclusion is what breaks a feedback loop, not a style choice: without
 * it, generating a summary logs an `ai.tab.sitrep` event stamped with the
 * current time; the next `refresh()` pulls that event back in; it is newer
 * than anything else, so it becomes the cache key's timestamp; the key
 * changes; `sitrepBanner` sees a mismatched cache and reports
 * `source: "generated"` again; the widget regenerates; which logs another
 * `ai.tab.sitrep` event — forever, roughly once per refresh interval, for as
 * long as the tab stays open and away. The command's logging is correct and
 * wanted (the stats board counts it); the bug was ever feeding that event
 * back into the same computation that decides whether to log another one.
 * Do not remove this exclusion without replacing the loop-breaker it provides.
 */
export function newestRelevantTs(events: EventRow[]): string {
  let t = "";
  for (const e of events) {
    if (e.kind === "ai.tab.sitrep") continue;
    if (e.ts > t) t = e.ts;
  }
  return t;
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
  if (args.dismissedKey === args.currentKey) {
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
