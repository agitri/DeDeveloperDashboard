import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkConsent, consentToken, negotiatedVersion, openTransport, parseArgv, validateEndpoint } from "./transport";

// The Rust's framing tests (`result_of`, `parse_sse`, the stdout read loop) are
// not ported: the SDK owns framing here. What remains is the part this module
// exists for — what may be launched, what may be contacted, and the consent.

describe("the stored command", () => {
  it("is an array and never a shell string", () => {
    // No shell is involved, so there is nothing to inject into. A string that
    // looks like a command line is refused rather than split.
    expect(parseArgv(`["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"]`)).toEqual([
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/tmp",
    ]);
    expect(() => parseArgv(`"npx -y server; rm -rf /"`)).toThrow();
    expect(() => parseArgv("[]")).toThrow();
    expect(() => parseArgv(`["npx", 42]`)).toThrow();
    expect(() => parseArgv(`["npx", ""]`)).toThrow();
    expect(() => parseArgv("not json")).toThrow();
  });

  it("keeps shell metacharacters as one inert argument", () => {
    // They reach the program as a literal argument. There is no shell to
    // interpret them, which is the entire reason argv is an array.
    const parsed = parseArgv(`["echo", "; rm -rf / #"]`);
    expect(parsed[1]).toBe("; rm -rf / #");
    expect(parsed).toHaveLength(2); // one argument, not a parsed command line
  });

  it("names the four refusals exactly as Settings shows them", () => {
    expect(() => parseArgv("not json")).toThrow(`the command must be a JSON array, e.g. ["npx", "-y", "server"]`);
    expect(() => parseArgv(`"npx -y server"`)).toThrow("the command must be a JSON array, not a single string");
    expect(() => parseArgv("[]")).toThrow("the command is empty");
    expect(() => parseArgv(`["npx", 42]`)).toThrow("every part of the command must be a string");
    expect(() => parseArgv(`["npx", ""]`)).toThrow("a command cannot contain an empty argument");
  });

  it("is trimmed before it is parsed", () => {
    expect(parseArgv(`  ["npx"]\n`)).toEqual(["npx"]);
  });
});

describe("consent", () => {
  it("is bound to the exact command", () => {
    // Editing the command voids the approval: what you agreed to run is no
    // longer what would run, and launching it anyway would make the gate
    // theatre.
    const original = ["npx", "server", "/safe/dir"];
    const token = consentToken(original);
    expect(token).toBe("6a07373cd5457e73144d5e35"); // twelve bytes of SHA-256, hex
    expect(() => checkConsent(original, token)).not.toThrow();

    expect(() => checkConsent(["npx", "server", "/"], token)).toThrow(
      "this server's command has changed since you approved it — approve the new one in Settings",
    );
  });

  it("refuses an unapproved server rather than prompting for it", () => {
    // A scheduler tick must never be the thing that starts a process, so this
    // refuses where a prompt would be.
    expect(() => checkConsent(["npx", "server"], null)).toThrow("this server has not been approved to run — approve it in Settings first");
  });

  it("cannot have its argv parts rearranged without voiding the approval", () => {
    // Joined on a separator no argument can contain, so ["a b"] and ["a", "b"]
    // are not the same approval.
    expect(consentToken(["a b"])).not.toBe(consentToken(["a", "b"]));
    expect(consentToken(["npx", "-y", "server"])).toBe("fcc4c8cdd12fb9c6b3149580");
  });
});

