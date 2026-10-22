import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Item } from "../../models";
import { fetchContext } from "../adapter";
import { forProvider } from "../providers";
import { McpAdapter, config } from "./adapter";
import { consentToken } from "./transport";

const FIXTURE = join(__dirname, "fixtures/echo-server.mjs");

const context = (settings: Record<string, string>, token = "") =>
  fetchContext({
    environmentId: "default",
    connection: { id: "c1", provider: "mcp", label: "files", config: settings },
    token,
  });

function scratchFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "ddd-mcp-")), name);
}

describe("what the adapter refuses", () => {
  it("never lets an unapproved command reach a spawn", async () => {
    // The refusal is the adapter's, before any process exists. A scheduler tick
    // must never be the thing that starts a program — so the command here is a
    // real server that would write a marker file the moment it ran.
    const marker = scratchFile("marker");
    const cx = context({ [config.COMMAND]: JSON.stringify([process.execPath, FIXTURE, marker]) });
    await expect(new McpAdapter().fetch(cx)).rejects.toThrow("this server has not been approved to run — approve it in Settings first");
    expect(existsSync(marker)).toBe(false); // nothing ran
  });

  it("refuses an approved command that was later edited", async () => {
    const approved = consentToken(["/bin/echo", "safe"]);
    const cx = context({
      [config.COMMAND]: `["/bin/echo", "dangerous"]`,
      [config.CONSENT]: approved,
    });
    await expect(new McpAdapter().fetch(cx)).rejects.toThrow(
      "this server's command has changed since you approved it — approve the new one in Settings",
    );
  });

  it("refuses a shell string as a command", async () => {
    const cx = context({ [config.COMMAND]: "npx -y some-server" });
    await expect(new McpAdapter().fetch(cx)).rejects.toThrow("JSON array");
  });

  it("refuses a plaintext http endpoint before any request", async () => {
    const cx = context({ [config.TRANSPORT]: "http", [config.ENDPOINT]: "http://mcp.example.com/rpc" });
    await expect(new McpAdapter().fetch(cx)).rejects.toThrow("only allowed for localhost");
  });

  it("names a transport nobody implements rather than guessing at it", async () => {
    const cx = context({ [config.TRANSPORT]: "carrier-pigeon" });
    await expect(new McpAdapter().fetch(cx)).rejects.toThrow("carrier-pigeon is not an MCP transport — use stdio or http");
  });

  it("says what is missing for a connection with nothing configured", async () => {
    await expect(new McpAdapter().fetch(context({}))).rejects.toThrow("command is not set for files");
  });

  it("refuses to perform, because tools are not actions yet", async () => {
    // The port's default. Asserted here because the day this changes it must be
    // a deliberate act with its own test, not a silent capability.
    const item = {
      id: "c1:x://1",
      environmentId: "default",
      connectionId: "c1",
      source: "mcp",
      kind: "resource",
      project: null,
      title: "x",
      body: null,
      url: null,
      refs: [],
      actions: [],
      updatedAt: "2026-09-04T10:00:00Z",
      unread: false,
    } satisfies Item;
    await expect(new McpAdapter().perform(context({}), { action: "search", item, input: null })).rejects.toThrow("mcp cannot search");
  });
});

describe("a real stdio server", () => {
  const spawnable = (pidFile: string) => {
    const argv = [process.execPath, FIXTURE, pidFile];
    return {
      [config.COMMAND]: JSON.stringify(argv),
      [config.CONSENT]: consentToken(argv),
      [config.TOKEN_ENV]: "DDD_TEST_TOKEN",
    };
  };

  it("syncs its human resources and leaves no process behind", async () => {
    const pidFile = scratchFile("pid");
    const items = await new McpAdapter().fetch(context(spawnable(pidFile), "s3cret"));

    // Three of the server's four resources: the model-only one is not here.
    expect(items.map((i) => i.title)).toEqual(["Note one", "Two", "Env"]);
    expect(items.every((i) => i.source === "mcp" && i.kind === "resource")).toBe(true);
    expect(items[0]!.id).toBe("c1:https://example.test/notes/one");
    expect(items[0]!.url).toBe("https://example.test/notes/one");
    expect(items[0]!.body).toBe("the first note"); // a description costs no read
    expect(items[0]!.updatedAt).toBe("2026-01-02T03:04:05Z");
    expect(items[0]!.refs).toEqual(expect.arrayContaining(["mcp:https://example.test/notes/one", "priority:0.5", "server:files"]));
    // No description and a textual type: this one was read.
    expect(items[1]!.body).toBe("body of file:///notes/two.md");
    expect(items[1]!.url).toBeNull(); // file:// is data, not a link
    expect(items[1]!.refs).toContain("mime:text/markdown");
    // The keychain secret reached the child as an environment variable, and the
    // argv beside it stayed in the clear.
    expect(items[2]!.body).toBe("token:s3cret");

    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(await gone(pid)).toBe(true); // the server did not outlive the sync
  }, 20000);

  it("probes the same way a sync does", async () => {
    const report = await new McpAdapter().probe(context(spawnable(scratchFile("pid"))));
    expect(report.server.name).toBe("echo");
    expect(report.server.version).toBe("9.9.9");
    expect(report.server.hasResources && report.server.hasTools).toBe(true);
    expect(report.server.protocolVersion).not.toBe("");
    expect(report.tools).toEqual([{ name: "echo", description: "echoes its argument" }]);
    expect(report.skippedForModels).toBe(1);
    expect(report.capped).toBe(false);
    expect(report.failedReads).toBe(0);
    expect(report.unreadBodies).toBe(0);
  }, 20000);

  it("is what the mcp provider builds", () => {
    expect(forProvider("mcp")).toBeInstanceOf(McpAdapter);
    expect(forProvider("mcp")!.source).toBe("mcp");
  });

  it("writes Mapping.now through rfc3339, the same whole-second form every other adapter uses", async () => {
    // Only Date is faked: the child process's own I/O still runs on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    try {
      const items = await new McpAdapter().fetch(context(spawnable(scratchFile("pid")), "s3cret"));
      // "Env" has no lastModified, so its updatedAt falls back to Mapping.now.
      // A bare `toISOString()` would have kept the ".000"; rfc3339 strips it.
      expect(items[2]!.updatedAt).toBe("2026-01-02T03:04:05Z");
    } finally {
      vi.useRealTimers();
    }
  }, 20000);
});

/** Whether the process is gone, giving the kill up to two seconds to land. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
