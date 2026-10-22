import type { WidgetDefinition } from "../widgets/registry";

export type GuideGroup = "widget" | "integration" | "concept";

export interface GuideEntry {
  id: string;
  group: GuideGroup;
  title: string;
  what: string; // ~two lines: what it is
  how: string; // one line: how to use it
  needs: string; // one line: what it depends on — a file, a connection, a URL, a key, or nothing
}

/**
 * Authored copy per widget kind: a two-line `what`, a `how`, and a `needs`.
 * buildGuide asserts (via the drift-guard test) that every registered widget
 * kind has an entry here, so a newly added widget forces a guide row rather
 * than shipping undocumented. The registry description is only a fallback.
 */
const WIDGET_GUIDE: Record<string, { what: string; how: string; needs: string }> = {
  clock: {
    what: "The time and date, and nothing else. It is the floor of the widget contract — proof a widget can render with no data source behind it.",
    how: "Add it from the + menu; there is nothing to configure.",
    needs: "Nothing — it runs on your machine's clock.",
  },
  notes: {
    what: "A markdown scratchpad that lives in the tab itself. Whatever you type is saved straight into the layout, per widget, and travels with the tab.",
    how: "Add it and start typing; the toolbar covers the basics and it saves as you go.",
    needs: "Nothing — the text is stored in layout.json beside the widget.",
  },
  calendar: {
    what: "Your own events and any .ics feeds you subscribe to, merged into one view. Recurring events are expanded so every occurrence shows up.",
    how: "Add it, then subscribe to .ics feeds in Settings — or let a Google connection feed it.",
    needs: "An .ics feed URL or a Google connection (it also works empty).",
  },
  launcher: {
    what: "One-click jumps into your real terminal or editor at a directory you pick. A shortcut rack for the folders you open all day.",
    how: "Add it, then add targets: choose a directory and whether it opens a terminal or your IDE.",
    needs: "A directory path, plus your terminal/editor set in Appearance settings.",
  },
  items: {
    what: "The generic feed. Any connected source — PRs, issues, mail, Slack, Jira, calendar, MCP — sliced by a filter you set or describe in plain words.",
    how: "Add it, bind a connection, and give it a filter; the AI can compile a plain-English description into one.",
    needs: "A connection (GitHub, Jira, Slack, mail, MCP…).",
  },
  stats: {
    what: "Your own local behaviour: AI spend and tokens, focus, throughput. Read from the on-device events table and never sent anywhere.",
    how: "Add it; it charts your recent logged activity automatically.",
    needs: "Nothing external — it reads the local events database.",
  },
  projects: {
    what: "Your registered project folders at a glance: git status, todos, the recap, and the .ddd/icm file count. One card per folder.",
    how: "Register a folder (or promote a repo); the card fills from its .ddd/ directory and git.",
    needs: "A folder on disk with a .ddd/ directory.",
  },
  devservers: {
    what: "What is listening on this machine right now, matched to the project it belongs to. Stop a stray dev server without hunting for its PID.",
    how: "Add it; it scans local ports (and Docker, if the CLI is present) — no setup.",
    needs: "Nothing — a local port scan (lsof on macOS, /proc on Linux).",
  },
  products: {
    what: "The things your repos declare they can run, from <repo>/.ddd/config.json. Start and stop them without a terminal; their output is captured.",
    how: "Declare products in a repo's .ddd/config.json, then approve the exact command once to start it.",
    needs: "A .ddd/config.json declaring products, plus one-time approval (macOS/Linux).",
  },
  eol: {
    what: "A runtime end-of-life watch. For the checkouts you assign it, it checks weekly whether their languages and runtimes are still supported.",
    how: "Assign a checkout to watch; it fetches from endoflife.date and caches the answer.",
    needs: "A watched checkout path (it runs its own weekly network check).",
  },
  repos: {
    what: "Your GitHub repositories and which are checked out locally. Clone one, open it, or promote it into a ready-made tab.",
    how: "Bind a GitHub connection to list remotes, or add a local checkout by path.",
    needs: "A GitHub connection for remotes; a local scan works without one.",
  },
  about: {
    what: "One repo at a glance: its facts, declared products, and recent activity. The read-only card that Promote to tab drops into a repo's tab.",
    how: "Created for you by Promote to tab, or add it and point it at a project.",
    needs: "A project it is bound to (its projectId).",
  },
  sitrep: {
    what: "What changed in a repo while you were away from its tab — processes stopped, commits and files changed, what the AI did. After a long absence it writes a 'while you were away' summary.",
    how: "Bind it to a project; the summary uses your local model, falling back to a plain digest.",
    needs: "A project; a local model (Ollama) for the AI summary is optional.",
  },
  media: {
    what: "Now playing, with transport and volume. It controls whatever is playing and auto-follows the active player, so you never leave the board to skip a track.",
    how: "Add it; play/pause, skip, or drag the volume — pin a specific player if you like.",
    needs: "macOS (Spotify/Apple Music) or Linux with playerctl.",
  },
  models: {
    what: "Every model your local runtimes downloaded — Ollama, the Hugging Face hub (MLX, vLLM, transformers), LM Studio, llama.cpp, Jan, GPT4All — grouped by runtime with sizes and a total. Each row has a Move that takes the model physically out of the runtime's store into a folder of your choosing, one folder per model, so you can archive or delete it in Finder. Ollama models are exported as a GGUF plus a Modelfile (re-import with ollama create) and removed from Ollama.",
    how: "Add it; pick a destination with Choose…, then Move a row or Move all. Big moves to another disk show byte progress.",
    needs: "Nothing — it reads the runtimes' folders (honouring OLLAMA_MODELS and HF_HOME).",
  },
};

