import { useCallback, useEffect, useRef, useState } from "react";
import { Empty } from "../components/Status";
import { ipc } from "../lib/ipc";
import { recentForProject } from "../lib/about";
import { since } from "../lib/products";
import { awayInfo, buildDigest, extractDelta, isEmptyDelta } from "../lib/sitrep";
import type { SitrepInput } from "../lib/sitrep";
import { useStore } from "../state/store";
import { useRemembered } from "../state/remembered";
import { firstLoad } from "../state/timing";
import type { EventRow, Product, Project } from "../types";
import type { WidgetViewProps } from "./registry";

interface SitrepData {
  project: Project | null;
  products: Product[];
  events: EventRow[];
  changes: { commits: number; filesChanged: number; messages: string[] };
}

const EMPTY: SitrepData = {
  project: null,
  products: [],
  events: [],
  changes: { commits: 0, filesChanged: 0, messages: [] },
};

/** The cached "while you were away" summary, held on `widget.config.sitrep`. */
interface SitrepCache {
  text?: string;
  coveredThroughTs?: string;
  generatedAt?: string;
  model?: string;
  /** Set when the banner is closed, so it stays closed for this same range. */
  dismissedRange?: string;
}

const FALLBACK_WINDOW_MS = 30 * 86_400_000;

/**
 * What changed in a repo while you were away: the widget the "Promote to tab"
 * card builds for you, alongside About and Products.
 *
 * Bound to a single project by `widget.config.projectId`, the same as About.
 * Unlike About it also reads its own tab's `lastVisitedAt` — there is no tab
 * prop on `WidgetViewProps`, so it walks the store to find the tab that holds
 * this widget's id, the way the brief's per-tab-sitrep design calls for.
 *
 * The AI summary is best-effort and cached on the widget: a thrown error from
 * `tabSitrepGenerate` (Ollama down, most likely) must never surface as a
 * crash — it falls back to the deterministic digest with a manual retry,
 * the same rule InstructionsPanel already follows for its own model call.
 */
