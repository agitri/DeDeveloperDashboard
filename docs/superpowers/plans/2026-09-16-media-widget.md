# Media Control Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `media` widget that shows the current track and controls play/pause, next, previous and volume for Spotify + Apple Music on macOS and any MPRIS player on Linux, auto-following whatever is playing. Then rebuild the app.

**Architecture:** `src/core/media/control.ts` drives players through the OS media mechanism behind the `Runner` seam, dispatching on `process.platform` (darwin → `osascript`, linux → `playerctl`, else unsupported) — the same shape as `src/core/dev/*`. Two nodeDDD-only commands (`media_state`, `media_command`); `media_state` inlines album art as a data URL via the main process `fetch` so the CSP doesn't block it. A thin `MediaWidget` polls and renders.

**Tech Stack:** Electron 44, TypeScript 5.8, vitest 5, React 19, `node:child_process` (osascript / playerctl via the Runner seam).

**Spec:** `docs/superpowers/specs/2026-09-16-media-widget-design.md`

## Global Constraints

- `src/core` never imports electron. All player access is through the `Runner` seam (`src/core/dev/run.ts`: `type Runner = (file, args) => Promise<RunResult>` where `RunResult = { stdout: string; ok: boolean }`; `execFileRunner`; `lines(output)`). Every core function takes `(… , runner: Runner = execFileRunner, platform: NodeJS.Platform = process.platform)` so tests inject a fake runner and an explicit platform, exactly like `readMachine`/`enumerate` in `src/core/dev/`.
- Never launch a player: the macOS scripts guard with `if application "X" is running`; Linux only lists live MPRIS players. Polling must not start Spotify/Music.
- Windows and any non-darwin/linux platform: `state` returns `{ supported: false, players: [], active: null }`; `command` throws `DddError`. macOS is verified here; the Linux backend is unit-tested with a fake runner (no Linux box in this environment).
- New commands are nodeDDD-only (no Rust counterpart); register them in the `HOST_COMMANDS` array in `src/main/commands.ts` so the contract test stays green; `NOT_YET_PORTED` stays `new Set([])`.
- Volume is normalised to an integer 0–100 across platforms in the API (macOS `sound volume` is already 0–100; playerctl `{{volume}}` is 0–1 → ×100; `setVolume` converts back for Linux: `value/100`).
- Album art must not rely on the renderer loading an external URL (the CSP blocks it): `media_state` fetches `artUrl` in main via `deps.sync.fetch` and returns a `data:` URL, cached in-process by a track key so a 3s poll does not refetch. `file://` art is read from disk. Art failure just omits art.
- Renderer: logic in pure tested `lib/` functions; the component is thin. Backward compatible/additive (`media` is a new kind; no existing layout changes).
- Both looks: base/classic in `global.css`, Console overrides under `[data-look="console"]` in `console.css`. No icon library.
- The Features Guide gains a `media` entry (`WIDGET_HOW.media` in `src/renderer/src/lib/guide.ts`) — the standing rule; the guide drift-guard test enforces it.
- `npm test` and `npm run typecheck` exit 0 after every task (the two live FSEvents watcher tests are a known environmental flake — judge by whether ONLY those fail; re-run them in isolation to confirm). No new npm dependency.
- Commit after every task. End every commit message with these two lines exactly:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_017ja7FNu24S9L9DM9L8p9Dr`

---

### Task 1: Core media control (macOS + Linux backends)

**Files:**
- Create: `src/core/media/control.ts`, `src/core/media/control.test.ts`

**Interfaces:**
- Produces: `Player`, `Track`, `PlayerState`, `MediaState`, `MediaAction`, `state(runner?, platform?)`, `command(player, action, value?, runner?, platform?)`.

- [ ] **Step 1: Write the failing tests**

`src/core/media/control.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { command, state } from "./control";
import type { Runner, RunResult } from "../dev/run";

const ok = (stdout: string): RunResult => ({ stdout, ok: true });
const fail = (): RunResult => ({ stdout: "", ok: false });
const TAB = "\t";
const spotifyLine = ["playing", "Song A", "Artist A", "Album A", "https://i.scdn.co/x.jpg", "210000", "12.5", "70"].join(TAB);

