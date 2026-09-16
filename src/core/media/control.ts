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
