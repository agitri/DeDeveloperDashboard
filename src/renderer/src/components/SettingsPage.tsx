import { useEffect, useMemo, useState } from "react";
import { DEFAULT_KEYMAP, buildActions, findConflicts } from "../keyboard/actions";
import { eventToBinding, formatBinding } from "../keyboard/keys";
import { ipc, DEFAULT_SETTINGS } from "../lib/ipc";
import { useStore } from "../state/store";
import { ENV_COLORS } from "../lib/palette";
import { useUi } from "../state/ui";
import type {
  McpReport,
  AppearanceSettings,
  Connection,
  Environment,
  FoundApp,
  PathsInfo,
  Settings,
} from "../types";

/**
 * For a local-first app the settings page *is* the onboarding — there is no
 * backend provisioning anything (§5.8). The first-run wizard, when it lands,
 * walks these same panels rather than duplicating them.
 */
/**
 * Two groups, because they answer two different questions.
 *
 * Global settings are about the app: how it looks, what your keys do, which
 * worlds exist. Environment settings are about *one* world: its accounts, its
 * AI budget, its data — the things the isolation wall exists to keep apart.
 *
 * Anything that would be strange to have two of belongs in the first group.
 */
const GLOBAL_PANELS = [
  { id: "environments", label: "Environments" },
  { id: "appearance", label: "Appearance" },
  { id: "keyboard", label: "Keyboard" },
] as const;

const ENV_PANELS = [
  { id: "connections", label: "Connections" },
  { id: "ai", label: "AI" },
  { id: "voice", label: "Voice" },
  { id: "data", label: "Data" },
] as const;

const PANELS = [...GLOBAL_PANELS, ...ENV_PANELS];

type PanelId = (typeof PANELS)[number]["id"];

export function SettingsPage({ keymap }: { keymap: Record<string, string[]> }) {
  // The panel lives in UI state so the palette can deep-link straight into one.
  const panel = useUi((s) => s.settingsPanel) as PanelId;
  const setPanel = useUi((s) => s.openSettingsPanel);
  const saveSettings = useStore((s) => s.saveSettings);
  // The environment these panels describe: whichever tab-gear you came from,
  // or the active one when you arrived from the header.
  const pinnedEnvId = useUi((s) => s.settingsEnvId);
  const activeEnvId = useStore((s) => s.activeEnvironmentId());
  const envId = pinnedEnvId ?? activeEnvId;
  const settings = useStore((s) => s.settings[envId] ?? DEFAULT_SETTINGS);
  const environment = useStore((s) => s.environments().find((e) => e.id === envId));

  function patch(update: (draft: Settings) => Settings) {
    saveSettings(update(structuredClone(settings)), envId);
  }

  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="mono-label nav-head">This app</div>
        {GLOBAL_PANELS.map((p) => (
          <button
            key={p.id}
            className={panel === p.id ? "active" : ""}
            onClick={() => setPanel(p.id)}
          >
            {p.label}
          </button>
        ))}

        <div className="mono-label nav-head">
          <i className="env-dot" style={{ ["--env" as string]: environment?.color }} />
          {environment?.name ?? envId}
        </div>
        {ENV_PANELS.map((p) => (
          <button
            key={p.id}
            className={panel === p.id ? "active" : ""}
            onClick={() => setPanel(p.id)}
          >
            {p.label}
          </button>
        ))}
      </nav>

      <div className="settings-body">
        {panel === "environments" && <EnvironmentsPanel activeId={envId} />}
        {panel === "connections" && <ConnectionsPanel settings={settings} patch={patch} envId={envId} />}
        {panel === "ai" && <AiPanel settings={settings} patch={patch} envId={envId} />}
        {panel === "voice" && <VoicePanel settings={settings} patch={patch} />}
        {panel === "appearance" && <AppearancePanel />}
        {panel === "keyboard" && <KeyboardPanel keymap={keymap} envId={envId} />}
        {panel === "data" && <DataPanel settings={settings} patch={patch} envId={envId} />}
      </div>
    </div>
  );
}

type PatchFn = (update: (draft: Settings) => Settings) => void;

