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
