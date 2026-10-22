import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "../lib/ipc";
import type { EventRow } from "../types";
import type { WidgetViewProps } from "./registry";
import { useRemembered } from "../state/remembered";
import { firstLoad } from "../state/timing";

/**
 * The stats board (§5.7) — your dashboard about you.
 *
 * Every action already flows through the sync and AI layers and writes an event,
 * so this widget is charts over a table that was being filled the whole time.
 * Zero telemetry leaves the machine; the numbers are local or they do not exist.
 *
 * Charting decisions worth keeping: each chart is a **single series**, so there
 * is no categorical palette to get wrong and no legend to read — the title names
 * the series and the bars take the environment accent. Counters are stat tiles
 * rather than charts, because a number that has no shape over time is not a
 * chart, it is a number.
 */

const WINDOW_DAYS = 14;
/** Bounded so one query cannot walk a year of history. Surfaced, not silent. */
const MAX_EVENTS = 5000;

export function StatsWidget({ environmentId }: WidgetViewProps) {
  const [rows, setRows] = useRemembered<EventRow[]>(`stats:${environmentId}`, []);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    try {
      setRows(await firstLoad("stats", () => ipc.eventsQuery(environmentId, { since, limit: MAX_EVENTS })));
    } finally {
      setLoaded(true);
    }
  }, [environmentId, setRows]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const stats = useMemo(() => summarize(rows), [rows]);

  if (loaded && rows.length === 0) {
    return (
      <div className="widget-blank ink-3">
        Nothing logged yet in the last {WINDOW_DAYS} days. The events table fills itself as you use the board — switch a tab and come back.
      </div>
    );
  }

  return (
    <div className="chart-stack">
      <Hero
        value={stats.spend > 0 ? `$${(stats.spend / 1_000_000).toFixed(2)}` : "$0.00"}
        label={`AI spend · last ${WINDOW_DAYS} days`}
        detail={stats.localShare !== null ? `${Math.round(stats.localShare * 100)}% of AI actions ran locally` : "no AI actions yet"}
      />

      {/* Dividers are drawn on the tiles, not as a gap over a coloured
          container — an auto-fit grid leaves the last row partly empty, and a
          container background shows through as a dangling block. Console drops
          the borders entirely and groups the numbers by spacing. */}
      <div className="stat-nums">
        <Tile label="AI actions" value={stats.aiActions} />
        <Tile label="Tokens" value={compact(stats.tokens)} />
        <Tile label="Tab switches" value={stats.tabSwitches} />
        <Tile label="Launches" value={stats.launches} />
        <Tile label="Actions" value={stats.itemActions} />
        <Tile label="Syncs" value={stats.syncs} />
      </div>

      <BarChart title="Activity per day" series={stats.perDayActivity} format={(n) => `${n} event${n === 1 ? "" : "s"}`} />
      <BarChart
        title="AI spend per day"
        series={stats.perDaySpend}
        format={(n) => `$${(n / 1_000_000).toFixed(3)}`}
        emptyNote="No AI spend in this window."
      />

      <div className="mono-label">
        {rows.length >= MAX_EVENTS ?
          `showing the most recent ${MAX_EVENTS} events — older ones exist but are not counted here`
        : `${rows.length} events · never leaves this machine`}
      </div>
    </div>
  );
}

// --- summarizing ------------------------------------------------------------

interface Point {
  day: string;
  value: number;
}

