import { describe, expect, it } from "vitest";
import { fetchContext } from "./adapter";
import { MockAdapter } from "./mock";

describe("the mock source", () => {
  it("yields ten items scoped to the connection, mail run through the real scorer", async () => {
    const cx = fetchContext({ environmentId: "work", connection: { id: "mock-1", provider: "mock" } });
    const items = await new MockAdapter().fetch(cx);
    expect(items).toHaveLength(10);
    expect(
      items.every((i) => i.id.startsWith("mock-1:") && i.connectionId === "mock-1" && i.environmentId === "work" && i.source === "mock"),
    ).toBe(true);
    const kinds = items.map((i) => i.kind);
    expect(kinds.filter((k) => k === "pull_request")).toHaveLength(2);
    expect(kinds.filter((k) => k === "mail")).toHaveLength(2);
    expect(kinds.filter((k) => k === "mail_bulk")).toHaveLength(3);
    const first = items[0]!;
    expect(first.title).toBe("Normalize the Item model across adapters");
    expect(first.actions.map((a) => a.id)).toEqual(["comment", "open"]);
    expect(first.unread).toBe(true);
    // Reasons ride in refs so a wrong call is inspectable.
    const bulk = items.find((i) => i.kind === "mail_bulk")!;
    expect(bulk.refs.length).toBeGreaterThan(0);
    expect(bulk.body).toMatch(/^score -?\d+$/);
  });

  it("performs anything and says what it did", async () => {
    const cx = fetchContext({});
    const items = await new MockAdapter().fetch(cx);
    const out = await new MockAdapter().perform(cx, { action: "comment", item: items[0]!, input: "hi" });
    expect(out).toBe("mock: comment on Normalize the Item model across adapters (hi)");
    const none = await new MockAdapter().perform(cx, { action: "archive", item: items[0]!, input: null });
    expect(none).toBe("mock: archive on Normalize the Item model across adapters (no input)");
  });
});
