/**
 * OAuth for a desktop app that has no server. Port of `sync/oauth.rs`.
 *
 * Loopback redirect + PKCE (RFC 8252). No client secret is trusted: PKCE is
 * what proves the exchange came from the process that started it. Tokens land
 * in the keychain, namespaced per environment; the access token goes in the
 * connection's main slot so adapters read it exactly as they read a pasted PAT.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DddError } from "../error";
import type { EnvRoot } from "../paths";
import { settingsLoad, settingsSave, type Connection } from "../settings";
import { statusLabel, type SecretStore, type SyncDeps } from "./adapter";

/** How long we wait for the person to finish in the browser. */
export const CONSENT_TIMEOUT_MS = 180_000;

export interface OauthProvider {
  id: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string;
  /** Providers that only hand out a refresh token when explicitly asked. */
  extraAuthParams: [string, string][];
}

export function providerFor(provider: string): OauthProvider | null {
  switch (provider) {
    case "mail.gmail":
    case "calendar.google":
      return {
        id: "google",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.readonly",
        // Google returns a refresh token only on the first consent unless you insist.
        extraAuthParams: [
          ["access_type", "offline"],
          ["prompt", "consent"],
        ],
      };
    case "slack":
      return {
        id: "slack",
        authUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        scopes: "channels:history,groups:history,im:history,mpim:history,users:read,chat:write,search:read",
        extraAuthParams: [],
      };
    default:
      return null;
  }
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

const randomToken = () => base64url(randomBytes(32));

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** `code=…&state=…` out of a request target; empty when there is no query. */
export function parseQuery(target: string): Map<string, string> {
  const out = new Map<string, string>();
  const q = target.indexOf("?");
  if (q < 0) return out;
  for (const pair of target.slice(q + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    try {
      out.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
    } catch {
      /* a value that does not decode is dropped, as the Rust's `.ok()?` drops it */
    }
  }
  return out;
}

/** Wait for the browser to come back with `?code=…`, verifying `state`. Any
 *  request without a query (a favicon) is answered 404 and ignored. */
export function awaitRedirect(server: Server, expectedState: string, timeoutMs = CONSENT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(DddError.config("timed out waiting for consent"))), timeoutMs);
    // Closing the server from outside (e.g. the caller bailing after `openUrl`
    // failed) must settle this promise immediately, not leave the timer running.
    server.once("close", () => finish(() => reject(DddError.config("consent listener closed"))));
    server.on("request", (req, res) => {
      const params = parseQuery(req.url ?? "/");
      if (params.size === 0) {
        res.writeHead(404, { "content-length": "0" }).end();
        return;
      }
      const stateOk = params.get("state") === expectedState;
      const body =
        !stateOk ? "Something went wrong: the state did not match. Nothing was connected."
        : params.has("code") ? "Connected. You can close this tab and go back to DDD."
        : "Consent was denied. Nothing was connected.";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": String(Buffer.byteLength(body)) }).end(body);
      if (!stateOk) {
        // The exact shape of a CSRF attempt on the loopback listener: fail closed.
        finish(() => reject(DddError.config("OAuth state mismatch — nothing was connected")));
        return;
      }
      const code = params.get("code");
      finish(() => (code ? resolve(code) : reject(DddError.config("consent was denied"))));
    });
  });
}

