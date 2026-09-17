// The single global key listener. One listener, one lookup table, no component
// scattering `onKeyDown` handlers around.

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_KEYMAP, buildActions, type Action } from "./actions";
import { eventToBinding, isTypingTarget, normalizeBinding } from "./keys";
import { ipc } from "../lib/ipc";
import { useUi } from "../state/ui";
import { useWizard } from "../onboarding/useWizard";

export function useKeymap(): Record<string, string[]> {
  const [keymap, setKeymap] = useState<Record<string, string[]>>(DEFAULT_KEYMAP);

  // One keymap for the whole app, so this does not depend on the environment.
  useEffect(() => {
    let cancelled = false;
    void ipc.keymapLoad().then((saved) => {
      // The preset is the base; keymap.json only has to carry the differences.
      if (!cancelled) setKeymap(saved ? { ...DEFAULT_KEYMAP, ...saved } : DEFAULT_KEYMAP);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return keymap;
}

/** binding → actionId, with the user's overrides folded over the preset. */
function bindingIndex(keymap: Record<string, string[]>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [actionId, bindings] of Object.entries(keymap)) {
    for (const binding of bindings) {
      // First writer wins, so a conflict degrades to "one of them works"
      // rather than "both fire".
      const norm = normalizeBinding(binding);
      if (!index.has(norm)) index.set(norm, actionId);
    }
  }
  return index;
}

export function useGlobalKeys(keymap: Record<string, string[]>) {
  const index = useMemo(() => bindingIndex(keymap), [keymap]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Hold ⌘ (or Ctrl) to see what every key does. Hints are how shortcuts get
      // learned; a cheat sheet nobody opens is how they die. But during the
      // onboarding tour every step tells you to press a ⌘-shortcut, so the
      // cheat sheet would pop over the wizard's own spotlight on every step —
      // suppress it while the tour is running (the coach panel shows the one
      // shortcut that matters).
      if (
        (e.key === "Meta" || e.key === "Control") &&
        !useUi.getState().paletteOpen &&
        !useWizard.getState().active
      ) {
        useUi.getState().setHints(true);
      }

      const binding = eventToBinding(e);
      const actionId = index.get(binding);
      if (!actionId) return;

      const actions: Action[] = buildActions();
      const action = actions.find((a) => a.id === actionId);
      if (!action) return;

      // An overlay (palette, widget picker, features guide) traps keyboard
      // focus the same way a text field does: board-scope actions (the
      // default) would otherwise leak through the scrim and drive the board
      // behind it, while global-scope ones — chiefly `app.escape` — must
      // still get through so the overlay can be closed.
      const ui = useUi.getState();
      const overlayOpen = ui.paletteOpen || ui.pickerOpen || ui.guideOpen;
      const typing = isTypingTarget(e.target);
      if ((typing || overlayOpen) && (action.scope ?? "board") !== "global") return;

      e.preventDefault();
      action.run();
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.key === "Meta" || e.key === "Control") useUi.getState().setHints(false);
    }

    // Losing the window while ⌘ is down would otherwise strand the overlay on.
    function onBlur() {
      useUi.getState().setHints(false);
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [index]);
}

/** First binding for an action, for hint chips and palette rows. */
export function bindingFor(keymap: Record<string, string[]>, actionId: string): string | null {
  return keymap[actionId]?.[0] ?? null;
}
