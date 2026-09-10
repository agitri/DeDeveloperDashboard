import { beforeEach, describe, expect, it } from "vitest";

/**
 * `window.ddd` is what the preload provides; standing one up here exercises the
 * actual path a widget takes rather than a mock of `call`.
 */
const calls: Array<{ cmd: string; args: any }> = [];
const waiting: Array<(v: unknown) => void> = [];

(globalThis as any).window = globalThis;
(globalThis as any).ddd = {
  invoke: (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    return new Promise((resolve) => waiting.push(resolve));
  },
  on: () => () => {},
};

const { ipc } = await import("./ipc");

const settled = () => new Promise((r) => setTimeout(r, 0));
/** Answer everything outstanding, and let the `finally` that frees the key run. */
async function answer(value: unknown): Promise<void> {
  for (const resolve of waiting.splice(0)) resolve(value);
  await settled();
}

describe("one call per question", () => {
  beforeEach(async () => {
    await answer([]);
    calls.length = 0;
  });

  it("shares a read that two widgets ask for at the same time", async () => {
    // The board that motivated this: two projects widgets, doubled again by
    // StrictMode's double mount, asking the same question four times. Measured,
    // those four cost 481ms where one cost 124ms.
    const asked = [
      ipc.projectsList("work"),
      ipc.projectsList("work"),
      ipc.projectsList("work"),
      ipc.projectsList("work"),
    ];
    await settled();
    expect(calls).toHaveLength(1);

    await answer([{ id: "p1" }]);
    for (const a of await Promise.all(asked)) expect(a).toEqual([{ id: "p1" }]);
  });

  it("asks again once the shared call has settled — this is not a cache", async () => {
    void ipc.projectsList("work");
    await settled();
    await answer([]);

    void ipc.projectsList("work");
    await settled();
    expect(calls).toHaveLength(2);
  });

  it("keeps different questions apart", async () => {
    void ipc.projectsList("work");
    void ipc.projectsList("personal");
    void ipc.itemsQuery("work", {});
    await settled();
    expect(calls.map((c) => c.cmd)).toEqual(["projects_list", "projects_list", "items_query"]);
    expect(calls.map((c) => c.args.env)).toEqual(["work", "personal", "work"]);
  });

  it("never shares a write", async () => {
    // Two callers believing they each saved would be a correctness bug, not a
    // performance one — and `write_json` stages through one tmp path per file.
    const layout = { version: 1, groups: [], tabs: [] } as never;
    void ipc.layoutSave("work", layout);
    void ipc.layoutSave("work", layout);
    await settled();
    expect(calls.filter((c) => c.cmd === "layout_save")).toHaveLength(2);
  });
});
