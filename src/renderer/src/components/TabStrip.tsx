import { useEffect, useRef, useState } from "react";
import { Kbd } from "./Kbd";
import { formatBinding } from "../keyboard/keys";
import { ENV_COLORS } from "../lib/palette";
import { runsOf } from "../state/tabOrder";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import type { MenuItem } from "./ContextMenu";
import type { EnvTab, TabGroup } from "../types";

/**
 * Chrome-style tabs, grouped by environment and — inside an environment — by
 * tab group.
 *
 * Both worlds are on screen at once and both are synced; the group label and
 * the coloured marker are the only thing separating them. Clicking your "Life"
 * tab *is* the environment switch — no logout, no reload, no ceremony (§5.9).
 *
 * Groups nest *inside* environments and can never span two of them. A tab's
 * widgets read its environment's connections, so a tab that changed
 * environment by drag would silently repoint them — which is why the drop
 * logic below refuses any drag that leaves its band.
 */
export function TabStrip({ keymap }: { keymap: Record<string, string[]> }) {
  const tabs = useStore((s) => s.tabs());
  const environments = useStore((s) => s.environments());
  const layouts = useStore((s) => s.layouts);
  const activeTabId = useStore((s) => s.activeTabId);
  const selectTab = useStore((s) => s.selectTab);
  const addTab = useStore((s) => s.addTab);
  const hintsVisible = useUi((s) => s.hintsVisible);

  // Which tab is in flight, and where it would land. Kept in React rather than
  // in dataTransfer because dataTransfer is unreadable during `dragover` —
  // exactly when the caret has to be positioned.
  const [dragging, setDragging] = useState<{ tabId: string; envId: string } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Which group the drop would join. Read from the pointer's position over the
  // rendered group boxes rather than inferred from neighbours, so a run's edges
  // and one-tab groups are reachable — see tabOrder.moveTab.
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);

  const visibleEnvs = environments.filter((e) => !e.hidden);

  return (
    <div className="strip" data-wizard-target="tab-strip" role="tablist">
      {visibleEnvs.map((env) => {
        const envTabs = tabs.filter((t) => t.environmentId === env.id);
        if (envTabs.length === 0) return null;
        return (
          <EnvBand
            key={env.id}
            env={env}
            envTabs={envTabs}
            groups={layouts[env.id]?.groups ?? []}
            keymap={keymap}
            activeTabId={activeTabId}
            hintsVisible={hintsVisible}
            selectTab={selectTab}
            dragging={dragging}
            setDragging={setDragging}
            dropIndex={dropIndex}
            setDropIndex={setDropIndex}
            dropGroupId={dropGroupId}
            setDropGroupId={setDropGroupId}
          />
        );
      })}

      <button
        className="strip-add"
        data-wizard-target="new-tab"
        title="New tab"
        aria-label="New tab"
        onClick={() => addTab()}
      >
        +
      </button>
      {hintsVisible && keymap["tab.new"]?.[0] && (
        <span style={{ display: "flex", alignItems: "center" }}>
          <Kbd binding={keymap["tab.new"][0]} />
        </span>
      )}
    </div>
  );
}

/**
 * Go to one environment's own settings.
 *
 * Deliberately does not switch the active tab: you asked about this world, not
 * to move into it. It lands on Connections rather than Environments, because
 * that is what an environment *is* — its accounts. The list of all
 * environments is an app-level thing and lives under the header gear.
 */
function openEnvSettings(envId: string, panel: string) {
  useStore.getState().setView("settings");
  useUi.getState().openSettingsPanel(panel, envId);
}

/**
 * The environment is a group *and* a tab, so one click has to mean two things
 * in sequence: show me this world, then fold it away. Clicking it while its
 * overview is already showing is the second click.
 */
function pressEnvironment(envId: string, showing: boolean, collapsed: boolean) {
  const store = useStore.getState();
  if (!showing) {
    store.showOverview(envId);
    return;
  }
  store.setEnvironmentCollapsed(envId, !collapsed);
}


