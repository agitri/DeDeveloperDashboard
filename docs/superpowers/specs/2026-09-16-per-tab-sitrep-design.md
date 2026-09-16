# Per-Tab Sitrep Widget — Design

**Status:** approved for planning (2026-09-16)
**Author:** nodeDDD post-port UX phase, part 2
**Depends on:** the Features Guide + Promote-to-tab work (main at `cf4144f`), and the About widget it seeds from.

## Goal

A `sitrep` widget that reports the concrete changes to a repo/project **while you were away from its tab**: processes that stopped, how many files changed across how many commits, and what the AI did. It always shows a compact newest-first timeline of those changes; when the tab has been unopened past a threshold (default 14 days), it shows a dismissible "while you were away" summary on top, written by the local model, with a deterministic digest fallback when no model is available.

This is the per-tab history/situation-report the user asked for. The About widget is its seed and stays as-is (a glanceable card); the sitrep tells the narrative.

## What "the tab's sitrep" means (settled)

Not "UI activity inside the tab." It is the state of the tab's **subject** — its project/repo — and what changed there over the away period:

- **Processes**: products/processes for the project that stopped or exited (state deltas), and how many are still running.
- **Repo**: commits and a changed-file count since you were last here (from git).
- **AI**: the `ai.*` actions that ran for the project (drafts, summaries, classifications).

So the widget is **project-bound** (`config.projectId`), exactly like About. A tab with no project shows an empty "bind a project" state.

## Non-goals

- No cross-tab or environment-wide report; the sitrep is one project.
- No new event kinds and no change to the events schema or the shared `~/.ddd` layout. New AI events reuse the existing `events` table.
- No always-on background polling of git; the repo delta is fetched when the widget loads or refreshes, like every other widget.
- Not a replacement for About or the `.ddd/recap.md` recap; it is a distinct widget.

## Architecture

Split so the deterministic fallback and the AI prose summarize the *same* computed delta, and so the pure logic is tested on both sides of the IPC boundary.

**Core (`src/core`, no electron):**
- `src/core/ai/sitrep.ts` — the `tab.sitrep` action id, a shared `SitrepInput` type (the computed delta), and `completionFor(input): { system: string; user: string }` (the prompt builder, pure), mirroring `src/core/instructions.ts`.
- `src/core/repos/changes.ts` — `changesSince(runner, repoPath, sinceIso): Promise<RepoChanges>` where `RepoChanges = { commits: number; filesChanged: number; messages: string[] }`, behind the existing `Runner` seam (`src/core/dev/run.ts`) so tests use a fake. Uses `git log --since=<iso>` for commit count and messages, and the distinct file set across those commits for `filesChanged`.

**Main (`src/main/commands.ts`):**
- `repo_changes_since({ env, path, since })` → `RepoChanges` — thin wrapper over `changesSince` with the real runner.
- `tab_sitrep_generate({ env, input })` → `{ text: string; model: string }` — loads settings, `route(r, settings, sitrep.ACTION, deps.sync)`, `chosen.provider.complete(sitrep.completionFor(input))`, logs an `ai.tab.sitrep` event (tokens/cost/meta like `ai.widget.instructions`), returns the prose. Errors (e.g. Ollama down) propagate as `DddError` for the renderer to catch and fall back.
- `src/core/settings.ts` `defaultAiSettings().routing` gains `"tab.sitrep": "local"`. The existing routing backfill adds it to saved `settings.json` with no migration.

**Renderer (`src/renderer/src`):**
- `src/renderer/src/widgets/SitrepWidget.tsx` — the widget (kind `sitrep`), project-bound via `config.projectId`.
- `src/renderer/src/lib/sitrep.ts` — pure: `extractDelta({ project, products, events, changes, since }): SitrepInput`, `buildDigest(input): string` (the deterministic fallback text), and `awayInfo(lastVisitedAt, now, thresholdDays): { away: boolean; days: number }`.
- `src/renderer/src/types/index.ts` — `Tab` gains `lastVisitedAt?: string | null`; the sitrep `config` type.
- `src/renderer/src/state/store.ts` — `selectTab` stamps the **outgoing** tab's `lastVisitedAt = new Date().toISOString()` before `persistLayout`.
- `src/renderer/src/lib/products.ts` — extend `since()` with week granularity (`>=7d → "Nw"`), so "~2 weeks" reads right; it is used elsewhere and the change is an improvement.
- `src/renderer/src/widgets/registry.tsx` — register `sitrep`.
- `src/renderer/src/lib/promote.ts` — `buildPromotedTab` also adds a `sitrep` widget for the project.
- `src/renderer/src/lib/guide.ts` — a `WIDGET_HOW.sitrep` entry (the guide drift-guard requires it).
- `src/renderer/src/styles/global.css` + `console.css` — a dismissible `.sitrep-banner` callout and timeline styles, both looks.

