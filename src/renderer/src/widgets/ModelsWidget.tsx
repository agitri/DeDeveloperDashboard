import { useCallback, useEffect, useRef, useState } from "react";
import { Empty } from "../components/Status";
import { ipc } from "../lib/ipc";
import { fmtBytes, moveQueue, percent } from "../lib/models";
import { useStore } from "../state/store";
import { useRemembered } from "../state/remembered";
import { firstLoad } from "../state/timing";
import type { LocalModel, ModelMoveProgress, ModelScan } from "../types";
import type { WidgetViewProps } from "./registry";

const EMPTY: ModelScan = { stores: [], totalBytes: 0 };

interface Moved {
  name: string;
  destination: string;
}

/**
 * Every model the local runtimes downloaded — Ollama, the Hugging Face hub
 * (which MLX, vLLM and transformers all read), LM Studio, llama.cpp, Jan,
 * GPT4All — with its size, and a Move on each row that takes it physically out
 * of the runtime's store into a folder of your choosing, one folder per model,
 * so deleting it later is a Finder job.
 *
 * Nothing here polls: a scan reads the disk on mount, after every move, and on
 * the refresh button. The destination is `widget.config.dest`; a move that
 * would clobber something, run out of space, or land inside the store it came
 * from is refused by the core and shown on the row.
 */
