import { describe, expect, it } from "vitest";
import { classify, kindFor, mailSignals } from "./signal";

const mail = (from: string, subject: string, extra: Partial<Parameters<typeof mailSignals>[0]> = {}) =>
  mailSignals({ from, subject, ...extra });

describe("signal", () => {
  it("a person writing to you is signal", () => {
    const v = classify(mail("Jordy <jordy@vanbeurden.nl>", "Thursday still ok?", { addressedDirectly: true }));
    expect(v.signal).toBe(true);
    expect(kindFor(v)).toBe("mail");
  });

  it("noreply senders are noise", () => {
    const v = classify(mail("noreply@github.com", "Your weekly summary"));
    expect(v.signal).toBe(false);
    expect(v.reasons.some((r) => r.startsWith("noise:sender-"))).toBe(true);
    expect(kindFor(v)).toBe("mail_bulk");
  });

  it("list-unsubscribe outweighs a human-looking address", () => {
    const v = classify(mail("Sarah from Acme <sarah@acme.io>", "A quick question, Rene", { headers: ["list-unsubscribe"], addressedDirectly: true }));
    expect(v.signal).toBe(false);
  });

  it("a thread you replied to stays signal even from a robot address", () => {
    const v = classify(mail("notifications@atlassian.net", "[JIRA] IO-412 updated", { repliedBefore: true, addressedDirectly: true }));
    expect(v.signal).toBe(true);
    expect(v.reasons).toContain("signal:in-my-thread");
  });

  it("build notifications are noise", () => {
    expect(classify(mail("ci@buildserver.example", "Build failed: main #4821")).signal).toBe(false);
  });

  it("cc-only mail from a person is not promoted", () => {
    const human = classify(mail("Kees <kees@example.com>", "notes from standup"));
    const direct = classify(mail("Kees <kees@example.com>", "notes from standup", { addressedDirectly: true }));
    expect(direct.score).toBeGreaterThan(human.score);
  });

  it("a freelancer's invoice mail from a real person survives", () => {
    // Regression: scored exactly 0 when the subject word weighed as much as a header.
    const v = classify(mail("Marjolein <m@rene-it.nl>", "Invoice question", { addressedDirectly: true }));
    expect(v.signal).toBe(true);
  });

  it("an actual automated receipt is still noise", () => {
    expect(classify(mail("receipts@shop.example", "Your receipt from Shop", { headers: ["list-unsubscribe"] })).signal).toBe(false);
  });

  it("reasons explain every verdict", () => {
    expect(classify(mail("newsletter@substack.com", "Weekly digest")).reasons.length).toBeGreaterThan(0);
  });
});