function summarize(rows: EventRow[]) {
  const days: string[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  }
  const activity = new Map(days.map((d) => [d, 0]));
  const spend = new Map(days.map((d) => [d, 0]));

  let total = 0;
  let tokens = 0;
  let aiActions = 0;
  let localActions = 0;
  let tabSwitches = 0;
  let launches = 0;
  let itemActions = 0;
  let syncs = 0;

  for (const row of rows) {
    const day = row.ts.slice(0, 10);
    if (activity.has(day)) activity.set(day, activity.get(day)! + 1);

    const cost = row.costMicros ?? 0;
    if (cost > 0 && spend.has(day)) spend.set(day, spend.get(day)! + cost);
    total += cost;
    tokens += (row.tokensIn ?? 0) + (row.tokensOut ?? 0);

    if (row.kind.startsWith("ai.")) {
      aiActions += 1;
      // "How much am I keeping local?" is the question the routing config is
      // really about, so it gets a number rather than a chart.
      if (row.source === "local") localActions += 1;
    }
    if (row.kind === "tab.switch") tabSwitches += 1;
    if (row.kind === "project.launch") launches += 1;
    if (row.kind.startsWith("item.")) itemActions += 1;
    if (row.kind === "sync.fetch") syncs += 1;
  }

  return {
    spend: total,
    tokens,
    aiActions,
    localShare: aiActions > 0 ? localActions / aiActions : null,
    tabSwitches,
    launches,
    itemActions,
    syncs,
    perDayActivity: days.map((day) => ({ day, value: activity.get(day)! })) as Point[],
    perDaySpend: days.map((day) => ({ day, value: spend.get(day)! })) as Point[],
  };
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// --- marks ------------------------------------------------------------------

function Hero({ value, label, detail }: { value: string; label: string; detail: string }) {
  return (
    <div>
      <div className="mono-label">{label}</div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 34,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div className="chart-caption">{detail}</div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  // `<b>` then `<span>` is the design's contract for a figure and its caption;
  // both looks style the same two elements.
  return (
    <div className="stat-num">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/**
 * Single-series bars. Recessive baseline, 2px gaps between marks, 3px rounded
 * data-ends anchored to the baseline, and a hover readout — an SVG chart in a
 * browser is interactive, so it gets a tooltip rather than a number stamped on
 * every bar.
 */
function BarChart({
  title,
  series,
  format,
  emptyNote,
}: {
  title: string;
  series: Point[];
  format: (value: number) => string;
  emptyNote?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...series.map((p) => p.value), 1);
  const allZero = series.every((p) => p.value === 0);

  const height = 64;
  const width = 100; // viewBox units; the SVG scales to its container
  const slot = width / series.length;
  const barWidth = Math.max(slot - 2 * (slot / 12), slot * 0.5);

  return (
    <div>
      <div className="chart-head">
        <span className="mono-label">{title}</span>
        <span className="grow" />
        <span className="chart-figure">
          {hover !== null ? `${series[hover]!.day.slice(5)} · ${format(series[hover]!.value)}` : `peak ${format(max)}`}
        </span>
      </div>

      {allZero && emptyNote ?
        <div className="chart-caption">{emptyNote}</div>
      : <div className="stat-chart">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            style={{ width: "100%", height, display: "block" }}
            role="img"
            aria-label={`${title}. ${series.map((p) => `${p.day}: ${format(p.value)}`).join(", ")}`}
            onMouseLeave={() => setHover(null)}
          >
            {/* Baseline only — a full grid would compete with 14 thin marks. */}
            <line
              x1={0}
              y1={height - 0.5}
              x2={width}
              y2={height - 0.5}
              stroke="var(--line)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {series.map((point, index) => {
              const barHeight = point.value === 0 ? 0 : Math.max((point.value / max) * (height - 6), 2);
              const x = index * slot + (slot - barWidth) / 2;
              return (
                <g key={point.day}>
                  <rect
                    x={x}
                    y={height - barHeight}
                    width={barWidth}
                    height={barHeight}
                    rx={1.2}
                    // The newest day is the environment colour at full strength;
                    // the rest are a mix. Set as a class so the stylesheet owns
                    // the palette rather than the component.
                    className={`bar${index === series.length - 1 ? " today" : ""}`}
                    opacity={hover === null || hover === index ? 1 : 0.45}
                  />
                  {/* Hit target spans the full slot and the full height, so a
                    zero-value day is still hoverable. It carries a class rather
                    than only `fill="transparent"`: a stylesheet rule on `rect`
                    beats a presentation attribute, so styling the bars from CSS
                    turned every hit target into a solid block. */}
                  <rect
                    className="hit"
                    x={index * slot}
                    y={0}
                    width={slot}
                    height={height}
                    fill="transparent"
                    onMouseEnter={() => setHover(index)}
                  />
                </g>
              );
            })}
          </svg>
        </div>
      }
    </div>
  );
}
