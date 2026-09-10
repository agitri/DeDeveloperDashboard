import { useMemo } from "react";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import { widgetDef } from "../widgets/registry";
import type { EnvTab, TabGroup } from "../types";

/**
 * A map of one environment: every tab it holds, as a card you can click into.
 *
 * The environment is both a group and a tab. Selecting it shows this; selecting
 * it again folds its tabs away in the strip. This view is what makes the first
 * click worth making — an environment with eight tabs is otherwise only ever
 * seen eight-eighths at a time.
 */
export function EnvironmentOverview({ envId }: { envId: string }) {
  const environment = useStore((s) => s.environments().find((e) => e.id === envId));
  const tabs = useStore((s) => s.tabs());
  const layouts = useStore((s) => s.layouts);
  const selectTab = useStore((s) => s.selectTab);
  const addTab = useStore((s) => s.addTab);
  const openSettingsPanel = useUi((s) => s.openSettingsPanel);
  const setView = useStore((s) => s.setView);

  const envTabs = useMemo(
    () => tabs.filter((t) => t.environmentId === envId),
    [tabs, envId],
  );
  const groups: TabGroup[] = layouts[envId]?.groups ?? [];

  return (
    <div className="canvas overview">
      <div className="overview-head">
        <i className="env-dot" style={{ ["--env" as string]: environment?.color }} />
        <h1>{environment?.name ?? envId}</h1>
        <span className="mono-label">
          {envTabs.length} tab{envTabs.length === 1 ? "" : "s"}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => addTab(envId)}>
          New tab
        </button>
        <button
          className="btn"
          onClick={() => {
            openSettingsPanel("connections", envId);
            setView("settings");
          }}
        >
          Settings…
        </button>
      </div>

      {envTabs.length === 0 ? (
        <div className="canvas-empty">
          <h2>Nothing here yet</h2>
          <p>This environment has no tabs. Make one and it appears here.</p>
        </div>
      ) : (
        <div className="overview-grid">
          {envTabs.map((tab) => (
            <TabCard
              key={tab.id}
              tab={tab}
              group={groups.find((g) => g.id === tab.groupId)}
              fallbackColor={environment?.color ?? "#2f6ae8"}
              onOpen={() => selectTab(tab.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TabCard({
  tab,
  group,
  fallbackColor,
  onOpen,
}: {
  tab: EnvTab;
  group: TabGroup | undefined;
  fallbackColor: string;
  onOpen: () => void;
}) {
  // Name the views rather than the raw kinds: "Stats, Notes" is a description
  // of the tab, "stats, notes" is a description of the code.
  const contents = tab.widgets.map((w) => widgetDef(w.kind)?.name ?? w.kind);
  const unique = [...new Set(contents)];

  return (
    <button
      className="overview-card"
      style={{ ["--card" as string]: tab.color ?? fallbackColor }}
      onClick={onOpen}
    >
      <div className="overview-card-head">
        <span className="name">{tab.name}</span>
        {group && (
          <span className="mono-label group" style={{ ["--grp" as string]: group.color }}>
            {group.name}
          </span>
        )}
      </div>
      <div className="overview-card-body">
        {unique.length === 0 ? (
          <span className="empty">empty</span>
        ) : (
          unique.map((name) => (
            <span key={name} className="chip">
              {name}
            </span>
          ))
        )}
      </div>
      <div className="mono-label overview-card-foot">
        {tab.widgets.length} widget{tab.widgets.length === 1 ? "" : "s"}
      </div>
    </button>
  );
}
