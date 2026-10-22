/**
 * How DDD talks to an MCP server, and what it refuses to talk to. Port of
 * `sync/mcp/transport.rs`.
 *
 * Two bindings, per the specification: **stdio**, a subprocess DDD launches,
 * and **Streamable HTTP**, one POST per message. The framing itself — request
 * ids, line-delimited stdout, SSE parsing — is `@modelcontextprotocol/sdk`'s
 * here, so what is left of the Rust module is the part that matters.
 *
 * # The part that matters
 *
 * A stdio MCP server is **a program running on this machine as this user**.
 * DDD's existing guarantees have to survive that, so:
 *
 * - **The command is an argv array, never a shell string.** No shell is
 *   involved, so there is nothing to inject into. A server name containing
 *   `; rm -rf /` is a program name that does not exist, and nothing more.
 * - **Launching is consented explicitly, and the consent is bound to the exact
 *   argv.** Change the command and the consent is void, because what you agreed
 *   to run is no longer what would run.
 * - **The refusal happens before the transport is constructed, never as a
 *   prompt mid-sync.** A scheduler tick must never start a process.
 * - **Secrets are injected as environment variables at spawn**, from the
 *   keychain, and the argv is stored in the clear precisely because it must
 *   never contain one.
 */
import { createHash } from "node:crypto";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport as SdkTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DddError } from "../../error";

// --- what may be launched or contacted ---------------------------------------

/**
 * Read the stored command as an argv array.
 *
 * Refuses anything that is not a non-empty array of non-empty strings. A config
 * file that could smuggle a shell string through is not a config file DDD will
 * read, let alone write.
 */
export function parseArgv(stored: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.trim());
  } catch {
    throw DddError.config(`the command must be a JSON array, e.g. ["npx", "-y", "server"]`);
  }
  if (!Array.isArray(parsed)) throw DddError.config("the command must be a JSON array, not a single string");
  if (parsed.length === 0) throw DddError.config("the command is empty");
  const argv: string[] = [];
  for (const part of parsed) {
    if (typeof part !== "string") throw DddError.config("every part of the command must be a string");
    if (part === "") throw DddError.config("a command cannot contain an empty argument");
    argv.push(part);
  }
  return argv;
}

/**
 * The token a user's consent is recorded against.
 *
 * Bound to the exact argv, so editing the command voids the consent: what you
 * agreed to run is no longer what would run, and silently launching the new
 * thing would make the gate theatre.
 */
export function consentToken(argv: string[]): string {
  // Joined on NUL, a byte no argument can contain, so ["a b"] and ["a", "b"]
  // are not the same approval. Twelve bytes of SHA-256, hex — 24 characters.
  const joined = argv.join("\u0000");
  return createHash("sha256").update(joined, "utf8").digest("hex").slice(0, 24);
}

/** Refuse unless this exact command was consented to. */
export function checkConsent(argv: string[], recorded: string | null): void {
  const expected = consentToken(argv);
  // The Rust matches on `Option`: a recorded-but-empty token is a token that
  // does not match, not an absent one.
  if (recorded === null) {
    throw DddError.config("this server has not been approved to run — approve it in Settings first");
  }
  if (recorded !== expected) {
    throw DddError.config("this server's command has changed since you approved it — approve the new one in Settings");
  }
}

/**
 * Which HTTP endpoints DDD will speak to.
 *
 * `https` anywhere; plain `http` only for loopback, where there is no network
 * to eavesdrop on. The same rule the calendar applies to its feeds.
 */
export function validateEndpoint(url: string): string {
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("https://")) return trimmed;
  if (lower.startsWith("http://")) {
    const rest = lower.slice("http://".length);
    // The Rust splits on `/`, `:` and `?`. That means `[::1]` can never match
    // (the split cuts at its first colon); kept exactly as the Rust has it
    // rather than quietly widening what loopback means.
    const host = rest.split(/[/:?]/)[0] ?? "";
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return trimmed;
    throw DddError.config("plain http is only allowed for localhost — use https for anything else");
  }
  throw DddError.config(`${trimmed} is not an http or https endpoint`);
}

