/**
 * The third level of focus: the controls inside a widget.
 *
 * Levels one and two — which widget, which row — are app state, because they
 * mean something the DOM has no word for. This level is different: a button is
 * already a DOM element that knows how to be focused, activated by Enter or
 * Space, announced to a screen reader, and drawn with the focus ring both looks
 * already define. Mirroring that into the store would be re-implementing the
 * platform, and would need every widget to register its buttons — a contract
 * that 8 of the 10 widgets never signed for even the row cursor.
 *
 * So the list is computed from the DOM each time it is needed. Nothing is
 * stored, which is also what makes it correct across a re-render: a widget that
 * just refreshed has different buttons, and an index into the old list would
 * point at the wrong one.
 */

/** Everything that can hold focus, in the order the markup puts it on screen. */
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/**
 * The controls of one widget, in visual order.
 *
 * Row buttons come only from the row under the item cursor. Every row in a list
 * carries its own action strip — kept in the DOM at `opacity: 0` so it can fade
 * in — so taking all of them would put 500 rows' worth of buttons between you
 * and the next one you wanted.
 */
export function controlsOf(widget: Element): HTMLElement[] {
  const selectedRow = widget.querySelector(".row.selected");
  const all = [...widget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isAvailable);

  const inRow = (el: Element) => el.closest(".row");
  const rowControls = all.filter((el) => inRow(el) === selectedRow && selectedRow !== null);
  // Everything the widget owns rather than a row: the header's actions and the
  // filter bar. Rows other than the selected one are dropped — every row in a
  // list carries its own action strip, kept in the DOM at `opacity: 0` so it
  // can fade in, so taking all of them would put 500 rows' worth of buttons
  // between you and the next one you wanted.
  const widgetControls = all.filter((el) => !inRow(el));

  // The selected row's actions come first, ahead of the widget's own, even
  // though the markup is the other way round. You press `l` while looking at a
  // row: the thing you meant was on that row, not in the header above it.
  return [...rowControls, ...widgetControls];
}

function isAvailable(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled")) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  // `offsetParent` is null for anything `display: none`, including every
  // control inside a collapsed row detail. A hidden control is not a stop on
  // the way to a visible one.
  return el.offsetParent !== null;
}

/**
 * The next control after the one that has focus, wrapping at the ends.
 *
 * With nothing focused yet, a forward step lands on the first control and a
 * backward step on the last — the same rule `moveWidgetFocus` uses, so both
 * levels behave the same way when you arrive at them.
 */
export function nextControl(controls: HTMLElement[], active: Element | null, delta: number): HTMLElement | null {
  if (controls.length === 0) return null;
  // `indexOf`, not an `instanceof` narrowing: an element that is no longer in
  // the list — the widget refreshed while it held focus — has to read the same
  // as no focus at all, and it already does.
  const current = controls.indexOf(active as HTMLElement);
  if (current === -1) return delta > 0 ? controls[0]! : controls[controls.length - 1]!;
  const next = (((current + delta) % controls.length) + controls.length) % controls.length;
  return controls[next]!;
}

/** The focused widget, as the DOM marks it. */
export function focusedWidgetElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".widget.focused");
}

/** The control inside the focused widget that currently has focus, if any. */
export function focusedControl(): HTMLElement | null {
  const widget = focusedWidgetElement();
  const active = document.activeElement;
  if (!widget || !(active instanceof HTMLElement)) return null;
  return widget.contains(active) && active !== widget ? active : null;
}

/**
 * Drop control focus back to the row.
 *
 * Focusing a higher level releases the one below it: move to another widget or
 * another row and the button you were on is no longer the button in front of
 * you. Left alone, the ring stays behind on a row you have left — or, after
 * Tab, inside a widget that is no longer the focused one.
 */
export function releaseControl(): void {
  // Deliberately not `focusedControl()`: that one is scoped to the *currently*
  // focused widget, and the control being released is by definition in the
  // widget or row you just left. Asking the narrower question found nothing to
  // blur and left the ring behind in the old widget.
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest(".widget")) active.blur();
}
