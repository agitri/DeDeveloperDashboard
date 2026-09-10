import { useEffect, useMemo } from "react";
import GridLayout, { useContainerWidth, type LayoutItem } from "react-grid-layout";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import { widgetDef } from "../widgets/registry";
import { useFocus } from "../state/focus";
import { releaseControl } from "../keyboard/controls";
import { WidgetFrame } from "./WidgetFrame";
import {
  GRID_COLS as COLS,
  GRID_ROW_HEIGHT as ROW_HEIGHT,
  GRID_MARGIN as MARGIN,
  WIDGET_MIN_W,
  WIDGET_MIN_H,
} from "../state/grid";
import type { EnvTab } from "../types";


/**
 * The tab canvas. Drag and resize come entirely from react-grid-layout — §9
 * names building this by hand as a tarpit, and it is right.
 */
export function Canvas({ tab }: { tab: EnvTab | null }) {
  const updateWidgetLayout = useStore((s) => s.updateWidgetLayout);
  const togglePicker = useUi((s) => s.togglePicker);
  const focusedWidgetId = useFocus((s) => s.focusedWidgetId);
  const itemIndex = useFocus((s) => s.itemIndex);
  const { width, containerRef, mounted } = useContainerWidth();

  // Moving the widget or the row cursor releases whichever button held focus.
  // Enforced here rather than in the two keyboard actions so it also holds for
  // the mouse, the command palette and anything else that moves focus — the
  // invariant is about the state, not about how it got there.
  useEffect(() => {
    releaseControl();
  }, [focusedWidgetId, itemIndex]);

  const layout: LayoutItem[] = useMemo(
    () =>
      (tab?.widgets ?? []).map((w) => ({
        i: w.id,
        x: w.layout.x,
        y: w.layout.y,
        w: w.layout.w,
        h: w.layout.h,
        minW: WIDGET_MIN_W,
        minH: WIDGET_MIN_H,
      })),
    [tab?.widgets],
  );

  if (!tab) {
    return (
      <div className="canvas">
        <div className="canvas-empty">
          <h2>No tab open</h2>
          <p>Press ⌘T for a new tab, or ⌘K to search everything.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="canvas" ref={containerRef}>
      {tab.widgets.length === 0 ? (
        <div className="canvas-empty">
          <h2>{tab.name} is empty</h2>
          <p>
            A widget is a source, a filter and a view. Add one and scope it as wide or as narrow
            as you like.
          </p>
          <button className="btn primary" onClick={() => togglePicker(true)}>
            Add widget
          </button>
        </div>
      ) : (
        mounted && (
          <GridLayout
            width={width}
            className="grid"
            layout={layout}
            gridConfig={{
              cols: COLS,
              rowHeight: ROW_HEIGHT,
              margin: MARGIN,
              containerPadding: [12, 12],
            }}
            // Only the header drags, so text inside a widget stays selectable.
            dragConfig={{ handle: ".widget-drag-handle" }}
            resizeConfig={{ handles: ["se"] }}
            onDragStop={(l) => updateWidgetLayout([...l].map(toUpdate))}
            onResizeStop={(l) => updateWidgetLayout([...l].map(toUpdate))}
          >
            {tab.widgets.map((widget) => {
              const def = widgetDef(widget.kind);
              const View = def?.View;
              return (
                <div key={widget.id}>
                  <WidgetFrame widget={widget} environmentId={tab.environmentId}>
                    {View ? (
                      <View
                        widget={widget}
                        environmentId={tab.environmentId}
                        focused={focusedWidgetId === widget.id}
                        itemIndex={itemIndex}
                      />
                    ) : (
                      <div style={{ color: "var(--ink-3)" }}>
                        Unknown widget kind <code>{widget.kind}</code>. It stays in layout.json
                        untouched, so an older DDD will not eat your board.
                      </div>
                    )}
                  </WidgetFrame>
                </div>
              );
            })}
          </GridLayout>
        )
      )}
    </div>
  );
}

function toUpdate(item: LayoutItem) {
  return { id: item.i, x: item.x, y: item.y, w: item.w, h: item.h };
}
