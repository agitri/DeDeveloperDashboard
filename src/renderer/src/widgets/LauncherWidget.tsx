import { useCallback, useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import type { Widget } from "../types";
import type { WidgetViewProps } from "./registry";
import { Empty } from "../components/Status";

/**
 * Buttons that open your *real* terminal or editor at a directory.
 *
 * Deliberately not the embedded terminal. No OS lets one app host another's
 * window, so an in-board shell is necessarily DDD's own bare one — none of your
 * iTerm profiles, tmux or keybindings come with it. This widget is the other
 * half of that trade: one click into the tools you have actually configured.
 */
export interface LaunchTarget {
  id: string;
  label: string;
  path: string;
  open: "terminal" | "ide";
}

/** Read targets defensively: this is user-editable config in layout.json. */
export function targetsOf(widget: Widget): LaunchTarget[] {
  const raw = widget.config.targets;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const t = entry as Record<string, unknown>;
    const id = typeof t.id === "string" ? t.id : "";
    const path = typeof t.path === "string" ? t.path : "";
    // An unknown `open` would render a button that cannot do anything, and a
    // duplicate id would make React key collisions look like a rendering bug.
    if (!id || !path || seen.has(id)) return [];
    if (t.open !== "terminal" && t.open !== "ide") return [];
    seen.add(id);
    return [
      {
        id,
        label: typeof t.label === "string" && t.label ? t.label : leafOf(path),
        path,
        open: t.open,
      },
    ];
  });
}

function leafOf(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

export function LauncherWidget({ widget }: WidgetViewProps) {
  const updateWidget = useStore((s) => s.updateWidget);
  const showToast = useUi((s) => s.showToast);
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const targets = targetsOf(widget);

  // A target whose folder is gone is shown disabled with the reason, never
  // dropped — the same rule the repos widget uses for a missing checkout.
  const checkPaths = useCallback(async () => {
    const results = await Promise.all(targets.map(async (t) => [t.id, !(await ipc.pathExists(t.path))] as const));
    setMissing(Object.fromEntries(results));
  }, [targets]);

  const targetKey = targets.map((t) => `${t.id}:${t.path}`).join("|");
  useEffect(() => {
    void checkPaths();
    // targets is derived from widget.config and would re-run this on every
    // render if depended on directly; the id list is what actually matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  function setTargets(next: LaunchTarget[]) {
    updateWidget(widget.id, { config: { ...widget.config, targets: next } });
  }

  async function add(open: "terminal" | "ide") {
    const dir = await ipc.pickDirectory();
    if (!dir) return;
    setTargets([...targets, { id: `t-${Date.now().toString(36)}`, label: leafOf(dir), path: dir, open }]);
  }

  async function run(target: LaunchTarget) {
    try {
      if (target.open === "ide") await ipc.openInEditor(target.path);
      else await ipc.launchPath(target.path);
      showToast(`Opening ${target.label}…`);
    } catch (e) {
      showToast(String(e));
    }
  }

  return (
    <div>
      <div className="launcher-bar">
        <span className="mono-label">
          {targets.length} target{targets.length === 1 ? "" : "s"}
        </span>
        <span className="grow" />
        <button className="btn" onClick={() => void add("terminal")}>
          + Terminal…
        </button>
        <button className="btn" onClick={() => void add("ide")}>
          + IDE…
        </button>
      </div>

      {targets.length === 0 ?
        <Empty
          title="No directories yet."
          body="Add one and it becomes a one-click way into your terminal or your editor — the ones you actually use, not a copy of them."
        />
      : <div className="launcher-grid launch">
          {targets.map((target) => (
            <div key={target.id} className="launcher-cell launch-tile">
              <button
                className="launcher-btn"
                disabled={missing[target.id]}
                title={missing[target.id] ? `${target.path} is not there` : target.path}
                onClick={() => void run(target)}
              >
                {/* The glyph is the kind: `>_` is a prompt, `{ }` is a file.
                    Bolded, it takes the environment colour. */}
                <span className="kindmark launch-kind">
                  <b>{target.open === "ide" ? "{ }" : ">_"}</b> {target.open === "ide" ? "editor" : "terminal"}
                </span>
                <span className="label launch-name">{target.label}</span>
                {missing[target.id] && <span className="gone">missing</span>}
              </button>
              <button
                className="icon-btn"
                title="Remove this target"
                aria-label={`Remove ${target.label}`}
                onClick={() => setTargets(targets.filter((t) => t.id !== target.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      }
    </div>
  );
}
