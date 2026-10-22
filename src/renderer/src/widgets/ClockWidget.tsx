import { useEffect, useState } from "react";
import type { WidgetViewProps } from "./registry";

/** Proof that the widget contract holds with no data source behind it. */
export function ClockWidget(_props: WidgetViewProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Tick on the second boundary rather than every 1000ms from mount, so the
    // display never sits visibly behind the system clock.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setNow(new Date());
          schedule();
        },
        1000 - (Date.now() % 1000),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  return (
    <div style={{ display: "grid", placeContent: "center", height: "100%", gap: 6 }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 30,
          letterSpacing: "-0.02em",
          fontVariantNumeric: "tabular-nums",
          textAlign: "center",
        }}
      >
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </div>
      <div className="mono-label" style={{ textAlign: "center" }}>
        {now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
      </div>
    </div>
  );
}
