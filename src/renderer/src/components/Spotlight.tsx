import { useEffect, useRef, useState } from "react";

/**
 * A cut-out over one `data-wizard-target` element: the rest of the screen
 * dims via an enormous `box-shadow`, the element itself sits in a hole with
 * nothing over it. `pointer-events: none` throughout — this never blocks the
 * click it is pointing at, which is the one thing a DO wizard cannot do.
 *
 * Missing target (wrong look, not yet mounted) is not an error: it renders
 * nothing, and the coach panel alone still carries the step.
 */
export function Spotlight({ target, intense }: { target?: string; intense?: boolean }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const frameRef = useRef<number | undefined>(undefined);
  // Which target we've already scrolled into view, so we bring it on-screen
  // once (when it first appears) rather than fighting the user's own scroll on
  // every poll tick.
  const scrolledFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }

    function measure() {
      frameRef.current = undefined;
      const el = document.querySelector(`[data-wizard-target="${target}"]`);
      // A long environment list pushes the "Create" control below the fold, so
      // the cut-out (and the autofocused input) would sit off-screen. Scroll it
      // into view the first time we find it for this target.
      if (el && scrolledFor.current !== target) {
        scrolledFor.current = target;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        // If the spotlit area is a form (the environment step's Create card),
        // drop the cursor in its first text field so the user can just type —
        // preventScroll because we've already centred it above. Colour inputs
        // are skipped; a target with no text input (a gear, the tab strip) is
        // left alone.
        const input = el.querySelector<HTMLElement>('input:not([type="color"]):not([type="checkbox"]), textarea');
        input?.focus({ preventScroll: true });
      }
      setRect(el ? el.getBoundingClientRect() : null);
    }

    function schedule() {
      if (frameRef.current !== undefined) return;
      frameRef.current = requestAnimationFrame(measure);
    }

    schedule();
    // A short poll keeps the cut-out honest no matter how the target got there:
    // a target that mounts a tick after the step begins (the settings gear as
    // the panel opens), one that moves without a scroll/resize (the tab strip
    // as tabs are added), or a view change swapping the element out. The
    // scroll/resize listeners and the ResizeObserver below still handle the
    // common cases immediately; this only guarantees we never sit on a stale
    // or missed rect.
    const poll = window.setInterval(schedule, 250);
    // Capture phase: a scroll inside a nested pane (the settings body, a
    // widget list) does not bubble to window, and the element it moves may be
    // exactly the one being spotlit.
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);

    // In-place reflow (the tab strip widening as tabs are added) doesn't fire
    // either scroll or resize, so the cut-out would otherwise go stale until
    // the next unrelated event. Missing target/ResizeObserver is not an
    // error — the rAF-scheduled `measure()` above still renders whatever it
    // finds (or nothing).
    let observer: ResizeObserver | undefined;
    const el = document.querySelector(`[data-wizard-target="${target}"]`);
    if (el && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(el);
    }

    return () => {
      clearInterval(poll);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [target, intense]);

  if (!rect) return null;

  const pad = 6;
  const alpha = intense ? 0.72 : 0.5;

  return (
    <div
      className="wizard-spotlight"
      style={{
        left: rect.left - pad,
        top: rect.top - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
        boxShadow: `0 0 0 9999px rgba(0, 0, 0, ${alpha})`,
      }}
    />
  );
}
