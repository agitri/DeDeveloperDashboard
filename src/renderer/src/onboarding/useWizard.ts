// The tour's controller: which step is active, whether the reward or the
// ~15s hint is showing, and the plumbing that watches the real stores for the
// action each step is waiting on.
//
// A zustand store rather than a plain React hook — like `useStore`/`useUi`,
// every other piece of shell state lives this way, and it is what lets
// anything (App's first-run trigger, a palette action, this file's own
// replay watcher) drive the tour with `useWizard.getState().start(...)`
// without needing the `<Wizard/>` component on the call stack.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import { progress, STEPS, type WizardSnapshot, type WizardStep } from "./steps";

/** How long an unattended step waits before the hint reveals itself. */
const HINT_DELAY_MS = 15_000;
/** How long the 🎉 shows before the step actually advances. */
const REWARD_MS = 900;

interface WizardController {
  active: boolean;
  index: number;
  step: WizardStep | null;
  showHint: boolean;
  reward: boolean;
  progress: { current: number; total: number };

  /** Begin (or resume) the tour at a step. Captures a fresh baseline there. */
  start(fromStep?: number): void;
  /** Move on without waiting for the action — used for both "Skip step" and
   *  the welcome/finish steps' "Next"/"Finish", which have no action to wait
   *  for in the first place. */
  skip(): void;
  /** End the tour. Persists `completed: true`, same as finishing normally, so
   *  it does not auto-reappear next launch — it stays reachable from the
   *  Features Guide. */
  exit(): void;
  /** Reveal the hint (and intensify the spotlight) right now. */
  showMe(): void;
}

function snapshotNow(): WizardSnapshot {
  const s = useStore.getState();
  return {
    envCount: s.global?.environments.length ?? 0,
    tabCount: s.tabs().length,
    widgetCount: s.activeTab()?.widgets.length ?? 0,
    activeTabId: s.activeTabId,
    view: s.view,
  };
}

// Subscriptions and timers are plumbing, not state a re-render should ever
// reflect — kept outside the store, one live set at a time.
let unsubscribes: Array<() => void> = [];
let hintTimer: ReturnType<typeof setTimeout> | undefined;
let rewardTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

function stopWatchingStep() {
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
  clearTimeout(hintTimer);
  clearInterval(pollTimer);
  pollTimer = undefined;
}

function armHintTimer() {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    useWizard.setState({ showHint: true });
  }, HINT_DELAY_MS);
}

/** Watch both stores for the one transition this step is waiting on. */
function watchStep(index: number, baseline: WizardSnapshot) {
  const step = STEPS[index];
  if (!step) return;
  // Load-bearing: welcome/finish are "done" even at their own baseline (the
  // user advances them with a click, not an action), so this is computed once
  // and never re-checked — without it, the step that just started would
  // immediately auto-advance.
  const alreadyTrueAtBaseline = step.done(baseline, baseline);
  const check = () => {
    if (alreadyTrueAtBaseline) return;
    if (step.done(baseline, snapshotNow())) celebrateThenAdvance(index);
  };
  // The store subscriptions are the fast path, but a short poll is the safety
  // net: a DO wizard that silently fails to notice the action the user just
  // performed is worse than a 400ms tick. `celebrateThenAdvance` tears
  // everything (subs + this poll) down on the first hit, so it never
  // double-fires.
  pollTimer = setInterval(check, 400);
  unsubscribes = [useStore.subscribe(check), useUi.subscribe(check)];
}

function celebrateThenAdvance(fromIndex: number) {
  // Stop listening immediately — the reward's own timer is what advances now,
  // not another store change arriving before it fires.
  stopWatchingStep();
  useWizard.setState({ reward: true });
  clearTimeout(rewardTimer);
  rewardTimer = setTimeout(() => {
    useWizard.setState({ reward: false });
    goTo(fromIndex + 1);
  }, REWARD_MS);
}

function goTo(nextIndex: number) {
  if (nextIndex >= STEPS.length) {
    stopWatchingStep();
    clearTimeout(rewardTimer);
    void ipc.globalWizardSave(true, STEPS.length);
    useWizard.setState({ active: false, reward: false, showHint: false });
    return;
  }
  const baseline = snapshotNow();
  // A step whose gate is already unsatisfiable at the moment it would begin
  // (e.g. "switch tabs" with only one tab) is never shown — same path as a
  // detected completion, but with no reward, since the user did nothing.
  if (STEPS[nextIndex]?.skipWhen?.(baseline)) {
    goTo(nextIndex + 1);
    return;
  }
  useWizard.setState({
    active: true,
    index: nextIndex,
    step: STEPS[nextIndex] ?? null,
    progress: progress(nextIndex, STEPS.length),
    showHint: false,
    reward: false,
  });
  // Fire-and-forget: a reload resumes at this step; a failure to persist here
  // must not block the tour itself.
  void ipc.globalWizardSave(false, nextIndex);
  armHintTimer();
  watchStep(nextIndex, baseline);
}

export const useWizard = create<WizardController>((set, get) => ({
  active: false,
  index: 0,
  step: null,
  showHint: false,
  reward: false,
  progress: progress(0, STEPS.length),

  start(fromStep = 0) {
    stopWatchingStep();
    clearTimeout(rewardTimer);
    const clamped = Math.min(Math.max(fromStep, 0), STEPS.length - 1);
    goTo(clamped);
  },

  skip() {
    if (!get().active) return;
    stopWatchingStep();
    clearTimeout(rewardTimer);
    goTo(get().index + 1);
  },

  exit() {
    stopWatchingStep();
    clearTimeout(rewardTimer);
    void ipc.globalWizardSave(true, STEPS.length);
    set({ active: false, reward: false, showHint: false });
  },

  showMe() {
    clearTimeout(hintTimer);
    set({ showHint: true });
  },
}));

// The replay trigger: anything (the command palette, the Features Guide, a
// future "restart tour" button) just calls `useUi.getState().requestTour()`.
// Owned here, once, so a second entry point never has to re-derive it.
useUi.subscribe((state) => {
  if (!state.tourRequested) return;
  // Cleared first: `start` below fires its own store updates, and clearing
  // afterwards would re-enter this listener while the new step's watcher is
  // already live, for no purpose.
  useUi.getState().clearTourRequest();
  useWizard.getState().start(0);
});