// --- opening one -------------------------------------------------------------

/** Which binding, and everything needed to open it. */
export type Transport =
  { kind: "stdio"; argv: string[]; env: Record<string, string> } | { kind: "http"; endpoint: string; token: string | null };

/**
 * Build the SDK transport. **Consent is the caller's job and must already have
 * been checked**: constructing the stdio transport is not yet a spawn, but the
 * `Client.connect` that follows is, and the refusal belongs before both.
 */
export function openTransport(t: Transport): SdkTransport {
  if (t.kind === "stdio") {
    const [command, ...args] = t.argv;
    return rememberProtocolVersion(
      new StdioClientTransport({
        command: command!,
        args,
        // The Rust's `tokio::process::Command` inherits the parent environment
        // and adds the secret on top; the SDK's default is a safe subset, so
        // the inheritance is spelled out here to keep the behaviour.
        env: { ...inherited(), ...t.env },
        // The Rust piped stderr and never read it.
        stderr: "ignore",
      }),
    );
  }
  const headers: Record<string, string> = {};
  // `requestInit.headers` is the only thing that puts the bearer on the wire:
  // the SDK merges it into every POST. `MCP-Protocol-Version` is NOT set here —
  // the transport sends `mcp-protocol-version` itself, with the version the
  // server answered, on every request after the handshake.
  if (t.token !== null && t.token !== "") headers.Authorization = `Bearer ${t.token}`;
  return rememberProtocolVersion(
    reportHttpStatus(new StreamableHTTPClientTransport(new URL(validateEndpoint(t.endpoint)), { requestInit: { headers } })),
  );
}

/**
 * Keep the HTTP status in the error the scheduler sees.
 *
 * The SDK's `StreamableHTTPError` carries `.code`, but its `.message` alone —
 * the only thing a caught error's `.message` shows — omits it. The scheduler
 * decides `expired` by finding "401"/"403" in that text (`scheduler.ts`), so
 * the code has to be in the message itself. The Rust's wording was "the server
 * answered {status}".
 */
function reportHttpStatus(transport: StreamableHTTPClientTransport): StreamableHTTPClientTransport {
  const inner = transport.send.bind(transport);
  transport.send = async (...args: Parameters<StreamableHTTPClientTransport["send"]>) => {
    try {
      return await inner(...args);
    } catch (e) {
      if (e instanceof StreamableHTTPError) throw DddError.config(`the server answered ${e.code}: ${e.message}`);
      throw e;
    }
  };
  return transport;
}

/** The environment this process runs in, minus the unset entries. */
function inherited(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  return out;
}

interface Versioned {
  dddProtocolVersion?: string;
  setProtocolVersion?: (version: string) => void;
}

/**
 * Keep the version the server answered with.
 *
 * The SDK client hands the negotiated version to every transport, but only
 * `StreamableHTTPClientTransport` exposes it again afterwards (its
 * `protocolVersion` getter); stdio has no equivalent. The hook is installed on
 * every transport so stdio has somewhere to keep it too — `negotiatedVersion`
 * below prefers the transport's own getter and falls back to this for stdio.
 */
export function rememberProtocolVersion<T extends SdkTransport>(transport: T): T {
  const seen = transport as T & Versioned;
  const inner = seen.setProtocolVersion?.bind(seen);
  seen.setProtocolVersion = (version: string) => {
    seen.dddProtocolVersion = version;
    inner?.(version);
  };
  return seen;
}

/** What the transport negotiated: its own `protocolVersion` getter when it has
 *  one (HTTP), or what `rememberProtocolVersion` caught for a transport
 *  without one (stdio). `""` for a transport that never saw either. */
export function negotiatedVersion(transport: SdkTransport | undefined): string {
  if (transport === undefined) return "";
  const seen = transport as SdkTransport & Versioned & { protocolVersion?: string };
  if ("protocolVersion" in seen) return seen.protocolVersion ?? "";
  return seen.dddProtocolVersion ?? "";
}
