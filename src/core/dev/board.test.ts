import net from "node:net";
import { describe, expect, it } from "vitest";
import type { DevContainer } from "./containers";
import type { Listener } from "./listen";
import {
  EPHEMERAL,
  MEMO_FLOOR_MS,
  Memo,
  devServerFilterFromJson,
  emptySnapshot,
  join,
  list,
  readMachine,
  type DevServerFilter,
  type KnownProject,
  type Snapshot,
} from "./board";
import type { Runner } from "./run";

const l = (address: string, port: number, pid: number | null, process: string): Listener => ({
  port,
  address,
  pid,
  process: pid === null ? "" : process,
});

const project = (path: string, id: string | null): KnownProject => ({ path, id, isRepoLink: false });

const container = (name: string, running: boolean, ports: number[]): DevContainer => ({
  name,
  // Compose names containers `<project>-<service>-<n>`, so this mirrors what a
  // real `docker ps` would report.
  project: name.split("-")[0]!,
  status: running ? "Up 2 hours" : "Exited (0)",
  running,
  unhealthy: false,
  ports,
});

/** The measured reality: a handful of dev servers among hundreds of listeners
 *  belonging to Spotify, Sonos, Chrome and Control Centre. */
const machine = (): Listener[] => [
  l("*", 3000, 81631, "node"),
  l("127.0.0.1", 8005, 25197, "symfony"),
  l("::1", 5199, 24845, "node"),
  l("*", 1900, 1378, "Spotify"),
  l("*", 5000, 1191, "ControlCenter"),
  l("*", 5353, 87611, "Google Chrome Helper"),
  l("*", 631, null, ""),
  l("*", 0, 1013, "sharingd"),
];

const known = (): KnownProject[] => [
  project("/Users/rene/Projects/vanbeurden", "p1"),
  project("/Users/rene/Projects/climate4u", null),
  project("/Users/rene/Projects/DDD", "p2"),
];

const cwds = (): Map<number, string> =>
  new Map([
    [81631, "/Users/rene/Projects/vanbeurden"],
    [25197, "/Users/rene/Projects/climate4u"],
    [24845, "/Users/rene/Projects/DDD"],
    // The noise has a working directory too — it is just never a project.
    [1378, "/"],
    [1191, "/"],
    [87611, "/"],
  ]);

const NO_CONTAINERS = new Map<string, DevContainer[]>();
const ALL: DevServerFilter = { knownOnly: false };

