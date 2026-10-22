import { useCallback, useEffect, useState } from "react";
import { Empty } from "../components/Status";
import { ipc } from "../lib/ipc";
import { recentForProject } from "../lib/about";
import { filterByProject, since } from "../lib/products";
import { useRemembered } from "../state/remembered";
import { firstLoad } from "../state/timing";
import type { EventRow, Product, Project } from "../types";
import type { WidgetViewProps } from "./registry";

interface AboutData {
  project: Project | null;
  products: Product[];
  events: EventRow[];
}

const EMPTY: AboutData = { project: null, products: [], events: [] };

/**
 * One repo at a glance: the card "Promote to tab" builds for you.
 *
 * Bound to a single project by `widget.config.projectId` and nothing else —
 * there is no filter to widen, because the point of this card is that it is
 * about exactly one repo. Everything it shows already exists elsewhere (the
 * Projects list, the Products list, the events table); this is composition,
 * not a new source, and it never writes.
 */
export function AboutWidget({ widget, environmentId }: WidgetViewProps) {
  const projectId = typeof widget.config.projectId === "string" ? widget.config.projectId : "";
  const [data, setData] = useRemembered<AboutData>(`about:${environmentId}:${projectId}`, EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [projects, products, recentEvents] = await firstLoad("about", () =>
        Promise.all([
          ipc.projectsList(environmentId),
          ipc.productsList(environmentId),
          // No project param on this query — narrow client-side below.
          ipc.eventsQuery(environmentId, { limit: 50 }),
        ]),
      );
      const project = projects.find((p) => p.id === projectId) ?? null;
      setData({
        project,
        products: filterByProject(products, projectId),
        events: recentForProject(recentEvents, project?.name, 8, projectId),
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }, [environmentId, projectId, setData]);

  useEffect(() => {
    void refresh();
    const seconds = widget.refreshSeconds ?? 60;
    const timer = setInterval(() => void refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [refresh, widget.refreshSeconds]);

  if (error) {
    return <Empty title="Could not read this project" body={error} />;
  }

  // Guarded by `loaded`, the same way Projects and Products scope their own
  // empty states: without it, the very first render — before the project
  // list has come back at all — would flash "not found" for real ones too.
  if (loaded && !data.project) {
    return (
      <Empty
        title="Project not found"
        body="Its id doesn't match a project registered in this environment — it may have been unregistered."
      />
    );
  }

  const { project, products, events } = data;
  if (!project) return null;

  const remote = typeof widget.config.remote === "string" ? widget.config.remote : undefined;
  const openTodos = project.todos.filter((t) => !t.done).length;
  const git = project.git;

  return (
    <div className="item-detail stack">
      <div className="mono-label caption">{project.name}</div>
      <div className="pathline">
        <code>{project.path}</code>
      </div>
      {remote && <div className="ink-2">{remote}</div>}

      <div className="project-meta">
        {git.isRepo ?
          <>
            <span>
              <span className="k">branch </span>
              {git.branch ?? "—"}
            </span>
            <span>
              <span className="k">dirty </span>
              {git.dirtyFiles}
            </span>
            {(git.ahead > 0 || git.behind > 0) && (
              <span>
                <span className="k">sync </span>↑{git.ahead} ↓{git.behind}
              </span>
            )}
          </>
        : <span className="k">not a git repository</span>}
        {openTodos > 0 && (
          <span>
            <span className="k">todo </span>
            {openTodos}
          </span>
        )}
        {project.icmFiles.length > 0 && (
          <span>
            <span className="k">icm </span>
            {project.icmFiles.length}
          </span>
        )}
      </div>

      <div>
        <div className="mono-label caption">Products{products.length > 0 ? ` (${products.length})` : ""}</div>
        {products.length === 0 ?
          <div className="ink-2">
            No products declared in this project&rsquo;s <code>.ddd/config.json</code>.
          </div>
        : <div className="row-detail">
            {products.map((product) => (
              <div key={product.key} className="row-sub">
                {product.name}
              </div>
            ))}
          </div>
        }
      </div>

      <div>
        <div className="mono-label caption">Recent activity</div>
        {events.length === 0 ?
          <div className="ink-2">No recent activity.</div>
        : <div className="row-detail">
            {events.map((event) => (
              <div key={event.id} className="row-sub">
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
