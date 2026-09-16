# Media Control Widget — Design

**Status:** approved for planning (2026-09-16)
**Author:** nodeDDD post-port UX phase, part 3
**Depends on:** the completed port and the dev-servers/products platform-command patterns it established.

## Goal

A "Now Playing" widget that shows the currently-playing track and controls playback of the scriptable desktop players — **Spotify** and **Apple Music** on macOS, and any **MPRIS** player on Linux (Spotify, browsers, VLC, Tidal's Linux app, …). Controls: play/pause, next, previous, volume, and the current title/artist/album with album art where available. The widget auto-follows whichever player is playing, with an option to pin one.

No login, no OAuth, no tokens: control goes through the OS's own media mechanism behind the app's existing subprocess seam, exactly like dev-server scanning and products.

## Non-goals

- **Windows** is out of scope. Its media-session API (GlobalSystemMediaTransportControls / WinRT) has no built-in CLI and needs a native addon or bundled helper; the widget shows a "not supported on this platform" state there. Deferred.
- **Tidal on macOS** is not controllable (no AppleScript dictionary; macOS 15.4+ locked down the private now-playing framework). On Linux, Tidal's app is reachable *if* it implements MPRIS — no special-casing needed.
- **Apple Music album art** is raw image data over AppleScript (not a URL); art for Apple Music is a best-effort follow-up. Spotify (macOS) and MPRIS `mpris:artUrl` (Linux) provide art from the start.
- No playlist browsing, search, or library management. Transport + current track + volume only.
- No launching of a player: polling never starts an app that isn't already running.

## Architecture

The widget and commands are platform-agnostic; only the core backend differs per OS, dispatched on `process.platform` — the same shape as `src/core/dev/*` (`readMachine(runner = execFileRunner, platform = process.platform)`).

**Core — `src/core/media/control.ts` (never imports electron):**

```ts
export type Player = "spotify" | "music" | string; // string = an MPRIS player name on Linux
export interface Track { title: string; artist: string; album: string; artUrl?: string; positionMs?: number; durationMs?: number; }
export interface PlayerState { player: Player; label: string; playing: boolean; volume: number | null; track?: Track; }
export interface MediaState { supported: boolean; players: PlayerState[]; active: Player | null; }
export type MediaAction = "playpause" | "next" | "previous" | "setVolume";

export async function state(runner?: Runner, platform?: NodeJS.Platform): Promise<MediaState>;
export async function command(player: Player, action: MediaAction, value: number | undefined, runner?: Runner, platform?: NodeJS.Platform): Promise<void>;
```

- **darwin backend** (`osascript`): for Spotify and Apple Music, a single guarded AppleScript per player — `if application "X" is running then …` so it never launches — returning a delimited line of `player state`, track name/artist/album, (Spotify) `artwork url`, duration, position, and `sound volume`. Control via `tell application "X" to playpause / next track / previous track / set sound volume to N`. Pure parsers `parseAppleLine(...)` per player.
- **linux backend** (`playerctl`): `playerctl -a metadata --format '<delimited>'` lists every MPRIS player with status/title/artist/album/`mpris:artUrl`/position/`mpris:length`/volume; control via `playerctl -p <player> play-pause|next|previous|volume <0..1>`. Pure parser `parsePlayerctl(...)`. If `playerctl` is not installed, `state` returns `{ supported: true, players: [], active: null }` and the widget shows an "install playerctl" hint (like dev-servers needing `lsof`). Raw `dbus-send`/`gdbus` is a documented future fallback, not built now.
- **other platforms**: `state` returns `{ supported: false, players: [], active: null }`; `command` throws `DddError` "media control is not supported on this platform".
- **active pick** (pure, `pickActive(players, pinned)`): the pinned player if set and present; else the one that is `playing`; else the first present. Auto-follow falls out of this.

**Main — `src/main/commands.ts`:**
- `media_state({}): MediaState` → `mediaControl.state()`, then for the active track's `artUrl` (http/https), fetch it once via `deps.sync.fetch` and inline it as a `data:` URL (so the strict CSP doesn't block it), cached in-process by a track key so a 3-second poll doesn't refetch. `file://` art (some MPRIS players) is read from disk to a data URL. Failure to fetch art just omits it.
- `media_command({ player, action, value }): void` → `mediaControl.command(...)`.
- Both added to `HOST_COMMANDS` (nodeDDD-only; `NOT_YET_PORTED` stays empty).

