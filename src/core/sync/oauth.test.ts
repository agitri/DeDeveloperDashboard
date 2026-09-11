import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { scratchEnv } from "../testing";
import { settingsLoad, settingsSave, defaultSettings, type Connection } from "../settings";
import { memorySecrets } from "./adapter";
import { accessToken, awaitRedirect, connect, parseQuery, pkceChallenge, providerFor } from "./oauth";

const conn = (extra: Partial<Connection> = {}): Connection => ({
  id: "gmail-1", provider: "mail.gmail", label: "me@gmail.com", status: "disconnected", scopes: [],
  config: { clientId: "cid", clientSecret: "sec" }, lastSyncAt: null, error: null, ...extra,
});

describe("providers", () => {
  it("knows google and slack, and nothing else", () => {
    expect(providerFor("mail.gmail")?.id).toBe("google");
    expect(providerFor("calendar.google")?.id).toBe("google");
    expect(providerFor("slack")?.id).toBe("slack");
    expect(providerFor("github")).toBeNull();
  });
});

describe("the redirect", () => {
  it("pulls code and state out of it", () => {
    const p = parseQuery("/?code=abc%2F123&state=xyz&scope=a+b");
    expect(p.get("code")).toBe("abc/123");
    expect(p.get("state")).toBe("xyz");
  });
  it("ignores requests that are not the redirect", () => {
    expect(parseQuery("/favicon.ico").size).toBe(0);
    expect(parseQuery("/").size).toBe(0);
  });
  it("challenge is the S256 of the verifier", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("settles immediately, not after the timeout, when the server is closed from outside", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const redirect = awaitRedirect(server, "s", 5000);
    server.close();
    await expect(redirect).rejects.toThrow("consent listener closed");
  });
});

/** Plays the browser and the token endpoint. */
function fakeConsent(opts: { tokenBody?: unknown; tokenStatus?: number; tokenStatusText?: string; deny?: boolean; wrongState?: boolean } = {}) {
  const secrets = memorySecrets();
  const tokenCalls: string[] = [];
  let opened: string | null = null;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    tokenCalls.push(String(init?.body));
    return new Response(JSON.stringify(opts.tokenBody ?? { access_token: "AT", refresh_token: "RT", expires_in: 3600 }), { status: opts.tokenStatus ?? 200, statusText: opts.tokenStatusText ?? "" });
  };
  const openUrl = async (url: string) => {
    opened = url;
    const u = new URL(url);
    const redirect = u.searchParams.get("redirect_uri")!;
    const state = opts.wrongState ? "evil" : u.searchParams.get("state")!;
    // The browser comes back; favicon first, as browsers do.
    setTimeout(() => {
      void globalThis.fetch(`${redirect}/favicon.ico`).catch(() => {});
      const q = opts.deny ? `?error=access_denied&state=${state}` : `?code=THECODE&state=${state}`;
      void globalThis.fetch(`${redirect}/${q}`).catch(() => {});
    }, 50);
  };
  return { deps: { fetch, secrets, openUrl, emit: { emit() {} } }, tokenCalls, opened: () => opened, secrets };
}