describe("state (darwin)", () => {
  it("parses a running Spotify and normalises duration to ms and volume to 0-100", async () => {
    const runner: Runner = async (_file, args) => {
      const script = args.join(" ");
      if (script.includes("Spotify")) return ok(spotifyLine);
      return ok(""); // Music not running
    };
    const s = await state(runner, "darwin");
    expect(s.supported).toBe(true);
    const sp = s.players.find((p) => p.player === "spotify")!;
    expect(sp.playing).toBe(true);
    expect(sp.volume).toBe(70);
    expect(sp.track?.title).toBe("Song A");
    expect(sp.track?.durationMs).toBe(210000);
    expect(s.active).toBe("spotify"); // the playing one
  });

  it("skips a player that is not running (empty output), never launching it", async () => {
    const runner: Runner = async () => ok("");
    const s = await state(runner, "darwin");
    expect(s.players).toEqual([]);
    expect(s.active).toBeNull();
  });
});

describe("state (linux)", () => {
  it("parses playerctl -a output, one player per line", async () => {
    // playerName status title artist album artUrl position(us) length(us) volume(0-1)
    const line = ["spotify", "Playing", "Song B", "Artist B", "Album B", "https://x/y.jpg", "12500000", "210000000", "0.5"].join(TAB);
    const runner: Runner = async (file) => (file === "playerctl" ? ok(line + "\n") : fail());
    const s = await state(runner, "linux");
    expect(s.supported).toBe(true);
    const p = s.players[0];
    expect(p.player).toBe("spotify");
    expect(p.playing).toBe(true);
    expect(p.volume).toBe(50); // 0.5 → 50
    expect(p.track?.durationMs).toBe(210000); // 210_000_000 us → ms
    expect(p.track?.positionMs).toBe(12500);
  });

  it("returns empty players (not an error) when playerctl is missing or nothing plays", async () => {
    const runner: Runner = async () => fail();
    const s = await state(runner, "linux");
    expect(s).toEqual({ supported: true, players: [], active: null });
  });
});

describe("state (unsupported)", () => {
  it("is unsupported on win32", async () => {
    const s = await state(async () => ok(""), "win32");
    expect(s).toEqual({ supported: false, players: [], active: null });
  });
});