function EnvBand({
  env,
  envTabs,
  groups,
  keymap,
  activeTabId,
  hintsVisible,
  selectTab,
  dragging,
  setDragging,
  dropIndex,
  setDropIndex,
  dropGroupId,
  setDropGroupId,
}: {
  env: { id: string; name: string; color: string; collapsed?: boolean };
  envTabs: EnvTab[];
  groups: TabGroup[];
  keymap: Record<string, string[]>;
  activeTabId: string | null;
  hintsVisible: boolean;
  selectTab: (id: string) => void;
  dragging: { tabId: string; envId: string } | null;
  setDragging: (d: { tabId: string; envId: string } | null) => void;
  dropIndex: number | null;
  setDropIndex: (i: number | null) => void;
  dropGroupId: string | null;
  setDropGroupId: (id: string | null) => void;
}) {
  const moveTabTo = useStore((s) => s.moveTabTo);
  const overviewEnvId = useStore((s) => s.overviewEnvId);
  const bandRef = useRef<HTMLDivElement>(null);
  const tabCount = envTabs.length;
  const showingOverview = overviewEnvId === env.id;
  const collapsed = env.collapsed === true;
  // A drag that wandered into another environment must show no caret here.
  const accepting = dragging?.envId === env.id;

  /**
   * Where a pointer at `clientX` would drop, and into which group.
   *
   * Both `dragover` and `drop` call this. `drop` deliberately does not trust
   * state left behind by the last `dragover`: `dragleave` bubbles from every
   * child the pointer crosses, so any state-clearing there can land between the
   * final `dragover` and the `drop` and leave the drop with nothing to act on.
   * The drop event carries a `clientX` of its own, so it can simply ask again.
   */
  function resolveDrop(clientX: number): { index: number; groupId: string | null } {
    // Read each tab's own index rather than counting rendered buttons: a
    // collapsed group hides its tabs from the DOM, so loop position and
    // position in the environment's tab array stop agreeing the moment one
    // group is collapsed.
    const buttons = [...(bandRef.current?.querySelectorAll("[data-tab-id]") ?? [])];
    let index = tabCount;
    for (const button of buttons) {
      const r = button.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) {
        index = Number(button.getAttribute("data-index"));
        break;
      }
    }

    // Which group's box is the pointer actually inside? That is the whole
    // answer — the edges of a run are inside it, and a one-tab group has a box
    // like any other, both of which neighbour-inference gets wrong.
    const runs = bandRef.current?.querySelectorAll<HTMLElement>("[data-group-id]") ?? [];
    let groupId: string | null = null;
    for (const run of runs) {
      const r = run.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) {
        groupId = run.getAttribute("data-group-id");
        break;
      }
    }

    return { index, groupId };
  }

  function onDragOver(e: React.DragEvent) {
    if (!accepting) return;
    e.preventDefault();
    // Without this the cursor shows "copy" and, on some platforms, the drop is
    // refused outright.
    e.dataTransfer.dropEffect = "move";
    const { index, groupId } = resolveDrop(e.clientX);
    setDropIndex(index);
    setDropGroupId(groupId);
  }

  function onDrop(e: React.DragEvent) {
    if (!accepting || !dragging) return;
    e.preventDefault();
    // Resolved from this event, not from whatever `dragover` last stored.
    const { index, groupId } = resolveDrop(e.clientX);
    moveTabTo(dragging.tabId, index, groupId);
    setDragging(null);
    setDropIndex(null);
    setDropGroupId(null);
  }

  const caret = accepting && dropIndex !== null ? dropIndex : null;
  let cursor = 0;

  return (
    <div
      className="env-group"
      ref={bandRef}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={(e) => {
        // `dragleave` fires on every child the pointer crosses and bubbles up
        // here, so clearing unconditionally wipes the caret — and the drop
        // target — while the pointer is still inside the band. Only clear when
        // the pointer has genuinely left it.
        if (!accepting) return;
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropIndex(null);
        setDropGroupId(null);
      }}
    >
      {/* A tab, but the one you cannot close: an environment is the container
          its tabs live in, not a peer of them. The gear separates its settings
          from the app's, which live behind the header's own gear. */}
      <div
        className={`env-tab${showingOverview ? " active" : ""}`}
        data-wizard-target="environments"
        style={{ ["--env" as string]: env.color }}
      >
        <button
          className="env-name"
          aria-selected={showingOverview}
          title={
            showingOverview
              ? `${env.name} — click again to ${collapsed ? "unfold" : "fold"} its tabs`
              : `${env.name} — see its tabs`
          }
          onClick={() => pressEnvironment(env.id, showingOverview, collapsed)}
        >
          <i className="env-dot" />
          <span>{env.name}</span>
          {collapsed && <span className="env-count">{envTabs.length}</span>}
        </button>
        <button
          className="env-gear"
          title={`${env.name} settings — connections, AI, voice, data`}
          aria-label={`${env.name} settings`}
          onClick={() => openEnvSettings(env.id, "connections")}
        >
          ⚙
        </button>
      </div>

      {!collapsed &&
        runsOf(envTabs).map((run) => {
        const group = run.groupId ? groups.find((g) => g.id === run.groupId) : undefined;
        const start = cursor;
        cursor += run.tabs.length;

        const renderTabs = run.tabs.map((tab, n) => (
          <TabButton
            key={tab.id}
            tab={tab}
            index={start + n}
            envIndex={envTabs.findIndex((t) => t.id === tab.id)}
            numbered={envTabs.some((t) => t.id === activeTabId)}
            env={env}
            groups={groups}
            keymap={keymap}
            active={!showingOverview && tab.id === activeTabId}
            hintsVisible={hintsVisible}
            selectTab={selectTab}
            caretBefore={caret === start + n}
            onDragStart={(e) => {
              // A drag with nothing in its dataTransfer is not a drag the
              // browser is obliged to start — Firefox refuses outright, and
              // WebKit (which is what the Tauri window is) is inconsistent.
              // The payload itself is unused: `dragging` in React state carries
              // the real information, because dataTransfer is unreadable during
              // `dragover`, which is exactly when the caret needs positioning.
              e.dataTransfer.setData("text/plain", tab.id);
              e.dataTransfer.effectAllowed = "move";
              setDragging({ tabId: tab.id, envId: env.id });
            }}
            onDragEnd={() => {
              setDragging(null);
              setDropIndex(null);
              setDropGroupId(null);
            }}
          />
        ));

        if (!group) return <div className="tab-run" key={`u${start}`}>{renderTabs}</div>;
        return (
          <div
            className={`tab-run grouped${
              dragging && dropGroupId === group.id ? " targeted" : ""
            }`}
            key={group.id}
            data-group-id={group.id}
            style={{ ["--grp" as string]: group.color }}
          >
            <GroupPill group={group} envId={env.id} count={run.tabs.length} />
            {!group.collapsed && renderTabs}
          </div>
        );
      })}
      {!collapsed && caret === envTabs.length && <i className="tab-caret" />}
    </div>
  );
}

