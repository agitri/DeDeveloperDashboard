import { useCallback, useEffect, useRef, useState } from "react";
import { Empty, Status, type State } from "../components/Status";
import { badge, containerTone, lsofCommand, nextInterval } from "../lib/devBoard";
import { ipc } from "../lib/ipc";
import { useFocus } from "../state/focus";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import type { DevServerRow } from "../types";
import type { WidgetViewProps } from "./registry";
import { useRemembered } from "../state/remembered";
import { firstLoad } from "../state/timing";

/**
 * What is running on this machine, which project it belongs to, and whether it
 * is answering.
 *
 * A live read of the OS rather than the item cache: the cache is deliberately
 * allowed to be stale, which is fine for a pull request and fatal for liveness.
 */
export function DevServerWidget({ widget, environmentId, focused, itemIndex }: WidgetViewProps) {
  const [rows, setRows] = useRemembered<DevServerRow[]>(`dev:${environmentId}:${widget.id}`, []);
  const [hidden, setHidden] = useState(0);
  const [foreignCount, setForeignCount] = useState(0);
  const [scanMs, setScanMs] = useState(0);
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
      if (row) setExpanded((open) => (open === row.key ? null : row.key));
    });
    return () => unregisterWidget(widget.id);
  }, [widget.id, rows, registerWidget, unregisterWidget, setExpanded]);

  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [lookupPort, setLookupPort] = useState("");
  const updateWidget = useStore((s) => s.updateWidget);
  const showToast = useUi((s) => s.showToast);

  // Two rules behind one control: "Everything" means every socket this user can
  // see — unattributable processes and kernel-assigned ports included.
  const knownOnly = widget.filter.knownOnly !== false;
  const query = (widget.filter.query as string) ?? "";
  const [queryInput, setQueryInput] = useState(query);

  const baseMs = (widget.refreshSeconds ?? 5) * 1000;
  const [intervalMs, setIntervalMs] = useState(baseMs);
  // The interval is read by the poll effect but must not restart it on every
  // change of itself, so it lives in a ref as well as in state (state only so
  // the "slowed down" note can render).
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;

  useEffect(() => {
    if (queryInput === query) return;
    const timer = setTimeout(() => {
      updateWidget(widget.id, { filter: { ...widget.filter, query: queryInput } });
    }, 250);
    return () => clearTimeout(timer);
  }, [queryInput, query, widget.filter, widget.id, updateWidget]);

  /**
   * `probe` is false on the very first call so rows appear before any socket
   * work happens, and true on every cycle after — the board is worth looking at
   * before it knows whether anything is answering.
   */
  const load = useCallback(
    async (probe: boolean) => {
      try {
        const listing = await firstLoad("devservers", () =>
          ipc.devServersList(environmentId, {
            knownOnly,
            ephemeral: !knownOnly,
            query,
            probe,
          }),
        );
        setRows(listing.rows);
        setHidden(listing.hidden);
        setForeignCount(listing.foreignCount);
        setScanMs(listing.scanMs);
        setLoaded(true);
        setError(null);
        setIntervalMs((current) => nextInterval(baseMs, current, listing.scanMs));
      } catch (e) {
        // Keep the rows: a failed scan is a reason to badge the board stale,
        // not to blank it while someone is reading it.
        setError(String(e));
      }
    },
    [environmentId, knownOnly, query, baseMs, setRows],
  );

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void load(false);
  }, [load]);

  // Self-scheduling rather than setInterval, because the interval itself moves:
  // each cycle picks its own delay from how long the last scan took.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = () => {
      timer = setTimeout(() => {
        if (stopped) return;
        void loadRef.current(true).then(() => {
          if (!stopped) tick();
        });
      }, intervalRef.current);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [environmentId, baseMs]);

  function setFilter(patch: Record<string, unknown>) {
    updateWidget(widget.id, { filter: { ...widget.filter, ...patch } });
  }

  async function act(fn: () => Promise<unknown>, done?: string) {
    try {
      await fn();
      if (done) showToast(done);
    } catch (e) {
      showToast(String(e));
    }
  }

  async function check(row: DevServerRow) {
    try {
      const probe = await ipc.devServerProbe(row.address, row.port, true);
      setRows((current) =>
        current.map((r) =>
          r.key === row.key ? { ...r, health: probe.health, latencyMs: probe.latencyMs, checkedAt: probe.checkedAt } : r,
        ),
      );
    } catch (e) {
      showToast(String(e));
    }
  }

  async function stop(row: DevServerRow) {
    try {
      await ipc.devServerStop(environmentId, row.key, row.pid!, row.process!);
      showToast(`Asked ${row.process} (pid ${row.pid}) to stop`);
      // Immediately, then again after the process has had a moment: a server
      // that ignores TERM should show as still there rather than disappear
      // optimistically.
      void load(false);
      setTimeout(() => void loadRef.current(false), 3000);
    } catch (e) {
      showToast(String(e));
    } finally {
      setConfirmStop(null);
    }
  }

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(done);
    } catch {
      showToast("Could not reach the clipboard");
    }
  }

  const lookup = lsofCommand(lookupPort);
  const slowed = intervalMs > baseMs;

  return (
    <div>
      <div className="filter-bar">
        <button
          className={`btn sm${knownOnly ? " primary" : ""}`}
          title="Ports that map to a project on disk, and that a human chose rather than the kernel. On this machine that is 21 rows out of 324 listening sockets."
          onClick={() => setFilter({ knownOnly: true })}
        >
          Projects
        </button>
        <button
          className={`btn sm${knownOnly ? "" : " primary"}`}
          title="Every listening socket this user can see, including the noise"
          onClick={() => setFilter({ knownOnly: false })}
        >
          Everything
        </button>
        <input
          className="field grow"
          placeholder="Port, process or project…"
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
        />
        {knownOnly && hidden > 0 && (
          <span
            className="mono-label"
            title="Listening sockets left out: they map to no project on disk, or sit on a port the kernel assigned"
          >
            {hidden} other
          </span>
        )}
      </div>

      {error && <div className="mono-label widget-note warn">could not read the machine — showing the last scan · {error}</div>}

      {slowed && (
        <div className="mono-label widget-note">
          slowed to every {Math.round(intervalMs / 1000)}s — the last scan took {scanMs}ms
        </div>
      )}

      <div className="rows">
        {rows.map((row, index) => {
          const b = badge(row.health, row.latencyMs);
          const path = row.cwd ?? row.repoPath;
          const open = expanded === row.key;
          return (
            <div key={row.key}>
              <div className={`row${focused && index === itemIndex ? " selected" : ""}`}>
                <span className="row-mark" />
                <div className="row-main">
                  <div className="row-title badged">
                    {/* Colour is the verdict, computed per row — see lib/devBoard. */}
                    <span className="dot" title={b.title} style={{ background: b.color }} />
                    <span>:{row.port}</span>
                    <span className="soft">{row.projectName ?? row.process ?? "(unknown)"}</span>
                    {row.matchedAncestor && (
                      <span className="mono-label" title={`Started in ${row.cwd} — rolled up to its project`}>
                        ↑
                      </span>
                    )}
                    {row.docker && (
                      <span className="mono-label" title="A Docker-published port. Never probed.">
                        docker
                      </span>
                    )}
                    {row.foreign && (
                      <span
                        className="mono-label"
                        title="Another user's socket. DDD can only see processes running as you, and no permission setting changes that."
                      >
                        not yours
                      </span>
                    )}
                  </div>
                  <div className="row-sub">
                    <Status state={row.health as State} label={b.label} title={b.title} />
                    <span className="meta ink-3">
                      {row.family} · {row.address}
                    </span>
                    {row.process && row.pid !== null && (
                      <span className="meta ink-3">
                        {row.process} {row.pid}
                        {row.workers > 0 && (
                          <span title="Worker processes sharing this listening socket — one server, not many"> +{row.workers}</span>
                        )}
                      </span>
                    )}
                    {path && (
                      <span className="meta ink-3" title={path}>
                        {path}
                      </span>
                    )}
                    {row.containers.length > 0 && (
                      <button
                        className="btn xs meta"
                        title="Containers composed from this project"
                        onClick={() => setExpanded(open ? null : row.key)}
                      >
                        {open ? "▾" : "▸"} {row.containers.length} container
                        {row.containers.length === 1 ? "" : "s"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="row-actions">
                  {row.url && (
                    <>
                      <button className="btn sm" title={row.url} onClick={() => void act(() => ipc.openExternal(row.url!))}>
                        Open
                      </button>
                      <button className="btn sm" title="Copy the URL" onClick={() => void copy(row.url!, `Copied ${row.url}`)}>
                        Copy
                      </button>
                    </>
                  )}
                  {path && (
                    <>
                      <button
                        className="btn glyph sm"
                        title="Open a terminal here and run the launch command"
                        onClick={() => void act(() => ipc.launchPath(path))}
                      >
                        {">_"}
                      </button>
                      <button
                        className="btn sm"
                        title="Open this directory in your editor"
                        onClick={() => void act(() => ipc.openInEditor(path))}
                      >
                        IDE
                      </button>
                    </>
                  )}
                  {path && (
                    <button
                      className="btn sm"
                      title="Watch this project for runtimes going out of support"
                      onClick={() =>
                        void act(() => ipc.eolWatch(environmentId, path), `${row.projectName ?? path} added to the support watch`)
                      }
                    >
                      Watch
                    </button>
                  )}
                  {path && !row.projectId && (
                    <button
                      className="btn sm"
                      title="Register this directory as a project"
                      onClick={() =>
                        void act(async () => {
                          await ipc.projectRegister(environmentId, path);
                          await load(false);
                        }, `${path} added to projects`)
                      }
                    >
                      + Project
                    </button>
                  )}
                  {!row.foreign && !row.docker && (
                    <button className="btn sm" title="Probe this socket now" onClick={() => void check(row)}>
                      Check
                    </button>
                  )}
                  {!row.foreign &&
                    row.pid !== null &&
                    !!row.process &&
                    (confirmStop === row.key ?
                      <>
                        <button className="btn danger sm" onClick={() => void stop(row)}>
                          Stop {row.process} (pid {row.pid})
                        </button>
                        <button className="btn sm" onClick={() => setConfirmStop(null)}>
                          Cancel
                        </button>
                      </>
                    : <button
                        className="btn sm"
                        title="Send SIGTERM — a request to shut down, never a force kill"
                        onClick={() => setConfirmStop(row.key)}
                      >
                        Stop…
                      </button>)}
                </div>
              </div>

              {open && (
                <div className="row-detail">
                  {row.containers.map((c) => (
                    <div key={c.name} className="row-sub badged">
                      <span className="dot sm" style={{ background: containerTone(c.running, c.unhealthy) }} />
                      <span className="ink-2">{c.name}</span>
                      <span className="ink-3">{c.status}</span>
                      {c.ports.length > 0 && <span className="ink-3">{c.ports.map((p) => `:${p}`).join(" ")}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {loaded && rows.length === 0 && (
        <Empty
          title={knownOnly ? "Nothing of yours is listening in a known project." : "Nothing of yours is listening."}
          body={
            <>
              DDD can only see processes running as you — a service started with sudo, or owned by another user, will not appear here, and
              no permission setting changes that.
            </>
          }
          meta={
            <>
              scanned in {scanMs}ms
              {foreignCount > 0 && ` · ${foreignCount} socket${foreignCount === 1 ? "" : "s"} belong to someone else`}
            </>
          }
        />
      )}

      <div className="filter-bar footer">
        <span className="mono-label">still getting EADDRINUSE?</span>
        <input className="field narrow" placeholder="port" value={lookupPort} onChange={(e) => setLookupPort(e.target.value)} />
        <button
          className="btn sm"
          disabled={!lookup}
          title={lookup ?? "Enter a port number"}
          onClick={() => lookup && void copy(lookup, "Copied — paste it into a terminal")}
        >
          Copy lsof
        </button>
        {foreignCount > 0 && rows.length > 0 && (
          <span className="mono-label end" title="Sockets owned by another user">
            {foreignCount} not yours
          </span>
        )}
      </div>
    </div>
  );
}