describe("the join", () => {
  it("is the filter", () => {
    // 311 listeners of which 237 are noise was the measurement that decided this
    // default. A dev server runs inside a project; Spotify does not.
    const out = join(machine(), cwds(), known(), NO_CONTAINERS, {});
    // Ordered by port, which is how anyone hunting one reads the board.
    expect(out.rows.map((r) => r.projectName)).toEqual(["vanbeurden", "DDD", "climate4u"]);
    expect(out.rows.map((r) => r.port)).toEqual([3000, 5199, 8005]);
  });

  it("counts what is hidden rather than silently eating it", () => {
    const out = join(machine(), cwds(), known(), NO_CONTAINERS, {});
    // Spotify, ControlCenter, Chrome and the foreign socket — port 0 is not
    // counted, because it was never a candidate.
    expect(out.hidden).toBe(4);
    expect(out.foreignCount).toBe(1);
  });

  it("never makes a row of port zero, even showing everything", () => {
    // It appears in the table for sockets bound without a port. Nothing can
    // connect to it and it is pure noise.
    const out = join(machine(), cwds(), known(), NO_CONTAINERS, ALL);
    expect(out.rows.every((r) => r.port !== 0)).toBe(true);
    expect(out.rows).toHaveLength(7);
    expect(out.hidden).toBe(0);
  });

  it("keeps a v6 row's family and gives it a row of its own", () => {
    const ddd = join(machine(), cwds(), known(), NO_CONTAINERS, {}).rows.find((r) => r.port === 5199)!;
    expect(ddd.family).toBe("v6");
    expect(ddd.key).toBe("tcp:::1:5199");
    // The URL offered to a human is localhost; the probe target is not.
    expect(ddd.url).toBe("http://localhost:5199");
  });

  it("rolls a monorepo server up to its nearest project, and says that it did", () => {
    const dirs = cwds();
    dirs.set(81631, "/Users/rene/Projects/vanbeurden/packages/web");
    const out = join(machine(), dirs, known(), NO_CONTAINERS, {});
    expect(out.rows.find((r) => r.port === 3000)!.projectName).toBe("vanbeurden");
    expect(out.rows.find((r) => r.port === 3000)!.matchedAncestor).toBe(true);
    expect(out.rows.find((r) => r.port === 8005)!.matchedAncestor).toBe(false);
  });

  it("lets a nested project win over its parent", () => {
    // Longest match, so a project inside another is attributed to the nearer one
    // rather than swallowed by the outer.
    const out = join(
      [l("*", 3000, 81631, "node")],
      new Map([[81631, "/Users/rene/Projects/vanbeurden"]]),
      [project("/Users/rene/Projects", null), project("/Users/rene/Projects/vanbeurden", "p1")],
      NO_CONTAINERS,
      {},
    );
    expect(out.rows[0]!.projectId).toBe("p1");
  });

  it("does not treat a sibling directory as a prefix match", () => {
    // "/p/app" must not claim "/p/app-legacy". String prefixing without the
    // separator is the classic way this goes wrong.
    const out = join([l("*", 3000, 1, "node")], new Map([[1, "/p/app-legacy"]]), [project("/p/app", "p1")], NO_CONTAINERS, {});
    expect(out.rows).toEqual([]);
  });

  it("carries a project row's containers", () => {
    // The drill-down: the server on 8005 expands into what it talks to.
    const byDir = new Map([["/Users/rene/Projects/climate4u", [container("climate4u-database-1", true, [5433])]]]);
    const out = join(machine(), cwds(), known(), byDir, {});
    expect(out.rows.find((r) => r.port === 8005)!.containers.map((c) => c.name)).toEqual(["climate4u-database-1"]);
    // A project with no containers gets an empty list, not a missing field.
    expect(out.rows.find((r) => r.port === 3000)!.containers).toEqual([]);
  });

  it("attributes a docker-published port by which compose file published it", () => {
    // The daemon's cwd is Docker's own, never a project, so the port itself has
    // to do the attributing.
    const byDir = new Map([["/Users/rene/Projects/climate4u", [container("climate4u-database-1", true, [5433])]]]);
    const out = join([l("*", 5433, 79631, "com.docker.backend")], new Map(), known(), byDir, {});
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.projectName).toBe("climate4u");
    expect(out.rows[0]!.docker).toBe(true);
  });

  it("never gives a docker row a url to probe", () => {
    // Shown because it answers "what has 5432"; never probed, because a
    // dashboard must not send HEAD / to Postgres on a timer.
    const byDir = new Map([["/p", [container("db-1", true, [5432])]]]);
    const out = join([l("*", 5432, 1, "com.docker.backend")], new Map(), [project("/p", null)], byDir, {});
    expect(out.rows[0]!.url).toBeNull();
  });

  it("does not let a stopped container claim a port", () => {
    const byDir = new Map([["/p", [container("db-1", false, [5432])]]]);
    const out = join([l("*", 5432, 1, "com.docker.backend")], new Map(), [project("/p", null)], byDir, ALL);
    expect(out.rows[0]!.projectName).toBeNull();
  });

  it("names a docker row by its compose project, not its directory", () => {
    // The real case from this machine: a compose file in
    // `…/onderwijscatalogus/backend` publishes 8062. The directory's basename is
    // "backend", which matches nothing the user sees in `docker ps`.
    const dir = "/Users/rene/Projects/onderwijscatalogus/backend";
    const byDir = new Map([[dir, [container("onderwijscatalogus-nginx-1", true, [8062])]]]);
    const out = join([l("*", 8062, 1, "com.docker.backend")], new Map(), [project(dir, null)], byDir, {});
    expect(out.rows[0]!.projectName).toBe("onderwijscatalogus");
  });

  it("lets a registered project keep its own name even with containers", () => {
    // The registry is the user's own naming. Compose does not get to overrule
    // it — only to fill in where there is nothing.
    const byDir = new Map([["/Users/rene/Projects/climate4u", [container("c4u-database-1", true, [5433])]]]);
    const out = join(machine(), cwds(), known(), byDir, {});
    expect(out.rows.find((r) => r.port === 8005)!.projectName).toBe("climate4u");
  });

  it("never gives a foreign socket a project or a url", () => {
    const foreign = join(machine(), cwds(), known(), NO_CONTAINERS, ALL).rows.find((r) => r.foreign)!;
    expect(foreign.projectName).toBeNull();
    expect(foreign.url).toBeNull();
    expect(foreign.pid).toBeNull();
    expect(foreign.process).toBeNull();
  });

  it("never births a row healthy", () => {
    // Unknown until probed. Claiming health because nobody asked is the one lie
    // this widget must not tell.
    const out = join(machine(), cwds(), known(), NO_CONTAINERS, {});
    expect(out.rows.every((r) => r.health === "unknown" && r.latencyMs === null && r.checkedAt === null)).toBe(true);
  });

  it("searches port, process and project", () => {
    for (const [query, port] of [
      ["8005", 8005],
      ["symfony", 8005],
      ["climate", 8005],
      ["NODE", 3000],
    ] as const) {
      const out = join(machine(), cwds(), known(), NO_CONTAINERS, { query });
      expect(out.rows.map((r) => r.port)).toContain(port);
    }
    expect(join(machine(), cwds(), known(), NO_CONTAINERS, { query: "symfony" }).rows).toHaveLength(1);
  });

  it("collapses a forked pool into one server rather than four rows", () => {
    // php-fpm workers and a JVM's children inherit the parent's listening
    // socket, so the OS reports one row per process. Measured on this machine:
    // 16 rows collapse.
    const out = join(
      [l("127.0.0.1", 8005, 100, "php-fpm"), l("127.0.0.1", 8005, 101, "php-fpm"), l("127.0.0.1", 8005, 102, "php-fpm")],
      new Map([
        [100, "/p"],
        [101, "/p"],
        [102, "/p"],
      ]),
      [project("/p", null)],
      NO_CONTAINERS,
      {},
    );
    expect(out.rows).toHaveLength(1);
    // The first process on the socket represents it; the others are counted,
    // not discarded.
    expect(out.rows[0]!.pid).toBe(100);
    expect(out.rows[0]!.workers).toBe(2);
  });

  it("keeps the same port in two families as two rows", () => {
    // Deduplication is by socket, and 127.0.0.1:8000 and [::1]:8000 are two
    // sockets with two processes. Collapsing them would hide one.
    const out = join(
      [l("127.0.0.1", 8000, 1, "node"), l("::1", 8000, 2, "node")],
      new Map([
        [1, "/p"],
        [2, "/p"],
      ]),
      [project("/p", null)],
      NO_CONTAINERS,
      {},
    );
    expect(out.rows).toHaveLength(2);
    expect(out.rows.every((r) => r.workers === 0)).toBe(true);
  });

  it("does not call a kernel-assigned port a dev server, but brings it back when asked", () => {
    // 142 of this machine's rows sit at or above 49152: PhpStorm helpers, junie,
    // and the php-fpm workers behind a symfony server. Every one of the 21 below
    // it was real. Nobody types localhost:62662.
    const listeners = [l("127.0.0.1", 8005, 1, "symfony"), l("127.0.0.1", 62662, 2, "php-fpm")];
    const dirs = new Map([
      [1, "/p"],
      [2, "/p"],
    ]);
    const out = join(listeners, dirs, [project("/p", null)], NO_CONTAINERS, {});
    expect(out.rows.map((r) => r.port)).toEqual([8005]);
    expect(out.hidden).toBe(1);

    const all = join(listeners, dirs, [project("/p", null)], NO_CONTAINERS, { ephemeral: true });
    expect(all.rows).toHaveLength(2);
  });

  it("puts the boundary where the IANA range starts", () => {
    for (const [port, shown] of [
      [49151, 1],
      [EPHEMERAL, 0],
    ] as const) {
      const out = join([l("127.0.0.1", port, 1, "node")], new Map([[1, "/p"]]), [project("/p", null)], NO_CONTAINERS, {});
      expect(out.rows).toHaveLength(shown);
    }
  });

  it("marks a repo-link match with its path and leaves a registry-only match without one", () => {
    const out = join(
      [l("127.0.0.1", 8005, 1, "symfony"), l("127.0.0.1", 8006, 2, "symfony")],
      new Map([
        [1, "/p/linked"],
        [2, "/p/registered"],
      ]),
      [{ path: "/p/linked", id: null, isRepoLink: true }, project("/p/registered", "p9")],
      NO_CONTAINERS,
      {},
    );
    expect(out.rows[0]!.repoPath).toBe("/p/linked");
    expect(out.rows[0]!.projectId).toBeNull();
    expect(out.rows[1]!.repoPath).toBeNull();
    expect(out.rows[1]!.projectId).toBe("p9");
  });
});

