export interface WizardSnapshot {
  envCount: number;
  tabCount: number;
  widgetCount: number;
  activeTabId: string | null;
  view: string;
}

export interface WizardStep {
  id: string;
  title: string;
  instruction: string;
  shortcut?: string; // display glyphs, e.g. "⌘⇧A"
  target?: string; // a data-wizard-target key to spotlight
  hint: string; // shown by "Show me" / auto-hint
  /** Whether the user has completed this step, given the baseline captured when
   *  the step began and the current snapshot. Pure. */
  done(baseline: WizardSnapshot, current: WizardSnapshot): boolean;
}

const advanceable = () => true; // welcome/finish: the user clicks Next

export const STEPS: WizardStep[] = [
  {
    id: "welcome",
    title: "Welcome — let's do this hands-on",
    instruction: "This tour has you actually try each thing. Ready?",
    hint: "Click Next to begin. You can exit anytime.",
    done: advanceable,
  },
  {
    id: "environment",
    title: "Make an environment",
    instruction: "Environments are separate boards. Create one: press ⌘⇧N, then Create.",
    shortcut: "⌘⇧N",
    target: "environments",
    hint: "⌘⇧N opens Settings → Environments. Type a name and click Create.",
    done: (b, c) => c.envCount > b.envCount,
  },
  {
    id: "tab",
    title: "Add a tab",
    instruction: "Each environment holds tabs. Add one with ⌘T.",
    shortcut: "⌘T",
    target: "new-tab",
    hint: "⌘T adds a tab, or click the + at the end of the tab strip.",
    done: (b, c) => c.tabCount > b.tabCount,
  },
  {
    id: "switch",
    title: "Switch tabs",
    instruction: "Move between tabs with ⌃Tab (or click one).",
    shortcut: "⌃⇥",
    target: "tab-strip",
    hint: "Click a different tab in the strip, or press ⌃Tab.",
    done: (b, c) => c.activeTabId !== b.activeTabId,
  },
  {
    id: "widget",
    title: "Add a widget",
    instruction: "Widgets show your stuff. Open the picker with ⌘⇧A and add one.",
    shortcut: "⌘⇧A",
    target: "board",
    hint: "⌘⇧A opens the widget picker. Pick anything — you can remove it later.",
    done: (b, c) => c.widgetCount > b.widgetCount,
  },
  {
    id: "settings",
    title: "Open settings",
    instruction: "Everything is configured in Settings. Open it with ⌘,.",
    shortcut: "⌘,",
    target: "settings",
    hint: "⌘, opens Settings, or click the gear. Connections and AI live there.",
    done: (_b, c) => c.view === "settings",
  },
  {
    id: "finish",
    title: "You're set 🎉",
    instruction: "That's the tour. Reopen it anytime from the Features Guide.",
    hint: "Click Finish. The guide (header ? or ⌘K) can replay this later.",
    done: advanceable,
  },
];

export function progress(index: number, total: number): { current: number; total: number } {
  return { current: index + 1, total };
}
