import { useCallback, useEffect, useState } from "react";
import { Empty, Status, type State } from "../components/Status";
import { badge, confidenceNote, headline, liveNote, scheduleNote, sources } from "../lib/eol";
import { ipc } from "../lib/ipc";
import { useFocus } from "../state/focus";
import { useUi } from "../state/ui";
import type { EolRow } from "../types";
import type { WidgetViewProps } from "./registry";
import { useRemembered } from "../state/remembered";
import { firstLoad } from "../state/timing";

/**
 * What you shipped and stopped looking at.
 *
 * Repositories you assign, checked against their runtimes' published support
 * schedules. The list is explicit on purpose: a project you are working in gets
 * bumped as a matter of course, and the one that rots is the one nobody opens.
 */
/** The board's verdict vocabulary, in the design's state names. */
function verdictState(state: string): State {
  switch (state) {
    case "ended":
      return "ended";
    // Active support gone and a deadline approaching are the same call to
    // action — plan the upgrade — so they read the same.
    case "endingSoon":
    case "securityOnly":
      return "warn";
    case "active":
      return "ok";
    default:
      return "unknown";
  }
}

export function EolWidget({ widget, environmentId, focused, itemIndex }: WidgetViewProps) {
  const [rows, setRows] = useRemembered<EolRow[]>(`eol:${environmentId}`, []);
  const [stale, setStale] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // A row cursor, so j/k reaches these rows and h/l reaches the buttons on the
  // one it lands on. Registering is what puts a widget into the keyboard model:
  // without it `.row.selected` is never set and every row action stays
  // mouse-only. Eight of the ten widgets had never registered.
  const registerWidget = useFocus((s) => s.registerWidget);
  const unregisterWidget = useFocus((s) => s.unregisterWidget);
  useEffect(() => {
    registerWidget(widget.id, rows.length, (index) => {
      const row = rows[index];
      if (row) setExpanded((open) => (open === row.path ? null : row.path));
    });
    return () => unregisterWidget(widget.id);
  }, [widget.id, rows, registerWidget, unregisterWidget, setExpanded]);

  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const showToast = useUi((s) => s.showToast);

  // Newest-version is a toggle, never the default: "Symfony 8.1 exists" is
  // noise when you are on the 7.4 LTS and fine.
  const showLatest = widget.filter.showLatest === true;

  const load = useCallback(async () => {
    try {
      const board = await firstLoad("eol", () => ipc.eolBoard(environmentId));
      setRows(board.rows);
      setStale(board.stale);
      setLoaded(true);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [environmentId, setRows]);

  useEffect(() => {
    void load();
    // Support schedules move in years and the fetch is cached for a week, so
    // this is about picking up a manifest you edited, not about the network.
    const seconds = widget.refreshSeconds ?? 900;
    const timer = setInterval(() => void load(), seconds * 1000);
    return () => clearInterval(timer);
  }, [load, widget.refreshSeconds]);

  async function assign() {
    const dir = await ipc.pickDirectory();
    if (!dir) return;
    setAdding(true);
    try {
      await ipc.eolWatch(environmentId, dir);
      showToast(`Watching ${dir.split("/").pop()}`);
      await load();
    } catch (e) {
      showToast(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function setUrl(row: EolRow, url: string) {
    try {
      await ipc.eolWatch(environmentId, row.path, url);
      await load();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function drop(row: EolRow) {
    try {
      await ipc.eolUnwatch(environmentId, row.path);
      showToast(`Stopped watching ${row.name} — the checkout is untouched`);
      await load();
    } catch (e) {
      showToast(String(e));
    } finally {
      setConfirmDrop(null);
    }
  }

  return (
    <div>
      <div className="filter-bar">
        <span className={rows.some((r) => r.worst.state === "ended") ? "tone-err" : "ink-2"}>{loaded ? headline(rows) : "…"}</span>
        <button className="btn sm end" disabled={adding} onClick={() => void assign()}>
          Watch a repo…
        </button>
      </div>

      {error && <div className="mono-label widget-note warn">{error}</div>}

      {stale.length > 0 && (
        <div className="mono-label widget-note">could not refresh {stale.join(", ")} — showing the dates already on this machine</div>
      )}

      <div className="rows">
        {rows.map((row, index) => {
          const b = badge(row.worst, {
            eolDate: row.findings.find((f) => f.support.state === row.worst.state)?.eolDate,
            supportDate: row.findings.find((f) => f.support.state === row.worst.state)?.supportDate,
          });
          const open = expanded === row.path;
          const age = scheduleNote(row.findings[0]?.scheduleAgeDays ?? null);
          return (
            <div key={row.path}>
              <div className={`row${focused && index === itemIndex ? " selected" : ""}`}>
                <span className="row-mark" />
                <div className="row-main clickable" onClick={() => setExpanded(open ? null : row.path)}>
                  <div className="row-title badged">
                    {/* Colour is the verdict, computed per row — see lib/eol. */}
                    <span className="dot" title={b.title} style={{ background: b.color }} />
                    <span>{row.name}</span>
                    {row.url &&
                      (() => {
                        // Unchecked yet is still "live": the user said so, and
                        // not having asked is not evidence against them.
                        const l = liveNote(row.live) ?? {
                          label: "● live",
                          color: "var(--ok)",
                          title: `${row.url} — not checked yet this hour`,
                        };
                        return (
                          <span className="mono-label" style={{ color: l.color }} title={l.title}>
                            {l.label}
                          </span>
                        );
                      })()}
                    {row.missing && (
                      <span className="mono-label tone-warn" title={row.path}>
                        folder is gone
                      </span>
                    )}
                  </div>
                  <div className="row-sub">
                    <Status
                      state={verdictState(row.worst.state)}
                      label={row.unreadable ? "nothing to read here" : b.label}
                      title={b.title}
                    />
                    {!row.unreadable && (
                      <span className="meta ink-3">{row.findings.map((f) => `${f.product} ${f.cycle}`).join(" · ")}</span>
                    )}
                    {age && <span className="meta ink-3">{age}</span>}
                    {row.note && <span className="meta ink-3">{row.note}</span>}
                  </div>
                </div>
                <div className="row-actions">
                  {row.url && (
                    <button className="btn sm" title={row.url} onClick={() => void ipc.openExternal(row.url!)}>
                      Open
                    </button>
                  )}
                  {!row.missing && (
                    <>
                      <button
                        className="btn glyph sm"
                        title="Open a terminal here"
                        onClick={() => void ipc.launchPath(row.path).catch((e) => showToast(String(e)))}
                      >
                        {">_"}
                      </button>
                      <button
                        className="btn sm"
                        title="Open this checkout in your editor"
                        onClick={() => void ipc.openInEditor(row.path).catch((e) => showToast(String(e)))}
                      >
                        IDE
                      </button>
                    </>
                  )}
                  {confirmDrop === row.path ? (
                    <>
                      <button className="btn danger sm" onClick={() => void drop(row)}>
                        Stop watching
                      </button>
                      <button className="btn sm" onClick={() => setConfirmDrop(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn sm"
                      title="Removes it from this list only — the checkout on disk is untouched"
                      onClick={() => setConfirmDrop(row.path)}
                    >
                      Unwatch…
                    </button>
                  )}
                </div>
              </div>

              {open && (
                <div className="row-detail">
                  {row.findings.map((f) => {
                    const fb = badge(f.support, f);
                    return (
                      <div key={`${f.product}-${f.cycle}-${f.source}`} className="row-sub">
                        <span className="ink-2 finding-name">
                          {f.product} {f.cycle}
                        </span>
                        <span className="meta">
                          <Status state={verdictState(f.support.state)} label={fb.label} title={fb.title} />
                        </span>
                        <span className="meta ink-3" title={`${f.raw} — ${confidenceNote(f)}`}>
                          {sources(f)}
                          {f.confidence !== "exact" && ` · ${confidenceNote(f)}`}
                        </span>
                        {showLatest && f.latest && <span className="meta ink-3">newest {f.latest}</span>}
                      </div>
                    );
                  })}
                  <UrlField url={row.url} onSave={(url) => void setUrl(row, url)} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {loaded && rows.length === 0 && (
        <Empty
          title="Nothing is being watched."
          body="Assign the projects you built and stopped opening. A project you are working in gets its dependencies bumped anyway; the one that rots is the one nobody looks at — especially if it still has a URL serving traffic."
        />
      )}
    </div>
  );
}

/**
 * The live URL, typed rather than inferred.
 *
 * GitHub's `homepage` is stale often enough to lie, and a client's server is
 * invisible to it anyway. What you typed is the only source honest for every
 * host, so this is the only way a URL gets onto a row.
 */
function UrlField({ url, onSave }: { url: string | null; onSave: (url: string) => void }) {
  const [value, setValue] = useState(url ?? "");
  useEffect(() => setValue(url ?? ""), [url]);
  return (
    <div className="filter-bar url-field">
      <span className="mono-label">live at</span>
      <input
        className="field grow url"
        placeholder="https://… (optional)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onSave(value.trim());
        }}
      />
      {value.trim() !== (url ?? "") && value.trim() !== "" && (
        <button className="btn sm" onClick={() => onSave(value.trim())}>
          Save
        </button>
      )}
    </div>
  );
}
