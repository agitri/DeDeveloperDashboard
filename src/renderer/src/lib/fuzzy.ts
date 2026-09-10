/**
 * Subsequence matching with a bias toward word starts, so "lio" finds
 * "Launch IO" ahead of "Reload notification". Small and predictable beats
 * clever here: the palette is muscle memory, and muscle memory hates surprises.
 */
export function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();

  let score = 0;
  let hi = 0;
  let previousMatch = -2;

  for (const char of n) {
    if (char === " ") continue;
    const found = h.indexOf(char, hi);
    if (found === -1) return null;

    if (found === previousMatch + 1) score += 6; // contiguous run
    if (found === 0 || /[\s\-_./:]/.test(h[found - 1] ?? "")) score += 8; // word start
    score -= Math.min(found - hi, 6); // distance penalty
    previousMatch = found;
    hi = found + 1;
  }

  // Shorter targets win ties: "Notes" should beat "Notes settings sync".
  return score - h.length * 0.05;
}
