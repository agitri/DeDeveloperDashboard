/**
 * Watching each registered project's `.ddd/` folder. Port of `watcher.rs`.
 *
 * `/todo` inside Claude Code appends to `todos.json`, and the SessionEnd hook
 * writes `recap.md`. Neither of those knows DDD exists — so DDD watches the
 * files instead of being told about them. That is the whole coupling: one
 * side writes, the other side notices.
 */
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { Emitter } from "./emitter";
import type { ProjectRef } from "./models";

/** Filesystem events arrive in bursts — an editor save is three of them — and
 *  re-reading every project card per event would be silly. */
export const DEBOUNCE_MS = 400;

/** Payload of the `ddd://project-changed` event. */
export interface ProjectChanged {
  environmentId: string;
  projectId: string;
}

/** True when a watch callback is macOS's spurious FSEvents replay rather
 *  than a real change. A watch freshly registered on a directory created
 *  moments earlier can replay one callback naming the watched directory
 *  itself rather than any real child (seen for `.ddd` right after it is
 *  created). That replay's `filename` joins onto a path that does not
 *  exist — there is no real child sharing the watched directory's own
 *  name — which is exactly what tells it apart from a legitimate change
 *  to a file that happens to be named the same as the watched directory:
 *  only treat it as the replay when the joined path is not actually
 *  there. This also means a real deletion of the watched `.ddd` folder
 *  itself (named after its own basename, and gone by the time this
 *  checks) is swallowed too — an accepted trade-off of the same
 *  discriminator. */
export function isSelfNamedReplay(target: string, filename: string | null): boolean {
  if (filename === null || filename !== basename(target)) return false;
  return !existsSync(join(target, filename));
}

/** Map a changed path back to the project that owns it, ignoring anything
 *  outside `.ddd/` so a shallow root watch does not fire on unrelated edits. */
export function routeFor(routes: Map<string, ProjectChanged>, path: string): ProjectChanged | null {
  for (const [root, changed] of routes) {
    const rest = relative(root, path);
    if (rest === "") continue;
    const first = rest.split(sep)[0];
    // A root that itself contains ".." (e.g. "/tmp/..io") must not be
    // mistaken for "outside the root" just because relative()'s first
    // segment happens to start with the same two characters.
    if (first === "..") continue;
    if (first === ".ddd") return changed;
  }
  return null;
}

export class ProjectWatcher {
  /** Every environment's registered projects. Watching is global even though
   *  the registries are not, so the union has to live in one place. */
  private registry = new Map<string, ProjectRef[]>();
  private watchers: FSWatcher[] = [];
  private pending = new Map<string, ProjectChanged>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly emitter: Emitter) {}

  /** Record this environment's projects and re-point the watcher at the union.
   *  Called on every `projects_list`, which the widget polls — so it returns
   *  early when nothing changed. */
  sync(environmentId: string, projects: ProjectRef[]): void {
    const current = this.registry.get(environmentId);
    if (current && JSON.stringify(current) === JSON.stringify(projects)) return;
    this.registry.set(
      environmentId,
      projects.map((p) => ({ id: p.id, path: p.path })),
    );

    const routes = new Map<string, ProjectChanged>();
    for (const [envId, entries] of this.registry) {
      for (const project of entries) routes.set(project.path, { environmentId: envId, projectId: project.id });
    }
    this.rebuild(routes);
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    // Without this, a later sync() with the same project list hits the
    // early "nothing changed" return above and never rebuilds the (now
    // closed) watchers.
    this.registry.clear();
  }

  /** Rebuilt wholesale whenever the registry changes; simpler than diffing,
   *  and the registry changes about once a week. */
  private rebuild(routes: Map<string, ProjectChanged>): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];

    for (const root of routes.keys()) {
      const ddd = join(root, ".ddd");
      // Watch `.ddd` recursively when it exists; otherwise the project root
      // shallowly, so the folder appearing is itself noticed. Shallow keeps
      // node_modules out. Note: if `.ddd` appears while the root is being
      // watched shallowly, the watch is not upgraded to recursive until the
      // next `sync` with a changed registry — the Rust debouncer has the same
      // limitation (its watch set is only rebuilt in `sync`).
      const target = isDir(ddd) ? ddd : root;
      const recursive = target === ddd;
      try {
        const w = watch(target, { recursive }, (_event, filename) => {
          const name = filename?.toString() ?? null;
          if (isSelfNamedReplay(target, name)) return;
          const changedPath = name ? join(target, name) : target;
          const changed = routeFor(routes, changedPath);
          if (changed) this.queue(changed);
        });
        w.on("error", () => {
          /* a vanished directory stops its own watch; the others live on */
        });
        this.watchers.push(w);
      } catch {
        // Cannot watch this one (gone, or permissions): the others still work.
      }
    }
  }

  /** One notification per project per burst, not per file. */
  private queue(changed: ProjectChanged): void {
    this.pending.set(changed.projectId, changed);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const batch = [...this.pending.values()];
      this.pending.clear();
      for (const c of batch) this.emitter.emit("ddd://project-changed", c);
    }, DEBOUNCE_MS);
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