describe("command", () => {
  it("darwin play/pause targets the app via osascript", async () => {
    const runner = vi.fn<Runner>(async () => ok(""));
    await command("spotify", "playpause", undefined, runner, "darwin");
    const [file, args] = runner.mock.calls[0];
    expect(file).toBe("osascript");
    expect(args.join(" ")).toContain("Spotify");
    expect(args.join(" ")).toContain("playpause");
  });

  it("darwin setVolume passes 0-100 through", async () => {
    const runner = vi.fn<Runner>(async () => ok(""));
    await command("music", "setVolume", 40, runner, "darwin");
    expect(runner.mock.calls[0][1].join(" ")).toContain("set sound volume to 40");
  });

  it("linux setVolume converts 0-100 to 0-1 for playerctl", async () => {
    const runner = vi.fn<Runner>(async () => ok(""));
    await command("spotify", "setVolume", 50, runner, "linux");
    const [file, args] = runner.mock.calls[0];
    expect(file).toBe("playerctl");
    expect(args).toEqual(["-p", "spotify", "volume", "0.5"]);
  });

  it("refuses on an unsupported platform", async () => {
    await expect(command("spotify", "next", undefined, async () => ok(""), "win32")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/media/control.test.ts` — expected: cannot resolve `./control`.

- [ ] **Step 3: Write the module**

`src/core/media/control.ts`:

```ts
import { DddError } from "../error";
import { execFileRunner, lines, type Runner } from "../dev/run";

export type Player = string; // "spotify" | "music" on macOS; an MPRIS player name on Linux
export interface Track {
  title: string;
  artist: string;
  album: string;
  artUrl?: string;
  positionMs?: number;
  durationMs?: number;
}
export interface PlayerState {
  player: Player;
  label: string;
  playing: boolean;
  volume: number | null; // 0-100, or null when unknown
  track?: Track;
}
export interface MediaState {
  supported: boolean;
  players: PlayerState[];
  active: Player | null;
}
export type MediaAction = "playpause" | "next" | "previous" | "setVolume";

const TAB = "\t";
const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/** Which player the widget follows by default: the one playing, else the first. */
function autoActive(players: PlayerState[]): Player | null {
  return players.find((p) => p.playing)?.player ?? players[0]?.player ?? null;
}

// ---- macOS (osascript) ----

const MAC_APP: Record<string, string> = { spotify: "Spotify", music: "Music" };

// One guarded script per player: returns "" if not running (never launches it).
function macScript(app: string): string {
  const art = app === "Spotify" ? "(artwork url of t)" : '""';
  return [
    `if application "${app}" is running then`,
    `  tell application "${app}"`,
    `    try`,
    `      set st to player state as text`,
    `      set t to current track`,
    `      return st & tab & (name of t) & tab & (artist of t) & tab & (album of t) & tab & ${art} & tab & ((duration of t) as text) & tab & ((player position) as text) & tab & ((sound volume) as text)`,
    `    on error`,
    `      return "stopped"`,
    `    end try`,
    `  end tell`,
    `else`,
    `  return ""`,
    `end if`,
  ].join("\n");
}

function parseMacLine(player: string, out: string): PlayerState | null {
  const line = out.trim();
  if (line === "") return null;
  const f = line.split(TAB);
  const st = (f[0] ?? "").toLowerCase();
  const durRaw = num(f[5]);
  // Spotify duration is ms; Music duration is seconds.
  const durationMs = durRaw === undefined ? undefined : player === "spotify" ? durRaw : Math.round(durRaw * 1000);
  const posSec = num(f[6]);
  const state: PlayerState = {
    player,
    label: MAC_APP[player] ?? player,
    playing: st === "playing",
    volume: num(f[7]) ?? null,
  };
  if (f[1]) {
    state.track = {
      title: f[1] ?? "",
      artist: f[2] ?? "",
      album: f[3] ?? "",
      artUrl: f[4] && f[4].startsWith("http") ? f[4] : undefined,
      durationMs,
      positionMs: posSec === undefined ? undefined : Math.round(posSec * 1000),
    };
  }
  return state;
}

async function macState(runner: Runner): Promise<PlayerState[]> {
  const players: PlayerState[] = [];
  for (const [key, app] of Object.entries(MAC_APP)) {
    const res = await runner("osascript", ["-e", macScript(app)]);
    if (!res.ok) continue;
    const p = parseMacLine(key, res.stdout);
    if (p) players.push(p);
  }
  return players;
}

async function macCommand(runner: Runner, player: Player, action: MediaAction, value?: number): Promise<void> {
  const app = MAC_APP[player] ?? "Spotify";
  const verb =
    action === "playpause" ? "playpause"
    : action === "next" ? "next track"
    : action === "previous" ? "previous track"
    : `set sound volume to ${Math.round(value ?? 0)}`;
  await runner("osascript", ["-e", `tell application "${app}" to ${verb}`]);
}

// ---- Linux (playerctl / MPRIS) ----

const PC_FORMAT =
  "{{playerName}}\t{{status}}\t{{title}}\t{{artist}}\t{{album}}\t{{mpris:artUrl}}\t{{position}}\t{{mpris:length}}\t{{volume}}";

function parsePlayerctl(out: string): PlayerState[] {
  const players: PlayerState[] = [];
  for (const line of lines(out)) {
    if (line.trim() === "") continue;
    const f = line.split(TAB);
    const name = f[0] ?? "";
    if (name === "") continue;
    const posUs = num(f[6]);
    const lenUs = num(f[7]);
    const vol = num(f[8]);
    const state: PlayerState = {
      player: name,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      playing: (f[1] ?? "").toLowerCase() === "playing",
      volume: vol === undefined ? null : Math.round(vol * 100),
    };
    if (f[2]) {
      state.track = {
        title: f[2] ?? "",
        artist: f[3] ?? "",
        album: f[4] ?? "",
        artUrl: f[5] && f[5] !== "" ? f[5] : undefined,
        positionMs: posUs === undefined ? undefined : Math.round(posUs / 1000),
        durationMs: lenUs === undefined ? undefined : Math.round(lenUs / 1000),
      };
    }
    players.push(state);
  }
  return players;
}

async function linuxState(runner: Runner): Promise<PlayerState[]> {
  const res = await runner("playerctl", ["-a", "metadata", "--format", PC_FORMAT]);
  if (!res.ok) return []; // playerctl missing or no players — an empty answer, not an error
  return parsePlayerctl(res.stdout);
}

async function linuxCommand(runner: Runner, player: Player, action: MediaAction, value?: number): Promise<void> {
  const args =
    action === "playpause" ? ["-p", player, "play-pause"]
    : action === "next" ? ["-p", player, "next"]
    : action === "previous" ? ["-p", player, "previous"]
    : ["-p", player, "volume", String((value ?? 0) / 100)];
  await runner("playerctl", args);
}

// ---- dispatch ----

export async function state(runner: Runner = execFileRunner, platform: NodeJS.Platform = process.platform): Promise<MediaState> {
  if (platform === "darwin") {
    const players = await macState(runner);
    return { supported: true, players, active: autoActive(players) };
  }
  if (platform === "linux") {
    const players = await linuxState(runner);
    return { supported: true, players, active: autoActive(players) };
  }
  return { supported: false, players: [], active: null };
}

export async function command(
  player: Player,
  action: MediaAction,
  value?: number,
  runner: Runner = execFileRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "darwin") return macCommand(runner, player, action, value);
  if (platform === "linux") return linuxCommand(runner, player, action, value);
  throw DddError.config("media control is not supported on this platform");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/core/media/control.test.ts` — expected: PASS. (Confirm `DddError.config` is the right constructor by reading `src/core/error.ts`; adjust if the method name differs.)

- [ ] **Step 5: Commit**

```bash
git add src/core/media/control.ts src/core/media/control.test.ts
git commit -m "feat(media): macOS + Linux media control behind the Runner seam"
```

---

### Task 2: The commands and IPC wrappers

**Files:**
- Modify: `src/main/commands.ts` (add `media_state`, `media_command`, `HOST_COMMANDS`), `src/main/commands.test.ts` (allowed-extras if needed), `src/renderer/src/lib/ipc.ts`

**Interfaces:**
- Consumes: `mediaControl.state`/`command`, `deps.sync.fetch`.
- Produces: `media_state({}): MediaState`, `media_command({player, action, value?}): void`; `ipc.mediaState()`, `ipc.mediaCommand(player, action, value?)`.

- [ ] **Step 1: Add the commands**

In `src/main/commands.ts`, import `* as mediaControl from "../core/media/control"`. Add:

```ts
    media_state: async () => {
      const s = await mediaControl.state();
      const active = s.players.find((p) => p.player === s.active);
      const url = active?.track?.artUrl;
      if (url) {
        const dataUrl = await artDataUrl(url, deps.sync.fetch); // see Step 2
        if (dataUrl && active?.track) active.track.artUrl = dataUrl;
      }
      return s;
    },
    media_command: async ({ player, action, value }) => {
      await mediaControl.command(String(player), action as mediaControl.MediaAction, value === undefined ? undefined : Number(value));
    },
```

Add `"media_state"` and `"media_command"` to `HOST_COMMANDS` (the mechanism Task-1-of-earlier-plans used for `repo_changes_since`). Confirm `commands.test.ts` passes; if it forbids extras, they go in the same allowed-extras array.

- [ ] **Step 2: Album-art → data URL, cached by track**

Add a small module-scope helper in `commands.ts` (or `src/main/art.ts`): `async function artDataUrl(url: string, fetch: typeof globalThis.fetch): Promise<string | null>`. For an `http(s)` URL, fetch it, read the bytes, and return `data:<contentType>;base64,<...>`; for a `file://` URL, read the file from disk. Cache the last resolved `{ url, dataUrl }` in a module variable (or a tiny Map capped at a few entries) keyed by the source URL, so a 3-second poll of an unchanged track does not refetch. Any error returns `null` (art is best-effort). Keep the fetch timeout short.

- [ ] **Step 3: Renderer IPC wrappers**

In `src/renderer/src/lib/ipc.ts` (match the file's style; non-coalesced):

```ts
  mediaState(): Promise<MediaState> {
    if (!isNative) return Promise.resolve({ supported: false, players: [], active: null });
    return call("media_state");
  },
  mediaCommand(player: string, action: string, value?: number): Promise<void> {
    if (!isNative) return Promise.resolve();
    return call("media_command", { player, action, value });
  },
```

Add a matching `MediaState` type import (declare a renderer twin in `src/renderer/src/types/index.ts` mirroring the core `MediaState`/`PlayerState`/`Track`, same shape — do not import across the boundary).

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck` and `npx vitest run src/main/commands.test.ts` — expected: clean.

```bash
git add src/main/commands.ts src/main/commands.test.ts src/renderer/src/lib/ipc.ts src/renderer/src/types/index.ts
git commit -m "feat(media): media_state (with inlined art) and media_command commands"
```

---

### Task 3: The Media widget

**Files:**
- Create: `src/renderer/src/widgets/MediaWidget.tsx`, `src/renderer/src/lib/media.ts`, `src/renderer/src/lib/media.test.ts`
- Modify: `src/renderer/src/widgets/registry.tsx`, `src/renderer/src/lib/guide.ts`, `src/renderer/src/styles/global.css`, `src/renderer/src/styles/console.css`

**Interfaces:**
- Consumes: `ipc.mediaState`/`mediaCommand`, the `MediaState` twin type.
- Produces: `pickActive(players, pinned)`, `fmtTime(ms)`, the `media` widget kind.

- [ ] **Step 1: Pure helpers + tests**

`src/renderer/src/lib/media.ts`:

```ts
import type { PlayerState } from "../types";

/** The player to show: the pinned one if present, else the playing one, else the first. */
export function pickActive(players: PlayerState[], pinned?: string): PlayerState | null {
  if (pinned && pinned !== "auto") {
    const p = players.find((x) => x.player === pinned);
    if (p) return p;
  }
  return players.find((p) => p.playing) ?? players[0] ?? null;
}

/** ms → "m:ss", "" when unknown. */
export function fmtTime(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
```

`src/renderer/src/lib/media.test.ts`: cover `pickActive` (pinned present/absent → falls back to playing → first → null on empty) and `fmtTime` (0 → "0:00", 210000 → "3:30", undefined → "").

- [ ] **Step 2: The widget**

`src/renderer/src/widgets/MediaWidget.tsx` — read `AboutWidget.tsx`/`ProductsWidget.tsx` for the `WidgetViewProps` shape, `firstLoad`, polling and the detail idiom. Poll `ipc.mediaState()` on an interval (`widget.refreshSeconds ?? 3`). Compute `const shown = pickActive(state.players, String(widget.config.player ?? "auto"))`. Render:
- when `!state.supported`: an empty state "Media control is macOS/Linux only";
- when supported but no `shown`: "No player detected — open Spotify or Apple Music (on Linux, install playerctl)";
- otherwise: the album art (`shown.track.artUrl` as an `<img>` — it is a data URL, CSP-safe), title/artist/album, transport buttons (play/pause showing pause when `shown.playing`, next, previous → `ipc.mediaCommand(shown.player, …)` then refresh), and, when `shown.volume !== null`, a range input calling `mediaCommand(shown.player, "setVolume", n)`. A small select sets `config.player` to `"auto"` or a specific `player` (via `updateWidget`).

Keep it thin: the button/slider handlers call `mediaCommand` then trigger a refresh; no business logic beyond `pickActive`/`fmtTime`.

- [ ] **Step 3: Register + guide + styles**

In `registry.tsx` add `{ kind: "media", name: "Media", description: "Now playing: control Spotify or Apple Music (and MPRIS players on Linux).", source: "local", needsConnection: false, flush: true, View: MediaWidget }` (import `MediaWidget`); NOT in `PRESETS`. In `lib/guide.ts` add `media: { how: "Play/pause, skip and set volume for whatever is playing; auto-follows Spotify or Apple Music.", needs: "macOS, or Linux with playerctl." }` to `WIDGET_HOW`. Add `.media-*` styles (art, transport row, volume slider) to `global.css` and `[data-look="console"]` overrides in `console.css`, existing tokens only.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck` and `npx vitest run src/renderer/src/lib/media.test.ts src/renderer/src/lib/guide.test.ts` — expected: clean (guide drift-guard now covers `media`).

```bash
git add src/renderer/src/widgets/MediaWidget.tsx src/renderer/src/lib/media.ts src/renderer/src/lib/media.test.ts src/renderer/src/widgets/registry.tsx src/renderer/src/lib/guide.ts src/renderer/src/styles/global.css src/renderer/src/styles/console.css
git commit -m "feat(widgets): the Media now-playing widget"
```

---

### Task 4: Verification, README, and a rebuilt app

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Full verification**

Run: `npm test` (capture the EXIT CODE — if the FSEvents watcher tests print FAIL, re-run `src/core/watcher.test.ts` and `src/main/commands.test.ts` in isolation and confirm they pass; only those two may flake), `npm run typecheck`, and `npm run build`. All green.

- [ ] **Step 2: README**

In `README.md`'s "Beyond the port" section, add the Media widget: now-playing display and transport/volume control for Spotify + Apple Music on macOS and MPRIS players on Linux, no login required; Windows not supported.

- [ ] **Step 3: Rebuild the app**

Run: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir 2>&1 | tail -15` — expected: `dist/mac-arm64/nodeDDD.app` is rebuilt. Confirm the bundle exists and report its path.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): the media control widget"
```
