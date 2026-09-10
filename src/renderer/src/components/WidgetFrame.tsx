import { useState, type ReactNode } from "react";
import { InstructionsPanel, useInstructionsSync } from "./InstructionsPanel";
import { useFocus } from "../state/focus";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import { SIZE_PRESETS } from "../state/grid";
import { widgetDef } from "../widgets/registry";
import type { MenuItem } from "./ContextMenu";
import type { Compiled, Widget } from "../types";
import { describe } from "../lib/instructions";

/**
 * The chrome around every widget: label, drag handle, remove, focus ring.
 *
 * The focus ring is not decoration — §5.10 makes it a requirement, because
 * keyboard navigation is unusable when you cannot see where you are.
 */
export function WidgetFrame({
  widget,
  environmentId,
  children,
}: {
  widget: Widget;
  environmentId: string;
  children: ReactNode;
}) {
  const def = widgetDef(widget.kind);
  const focusedWidgetId = useFocus((s) => s.focusedWidgetId);
  const focusWidget = useFocus((s) => s.focusWidget);
  const removeWidget = useStore((s) => s.removeWidget);
  const updateWidget = useStore((s) => s.updateWidget);
  const updateWidgetLayout = useStore((s) => s.updateWidgetLayout);
  const arrangeWidgets = useStore((s) => s.arrangeWidgets);
  const openMenu = useUi((s) => s.openMenu);
  const [editing, setEditing] = useState(false);
  const [instructing, setInstructing] = useState(false);
  // A filtered widget must never look like an unfiltered one, so the button
  // carries a dot when this widget has instructions.
  const compiled = widget.config.instructions as Compiled | undefined;
  const instructable = def?.instructable === true;
  useInstructionsSync(widget, environmentId);
  const focused = focusedWidgetId === widget.id;

  function resize(w: number, h: number | null) {
    updateWidgetLayout([
      { id: widget.id, x: widget.layout.x, y: widget.layout.y, w, h: h ?? widget.layout.h },
    ]);
  }

  /**
   * No item actions here. Comment, Approve and Archive send things outward and
   * belong on the item behind the approval gate; a menu that mixes "delete this
   * widget" with "reply to this person" invites the wrong click.
   */
  function items(x: number, y: number): MenuItem[] {
    return [
      { kind: "action", label: "Edit widget…", run: () => setEditing(true) },
      ...(instructable
        ? [{ kind: "action" as const, label: "Tell it what to show…", run: () => setInstructing(true) }]
        : []),
      ...(def?.menuItems?.(widget) ?? []),
      {
        kind: "submenu",
        label: "Resize",
        items: SIZE_PRESETS.map((preset) => ({
          kind: "action" as const,
          label: preset.label,
          run: () => resize(preset.w, preset.h),
        })),
      },
      { kind: "action", label: "Rearrange all widgets", run: () => arrangeWidgets() },
      { kind: "separator" },
      {
        kind: "action",
        label: "Delete this widget",
        danger: true,
        // A menu closes on click, so a two-step confirm cannot live inside one
        // row. Re-open at the same spot with only the confirmation on it —
        // same pattern as Remove… → Unregister on a project card.
        run: () =>
          openMenu(x, y, [
            {
              kind: "action",
              label: "Delete — this cannot be undone",
              danger: true,
              run: () => removeWidget(widget.id),
            },
            { kind: "action", label: "Cancel", run: () => {} },
          ]),
      },
    ];
  }

  return (
    <div
      className={`widget${focused ? " focused" : ""}`}
      onMouseDown={() => focusWidget(widget.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, items(e.clientX, e.clientY));
      }}
    >
      <div className="widget-head w-head widget-drag-handle">
        {/* The `▪` before the kicker is a CSS ::before in the Console system,
            so the name stays the name. */}
        <span className="mono-label w-kicker">{def?.name ?? widget.kind}</span>
        {/* Presets often title a widget after its own kind, and the header
            already names the kind — "REPOSITORIES Repositories" reads as a
            truncation bug rather than a label. Show a title only when it says
            something the kicker does not. */}
        <span className="title w-title">
          {widget.title && widget.title !== def?.name ? widget.title : ""}
        </span>
        <div className="widget-actions w-actions">
          {instructable && (
            <button
              className={`icon-btn text${compiled ? " on" : ""}`}
              title={
                compiled
                  ? "This widget has instructions — click to read or change them"
                  : "Tell this widget what to show, in words"
              }
              aria-label="Widget instructions"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setInstructing(true)}
            >
              AI{compiled ? "•" : ""}
            </button>
          )}
          <button
            className="icon-btn"
            title="Remove widget"
            aria-label="Remove widget"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => removeWidget(widget.id)}
          >
            ×
          </button>
        </div>
      </div>
      {editing && (
        <WidgetEditor
          widget={widget}
          onClose={() => setEditing(false)}
          onSave={(patch) => {
            updateWidget(widget.id, patch);
            setEditing(false);
          }}
        />
      )}
      {instructing && (
        <InstructionsPanel
          widget={widget}
          environmentId={environmentId}
          onClose={() => setInstructing(false)}
        />
      )}
      {compiled && !instructing && (
        // An empty widget must be explained rather than mysterious: whatever is
        // (or is not) below is the result of a sentence you wrote, and this is
        // the line that says so.
        <button
          className={`mono-label instruction-strip${compiled.unmet.length > 0 ? " warn" : ""}`}
          title="Click to read or change these instructions"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setInstructing(true)}
        >
          {describe(compiled.filter).join(" ")}
          {compiled.unmet.length > 0 && ` · ${compiled.unmet.length} not possible`}
        </button>
      )}
      <div className={`widget-body w-body${def?.flush ? " flush" : ""}`}>{children}</div>
      {/* The resize affordance. react-grid-layout owns the actual handle at the
          same corner; this is the mark that says it is there. */}
      <span className="w-resize" aria-hidden="true" />
      {/* environmentId travels with the widget so a view can never accidentally
          read another environment's data. */}
      <span hidden data-environment={environmentId} />
    </div>
  );
}

