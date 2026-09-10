import { describe, expect, it } from "vitest";
import actions from "./actions.ts?raw";
import overlay from "../components/HintOverlay.tsx?raw";

/**
 * The hint overlay is a hand-written list, while the command palette and the
 * settings keyboard panel both build themselves from `buildActions()`. So those
 * two pick up a new action on their own and the overlay does not — which is
 * exactly how `h`/`l` came to move between buttons without the sheet that
 * teaches keys ever mentioning it.
 *
 * Hints are how shortcuts get learned (§5.10). A key nobody can discover is a
 * key nobody has.
 */

/** Action ids declared in the `Navigate` group — the within-a-board vocabulary. */
function navigateActions(source: string): string[] {
  const ids: string[] = [];
  // Each action is an object literal; find the id that precedes each
  // `group: "Navigate"` without crossing into the previous action's body.
  for (const match of source.matchAll(/group: "Navigate"/g)) {
    const before = source.slice(0, match.index);
    const id = [...before.matchAll(/id: "([\w.]+)"/g)].pop()?.[1];
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

describe("the shortcut hint overlay", () => {
  it("finds the navigate actions at all", () => {
    // If this regex ever stops matching, every assertion below passes
    // vacuously — which would be worse than the drift it is meant to catch.
    const found = navigateActions(actions);
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(found).toContain("control.next");
  });

  it("mentions every way of moving around a board", () => {
    const missing = navigateActions(actions).filter((id) => {
      // A pair like next/prev is taught as one line; naming either satisfies it.
      const pair = id.replace(/\.next$/, ".prev").replace(/\.prev$/, ".next");
      return !overlay.includes(`"${id}"`) && !overlay.includes(`"${pair}"`);
    });
    expect(missing).toEqual([]);
  });

  it("names only actions that exist", () => {
    // From DEFAULT_KEYMAP rather than the `id:` literals: the tab and
    // environment actions are built in a loop, so their ids never appear as
    // literals even though they are perfectly real.
    const keymap = actions.slice(actions.indexOf("DEFAULT_KEYMAP"));
    const declared = new Set([...keymap.matchAll(/"([\w.]+)":\s*\[/g)].map((m) => m[1]));
    const referenced = [...overlay.matchAll(/", "([\w.]+)"\]/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(5);
    for (const id of referenced) expect([...declared]).toContain(id);
  });
});
