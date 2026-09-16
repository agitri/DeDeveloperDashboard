import { useEffect, useRef, useState } from "react";
import { formatBinding } from "../keyboard/keys";
import { tabCode } from "../lib/look";
import { ENV_COLORS } from "../lib/palette";
import { runsOf } from "../state/tabOrder";
import { useStore } from "../state/store";
import { useUi } from "../state/ui";
import type { MenuItem } from "./ContextMenu";
import type { EnvTab, Environment, TabGroup } from "../types";

/**
 * The rail: environments, their boards, and their tab groups, in one column.
 *
 * In the Console system this replaces both the 38px icon rail *and* the 34px
 * tab strip. The argument for merging them is that they were answering the same
 * question in two places — "which world am I in, and which board of it" — and
 * splitting that across two edges of the window made the environment the quiet
 * one, when it is the thing that changes what every widget shows.
 *
 * Collapsed it is 44px of letters and numbers; expanded, 172px of names.
 */
/**
 * What is in flight. A tab or a whole group — the rail can reorder both, and
 * the environment travels with it so a drop into another world can be refused.
 */
type Drag = { kind: "tab"; id: string; envId: string } | { kind: "group"; id: string; envId: string };

export function ConsoleRail({
  keymap,
  wide,
  onToggleWide,
  onOpenSettings,
}: {
  keymap: Record<string, string[]>;
  wide: boolean;
  onToggleWide: () => void;
  onOpenSettings: () => void;
}) {
  const environments = useStore((s) => s.environments());
  const tabs = useStore((s) => s.tabs());
  const layouts = useStore((s) => s.layouts);
  const activeTabId = useStore((s) => s.activeTabId);
  const selectTab = useStore((s) => s.selectTab);
  const updateEnvironment = useStore((s) => s.updateEnvironment);
  const setGroupCollapsed = useStore((s) => s.setGroupCollapsed);
  const showOverview = useStore((s) => s.showOverview);
  const addTab = useStore((s) => s.addTab);
  const closeTab = useStore((s) => s.closeTab);
  const startRenamingTab = useUi((s) => s.startRenamingTab);
  const togglePalette = useUi((s) => s.togglePalette);
  const toggleGuide = useUi((s) => s.toggleGuide);
  const hintsVisible = useUi((s) => s.hintsVisible);

  // Which tab is in flight. Kept in React rather than in dataTransfer, which is
  // unreadable during `dragover` — exactly when the caret has to be positioned.
  const [dragging, setDragging] = useState<Drag | null>(null);
  const openMenu = useUi((s) => s.openMenu);

  const paletteBinding = keymap["app.palette"]?.[0];

  return (
    /* `data-hints` lets the collapsed rail swap each tile's code for its
       number while ⌘ is held, without either being permanently on screen. */
    <div className="chrome-rail" data-hints={hintsVisible || undefined}>
      <button
        className="rail-toggle"
        title={wide ? "Collapse the rail" : "Expand the rail"}
        aria-label={wide ? "Collapse the rail" : "Expand the rail"}
        onClick={onToggleWide}
      >
        {wide ? "«" : "»"}
      </button>

      {environments
        .filter((env) => !env.hidden)
        .map((env) => (
          <RailEnvironment
            key={env.id}
            env={env}
            tabs={tabs.filter((t) => t.environmentId === env.id)}
            keymap={keymap}
            hintsVisible={hintsVisible}
            envHint={
              hintsVisible
                ? keymap[`env.go.${environments.filter((e) => !e.hidden).indexOf(env) + 1}`]?.[0]
                : undefined
            }
            groups={layouts[env.id]?.groups ?? []}
            activeTabId={activeTabId}
            selectTab={selectTab}
            // `collapsed` already exists on an environment and already
            // persists; the fan-out is the same idea wearing the rail's
            // clothes, so it reuses the state rather than inventing a second.
            onToggle={() => void updateEnvironment(env.id, { collapsed: !env.collapsed })}
            onGear={() => showOverview(env.id)}
            onAddTab={() => addTab(env.id)}
            onRenameTab={startRenamingTab}
            onCloseTab={closeTab}
            setGroupCollapsed={setGroupCollapsed}
            openMenu={openMenu}
            dragging={dragging}
            setDragging={setDragging}
          />
        ))}

      <div className="rail-spacer" />

      <button
        className="rail-toggle"
        title="App settings"
        aria-label="App settings"
        onClick={onOpenSettings}
      >
        ⚙
      </button>
      <button
        className="rail-toggle"
        title="Features guide"
        aria-label="Features guide"
        onClick={() => toggleGuide()}
      >
        ?
      </button>
      <button
        className="rail-toggle"
        title="Search actions, tabs, projects"
        aria-label="Search actions, tabs, projects"
        onClick={() => togglePalette(true)}
      >
        {paletteBinding ? <kbd className="kbd">{formatBinding(paletteBinding)}</kbd> : "⌘K"}
      </button>
      <RailClock />
    </div>
  );
}