async function postForm(fetch: typeof globalThis.fetch, url: string, form: [string, string][]): Promise<Record<string, unknown>> {
  const body = form.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw DddError.config(`token request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await response.text().catch(() => "");
  let parsed: Record<string, unknown> = {};
  try {
    const j: unknown = JSON.parse(text);
    if (typeof j === "object" && j !== null) parsed = j as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (!response.ok) {
    const detail =
      (typeof parsed.error_description === "string" && parsed.error_description) ||
      (typeof parsed.error === "string" && parsed.error) ||
      text;
    throw DddError.config(`oauth ${statusLabel(response)}: ${detail}`);
  }
  // Slack answers 200 with `ok: false`, so status alone proves nothing.
  if (parsed.ok === false) {
    throw DddError.config(`oauth: ${typeof parsed.error === "string" ? parsed.error : "rejected"}`);
  }
  return parsed;
}

function storeTokens(env: EnvRoot, connection: Connection, tokens: Record<string, unknown>, secrets: SecretStore): void {
  // Slack nests the user token; Google returns it flat.
  const nested =
    typeof tokens.authed_user === "object" && tokens.authed_user !== null ?
      (tokens.authed_user as Record<string, unknown>).access_token
    : undefined;
  const access =
    typeof tokens.access_token === "string" ? tokens.access_token
    : typeof nested === "string" ? nested
    : null;
  if (access === null) throw DddError.config("no access token in the response");
  secrets.set(env, connection.id, access);
  if (typeof tokens.refresh_token === "string") secrets.set(env, `${connection.id}:refresh`, tokens.refresh_token);

  const settings = settingsLoad(env);
  const stored = settings.connections.find((c) => c.id === connection.id);
  if (stored) {
    stored.status = "connected";
    stored.error = null;
    if (typeof tokens.expires_in === "number") {
      // Expire a minute early: a token that dies mid-request reads as "broken".
      stored.config.expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString();
    }
  }
  settingsSave(env, settings);
}

/** Run the whole consent dance and store the resulting tokens. */
export async function connect(env: EnvRoot, connection: Connection, deps: SyncDeps): Promise<void> {
  const provider = providerFor(connection.provider);
  if (!provider) throw DddError.config(`${connection.provider} does not use OAuth`);
  const clientId = connection.config.clientId;
  if (!clientId) {
    throw DddError.config(
      'This connection needs a client ID. Create an OAuth client of type "Desktop app" in the provider\'s console and paste it here.',
    );
  }
  const clientSecret = connection.config.clientSecret ?? "";

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const verifier = randomToken();
  const challenge = pkceChallenge(verifier);
  const state = randomToken();

  let auth =
    `${provider.authUrl}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(provider.scopes)}` +
    `&state=${encodeURIComponent(state)}&code_challenge=${challenge}&code_challenge_method=S256`;
  for (const [key, value] of provider.extraAuthParams) auth += `&${key}=${encodeURIComponent(value)}`;

  const redirect = awaitRedirect(server, state);
  try {
    await deps.openUrl(auth);
  } catch (e) {
    // Settle the pending redirect before closing, so its rejection (now
    // immediate via the server's "close" listener) is observed, not left to
    // fire the 180s timeout unhandled after we've already returned.
    redirect.catch(() => {});
    server.close();
    throw DddError.config(`could not open a browser: ${e instanceof Error ? e.message : String(e)}`);
  }
  const code = await redirect;

  const tokens = await postForm(deps.fetch, provider.tokenUrl, [
    ["grant_type", "authorization_code"],
    ["code", code],
    ["redirect_uri", redirectUri],
    ["client_id", clientId],
    ["client_secret", clientSecret],
    ["code_verifier", verifier],
  ]);
  storeTokens(env, connection, tokens, deps.secrets);
}

/** The credential an adapter should use right now, refreshing first if the
 *  stored one is stale. Providers without OAuth fall straight through. */
export async function accessToken(env: EnvRoot, connection: Connection, deps: SyncDeps): Promise<string> {
  const stored = () => deps.secrets.get(env, connection.id) ?? "";
  const provider = providerFor(connection.provider);
  if (!provider) return stored();
  const expiresAt = connection.config.expiresAt;
  const fresh = expiresAt !== undefined && !Number.isNaN(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.now();
  if (fresh) return stored();
  const refresh = deps.secrets.get(env, `${connection.id}:refresh`);
  // No refresh token: never connected, or a provider that only issues
  // long-lived tokens (Slack). Use what we have.
  if (refresh === null) return stored();
  const tokens = await postForm(deps.fetch, provider.tokenUrl, [
    ["grant_type", "refresh_token"],
    ["refresh_token", refresh],
    ["client_id", connection.config.clientId ?? ""],
    ["client_secret", connection.config.clientSecret ?? ""],
  ]);
  storeTokens(env, connection, tokens, deps.secrets);
  return stored();
}
