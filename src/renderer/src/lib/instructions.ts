/**
 * What a widget actually filters by, once its instructions are in play.
 *
 * Three sources want a say: the preset the widget was created from, the
 * instructions you wrote in words, and the controls in the widget's own filter
 * bar. This file is the one place that decides between them, and the one place
 * that turns a compiled filter back into a sentence.
 */

import type { Compiled } from "../types";

type Filter = Record<string, unknown>;

/**
 * Merge the three, most-wins-last: **preset → compiled instructions → the
 * widget's own controls.**
 *
 * A control wins because it is the thing you touched most recently and it is
 * visible on screen; an instruction you cannot see must never quietly beat a
 * dropdown you can. A control counts as touched when its value differs from
 * what the preset seeded — which is why the preset's own filter is recorded at
 * creation, in `config.presetFilter`.
 *
 * With no `presetFilter` recorded (a widget made before this existed), every
 * key in `current` is treated as a control. That is the safe direction: the
 * widget keeps behaving exactly as it did.
 */
export function resolveFilter(
  current: Filter,
  presetFilter: Filter | undefined,
  compiled: Filter | undefined,
): Filter {
  if (!compiled) return current;

  const controls: Filter = {};
  for (const [key, value] of Object.entries(current)) {
    const seeded = presetFilter && key in presetFilter;
    if (!seeded || JSON.stringify(presetFilter![key]) !== JSON.stringify(value)) {
      controls[key] = value;
    }
  }
  return { ...(presetFilter ?? {}), ...compiled, ...controls };
}

/** The compiled filter a widget is carrying, if any. */
export function compiledFilterOf(widget: { config: Filter }): Filter | undefined {
  const compiled = widget.config.instructions as Compiled | undefined;
  return compiled?.filter;
}

/** The filter the widget's preset seeded it with, recorded at creation. */
export function presetFilterOf(widget: { config: Filter }): Filter | undefined {
  const preset = widget.config.presetFilter;
  return preset && typeof preset === "object" ? (preset as Filter) : undefined;
}

const KIND_NAMES: Record<string, string> = {
  pull_request: "pull requests",
  review_request: "review requests",
  issue: "issues",
  comment: "comments",
  mail: "mail",
  mail_bulk: "bulk mail",
  message: "messages",
  mention: "mentions",
  event: "calendar events",
  repo: "repositories",
};

function kindName(kind: string): string {
  return KIND_NAMES[kind] ?? kind;
}

/**
 * What the compiled filter means, in words.
 *
 * The point of compiling once is that the result can be read and argued with.
 * A filter you cannot see is a filter you stop trusting, so this renders every
 * field rather than the interesting ones.
 */
export function describe(filter: Filter): string[] {
  const lines: string[] = [];
  const s = (key: string) => (typeof filter[key] === "string" ? (filter[key] as string) : null);

  if (s("source")) lines.push(`From ${s("source")}.`);
  if (s("kind")) lines.push(`Only ${kindName(s("kind")!)}.`);
  const exclude = filter.excludeKinds;
  if (Array.isArray(exclude) && exclude.length > 0) {
    lines.push(`Hiding ${exclude.map((k) => kindName(String(k))).join(" and ")}.`);
  }
  if (s("query")) lines.push(`Matching “${s("query")}”.`);
  if (s("project")) lines.push(`In project ${s("project")}.`);
  if (s("scope") === "all") lines.push("All of them, not just recent.");
  if (s("scope") === "recent") lines.push("Recent ones only.");
  if (filter.unreadOnly === true) lines.push("Unread only.");
  if (filter.unreadOnly === false) lines.push("Read and unread.");
  if (typeof filter.limit === "number") lines.push(`Showing the newest ${filter.limit}.`);
  if (s("connectionId")) lines.push(`From one account only.`);

  if (lines.length === 0) lines.push("Nothing narrowed — this shows everything the widget can.");
  return lines;
}
