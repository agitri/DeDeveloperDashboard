import { useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "./Kbd";
import { buildActions, type Action } from "../keyboard/actions";
import { fuzzyScore } from "../lib/fuzzy";
import { useUi } from "../state/ui";

/**
 * ⌘K — the universal entry point (§5.10). Every action in the registry is
 * reachable here, which is what lets the rest of the UI stay uncluttered: a
 * feature does not need a button to be usable.
 */
export function CommandPalette({ keymap }: { keymap: Record<string, string[]> }) {
  const open = useUi((s) => s.paletteOpen);
  const togglePalette = useUi((s) => s.togglePalette);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row on screen: arrowing past the bottom of the list
  // moved the cursor but not the scroll, so the selection went off-screen.
  useEffect(() => {
    listRef.current?.querySelector(".panel-row.active")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Snapshot the registry when the palette opens: actions close over live store
  // state, and rebuilding them mid-keystroke would reshuffle the list.
  const actions = useMemo<Action[]>(() => (open ? buildActions() : []), [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const results = useMemo(() => {
    const scored = actions
      .map((action) => ({
        action,
        score: fuzzyScore(query, `${action.title} ${action.group} ${action.keywords ?? ""}`),
      }))
      .filter((r): r is { action: Action; score: number } => r.score !== null);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 40).map((r) => r.action);
  }, [actions, query]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  if (!open) return null;

  function run(action: Action) {
    togglePalette(false);
    // Let the overlay unmount before the action moves focus around.
    requestAnimationFrame(() => action.run());
  }

  return (
    <div className="scrim" onMouseDown={() => togglePalette(false)}>
      <div className="panel" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="panel-input"
          placeholder="Search actions, tabs, projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
              e.preventDefault();
              setCursor((c) => Math.min(results.length - 1, c + 1));
            } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const action = results[cursor];
              if (action) run(action);
            } else if (e.key === "Escape") {
              e.preventDefault();
              togglePalette(false);
            }
          }}
        />

        <div className="panel-list" ref={listRef}>
          {results.length === 0 && <div className="panel-empty">Nothing matches “{query}”.</div>}
          {results.map((action, index) => {
            const binding = keymap[action.id]?.[0];
            return (
              <button
                key={action.id}
                className={`panel-row${index === cursor ? " active" : ""}`}
                onMouseEnter={() => setCursor(index)}
                onClick={() => run(action)}
              >
                <span className="mono-label" style={{ width: 62, flex: "none" }}>
                  {action.group}
                </span>
                <span className="grow">
                  <span>{action.title}</span>
                  {action.hint && <span className="sub"> · {action.hint}</span>}
                </span>
                {binding && <Kbd binding={binding} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
