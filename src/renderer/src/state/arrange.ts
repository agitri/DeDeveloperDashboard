//! Tidying the canvas.
//!
//! Kept as a pure function over widgets rather than a store action so the
//! packing rules can be tested without a zustand store or a DOM.

import type { Widget } from "../types";

/**
 * Reflow widgets into a packed grid: current reading order, current sizes,
 * wrapping at `cols`, no gaps.
 *
 * Sizes are deliberately untouched. A "tidy up" that silently resized things
 * would be a worse surprise than the mess it cleaned up — resizing is what the
 * Resize presets and the drag handle are for.
 */
export function packWidgets(widgets: Widget[], cols: number): Widget[] {
  // Reading order across the grid: down first, then across, which is how the
  // canvas is laid out and how j/k already traverses it.
  const ordered = [...widgets].sort(
    (a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x,
  );

  let x = 0;
  let rowTop = 0;
  let rowHeight = 0;

  return ordered.map((widget) => {
    // Clamp first: a widget wider than the grid can never fit, and without
    // this it would wrap forever onto rows of its own with x drifting.
    const w = Math.min(widget.layout.w, cols);
    if (x > 0 && x + w > cols) {
      rowTop += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    const placed: Widget = { ...widget, layout: { ...widget.layout, x, y: rowTop, w } };
    x += w;
    rowHeight = Math.max(rowHeight, widget.layout.h);
    return placed;
  });
}
