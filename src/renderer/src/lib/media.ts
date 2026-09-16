import type { MediaAction, PlayerState } from "../types";

/** The player to show: the pinned one if present, else the playing one, else the first. */
export function pickActive(players: PlayerState[], pinned?: string): PlayerState | null {
  if (pinned && pinned !== "auto") {
    const p = players.find((x) => x.player === pinned);
    if (p) return p;
  }
  return players.find((p) => p.playing) ?? players[0] ?? null;
}

/** The action for the widget's single transport button: the API has one
 *  play/pause toggle, not separate play and pause verbs, so this is what the
 *  button dispatches regardless of whether the track is currently playing.
 *  ("play"/"pause" are not `MediaAction` members and would silently fall
 *  through to the volume branch on both backends — see control.ts.) */
export function toggleAction(): MediaAction {
  return "playpause";
}

/** ms → "m:ss", "" when unknown. */
export function fmtTime(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