describe("consent", () => {
  it("runs the whole dance: PKCE, state, loopback, token exchange, keychain, settings", async () => {
    const { env } = scratchEnv("oauth-connect");
    const s = defaultSettings();
    s.connections.push(conn());
    settingsSave(env, s);
    const f = fakeConsent();
    await connect(env, conn(), f.deps);
    const auth = new URL(f.opened()!);
    expect(auth.origin + auth.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(auth.searchParams.get("client_id")).toBe("cid");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("access_type")).toBe("offline");
    expect(auth.searchParams.get("prompt")).toBe("consent");
    expect(auth.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const exchange = f.tokenCalls[0]!;
    expect(exchange).toContain("grant_type=authorization_code");
    expect(exchange).toContain("code=THECODE");
    expect(exchange).toContain("code_verifier=");
    expect(f.secrets.map.get("default/gmail-1")).toBe("AT");
    expect(f.secrets.map.get("default/gmail-1:refresh")).toBe("RT");
    const stored = settingsLoad(env).connections[0]!;
    expect(stored.status).toBe("connected");
    expect(stored.error).toBeNull();
    expect(stored.config.expiresAt).toMatch(/^\d{4}-/);
    expect(readFileSync(env.settingsFile(), "utf8")).toContain("expiresAt");
  });

  it("fails closed on a state mismatch, and reports a denial", async () => {
    const { env } = scratchEnv("oauth-state");
    await expect(connect(env, conn(), fakeConsent({ wrongState: true }).deps)).rejects.toThrow("OAuth state mismatch — nothing was connected");
    await expect(connect(env, conn(), fakeConsent({ deny: true }).deps)).rejects.toThrow("consent was denied");
  });

  it("needs a client id, and only for providers that use OAuth", async () => {
    const { env } = scratchEnv("oauth-config");
    await expect(connect(env, conn({ config: {} }), fakeConsent().deps)).rejects.toThrow(/needs a client ID/);
    await expect(connect(env, conn({ provider: "github" }), fakeConsent().deps)).rejects.toThrow("github does not use OAuth");
  });

  it("does not leave the redirect wait unhandled when the browser fails to open", async () => {
    const { env } = scratchEnv("oauth-open-fails");
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.once("unhandledRejection", onUnhandled);
    try {
      const f = fakeConsent();
      await expect(
        connect(env, conn(), {
          ...f.deps,
          openUrl: async () => {
            throw new Error("no browser");
          },
        }),
      ).rejects.toThrow("could not open a browser: no browser");
      // Nothing should be wedged: a fresh loopback listener still binds and closes cleanly.
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toBeNull();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("explains a rejected token exchange, including Slack's ok:false", async () => {
    const { env } = scratchEnv("oauth-reject");
    await expect(connect(env, conn(), fakeConsent({ tokenStatus: 400, tokenStatusText: "Bad Request", tokenBody: { error: "invalid_grant", error_description: "Bad code" } }).deps)).rejects.toThrow("oauth 400 Bad Request: Bad code");
    // No reason phrase from the server: no dangling space before the colon.
    await expect(connect(env, conn(), fakeConsent({ tokenStatus: 400, tokenBody: { error: "invalid_grant", error_description: "Bad code" } }).deps)).rejects.toThrow("oauth 400: Bad code");
    await expect(connect(env, conn(), fakeConsent({ tokenBody: { ok: false, error: "invalid_code" } }).deps)).rejects.toThrow("oauth: invalid_code");
    await expect(connect(env, conn(), fakeConsent({ tokenBody: { nothing: true } }).deps)).rejects.toThrow("no access token in the response");
  });
});

describe("the access token", () => {
  it("falls straight through for providers without OAuth", async () => {
    const { env } = scratchEnv("token-plain");
    const f = fakeConsent();
    f.secrets.set(env, "gh", "PAT");
    expect(await accessToken(env, conn({ id: "gh", provider: "github" }), f.deps)).toBe("PAT");
    expect(await accessToken(env, conn({ id: "none", provider: "github" }), f.deps)).toBe("");
    expect(f.tokenCalls).toEqual([]);
  });

  it("uses a fresh token, refreshes a stale one, and uses what it has without a refresh token", async () => {
    const { env } = scratchEnv("token-refresh");
    const s = defaultSettings();
    s.connections.push(conn());
    settingsSave(env, s);
    const f = fakeConsent({ tokenBody: { access_token: "NEW", expires_in: 3600 } });
    f.secrets.set(env, "gmail-1", "OLD");
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(await accessToken(env, conn({ config: { clientId: "cid", expiresAt: future } }), f.deps)).toBe("OLD");
    expect(f.tokenCalls).toEqual([]);
    // Stale but no refresh token: use what we have (Slack issues none).
    expect(await accessToken(env, conn({ config: { clientId: "cid", expiresAt: "2000-01-01T00:00:00Z" } }), f.deps)).toBe("OLD");
    expect(f.tokenCalls).toEqual([]);
    f.secrets.set(env, "gmail-1:refresh", "RT");
    expect(await accessToken(env, conn({ config: { clientId: "cid", expiresAt: "2000-01-01T00:00:00Z" } }), f.deps)).toBe("NEW");
    expect(f.tokenCalls[0]).toContain("grant_type=refresh_token");
    expect(f.tokenCalls[0]).toContain("refresh_token=RT");
    expect(settingsLoad(env).connections[0]!.config.expiresAt).toMatch(/^\d{4}-/);
  });
});
