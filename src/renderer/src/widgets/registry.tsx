// The widget contract.
//
// A widget is a data source, a filter over it, and a view (§5.2). The registry
// is the only place the shell learns what views exist — adding "My PRs" in
// Phase 2 means adding an entry here, not touching the canvas, the tabs, or the
// persistence layer.

import type { ComponentType } from "react";
import type { Widget } from "../types";
import type { MenuItem } from "../components/ContextMenu";
import type { ItemFilter, RepoFilter } from "../types";
import { CalendarWidget } from "./CalendarWidget";
import { DevServerWidget } from "./DevServerWidget";
import { ProductsWidget } from "./ProductsWidget";
import { EolWidget } from "./EolWidget";
import { ClockWidget } from "./ClockWidget";
import { ItemsWidget } from "./ItemsWidget";
import { LauncherWidget } from "./LauncherWidget";
import { NotesWidget, notesMenuItems } from "./NotesWidget";
import { ProjectsWidget } from "./ProjectsWidget";
import { RepoWidget } from "./RepoWidget";
import { StatsWidget } from "./StatsWidget";

export interface WidgetViewProps {
  widget: Widget;
  environmentId: string;
  /** Whether this widget currently owns keyboard focus. */
  focused: boolean;
  /** Which item inside it is selected (j/k). Meaningless for non-list views. */
  itemIndex: number;
}

export interface WidgetDefinition {
  kind: string;
  name: string;
  description: string;
  /**
   * The source the central sync engine must feed it, or null when the view is
   * self-contained. Widgets never poll on their own — one scheduler, many
   * views, or the rate limits win.
   */
  source: string | null;
  /** Whether binding a connection is required before it can show anything. */
  needsConnection?: boolean;
  defaultRefreshSeconds?: number;
  /** Drop the body padding for views that draw their own rows. */
  flush?: boolean;
  /**
   * Whether this kind can be told what to show in words.
   *
   * True only for kinds with a filter schema on the Rust side to compile into
   * — `items` and `repos`. Anything else has no compile target, and offering
   * the button would mean offering an instruction that quietly does nothing.
   */
  instructable?: boolean;
  /**
   * Extra rows for this widget's right-click menu, spliced above the
   * separator. Generic chrome stays generic; a widget that wants its own
   * verbs says so itself rather than WidgetFrame learning about kinds.
   */
  menuItems?: (widget: Widget) => MenuItem[];
  View: ComponentType<WidgetViewProps>;
}

export const WIDGETS: WidgetDefinition[] = [
  {
    kind: "clock",
    name: "Clock",
    description: "Time and date. No source, no connection — the contract's floor.",
    source: null,
    View: ClockWidget,
  },
  {
    kind: "notes",
    menuItems: notesMenuItems,
    name: "Notes",
    description: "A scratchpad stored in the layout file alongside the widget.",
    source: null,
    View: NotesWidget,
  },
  {
    kind: "calendar",
    name: "Calendar",
    description: "Subscribed .ics feeds and your own events, in one view.",
    // Self-contained as a *view*: it reads the cache and calendar.json, and
    // works with no connection at all — a subscription only adds to it.
    source: null,
    flush: true,
    View: CalendarWidget,
  },
  {
    kind: "launcher",
    name: "Launcher",
    description: "One click into your real terminal or editor, at a directory you choose.",
    source: null,
    flush: true,
    View: LauncherWidget,
  },
  {
    kind: "items",
    name: "Items",
    description: "Any source, any filter: PRs, issues, comments, mail, messages.",
    source: "*",
    needsConnection: true,
    flush: true,
    instructable: true,
    View: ItemsWidget,
  },
  {
    kind: "stats",
    name: "Stats",
    description: "Your own behaviour, from the local events table. Nothing leaves the machine.",
    source: "local",
    defaultRefreshSeconds: 60,
    View: StatsWidget,
  },
  {
    kind: "projects",
    name: "Projects",
    description: "Registered projects: git status, recap, and todos from .ddd/.",
    source: "local",
    flush: true,
    defaultRefreshSeconds: 60,
    View: ProjectsWidget,
  },
  {
    kind: "devservers",
    name: "Dev servers",
    description: "What is listening on this machine, and which project it belongs to.",
    // A live read of the OS, not a synced source: the scheduler has nothing to
    // do here, and a stale answer to "is it up" is worse than none.
    source: "local",
    flush: true,
    defaultRefreshSeconds: 5,
    View: DevServerWidget,
  },
  {
    kind: "products",
    name: "Products",
    description: "Things your repos know how to run — start them without a terminal.",
    // Local: it reads each project's own config and the processes on this
    // machine. Nothing here is a sync source.
    source: "local",
    flush: true,
    defaultRefreshSeconds: 5,
    View: ProductsWidget,
  },
  {
    kind: "eol",
    name: "Support watch",
    description: "Repos you assigned: are the runtimes they were built on still supported?",
    // Its own network source, not the scheduler's: one request per product per
    // week, cached on disk, and never per repo.
    source: "local",
    flush: true,
    defaultRefreshSeconds: 900,
    View: EolWidget,
  },
  {
    kind: "repos",
    name: "Repositories",
    description: "Your GitHub repos, and which of them are on this machine.",
    source: "github",
    needsConnection: true,
    flush: true,
    instructable: true,
    View: RepoWidget,
  },
];

