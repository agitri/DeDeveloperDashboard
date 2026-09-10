/**
 * How long a tab switch actually takes, measured where it happens.
 *
 * A Tauri window is not a debuggable browser target, so "it feels slow" cannot
 * be turned into a number from outside. This writes the number into the events
 * table the stats board already owns, which can be read back from SQLite.
 *
 * A switch is not over when the click lands; it is over when the last widget on
 * the arriving tab has finished its first load. So each widget reports its own
 * first load, and the switch is closed by whichever finishes last.
 */

import { ipc } from "../lib/ipc";

/** How long the board has to stay quiet before a switch counts as finished. */
const SETTLED_MS = 300;

/**
 * A load that only *begins* this long after the switch is a poll, not part of
 * arriving on the tab. Without this, a tab where nothing ever loads leaves a
 * switch open until the next five-second refresh adopts it and reports the
 * wait as the switch's cost.
 */
const STALE_MS = 10_000;

interface Switch {
  tabId: string;
  env: string;
  startedAt: number;
  /** The last moment any widget finished — the switch's real end. */
  lastFinish: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let current: Switch | null = null;

/** Called when a tab is selected, before anything mounts. */
export function switchStarted(env: string, tabId: string): void {
  if (current?.timer) clearTimeout(current.timer);
  current = { tabId, env, startedAt: performance.now(), lastFinish: 0, timer: null };
}

/**
 * Wrap a widget's first load. Later loads — polls, refreshes — are not part of
 * a switch and are not counted.
 */
export async function firstLoad<T>(kind: string, load: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const owner = current && startedAt - current.startedAt < STALE_MS ? current : null;
  try {
    return await load();
  } finally {
    if (owner && owner === current) record(owner, kind, startedAt);
  }
}

function record(owner: Switch, kind: string, startedAt: number): void {
  const now = performance.now();
  owner.lastFinish = now;
  ipc.eventLog(owner.env, {
    kind: "perf.widget",
    meta: {
      widget: kind,
      ms: Math.round(now - startedAt),
      sinceSwitch: Math.round(now - owner.startedAt),
    },
  });

  // Counting outstanding loads and closing at zero looks tidier and is wrong:
  // widgets mount in staggered effects, so the count legitimately touches zero
  // between the first widget finishing and the second one starting. Waiting for
  // the board to go quiet instead measures the thing a person is actually
  // watching, and the wait itself is not counted.
  if (owner.timer) clearTimeout(owner.timer);
  owner.timer = setTimeout(() => {
    if (owner !== current) return;
    current = null;
    ipc.eventLog(owner.env, {
      kind: "perf.switch",
      meta: { tab: owner.tabId, ms: Math.round(owner.lastFinish - owner.startedAt) },
    });
  }, SETTLED_MS);
}