function RailEnvironment({
  env,
  tabs,
  keymap,
  hintsVisible,
  envHint,
  groups,
  activeTabId,
  selectTab,
  onToggle,
  onGear,
  onAddTab,
  onRenameTab,
  onCloseTab,
  setGroupCollapsed,
  openMenu,
  dragging,
  setDragging,
}: {
  env: Environment;
  tabs: EnvTab[];
  keymap: Record<string, string[]>;
  hintsVisible: boolean;
  /** The ⌘⇧N that goes to this environment, while the hint layer is up. */
  envHint?: string;
  groups: TabGroup[];
  activeTabId: string | null;
  selectTab: (id: string) => void;
  onToggle: () => void;
  onGear: () => void;
  onAddTab: () => void;
  onRenameTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  setGroupCollapsed: (envId: string, groupId: string, collapsed: boolean) => void;
  openMenu: (x: number, y: number, items: MenuItem[]) => void;
  dragging: Drag | null;
  setDragging: (d: Drag | null) => void;
}) {
  const expanded = !env.collapsed;
  // ⌘1…9 addresses the environment you are in, so only that one shows numbers.
  // A digit beside a tab the shortcut does not select would be a lie, and the
  // rail is where you would learn the lie.
  const indexOf = (tab: EnvTab) => tabs.findIndex((t) => t.id === tab.id) + 1;
  const newTabBinding = keymap["tab.new"]?.[0];
  const moveTabTo = useStore((s) => s.moveTabTo);
  const moveGroupTo = useStore((s) => s.moveGroupTo);
  const setTabColor = useStore((s) => s.setTabColor);
  const setTabGroup = useStore((s) => s.setTabGroup);
  const createGroup = useStore((s) => s.createGroup);
  const startRenamingGroup = useUi((s) => s.startRenamingGroup);
  const boardsRef = useRef<HTMLDivElement | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);

  // A tab may never change environment by being dragged: its widgets read its
  // environment's connections, so a cross-environment drop would silently
  // repoint them. The rail stacks environments vertically, which makes that
  // drag easier to attempt than it was in the strip — so the guard matters more.
  const accepting = dragging?.envId === env.id;

  /**
   * Where a drop at this height would land, resolved from the event's own
   * `clientY` rather than from whatever `dragover` last stored: `dragleave`
   * bubbles from every child the pointer crosses, so state cleared there can
   * land between the final `dragover` and the `drop`.
   *
   * Vertical twin of the strip's `resolveDrop` — midpoints on Y, group boxes
   * tested top-to-bottom.
   */
  function resolveDrop(clientY: number): { index: number; groupId: string | null } {
    // Each tile's own index, not its loop position: a collapsed group hides its
    // tabs from the DOM, and the two stop agreeing the moment one is collapsed.
    const tiles = [...(boardsRef.current?.querySelectorAll("[data-tab-id]") ?? [])];
    let index = tabs.length;
    for (const tile of tiles) {
      const r = tile.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        index = Number(tile.getAttribute("data-index"));
        break;
      }
    }

    // Which group's box is the pointer inside? The edges of a run are inside
    // it, and a one-tab group has a box like any other — both of which
    // inferring from neighbours gets wrong.
    let groupId: string | null = null;
    for (const run of boardsRef.current?.querySelectorAll<HTMLElement>("[data-group-id]") ?? []) {
      const r = run.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        groupId = run.getAttribute("data-group-id");
        break;
      }
    }
    return { index, groupId };
  }

  const dragHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (!accepting) return;
      e.preventDefault();
      // Without this the cursor shows "copy" and some platforms refuse the drop.
      e.dataTransfer.dropEffect = "move";
      const { index, groupId } = resolveDrop(e.clientY);
      setDropIndex(index);
      setDropGroupId(groupId);
    },
    onDrop: (e: React.DragEvent) => {
      if (!accepting || !dragging) return;
      e.preventDefault();
      const { index, groupId } = resolveDrop(e.clientY);
      if (dragging.kind === "group") {
        // A group takes the boundary and nothing else: it cannot join another
        // group, because groups are one level deep.
        moveGroupTo(env.id, dragging.id, index);
      } else {
        moveTabTo(dragging.id, index, groupId);
      }
      setDragging(null);
      setDropIndex(null);
      setDropGroupId(null);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!accepting) return;
      // `dragleave` bubbles from every child, so clearing unconditionally wipes
      // the caret while the pointer is still inside the rail.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDropIndex(null);
      setDropGroupId(null);
    },
  };

  function tileProps(tab: EnvTab, index: number) {
    return {
      index,
      caretBefore: accepting && dropIndex === index,
      onDragStart: (e: React.DragEvent) => {
        // A drag carrying nothing in its dataTransfer is not one the browser is
        // obliged to start — WebKit, which is what the Tauri window is, is
        // inconsistent about it. The payload itself goes unread.
        e.dataTransfer.setData("text/plain", tab.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging({ kind: "tab", id: tab.id, envId: env.id });
      },
      onDragEnd: () => {
        setDragging(null);
        setDropIndex(null);
        setDropGroupId(null);
      },
    };
  }
  const newTabTitle = newTabBinding
    ? `New tab in ${env.name} (${formatBinding(newTabBinding)})`
    : `New tab in ${env.name}`;
  const holdsActive = tabs.some((t) => t.id === activeTabId);

  /** The strip's tab menu, on a rail tile. Same verbs, same order. */
  function tabMenu(x: number, y: number, tab: EnvTab) {
    const items: MenuItem[] = [
      { kind: "action", label: "Rename", run: () => onRenameTab(tab.id) },
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
              // The id is minted in the store, so read it back rather than
              // guessing: it is the one this tab now points at.
              const made = useStore.getState().layouts[env.id]?.tabs.find((t) => t.id === tab.id)?.groupId;
              if (made) startRenamingGroup(made);
            },
          },
        ],
      },
      ...(tab.groupId
        ? [{ kind: "action" as const, label: "Remove from group", run: () => setTabGroup(tab.id, null) }]
        : []),
      { kind: "action", label: "New tab", run: onAddTab },
      { kind: "separator" },
      {
        kind: "action",
        label: "Close tab",
        danger: true,
        // Two steps, like every other destructive thing here: the menu closes
        // on click, so the confirmation reopens in its place.
        run: () =>
          openMenu(x, y, [
            { kind: "action", label: "Close — widgets go with it", danger: true, run: () => onCloseTab(tab.id) },
            { kind: "action", label: "Cancel", run: () => {} },
          ]),
      },
    ];
    openMenu(x, y, items);
  }

  return (
    <>
      <div
        className={`rail-env${holdsActive ? " active" : ""}`}
        style={{ ["--c" as string]: env.color }}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
        title={`${env.name} — click to ${expanded ? "hide" : "show"} its tabs`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(e.clientX, e.clientY, [
            { kind: "action", label: `${env.name} settings…`, run: onGear },
          ]);
        }}
      >
        <span className="rail-letter">{env.name.slice(0, 1).toUpperCase()}</span>
        <span className="rail-name">{env.name}</span>
        {envHint ? (
          <kbd className="kbd rail-env-hint">{formatBinding(envHint)}</kbd>
        ) : (
          <span className="rail-env-count" title={`${tabs.length} tab${tabs.length === 1 ? "" : "s"}`}>
            {tabs.length}
          </span>
        )}
      </div>

      {expanded ? (
        <div
          className="rail-boards"
          ref={boardsRef}
          style={{ ["--c" as string]: env.color }}
          {...dragHandlers}
        >
          {/* Rendered in run order — the same order as the tab array — because
              `resolveDrop` walks the rendered tiles to work out where a drop
              lands. Every ungrouped tab first and then the groups would put the
              DOM and the array out of step, and a drop would compute an index
              belonging to a different tab. */}
          {runsOf(tabs).map((run) => {
            const group = run.groupId ? groups.find((g) => g.id === run.groupId) : undefined;

            const tiles = run.tabs.map((tab, n) => (
              <RailTile
                key={tab.id}
                tab={tab}
                number={holdsActive ? indexOf(tab) : null}
                active={tab.id === activeTabId}
                onSelect={() => selectTab(tab.id)}
                onMenu={(x, y) => tabMenu(x, y, tab)}
                hint={
                  hintsVisible && holdsActive ? keymap[`tab.go.${indexOf(tab)}`]?.[0] : undefined
                }
                {...tileProps(tab, run.from + n)}
              />
            ));

            if (!group) return <div key={`u${run.from}`}>{tiles}</div>;
            return (
              <div
                className={`rail-group${
                  dragging?.kind === "tab" && dropGroupId === group.id ? " targeted" : ""
                }${dragging?.kind === "group" && dragging.id === group.id ? " lifting" : ""}`}
                key={group.id}
                data-group-id={group.id}
                style={{ ["--g" as string]: group.color }}
              >
                <RailGroupPill
                  group={group}
                  envId={env.id}
                  count={run.tabs.length}
                  openMenu={openMenu}
                  setGroupCollapsed={setGroupCollapsed}
                  caretBefore={accepting && dropIndex === run.from}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", group.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragging({ kind: "group", id: group.id, envId: env.id });
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropIndex(null);
                    setDropGroupId(null);
                  }}
                />
                {!group.collapsed && <div className="rail-group-tabs">{tiles}</div>}
              </div>
            );
          })}
          <button
            className="rail-tile rail-add"
            title={newTabTitle}
            aria-label={`New tab in ${env.name}`}
            onClick={onAddTab}
          >
            <span className="rail-tile-code">+</span>
            <span className="rail-tile-name">New tab</span>
            {hintsVisible && newTabBinding && <kbd className="kbd">{formatBinding(newTabBinding)}</kbd>}
          </button>
        </div>
      ) : null}
    </>
  );
}

