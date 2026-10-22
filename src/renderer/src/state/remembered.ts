/**
 * What a widget last saw, kept for as long as the window lives.
 *
 * Switching tabs unmounts every widget on the tab you left and mounts the ones
 * on the tab you arrived at, so each of them fetches from nothing. Even when
 * that fetch is fast the widget paints empty first and fills a moment later,
 * which is the part that reads as "loading" — and on a board with a projects
 * card and a dev server list it was most of a second of genuine work as well.
 *
 * So a widget paints what it saw last, immediately, and refreshes underneath.
 * The data is already allowed to be a few seconds old — the scheduler owns the
 * cadence and every one of these views is a read of a cache — so showing the
 * previous answer for one frame is not a new kind of staleness. It is the same
 * staleness, without the flash of empty.
 *
 * Deliberately in memory and not persisted: a board that restores yesterday's
 * ports on launch would be lying about the present, and this is only meant to
 * survive a tab switch.
 */

import { useCallback, useRef, useState } from "react";

const seen = new Map<string, unknown>();

export function remembered<T>(key: string): T | undefined {
  return seen.get(key) as T | undefined;
}

export function remember<T>(key: string, value: T): void {
  seen.set(key, value);
}

/** Forget everything. Used when an environment's data is wiped. */
export function forgetAll(): void {
  seen.clear();
}

/**
 * `useState`, seeded from what this key last held and writing back on every
 * set. The key must identify the *view*, not the widget instance, so two
 * widgets showing the same thing share an answer and one widget in two
 * environments does not.
 */
export function useRemembered<T>(key: string, initial: T): [T, (value: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => remembered<T>(key) ?? initial);
  // The key can change while mounted — an environment switch — so the write
  // has to use the key of the moment rather than the one from first render.
  const current = useRef(key);
  current.current = key;

  // Takes an updater as well as a value, because `useState` does and these
  // replace `useState` calls — a row list updated from its previous self is
  // exactly how a probe result lands.
  const set = useCallback((next: T | ((previous: T) => T)) => {
    setValue((previous) => {
      const resolved = typeof next === "function" ? (next as (p: T) => T)(previous) : next;
      remember(current.current, resolved);
      return resolved;
    });
  }, []);

  return [value, set];
}
