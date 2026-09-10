//! Tab order and group membership.
//!
//! Pure functions over `(tabs, groups)` rather than zustand actions, because
//! the rule they enforce — a group's tabs must be adjacent — is the whole
//! feature, and it is far easier to pin in a test than to eyeball in a strip.
//!
//! Everything here operates on one environment's tabs. A group can never span
//! two environments, so the environment is implicit in the input.

import type { Tab, TabGroup } from "../types";

export type Ordering = { tabs: Tab[]; groups: TabGroup[] };

/**
 * Restore the invariant, whatever state the input was in.
 *
 * Runs at the end of every operation rather than being assumed, so a
 * `layout.json` that was hand-edited — or written before groups had any UI —
 * still renders as a strip instead of a group split in two.
 */
function normalize({ tabs, groups }: Ordering): Ordering {
  // A group with no tabs has nothing to draw and no way to be reached, so it
  // would only ever leak into layout.json.
  const kept = groups.filter((g) => tabs.some((t) => t.groupId === g.id));
  const known = new Set(kept.map((g) => g.id));

  // A tab pointing at a group that is gone would render outside every pill.
  const cleaned = tabs.map((t) =>
    t.groupId && !known.has(t.groupId) ? { ...t, groupId: null } : t,
  );

  // Emit each group's whole run at the position of its first member.
  const out: Tab[] = [];
  const emitted = new Set<string>();
  for (const t of cleaned) {
    if (!t.groupId) {
      out.push(t);
      continue;
    }
    if (emitted.has(t.groupId)) continue;
    emitted.add(t.groupId);
    out.push(...cleaned.filter((x) => x.groupId === t.groupId));
  }

  return { tabs: out, groups: kept };
}

/**
 * A group id this ordering actually owns, or `null`.
 *
 * An `Ordering` is always exactly one environment's tabs and groups, so "is
 * this group in this ordering?" *is* the cross-environment guard: a group id
 * belonging to another environment is not in `groups` and is refused here.
 *
 * That matters more than it looks. Tab and group ids are unique today only
 * because `uid()` mints them randomly — layout import, which §5.9 promises,
 * would make foreign ids reachable. A tab must never end up carrying another
 * environment's group id: the two worlds are a wall, and a tab that pointed
 * across it would render inside a group it cannot belong to.
 */
function ownGroup(ordering: Ordering, groupId: string | null): string | null {
  if (groupId === null) return null;
  return ordering.groups.some((g) => g.id === groupId) ? groupId : null;
}

/**
 * Which group a tab landing at `index` belongs to, inferred from its neighbours.
 *
 * Used only when the caller has no better answer. Requiring *both* neighbours
 * to agree makes "drop on the seam between two groups" mean "ungrouped" rather
 * than "whichever side won the rounding" — but it also means a run's leading
 * and trailing edges do not join, and a one-tab group can never be joined at
 * all, because such a group has no inside.
 *
 * That is why a drag passes its group explicitly: the pointer is either over a
 * group's box or it is not, which is both what the user sees and the only
 * reading that works at the edges.
 */
function groupAt(tabs: Tab[], index: number): string | null {
  const before = tabs[index - 1]?.groupId ?? null;
  const after = tabs[index + 1]?.groupId ?? null;
  return before !== null && before === after ? before : null;
}

/**
 * Move a tab to an insertion boundary, taking whatever group that spot implies.
 *
 * `toIndex` is a boundary in the array as the caller sees it — the tab ends up
 * before whatever currently sits at that index — which is exactly what a drag
 * caret between two tabs reports.
 */
export function moveTab(
  ordering: Ordering,
  tabId: string,
  toIndex: number,
  /**
   * Which group the drop lands in. A string joins it, `null` leaves every
   * group, and `undefined` means "work it out from the neighbours" — which is
   * what a caller with no pointer to hit-test has to fall back on.
   */
  groupId?: string | null,
): Ordering {
  const from = ordering.tabs.findIndex((t) => t.id === tabId);
  if (from === -1) return ordering;

  const rest = ordering.tabs.filter((t) => t.id !== tabId);
  // Removing the tab shifts every later boundary left by one.
  const target = Math.max(0, Math.min(rest.length, from < toIndex ? toIndex - 1 : toIndex));

  const moved = { ...ordering.tabs[from]!, groupId: null as string | null };
  const tabs = [...rest.slice(0, target), moved, ...rest.slice(target)];
  // An explicit group is the drop's own answer and outranks inference. One this
  // ordering does not own — deleted, or another environment's — is refused
  // rather than trusted.
  moved.groupId = groupId === undefined ? groupAt(tabs, target) : ownGroup(ordering, groupId);

  return normalize({ tabs, groups: ordering.groups });
}