function GroupPill({ group, envId, count }: { group: TabGroup; envId: string; count: number }) {
  const renameGroup = useStore((s) => s.renameGroup);
  const setGroupCollapsed = useStore((s) => s.setGroupCollapsed);
  const ungroup = useStore((s) => s.ungroup);
  const openMenu = useUi((s) => s.openMenu);
  const renamingGroupId = useUi((s) => s.renamingGroupId);
  const startRenamingGroup = useUi((s) => s.startRenamingGroup);

  const items: MenuItem[] = [
    { kind: "action", label: "Rename group", run: () => startRenamingGroup(group.id) },
    {
      kind: "action",
      label: group.collapsed ? "Expand" : "Collapse",
      run: () => setGroupCollapsed(envId, group.id, !group.collapsed),
    },
    { kind: "action", label: "Ungroup", run: () => ungroup(envId, group.id) },
  ];

  return (
    <button
      className={`group-pill${group.collapsed ? " collapsed" : ""}`}
      title={`${group.name} — click to ${group.collapsed ? "expand" : "collapse"}`}
      onClick={() => setGroupCollapsed(envId, group.id, !group.collapsed)}
      onDoubleClick={() => startRenamingGroup(group.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, items);
      }}
    >
      <i className="group-dot" />
      {renamingGroupId === group.id ? (
        <NameInput
          value={group.name}
          onCommit={(name) => {
            if (name.trim()) renameGroup(envId, group.id, name.trim());
            startRenamingGroup(null);
          }}
        />
      ) : (
        <span>{group.name}</span>
      )}
      {group.collapsed && <span className="group-count">{count}</span>}
    </button>
  );
}