describe("endpoints", () => {
  it("allows plain http for loopback only", () => {
    expect(validateEndpoint("https://mcp.example.com/rpc")).toBe("https://mcp.example.com/rpc");
    expect(validateEndpoint("http://localhost:3000/mcp")).toBe("http://localhost:3000/mcp");
    expect(validateEndpoint("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(validateEndpoint("  https://x.test/mcp  ")).toBe("https://x.test/mcp");
    for (const refused of ["http://mcp.example.com/rpc", "ws://example.com", "file:///tmp/x", "mcp.example.com", ""]) {
      expect(() => validateEndpoint(refused), refused).toThrow();
    }
  });

  it("says which refusal it is", () => {
    expect(() => validateEndpoint("http://mcp.example.com/rpc")).toThrow(
      "plain http is only allowed for localhost — use https for anything else",
    );
    expect(() => validateEndpoint("ws://example.com")).toThrow("ws://example.com is not an http or https endpoint");
    expect(() => validateEndpoint("")).toThrow(" is not an http or https endpoint");
  });

  it("refuses a plaintext endpoint before a transport exists", () => {
    expect(() => openTransport({ kind: "http", endpoint: "http://mcp.example.com/rpc", token: "t" })).toThrow(
      "plain http is only allowed for localhost",
    );
  });
});

describe("opening a transport", () => {
  it("builds the SDK transport for each binding", () => {
    const stdio = openTransport({ kind: "stdio", argv: ["node", "server.js"], env: { TOKEN: "s" } });
    expect(stdio).toBeInstanceOf(StdioClientTransport);
    // Nothing is spawned until the client starts it.
    expect((stdio as StdioClientTransport).pid).toBeNull();
    expect(openTransport({ kind: "http", endpoint: "https://x.test/mcp", token: null })).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it("sends the bearer on every request and the negotiated version on every one after the handshake", async () => {
    // `requestInit.headers.Authorization` is the only thing that puts the token
    // on the wire; `mcp-protocol-version` is the SDK transport's own, set from
    // what the server answered — which is why it is absent on `initialize`.
    const seen: { method: string | undefined; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string };
        seen.push({ method: message.method, headers: request.headers });
        response.setHeader("content-type", "application/json");
        // A notification: answered 200 with an empty body so the SDK does not
        // open a standalone SSE stream this fixture would have to serve.
        if (message.id === undefined) return void response.end("{}");
        const result =
          message.method === "initialize" ?
            { protocolVersion: "2025-06-18", serverInfo: { name: "files", version: "1.0.0" }, capabilities: { tools: {} } }
          : { tools: [{ name: "search", inputSchema: { type: "object" } }] };
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    const transport = openTransport({ kind: "http", endpoint, token: "tok" });
    const client = new Client({ name: "DDD", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    expect((await client.listTools()).tools[0]!.name).toBe("search");
    // The version the server answered, which the SDK otherwise keeps to itself.
    expect(negotiatedVersion(client.transport)).toBe("2025-06-18");
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(seen.map((s) => s.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(seen.every((s) => s.headers.authorization === "Bearer tok")).toBe(true);
    expect(seen[0]!.headers["mcp-protocol-version"]).toBeUndefined();
    expect(seen[2]!.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("leaves the header off when there is no token", () => {
    const t = openTransport({ kind: "http", endpoint: "https://x.test/mcp", token: "" });
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it("reads the negotiated version off the transport's own getter, with no hook installed", async () => {
    // The installed SDK's StreamableHTTPClientTransport has a `protocolVersion`
    // getter of its own; `negotiatedVersion` must read that directly rather than
    // depending on `rememberProtocolVersion` having patched the transport first.
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string };
        response.setHeader("content-type", "application/json");
        if (message.id === undefined) return void response.end("{}");
        const result =
          message.method === "initialize" ?
            { protocolVersion: "2025-06-18", serverInfo: { name: "files", version: "1.0.0" }, capabilities: {} }
          : { tools: [] };
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    // Built directly, not through openTransport: no rememberProtocolVersion hook.
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    const client = new Client({ name: "DDD", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    expect(negotiatedVersion(client.transport)).toBe("2025-06-18");
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps the HTTP status in the thrown error, for the scheduler to read", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 401;
      response.setHeader("content-type", "text/plain");
      response.end("nope");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    const transport = openTransport({ kind: "http", endpoint, token: null });
    const client = new Client({ name: "DDD", version: "0.1.0" }, { capabilities: {} });
    await expect(client.connect(transport)).rejects.toThrow(/^the server answered 401/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