function RailTile({
  tab,
  number,
  index,
  active,
  onSelect,
  onMenu,
  hint,
  caretBefore,
  onDragStart,
  onDragEnd,
}: {
  tab: EnvTab;
  /** What ⌘N selects it, or null when its environment is not the active one. */
  number: number | null;
  /** Its position within its environment, which is what a drop reorders. */
  index: number;
  active: boolean;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
  hint?: string;
  caretBefore: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const renamingTabId = useUi((s) => s.renamingTabId);
  const startRenamingTab = useUi((s) => s.startRenamingTab);
  const renameTab = useStore((s) => s.renameTab);
  const renaming = renamingTabId === tab.id;

  // Renaming happens where the name is. `startRenamingTab` only sets state —
  // the classic tab strip draws the input for it, and without this both the
  // menu item and the double-click would be no-ops in a look that has no strip.
  if (renaming) {
    return (
      <input
        className="field rail-rename"
        autoFocus
        defaultValue={tab.name}
        onBlur={(e) => {
          const name = e.target.value.trim();
          if (name) renameTab(tab.id, name);
          startRenamingTab(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.stopPropagation();
            e.currentTarget.value = tab.name;
            e.currentTarget.blur();
          }
        }}
      />
    );
  }

  return (
    <>
      {caretBefore && <i className="rail-caret" />}
      <div
        className={`rail-tile${active ? " active" : ""}`}
        tabIndex={0}
        role="tab"
        aria-selected={active}
        title={tab.name}
        data-tab-id={tab.id}
        data-index={index}
        // Not while renaming: dragging an input by its text is not a gesture
        // anyone means.
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onSelect}
        onDoubleClick={() => startRenamingTab(tab.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu(e.clientX, e.clientY);
        }}
      >
        <span className="rail-tile-code">{tabCode(tab.name)}</span>
        <span className="rail-tile-idx">{number ?? ""}</span>
        <span className="rail-tile-name">{tab.name}</span>
        {/* Only when the rail is wide: collapsed, the tile *is* the number, and
            a chip beside it in 44px would be the same fact twice, illegibly. */}
        {hint && <kbd className="kbd rail-hint">{formatBinding(hint)}</kbd>}
      </div>
    </>
  );
}