## Data flow

```
tab opened → SitrepWidget mounts (its tab is active)
  locate own tab via store → lastVisitedAt (previous leave time)
  gather (parallel):
    ipc.projectsList(env)      → project (name, path, git)
    ipc.productsList(env)      → filterByProject → running/stopped
    ipc.eventsQuery(env,{kindPrefix:"ai.",limit})  + product.* events, filtered to project & since lastVisitedAt
    ipc.repoChangesSince(env, project.path, lastVisitedAt) → {commits, filesChanged, messages}
  extractDelta(...) → SitrepInput
  render timeline always (from SitrepInput)
  awayInfo(lastVisitedAt, now, thresholdDays).away ?
    → show dismissible banner:
        cached config.sitrep covers this range? → show cached text
        else → ipc.tabSitrepGenerate(env, SitrepInput)  (local model)
                 ok → cache {text, coveredThroughTs, generatedAt, model} in config.sitrep, show
                 error (no model) → buildDigest(SitrepInput), show, offer "Summarise with AI"

switching away from a tab → selectTab stamps outgoing tab.lastVisitedAt = now
```

`lastVisitedAt` is stamped on leave, so on the next open it is genuinely "when I last left this tab." A brand-new or never-left tab has `lastVisitedAt` null → no banner. Events are logged with the project **name** (not the registry id), so the renderer filters by name, reusing the About-widget convention.

## The away banner

- Appears only when `now - lastVisitedAt > thresholdDays` (default 14, editable via `config.awayDays`).
- Dismissible: a close control sets a dismissed marker in `config.sitrep` so it does not reappear for that covered range; it reappears after the next long absence (a newer range).
- Content: the local-model prose, or the deterministic digest when the model is unavailable, always labelled so the user knows which they are reading.
- Cached in `config.sitrep = { text, coveredThroughTs, generatedAt, model, dismissedRange? }` in `layout.json` (the compiled-instructions cache pattern). Staleness is by covered range, not a hash.

## Caching and cost

The summary is generated at most once per away-return (cache keyed by covered range) and only routes to the local model by default, so it does not spend API budget unless the user explicitly picks the Anthropic fallback in a later iteration (out of scope here — this spec ships local + deterministic only). The deterministic digest costs nothing and is always available.

## Errors and edge cases

- **No project bound / project not found**: compact empty state; no git call.
- **Not a git repo / path gone**: `changesSince` returns zeros (the git call failing is a normal empty answer, like the dev-server scans), and the widget shows "no repo changes."
- **Ollama down**: `tab_sitrep_generate` throws `DddError`; the widget shows `buildDigest(...)` and a "Summarise with AI" retry — it never breaks (the InstructionsPanel rule).
- **No activity in the window**: timeline shows "nothing changed while you were away"; no banner spends a model call for an empty delta (skip generation when the delta is empty).
- **`lastVisitedAt` null**: no banner.

## Testing

- Core: `src/core/repos/changes.test.ts` (`changesSince` parses commit count, file count, messages from a fake `Runner`; a non-repo/error yields zeros); `src/core/ai/sitrep.test.ts` (`completionFor` includes the delta facts and the local-summary framing).
- Renderer: `src/renderer/src/lib/sitrep.test.ts` (`extractDelta` maps products/events/changes into the delta with project-name filtering; `buildDigest` renders the counts and notable lines and handles the empty delta; `awayInfo` thresholds correctly, including the null case); extend `src/renderer/src/lib/products.test.ts` for the new week granularity; extend `src/renderer/src/lib/promote.test.ts` for the added sitrep widget.
- `npm test` and `npm run typecheck` exit 0 (the exit code is the gate; the two live FSEvents watcher tests may flake under load and pass in isolation). `npm run build` clean.

## Delivery

- One spec (this file), one plan, executed subagent-driven with a final whole-branch review and one fix wave, then merged to main locally — the established workflow.
- The Features Guide gains a sitrep entry (the standing rule: new features update the guide).
- **Final step: package a runnable build.** After merge and verification, run the electron-builder packaging (`npm run dist:dir` for the unpacked app, or `npm run dist` for a shareable `.dmg`) so the user can open a build carrying all the new features — the guide, promote-to-tab, and the sitrep. Report the artifact path.
