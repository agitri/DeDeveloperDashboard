/**
 * The canvas grid, in one place.
 *
 * Canvas.tsx renders against these and the store packs against them; if the
 * two ever disagreed, "Rearrange all widgets" would place widgets that the
 * grid then immediately moved somewhere else.
 */
export const GRID_COLS = 12;
export const GRID_ROW_HEIGHT = 26;
export const GRID_MARGIN: readonly [number, number] = [10, 10];

/** Floor from Canvas's `minW`/`minH`; every resize preset sits at or above it. */
export const WIDGET_MIN_W = 2;
export const WIDGET_MIN_H = 3;

/** Menu presets. Sizes people actually want, without aiming at a grid handle. */
export const SIZE_PRESETS = [
  { label: "Small", w: 3, h: 5 },
  { label: "Medium", w: 4, h: 6 },
  { label: "Large", w: 6, h: 10 },
  { label: "Full width", w: GRID_COLS, h: null },
] as const;