function Row({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <div className="label">{label}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

// --- Environments -----------------------------------------------------------

/**
 * Suggested environment colours.
 *
 * Environment colour is the only saturated thing in the UI and it is how you
 * tell your worlds apart, so these are not eyeballed — they are validated for
 * colour-vision separation against both the light and dark chart surfaces
 * (OKLab ΔE ≥ 8 on every adjacent pair under deuteranopia, protanopia and
 * tritanopia). The first attempt shipped green and orange next to each other at
 * ΔE 5.7 under deuteranopia: for a red-green colourblind user, Work and
 * Personal were the same colour.
 *
 * The teal sits just under 3:1 contrast on the light surface. That is allowed
 * here only because an environment dot is never shown alone — the name label is
 * always beside it, so identity is never carried by colour on its own.
 */

function EnvironmentsPanel({ activeId }: { activeId: string }) {
  const environments = useStore((s) => s.environments());
  const anchor = useUi((s) => s.settingsAnchor);
  const clearAnchor = useUi((s) => s.clearSettingsAnchor);

  // Which card to highlight, held in React rather than poked onto the DOM.
  // `clearAnchor` re-renders, so anything cleaned up by this effect — a timer,
  // a listener — would be torn down before it could ever end the highlight,
  // leaving every visited card permanently lit.
  const [flashId, setFlashId] = useState<string | null>(null);

  // Arriving from a click on one environment's name: land on that card rather
  // than at the top of a list of six. The anchor is cleared immediately so
  // switching panels and coming back does not re-scroll.
  useEffect(() => {
    if (!anchor) return;
    document
      .querySelector<HTMLElement>(`[data-env-card="${anchor}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashId(anchor);
    clearAnchor();
  }, [anchor, clearAnchor]);

  const layouts = useStore((s) => s.layouts);
  const createEnvironment = useStore((s) => s.createEnvironment);
  const updateEnvironment = useStore((s) => s.updateEnvironment);
  const deleteEnvironment = useStore((s) => s.deleteEnvironment);
  const showToast = useUi((s) => s.showToast);

  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(ENV_COLORS[1]!);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    try {
      await createEnvironment(name, newColor);
      setNewName("");
      // Rotate the suggestion so the next one does not collide by default.
      setNewColor(ENV_COLORS[(ENV_COLORS.indexOf(newColor) + 1) % ENV_COLORS.length]!);
      showToast(`Created ${name}`);
    } catch (e) {
      showToast(String(e));
    }
  }

  async function remove(id: string, name: string) {
    try {
      await deleteEnvironment(id);
      showToast(`Deleted ${name} and everything in it`);
    } catch (e) {
      showToast(String(e));
    } finally {
      setConfirmDelete(null);
    }
  }

  return (
    <>
      <h1>Environments</h1>
      <p className="lede">
        A wall, not a filter. Each environment owns its own projects, connections, keys, stats
        and tabs, on disk and in the keychain — your employer's tokens and your personal mail
        never touch. There is no profile to switch into: every environment is connected at once
        and shows up as a coloured group in the tab strip, so clicking a tab <em>is</em> the
        switch.
      </p>

      {environments.map((env) => (
        <EnvironmentCard
          key={env.id}
          env={env}
          active={env.id === activeId}
          flash={flashId === env.id}
          onFlashEnd={() => setFlashId(null)}
          tabCount={layouts[env.id]?.tabs.length ?? 0}
          onlyOne={environments.length <= 1}
          confirming={confirmDelete === env.id}
          onConfirm={() => setConfirmDelete(env.id)}
          onCancel={() => setConfirmDelete(null)}
          onDelete={() => void remove(env.id, env.name)}
          onPatch={(patch) => void updateEnvironment(env.id, patch)}
        />
      ))}

      <div className="card">
        <div className="card-head">
          <div className="grow">Add an environment</div>
        </div>
        <div className="card-body" data-wizard-target="env-create">
          <Row label="Name" desc="Work, Personal, or one per client.">
            <input
              className="field"
              style={{ maxWidth: 220 }}
              placeholder="Work"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
            />
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              style={{ width: 44, height: 26, padding: 0, border: "none", background: "none" }}
            />
            <button className="btn primary" onClick={() => void create()} disabled={!newName.trim()}>
              Create
            </button>
          </Row>
        </div>
      </div>

      <div className="note">
        A new environment starts with its own empty board. Nothing is copied across — use
        Appearance → layout export/import when you deliberately want the same setup in both.
      </div>
    </>
  );
}

/**
 * Name and colour are edited locally and committed on blur. Writing on every
 * keystroke would mean a `global.json` write per character typed.
 */
function EnvironmentCard({
  env,
  active,
  flash,
  onFlashEnd,
  tabCount,
  onlyOne,
  confirming,
  onConfirm,
  onCancel,
  onDelete,
  onPatch,
}: {
  env: Environment;
  active: boolean;
  flash: boolean;
  onFlashEnd: () => void;
  tabCount: number;
  onlyOne: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onPatch: (patch: { name?: string; color?: string; hidden?: boolean }) => void;
}) {
  const [name, setName] = useState(env.name);
  const [color, setColor] = useState(env.color);

  return (
    <div
      className={`card${flash ? " flash" : ""}`}
      data-env-card={env.id}
      onAnimationEnd={onFlashEnd}
    >
      <div className="card-head">
        <i className="env-dot" style={{ ["--env" as string]: color, marginRight: 4 }} />
        <div className="grow">
          <input
            className="field"
            style={{ maxWidth: 220 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const trimmed = name.trim();
              if (!trimmed) return setName(env.name);
              if (trimmed !== env.name) onPatch({ name: trimmed });
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </div>
        {active && <span className="mono-label">active</span>}
        <span className="mono-label">
          {tabCount} tab{tabCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="card-body">
        <Row label="Colour" desc="Marks its tab group and tints focus rings while you are in it.">
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            onBlur={() => color !== env.color && onPatch({ color })}
            style={{ width: 44, height: 26, padding: 0, border: "none", background: "none" }}
          />
          {ENV_COLORS.map((swatch) => (
            <button
              key={swatch}
              aria-label={`Use ${swatch}`}
              onClick={() => {
                setColor(swatch);
                onPatch({ color: swatch });
              }}
              style={{
                width: 18,
                height: 18,
                border: `1px solid ${swatch === color ? "var(--ink)" : "var(--line)"}`,
                borderRadius: 3,
                background: swatch,
                cursor: "pointer",
              }}
            />
          ))}
        </Row>
        <Row
          label="Focus mode"
          desc="Hide its tab group entirely. A visibility toggle — nothing is deleted, nothing stops syncing."
        >
          <input
            type="checkbox"
            checked={env.hidden}
            onChange={(e) => onPatch({ hidden: e.target.checked })}
          />
          <span className="mono-label">{env.hidden ? "hidden" : "visible"}</span>
        </Row>
        <Row label="Directory">
          <span className="pathline">~/.ddd/environments/{env.id}/</span>
        </Row>
        <Row
          label="Delete"
          desc="Removes its directory, its tabs and every keychain entry its connections own."
        >
          {onlyOne ? (
            <span className="mono-label">the last environment cannot be deleted</span>
          ) : confirming ? (
            <>
              <button className="btn danger" onClick={onDelete}>
                Delete {env.name} permanently
              </button>
              <button className="btn" onClick={onCancel}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn danger" onClick={onConfirm}>
              Delete…
            </button>
          )}
        </Row>
      </div>
    </div>
  );
}

// --- Connections ------------------------------------------------------------

/** Providers the adapters are being written against. Everything here is a
 *  placeholder card until its phase lands — but the *shape* is fixed now, so
 *  each integration arrives as "add a card", not as ad-hoc config. */
const PROVIDERS: {
  id: string;
  label: string;
  phase: string;
  scopes: string[];
  /** Non-secret settings this adapter needs before it can fetch. */
  fields?: { key: string; label: string; placeholder: string }[];
  ready?: boolean;
  /** Uses consent rather than a pasted token. */
  oauth?: boolean;
  /** What the credential is called for this provider, when "token" is wrong. */
  secretLabel?: string;
  /**
   * What connecting this provider needs from someone other than the user.
   *
   * Most developers are not their organisation's Google, Microsoft or Slack
   * admin. Saying so on the card — rather than after an hour in a console —
   * is the difference between a known limit and a wasted afternoon.
   */
  adminNeeded?: string;
}[] = [
  {
    id: "github",
    label: "GitHub",
    phase: "Phase 2",
    scopes: ["repo", "read:org", "notifications"],
    ready: true,
  },
  {
    id: "jira",
    label: "Jira",
    phase: "Phase 2",
    scopes: ["read:jira-work", "write:jira-work"],
    ready: true,
    fields: [
      { key: "siteUrl", label: "Site URL", placeholder: "https://your-team.atlassian.net" },
      { key: "email", label: "Account email", placeholder: "you@example.com" },
    ],
  },
  {
    id: "calendar.ics",
    label: "Calendar subscription (.ics)",
    phase: "Phase 3",
    scopes: [],
    ready: true,
    // The URL is the credential — anyone holding it can read the calendar — so
    // it goes in the keychain like a token, not into config.json.
    secretLabel: "Calendar URL",
    fields: [{ key: "color", label: "Colour", placeholder: "#00a99f" }],
  },
  {
    id: "mail.gmail",
    label: "Gmail & Google Calendar",
    adminNeeded:
      "Needs an OAuth client in a Google Cloud project. For a personal account you can " +
      "make one yourself in about ten minutes — see docs/connect-gmail.md, which walks " +
      "the console step by step. For a work account, a Workspace admin may block " +
      "third-party apps entirely; that guide has the exact wording to ask them for. " +
      "Calendars need none of this: publish the calendar and subscribe to its .ics URL " +
      "instead.",
    phase: "Phase 3",
    scopes: ["gmail.modify", "calendar.readonly"],
    ready: true,
    oauth: true,
    fields: [
      { key: "clientId", label: "OAuth client ID", placeholder: "…apps.googleusercontent.com" },
      { key: "clientSecret", label: "OAuth client secret", placeholder: "GOCSPX-…" },
    ],
  },
  {
    id: "slack",
    label: "Slack",
    adminNeeded:
      "Needs a Slack app installed in the workspace. Most workspaces require an admin to " +
      "approve that — ask them to approve an app with the scopes listed below.",
    phase: "Phase 3",
    scopes: ["im:history", "chat:write", "search:read"],
    ready: true,
    oauth: true,
    fields: [
      { key: "clientId", label: "OAuth client ID", placeholder: "1234567890.1234567890" },
      { key: "clientSecret", label: "OAuth client secret", placeholder: "…" },
    ],
  },
  {
    id: "mail.outlook",
    label: "Outlook (Microsoft Graph)",
    adminNeeded:
      "Needs an Entra app registration, and mail scopes need admin consent. Calendars do " +
      "not: Outlook Web can publish a calendar as an .ics URL you subscribe to instead.",
    phase: "later",
    scopes: ["Mail.ReadWrite", "Mail.Send", "Calendars.Read"],
  },
  {
    id: "mail.imap",
    label: "Mail over IMAP",
    phase: "Phase 3",
    scopes: [],
    ready: true,
    // The credential is an app password the user makes themselves — no OAuth
    // client, no cloud project, no administrator. This is the connection that
    // works when the Gmail one is blocked.
    secretLabel: "App password",
    fields: [
      { key: "host", label: "IMAP server", placeholder: "imap.gmail.com" },
      { key: "username", label: "Username", placeholder: "you@example.com" },
      { key: "port", label: "Port", placeholder: "993" },
      { key: "folder", label: "Folder", placeholder: "INBOX" },
      { key: "limit", label: "Newest messages", placeholder: "200" },
    ],
  },
  {
    id: "mcp",
    label: "MCP server",
    phase: "Phase 4",
    scopes: [],
    ready: true,
    // The credential, when a server wants one, is injected as the environment
    // variable named below. It never enters settings.json, which is exactly why
    // the command beside it can be stored in the clear.
    secretLabel: "Server credential",
    fields: [
      { key: "transport", label: "Transport", placeholder: "stdio  ·  or  http" },
      {
        key: "command",
        label: "Command (stdio)",
        placeholder: '["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path"]',
      },
      { key: "endpoint", label: "Endpoint (http)", placeholder: "https://mcp.example.com/rpc" },
      { key: "kind", label: "Show items as", placeholder: "resource" },
      { key: "tokenEnv", label: "Credential goes in", placeholder: "GITHUB_TOKEN" },
    ],
  },
  {
    id: "mock",
    label: "Mock source",
    phase: "always",
    scopes: [],
    ready: true,
  },
  { id: "mail.outlook", label: "Outlook (Microsoft Graph)", phase: "Phase 3", scopes: ["Mail.ReadWrite", "Mail.Send", "Calendars.Read"] },
  { id: "mail.gmail", label: "Gmail", phase: "Phase 3", scopes: ["gmail.modify", "calendar.readonly"] },
  { id: "slack", label: "Slack", phase: "Phase 3", scopes: ["channels:history", "im:history", "chat:write"] },
];

/**
 * The consent gate, and what the server says about itself.
 *
 * A stdio MCP server is a program running on this machine as this user, so the
 * approval shows the exact argv and is bound to it: edit the command and the
 * approval is void, because what you agreed to run is no longer what would run.
 * Nothing here can start a process — approval is a record, and only a sync
 * spawns anything.
 */
function McpPanel({
  connection,
  patch,
  envId,
}: {
  connection: Connection;
  patch: PatchFn;
  envId: string;
}) {
  const [typed, setTyped] = useState("");
  const [report, setReport] = useState<McpReport | null>(null);
  const [busy, setBusy] = useState(false);
  const showToast = useUi((s) => s.showToast);

  const command = connection.config.command ?? "";
  const isStdio = (connection.config.transport ?? "stdio") !== "http";
  const consented = Boolean(connection.config.consent);

  async function approve() {
    try {
      const token = await ipc.mcpConsent(command);
      patch((draft) => {
        const c = draft.connections.find((x) => x.id === connection.id);
        if (c) c.config.consent = token;
        return draft;
      });
      setTyped("");
      showToast("Approved — this exact command may now be launched");
    } catch (e) {
      showToast(String(e));
    }
  }

  async function probe() {
    setBusy(true);
    try {
      setReport(await ipc.mcpProbe(envId, connection.id));
    } catch (e) {
      setReport(null);
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {isStdio && (
        <Row
          label="Approval"
          desc="This launches a program on your machine as you. The approval is bound to the exact command below — editing it asks again."
        >
          {consented ? (
            <span className="mono-label" style={{ color: "var(--ok)" }}>
              approved
            </span>
          ) : (
            <>
              <input
                className="field"
                style={{ maxWidth: 120 }}
                placeholder="type: approve"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
              <button
                className="btn primary"
                disabled={typed.trim().toLowerCase() !== "approve" || !command.trim()}
                onClick={() => void approve()}
              >
                Approve this command
              </button>
            </>
          )}
        </Row>
      )}
      {isStdio && command && (
        <Row label="Will run" desc="As an argument list. No shell is involved, so nothing here is interpreted.">
          <span className="pathline">{command}</span>
        </Row>
      )}
      <Row label="Server" desc="Handshake with the server and report what it offers. Writes nothing.">
        <button className="btn" disabled={busy} onClick={() => void probe()}>
          {busy ? "Asking…" : "Test connection"}
        </button>
        {report && (
          <span className="mono-label" style={{ marginLeft: 8 }}>
            {report.server.name} {report.server.version} · protocol {report.server.protocolVersion}
          </span>
        )}
      </Row>
      {report && (
        <>
          <Row label="Offers" desc="What the server declared in its handshake.">
            <span className="mono-label">
              {[
                report.server.hasResources ? "resources" : null,
                report.server.hasTools ? "tools" : null,
                report.server.subscribe ? "subscribe" : null,
                report.server.listChanged ? "listChanged" : null,
              ]
                .filter(Boolean)
                .join(" · ") || "nothing DDD can use"}
            </span>
          </Row>
          <Row
            label="Skipped as model-facing"
            desc="Resources annotated for an assistant rather than a person. DDD is an overview, not an agent, so it syncs the human half. This number is the difference between 'nothing here for me' and 'this server talks to models'."
          >
            <span className="mono-label">{report.skippedForModels}</span>
          </Row>
          {report.tools.length > 0 && (
            <Row label="Tools" desc="Discovered and listed. Not callable in this version — when they arrive they become item actions, behind the same approval gate as everything else that sends something outward.">
              <span className="mono-label" style={{ color: "var(--ink-3)" }}>
                {report.tools.map((t) => t.name).join(" · ")}
              </span>
            </Row>
          )}
          {(report.capped || report.failedReads > 0 || report.unreadBodies > 0) && (
            <Row label="Last read" desc="What one sync would leave out, so an incomplete board says so.">
              <span className="mono-label">
                {[
                  report.capped ? "more pages than the cap" : null,
                  report.failedReads > 0 ? `${report.failedReads} unreadable` : null,
                  report.unreadBodies > 0 ? `${report.unreadBodies} without bodies` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </Row>
          )}
        </>
      )}
    </>
  );
}

function ConnectionsPanel({
  settings,
  patch,
  envId,
}: {
  settings: Settings;
  patch: PatchFn;
  envId: string;
}) {
  const showToast = useUi((s) => s.showToast);
  const [secretPresent, setSecretPresent] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      settings.connections.map(async (c) => [c.id, await ipc.secretExists(envId, c.id).catch(() => false)] as const),
    ).then((pairs) => {
      if (!cancelled) setSecretPresent(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [settings.connections, envId]);

  function addConnection(providerId: string, label: string, scopes: string[]) {
    patch((draft) => {
      draft.connections.push({
        id: `${providerId}-${Math.random().toString(36).slice(2, 7)}`,
        provider: providerId,
        label,
        status: "disconnected",
        scopes,
        config: {},
      });
      return draft;
    });
  }

  // Deliberately not `window.prompt`: it is unreliable inside Tauri's webviews,
  // and a secret deserves a real password field rather than a browser dialog.
  async function storeToken(connection: Connection, token: string) {
    if (!token.trim()) return;
    try {
      await ipc.secretSet(envId, connection.id, token.trim());
      setSecretPresent((s) => ({ ...s, [connection.id]: true }));
      patch((draft) => {
        const c = draft.connections.find((x) => x.id === connection.id);
        if (c) c.status = "connected";
        return draft;
      });
      setEditing(null);
      showToast("Stored in the keychain");
    } catch (e) {
      showToast(String(e));
    }
  }

  async function removeConnection(connection: Connection) {
    await ipc.secretDelete(envId, connection.id).catch(() => {});
    patch((draft) => {
      draft.connections = draft.connections.filter((c) => c.id !== connection.id);
      return draft;
    });
  }

  return (
    <>
      <h1>Connections</h1>
      <p className="lede">
        Connections are account-scoped and belong to exactly one environment, so work GitHub and
        personal GitHub can both be connected without either seeing the other. Tokens live in the
        OS keychain under <code>ddd:{envId}</code> — this page shows status, never secrets.
      </p>

      {settings.connections.length === 0 && (
        <div className="note" style={{ marginBottom: 16 }}>
          Nothing connected yet in this environment. Adding a card below creates the connection
          record; OAuth device-code flows arrive with each adapter's phase.
        </div>
      )}

      {settings.connections.map((connection) => (
        <div className="card" key={connection.id}>
          <div className="card-head">
            <i className={`status-dot ${connection.status}`} />
            <div className="grow">
              <div>{connection.label}</div>
              <div className="mono-label">{connection.provider}</div>
            </div>
            {PROVIDERS.find((p) => p.id === connection.provider)?.oauth ? (
              <button
                className="btn primary"
                title="Opens your browser; the token never passes through this window"
                onClick={() => {
                  showToast("Finish in your browser…");
                  void ipc
                    .connectionConnect(envId, connection.id)
                    .then(() => {
                      setSecretPresent((s) => ({ ...s, [connection.id]: true }));
                      showToast(`Connected ${connection.label}`);
                    })
                    .catch((e) => showToast(String(e)));
                }}
              >
                {secretPresent[connection.id] ? "Reconnect" : "Connect"}
              </button>
            ) : (
              <button
                className="btn"
                onClick={() => setEditing(editing === connection.id ? null : connection.id)}
              >
                {(() => {
                  const what = (
                    PROVIDERS.find((p) => p.id === connection.provider)?.secretLabel ?? "token"
                  ).toLowerCase();
                  return `${secretPresent[connection.id] ? "Replace" : "Set"} ${what}`;
                })()}
              </button>
            )}
            <button className="btn danger" onClick={() => void removeConnection(connection)}>
              Remove
            </button>
          </div>
          <div className="card-body">
            {PROVIDERS.find((p) => p.id === connection.provider)?.adminNeeded && (
              <div className="admin-note">
                {PROVIDERS.find((p) => p.id === connection.provider)!.adminNeeded}
              </div>
            )}
            {editing === connection.id && (
              <TokenField
                label={
                  PROVIDERS.find((p) => p.id === connection.provider)?.secretLabel ??
                  connection.label
                }
                onCancel={() => setEditing(null)}
                onSave={(token) => void storeToken(connection, token)}
              />
            )}
            {connection.provider === "mcp" && (
              <McpPanel connection={connection} patch={patch} envId={envId} />
            )}
            {(PROVIDERS.find((p) => p.id === connection.provider)?.fields ?? []).map((field) => (
              <Row key={field.key} label={field.label}>
                <input
                  className="field"
                  style={{ maxWidth: 320 }}
                  placeholder={field.placeholder}
                  defaultValue={connection.config[field.key] ?? ""}
                  onBlur={(e) =>
                    patch((draft) => {
                      const c = draft.connections.find((x) => x.id === connection.id);
                      if (c) c.config[field.key] = e.target.value.trim();
                      return draft;
                    })
                  }
                />
              </Row>
            ))}
            <Row label="Keychain" desc="Whether a credential exists for this connection.">
              <span className="mono-label">
                {secretPresent[connection.id] ? "present" : "empty"}
              </span>
            </Row>
            <Row label="Scopes" desc="Shown in full so self-hosters can see exactly what is asked for.">
              <span className="pathline">{connection.scopes.join(" · ") || "—"}</span>
            </Row>
            <Row
              label="Last sync"
              desc={connection.error ?? "The scheduler refreshes on the interval set in Appearance."}
            >
              <span className="mono-label">
                {connection.lastSyncAt ? new Date(connection.lastSyncAt).toLocaleString() : "never"}
              </span>
              <button
                className="btn"
                onClick={() => {
                  void ipc
                    .syncNow(envId, connection.id)
                    .then((n) => showToast(`Synced ${n} item${n === 1 ? "" : "s"}`))
                    .catch((e) => showToast(String(e)));
                }}
              >
                Sync now
              </button>
            </Row>
          </div>
        </div>
      ))}

      <h2 style={{ fontSize: 13, margin: "22px 0 8px" }} className="mono-label">
        Available providers
      </h2>
      <div className="card">
        <div className="card-body">
          {PROVIDERS.map((p) => (
            <Row
              key={p.id}
              label={p.label}
              desc={p.ready ? "Adapter is in." : `Adapter lands in ${p.phase}.`}
            >
              {p.adminNeeded && (
                <span className="admin-flag" title={p.adminNeeded}>
                  may need an admin
                </span>
              )}
              <button className="btn" onClick={() => addConnection(p.id, p.label, p.scopes)}>
                Add account
              </button>
            </Row>
          ))}
        </div>
      </div>
    </>
  );
}

/** One-shot secret entry. The value never leaves this component except on its
 *  way to the keychain, and there is no command that can read it back. */
function TokenField({
  label,
  onSave,
  onCancel,
}: {
  label: string;
  onSave: (token: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Row label="Token" desc={`Stored in the OS keychain for ${label}. Never written to a config file.`}>
      <input
        className="field"
        style={{ maxWidth: 320 }}
        type="password"
        autoFocus
        placeholder="Paste a token"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(value);
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <button className="btn primary" onClick={() => onSave(value)} disabled={!value.trim()}>
        Save
      </button>
      <button className="btn" onClick={onCancel}>
        Cancel
      </button>
    </Row>
  );
}

// --- AI ---------------------------------------------------------------------

const AI_ACTIONS = [
  { id: "mail.classify", label: "Real-mail filtering", note: "Classification — where 7–14B local models shine." },
  { id: "thread.summarize", label: "Summarize", note: "Summaries are cheap and private; keep them local." },
  { id: "issue.tasks", label: "Break issue into tasks", note: "Benefits from understanding your codebase." },
  { id: "mail.draft", label: "Draft email reply", note: "High-stakes wording. Defaults to Claude." },
  { id: "code.propose_fix", label: "Propose a fix", note: "Code quality matters most here. Lands in Phase 4b." },
];

function AiPanel({
  settings,
  patch,
  envId,
}: {
  settings: Settings;
  patch: PatchFn;
  envId: string;
}) {
  const showToast = useUi((s) => s.showToast);
  const [keyPresent, setKeyPresent] = useState<Record<string, boolean>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all(
      ["ai:anthropic", "ai:openai-compatible"].map(
        async (key) => [key, await ipc.secretExists(envId, key).catch(() => false)] as const,
      ),
    ).then((pairs) => setKeyPresent(Object.fromEntries(pairs)));
  }, [envId]);

  async function saveKey(key: string, value: string) {
    try {
      await ipc.secretSet(envId, key, value.trim());
      setKeyPresent((s) => ({ ...s, [key]: true }));
      setEditingKey(null);
      showToast("Stored in the keychain");
    } catch (e) {
      showToast(String(e));
    }
  }

  return (
    <>
      <h1>AI</h1>
      <p className="lede">
        AI never acts on its own. Every action produces a proposal you approve — the approval gate
        holds the credentials, the model never does. Routing defaults send cheap, private work to a
        local model and drafting or code to Claude.
      </p>

      <div className="card">
        <div className="card-head">
          <div className="grow">Providers</div>
        </div>
        <div className="card-body">
          <Row label="Default provider">
            <select
              className="field"
              style={{ width: 220 }}
              value={settings.ai.defaultProvider}
              onChange={(e) =>
                patch((d) => {
                  d.ai.defaultProvider = e.target.value;
                  return d;
                })
              }
            >
              <option value="anthropic">Anthropic API</option>
              <option value="local">Local (Ollama)</option>
              <option value="openai-compatible">OpenAI-compatible endpoint</option>
            </select>
          </Row>
          <Row
            label="Anthropic API key"
            desc="Stored in the OS keychain for this environment. Never written to a config file."
          >
            <span className="mono-label">
              {keyPresent["ai:anthropic"] ? "present" : "not set"}
            </span>
            <button
              className="btn"
              onClick={() =>
                setEditingKey(editingKey === "ai:anthropic" ? null : "ai:anthropic")
              }
            >
              {keyPresent["ai:anthropic"] ? "Replace key" : "Set key"}
            </button>
          </Row>
          {editingKey === "ai:anthropic" && (
            <TokenField
              label="the Anthropic API"
              onCancel={() => setEditingKey(null)}
              onSave={(value) => void saveKey("ai:anthropic", value)}
            />
          )}
          <Row label="Claude model" desc="Used wherever an action routes to Anthropic.">
            <select
              className="field"
              style={{ width: 220 }}
              value={settings.ai.anthropicModel ?? "claude-opus-5"}
              onChange={(e) =>
                patch((d) => {
                  d.ai.anthropicModel = e.target.value;
                  return d;
                })
              }
            >
              <option value="claude-opus-5">Claude Opus 5 — $5/$25 per Mtok</option>
              <option value="claude-sonnet-5">Claude Sonnet 5 — $3/$15</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5 — $1/$5</option>
            </select>
          </Row>
          <Row label="Local model" desc="Whatever you have pulled in Ollama.">
            <input
              className="field"
              style={{ width: 220 }}
              placeholder="llama3.1:8b"
              value={settings.ai.localModel ?? ""}
              onChange={(e) =>
                patch((d) => {
                  d.ai.localModel = e.target.value;
                  return d;
                })
              }
            />
          </Row>
          <Row label="Ollama URL" desc="Local model manager lands in Phase 4b.">
            <input
              className="field"
              style={{ width: 260 }}
              value={settings.ai.ollamaUrl}
              onChange={(e) =>
                patch((d) => {
                  d.ai.ollamaUrl = e.target.value;
                  return d;
                })
              }
            />
          </Row>
          <Row label="OpenAI-compatible URL" desc="LM Studio, llama.cpp server, vLLM.">
            <input
              className="field"
              style={{ width: 260 }}
              placeholder="http://localhost:1234/v1"
              value={settings.ai.openaiCompatibleUrl ?? ""}
              onChange={(e) =>
                patch((d) => {
                  d.ai.openaiCompatibleUrl = e.target.value || null;
                  return d;
                })
              }
            />
          </Row>
          <Row
            label="Sort ambiguous mail locally"
            desc="The rule filter decides most mail instantly and offline. With this on, the local model is asked only about the handful it is genuinely unsure about — never about mail with a clear tell, and never with the result leaving your machine. If the model is unavailable the rules simply stand."
          >
            <input
              type="checkbox"
              checked={settings.ai.classifyMailLocally}
              onChange={(e) =>
                patch((d) => {
                  d.ai.classifyMailLocally = e.target.checked;
                  return d;
                })
              }
            />
          </Row>
          <Row label="Monthly budget (USD)" desc="Soft warning only; feeds the stats board.">
            <input
              className="field"
              style={{ width: 120 }}
              type="number"
              min={0}
              value={settings.ai.monthlyBudgetUsd ?? ""}
              onChange={(e) =>
                patch((d) => {
                  d.ai.monthlyBudgetUsd = e.target.value === "" ? null : Number(e.target.value);
                  return d;
                })
              }
            />
          </Row>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="grow">Per-action routing</div>
        </div>
        <div className="card-body">
          {AI_ACTIONS.map((action) => (
            <Row key={action.id} label={action.label} desc={action.note}>
              <select
                className="field"
                style={{ width: 220 }}
                value={settings.ai.routing[action.id] ?? settings.ai.defaultProvider}
                onChange={(e) =>
                  patch((d) => {
                    d.ai.routing[action.id] = e.target.value;
                    return d;
                  })
                }
              >
                <option value="anthropic">Anthropic API</option>
                <option value="local">Local (Ollama)</option>
                <option value="openai-compatible">OpenAI-compatible</option>
              </select>
            </Row>
          ))}
        </div>
      </div>
    </>
  );
}

// --- Voice ------------------------------------------------------------------

function VoicePanel({ settings, patch }: { settings: Settings; patch: PatchFn }) {
  return (
    <>
      <h1>Voice</h1>
      <p className="lede">
        Voice is an interface to the same actions and the same approval gates — it never gets extra
        powers. Push-to-talk is itself just a keybinding. The pipeline ships in Phase 5; these
        preferences are stored now so the wiring has somewhere to read from.
      </p>

      <div className="card">
        <div className="card-body">
          <Row label="Enable voice">
            <input
              type="checkbox"
              checked={settings.voice.enabled}
              onChange={(e) =>
                patch((d) => {
                  d.voice.enabled = e.target.checked;
                  return d;
                })
              }
            />
          </Row>
          <Row
            label="Speech-to-text"
            desc="Same Whisper model family either way — local keeps audio on the machine."
          >
            <select
              className="field"
              style={{ width: 240 }}
              value={settings.voice.sttMode}
              onChange={(e) =>
                patch((d) => {
                  d.voice.sttMode = e.target.value;
                  return d;
                })
              }
            >
              <option value="local">Whisper local (whisper.cpp)</option>
              <option value="api">Whisper via OpenAI API</option>
            </select>
            <select
              className="field"
              style={{ width: 110 }}
              value={settings.voice.sttModel}
              onChange={(e) =>
                patch((d) => {
                  d.voice.sttModel = e.target.value;
                  return d;
                })
              }
            >
              <option value="tiny">tiny</option>
              <option value="base">base</option>
              <option value="small">small</option>
            </select>
          </Row>
          <Row label="Text-to-speech">
            <select
              className="field"
              style={{ width: 240 }}
              value={settings.voice.ttsEngine}
              onChange={(e) =>
                patch((d) => {
                  d.voice.ttsEngine = e.target.value;
                  return d;
                })
              }
            >
              <option value="os">OS-native voices (offline)</option>
              <option value="piper">Piper (local)</option>
              <option value="elevenlabs">ElevenLabs</option>
            </select>
          </Row>
        </div>
      </div>
    </>
  );
}

// --- Appearance -------------------------------------------------------------

/**
 * Pick a detected app, or type anything else.
 *
 * Detection is a convenience, never a gate — the free-text box stays, because
 * no catalog knows about every editor or terminal, and a `{dir}` template has
 * to remain reachable whatever is installed.
 */
function AppPicker({
  value,
  placeholder,
  load,
  onChange,
}: {
  value: string;
  placeholder: string;
  load: () => Promise<FoundApp[]>;
  onChange: (v: string) => void;
}) {
  const [found, setFound] = useState<FoundApp[]>([]);
  useEffect(() => {
    let cancelled = false;
    void load()
      .then((apps) => !cancelled && setFound(apps))
      .catch(() => !cancelled && setFound([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is a fresh
    // closure each render; the fetch is a one-shot on mount by design.
  }, []);

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <input
        className="field"
        style={{ width: 300 }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {found.map((app) => (
        <button
          key={app.id}
          className={`btn${value === app.target ? " primary" : ""}`}
          title={`Use ${app.name}`}
          onClick={() => onChange(app.target)}
        >
          {app.name}
        </button>
      ))}
      {found.length === 0 && (
        <span className="mono-label" style={{ color: "var(--ink-3)" }}>
          none detected — type one
        </span>
      )}
    </div>
  );
}

function AppearancePanel() {
  const appearance = useStore((s) => s.appearance());
  const saveAppearance = useStore((s) => s.saveAppearance);

  // Appearance is global, so this patches `global.json` rather than the
  // environment you happen to be looking at.
  const patch = (update: (draft: AppearanceSettings) => AppearanceSettings) =>
    void saveAppearance(update(structuredClone(appearance)));

  return (
    <>
      <h1>Appearance &amp; behavior</h1>
      <p className="lede">
        Theme, terminal, and how often the sync engine is allowed to work. These apply to every
        environment — your shortcuts and your theme should not change because you clicked a
        different tab.
      </p>
      <div className="card">
        <div className="card-body">
          <Row
            label="Look"
            desc="Two visual systems ship. Classic is what DDD has always looked like; Console is one monospace voice, with the tabs folded into a collapsible rail. Applied on the next window load."
          >
            <select
              className="field"
              style={{ maxWidth: 220 }}
              value={appearance.look ?? "classic"}
              onChange={(e) =>
                patch((d) => {
                  d.look = e.target.value as AppearanceSettings["look"];
                  return d;
                })
              }
            >
              <option value="classic">Classic</option>
              <option value="console">Console</option>
            </select>
          </Row>
          <Row label="Theme">
            <select
              className="field"
              style={{ width: 160 }}
              value={appearance.theme}
              onChange={(e) =>
                patch((d) => {
                  d.theme = e.target.value as AppearanceSettings["theme"];
                  return d;
                })
              }
            >
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </Row>
          <Row
            label="Terminal app"
            desc="Used by a project card's Launch button. A value containing {dir} or {cmd} is treated as a full command template instead."
          >
            <AppPicker
              value={appearance.terminalApp ?? ""}
              placeholder="iTerm · Terminal · wezterm start --cwd {dir}"
              load={ipc.terminalsList}
              onChange={(terminal) =>
                patch((d) => {
                  d.terminalApp = terminal || null;
                  return d;
                })
              }
            />
          </Row>
          <Row
            label="Editor"
            desc="Used by Open in IDE. Installed editors are detected; anything else can be typed, or given as a {dir} template."
          >
            <AppPicker
              value={appearance.editor ?? ""}
              placeholder="PhpStorm · code · zed -a {dir}"
              load={ipc.editorsList}
              onChange={(editor) =>
                patch((d) => {
                  d.editor = editor || null;
                  return d;
                })
              }
            />
          </Row>
          <Row
            label="Launch command"
            desc="What runs once the terminal is open. `claude --continue` picks the last session back up."
          >
            <input
              className="field"
              style={{ width: 240 }}
              placeholder="claude"
              value={appearance.launchCommand ?? "claude"}
              onChange={(e) =>
                patch((d) => {
                  d.launchCommand = e.target.value;
                  return d;
                })
              }
            />
          </Row>
          <Row label="Default refresh" desc="Seconds. Widgets ask the scheduler; they never poll alone.">
            <input
              className="field"
              style={{ width: 110 }}
              type="number"
              min={15}
              value={appearance.defaultRefreshSeconds}
              onChange={(e) =>
                patch((d) => {
                  d.defaultRefreshSeconds = Number(e.target.value) || 300;
                  return d;
                })
              }
            />
          </Row>
          <Row label="Hold ⌘ for hints" desc="Overlay the UI with its shortcuts while the modifier is down.">
            <input
              type="checkbox"
              checked={appearance.showShortcutHints}
              onChange={(e) =>
                patch((d) => {
                  d.showShortcutHints = e.target.checked;
                  return d;
                })
              }
            />
          </Row>
        </div>
      </div>
    </>
  );
}

// --- Keyboard ---------------------------------------------------------------

function KeyboardPanel({ keymap, envId }: { keymap: Record<string, string[]>; envId: string }) {
  const [local, setLocal] = useState(keymap);
  const [capturing, setCapturing] = useState<string | null>(null);
  const showToast = useUi((s) => s.showToast);
  const [query, setQuery] = useState("");

  const actions = useMemo(() => buildActions(), []);
  const conflicts = useMemo(() => findConflicts(local), [local]);

  // While capturing, this listener owns the keyboard — otherwise pressing ⌘K to
  // rebind ⌘K would just open the palette.
  useEffect(() => {
    if (!capturing) return;
    const actionId = capturing;
    function onKeyDown(e: KeyboardEvent) {
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const binding = e.key === "Escape" ? null : eventToBinding(e);
      const next = { ...local };
      if (binding) next[actionId] = [binding];
      setLocal(next);
      setCapturing(null);
      if (binding) void ipc.keymapSave(next).then(() => showToast("Keymap saved"));
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, local, envId, showToast]);

  const rows = actions.filter(
    (a) =>
      !query ||
      `${a.title} ${a.group}`.toLowerCase().includes(query.toLowerCase()),
  );

  async function resetToPreset() {
    setLocal(DEFAULT_KEYMAP);
    await ipc.keymapSave(DEFAULT_KEYMAP);
    showToast("Reset to the default preset");
  }

  return (
    <>
      <h1>Keyboard</h1>
      <p className="lede">
        Every action is here, and every action is reachable without the mouse. Bindings are stored
        in <code>keymap.json</code> next to this environment's layout — edit them here or in the
        file. <code>mod</code> means ⌘ on macOS and Ctrl elsewhere.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          className="field"
          style={{ maxWidth: 280 }}
          placeholder="Search actions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn" onClick={() => void resetToPreset()}>
          Reset to preset
        </button>
      </div>

      {Object.keys(conflicts).length > 0 && (
        <div className="note" style={{ borderLeftColor: "var(--warn)", marginBottom: 12 }}>
          Conflicting bindings:{" "}
          {Object.entries(conflicts)
            .map(([binding, ids]) => `${formatBinding(binding)} → ${ids.join(", ")}`)
            .join(" · ")}
          . The first one wins.
        </div>
      )}

      <div className="card">
        <div className="card-body">
          {rows.map((action) => {
            const bindings = local[action.id] ?? [];
            return (
              <Row key={action.id} label={action.title} desc={action.group}>
                {bindings.map((b) => (
                  <kbd className="kbd" key={b}>
                    {formatBinding(b)}
                  </kbd>
                ))}
                {bindings.length === 0 && <span className="mono-label">unbound</span>}
                <button
                  className="btn"
                  onClick={() => setCapturing(action.id)}
                  onKeyDown={(e) => e.preventDefault()}
                >
                  {capturing === action.id ? "Press a key…" : "Rebind"}
                </button>
              </Row>
            );
          })}
        </div>
      </div>
    </>
  );
}

// --- Data -------------------------------------------------------------------

/**
 * Carry a board somewhere else.
 *
 * §5.9 promises this as the way to copy a setup between environments. The whole
 * subtlety is on the way *in*: ids are unique across environments rather than
 * within one, so an import that kept them would make two environments share
 * tabs — see state/portable.
 */
function LayoutTransferCard({ envId }: { envId: string }) {
  // Selected whole, filtered in render: a selector that builds a new array
  // every call never compares equal, and zustand re-renders forever. React
  // says so out loud — "getSnapshot should be cached" — and then the page is
  // blank.
  const allTabs = useStore((s) => s.tabs());
  const tabs = allTabs.filter((t) => t.environmentId === envId);
  const activeTabId = useStore((s) => s.activeTabId);
  const exportTabs = useStore((s) => s.exportTabs);
  const importTabs = useStore((s) => s.importTabs);
  const environments = useStore((s) => s.environments());
  const showToast = useUi((s) => s.showToast);
  const [busy, setBusy] = useState(false);

  const envName = environments.find((e) => e.id === envId)?.name ?? envId;
  const active = tabs.find((t) => t.id === activeTabId);
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  async function write(tabIds: string[] | undefined, name: string) {
    setBusy(true);
    try {
      const path = await ipc.saveTextFile(name, exportTabs(envId, tabIds));
      if (path) showToast(`Written to ${path}`);
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function read() {
    setBusy(true);
    try {
      const text = await ipc.openTextFile();
      if (!text) return;
      const count = importTabs(envId, text);
      showToast(`${count} tab${count === 1 ? "" : "s"} added to ${envName}`);
    } catch (e) {
      // ImportError carries a sentence; anything else is shown as it came.
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div className="grow">Layouts</div>
      </div>
      <div className="card-body">
        <Row
          label="Export"
          desc="A JSON file of the tabs, their groups and their widgets. No credentials: a widget arrives unbound, and its instructions stay with the environment that holds them."
        >
          <button
            className="btn"
            disabled={busy || !active}
            onClick={() => void write(active ? [active.id] : undefined, `${slug(active?.name ?? "tab")}.json`)}
          >
            This tab
          </button>
          <button
            className="btn"
            disabled={busy || tabs.length === 0}
            onClick={() => void write(undefined, `${slug(envName)}-layout.json`)}
          >
            All {tabs.length} tabs
          </button>
        </Row>
        <Row
          label="Import"
          desc={`Adds the file's tabs to ${envName}. Nothing is replaced, and every id is minted fresh so the imported tabs are this environment's own.`}
        >
          <button className="btn" disabled={busy} onClick={() => void read()}>
            Choose a file…
          </button>
        </Row>
      </div>
    </div>
  );
}

function DataPanel({
  settings,
  patch,
  envId,
}: {
  settings: Settings;
  patch: PatchFn;
  envId: string;
}) {
  const [paths, setPaths] = useState<PathsInfo | null>(null);
  const [eventCount, setEventCount] = useState<number | null>(null);
  const showToast = useUi((s) => s.showToast);

  useEffect(() => {
    void ipc.pathsInfo(envId).then(setPaths).catch(() => setPaths(null));
    void ipc.eventsQuery(envId, { limit: 1000 }).then((rows) => setEventCount(rows.length));
  }, [envId]);

  return (
    <>
      <h1>Data</h1>
      <p className="lede">
        Everything DDD knows is on this machine, in files you can read. Zero telemetry leaves —
        the stats board is your dashboard about you.
      </p>

      <div className="card">
        <div className="card-head">
          <div className="grow">Where things live</div>
        </div>
        <div className="card-body">
          {paths ? (
            Object.entries(paths).map(([key, value]) => (
              <Row key={key} label={key.replace(/([A-Z])/g, " $1").toLowerCase()}>
                <span className="pathline">{value || "—"}</span>
              </Row>
            ))
          ) : (
            <div style={{ color: "var(--ink-3)" }}>Paths are only available in the desktop app.</div>
          )}
        </div>
      </div>

      <LayoutTransferCard envId={envId} />

      <div className="card">
        <div className="card-head">
          <div className="grow">Events</div>
        </div>
        <div className="card-body">
          <Row
            label="Log activity"
            desc="Feeds the stats board. Turning this off stops the writing, not just the charts."
          >
            <input
              type="checkbox"
              checked={settings.data.statsLoggingEnabled}
              onChange={(e) =>
                patch((d) => {
                  d.data.statsLoggingEnabled = e.target.checked;
                  return d;
                })
              }
            />
          </Row>
          <Row label="Recent events" desc="Capped sample from this environment's database.">
            <span className="mono-label">{eventCount ?? "—"}</span>
          </Row>
          <Row label="Wipe events" desc="Deletes this environment's event history. Not undoable.">
            <button
              className="btn danger"
              onClick={() => {
                void ipc.eventsClear(envId).then(() => {
                  setEventCount(0);
                  showToast("Event history cleared");
                });
              }}
            >
              Wipe
            </button>
          </Row>
        </div>
      </div>
    </>
  );
}
