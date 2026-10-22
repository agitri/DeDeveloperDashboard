import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Listener } from "./listen";
import { mayStop, refusalMessage, signal } from "./stop";

const listener = (port: number, pid: number | null, process: string): Listener => ({ port, address: "127.0.0.1", pid, process });

describe("the stop guard", () => {
  it("passes the same process on the same socket", () => {
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "node", [listener(3000, 4821, "node")])).toBeNull();
    // The name comparison ignores case, as the Rust's eq_ignore_ascii_case does.
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "Node", [listener(3000, 4821, "node")])).toBeNull();
  });

  it("refuses a recycled pid by name", () => {
    // The race this exists for: node exited, the PID came back as something
    // else entirely.
    const refusal = mayStop("tcp:127.0.0.1:3000", 4821, "node", [listener(3000, 4821, "postgres")])!;
    expect(refusal.kind).toBe("reused");
    // The refusal names what is there now.
    expect(refusalMessage(refusal)).toBe("declined: that port now belongs to postgres (pid 4821), not the process you clicked");
  });

  it("refuses a different pid on the same port", () => {
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "node", [listener(3000, 9999, "node")])!.kind).toBe("reused");
  });

  it("refuses a socket that is gone rather than signalling", () => {
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "node", [])).toEqual({ kind: "notListening" });
  });

  it("treats the same port in the other family as a different socket", () => {
    // Keyed by address and port, so [::1]:3000 never satisfies a guard drawn
    // for 127.0.0.1:3000.
    const v6 = { ...listener(3000, 4821, "node"), address: "::1" };
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "node", [v6])).toEqual({ kind: "notListening" });
  });

  it("refuses a nameless row before anything is enumerated", () => {
    // Checked first: with no name there is nothing to compare, so the guard
    // cannot run and must not be skipped.
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "  ", [listener(3000, 4821, "node")])).toEqual({ kind: "unnamed" });
  });

  it("refuses another user's socket", () => {
    expect(mayStop("tcp:127.0.0.1:3000", 4821, "node", [listener(3000, null, "")])).toEqual({ kind: "foreign" });
  });

  it("gives every refusal a sentence the widget can show as it stands", () => {
    expect(refusalMessage({ kind: "notListening" })).toBe("it already exited — nothing is on that port now");
    expect(refusalMessage({ kind: "foreign" })).toBe("not your process — DDD will not ask for privilege to stop it");
    expect(refusalMessage({ kind: "unnamed" })).toBe("no process name to verify against, so the reuse guard cannot run");
    for (const r of [
      { kind: "notListening" },
      { kind: "reused", now: "postgres (pid 1)" },
      { kind: "foreign" },
      { kind: "unnamed" },
    ] as const) {
      expect(refusalMessage(r).length).toBeGreaterThan(20);
    }
  });
});

describe("signalling", () => {
  it("sends SIGTERM to a process this test owns", async () => {
    const child = spawn("sleep", ["30"]);
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const ended = new Promise<string | null>((resolve) => child.once("exit", (_code, sig) => resolve(sig)));
    signal(child.pid!);
    expect(await ended).toBe("SIGTERM");
  }, 15_000);

  it("maps a refused signal to the sentence that says why", () => {
    const eperm = () => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    };
    expect(() => signal(1, "darwin", eperm)).toThrow("not your process — DDD will not ask for privilege to stop it");

    const esrch = () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    expect(() => signal(4821, "darwin", esrch)).toThrow("could not stop pid 4821: kill ESRCH");
  });

  it("offers nothing at all on Windows", () => {
    // `TerminateProcess` is SIGKILL-equivalent and `GenerateConsoleCtrlEvent`
    // does not cross sessions reliably, so offering the only available
    // primitive would quietly break the no-force rule.
    let killed = 0;
    expect(() => signal(4821, "win32", () => void killed++)).toThrow(
      "could not stop pid 4821: stopping a process is not offered on Windows: the only primitive available is a force kill",
    );
    expect(killed).toBe(0);
  });
});
