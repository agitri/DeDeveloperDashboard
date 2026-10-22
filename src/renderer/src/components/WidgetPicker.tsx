import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyScore } from "../lib/fuzzy";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import { PRESETS, presetSource } from "../widgets/registry";

/**
 * The `+` on every tab. Deliberately the same panel shape as the palette:
 * adding a widget is just another searchable action, not a modal wizard.
 */
export function WidgetPicker() {
  const open = useUi((s) => s.pickerOpen);
  const togglePicker = useUi((s) => s.togglePicker);
  const addWidget = useStore((s) => s.addWidget);
  const tabName = useStore((s) => s.activeTab()?.name);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row on screen: arrowing past the bottom of the list
  // moved the cursor but not the scroll, so the selection went off-screen.
  useEffect(() => {
    listRef.current?.querySelector(".panel-row.active")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const results = useMemo(() => {
    const scored = PRESETS.map((def) => ({
      def,
      score: fuzzyScore(query, `${def.name} ${def.description} ${presetSource(def) ?? ""}`),
    })).filter((r) => r.score !== null);
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return scored.map((r) => r.def);
  }, [query]);

  if (!open) return null;

  function add(preset: (typeof PRESETS)[number]) {
    togglePicker(false);
    addWidget(preset.kind, { filter: preset.filter, title: preset.title });
  }

  return (
    <div className="scrim" onMouseDown={() => togglePicker(false)}>
      <div className="panel" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Add widget">
        <input
          ref={inputRef}
          className="panel-input"
          placeholder={`Add a widget to ${tabName ?? "this tab"}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(results.length - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const def = results[cursor];
              if (def) add(def);
            } else if (e.key === "Escape") {
              e.preventDefault();
              togglePicker(false);
            }
          }}
        />
        <div className="panel-list" ref={listRef}>
          {results.map((def, index) => (
            <button
              key={def.id}
              className={`panel-row${index === cursor ? " active" : ""}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => add(def)}
            >
              <span className="mono-label" style={{ width: 62, flex: "none" }}>
                {presetSource(def) ?? "local"}
              </span>
              <span className="grow">
                <div>{def.name}</div>
                <div className="sub">{def.description}</div>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
