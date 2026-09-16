import { useEffect, useMemo, useRef, useState } from "react";
import { buildGuide, type GuideEntry, type GuideGroup } from "../lib/guide";
import { useUi } from "../state/ui";
import { WIDGETS } from "../widgets/registry";

const GROUP_LABELS: Record<GuideGroup, string> = {
  widget: "Widgets",
  integration: "Integrations",
  concept: "Concepts",
};

const GROUP_ORDER: GuideGroup[] = ["widget", "integration", "concept"];

/**
 * The `?` in the header. One place that answers "what is this and how do I use
 * it" for every widget, integration and concept in the app, so a feature does
 * not need its own tour to be discoverable (mirrors CommandPalette / §5.10).
 */
export function FeaturesGuide() {
  const open = useUi((s) => s.guideOpen);
  const toggleGuide = useUi((s) => s.toggleGuide);
  const [openId, setOpenId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Computed once: the guide describes what the app can do, not its current
  // state, so it never needs to be rebuilt while open.
  const entries = useMemo(() => buildGuide(WIDGETS), []);

  // Focus trap: moving DOM focus onto the panel the moment it opens keeps Tab
  // (and every other board shortcut) from reaching a widget behind the scrim.
  // The global keydown handler in keyboard/useKeyboard.ts does the other half
  // — suppressing board-scope actions outright while an overlay is open.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const groups = GROUP_ORDER.map((group) => ({
    group,
    entries: entries.filter((e) => e.group === group),
  })).filter((g) => g.entries.length > 0);

  return (
    <div className="scrim" onMouseDown={() => toggleGuide(false)}>
      <div
        ref={panelRef}
        className="panel"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Features guide"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            toggleGuide(false);
          }
        }}
      >
        <div className="panel-input">Features guide</div>
        <div className="panel-list">
          {groups.map(({ group, entries: groupEntries }) => (
            <div key={group}>
              <div className="panel-group mono-label">{GROUP_LABELS[group]}</div>
              {groupEntries.map((entry) => (
                <GuideRow
                  key={entry.id}
                  entry={entry}
                  open={openId === entry.id}
                  // Single-open: opening one closes whichever else was open;
                  // clicking the open one closes it.
                  onToggle={() => setOpenId((current) => (current === entry.id ? null : entry.id))}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GuideRow({ entry, open, onToggle }: { entry: GuideEntry; open: boolean; onToggle: () => void }) {
  const detailId = `guide-detail-${entry.id}`;
  return (
    <div>
      <button className="guide-row" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
        <span className="grow">{entry.title}</span>
        <span className={`guide-chevron${open ? " open" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div id={detailId} role="region" className="guide-detail item-detail stack">
          <div>
            <div className="mono-label caption">what it is</div>
            <div className="ink-2">{entry.what}</div>
          </div>
          <div>
            <div className="mono-label caption">how to use it</div>
            <div className="ink-2">{entry.how}</div>
          </div>
          {entry.needs && (
            <div>
              <div className="mono-label caption">needs</div>
              <div className="ink-2">
                <code>{entry.needs}</code>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