export interface GuideStatic {
  id: string;
  title: string;
  what: string;
  how: string;
  needs: string;
}

export const GUIDE_INTEGRATIONS: GuideStatic[] = [
  {
    id: "integration:github",
    title: "GitHub",
    what: "Your pull requests, issues and repositories, pulled into the Items and Repositories widgets. The backbone connection for most boards.",
    how: "Add a GitHub connection in Settings → Connections and paste a token.",
    needs: "A GitHub personal access token.",
  },
  {
    id: "integration:jira",
    title: "Jira",
    what: "Your Jira issues, as items you can filter and act on. Reads across the projects your account can see.",
    how: "Add a Jira connection with your site URL, email and API token.",
    needs: "Your Jira site URL, email, and an API token.",
  },
  {
    id: "integration:slack",
    title: "Slack",
    what: "Messages and mentions from Slack, surfaced as items. Keeps the channels you care about right next to your code.",
    how: "Add a Slack connection and authorise the requested history scopes.",
    needs: "A Slack token with channel/message history scopes.",
  },
  {
    id: "integration:google",
    title: "Google (Gmail + Calendar)",
    what: "Gmail as items and your Google Calendar events, in one place. Sign in once and both flow onto the board.",
    how: "Add a Google connection and sign in through the browser.",
    needs: "A Google account and an OAuth sign-in.",
  },
  {
    id: "integration:imap",
    title: "IMAP mail",
    what: "Any mailbox over plain IMAP, shown as items. For mail that isn't Gmail, or when you'd rather use an app password than OAuth.",
    how: "Add an IMAP connection with host, username and an app password.",
    needs: "An IMAP host (implicit TLS on 993) and an app password.",
  },
  {
    id: "integration:mcp",
    title: "MCP",
    what: "Tools and resources from a Model Context Protocol server, shown as items. Brings an external tool's data onto the board through the Items widget.",
    how: "Add an MCP connection — a stdio command or an HTTP endpoint — and approve it once.",
    needs: "An MCP server command or URL, plus one-time consent.",
  },
];

export const GUIDE_CONCEPTS: GuideStatic[] = [
  {
    id: "concept:mcp",
    title: "MCP connections",
    what: "How an external tool server plugs in as a source for the Items widget. The consent step binds the exact command, so a checkout can never run something new behind your back.",
    how: "Configure one in Settings → Connections and approve the exact command once.",
    needs: "An MCP server command/endpoint and your one-time consent.",
  },
  {
    id: "concept:icm",
    title: "ICM context files",
    what: "The .ddd/icm/ files in a project that shape what an AI action is given. Drop context in and every AI action for that project reads it — this is how you steer the model per project.",
    how: "Put files in a project's .ddd/icm/; the Projects and Items widgets show what will be used.",
    needs: "An .ddd/icm/ folder in the project with files in it.",
  },
  {
    id: "concept:ai",
    title: "AI routing",
    what: "Which model answers each AI action — your local Ollama, Anthropic, or an OpenAI-compatible endpoint. Routing is per action, so summaries can stay local while drafts use a bigger model.",
    how: "Set an Ollama URL or an Anthropic key in Settings → AI; actions default to local where they can.",
    needs: "An Ollama URL (local) or an Anthropic API key (cloud).",
  },
  {
    id: "concept:looks",
    title: "Looks",
    what: "Two visual treatments of the whole app: classic and console. Same features and data, a different shell — pick the one you like.",
    how: "Choose a look; it is remembered across launches.",
    needs: "Nothing — a display preference stored locally.",
  },
  {
    id: "concept:approval",
    title: "Run approval",
    what: "Why starting a product needs a one-time consent. A checkout can declare a command, but DDD never runs it until you approve that exact command and directory — so a cloned repo can't execute anything on first open.",
    how: "Approve the exact command and directory once, from the Products widget.",
    needs: "Your explicit approval of the exact command + directory.",
  },
  {
    id: "concept:appearance",
    title: "Scale, scheme & accent",
    what: "Settings → Appearance sizes and colours the whole app: a UI scale percentage (80–150%, real browser zoom so everything grows together), a shortcut-badge size, six colour schemes in light and dark, and an accent that follows your environment colour unless you fix one.",
    how: "Open Settings → Appearance; every change applies live, no reload.",
    needs: "Nothing — it is saved in global.json for every environment.",
  },
  {
    id: "concept:tour",
    title: "Guided tour",
    what: "A hands-on walkthrough that has you actually create an environment, add tabs and a widget, and open settings. This guide is where it points you at the end.",
    how: "It runs on first launch; replay it anytime from here or the command palette (Start tour).",
    needs: "Nothing — it runs on a fresh install and on demand.",
  },
];

export function buildGuide(widgets: WidgetDefinition[]): GuideEntry[] {
  const widgetEntries: GuideEntry[] = widgets.map((def) => {
    const g = WIDGET_GUIDE[def.kind];
    return {
      id: `widget:${def.kind}`,
      group: "widget",
      title: def.name,
      what: g?.what ?? def.description,
      how: g?.how ?? def.description,
      needs: g?.needs ?? (def.needsConnection ? "A connection." : "Nothing."),
    };
  });
  const toEntry =
    (group: GuideGroup) =>
    (s: GuideStatic): GuideEntry => ({ ...s, group });
  return [...widgetEntries, ...GUIDE_INTEGRATIONS.map(toEntry("integration")), ...GUIDE_CONCEPTS.map(toEntry("concept"))];
}
