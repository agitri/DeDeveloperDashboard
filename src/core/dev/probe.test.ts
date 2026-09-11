import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HTTP_PROCESSES, browserUrl, batch, classify, httpRequest, run, speaksHttp, target } from "./probe";

/** A server this test owns. `answer` is what it writes back, if anything. */
function listening(host: string, answer: string | null): Promise<{ port: number; seen: string[]; close: () => void }> {
  const sockets: net.Socket[] = [];
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    // Replies only once it has been asked, so `seen` is always populated before
    // the client sees a byte — no race between the two assertions.
    socket.on("data", (chunk) => {
      seen.push(chunk.toString());
      if (answer !== null) socket.write(answer);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        seen,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

const closing: (() => void)[] = [];
afterEach(() => {
  while (closing.length > 0) closing.pop()!();
});

async function server(host: string, answer: string | null) {
  const s = await listening(host, answer);
  closing.push(s.close);
  return s;
}

describe("classifying a probe", () => {
  it("calls a timeout slow and never down", () => {
    // The rule the whole widget rests on. A cold Next compile takes fifteen
    // seconds; reporting it dead would tell you to kill what you are waiting for.
    expect(classify(true, null).health).toBe("slow");
    expect(classify(true, 1400).health).toBe("slow");
  });

  it("calls only a refused connect down", () => {
    expect(classify(false, null)).toEqual({ health: "down", latencyMs: null });
  });

  it("puts the measured values where they were intended", () => {
    // 5ms symfony and 978ms next-server, the two real measurements the boundary
    // was chosen between.
    expect(classify(true, 5)).toEqual({ health: "up", latencyMs: 5 });
    expect(classify(true, 978).health).toBe("slow");
    expect(classify(true, 249).health).toBe("up");
    expect(classify(true, 250).health).toBe("slow");
  });

  it("never returns unknown — there is no path from `not probed` to a verdict", () => {
    // Claiming a server is healthy because nobody asked is the one lie this
    // widget must not tell, so `unknown` is only ever the initial value.
    for (const p of [classify(false, null), classify(true, null), classify(true, 5)]) {
      expect(p.health).not.toBe("unknown");
    }
  });
});

describe("choosing what to dial", () => {
  it("probes a v6 bind on v6", () => {
    // The bug that was actually hit: DDD's own dev server binds [::1]:5199 and
    // an IPv4 probe reports it dead.
    expect(target("::1", 5199)).toEqual({ host: "::1", port: 5199 });
    expect(target("[::1]", 5199).host).toBe("::1");
    // A v6 wildcard answers on ::1.
    expect(target("::", 5199).host).toBe("::1");
    expect(target("[::]", 5199).host).toBe("::1");
  });

  it("probes a v4 bind on v4", () => {
    expect(target("127.0.0.1", 8000).host).toBe("127.0.0.1");
    expect(target("0.0.0.0", 8000).host).toBe("127.0.0.1");
    expect(target("*", 8000).host).toBe("127.0.0.1");
  });

  it("probes a specific address verbatim, and never a name", () => {
    expect(target("192.168.1.10", 80).host).toBe("192.168.1.10");
    // `localhost` resolves through the system resolver, whose family preference
    // is not ours to predict — a name would make the family bug intermittent
    // rather than fixed.
    expect(target("localhost", 80).host).toBe("127.0.0.1");
  });

  it("offers a browser url that is deliberately not the probe target", () => {
    expect(browserUrl("::1", 5199)).toBe("http://localhost:5199");
    expect(browserUrl("127.0.0.1", 8000)).toBe("http://localhost:8000");
    expect(browserUrl("*", 3000)).toBe("http://localhost:3000");
    // A real bound address stays itself, bracketed when it must be.
    expect(browserUrl("192.168.1.10", 80)).toBe("http://192.168.1.10:80");
    expect(browserUrl("fe80::1", 8080)).toBe("http://[fe80::1]:8080");
  });
});

describe("the http allowlist", () => {
  it("is the bundled list, verbatim", () => {
    expect(HTTP_PROCESSES).toEqual([
      "node", "next-server", "next", "vite", "esbuild", "webpack", "bun", "deno",
      "symfony", "php", "php-fpm", "caddy", "nginx", "httpd", "traefik",
      "python", "python3", "gunicorn", "uvicorn", "flask", "django",
      "ruby", "rails", "puma", "cargo", "rustc", "dotnet", "java", "gradle",
    ]);
  });

  it("sends http bytes only to processes it vouches for", () => {
    expect(speaksHttp("next-server", [])).toBe(true);
    expect(speaksHttp("Python", [])).toBe(true);
    // The point of the allowlist: a database must never be sent HEAD /.
    expect(speaksHttp("postgres", [])).toBe(false);
    expect(speaksHttp("mysqld", [])).toBe(false);
    expect(speaksHttp("redis-server", [])).toBe(false);
    // Another UID's socket has no process name at all.
    expect(speaksHttp(null, [])).toBe(false);
    expect(speaksHttp("", [])).toBe(false);
  });

  it("lets a widget's own allowlist replace the default", () => {
    expect(speaksHttp("postgres", ["postgres"])).toBe(true);
    expect(speaksHttp("next-server", ["postgres"])).toBe(false);
  });
});

describe("the transport, against sockets this test owns", () => {
  it("connects to a socket that exists and calls a closed port down", async () => {
    const s = await server("127.0.0.1", null);
    // Tier 1 only: it accepted, and we asked it nothing.
    expect(await run({ host: "127.0.0.1", port: s.port }, false, 500)).toEqual({ health: "up", latencyMs: null });

    // Port 1 rather than a freed ephemeral one: the kernel hands those straight
    // to the next thing that binds :0, which in a parallel run is another test.
    expect((await run({ host: "127.0.0.1", port: 1 }, false, 500)).health).toBe("down");
  });

  it("calls a listener that accepts but never answers slow, not down", async () => {
    // Twenty lines of compiling Next.js. The kernel completes the handshake and
    // the process says nothing.
    const s = await server("127.0.0.1", null);
    const probe = await run({ host: "127.0.0.1", port: s.port }, true, 300);
    expect(probe).toEqual({ health: "slow", latencyMs: null });
  });

  it("times a server that answers, and sends exactly the bytes the Rust sends", async () => {
    const s = await server("127.0.0.1", "HTTP/1.0 200 OK\r\n\r\n");
    const probe = await run({ host: "127.0.0.1", port: s.port }, true, 1000);
    expect(probe.health).toBe("up");
    expect(typeof probe.latencyMs).toBe("number");
    expect(s.seen.join("")).toBe(
      `HEAD / HTTP/1.0\r\nHost: 127.0.0.1:${s.port}\r\nUser-Agent: DDD-dev-board\r\nConnection: close\r\n\r\n`,
    );
    expect(httpRequest({ host: "::1", port: 5199 })).toBe(
      "HEAD / HTTP/1.0\r\nHost: [::1]:5199\r\nUser-Agent: DDD-dev-board\r\nConnection: close\r\n\r\n",
    );
  });

  it("reaches a v6 bind on v6", async () => {
    // The live half of the [::1]:5199 regression. CI containers routinely have
    // no IPv6 loopback, and a silent pass would be worse than a skip.
    let s: Awaited<ReturnType<typeof server>>;
    try {
      s = await server("::1", null);
    } catch {
      return; // no IPv6 loopback on this machine
    }
    expect((await run({ host: "::1", port: s.port }, false, 500)).health).toBe("up");
  });

  it("resolves every target a batch was given", async () => {
    const s = await server("127.0.0.1", null);
    const out = await batch(
      [
        { key: "a", target: { host: "127.0.0.1", port: s.port }, http: false },
        { key: "b", target: { host: "127.0.0.1", port: 1 }, http: false },
      ],
      500,
    );
    expect(out.get("a")!.health).toBe("up");
    expect(out.get("b")!.health).toBe("down");
  });
});
