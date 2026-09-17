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

  useEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }

    function measure() {
      frameRef.current = undefined;
      const el = document.querySelector(`[data-wizard-target="${target}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    }

    function schedule() {
      if (frameRef.current !== undefined) return;
      frameRef.current = requestAnimationFrame(measure);
    }

    schedule();
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
