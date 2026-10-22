import { useCallback, useEffect, useMemo, useState } from "react";
import { gridWindow, monthGrid } from "../lib/monthGrid";
import { ipc } from "../lib/ipc";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import type { Occurrence } from "../types";
import type { WidgetViewProps } from "./registry";

/**
 * Subscribed calendars and your own events, in one view.
 *
 * Like every widget this reads only — `calendar_list` merges the item cache
 * with `calendar.json` and expands recurrence for the visible window. Paging to
 * next month is a re-read, never a re-fetch: the scheduler owns fetching.
 */
export function CalendarWidget({ widget, environmentId }: WidgetViewProps) {
  const updateWidget = useStore((s) => s.updateWidget);
  const showToast = useUi((s) => s.showToast);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [offset, setOffset] = useState(0);

  const view = (widget.filter.view as string) ?? "month";
  const firstDay = Number(widget.filter.firstDay ?? 1);

  // `offset` months from this one. Built from a real Date so month arithmetic
  // stays month arithmetic and never becomes 30-day arithmetic.
  const anchor = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + offset, 1);
  }, [offset]);

  const days = useMemo(
    () => (view === "month" ? monthGrid(anchor.getFullYear(), anchor.getMonth(), firstDay) : weekGrid(anchor, offset, firstDay)),
    [view, anchor, offset, firstDay],
  );

  const load = useCallback(async () => {
    const { from, to } = gridWindow(days);
    try {
      const listing = await ipc.calendarList(environmentId, from, to);
      // The backend sorts, but the agenda's day headings are built from runs of
      // consecutive equal dates — an assumption about another layer's output
      // that costs one line to stop making.
      setOccurrences([...listing].sort((a, b) => a.start.localeCompare(b.start)));
    } catch (e) {
      showToast(String(e));
    }
  }, [environmentId, days, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  // The scheduler is what refreshes the cache; without this a synced calendar
  // would update the database and this screen would never know.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void ipc
      .onItemsChanged(({ environmentId: changed }) => {
        if (changed === environmentId) void load();
      })
      .then((un) => (cancelled ? un() : (dispose = un)));
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [environmentId, load]);

  const byDay = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    for (const o of occurrences) {
      const key = localKey(new Date(o.start));
      const list = map.get(key);
      if (list) list.push(o);
      else map.set(key, [o]);
    }
    return map;
  }, [occurrences]);

  function setView(next: string) {
    updateWidget(widget.id, { filter: { ...widget.filter, view: next } });
  }

  return (
    <div className="cal">
      <div className="cal-bar">
        {(["month", "week", "agenda"] as const).map((option) => (
          <button key={option} className={`btn${view === option ? " primary" : ""}`} onClick={() => setView(option)}>
            {option[0]!.toUpperCase() + option.slice(1)}
          </button>
        ))}
        <span className="grow" />
        <button className="btn" title="Previous" onClick={() => setOffset((o) => o - 1)}>
          ‹
        </button>
        <button className="btn" onClick={() => setOffset(0)}>
          Today
        </button>
        <button className="btn" title="Next" onClick={() => setOffset((o) => o + 1)}>
          ›
        </button>
        <span className="mono-label" style={{ marginLeft: 6 }}>
          {anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </span>
      </div>

      {view === "agenda" ?
        <Agenda occurrences={occurrences} />
      : <Grid days={days} byDay={byDay} month={anchor.getMonth()} firstDay={firstDay} />}
    </div>
  );
}

function weekGrid(_anchor: Date, offset: number, firstDay: number): Date[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset * 7);
  const back = (today.getDay() - firstDay + 7) % 7;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/**
 * A date's own key in local time. `toISOString()` would convert to UTC and put
 * anything after 22:00 in Amsterdam on the following day.
 */
function localKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Grid({ days, byDay, month, firstDay }: { days: Date[]; byDay: Map<string, Occurrence[]>; month: number; firstDay: number }) {
  const todayKey = localKey(new Date());
  return (
    <div className="cal-grid">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="cal-head mono-label">
          {WEEKDAYS[(firstDay + i) % 7]}
        </div>
      ))}
      {days.map((day) => {
        const key = localKey(day);
        const events = byDay.get(key) ?? [];
        return (
          <div key={key} className={`cal-day${day.getMonth() === month ? "" : " outside"}${key === todayKey ? " today" : ""}`}>
            <div className="cal-date">{day.getDate()}</div>
            {events.map((o) => (
              <Pill key={o.id} occurrence={o} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Agenda({ occurrences }: { occurrences: Occurrence[] }) {
  if (occurrences.length === 0) {
    return <div className="cal-empty">Nothing scheduled in this range.</div>;
  }
  let lastDay = "";
  return (
    <div className="rows">
      {occurrences.map((o) => {
        const day = localKey(new Date(o.start));
        const heading = day !== lastDay ? day : null;
        lastDay = day;
        return (
          <div key={o.id}>
            {heading && (
              <div className="mono-label" style={{ padding: "8px 10px 2px" }}>
                {new Date(o.start).toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
              </div>
            )}
            <div className="row">
              <div className="row-main">
                <div className="row-title">
                  <i className="cal-dot" style={{ background: o.color }} /> {o.title}
                </div>
                <div className="row-sub">
                  {o.allDay ? "all day" : timeRange(o)} · {o.calendar}
                  {o.location ? ` · ${o.location}` : ""}
                  {o.recurringUnexpanded && <span className="meta tone-warn">recurring — shown once</span>}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Pill({ occurrence }: { occurrence: Occurrence }) {
  return (
    <div
      className="cal-pill"
      style={{ ["--pill" as string]: occurrence.color }}
      title={`${occurrence.title}${occurrence.location ? ` · ${occurrence.location}` : ""} · ${
        occurrence.calendar
      }${occurrence.recurringUnexpanded ? " · recurring — shown once" : ""}`}
    >
      {!occurrence.allDay && <span className="cal-time">{shortTime(occurrence.start)}</span>}
      {occurrence.title}
    </div>
  );
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function timeRange(o: Occurrence): string {
  return `${shortTime(o.start)}–${shortTime(o.end)}`;
}
