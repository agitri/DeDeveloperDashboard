import { beforeEach, describe, expect, it, vi } from "vitest";

const logged: Array<{ env: string; kind: string; meta: any }> = [];
vi.mock("../lib/ipc", () => ({
  ipc: {
    eventLog: (env: string, event: { kind: string; meta: unknown }) =>
      logged.push({ env, kind: event.kind, meta: event.meta }),
  },
}));

const { firstLoad, switchStarted } = await import("./timing");

const after = (ms: number) => new Promise((r) => setTimeout(r, ms));
const switches = () => logged.filter((e) => e.kind === "perf.switch");
const widgets = () => logged.filter((e) => e.kind === "perf.widget");

describe("tab switch timing", () => {
  beforeEach(() => {
    logged.length = 0;
  });

  it("closes on the last widget, not the first one to finish alone", async () => {
    // The failure this exists for: widget A mounts, loads and finishes before
    // widget B has even started. A count of outstanding loads reaches zero
    // there and would report the switch as over in 20ms.
    switchStarted("work", "tab-2");
    await firstLoad("clock", () => after(20));
    await after(50);
    await firstLoad("repos", () => after(120));

    expect(switches()).toHaveLength(0); // still settling
    await after(400);

    expect(switches()).toHaveLength(1);
    expect(switches()[0]!.meta.tab).toBe("tab-2");
    expect(switches()[0]!.meta.ms).toBeGreaterThanOrEqual(180);
    // And the settle wait itself is not billed to the switch.
    expect(switches()[0]!.meta.ms).toBeLessThan(300);
  });

  it("bills every widget, with its own cost and its offset into the switch", async () => {
    switchStarted("work", "tab-1");
    await Promise.all([firstLoad("items", () => after(30)), firstLoad("eol", () => after(90))]);
    await after(400);

    expect(widgets().map((e) => e.meta.widget).sort()).toEqual(["eol", "items"]);
    const eol = widgets().find((e) => e.meta.widget === "eol")!;
    expect(eol.meta.ms).toBeGreaterThanOrEqual(80);
    expect(eol.meta.sinceSwitch).toBeGreaterThanOrEqual(eol.meta.ms);
  });

  it("abandons a switch that is superseded before it settles", async () => {
    // Switching twice quickly must not report the first switch's duration, nor
    // fold a load it started into the second switch's numbers.
    switchStarted("work", "tab-1");
    const slow = firstLoad("repos", () => after(60));
    switchStarted("work", "tab-2");
    await slow;
    await firstLoad("items", () => after(20));
    await after(400);

    expect(switches().map((e) => e.meta.tab)).toEqual(["tab-2"]);
    expect(widgets().map((e) => e.meta.widget)).toEqual(["items"]);
  });

  it("ignores loads outside a switch", async () => {
    // A poll five seconds later is not a tab switch.
    await firstLoad("items", () => after(10));
    await after(400);
    expect(logged).toHaveLength(0);
  });
});