/**
 * Title and refresh interval, and deliberately nothing else.
 *
 * Filters stay where they already are — the repos widget owns scope and search
 * in its own filter bar — because two places to set one thing is how the two
 * drift apart.
 */
function WidgetEditor({
  widget,
  onClose,
  onSave,
}: {
  widget: Widget;
  onClose: () => void;
  onSave: (patch: Partial<Widget>) => void;
}) {
  const [title, setTitle] = useState(widget.title ?? "");
  const [refresh, setRefresh] = useState(
    widget.refreshSeconds === null || widget.refreshSeconds === undefined
      ? ""
      : String(widget.refreshSeconds),
  );

  function save() {
    const seconds = refresh.trim() === "" ? null : Number(refresh);
    onSave({
      title: title.trim() === "" ? null : title.trim(),
      // A blank box means "use the default", not "refresh zero seconds from
      // now" — and a non-number must not be written into layout.json at all.
      refreshSeconds: seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    });
  }

  return (
    <div
      className="widget-editor"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="mono-label" htmlFor={`title-${widget.id}`}>
        Title
      </label>
      <input
        id={`title-${widget.id}`}
        className="field"
        autoFocus
        value={title}
        placeholder={widgetDef(widget.kind)?.name ?? widget.kind}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label className="mono-label" htmlFor={`refresh-${widget.id}`}>
        Refresh (s)
      </label>
      <input
        id={`refresh-${widget.id}`}
        className="field"
        inputMode="numeric"
        value={refresh}
        placeholder="default"
        onChange={(e) => setRefresh(e.target.value)}
      />
      <button className="btn primary" onClick={save}>
        Save
      </button>
      <button className="btn" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
