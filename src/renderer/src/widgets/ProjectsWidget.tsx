import { useCallback, useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import { useFocus } from "../state/focus";
import { useUi } from "../state/ui";
import type { Project } from "../types";
import type { WidgetViewProps } from "./registry";
import { Empty } from "../components/Status";
import { useRemembered } from "../state/remembered";
import { firstLoad } from "../state/timing";

/**
 * The projects registry (§5.3), Phase 0 shape: read-only cards over the `.ddd/`
 * contract. DDD never writes these files — `todos.json` comes from `/todo` and
 * `recap.md` from the SessionEnd hook, both inside Claude Code. Keeping the
 * write side entirely on the other end is what makes the coupling loose.
 */
export function ProjectsWidget({ widget, environmentId, focused, itemIndex }: WidgetViewProps) {
  const [projects, setProjects] = useRemembered<Project[]>(`projects:${environmentId}`, []);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const registerWidget = useFocus((s) => s.registerWidget);
  const unregisterWidget = useFocus((s) => s.unregisterWidget);
  const showToast = useUi((s) => s.showToast);

  const refresh = useCallback(async () => {
    try {
      setProjects(await firstLoad("projects", () => ipc.projectsList(environmentId)));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [environmentId]);

  useEffect(() => {
    void refresh();
    // The poll is the safety net for things the watcher cannot see — a commit
    // made in another window, a branch switch. `.ddd/` changes arrive instantly
    // via the event below, so this can stay slow.
    const seconds = widget.refreshSeconds ?? 60;
    const timer = setInterval(() => void refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [refresh, widget.refreshSeconds]);

  // Live `.ddd/` updates. Only the project that changed is re-read.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void ipc
      .onProjectChanged(({ environmentId: changedEnv, projectId }) => {
        if (changedEnv !== environmentId) return;
        void ipc
          .projectReload(environmentId, projectId)
          .then((fresh) =>
            setProjects((current) =>
              current.map((p) => (p.id === fresh.id ? fresh : p)),
            ),
          )
          // A project that vanished from the registry mid-flight is not an error.
          .catch(() => {});
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [environmentId]);

  const launch = useCallback(
    async (project: Project) => {
      try {
        await ipc.projectLaunch(environmentId, project.id);
        showToast(`Launching ${project.name}…`);
      } catch (e) {
        showToast(String(e));
      }
    },
    [environmentId, showToast],
  );

  // Publish the list length so j/k knows how far it can travel, what Enter does
  // on the selected row, and which single-key verbs this widget supports.
  useEffect(() => {
    registerWidget(
      widget.id,
      projects.length,
      (index) => {
        const project = projects[index];
        if (project) setExpanded((cur) => (cur === project.id ? null : project.id));
      },
      {
        launch: (index) => {
          const project = projects[index];
          if (project) void launch(project);
        },
      },
    );
    return () => unregisterWidget(widget.id);
  }, [widget.id, projects, registerWidget, unregisterWidget, launch]);

  async function addProject() {
    try {
      const dir = await ipc.pickDirectory();
      if (!dir) return;
      await ipc.projectRegister(environmentId, dir);
      await refresh();
    } catch (e) {
      showToast(String(e));
    }
  }

  // Registering the wrong folder is easy — picking a parent directory instead
  // of a repo takes one misclick — so getting it back out has to be equally
  // easy. Unregistering never touches the folder itself; it only stops DDD
  // watching it.
  async function openInEditor(project: Project) {
    try {
      await ipc.openInEditor(project.path);
      showToast(`Opening ${project.name}…`);
    } catch (e) {
      showToast(String(e));
    }
  }

  async function removeProject(project: Project) {
    try {
      await ipc.projectUnregister(environmentId, project.id);
      showToast(`Unregistered ${project.name} — the folder on disk is untouched`);
      await refresh();
    } catch (e) {
      showToast(String(e));
    } finally {
      setConfirmRemove(null);
    }
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 10px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <span className="mono-label">{projects.length} registered</span>
        <span className="grow" />
        <button className="btn" onClick={() => void addProject()}>
          Register project…
        </button>
      </div>

      {error && <div className="widget-error">{error}</div>}

      {projects.length === 0 && !error && (
        <Empty
          title="No projects yet."
          body="Register a directory to see its branch, recap and todos here."
        />
      )}

      <div style={{ padding: 9 }}>
        {projects.map((project, index) => (
          <ProjectCard
            key={project.id}
            project={project}
            selected={focused && index === itemIndex}
            expanded={expanded === project.id}
            onToggle={() => setExpanded((cur) => (cur === project.id ? null : project.id))}
            onLaunch={() => void launch(project)}
            onOpenInEditor={() => void openInEditor(project)}
            confirmingRemove={confirmRemove === project.id}
            onAskRemove={() => setConfirmRemove(project.id)}
            onCancelRemove={() => setConfirmRemove(null)}
            onRemove={() => void removeProject(project)}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  selected,
  expanded,
  onToggle,
  onLaunch,
  onOpenInEditor,
  confirmingRemove,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  project: Project;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onLaunch: () => void;
  onOpenInEditor: () => void;
  confirmingRemove: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}) {
  const git = project.git;
  const open = project.todos.filter((t) => !t.done);

  return (
    <div className={`project${selected ? " selected" : ""}`}>
      <div className="project-head" onClick={onToggle} style={{ cursor: "pointer" }}>
        <span className="name">{project.name}</span>
        {!project.exists && <span className="tone-err">missing</span>}
        <span className="grow" />
        {open.length > 0 && <span className="mono-label">{open.length} todo</span>}
        {project.icmFiles.length > 0 && (
          <span className="mono-label" title={project.icmFiles.join(", ")}>
            icm {project.icmFiles.length}
          </span>
        )}
        <button
          className="btn"
          disabled={!project.exists}
          title="Open a terminal here and start Claude Code"
          onClick={(e) => {
            e.stopPropagation();
            onLaunch();
          }}
        >
          Launch
        </button>
        <button
          className="btn"
          disabled={!project.exists}
          title="Open this project in your editor"
          onClick={(e) => {
            e.stopPropagation();
            onOpenInEditor();
          }}
        >
          IDE
        </button>
        {/* Deliberately not disabled by `exists`: a project whose folder is
            gone is exactly the one you most need to be able to remove. */}
        {confirmingRemove ? (
          <>
            <button
              className="btn danger"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              Unregister
            </button>
            <button
              className="btn"
              onClick={(e) => {
                e.stopPropagation();
                onCancelRemove();
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className="btn"
            title="Removes it from this list only — the folder on disk is untouched"
            onClick={(e) => {
              e.stopPropagation();
              onAskRemove();
            }}
          >
            Remove…
          </button>
        )}
        <span className="mono-label">{expanded ? "▾" : "▸"}</span>
      </div>

      {/* The status line: everything you need to answer "where was I?" */}
      <div className="project-meta">
        {git.isRepo ? (
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
            {git.lastCommitSummary && (
              <span className="ink-3">{git.lastCommitSummary}</span>
            )}
          </>
        ) : (
          <span className="k">not a git repository</span>
        )}
      </div>

      {expanded && (
        <>
          <div className="project-section">
            <div className="mono-label" style={{ marginBottom: 5 }}>
              Recap {project.recapUpdatedAt ? `· ${relative(project.recapUpdatedAt)}` : ""}
            </div>
            {project.recap ? (
              <pre className="recap">{project.recap.trim()}</pre>
            ) : (
              <div className="ink-3">
                No <code>.ddd/recap.md</code> yet — it appears after the first Claude Code session
                that ends with the SessionEnd hook installed.
              </div>
            )}
          </div>

          <div className="project-section">
            <div className="mono-label" style={{ marginBottom: 5 }}>
              Todos
            </div>
            {project.todos.length === 0 ? (
              <div className="ink-3">
                Nothing captured. Use <code>/todo</code> inside Claude Code.
              </div>
            ) : (
              project.todos.map((todo) => (
                <div key={todo.id} className={`todo${todo.done ? " done" : ""}`}>
                  <span className="box">{todo.done ? "[x]" : "[ ]"}</span>
                  <span>{todo.text}</span>
                </div>
              ))
            )}
          </div>

          <div className="project-section">
            <div className="pathline">{project.path}</div>
          </div>
        </>
      )}
    </div>
  );
}

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
