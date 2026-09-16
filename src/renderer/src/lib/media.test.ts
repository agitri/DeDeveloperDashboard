import { describe, expect, it } from "vitest";
import { fmtTime, pickActive, toggleAction } from "./media";
import type { PlayerState } from "../types";

const player = (over: Partial<PlayerState> = {}): PlayerState => ({
  player: "spotify",
  label: "Spotify",
  playing: false,
  volume: null,
  ...over,
});

describe("pickActive", () => {
  it("returns the pinned player when it is present", () => {
    const players = [player({ player: "spotify" }), player({ player: "apple-music" })];
    expect(pickActive(players, "apple-music")?.player).toBe("apple-music");
  });

  it("falls back to the playing player when the pinned one is not present", () => {
    const players = [
      player({ player: "spotify", playing: false }),
      player({ player: "apple-music", playing: true }),
    ];
    expect(pickActive(players, "missing")?.player).toBe("apple-music");
  });

  it("falls back to the playing player when nothing is pinned", () => {
    const players = [
      player({ player: "spotify", playing: false }),
      player({ player: "apple-music", playing: true }),
    ];
    expect(pickActive(players)?.player).toBe("apple-music");
  });

  it("treats \"auto\" the same as no pin", () => {
    const players = [
      player({ player: "spotify", playing: false }),
      player({ player: "apple-music", playing: true }),
    ];
    expect(pickActive(players, "auto")?.player).toBe("apple-music");
  });

  it("falls back to the first player when nobody is playing", () => {
    const players = [player({ player: "spotify" }), player({ player: "apple-music" })];
    expect(pickActive(players)?.player).toBe("spotify");
  });

  it("returns null when there are no players", () => {
    expect(pickActive([])).toBeNull();
  });
});

describe("toggleAction", () => {
  // Locks down the play/pause fix: the widget's transport toggle must always
  // dispatch the one real API verb, "playpause" — not "play"/"pause", which
  // are not `MediaAction` members and silently zeroed the volume instead.
  it("always dispatches \"playpause\"", () => {
    expect(toggleAction()).toBe("playpause");
  });
});

describe("fmtTime", () => {
  it("formats zero as 0:00", () => {
    expect(fmtTime(0)).toBe("0:00");
  });

  it("formats minutes and seconds, zero-padded", () => {
    expect(fmtTime(210000)).toBe("3:30");
  });

  it("returns empty string when unknown", () => {
    expect(fmtTime(undefined)).toBe("");
  });

  it("returns empty string for negative or non-finite values", () => {
    expect(fmtTime(-1)).toBe("");
    expect(fmtTime(Number.NaN)).toBe("");
    expect(fmtTime(Number.POSITIVE_INFINITY)).toBe("");
  });
});
