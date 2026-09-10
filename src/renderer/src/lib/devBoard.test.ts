import { describe, expect, it } from "vitest";
import { badge, containerTone, lsofCommand, nextInterval } from "./devBoard";

describe("badge", () => {
  it("never renders an unchecked row as healthy", () => {
    // The one lie this widget must not tell.
    const unknown = badge("unknown", null);
    expect(unknown.color).toBe("var(--ink-3)");
    expect(unknown.color).not.toBe("var(--ok)");
  });

  it("reads a busy server as busy rather than dead", () => {
    // A cold Next compile connects and then says nothing for fifteen seconds.
    const slow = badge("slow", null);
    expect(slow.label).toBe("busy");
    expect(slow.color).toBe("var(--warn)");
    expect(slow.title).toContain("compiling");
  });

  it("shows a latency when there is one and 'listening' when there is not", () => {
    expect(badge("up", 5).label).toBe("5ms");
    // Tier 1 only: it accepted a connection and was never asked for a reply.
    expect(badge("up", null).label).toBe("listening");
  });

  it("marks a refused connection down", () => {
    expect(badge("down", null).color).toBe("var(--err)");
  });
});

describe("nextInterval", () => {
  it("doubles after a slow scan and walks back as the machine recovers", () => {
    // 929ms measured at load average 17; 290ms measured idle.
    const backedOff = nextInterval(5000, 5000, 929);
    expect(backedOff).toBe(10_000);
    expect(nextInterval(5000, backedOff, 290)).toBe(5000);
  });

  it("stops at thirty seconds", () => {
    let interval = 5000;
    for (let i = 0; i < 10; i++) interval = nextInterval(5000, interval, 2000);
    expect(interval).toBe(30_000);
  });

  it("never polls faster than the user asked for", () => {
    expect(nextInterval(5000, 5000, 10)).toBe(5000);
  });

  it("leaves the middle band alone so the interval cannot oscillate", () => {
    expect(nextInterval(5000, 10_000, 500)).toBe(10_000);
  });

  it("honours a base above the ceiling rather than silently speeding it up", () => {
    // A widget set to refresh every minute means it.
    expect(nextInterval(60_000, 60_000, 10)).toBe(60_000);
  });
});

describe("lsofCommand", () => {
  it("builds the command for a real port", () => {
    expect(lsofCommand("3000")).toBe("sudo lsof -i :3000 -sTCP:LISTEN");
    expect(lsofCommand(" 8080 ")).toBe("sudo lsof -i :8080 -sTCP:LISTEN");
  });

  it("refuses anything that is not a port, because this gets pasted into a shell", () => {
    expect(lsofCommand("3000; rm -rf /")).toBeNull();
    expect(lsofCommand("")).toBeNull();
    expect(lsofCommand("abc")).toBeNull();
    expect(lsofCommand("0")).toBeNull();
    expect(lsofCommand("99999")).toBeNull();
  });
});

describe("containerTone", () => {
  it("separates stopped from unhealthy from fine", () => {
    expect(containerTone(false, false)).toBe("var(--ink-3)");
    expect(containerTone(true, true)).toBe("var(--warn)");
    expect(containerTone(true, false)).toBe("var(--ok)");
  });
});
