# DDD on Node

De Developer Dashboard — the [Rust/Tauri app](../DDD) rebuilt on Electron with a
TypeScript backend. Same `~/.ddd` files, same keychain entries; the two apps can
share a home.

Design: `docs/superpowers/specs/2026-09-10-node-port-design.md`.

Status: all 71 commands from the Rust `generate_handler!` are ported; phases 0–6 are done.

## Run

    npm install
    npm run dev:electron     # the desktop app, with HMR
    npm run dev              # browser preview of the renderer alone, localStorage-backed
    npm test                 # vitest: core, main and renderer
    npm run smoke            # build, boot, call global_load through the bridge, exit
    npm run build            # typecheck + electron-vite build → out/

If `npm install` could not download the Electron binary (proxy, offline
mirror, …), run `node node_modules/electron/install.js` once to fetch it.

Set `DDD_HOME` to keep a dev instance away from your real board.
`npm run smoke` uses a scratch `DDD_HOME` (a fresh temp directory, logged on
start) unless one is already set, so it never touches your real `~/.ddd`.
`DDD_SMOKE_SHOT=<path>` on `npm run smoke` also writes a PNG of the booted window to `<path>`.
A connection's token is stored in the OS keychain under service `ddd:<env>`, exactly as the Rust app stores it.

## Where things are

    src/core      the port of src-tauri/src — plain Node, never imports electron
    src/main      Electron host: window, ddd:invoke, dialogs, CSP
    src/preload   window.ddd
    src/renderer  the DDD frontend, copied from its HEAD; only lib/ipc.ts knows

## What is ported

| Phase | Contents | State |
|---|---|---|
| 0 | global.json, environments, layout, settings, keymap, events, secrets, paths; the app boots to the starter board | **done** |
| 1 | projects, launcher, `.ddd/` watching: register a folder, launch Claude Code in it, `/todo` reaches the card | **done** |
| 2 | sync engine, item cache, GitHub, OAuth, the approval gate; paste a GitHub token in Settings → Connections to see your PRs | **done** |
| 3 | AI actions (draft / summarize / tasks) over Anthropic, Ollama or an OpenAI-compatible endpoint, ICM project context, widget instructions compiled locally | **done** |
| 4 | Calendar (ICS feeds + local events, recurrence expansion), repos (scan/link/clone with progress), dev servers (list/probe/stop), end-of-life board (endoflife.date, cached) | **done** |
| 5 | Jira, Slack, Gmail + Google Calendar, IMAP (app password, optional local mail classification), MCP servers (stdio and streamable HTTP, consent-gated) | **done** |
| 6 | Products (declare in .ddd/config.json, approve, start/stop via a login shell into its own process group, captured logs), electron-builder packaging (macOS verified; Windows/Linux configured), Claude Code /todo + recap scripts | **done** |

Platform notes: dev-server cwd resolution needs `lsof` on macOS and `/proc` on Linux; stopping a process is not offered on Windows; docker containers appear when the `docker` CLI is on `PATH`; MCP servers are spawned per sync from a JSON-array command approved in Settings; IMAP uses implicit TLS on port 993 and never marks mail read; products are macOS/Linux only (Windows is refused, as in the Rust app); packaging produces an unsigned macOS build locally, and signing/notarization plus the Windows and Linux installers are left for a release pipeline.

The first keychain access on macOS prompts to allow the Electron binary; in a
packaged build that will be DDD itself.

## Beyond the port

Two renderer-only additions, neither present in the Rust app:

- **Features guide** — a modal accordion listing every widget, integration and
  concept, opened from the classic header button or `⌘K`. It's a map of the
  app for anyone landing on a board that's already full of tabs.
- **Promote to tab** — a row action on the Repositories and Projects widgets
  that builds a pre-filled tab from a repo or project: a Launcher, a
  project-scoped Products widget, a read-only About card, Notes, and a Sitrep.
- **Sitrep** — a project-bound widget reporting what changed in a repo while
  you were away from its tab: processes that stopped, commits and changed
  files, and what the AI did. After a long absence (14 days by default) it
  shows a dismissible "while you were away" summary written by the local
  model, falling back to a deterministic digest when no model is available.
  It reads `Tab.lastVisitedAt`, stamped when you switch away from a tab.

These are the first renderer features to intentionally diverge from the DDD
renderer, rather than port it.
