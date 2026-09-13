import { describe, expect, it } from "vitest";
import { fetchContext, itemId, refuse, requireConfig } from "./adapter";
import { forProvider } from "./providers";

describe("the adapter port", () => {
  it("builds collision-proof item ids from the connection", () => {
    expect(itemId("work-gh", "agitri/ddd#142")).toBe("work-gh:agitri/ddd#142");
  });

  it("resolves the providers this phase has, and nothing else", () => {
    expect(forProvider("github")?.source).toBe("github");
    expect(forProvider("mock")?.source).toBe("mock");
    expect(forProvider("jira")?.source).toBe("jira");
    expect(forProvider("slack")?.source).toBe("slack");
    expect(forProvider("mail.gmail")?.source).toBe("google");
    expect(forProvider("mail.imap")?.source).toBe("mail.imap");
    expect(forProvider("nope")).toBeNull();
  });

  it("requires connection config with the Rust's sentence", () => {
    const cx = fetchContext({ connection: { label: "rene@rene-it.nl", config: { site: "https://x" } } });
    expect(requireConfig(cx, "site")).toBe("https://x");
    expect(() => requireConfig(cx, "email")).toThrow("email is not set for rene@rene-it.nl");
    const blank = fetchContext({ connection: { label: "l", config: { site: "" } } });
    expect(() => requireConfig(blank, "site")).toThrow("site is not set for l");
  });

  it("refuses politely by default", () => {
    expect(() => refuse("github", "dance")).toThrow("github cannot dance");
  });
});
