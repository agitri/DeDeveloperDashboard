/**
 * Layouts you can carry between environments, and between machines.
 *
 * §5.9 promises this as the way to copy a setup from one world to another, and
 * it comes with one hard requirement that is easy to miss until it bites:
 *
 * **Tab, group and widget ids must be unique across environments, not just
 * within one.** `store.envOf` answers "which environment owns this tab?" by
 * scanning every environment and returning the first match, and seven store
 * actions depend on it. A widget's id is also the name of its instructions
 * file. Import a layout verbatim and every id in it exists twice: operations on
 * the new tabs silently act on the *old* environment's tabs of the same id, so
 * one environment's tabs appear frozen while the other moves by itself.
 *
 * So ids are re-minted here, where they enter the system, rather than by
 * teaching every reader to cope with the invariant being false.
 */

import type { Layout, Tab, TabGroup, Widget } from "../types";

/** Bumped when the shape changes in a way an older DDD could not read. */
export const PORTABLE_VERSION = 1;

export interface Portable {
  kind: "ddd.layout";
  version: number;
  /** Whose board this was — shown on import, never used to place anything. */
  exportedFrom?: string;
  exportedAt?: string;
  tabs: Tab[];
  groups: TabGroup[];
}

/**
 * Package tabs for export, carrying only the groups they actually use.
 *
 * A group nobody references would arrive as an empty pill, so it is dropped
 * here rather than left for `normalize` to clean up after the fact.
 */
export function exportLayout(
  layout: Layout,
  options: { tabIds?: string[]; from?: string; exportedAt?: string } = {},
): Portable {
  const tabs = options.tabIds
    ? layout.tabs.filter((t) => options.tabIds!.includes(t.id))
    : layout.tabs;
  const used = new Set(tabs.map((t) => t.groupId).filter(Boolean) as string[]);

  return {
    kind: "ddd.layout",
    version: PORTABLE_VERSION,
    exportedFrom: options.from,
    exportedAt: options.exportedAt,
    tabs: structuredClone(tabs),
    groups: layout.groups.filter((g) => used.has(g.id)).map((g) => ({ ...g })),
  };
}

/** What a document failed on, in words a person can act on. */
export class ImportError extends Error {}

/**
 * Read a document, re-minting every id in it.
 *
 * `mint` is injected so the property that matters — that nothing keeps its old
 * id — can be tested without depending on randomness.
 */
export function importLayout(
  input: unknown,
  mint: (prefix: string) => string,
): { tabs: Tab[]; groups: TabGroup[] } {
  const doc = parse(input);

  // Groups first: a tab's new `groupId` has to point at the group's new id, and
  // a tab referencing a group the document did not carry loses the reference
  // rather than pointing into space.
  const groupIds = new Map<string, string>();
  const groups = doc.groups.map((group) => {
    const id = mint("g");
    groupIds.set(group.id, id);
    return { ...group, id };
  });

  const tabs = doc.tabs.map((tab) => ({
    ...tab,
    id: mint("t"),
    groupId: tab.groupId ? (groupIds.get(tab.groupId) ?? null) : null,
    // A widget's id is the name of its instructions file. Carrying it over
    // would make two widgets in two environments share one file, and editing
    // either would change both.
    widgets: (tab.widgets ?? []).map((widget) => reset(widget, mint)),
  }));

  return { tabs, groups };
}

/**
 * A widget, fit to arrive somewhere else.
 *
 * The compiled instructions cache goes: it is keyed to a hash of a file in the
 * environment the layout came from, and that file is not travelling. Keeping it
 * would give the widget a filter it cannot explain and a source you cannot
 * find. The preset filter stays — it is what the widget was made from.
 */
function reset(widget: Widget, mint: (prefix: string) => string): Widget {
  const config = { ...(widget.config ?? {}) };
  delete config.instructions;
  return {
    ...widget,
    id: mint("w"),
    // A connection belongs to the environment that holds its credentials, so a
    // widget bound to one arrives unbound rather than pointing at a connection
    // this world does not have.
    connectionId: null,
    config,
  };
}

function parse(input: unknown): Portable {
  const doc = typeof input === "string" ? json(input) : input;
  if (!doc || typeof doc !== "object") throw new ImportError("That is not a layout file.");

  const candidate = doc as Partial<Portable>;
  if (candidate.kind !== "ddd.layout") {
    throw new ImportError("That file is not a DDD layout.");
  }
  if (typeof candidate.version !== "number" || candidate.version > PORTABLE_VERSION) {
    throw new ImportError(
      `That layout was written by a newer DDD (version ${candidate.version}). Update, then import it.`,
    );
  }
  if (!Array.isArray(candidate.tabs) || candidate.tabs.length === 0) {
    throw new ImportError("That layout has no tabs in it.");
  }
  for (const tab of candidate.tabs) {
    if (!tab || typeof tab.id !== "string" || typeof tab.name !== "string") {
      throw new ImportError("That layout has a tab with no name.");
    }
  }
  return { ...candidate, groups: candidate.groups ?? [] } as Portable;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportError("That file is not readable JSON.");
  }
}
