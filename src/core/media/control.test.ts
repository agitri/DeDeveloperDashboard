import { describe, expect, it, vi } from "vitest";
import { command, state } from "./control";
import type { Runner, RunResult } from "../dev/run";

const ok = (stdout: string): RunResult => ({ stdout, ok: true });
const fail = (): RunResult => ({ stdout: "", ok: false });
// \x1f (unit separator): the field delimiter both backends now use, chosen
// because it cannot occur in track metadata (unlike a tab).
const SEP = "\x1f";
const spotifyLine = ["playing", "Song A", "Artist A", "Album A", "https://i.scdn.co/x.jpg", "210000", "12.5", "70"].join(SEP);

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

  it("falls back to the first present player when none are playing", async () => {
    const spotifyStopped = ["stopped", "Song A", "Artist A", "Album A", "", "210000", "0", "50"].join(SEP);
    const musicStopped = ["stopped", "Song B", "Artist B", "Album B", "", "180000", "0", "60"].join(SEP);
    const runner: Runner = async (_file, args) => {
      const script = args.join(" ");
      if (script.includes("Spotify")) return ok(spotifyStopped);
      if (script.includes("Music")) return ok(musicStopped);
      return ok("");
    };
    const s = await state(runner, "darwin");
    expect(s.players.map((p) => p.player)).toEqual(["spotify", "music"]);
    expect(s.players.every((p) => !p.playing)).toBe(true);
    expect(s.active).toBe("spotify"); // first present, since nobody is playing
  });
});

describe("state (linux)", () => {
  it("parses playerctl -a output, one player per line", async () => {
    // playerName status title artist album artUrl position(us) length(us) volume(0-1)
    const line = ["spotify", "Playing", "Song B", "Artist B", "Album B", "https://x/y.jpg", "12500000", "210000000", "0.5"].join(SEP);
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

  it("clamps setVolume above 100 on both backends", async () => {
    const macRunner = vi.fn<Runner>(async () => ok(""));
    await command("music", "setVolume", 150, macRunner, "darwin");
    expect(macRunner.mock.calls[0][1].join(" ")).toContain("set sound volume to 100");

    const linuxRunner = vi.fn<Runner>(async () => ok(""));
    await command("spotify", "setVolume", 150, linuxRunner, "linux");
    expect(linuxRunner.mock.calls[0][1]).toEqual(["-p", "spotify", "volume", "1"]);
  });

  it("clamps setVolume below 0 on both backends", async () => {
    const macRunner = vi.fn<Runner>(async () => ok(""));
    await command("music", "setVolume", -20, macRunner, "darwin");
    expect(macRunner.mock.calls[0][1].join(" ")).toContain("set sound volume to 0");

    const linuxRunner = vi.fn<Runner>(async () => ok(""));
    await command("spotify", "setVolume", -20, linuxRunner, "linux");
    expect(linuxRunner.mock.calls[0][1]).toEqual(["-p", "spotify", "volume", "0"]);
  });

  it("darwin next/previous send the matching track-transport argv", async () => {
    const runner = vi.fn<Runner>(async () => ok(""));
    await command("music", "next", undefined, runner, "darwin");
    expect(runner.mock.calls[0]![1].join(" ")).toContain("next track");

    await command("music", "previous", undefined, runner, "darwin");
    expect(runner.mock.calls[1]![1].join(" ")).toContain("previous track");
  });

  it("linux next/previous send the matching playerctl argv", async () => {
    const runner = vi.fn<Runner>(async () => ok(""));
    await command("spotify", "next", undefined, runner, "linux");
    expect(runner.mock.calls[0]![1]).toEqual(["-p", "spotify", "next"]);

    await command("spotify", "previous", undefined, runner, "linux");
    expect(runner.mock.calls[1]![1]).toEqual(["-p", "spotify", "previous"]);
  });

  it("throws for an unknown mac player instead of defaulting to Spotify", async () => {
    const runner = vi.fn<Runner>(async () => ok(""));
    await expect(command("not-a-real-player", "playpause", undefined, runner, "darwin")).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses on an unsupported platform", async () => {
    await expect(command("spotify", "next", undefined, async () => ok(""), "win32")).rejects.toThrow();
  });
});