/**
 * A group's pill: click collapses, double-click renames, right-click carries
 * the group verbs. The strip's `GroupPill`, vertically.
 */
function RailGroupPill({
  group,
  envId,
  count,
  openMenu,
  setGroupCollapsed,
  caretBefore,
  onDragStart,
  onDragEnd,
}: {
  group: TabGroup;
  envId: string;
  count: number;
  openMenu: (x: number, y: number, items: MenuItem[]) => void;
  setGroupCollapsed: (envId: string, groupId: string, collapsed: boolean) => void;
  caretBefore: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const renameGroup = useStore((s) => s.renameGroup);
  const ungroup = useStore((s) => s.ungroup);
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
    <>
      {caretBefore && <i className="rail-caret" />}
    <div
      className="rail-group-pill"
      tabIndex={0}
      role="button"
      // The pill is the group's handle: dragging it moves the whole run.
      // Not while renaming — dragging an input by its text is not a gesture
      // anyone means.
      draggable={renamingGroupId !== group.id}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-expanded={!group.collapsed}
      title={`${group.name} — click to ${group.collapsed ? "expand" : "collapse"}`}
      onClick={() => setGroupCollapsed(envId, group.id, !group.collapsed)}
      onDoubleClick={() => startRenamingGroup(group.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setGroupCollapsed(envId, group.id, !group.collapsed);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, items);
      }}
    >
      <i />
      {renamingGroupId === group.id ? (
        <input
          className="field rail-rename"
          autoFocus
          defaultValue={group.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name) renameGroup(envId, group.id, name);
            startRenamingGroup(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = group.name;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <span>{group.name}</span>
      )}
      <span className="rail-group-count">{count}</span>
    </div>
    </>
  );
}

/** The clock at the foot of the rail. Minutes only — this is not a stopwatch. */
function RailClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Ticks on the minute rather than every second: nothing here animates, and
    // a board open for eight hours should not wake for a digit nobody reads.
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="rail-clock">
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
    </div>
  );
}
