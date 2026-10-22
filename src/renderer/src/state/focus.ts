// Keyboard focus is app state, not DOM state.
//
// Two levels, as §5.10 describes them: which *widget* has focus (Tab /
// Shift+Tab) and which *item* inside it (j / k). Widgets that hold a list
// register their length and an open handler; widgets that don't simply never
// register, and j/k skip straight past them.
//
// A third level — which *button* — is deliberately not here. A button is a DOM
// element that already knows how to be focused and activated, so `keyboard/
// controls.ts` drives real focus rather than mirroring it into this store.

import { create } from "zustand";

interface FocusState {
  focusedWidgetId: string | null;
  /** Item index within the focused widget. */
  itemIndex: number;
  itemCounts: Record<string, number>;
  openHandlers: Record<string, (index: number) => void>;
  /**
   * Single-key verbs on the focused item (§5.10): `r` reply, `a` archive,
   * `t` todo… Widgets register whichever ones they support, so the action
   * registry can bind a key without knowing what is on screen.
   */
  verbHandlers: Record<string, Record<string, (index: number) => void>>;

  focusWidget(id: string | null): void;
  /** Move focus between widgets, following the order given by the caller. */
  moveWidgetFocus(order: string[], delta: number): void;
  moveItem(delta: number): void;
  openFocusedItem(): void;
  runVerb(verb: string): void;
  registerWidget(id: string, count: number, onOpen?: (index: number) => void, verbs?: Record<string, (index: number) => void>): void;
  unregisterWidget(id: string): void;
}

export const useFocus = create<FocusState>((set, get) => ({
  focusedWidgetId: null,
  itemIndex: 0,
  itemCounts: {},
  openHandlers: {},
  verbHandlers: {},

  focusWidget(id) {
    set({ focusedWidgetId: id, itemIndex: 0 });
  },

  moveWidgetFocus(order, delta) {
    if (order.length === 0) return;
    const current = order.indexOf(get().focusedWidgetId ?? "");
    // No focus yet + forward step lands on the first widget rather than the second.
    const start =
      current === -1 ?
        delta > 0 ?
          -1
        : 0
      : current;
    const next = (((start + delta) % order.length) + order.length) % order.length;
    set({ focusedWidgetId: order[next]!, itemIndex: 0 });
  },

  moveItem(delta) {
    const { focusedWidgetId, itemCounts, itemIndex } = get();
    if (!focusedWidgetId) return;
    const count = itemCounts[focusedWidgetId] ?? 0;
    if (count === 0) return;
    set({ itemIndex: Math.max(0, Math.min(count - 1, itemIndex + delta)) });
  },

  openFocusedItem() {
    const { focusedWidgetId, itemIndex, openHandlers, itemCounts } = get();
    if (!focusedWidgetId) return;
    if ((itemCounts[focusedWidgetId] ?? 0) === 0) return;
    openHandlers[focusedWidgetId]?.(itemIndex);
  },

  runVerb(verb) {
    const { focusedWidgetId, itemIndex, verbHandlers, itemCounts } = get();
    if (!focusedWidgetId) return;
    if ((itemCounts[focusedWidgetId] ?? 0) === 0) return;
    verbHandlers[focusedWidgetId]?.[verb]?.(itemIndex);
  },

  registerWidget(id, count, onOpen, verbs) {
    set((s) => ({
      itemCounts: { ...s.itemCounts, [id]: count },
      openHandlers: onOpen ? { ...s.openHandlers, [id]: onOpen } : s.openHandlers,
      verbHandlers: verbs ? { ...s.verbHandlers, [id]: verbs } : s.verbHandlers,
      // Clamp: a list that shrank under the cursor must not leave it dangling.
      itemIndex: s.focusedWidgetId === id ? Math.min(s.itemIndex, Math.max(0, count - 1)) : s.itemIndex,
    }));
  },

  unregisterWidget(id) {
    set((s) => {
      const itemCounts = { ...s.itemCounts };
      const openHandlers = { ...s.openHandlers };
      const verbHandlers = { ...s.verbHandlers };
      delete itemCounts[id];
      delete openHandlers[id];
      delete verbHandlers[id];
      return {
        itemCounts,
        openHandlers,
        verbHandlers,
        focusedWidgetId: s.focusedWidgetId === id ? null : s.focusedWidgetId,
      };
    });
  },
}));