export function ModelsWidget({ widget }: WidgetViewProps) {
  const updateWidget = useStore((s) => s.updateWidget);
  const [scan, setScan] = useRemembered<ModelScan>(`models:${widget.id}`, EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<ModelMoveProgress | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [moved, setMoved] = useState<Moved[]>([]);
  const movedIds = useRef(new Set<string>());
  const cancelAll = useRef(false);

  const dest = typeof widget.config.dest === "string" ? widget.config.dest : "";

  const refresh = useCallback(async () => {
    try {
      setScan(await firstLoad("models", () => ipc.modelsScan()));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }, [setScan]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let off: (() => void) | undefined;
    void ipc.onModelsProgress((p) => setProgress(p)).then((unsub) => (off = unsub));
    return () => off?.();
  }, []);

  const pickDest = useCallback(async () => {
    const chosen = await ipc.pickDirectory();
    if (chosen) updateWidget(widget.id, { config: { ...widget.config, dest: chosen } });
    return chosen;
  }, [updateWidget, widget.id, widget.config]);

  const moveOne = useCallback(async (m: LocalModel, to: string): Promise<boolean> => {
    setBusy(m.id);
    setProgress({ id: m.id, phase: "copy", bytesDone: 0, bytesTotal: m.bytes });
    setRowError(null);
    try {
      const out = await ipc.modelsMove(m.id, to);
      movedIds.current.add(m.id);
      setMoved((list) => [{ name: m.name, destination: out.destination }, ...list].slice(0, 8));
      return true;
    } catch (e) {
      setRowError({ id: m.id, text: String(e) });
      return false;
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  const runOne = useCallback(
    async (m: LocalModel) => {
      setConfirming(null);
      const to = dest || (await pickDest());
      if (!to) return;
      await moveOne(m, to);
      await refresh();
    },
    [dest, pickDest, moveOne, refresh],
  );

  const runAll = useCallback(async () => {
    setConfirming(null);
    const to = dest || (await pickDest());
    if (!to) return;
    cancelAll.current = false;
    const byId = new Map(scan.stores.flatMap((s) => s.models).map((m) => [m.id, m]));
    for (const id of moveQueue(scan, movedIds.current)) {
      if (cancelAll.current) break;
      const m = byId.get(id);
      if (!m) continue;
      const ok = await moveOne(m, to);
      if (!ok) break; // one refusal stops the batch; the row says why
    }
    await refresh();
  }, [dest, pickDest, scan, moveOne, refresh]);

  if (error) return <Empty title="Could not scan for models" body={error} />;
  if (!loaded) return null;

  const present = scan.stores.filter((s) => s.present);
  const queue = moveQueue(scan, movedIds.current);
  const shortDest = dest ? dest.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~") : "";

  return (
    <div className="models-widget">
      <div className="models-bar">
        <div className="models-total">
          <span className="mono-label">on disk</span>
          <span className="models-total-value">{fmtBytes(scan.totalBytes)}</span>
          <span className="ink-3">
            {queue.length} model{queue.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="models-dest">
          <span className="mono-label">move to</span>
          <span className="models-dest-path ink-2" title={dest}>
            {shortDest || "not chosen"}
          </span>
          <button className="btn xs" onClick={() => void pickDest()} disabled={busy !== null}>
            {dest ? "Change…" : "Choose…"}
          </button>
        </div>
        <div className="models-actions">
          <button className="btn xs" title="Rescan" onClick={() => void refresh()} disabled={busy !== null}>
            ↻
          </button>
          {busy && confirming === null ?
            <button className="btn xs" onClick={() => (cancelAll.current = true)}>
              Stop after this one
            </button>
          : <button className="btn xs primary" disabled={queue.length === 0 || busy !== null} onClick={() => setConfirming("all")}>
              Move all
            </button>
          }
        </div>
      </div>

      {confirming === "all" && (
        <div className="models-confirm">
          <div>
            Move {queue.length} model{queue.length === 1 ? "" : "s"} ({fmtBytes(scan.totalBytes)}) to{" "}
            <code>{shortDest || "a folder you pick next"}</code>, one folder per model?
            {present.some((s) => s.runtime === "ollama" && s.models.length > 0) && (
              <div className="ink-3">Ollama models are exported as a GGUF plus a Modelfile and removed from Ollama.</div>
            )}
          </div>
          <div className="models-confirm-actions">
            <button className="btn xs primary" onClick={() => void runAll()}>
              Move all
            </button>
            <button className="btn xs" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {present.length === 0 ?
        <Empty
          title="No local model stores found"
          body="Looked for Ollama, the Hugging Face hub cache (MLX, vLLM), LM Studio, llama.cpp, Jan and GPT4All."
        />
      : present.map((store) => (
          <div className="models-store" key={store.runtime}>
            <div className="models-store-head">
              <span className="models-store-name">{store.label}</span>
              <span className="models-store-root ink-3" title={store.root}>
                {store.root.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~")}
              </span>
              <span className="models-store-bytes ink-2">{fmtBytes(store.bytes)}</span>
            </div>
            {store.models.length === 0 && <div className="widget-note ink-3">Nothing downloaded.</div>}
            {store.models.map((m) => {
              const isBusy = busy === m.id;
              const p = isBusy && progress?.id === m.id ? progress : null;
              const err = rowError?.id === m.id ? rowError.text : null;
              return (
                <div className={`row models-row${isBusy ? " busy" : ""}`} key={m.id}>
                  <div className="row-main">
                    <div className="row-title" title={m.path}>
                      {m.name}
                    </div>
                    {p ?
                      <div className="models-progress">
                        <div className="models-progress-bar">
                          <div className="models-progress-fill" style={{ width: `${percent(p.bytesDone, p.bytesTotal)}%` }} />
                        </div>
                        <span className="ink-3">
                          {p.phase === "remove" ? "removing source…" : `${fmtBytes(p.bytesDone)} / ${fmtBytes(p.bytesTotal)}`}
                        </span>
                      </div>
                    : err ?
                      <div className="row-sub models-row-error">{err}</div>
                    : confirming === m.id ?
                      <div className="row-sub">
                        Move to <code>{shortDest || "a folder you pick next"}</code>?
                        {m.runtime === "ollama" && " Exported as GGUF + Modelfile and removed from Ollama."}
                      </div>
                    : null}
                  </div>
                  <span className="models-row-bytes ink-2">{fmtBytes(m.bytes)}</span>
                  <div className="models-row-actions">
                    {confirming === m.id ?
                      <>
                        <button className="btn xs primary" onClick={() => void runOne(m)}>
                          Move
                        </button>
                        <button className="btn xs" onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </>
                    : <button className="btn xs" disabled={busy !== null} onClick={() => setConfirming(m.id)}>
                        Move
                      </button>
                    }
                  </div>
                </div>
              );
            })}
          </div>
        ))
      }

      {moved.length > 0 && (
        <div className="models-store">
          <div className="models-store-head">
            <span className="models-store-name">Moved this session</span>
          </div>
          {moved.map((x) => (
            <div className="row models-row" key={x.destination}>
              <div className="row-main">
                <div className="row-title">{x.name}</div>
                <div className="row-sub" title={x.destination}>
                  {x.destination.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~")}
                </div>
              </div>
              <div className="models-row-actions">
                <button className="btn xs" onClick={() => void ipc.revealPath(x.destination)}>
                  Reveal
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