describe("the filter shape", () => {
  it("keeps only what is present", () => {
    expect(devServerFilterFromJson({})).toEqual({});
    expect(devServerFilterFromJson({ knownOnly: false, query: "node", http: ["node"], ephemeral: true, probe: true })).toEqual({
      knownOnly: false,
      query: "node",
      http: ["node"],
      ephemeral: true,
      probe: true,
    });
    expect(devServerFilterFromJson({ query: null })).toEqual({});
  });

  it("refuses a malformed filter", () => {
    expect(() => devServerFilterFromJson({ knownOnly: "yes" })).toThrow(/^json: /);
    expect(() => devServerFilterFromJson({ http: "node" })).toThrow(/^json: /);
    expect(() => devServerFilterFromJson({ http: [1] })).toThrow(/^json: /);
    expect(() => devServerFilterFromJson("nope")).toThrow(/^json: /);
  });
});

describe("the memo", () => {
  const counting = (reads: { n: number }) => async (): Promise<Snapshot> => {
    reads.n += 1;
    return { ...emptySnapshot(), scanMs: 7 };
  };

  it("reads the machine once for two calls inside the floor", async () => {
    // Two widgets on one board, or a manual refresh landing on a poll, must not
    // mean two lsof calls and two docker ps.
    const reads = { n: 0 };
    const memo = new Memo();
    const first = await memo.get(1_000, MEMO_FLOOR_MS, counting(reads));
    const second = await memo.get(1_500, MEMO_FLOOR_MS, counting(reads));
    expect(reads.n).toBe(1);
    // The cached read is handed back whole.
    expect(second.scanMs).toBe(first.scanMs);
  });

  it("reads again outside the floor", async () => {
    const reads = { n: 0 };
    const memo = new Memo();
    await memo.get(1_000, MEMO_FLOOR_MS, counting(reads));
    await memo.get(1_000 + MEMO_FLOOR_MS, MEMO_FLOOR_MS, counting(reads));
    // The floor must not make the board stale.
    expect(reads.n).toBe(2);
  });

  it("makes a second caller wait for the read already in flight rather than starting its own", async () => {
    const reads = { n: 0 };
    const memo = new Memo();
    const slow = async (): Promise<Snapshot> => {
      reads.n += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ...emptySnapshot(), scanMs: 20 };
    };
    const [a, b] = await Promise.all([memo.get(1_000, MEMO_FLOOR_MS, slow), memo.get(1_001, MEMO_FLOOR_MS, slow)]);
    expect(reads.n).toBe(1);
    expect(a).toBe(b);
  });
});

