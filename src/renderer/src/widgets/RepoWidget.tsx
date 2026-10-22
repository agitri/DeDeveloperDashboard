import { useCallback, useEffect, useRef, useState } from "react";
import { compiledFilterOf, presetFilterOf, resolveFilter } from "../lib/instructions";
import { ipc } from "../lib/ipc";
import { useFocus } from "../state/focus";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import type { LocalRepoRow, RepoRow } from "../types";
import type { WidgetViewProps } from "./registry";
import { Empty } from "../components/Status";
import { useRemembered } from "../state/remembered";
import { firstLoad } from "../state/timing";

/**
 * Repositories, and whether each one is on this machine.
 *
 * The first widget with its own filter bar: scope and search live in
 * `widget.filter`, so they persist in layout.json like any other widget config.
 */
export function RepoWidget({ widget, environmentId, focused, itemIndex }: WidgetViewProps) {
  const [rows, setRows] = useRemembered<RepoRow[]>(`repos:${environmentId}:${widget.id}`, []);
  const [localOnly, setLocalOnly] = useState<LocalRepoRow[]>([]);
  const [capped, setCapped] = useState(false);
  const [total, setTotal] = useState(0);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [confirmUnlink, setConfirmUnlink] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const updateWidget = useStore((s) => s.updateWidget);
  const promoteToTab = useStore((s) => s.promoteToTab);
  const showToast = useUi((s) => s.showToast);

  // Compiled instructions merge under the widget's own filter bar: the switch
  // and the search box are on screen and win, an instruction fills in the rest.
  const resolved = resolveFilter(widget.filter, presetFilterOf(widget), compiledFilterOf(widget));
  const scope = (resolved.scope as string) ?? "recent";
  const query = (resolved.query as string) ?? "";
  // Remotes the user has dismissed from this widget's list. Hiding is a view
  // concern — the repo is still synced, still linked, still on disk — so it
  // lives in the widget's own filter rather than touching the cache or the
  // link store. Two repo widgets can therefore show different subsets, which
  // is the point of "same source, many widgets".
  const hidden: string[] = Array.isArray(widget.filter.hidden) ? (widget.filter.hidden as string[]) : [];
  const [showHidden, setShowHidden] = useState(false);

  // What is actually on screen, hoisted out of the JSX so the row cursor and
  // the render agree on which row is row N. The two sections are one list to
  // the keyboard, in the order they are drawn.
  const visible = rows.filter((row) => showHidden || !hidden.includes(row.remote));

  // A row cursor, so j/k reaches these rows and h/l reaches the buttons on the
  // one it lands on. Registering is what puts a widget into the keyboard model:
  // without it `.row.selected` is never set and every row action — Map, Clone,
  // open a terminal — stays mouse-only.
  const registerWidget = useFocus((s) => s.registerWidget);
  const unregisterWidget = useFocus((s) => s.unregisterWidget);
  useEffect(() => {
    registerWidget(widget.id, visible.length + localOnly.length);
    return () => unregisterWidget(widget.id);
  }, [widget.id, visible.length, localOnly.length, registerWidget, unregisterWidget]);

  // The immediate value backs the input for a responsive box; only the
  // settled value (below, after 350ms of no typing) is written into
  // `widget.filter` and so feeds `query` above — same pattern as
  // NotesWidget's debounced textarea, applied here because every keystroke
  // otherwise fires a full `reposList` round-trip.
  const [queryInput, setQueryInput] = useState(query);
  useEffect(() => {
    if (queryInput === query) return;
    const timer = setTimeout(() => {
      updateWidget(widget.id, { filter: { ...widget.filter, query: queryInput } });
    }, 350);
    return () => clearTimeout(timer);
    // `widget.filter` is in the deps (not suppressed) on purpose, matching
    // NotesWidget's own debounce: if `scope` is toggled while a query edit is
    // still pending, this restarts the timer against the fresh filter object
    // instead of firing later with a stale one and clobbering the scope change.
  }, [queryInput, query, widget.filter, widget.id, updateWidget]);

  const load = useCallback(async () => {
    try {
      const listing = await firstLoad("repos", () => ipc.reposList(environmentId, { scope, query }));
      setRows(listing.rows);
      setLocalOnly(listing.localOnly ?? []);
      setCapped(listing.capped);
      setTotal(listing.total);
    } catch (e) {
      showToast(String(e));
    }
  }, [environmentId, scope, query, showToast, setRows]);

  useEffect(() => {
    void load();
  }, [load]);

  // `load` closes over `query`, so it gets a new identity on every keystroke
  // in the filter box. If the progress subscription below depended on `load`
  // directly, that would tear the listener down and resubscribe it on every
  // keystroke too — and a `ddd://repo-progress` event arriving in that gap
  // would be lost for good, since Tauri events aren't replayed. Route the
  // handler's call to `load` through a ref instead, kept fresh here, so the
  // subscription effect can depend on `environmentId` alone and stay mounted
  // across filter edits. Do not "simplify" this by putting `load` back in
  // the deps array below.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void ipc
      .onRepoProgress((p) => {
        setProgress((current) => {
          if (p.done) {
            // Once a clone is done, the row's own state — the reloaded
            // cache row on success, or the failure toast below — is the
            // source of truth. Leaving the last progress entry in place
            // would stick "Done 100%" (or a stale failure line) on a row
            // that is no longer in progress.
            if (!(p.remote in current)) return current;
            const next = { ...current };
            delete next[p.remote];
            return next;
          }
          return {
            ...current,
            [p.remote]: p.error ? `failed: ${p.error.split("\n").pop()}` : `${p.phase} ${p.percent}%`,
          };
        });
        if (p.done) {
          void loadRef.current();
          // showToast is a zustand action — a stable reference for the life of
          // the store, so closing over it here (rather than also ref'ing it)
          // never goes stale.
          if (p.error) {
            // "could not start git" is the one failure mode where git never
            // ran, so no folder ever touched disk — every other failure path
            // (non-zero exit, or a checkout that finished but couldn't be
            // canonicalized) leaves a real folder behind, worth mentioning.
            const neverStarted = p.error.startsWith("could not start git:");
            showToast(neverStarted ? "Clone failed — nothing was checked out" : "Clone failed — the partial checkout was left in place");
          }
        }
      })
      .then((un) => (cancelled ? un() : (dispose = un)));
    return () => {
      cancelled = true;
      dispose?.();
    };
    // See the loadRef comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId]);

  // Rows come from the cache, and the scheduler is what refreshes the
  // cache on its own cadence — without this, a scheduled GitHub sync would
  // update the database and this screen would just never know.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void ipc
      .onItemsChanged(({ environmentId: changed }) => {
        if (changed === environmentId) void loadRef.current();
      })
      .then((unlisten) => (cancelled ? unlisten() : (dispose = unlisten)));
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [environmentId]);

  function setFilter(patch: Record<string, unknown>) {
    updateWidget(widget.id, { filter: { ...widget.filter, ...patch } });
  }

  async function scan() {
    const dir = await ipc.pickDirectory();
    if (!dir) return;
    try {
      const linked = await ipc.repoScan(environmentId, dir);
      showToast(`Linked ${linked} repo${linked === 1 ? "" : "s"} from ${dir}`);
      void load();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function addLocal() {
    const dir = await ipc.pickDirectory();
    if (!dir) return;
    try {
      await ipc.repoAddLocal(environmentId, dir);
      showToast(`Added ${dir}`);
      void load();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function forget(row: LocalRepoRow) {
    try {
      await ipc.repoForget(environmentId, row.path);
      showToast(`Forgot ${row.name} — the folder on disk is untouched`);
      void load();
    } catch (e) {
      showToast(String(e));
    } finally {
      setConfirmForget(null);
    }
  }

  /** Assign a checkout to the support watcher — the same list, reached from
   *  where the repo already is. */
  async function watch(path: string, name: string) {
    try {
      await ipc.eolWatch(environmentId, path);
      showToast(`${name} added to the support watch`);
    } catch (e) {
      showToast(String(e));
    }
  }

  async function openIn(path: string) {
    try {
      await ipc.openInEditor(path);
    } catch (e) {
      showToast(String(e));
    }
  }

  function hide(remote: string) {
    setFilter({ hidden: [...hidden, remote] });
  }

  function unhide(remote: string) {
    setFilter({ hidden: hidden.filter((r) => r !== remote) });
  }

  /** Same terminal and launch command as a project card's Launch button. */
  async function launchIn(path: string) {
    try {
      await ipc.launchPath(path);
    } catch (e) {
      showToast(String(e));
    }
  }

  async function registerMapped(row: RepoRow) {
    if (!row.localPath) return;
    try {
      await ipc.projectRegister(environmentId, row.localPath);
      showToast(`${row.nameWithOwner} added to projects`);
      void load();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function registerLocal(row: LocalRepoRow) {
    try {
      await ipc.projectRegister(environmentId, row.path);
      showToast(`${row.name} added to projects`);
      void load();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function promote(path: string, name: string, remote?: string) {
    try {
      await promoteToTab({ environmentId, path, name, remote });
    } catch (e) {
      showToast(String(e));
    }
  }

  async function map(row: RepoRow) {
    const dir = await ipc.pickDirectory();
    if (!dir) return;
    try {
      await ipc.repoLink(environmentId, row.remote, dir);
      showToast(`${row.nameWithOwner} → ${dir}`);
      void load();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function clone(row: RepoRow) {
    const parent = await ipc.pickDirectory();
    if (!parent) return;
    try {
      await ipc.repoClone(environmentId, row.remote, row.cloneUrl, parent);
    } catch (e) {
      showToast(String(e));
    }
  }

  async function unlink(row: RepoRow) {
    try {
      await ipc.repoUnlink(environmentId, row.remote);
      showToast(`Unmapped ${row.nameWithOwner} — the folder on disk is untouched`);
      void load();
    } catch (e) {
      showToast(String(e));
    } finally {
      setConfirmUnlink(null);
    }
  }

  return (
    <div>
      <div className="filter-bar">
        {(["recent", "all"] as const).map((option) => (
          <button key={option} className={`btn sm${scope === option ? " primary" : ""}`} onClick={() => setFilter({ scope: option })}>
            {option === "recent" ? "Recent" : "All"}
          </button>
        ))}
        <input className="field grow" placeholder="Filter…" value={queryInput} onChange={(e) => setQueryInput(e.target.value)} />
        <button className="btn sm" onClick={() => void scan()}>
          Scan folder…
        </button>
        <button className="btn sm" title="Add one checkout DDD has not found, and register it as a project" onClick={() => void addLocal()}>
          Add local repo…
        </button>
        {hidden.length > 0 && (
          <button
            className={`btn sm${showHidden ? " primary" : ""}`}
            title={showHidden ? "Stop showing hidden repositories" : "Show the repositories you have hidden, so you can bring one back"}
            onClick={() => setShowHidden((v) => !v)}
          >
            {hidden.length} hidden
          </button>
        )}
      </div>

      {capped && <div className="mono-label widget-note">showing the {total} most recently pushed — there may be more</div>}

      <div className="rows">
        {visible.map((row, index) => {
          const isHidden = hidden.includes(row.remote);
          return (
            <div
              key={row.remote || row.nameWithOwner}
              className={`row${isHidden ? " dimmed" : ""}${focused && index === itemIndex ? " selected" : ""}`}
            >
              <div className="row-main">
                <div className="row-title">{row.nameWithOwner}</div>
                <div className="row-sub">
                  {row.facts}
                  {row.pushedAt && (
                    <span className="meta ink-3" title={row.pushedAt}>
                      pushed {relative(row.pushedAt)}
                    </span>
                  )}
                  {row.localPath && (
                    // `path` truncates from the left: the end of a checkout path
                    // is the part you read, and `/Users/you/Projects` is not.
                    <span className={`meta path ${row.missing ? "tone-warn" : "tone-ok"}`} title={row.localPath}>
                      {row.missing ? "missing · " : ""}
                      <bdi>{row.localPath}</bdi>
                    </span>
                  )}
                  {row.matchConfidence === "fallback" && (
                    <span title="Matched on owner/repo only — this cannot tell one host from another" className="meta tone-warn help">
                      guessed
                    </span>
                  )}
                  {progress[row.remote] && <span className="meta ink-2">{progress[row.remote]}</span>}
                </div>
              </div>
              <div className="row-actions">
                {!row.localPath && (
                  <>
                    <button className="btn sm" onClick={() => void map(row)}>
                      → Map…
                    </button>
                    <button className="btn sm" onClick={() => void clone(row)}>
                      ↓ Clone…
                    </button>
                  </>
                )}
                {row.localPath && !row.missing && (
                  <>
                    <button
                      className="btn glyph sm"
                      title="Open a terminal here and run the launch command"
                      onClick={() => void launchIn(row.localPath!)}
                    >
                      {">_"}
                    </button>
                    <button className="btn sm" title="Open this checkout in your editor" onClick={() => void openIn(row.localPath!)}>
                      IDE
                    </button>
                    <button
                      className="btn sm"
                      title="Watch this checkout for runtimes going out of support"
                      onClick={() => void watch(row.localPath!, row.nameWithOwner)}
                    >
                      Watch
                    </button>
                  </>
                )}
                {row.localPath && !row.projectId && !row.missing && (
                  <button className="btn sm" title="Register this checkout as a project" onClick={() => void registerMapped(row)}>
                    + Project
                  </button>
                )}
                <button
                  className="btn sm"
                  disabled={!row.localPath || row.missing}
                  title={row.localPath && !row.missing ? "Build a tab pre-filled for this repo" : "check out or add a local path first"}
                  onClick={() =>
                    row.localPath &&
                    !row.missing &&
                    void promote(row.localPath, row.nameWithOwner.split("/").pop() || row.nameWithOwner, row.remote)
                  }
                >
                  Promote to tab
                </button>
                {row.localPath &&
                  (confirmUnlink === row.remote ?
                    <>
                      <button className="btn danger sm" onClick={() => void unlink(row)}>
                        Remove mapping
                      </button>
                      <button className="btn sm" onClick={() => setConfirmUnlink(null)}>
                        Cancel
                      </button>
                    </>
                  : <button
                      className="btn sm"
                      title="Removes the mapping only — the folder on disk is untouched"
                      onClick={() => setConfirmUnlink(row.remote)}
                    >
                      Unlink…
                    </button>)}
                {isHidden ?
                  <button className="btn sm" title="Show this repository in the list again" onClick={() => unhide(row.remote)}>
                    Unhide
                  </button>
                : <button
                    className="btn sm"
                    title="Remove from this list only — nothing is unlinked, deleted or unsynced"
                    onClick={() => hide(row.remote)}
                  >
                    Hide
                  </button>
                }
                <button className="btn sm" onClick={() => void ipc.openExternal(row.url)}>
                  Open
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {localOnly.length > 0 && (
        <>
          <div className="mono-label section-head">Local only — {localOnly.length}</div>
          <div className="rows">
            {localOnly.map((row, index) => (
              <div key={row.path} className={`row${focused && visible.length + index === itemIndex ? " selected" : ""}`}>
                <div className="row-main">
                  <div className="row-title">{row.name}</div>
                  <div className="row-sub">
                    <span className="mono-label" title={row.origin ?? "this checkout has no origin remote"}>
                      {row.originHost ?? "no remote"}
                    </span>
                    <span className={`meta ${row.missing ? "tone-warn" : "ink-3"}`}>
                      {row.missing ? "missing · " : ""}
                      {row.path}
                    </span>
                  </div>
                </div>
                <div className="row-actions">
                  {/* No Clone — it is already here. No Map — it already is. */}
                  {!row.projectId && !row.missing && (
                    <button className="btn sm" onClick={() => void registerLocal(row)}>
                      + Project
                    </button>
                  )}
                  {!row.missing && (
                    <button
                      className="btn sm"
                      title="Build a tab pre-filled for this repo"
                      onClick={() => void promote(row.path, row.name, row.origin ?? undefined)}
                    >
                      Promote to tab
                    </button>
                  )}
                  {!row.missing && (
                    <>
                      <button
                        className="btn glyph sm"
                        title="Open a terminal here and run the launch command"
                        onClick={() => void launchIn(row.path)}
                      >
                        {">_"}
                      </button>
                      <button className="btn sm" title="Open this checkout in your editor" onClick={() => void openIn(row.path)}>
                        IDE
                      </button>
                      <button className="btn sm" onClick={() => void revealItem(row.path)}>
                        Reveal
                      </button>
                    </>
                  )}
                  {confirmForget === row.path ?
                    <>
                      <button className="btn danger sm" onClick={() => void forget(row)}>
                        Forget
                      </button>
                      <button className="btn sm" onClick={() => setConfirmForget(null)}>
                        Cancel
                      </button>
                    </>
                  : <button
                      className="btn sm"
                      title="Removes it from this list only — the folder on disk is untouched"
                      onClick={() => setConfirmForget(row.path)}
                    >
                      Forget…
                    </button>
                  }
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {rows.length === 0 && localOnly.length === 0 && (
        <Empty
          title="No repositories yet."
          body={
            <>
              Use <b>Scan folder…</b> or <b>Add local repo…</b> to list what you already have on disk — neither needs an account. Connect
              GitHub in Settings to see the rest.
            </>
          }
        />
      )}
    </div>
  );
}

/**
 * Show the folder in Finder. `revealItemInDir` is already covered by the
 * `opener:default` capability, so this needs no permission change.
 */
async function revealItem(path: string) {
  await ipc.revealPath(path);
}

/**
 * "3d ago" from an RFC 3339 timestamp. The exact instant stays in the title
 * attribute — a relative time is for scanning, not for citing.
 */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}
