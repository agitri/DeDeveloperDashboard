import type { EventRow } from "../types";

/**
 * Which events belong on a single project's About card.
 *
 * Job events (`project.launch`, `item.*`, `ai.*`) are logged with the
 * project's **name** (its basename), not its registered **id**
 * (`<basename>-<hash6>`) — so the card must filter by name, not id. The one
 * exception is this widget's own `tab.promote` event, which is written
 * against the promoted tab's id; passing that id too keeps those visible for
 * the project they promoted.
 *
 * Pure over its input — `events` is expected newest-first already (that is
 * how `eventsQuery` returns it), so this never re-sorts, only filters and
 * caps.
 */
export function recentForProject(
  events: EventRow[],
  projectName: string | undefined,
  limit = 8,
  projectId?: string,
): EventRow[] {
  if (!projectName) return [];
  return events
    .filter((e) => e.project === projectName || (!!projectId && e.project === projectId))
    .slice(0, limit);
}
