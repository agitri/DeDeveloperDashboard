import { useCallback, useEffect, useState } from "react";
import { describe } from "../lib/instructions";
import { ipc } from "../lib/ipc";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import type { Compiled, Widget } from "../types";

/**
 * Tell a widget what to show, in words.
 *
 * The prose is a real file on disk and the only source of truth; what the model
 * makes of it is a cache stored on the widget. So this panel writes the file
 * first, then compiles — never the other way round, and never a compilation
 * written back into the prose.
 */
export function InstructionsPanel({ widget, environmentId, onClose }: { widget: Widget; environmentId: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [path, setPath] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateWidget = useStore((s) => s.updateWidget);
  const showToast = useUi((s) => s.showToast);

  const compiled = widget.config.instructions as Compiled | undefined;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await ipc.widgetInstructionsLoad(environmentId, widget.id);
      if (cancelled) return;
      setPath(found.path);
      // The starter text names what this kind can actually be told, so an empty
      // box never invites an instruction the schema can never honour.
      setText(found.exists ? found.text : await ipc.widgetInstructionsTemplate(widget.kind));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, widget.id, widget.kind]);

  const compile = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await ipc.widgetInstructionsSave(environmentId, widget.id, text);
      const result = await ipc.widgetInstructionsCompile(environmentId, widget.id, widget.kind);
      updateWidget(widget.id, {
        config: { ...widget.config, instructions: result },
      });
    } catch (e) {
      // Every failure keeps the last good filter. A widget must never break
      // because Ollama is not running.
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [environmentId, text, widget.id, widget.kind, widget.config, updateWidget]);

  async function clear() {
    try {
      await ipc.widgetInstructionsClear(environmentId, widget.id);
      const config = { ...widget.config };
      delete config.instructions;
      updateWidget(widget.id, { config });
      setText(await ipc.widgetInstructionsTemplate(widget.kind));
      showToast("Instructions cleared — the widget is back to its own filter");
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div
      className="widget-editor instructions"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Not Enter: this is prose, and a newline has to stay a newline.
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void compile();
      }}
    >
      <label className="mono-label" htmlFor={`instructions-${widget.id}`}>
        What should this widget show?
      </label>
      <textarea
        id={`instructions-${widget.id}`}
        className="field prose"
        placeholder="No automated mail. Only messages a person actually sent me. Latest 10."
        value={text}
        disabled={!loaded}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="button-row">
        <button className="btn primary" disabled={busy || !loaded} onClick={() => void compile()}>
          {busy ?
            "Reading…"
          : compiled ?
            "Recompile"
          : "Apply"}
        </button>
        {compiled && (
          <button className="btn" disabled={busy} onClick={() => void clear()}>
            Clear
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Close
        </button>
        {path && (
          <span className="mono-label end" title={path}>
            {path.replace(/^.*\/environments\//, "…/environments/")}
          </span>
        )}
      </div>

      {error && (
        <div className="mono-label panel-error">
          {error}
          <div className="ink-3">
            {compiled ? "The previous filter is still in force." : "Nothing changed — this widget is still showing what it did."}
          </div>
        </div>
      )}

      {compiled && (
        <div className="understood">
          <div className="mono-label">what it understood</div>
          {describe(compiled.filter).map((line) => (
            <div key={line} className="ink-2">
              {line}
            </div>
          ))}
          {compiled.unmet.length > 0 && (
            <div className="unmet">
              <div className="mono-label tone-warn">could not do</div>
              {compiled.unmet.map((line) => (
                <div key={line} className="ink-2">
                  {line}
                </div>
              ))}
            </div>
          )}
          <div className="mono-label compiled-by">
            compiled once by {compiled.model} — the widget applies this filter itself, with no model involved
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Keep a widget's compiled filter honest about the file it came from.
 *
 * The prose is a real file, so it can be edited in an editor or deleted in a
 * Finder window with DDD none the wiser. Rather than watch it, DDD hashes it on
 * mount and compares — a comparison it was going to make anyway. A mismatch
 * recompiles; a missing file drops the cache and the widget returns to its own
 * filter.
 */
export function useInstructionsSync(widget: Widget, environmentId: string) {
  const updateWidget = useStore((s) => s.updateWidget);
  const compiled = widget.config.instructions as Compiled | undefined;
  const sourceHash = compiled?.sourceHash;

  useEffect(() => {
    if (!sourceHash) return;
    let cancelled = false;
    void (async () => {
      const found = await ipc.widgetInstructionsLoad(environmentId, widget.id);
      if (cancelled || found.hash === sourceHash) return;

      if (!found.exists) {
        const config = { ...widget.config };
        delete config.instructions;
        updateWidget(widget.id, { config });
        return;
      }
      try {
        const result = await ipc.widgetInstructionsCompile(environmentId, widget.id, widget.kind);
        if (!cancelled) {
          updateWidget(widget.id, { config: { ...widget.config, instructions: result } });
        }
      } catch {
        // The last good filter stands. A widget must never break because the
        // model that compiled it is not running today.
      }
    })();
    return () => {
      cancelled = true;
    };
    // `widget.config` is read inside but deliberately not a dependency: this
    // effect writes to it, and depending on it would re-run on its own result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, widget.id, widget.kind, sourceHash, updateWidget]);
}