export function SitrepWidget({ widget, environmentId }: WidgetViewProps) {
  const projectId = String(widget.config.projectId ?? "");
  const awayDays = Number(widget.config.awayDays ?? 14);

  const updateWidget = useStore((s) => s.updateWidget);
  const tabs = useStore((s) => s.tabs());
  const lastVisitedAt = tabs.find((t) => t.widgets.some((w) => w.id === widget.id))?.lastVisitedAt ?? null;

  const [data, setData] = useRemembered<SitrepData>(`sitrep:${environmentId}:${projectId}`, EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [genError, setGenError] = useState(false);
  // Which range we already tried to summarise, so a re-render after a failed
  // attempt does not immediately fire another one — only the retry button, or
  // a genuinely new range, does.
  const attempted = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [project, products, events, changes] = await firstLoad("sitrep", async () => {
        const [projects, prods, aiEvents, productEvents] = await Promise.all([
          ipc.projectsList(environmentId),
          ipc.productsList(environmentId),
          ipc.eventsQuery(environmentId, { since: lastVisitedAt ?? undefined, kindPrefix: "ai.", limit: 200 }),
          ipc.eventsQuery(environmentId, { since: lastVisitedAt ?? undefined, kindPrefix: "product.", limit: 200 }),
        ]);
        const proj = projects.find((p) => p.id === projectId) ?? null;
        const merged = [...aiEvents, ...productEvents].sort((a, b) => (a.ts < b.ts ? 1 : -1));
        const fallbackSince = new Date(Date.now() - FALLBACK_WINDOW_MS).toISOString();
        const repoChanges = proj
          ? await ipc.repoChangesSince(environmentId, proj.path, lastVisitedAt ?? fallbackSince)
          : { commits: 0, filesChanged: 0, messages: [] };
        return [proj, prods, merged, repoChanges] as const;
      });
      setData({ project, products, events, changes });
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }, [environmentId, projectId, lastVisitedAt, setData]);

  useEffect(() => {
    void refresh();
    const seconds = widget.refreshSeconds ?? 60;
    const timer = setInterval(() => void refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [refresh, widget.refreshSeconds]);

  const { project, products, events, changes } = data;
  const away = awayInfo(lastVisitedAt, Date.now(), awayDays);
  const delta = project
    ? extractDelta({ projectName: project.name, projectId, awayDays: away.days, products, events, changes })
    : null;

  // The range this sitrep covers: the newest thing we know about, data-only —
  // never wall-clock time — so it stays stable across renders and only moves
  // forward when a fresh event or a new absence actually arrives.
  let throughTs = lastVisitedAt ?? "";
  for (const e of events) if (e.ts > throughTs) throughTs = e.ts;

  const cached = widget.config.sitrep as SitrepCache | undefined;
  const showBanner = away.away && !!delta && !isEmptyDelta(delta);
  const dismissed = !!cached?.dismissedRange && !!throughTs && cached.dismissedRange >= throughTs;
  const cacheValid = !!cached?.text && !!cached.coveredThroughTs && !!throughTs && cached.coveredThroughTs >= throughTs;

  const generate = useCallback(
    async (input: SitrepInput, key: string) => {
      setPending(true);
      setGenError(false);
      try {
        const result = await ipc.tabSitrepGenerate(environmentId, input);
        updateWidget(widget.id, {
          config: {
            ...widget.config,
            sitrep: {
              ...(widget.config.sitrep as SitrepCache | undefined),
              text: result.text,
              coveredThroughTs: key,
              generatedAt: new Date().toISOString(),
              model: result.model,
            },
          },
        });
      } catch (e) {
        // Ollama down, or any other failure: never throw. The caller falls
        // back to the deterministic digest and a manual retry.
        setGenError(true);
        void e;
      } finally {
        setPending(false);
      }
    },
    [environmentId, widget.id, widget.config, updateWidget],
  );

  useEffect(() => {
    if (!showBanner || dismissed || cacheValid || !delta || !throughTs) return;
    if (attempted.current === throughTs) return;
    attempted.current = throughTs;
    void generate(delta, throughTs);
  }, [showBanner, dismissed, cacheValid, delta, throughTs, generate]);

  if (!projectId) {
    return <Empty title="Bind a project to see its sitrep" />;
  }

  if (error) {
    return <Empty title="Could not read this project" body={error} />;
  }

  // Guarded by `loaded`, the same way About scopes its own empty state: before
  // the project list has come back at all, this would flash "not found" for
  // real projects too.
  if (loaded && !project) {
    return (
      <Empty
        title="Project not found"
        body="Its id doesn't match a project registered in this environment — it may have been unregistered."
      />
    );
  }

  if (!project) return null;

  if (loaded && delta && isEmptyDelta(delta)) {
    return <Empty title="Nothing changed while you were away." />;
  }

  const recent = recentForProject(events, project.name, 8, projectId);

  function dismiss() {
    updateWidget(widget.id, {
      config: {
        ...widget.config,
        sitrep: { ...(cached ?? {}), dismissedRange: throughTs },
      },
    });
  }

  return (
    <div className="item-detail stack">
      {showBanner && !dismissed && (
        <div className="sitrep-banner">
          <button className="icon-btn sitrep-banner-close" aria-label="Dismiss" onClick={dismiss}>
            ×
          </button>
          <div className="sitrep-banner-text">
            {cacheValid ? cached!.text : genError ? buildDigest(delta!) : "Summarising…"}
          </div>
          {genError && (
            <button className="btn xs" disabled={pending} onClick={() => void generate(delta!, throughTs)}>
              {pending ? "Summarising…" : "Summarise with AI"}
            </button>
          )}
        </div>
      )}

      <div className="mono-label caption">{project.name}</div>
      {delta && <div className="ink-2">{buildDigest(delta)}</div>}

      <div>
        <div className="mono-label caption">Timeline</div>
        {recent.length === 0 ? (
          <div className="ink-2">No recent activity.</div>
        ) : (
          <div className="sitrep-timeline">
            {recent.map((event) => (
              <div key={event.id} className="sitrep-line">
                <span className="ink-2">{event.kind}</span>
                <span className="meta ink-3">{relativeAgo(event.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** `since()` reads as a duration ("2h"), "just now", or "" for a bad
 * timestamp — none of which want a bare " ago" suffix appended. */
function relativeAgo(ts: string): string {
  const s = since(ts);
  return s === "" || s === "just now" ? s : `${s} ago`;
}