**Renderer:**
- `src/renderer/src/lib/ipc.ts`: `mediaState()`, `mediaCommand(player, action, value?)`, with `!isNative` fallbacks.
- `src/renderer/src/widgets/MediaWidget.tsx` (kind `media`): polls `media_state` (default `refreshSeconds` ~3), renders the active player's track + art, transport buttons (play/pause reflects `playing`), and a volume slider; a small picker sets `config.player = "auto" | <player>`. Empty states: not supported → "Media control is macOS/Linux only"; supported but nothing running → "Open a player" (Linux adds the playerctl hint when the list is empty).
- `src/renderer/src/lib/media.ts` (pure, tested): `pickActive` re-exported for the widget, plus any display formatting (e.g. `position/duration` → `m:ss`).
- `registry.tsx`: register `media` (source `"local"`, `needsConnection: false`); NOT in `PRESETS`.
- `src/renderer/src/lib/guide.ts`: a `WIDGET_HOW.media` entry (the guide drift-guard requires it — the standing rule that new features update the guide).
- `styles/global.css` + `console.css`: transport row, volume slider, now-playing layout; both looks, existing tokens.

## Data flow

```
widget mount → poll media_state every ~3s
  main: mediaControl.state(execFileRunner, process.platform)
        darwin → osascript per running player;  linux → playerctl -a
        pickActive(players, — ) → active
        art: active.track.artUrl → deps.sync.fetch → data: URL (cached by track key)
  widget: pickActive(players, config.player) → render track + transport + volume
transport click / volume drag → media_command(player, action, value)
        → osascript `tell application …` (mac) / `playerctl -p …` (linux)
```

## Errors and edge cases

- A player that is not running is never launched (macOS `is running` guard; Linux only lists live MPRIS players).
- `playerctl` absent → empty list + hint, not an error.
- Non-macOS/Linux → `supported: false`, widget shows the platform note; `media_command` refuses.
- A player exposing no volume (`{{volume}}` unsupported) → `volume: null`, slider hidden/disabled for it.
- osascript/playerctl failure on a single call → that player is omitted (the run seam never rejects), the rest still show.
- Album art fetch failure or CSP edge → art omitted, everything else renders.

## Testing

- Core: `src/core/media/control.test.ts` — `parseAppleLine`/`parsePlayerctl` map delimited runner output into `PlayerState` (playing/paused, volume, track, art); `state` dispatches by platform (fake runner + explicit `platform` arg) and returns `supported:false` off-Unix; `pickActive` covers pinned/playing/first/empty; `command` builds the right argv per platform (assert the `osascript -e` script text and the `playerctl` args) and refuses off-platform. No real player, no real network.
- Renderer: `src/renderer/src/lib/media.test.ts` — `pickActive` and the time formatter.
- `npm test` and `npm run typecheck` exit 0 (the two FSEvents watcher tests are a known environmental flake — judge by whether only those fail); `npm run build` clean.

## Delivery

- One spec (this file), one plan, executed subagent-driven with a final whole-branch review and one fix wave, then merged to main locally.
- The Features Guide gains a media entry.
- **Final step: rebuild the app** (`npm run dist:dir`) so the widget is runnable, per the standing "rebuild to show new features" preference. macOS is verified here end to end; the Linux backend is unit-tested with a fake runner and validated by the user on a Linux machine.