/**
 * Move a whole group to an insertion boundary, run and all.
 *
 * `toIndex` is a boundary in the array as the caller sees it, exactly as in
 * `moveTab` — the group ends up before whatever currently sits there.
 *
 * A group dropped inside another does **not** nest: groups are one level deep,
 * and the run keeps its own id, so `normalize` pulls the two runs apart and the
 * moved group lands just after the one it was dropped into. That is the only
 * sane reading of the gesture, and it is a test rather than a comment.
 */
export function moveGroup(ordering: Ordering, groupId: string, toIndex: number): Ordering {
  const run = ordering.tabs.filter((t) => t.groupId === groupId);
  if (run.length === 0) return ordering;

  const rest = ordering.tabs.filter((t) => t.groupId !== groupId);
  // Removing the run shifts every boundary after it left by however many of its
  // members sat before that boundary.
  const removedBefore = ordering.tabs
    .slice(0, toIndex)
    .filter((t) => t.groupId === groupId).length;
  const target = Math.max(0, Math.min(rest.length, toIndex - removedBefore));

  const tabs = [...rest.slice(0, target), ...run, ...rest.slice(target)];
  return normalize({ tabs, groups: ordering.groups });
}

/**
 * Put a tab into a group, or take it out, moving it so the runs stay whole.
 *
 * Joining lands it after the group's current last member; leaving lands it
 * just past its former run rather than staying put, which would split the run
 * it just left.
 */
export function setTabGroup(
  ordering: Ordering,
  tabId: string,
  groupId: string | null,
): Ordering {
  const from = ordering.tabs.findIndex((t) => t.id === tabId);
  if (from === -1) return ordering;

  // Refused here rather than left to `normalize` to strip: a guard that works
  // by accident downstream is one a later change can quietly remove.
  const target_group = ownGroup(ordering, groupId);
  const moved = { ...ordering.tabs[from]!, groupId: target_group };
  const previousGroup = ordering.tabs[from]!.groupId;
  const rest = ordering.tabs.filter((t) => t.id !== tabId);

  // Anchor on the run this tab is joining, or on the one it just left.
  const anchor = target_group ?? previousGroup;
  const lastOfRun = anchor
    ? rest.reduce((last, t, i) => (t.groupId === anchor ? i : last), -1)
    : -1;
  // No run to anchor to (a brand-new group, or the last member leaving) means
  // the tab has no reason to move at all.
  const target = lastOfRun === -1 ? Math.min(from, rest.length) : lastOfRun + 1;

  return normalize({
    tabs: [...rest.slice(0, target), moved, ...rest.slice(target)],
    groups: ordering.groups,
  });
}

/**
 * Consecutive tabs sharing a group id.
 *
 * The contiguity invariant `normalize` maintains is what makes this a scan
 * rather than a search — and rendering *in run order* is what keeps the DOM in
 * the same order as the tab array. Anything that resolves a drop by walking
 * rendered elements depends on that: render every ungrouped tab first and then
 * the groups, and a drop computes an index for the wrong tab.
 */
export function runsOf<T extends { groupId?: string | null }>(
  envTabs: T[],
): { groupId: string | null; tabs: T[]; from: number }[] {
  const runs: { groupId: string | null; tabs: T[]; from: number }[] = [];
  envTabs.forEach((tab, i) => {
    const last = runs[runs.length - 1];
    const groupId = tab.groupId ?? null;
    if (last && groupId !== null && last.groupId === groupId) last.tabs.push(tab);
    else runs.push({ groupId, tabs: [tab], from: i });
  });
  return runs;
}
