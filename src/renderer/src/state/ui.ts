// Ephemeral shell state: overlays, transient hints, the tab currently being
// renamed. None of it belongs in layout.json, so none of it is persisted.

import { create } from "zustand";
import type { MenuItem } from "../components/ContextMenu";

interface UiState {
  paletteOpen: boolean;
  pickerOpen: boolean;
  guideOpen: boolean;
  /** True while the ⌘-hold (or `?`) shortcut overlay is showing. */
  hintsVisible: boolean;
  renamingTabId: string | null;
  renamingGroupId: string | null;
  /** The one note in edit mode. One at a time is what makes a global ⌘S unambiguous. */
  editingNoteId: string | null;
  /** The one open context menu, if any. One at a time, by construction. */
  menu: { x: number; y: number; items: MenuItem[] } | null;
  toast: string | null;
  /** Which settings panel to show; lets the palette deep-link into one. */
  settingsPanel: string;
  /** Which row inside that panel to scroll to and flash, when arriving from a
   *  click that named one. Cleared once used. */
  settingsAnchor: string | null;
  /** Which environment the per-environment panels describe. `null` follows the
   *  active environment; a gear on one environment's tab pins that one, so
   *  asking about a world does not require moving into it. */
  settingsEnvId: string | null;

  togglePalette(open?: boolean): void;
  togglePicker(open?: boolean): void;
  toggleGuide(open?: boolean): void;
  setHints(visible: boolean): void;
  /** `?` shows the same overlay as holding ⌘, but latched until dismissed. */
  flashHints(): void;
  startRenamingTab(id: string | null): void;
  startRenamingGroup(id: string | null): void;
  editNote(widgetId: string | null): void;
  openMenu(x: number, y: number, items: MenuItem[]): void;
  closeMenu(): void;
  openSettingsPanel(panel: string, envId?: string): void;
  clearSettingsAnchor(): void;
  showToast(message: string | null): void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useUi = create<UiState>((set, get) => ({
  paletteOpen: false,
  pickerOpen: false,
  guideOpen: false,
  hintsVisible: false,
  renamingTabId: null,
  renamingGroupId: null,
  editingNoteId: null,
  menu: null,
  toast: null,
  settingsPanel: "connections",
  settingsAnchor: null,
  settingsEnvId: null,

  togglePalette(open) {
    set((s) => ({ paletteOpen: open ?? !s.paletteOpen, pickerOpen: false, guideOpen: false }));
  },
  togglePicker(open) {
    set((s) => ({ pickerOpen: open ?? !s.pickerOpen, paletteOpen: false, guideOpen: false }));
  },
  toggleGuide(open) {
    set((s) => ({ guideOpen: open ?? !s.guideOpen, paletteOpen: false, pickerOpen: false }));
  },
  setHints(visible) {
    set({ hintsVisible: visible });
  },
  flashHints() {
    set({ hintsVisible: !get().hintsVisible });
  },
  startRenamingTab(id) {
    // Renaming and a menu are both "this tab, right now" modes; letting them
    // coexist would leave a menu floating over an input it can no longer act on.
    set({ renamingTabId: id, renamingGroupId: null, menu: null });
  },
  startRenamingGroup(id) {
    set({ renamingGroupId: id, renamingTabId: null, menu: null });
  },
  editNote(widgetId) {
    set({ editingNoteId: widgetId, menu: null });
  },
  openMenu(x, y, items) {
    set({ menu: { x, y, items }, paletteOpen: false, pickerOpen: false });
  },
  closeMenu() {
    set({ menu: null });
  },
  openSettingsPanel(panel, envId) {
    set({
      settingsPanel: panel,
      settingsAnchor: envId ?? null,
      // Omitted means "whatever is active" — that is what the header gear does.
      settingsEnvId: envId ?? null,
      paletteOpen: false,
    });
  },
  clearSettingsAnchor() {
    set({ settingsAnchor: null });
  },
  showToast(message) {
    clearTimeout(toastTimer);
    set({ toast: message });
    if (message) toastTimer = setTimeout(() => set({ toast: null }), 2600);
  },
}));
