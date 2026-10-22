import type { ModelScan } from "../types";

/** "4.7 GB", "512 B": decimal units (what Finder and `ollama list` show), one
 *  decimal only when the number is small enough to need it. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const text = i === 0 ? String(Math.round(v)) : v >= 10 ? String(Math.round(v)) : v.toFixed(1);
  return `${text} ${units[i]}`;
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** The ids "Move all" walks: every model still in its store, in the order the
 *  widget shows them, minus the ones already moved this session. */
export function moveQueue(scan: ModelScan, moved: ReadonlySet<string>): string[] {
  return scan.stores.flatMap((s) => s.models.map((m) => m.id)).filter((id) => !moved.has(id));
}