describe("reading the machine", () => {
  it("asks lsof for listeners, lsof for their working directories, and docker once", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (file, args) => {
      calls.push([file, ...args]);
      if (file === "docker") return { stdout: "/p\tapi-1\tUp\t\n", ok: true };
      if (args.includes("-d")) return { stdout: "p1\nn/p\n", ok: true };
      return { stdout: "p1\ncnode\nf8\nn127.0.0.1:3000\n", ok: true };
    };
    const snapshot = await readMachine(runner, "darwin");
    expect(calls.map((c) => c[0])).toEqual(["lsof", "lsof", "docker"]);
    expect(snapshot.listeners).toEqual([{ port: 3000, address: "127.0.0.1", pid: 1, process: "node" }]);
    expect(snapshot.cwds.get(1)).toBe("/p");
    expect(snapshot.containers.get("/p")).toHaveLength(1);
    expect(typeof snapshot.scanMs).toBe("number");
  });
});

describe("listing, including the probe pass", () => {
  const snapshot = (): Snapshot => ({ listeners: machine(), cwds: cwds(), containers: NO_CONTAINERS, scanMs: 42 });

  it("does no socket work on the first paint", async () => {
    // probe defaults false: rows appear before anything is dialled.
    const out = await list(snapshot(), known(), {});
    expect(out.rows.every((r) => r.health === "unknown" && r.checkedAt === null)).toBe(true);
    expect(out.partial).toBe(false);
    // The scan cost is reported, not invented.
    expect(out.scanMs).toBe(42);
  });

  it("reaches a real socket and reports the others down", async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const snap: Snapshot = {
        // Not in the HTTP allowlist on purpose: this test is about the connect
        // tier reaching the right rows, and tier 2 against a listener that never
        // accepts is `slow` by design.
        listeners: [l("127.0.0.1", port, 1, "myserver"), l("127.0.0.1", 1, 2, "myserver")],
        cwds: new Map([
          [1, "/p"],
          [2, "/p"],
        ]),
        containers: NO_CONTAINERS,
        scanMs: 1,
      };
      // A kernel-assigned port is exactly what bind(:0) hands back, so this test
      // has to ask for the range it is testing in.
      const out = await list(snap, [project("/p", "p1")], { probe: true, ephemeral: true });
      const live = out.rows.find((r) => r.port === port)!;
      expect(live.health).toBe("up");
      // A verdict carries when it was reached.
      expect(Number.isNaN(Date.parse(live.checkedAt!))).toBe(false);
      expect(out.rows.find((r) => r.port === 1)!.health).toBe("down");
      expect(out.partial).toBe(false);
    } finally {
      server.close();
    }
  }, 15_000);

  it("never dials a docker row, even when probing", async () => {
    // The rule stated once in join as "no url" and again here as "no packet".
    const byDir = new Map([["/p", [container("db-1", true, [5432])]]]);
    const snap: Snapshot = {
      listeners: [l("127.0.0.1", 5432, 1, "com.docker.backend")],
      cwds: new Map(),
      containers: byDir,
      scanMs: 1,
    };
    const out = await list(snap, [project("/p", null)], { probe: true });
    // Nothing is on 5432 here, so a probe would have said "down" — staying
    // unknown is the evidence that no packet was sent.
    expect(out.rows[0]!.health).toBe("unknown");
    expect(out.rows[0]!.checkedAt).toBeNull();
  });

  it("never dials a foreign socket", async () => {
    const snap: Snapshot = { listeners: [l("127.0.0.1", 1, null, "")], cwds: new Map(), containers: NO_CONTAINERS, scanMs: 1 };
    const out = await list(snap, [], { probe: true, knownOnly: false });
    expect(out.rows[0]!.health).toBe("unknown");
  });

  it("marks a listing partial when the probe batch came back short", async () => {
    // Nothing resolved, so every row keeps `unknown` and gets another chance
    // next cycle — never a fabricated verdict.
    const snap: Snapshot = {
      listeners: [l("127.0.0.1", 8005, 1, "symfony")],
      cwds: new Map([[1, "/p"]]),
      containers: NO_CONTAINERS,
      scanMs: 1,
    };
    const out = await list(snap, [project("/p", null)], { probe: true }, async () => new Map());
    expect(out.partial).toBe(true);
    expect(out.rows[0]!.health).toBe("unknown");
  });
});
