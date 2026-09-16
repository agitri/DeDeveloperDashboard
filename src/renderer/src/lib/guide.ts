import type { WidgetDefinition } from "../widgets/registry";

export type GuideGroup = "widget" | "integration" | "concept";

export interface GuideEntry {
  id: string;
  group: GuideGroup;
  title: string;
  what: string; // one line: what it is
  how: string; // one line: how to use it
  needs?: string; // one line: what it depends on
}

/**
 * How-to lines per widget kind. The `what` comes from the registry description
 * so it cannot drift; the how is authored here. buildGuide asserts every kind
 * has a line, so a newly registered widget forces a guide row rather than
 * shipping without one.
 */
const WIDGET_HOW: Record<string, { how: string; needs?: string }> = {
  clock: { how: "Add it from the + menu; it needs no setup." },
  notes: { how: "Add it and type; the text is saved in your layout." },
  calendar: { how: "Add it, then subscribe to .ics feeds in Settings to fill it." },
  launcher: { how: "Add it and set targets — a directory and whether to open a terminal or your editor." },
  items: { how: "Add it, bind a connection, and give it a filter (or describe one in words).", needs: "A connection (GitHub, Jira, Slack, mail, MCP…)." },
  stats: { how: "Add it; it reads your local activity, no connection needed." },
  projects: { how: "Register a project folder; it shows git status, todos, recap and .ddd/icm count.", needs: "A folder with a .ddd/ directory." },
  devservers: { how: "Add it; it scans what is listening on this machine." },
  products: { how: "Declare products in a repo's .ddd/config.json, then approve a command once to start it.", needs: "A project with declared products and one-time run approval." },
  eol: { how: "Assign a checkout to watch; it checks weekly whether its runtimes are still supported." },
  repos: { how: "Bind a GitHub connection to list your repos, or add a local checkout by path.", needs: "A GitHub connection for remotes; local scan works without one." },
  about: { how: "Created for you by Promote to tab; shows one repo's facts and recent activity." },
  sitrep: { how: "Bind it to a project; after you have been away a while it summarises what changed." },
  media: { how: "Play/pause, skip and set volume for whatever is playing; auto-follows Spotify or Apple Music.", needs: "macOS, or Linux with playerctl." },
};

export interface GuideStatic {
  id: string;
  title: string;
  what: string;
  how: string;
  needs?: string;
}

export const GUIDE_INTEGRATIONS: GuideStatic[] = [
  { id: "integration:github", title: "GitHub", what: "Your pull requests, issues and repositories.", how: "Add a GitHub connection in Settings → Connections with a token.", needs: "A GitHub personal access token." },
  { id: "integration:jira", title: "Jira", what: "Your Jira issues as items.", how: "Add a Jira connection with your site, email and API token.", needs: "A Jira API token." },
  { id: "integration:slack", title: "Slack", what: "Messages and mentions from Slack.", how: "Add a Slack connection and authorise the requested scopes.", needs: "A Slack token with history scopes." },
  { id: "integration:google", title: "Google (Gmail + Calendar)", what: "Mail as items and events in the calendar.", how: "Add a Google connection and sign in.", needs: "A Google OAuth sign-in." },
  { id: "integration:imap", title: "IMAP mail", what: "Any mailbox over IMAP as items.", how: "Add an IMAP connection with host, user and an app password.", needs: "IMAP host and an app password." },
  { id: "integration:mcp", title: "MCP", what: "Tools and resources from a Model Context Protocol server, shown as items.", how: "Add an MCP connection (stdio command or HTTP endpoint) and approve it once.", needs: "An MCP server command or endpoint, plus one-time consent." },
];

export const GUIDE_CONCEPTS: GuideStatic[] = [
  { id: "concept:mcp", title: "MCP connections", what: "How external tool servers plug in as a source for the Items widget.", how: "Configure one in Settings → Connections; consent binds the exact command." },
  { id: "concept:icm", title: "ICM context files", what: "The .ddd/icm/ files in a project that shape what an AI action is given.", how: "Put files in a project's .ddd/icm/; the Projects and Items widgets show what will be used." },
  { id: "concept:ai", title: "AI routing", what: "Which model answers each AI action — local Ollama or Anthropic.", how: "Set an Ollama URL or an Anthropic key in Settings → AI; actions default to local where they can." },
  { id: "concept:looks", title: "Looks", what: "Two visual treatments of the whole app: classic and console.", how: "Choose a look; it is remembered across launches." },
  { id: "concept:approval", title: "Run approval", what: "Why starting a product needs a one-time consent.", how: "Approve the exact command and directory once; a checkout can declare a command but never auto-run it." },
];

export function buildGuide(widgets: WidgetDefinition[]): GuideEntry[] {
  const widgetEntries: GuideEntry[] = widgets.map((def) => {
    const hint = WIDGET_HOW[def.kind];
    return {
      id: `widget:${def.kind}`,
      group: "widget",
      title: def.name,
      what: def.description,
      how: hint?.how ?? def.description,
      needs: hint?.needs ?? (def.needsConnection ? "A connection." : undefined),
    };
  });
  const toEntry = (group: GuideGroup) => (s: GuideStatic): GuideEntry => ({ ...s, group });
  return [
    ...widgetEntries,
    ...GUIDE_INTEGRATIONS.map(toEntry("integration")),
    ...GUIDE_CONCEPTS.map(toEntry("concept")),
  ];
}
