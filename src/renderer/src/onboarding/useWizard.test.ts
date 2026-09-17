// The controller is a zustand store — driven directly via `.getState()`, no
// React render needed. `../lib/ipc` is mocked so `globalWizardSave` is a spy;
// `../state/store` is replaced with a tiny fake exposing exactly the surface
// `snapshotNow` reads (`global`, `tabs()`, `activeTab()`, `activeTabId`,
// `view`) plus `subscribe`, so a test can drive a "genuine transition" with a
// plain `setState` call. `../state/ui` is left real — it has no async work,
// and the module-level tour-replay listener it powers stays harmless as long
// as `tourRequested` is never set.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeTab {
  id: string;
  widgets: unknown[];
}

interface FakeStoreState {
  global: { environments: unknown[] } | null;
  activeTabId: string | null;
  view: string;
  tabsList: FakeTab[];
}

interface FakeStore {
  getState: () => {
    global: { environments: unknown[] } | null;
    activeTabId: string | null;
    view: string;
    tabs: () => FakeTab[];
    activeTab: () => FakeTab | null;
  };
  setState: (patch: Partial<FakeStoreState>) => void;
  subscribe: (fn: () => void) => () => void;
}

vi.mock("../state/store", () => {
  let state: FakeStoreState = {
    global: { environments: [{}] },
    activeTabId: "t1",
    view: "board",
    tabsList: [{ id: "t1", widgets: [] }],
  };
  const listeners = new Set<() => void>();
  const useStore: FakeStore = {
    getState: () => ({
      global: state.global,
      activeTabId: state.activeTabId,
      view: state.view,
      tabs: () => state.tabsList,
      activeTab: () => state.tabsList.find((t) => t.id === state.activeTabId) ?? null,
    }),
    setState: (patch) => {
      state = { ...state, ...patch };
      for (const fn of listeners) fn();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return { useStore };
});

const globalWizardSave = vi.fn(async (_completed: boolean, _step: number) => ({}) as never);
vi.mock("../lib/ipc", () => ({ ipc: { globalWizardSave } }));

const { useStore } = (await import("../state/store")) as unknown as { useStore: FakeStore };
const { useWizard } = await import("./useWizard");
const { STEPS } = await import("./steps");

// Comfortably above the controller's own REWARD_MS (900ms) without importing
// its private constant.
const REWARD_MS_UPPER_BOUND = 5_000;

const BASELINE: FakeStoreState = {
  global: { environments: [{}] },
  activeTabId: "t1",
  view: "board",
  tabsList: [{ id: "t1", widgets: [] }],
};

const idOf = (index: number) => STEPS[index]!.id;

describe("useWizard controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalWizardSave.mockClear();
    useStore.setState(BASELINE);
  });

  afterEach(() => {
    // Stop the tour so no leftover subscription/timer from one test's `start`
    // can fire into the next, then drop the fake clock entirely.
    useWizard.getState().exit();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not auto-advance a step already satisfied at its own baseline (welcome)", () => {
    useWizard.getState().start(0);
    expect(idOf(useWizard.getState().index)).toBe("welcome");

    // A store change happens while welcome is showing — welcome's `done` is
    // trivially true even at baseline, so this must never fire the reward.
    useStore.setState({ activeTabId: "t2" });
    vi.advanceTimersByTime(REWARD_MS_UPPER_BOUND);

    expect(useWizard.getState().index).toBe(0);
    expect(idOf(useWizard.getState().index)).toBe("welcome");
    expect(useWizard.getState().reward).toBe(false);
  });

  it("advances on a genuine transition, and persists (false, nextIndex)", () => {
    const environmentIndex = STEPS.findIndex((s) => s.id === "environment");
    useWizard.getState().start(environmentIndex);
    globalWizardSave.mockClear(); // drop the persist from `start` itself

    // A second environment appears — the real transition this step waits for.
    useStore.setState({ global: { environments: [{}, {}] } });
    vi.advanceTimersByTime(REWARD_MS_UPPER_BOUND);

    expect(idOf(useWizard.getState().index)).toBe("tab");
    expect(globalWizardSave).toHaveBeenCalledWith(false, environmentIndex + 1);
  });

  it("skipWhen auto-skips the switch step when tabCount < 2, landing on the next step", () => {
    const switchIndex = STEPS.findIndex((s) => s.id === "switch");
    useStore.setState({ tabsList: [{ id: "t1", widgets: [] }] }); // tabCount 1

    useWizard.getState().start(switchIndex);

    expect(idOf(useWizard.getState().index)).toBe("widget");
    expect(globalWizardSave).not.toHaveBeenCalledWith(false, switchIndex);
    expect(globalWizardSave).toHaveBeenCalledWith(false, switchIndex + 1);
  });

  it("does not skip the switch step once a second tab exists", () => {
    const switchIndex = STEPS.findIndex((s) => s.id === "switch");
    useStore.setState({
      tabsList: [
        { id: "t1", widgets: [] },
        { id: "t2", widgets: [] },
      ],
    });

    useWizard.getState().start(switchIndex);

    expect(idOf(useWizard.getState().index)).toBe("switch");
  });

  it("exit() persists globalWizardSave(true, STEPS.length) and stops the tour", () => {
    useWizard.getState().start(0);
    globalWizardSave.mockClear();

    useWizard.getState().exit();

    expect(globalWizardSave).toHaveBeenCalledWith(true, STEPS.length);
    expect(useWizard.getState().active).toBe(false);
  });

  it("cleans up on exit: a subsequent store change does not advance the (now inactive) tour", () => {
    const environmentIndex = STEPS.findIndex((s) => s.id === "environment");
    useWizard.getState().start(environmentIndex);
    useWizard.getState().exit();
    globalWizardSave.mockClear();

    // The same transition that would have completed the step, arriving after exit.
    useStore.setState({ global: { environments: [{}, {}] } });
    vi.advanceTimersByTime(REWARD_MS_UPPER_BOUND);

    expect(useWizard.getState().active).toBe(false);
    expect(useWizard.getState().reward).toBe(false);
    expect(globalWizardSave).not.toHaveBeenCalled();
  });
});
