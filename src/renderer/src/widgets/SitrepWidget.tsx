import { useCallback, useEffect, useRef, useState } from "react";
import { Empty } from "../components/Status";
import { ipc } from "../lib/ipc";
import { recentForProject } from "../lib/about";
import { since } from "../lib/products";
import { awayInfo, buildDigest, extractDelta, isEmptyDelta, newestRelevantTs, sitrepBanner, sitrepCacheKey } from "../lib/sitrep";
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
 * this widget's id, the way the per-tab-sitrep design calls for. That same
 * lookup gives it the tab's id, which it needs anyway: a generated summary
 * has to land on the tab that owns this widget even if the user has switched
 * away by the time it resolves, so writes go through `updateWidgetIn`
 * (tab-targeted) rather than `updateWidget` (active-tab-targeted).
 *
 * All of the cache/fallback *decisions* — what the banner shows, and whether
 * the range is stale — live in pure, tested helpers (`sitrepCacheKey`,
 * `sitrepBanner` in `lib/sitrep.ts`). This component only wires them to the
 * store and to `ipc.tabSitrepGenerate`, and never throws even when that call
 * rejects (Ollama down, no desktop bridge, or anything else) — the same rule
 * InstructionsPanel already follows for its own model call.
 */
export function SitrepWidget({ widget, environmentId }: WidgetViewProps) {
  const projectId = typeof widget.config.projectId === "string" ? widget.config.projectId : "";
  const awayDays = Number(widget.config.awayDays ?? 14);

  const updateWidgetIn = useStore((s) => s.updateWidgetIn);
  const tabs = useStore((s) => s.tabs());
  const ownTab = tabs.find((t) => t.widgets.some((w) => w.id === widget.id));
  const tabId = ownTab?.id ?? null;
  const lastVisitedAt = ownTab?.lastVisitedAt ?? null;

  const [data, setData] = useRemembered<SitrepData>(`sitrep:${environmentId}:${widget.id}`, EMPTY);
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
        // Newest first; `0` for equal timestamps keeps the comparator a valid
        // total order rather than one that quietly depends on sort stability.
        const merged = [...aiEvents, ...productEvents].sort((a, b) =>
          a.ts === b.ts ? 0
          : a.ts < b.ts ? 1
          : -1,
        );
        const fallbackSince = new Date(Date.now() - FALLBACK_WINDOW_MS).toISOString();
        const repoChanges =
          proj ?
            await ipc.repoChangesSince(environmentId, proj.path, lastVisitedAt ?? fallbackSince)
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
  const delta = project ? extractDelta({ projectName: project.name, projectId, awayDays: away.days, products, events, changes }) : null;

  // `newestRelevantTs` deliberately excludes the widget's own `ai.tab.sitrep`
  // event — see its doc comment. Using a plain "newest of all events" here
  // would feed each generation's own event back into the key that decides
  // whether to generate again, regenerating forever on an away tab left open.
  const currentKey = sitrepCacheKey({
    lastVisitedAt,
    newestEventTs: newestRelevantTs(events),
    commits: delta?.commits ?? 0,
    filesChanged: delta?.filesChanged ?? 0,
  });

  const cachedRaw = widget.config.sitrep as SitrepCache | undefined;
  const cached =
    cachedRaw?.text !== undefined && cachedRaw.coveredThroughTs !== undefined ?
      { text: cachedRaw.text, key: cachedRaw.coveredThroughTs }
    : undefined;
  // A stale `genError` (from a previous, now-superseded range) must not leak
  // into this range's decision — only a failure *of this attempt* counts.
  const effectiveGenError = genError && attempted.current === currentKey;

  const banner =
    delta ?
      sitrepBanner({
        away: away.away,
        delta,
        cached,
        currentKey,
        genError: effectiveGenError,
        dismissedKey: cachedRaw?.dismissedRange,
      })
    : { show: false, source: "none" as const, text: "" };

  const generate = useCallback(
    async (input: SitrepInput, key: string) => {
      if (!tabId) return;
      setPending(true);
      setGenError(false);
      try {
        const result = await ipc.tabSitrepGenerate(environmentId, input);
        if (!result.text) {
          // A resolved-but-empty summary (the no-native-bridge preview path,
          // or a future degenerate model response) is treated exactly like a
          // thrown error: fall through to the digest rather than caching
          // nothing and getting stuck on "Summarising…" forever.
          setGenError(true);
          return;
        }
        updateWidgetIn(tabId, widget.id, {
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
      } catch {
        // Ollama down, no desktop bridge, or anything else: never throw. The
        // banner falls back to the deterministic digest and a manual retry.
        setGenError(true);
      } finally {
        setPending(false);
      }
    },
    [environmentId, tabId, widget.id, widget.config, updateWidgetIn],
  );

  useEffect(() => {
    if (!delta || banner.source !== "generated") return;
    if (attempted.current === currentKey) return;
    attempted.current = currentKey;
    void generate(delta, currentKey);
  }, [banner.source, delta, currentKey, generate]);

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
    if (!tabId) return;
    updateWidgetIn(tabId, widget.id, {
      config: {
        ...widget.config,
        sitrep: { ...(cachedRaw ?? {}), dismissedRange: currentKey },
      },
    });
  }

  return (
    <div className="item-detail stack">
      {banner.show && (
        <div className="sitrep-banner">
          <button className="icon-btn sitrep-banner-close" aria-label="Dismiss" onClick={dismiss}>
            ×
          </button>
          <div className="sitrep-banner-text">{banner.source === "generated" ? "Summarising…" : banner.text}</div>
          {banner.source === "digest" && (
            <button className="btn xs" disabled={pending} onClick={() => void generate(delta!, currentKey)}>
              {pending ? "Summarising…" : "Summarise with AI"}
            </button>
          )}
        </div>
      )}

      <div className="mono-label caption">{project.name}</div>
      {delta && <div className="ink-2">{buildDigest(delta)}</div>}

      <div>
        <div className="mono-label caption">Timeline</div>
        {recent.length === 0 ?
          <div className="ink-2">No recent activity.</div>
        : <div className="sitrep-timeline">
            {recent.map((event) => (
              <div key={event.id} className="sitrep-line">
                <span className="ink-2">{event.kind}</span>
                <span className="meta ink-3">{relativeAgo(event.ts)}</span>
              </div>
            ))}
          </div>
        }
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