function TabButton({
  tab,
  index,
  envIndex,
  numbered,
  env,
  groups,
  keymap,
  active,
  hintsVisible,
  selectTab,
  caretBefore,
  onDragStart,
  onDragEnd,
}: {
  tab: EnvTab;
  index: number;
  /** Position within its own environment — what ⌘N now addresses. */
  envIndex: number;
  /** Whether this environment is the active one, and so has numbers at all. */
  numbered: boolean;
  env: { id: string; color: string };
  groups: TabGroup[];
  keymap: Record<string, string[]>;
  active: boolean;
  hintsVisible: boolean;
  selectTab: (id: string) => void;
  caretBefore: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const renameTab = useStore((s) => s.renameTab);
  const setTabColor = useStore((s) => s.setTabColor);
  const setTabGroup = useStore((s) => s.setTabGroup);
  const createGroup = useStore((s) => s.createGroup);
  const closeTab = useStore((s) => s.closeTab);
  const renamingTabId = useUi((s) => s.renamingTabId);
  const startRenamingTab = useUi((s) => s.startRenamingTab);
  const startRenamingGroup = useUi((s) => s.startRenamingGroup);
  const openMenu = useUi((s) => s.openMenu);

  // ⌘1…9 addresses the environment you are in, so only its tabs carry a chip.
  // A number beside a tab the shortcut does not select would be a lie.
  const binding =
    numbered && envIndex < 9 ? keymap[`tab.go.${envIndex + 1}`]?.[0] : undefined;
  const renameBinding = keymap["tab.rename"]?.[0];
  const color = tab.color ?? env.color;
  const renaming = renamingTabId === tab.id;

  const items: MenuItem[] = [
    { kind: "action", label: "Rename", run: () => startRenamingTab(tab.id) },
    {
      kind: "submenu",
      label: "Colour",
      items: [
        { kind: "action", label: "Match environment", run: () => setTabColor(tab.id, null) },
        ...ENV_COLORS.map((hex) => ({
          kind: "action" as const,
          label: hex,
          run: () => setTabColor(tab.id, hex),
        })),
      ],
    },
    {
      kind: "submenu",
      label: "Add to group",
      items: [
        ...groups
          .filter((g) => g.id !== tab.groupId)
          .map((g) => ({
            kind: "action" as const,
            label: g.name,
            run: () => setTabGroup(tab.id, g.id),
          })),
        {
          kind: "action",
          label: "New group…",
          run: () => {
            createGroup(tab.id, "New group");
            // The group id is minted inside the store, so read it back rather
            // than guessing: it is the one this tab now points at.
            const envLayout = useStore.getState().layouts[env.id];
            const made = envLayout?.tabs.find((t) => t.id === tab.id)?.groupId;
            if (made) startRenamingGroup(made);
          },
        },
      ],
    },
    ...(tab.groupId
      ? [
          {
            kind: "action" as const,
            label: "Remove from group",
            run: () => setTabGroup(tab.id, null),
          },
        ]
      : []),
    { kind: "separator" },
    { kind: "action", label: "Close tab", danger: true, run: () => closeTab(tab.id) },
  ];

  return (
    <>
      {caretBefore && <i className="tab-caret" />}
      <button
        role="tab"
        data-tab-id={tab.id}
        data-index={index}
        aria-selected={active}
        className={`tab${active ? " active" : ""}`}
        style={{ ["--tab-color" as string]: color }}
        // Renaming puts an input inside the button; dragging then steals the
        // pointer before the caret can be placed.
        draggable={!renaming}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title={
          renaming
            ? undefined
            : `${tab.name} — double-click to rename${
                renameBinding ? ` (${formatBinding(renameBinding)})` : ""
              }, right-click for more`
        }
        onClick={() => selectTab(tab.id)}
        onDoubleClick={() => startRenamingTab(tab.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(e.clientX, e.clientY, items);
        }}
      >
        {renaming ? (
          <NameInput
            value={tab.name}
            onCommit={(name) => {
              if (name.trim()) renameTab(tab.id, name.trim());
              startRenamingTab(null);
            }}
          />
        ) : (
          <span>{tab.name}</span>
        )}
        {hintsVisible && binding && <Kbd binding={binding} />}
      </button>
    </>
  );
}

function NameInput({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={value}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(e.currentTarget.value);
        // Escape must abandon the rename, not the whole overlay stack.
        if (e.key === "Escape") {
          e.stopPropagation();
          onCommit(value);
        }
      }}
    />
  );
}