export function widgetDef(kind: string): WidgetDefinition | undefined {
  return WIDGETS.find((w) => w.kind === kind);
}

/**
 * What the `+` picker actually offers.
 *
 * A preset is a view plus a filter — nothing more. "My PRs" and "PR comments
 * only" are the same `items` view pointed at different slices, which is the
 * whole claim of §5.2 made concrete: no special widget types exist, so a new
 * source adds presets rather than components.
 */
interface PresetBase {
  id: string;
  name: string;
  description: string;
  title?: string;
}

/**
 * A preset, **discriminated on `kind`** so each widget kind gets exactly its
 * own filter shape.
 *
 * The obvious spelling — one interface with `filter?: ItemFilter | RepoFilter`
 * — does not work, and the way it fails is quiet. TypeScript checks an object
 * literal against a *union* by allowing any key that appears in any arm, so
 * `{ kind: "items", filter: { source: "github", scope: "recent" } }` compiles
 * clean: `scope` belongs to `RepoFilter`, `source` to `ItemFilter`, and
 * nothing objects to the mixture. `repos_list` would then never see the scope
 * it was given and the widget would quietly show the wrong slice.
 *
 * (It also must not be `& Record<string, unknown>`: an index signature
 * suppresses excess-property checking entirely, which is how a typo like
 * `sorce` once compiled into a filter that matched nothing.)
 *
 * Splitting per kind makes both mistakes type errors at the literal.
 */
export type WidgetPreset =
  | (PresetBase & { kind: "items"; filter: ItemFilter })
  | (PresetBase & { kind: "repos"; filter?: RepoFilter })
  // Views that are their own filter: a clock has no slice to take.
  | (PresetBase & {
      kind:
        | "clock"
        | "notes"
        | "stats"
        | "projects"
        | "calendar"
        | "launcher"
        | "devservers"
        | "products"
        | "eol";
      filter?: undefined;
    });

/**
 * `RepoFilter` has no `source` field, so `preset.filter.source` cannot be
 * read directly off the union without TS rejecting it for `repos` presets.
 * Centralizing the narrowing here (rather than casting at each call site)
 * keeps that safe for every future non-`items` preset kind too.
 */
export function presetSource(preset: WidgetPreset): string | null | undefined {
  return preset.kind === "items" ? preset.filter.source : undefined;
}

