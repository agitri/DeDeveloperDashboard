import { useCallback, useEffect, useState } from "react";
import { Empty } from "../components/Status";
import { ipc } from "../lib/ipc";
import { fmtTime, pickActive, toggleAction } from "../lib/media";
import { useStore } from "../state/store";
import { useRemembered } from "../state/remembered";
import { firstLoad } from "../state/timing";
import type { MediaAction, MediaState } from "../types";
import type { WidgetViewProps } from "./registry";

const EMPTY: MediaState = { supported: false, players: [], active: null };

/**
 * What is playing right now, wherever it is playing — Spotify, Apple Music,
 * or (on Linux) anything speaking MPRIS through playerctl.
 *
 * There is nothing to sync here: this is a live read of the OS, the same
 * shape as Dev servers. "Auto" follows whichever player is actually making
 * noise; pinning one keeps the widget on it even while it is paused.
 */
export function MediaWidget({ widget }: WidgetViewProps) {
  const updateWidget = useStore((s) => s.updateWidget);
  const [state, setState] = useRemembered<MediaState>(`media:${widget.id}`, EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await firstLoad("media", () => ipc.mediaState()));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }, [setState]);

  useEffect(() => {
    void refresh();
    const seconds = widget.refreshSeconds ?? 3;
    const timer = setInterval(() => void refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [refresh, widget.refreshSeconds]);

  const pinned = typeof widget.config.player === "string" ? widget.config.player : "auto";
  const shown = pickActive(state.players, pinned);
  // The picker's <select> must always resolve to one of its own options —
  // fall back to "auto" once the pinned player is no longer live, rather
  // than rendering blank.
  const pinnedIsLive = pinned !== "auto" && state.players.some((p) => p.player === pinned);

  const setPinned = useCallback(
    (player: string) => {
      updateWidget(widget.id, { config: { ...widget.config, player } });
    },
    [updateWidget, widget.id, widget.config],
  );

  const command = useCallback(
    async (action: MediaAction, value?: number) => {
      if (!shown) return;
      try {
        await ipc.mediaCommand(shown.player, action, value);
      } catch (e) {
        setError(String(e));
      } finally {
        await refresh();
      }
    },
    [shown, refresh],
  );

  if (error) {
    return <Empty title="Could not read what is playing" body={error} />;
  }

  if (!loaded) return null;

  if (!state.supported) {
    return <Empty title="Media control is macOS/Linux only" />;
  }

  return (
    <div className="media-widget">
      {state.players.length > 1 && (
        <div className="media-picker">
          <select className="field" value={pinnedIsLive ? pinned : "auto"} onChange={(e) => setPinned(e.target.value)}>
            <option value="auto">Auto</option>
            {state.players.map((p) => (
              <option key={p.player} value={p.player}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {!shown ?
        <Empty title="No player detected — open Spotify or Apple Music (on Linux, install playerctl)" />
      : <div className="media-body">
          <div className="media-art">
            {shown.track?.artUrl ?
              <img src={shown.track.artUrl} alt="" />
            : <div className="media-art-fallback">♪</div>}
          </div>

          <div className="media-info">
            <div className="media-title">{shown.track?.title || "—"}</div>
            <div className="media-sub ink-2">{shown.track?.artist || ""}</div>
            <div className="media-sub ink-3">{shown.track?.album || ""}</div>
            {shown.track?.durationMs !== undefined && (
              <div className="media-time ink-3">
                {fmtTime(shown.track?.positionMs)} / {fmtTime(shown.track?.durationMs)}
              </div>
            )}
          </div>

          <div className="media-transport">
            <button className="btn sm" title="Previous" onClick={() => void command("previous")}>
              ⏮
            </button>
            <button className="btn sm" title={shown.playing ? "Pause" : "Play"} onClick={() => void command(toggleAction())}>
              {shown.playing ? "⏸" : "▶"}
            </button>
            <button className="btn sm" title="Next" onClick={() => void command("next")}>
              ⏭
            </button>
          </div>

          {shown.volume !== null && (
            <div className="media-volume">
              <span className="mono-label">vol</span>
              <input
                type="range"
                min={0}
                max={100}
                value={shown.volume}
                onChange={(e) => void command("setVolume", Number(e.target.value))}
              />
              <span className="media-volume-value ink-3">{shown.volume}</span>
            </div>
          )}
        </div>
      }
    </div>
  );
}
