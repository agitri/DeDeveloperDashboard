import { describe, expect, it } from "vitest";
import { enumerate, family, foreign, key, normalizeAddress, order, parseLsof, parseNetstat, type Listener } from "./listen";
import type { Runner } from "./run";

/** Real `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` output from a Mac: `f` lines
 *  appear even though only `pcn` was asked for, and a dual-stack bind is
 *  reported once per file descriptor. */
const LSOF = [
  "p958",
  "crapportd",
  "f8",
  "n*:59527",
  "f9",
  "n*:59527",
  "p1191",
  "cControlCenter",
  "f8",
  "n*:7000",
  "f10",
  "n0.0.0.0:5000",
  "p24845",
  "cnode",
  "f21",
  "n[::1]:5199",
  "p25197",
  "csymfony",
  "f16",
  "n127.0.0.1:8005",
  "p6756",
  "cphp-fpm",
  "f16",
  "n127.0.0.1:64639",
  "",
].join("\n");

/** Real `netstat -ano` output, header and all. */
const NETSTAT = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044",
  "  TCP    127.0.0.1:5199         0.0.0.0:0              LISTENING       17532",
  "  TCP    [::]:135               [::]:0                 LISTENING       1044",
  "  TCP    127.0.0.1:49670        127.0.0.1:49671        ESTABLISHED     9612",
  "  UDP    0.0.0.0:5353           *:*                                    3444",
  "",
].join("\n");

function fixture(stdout: string, ok = true): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout, ok };
  };
  return { runner, calls };
}

const listener = (address: string, port: number, pid: number | null): Listener => ({
  port,
  address,
  pid,
  process: pid === null ? "" : "node",
});

describe("a listener", () => {
  it("is identified by address and port, so two families on one port are two rows", () => {
    // The reason identity is address+port. These are two processes, and a
    // port-keyed list would collapse them and lose one.
    expect(key(listener("127.0.0.1", 8000, 1))).toBe("tcp:127.0.0.1:8000");
    expect(key(listener("::1", 8000, 2))).toBe("tcp:::1:8000");
    expect(key(listener("127.0.0.1", 8000, 1))).not.toBe(key(listener("::1", 8000, 2)));
  });

  it("reads its family from the bound address", () => {
    expect(family(listener("::1", 5199, 1))).toBe("v6");
    expect(family(listener("127.0.0.1", 8000, 1))).toBe("v4");
    // A wildcard has a colon in neither spelling we normalise it to.
    expect(family(listener("*", 3000, 1))).toBe("v4");
  });

  it("is foreign when it has no pid", () => {
    // Another UID's. Not ours to probe, project or stop — and no permission
    // exists that would change that.
    expect(foreign(listener("*", 631, null))).toBe(true);
    expect(foreign(listener("*", 3000, 42))).toBe(false);
  });

  it("normalises every spelling of a wildcard to one", () => {
    expect(normalizeAddress("0.0.0.0")).toBe("*");
    expect(normalizeAddress("::")).toBe("*");
    expect(normalizeAddress("[::]")).toBe("*");
    expect(normalizeAddress("*")).toBe("*");
    expect(normalizeAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeAddress("::1")).toBe("::1");
    expect(normalizeAddress("[::1]")).toBe("::1");
  });
});

describe("parsing lsof's machine-readable form", () => {
  it("reads a listener per n line, carrying the pid and command down from the p and c lines", () => {
    const found = parseLsof(LSOF);
    expect(found.filter((l) => l.port === 8005)).toEqual([{ port: 8005, address: "127.0.0.1", pid: 25197, process: "symfony" }]);
    expect(found.find((l) => l.port === 5199)).toEqual({ port: 5199, address: "::1", pid: 24845, process: "node" });
    // f lines are emitted even though only `pcn` was asked for.
    expect(found.every((l) => l.pid !== null)).toBe(true);
  });

  it("drops a path with no pid before it rather than guessing an association", () => {
    expect(parseLsof("n*:3000\n")).toEqual([]);
  });

  it("ignores what it cannot read as a socket", () => {
    expect(parseLsof("p1\ncnode\nn*:*\nn127.0.0.1\nnfoo:bar\n")).toEqual([]);
    // An established socket would carry an arrow; -sTCP:LISTEN should already
    // have excluded it, and this is the belt to that braces.
    expect(parseLsof("p1\ncnode\nn127.0.0.1:8005->127.0.0.1:9\n")).toEqual([]);
  });
});

describe("parsing netstat", () => {
  it("takes only TCP rows in LISTENING, with the pid from the last column", () => {
    const found = parseNetstat(NETSTAT);
    expect(found).toEqual([
      { port: 135, address: "*", pid: 1044, process: "" },
      { port: 5199, address: "127.0.0.1", pid: 17532, process: "" },
      { port: 135, address: "*", pid: 1044, process: "" },
    ]);
    // netstat never names the process, and inventing one would be worse.
    expect(found.every((l) => l.process === "")).toBe(true);
  });
});

describe("enumerate", () => {
  it("runs lsof on a Mac, sorted by port then address, with duplicates collapsed", async () => {
    const { runner, calls } = fixture(LSOF);
    const found = await enumerate(runner, "darwin");
    expect(calls).toEqual([["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"]]);
    expect(found.map((l) => l.port)).toEqual([5000, 5199, 7000, 8005, 59527, 64639]);
    // The same socket reported on two descriptors is one socket.
    expect(found.filter((l) => l.port === 59527)).toHaveLength(1);
    expect(found.find((l) => l.port === 5000)!.address).toBe("*");
  });

  it("runs netstat on Windows and collapses a dual-stack bind", async () => {
    const { runner, calls } = fixture(NETSTAT);
    const found = await enumerate(runner, "win32");
    expect(calls).toEqual([["netstat", "-ano"]]);
    // 0.0.0.0:135 and [::]:135 normalise to the same socket under the same pid.
    expect(found).toEqual([
      { port: 135, address: "*", pid: 1044, process: "" },
      { port: 5199, address: "127.0.0.1", pid: 17532, process: "" },
    ]);
  });

  it("finds nothing rather than throwing when the tool is not there", async () => {
    const { runner } = fixture("", false);
    expect(await enumerate(runner, "darwin")).toEqual([]);
  });

  it("keeps rows with the same port and different processes — a forked pool is collapsed later, not here", () => {
    const pool = order([
      { port: 8005, address: "127.0.0.1", pid: 102, process: "php-fpm" },
      { port: 8005, address: "127.0.0.1", pid: 100, process: "php-fpm" },
      { port: 8005, address: "127.0.0.1", pid: 100, process: "php-fpm" },
    ]);
    expect(pool.map((l) => l.pid)).toEqual([102, 100]);
  });

  it("never throws against this machine, and comes back ordered", async () => {
    // Runs against the real machine: whatever is or is not listening, this
    // must return and must be sorted, because an unstable order reshuffles the
    // board under the user's cursor on every refresh.
    const found = await enumerate();
    const sorted = [...found].sort(
      (a, b) =>
        a.port - b.port ||
        (a.address < b.address ? -1
        : a.address > b.address ? 1
        : 0),
    );
    expect(found).toEqual(sorted);
  }, 30_000);
});