export const PRESETS: WidgetPreset[] = [
  {
    id: "github.pulls",
    name: "My pull requests",
    description: "Open PRs you authored, with CI and review state.",
    kind: "items",
    title: "My pull requests",
    filter: { source: "github", kind: "pull_request" },
  },
  {
    id: "github.reviews",
    name: "Review requests",
    description: "PRs waiting on your review. Approve without leaving the board.",
    kind: "items",
    title: "Waiting on my review",
    filter: { source: "github", kind: "review_request" },
  },
  {
    id: "github.comments",
    name: "PR comments & mentions",
    description: "Your GitHub notifications — the someone-is-waiting-on-you feed.",
    kind: "items",
    title: "Mentions",
    filter: { source: "github", kind: "comment" },
  },
  {
    id: "github.issues",
    name: "Issues assigned to me",
    description: "Open GitHub issues with your name on them.",
    kind: "items",
    title: "My issues",
    filter: { source: "github", kind: "issue" },
  },
  {
    id: "jira.issues",
    name: "Jira issues",
    description: "Assigned to you and not done, freshest first.",
    kind: "items",
    title: "Jira",
    filter: { source: "jira" },
  },
  // Deliberately not scoped to a source. Mail is mail: Gmail and IMAP both
  // produce `kind: "mail"` through the same signal filter, and a widget that
  // named one of them would silently show nothing to whoever connected the
  // other. Someone with both connected gets one inbox, which is the point of
  // there being one Item model.
  {
    id: "mail.real",
    name: "Inbox — real mail only",
    description: "Human mail from any connected account. CI, receipts and newsletters filtered out before you see them.",
    kind: "items",
    title: "Inbox",
    filter: { kind: "mail" },
  },
  {
    id: "mail.bulk",
    name: "Filtered-out mail",
    description: "What the signal filter set aside, with its reason on every row.",
    kind: "items",
    title: "Filtered out",
    filter: { kind: "mail_bulk" },
  },
  {
    id: "calendar.today",
    name: "Calendar",
    description: "The next seven days, soonest first.",
    kind: "items",
    title: "Calendar",
    filter: { source: "google", kind: "event" },
  },
  {
    id: "slack.dms",
    name: "Slack DMs",
    description: "Direct messages waiting on you. Not channel history.",
    kind: "items",
    title: "Slack",
    filter: { source: "slack", kind: "message" },
  },
  {
    id: "slack.mentions",
    name: "Slack mentions",
    description: "Where someone put your name in a message.",
    kind: "items",
    title: "Mentions",
    filter: { source: "slack", kind: "mention" },
  },
  {
    id: "items.all",
    name: "Everything",
    description: "Every item from every connection in this environment.",
    kind: "items",
    title: "Everything",
    filter: { excludeKinds: ["repo"] },
  },
  {
    id: "items.unread",
    name: "Unread only",
    description: "The same feed, narrowed to what you have not seen.",
    kind: "items",
    title: "Unread",
    filter: { unreadOnly: true },
  },
  {
    id: "projects",
    name: "Projects",
    description: "Registered projects: git status, recap and todos from .ddd/.",
    kind: "projects",
  },
  {
    id: "repos.recent",
    name: "Repositories",
    description: "Recently pushed repos, with a map-or-clone arrow for the ones you don't have.",
    kind: "repos",
    title: "Repositories",
    filter: { scope: "recent" },
  },
  {
    id: "products",
    name: "Products",
    description: "The thing you run once a month and have to look up the command for.",
    kind: "products",
    title: "Products",
  },
  {
    id: "eol",
    name: "Support watch",
    description: "The projects you shipped and stopped opening — and whether their runtimes still get fixes.",
    kind: "eol",
    title: "Support watch",
  },
  {
    id: "devservers",
    name: "Dev servers",
    description: "Which ports are taken, by what, in which project — and whether it is answering.",
    kind: "devservers",
    title: "Dev servers",
  },
  {
    id: "stats",
    name: "Stats board",
    description: "AI spend and tokens, focus, throughput — charts over your local events table.",
    kind: "stats",
    title: "Stats",
  },
  {
    id: "clock",
    name: "Clock",
    description: "Time and date. No source, no connection.",
    kind: "clock",
  },
  {
    id: "notes",
    name: "Notes",
    description: "A scratchpad stored in the layout file alongside the widget.",
    kind: "notes",
  },
  {
    id: "launcher",
    name: "Launcher",
    description: "Open your terminal or IDE at a directory — the tools you already use.",
    kind: "launcher",
  },
  {
    id: "calendar",
    name: "Calendar",
    description: "Your own events, plus any .ics calendar you subscribe to.",
    kind: "calendar",
  },
];
