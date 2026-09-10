/**
 * How a support verdict reads.
 *
 * The one rule underneath all of it: this widget exists to be believed on the
 * day it matters, so it never overstates. `unknown` is neutral and specifically
 * not green, a floor is labelled a floor, and a date is shown next to every
 * claim that has one.
 */

import type { EolFinding, Liveness, Support } from "../types";

export interface Badge {
  label: string;
  color: string;
  title: string;
}

export function badge(support: Support, dates: { eolDate?: string | null; supportDate?: string | null } = {}): Badge {
  switch (support.state) {
    case "ended":
      return {
        label: dates.eolDate ? `ended ${dates.eolDate}` : "out of support",
        color: "var(--err)",
        title: "Security support has ended. Nothing is being fixed in this release line.",
      };
    case "endingSoon":
      return {
        label: support.days === 1 ? "ends tomorrow" : `ends in ${support.days} days`,
        color: "var(--warn)",
        title: "Support ends inside the planning horizon — the upgrade window is open now.",
      };
    case "securityOnly":
      return {
        label: dates.eolDate ? `security only to ${dates.eolDate}` : "security fixes only",
        color: "var(--ink-2)",
        title: "Active support has ended; security fixes continue. A normal place to be.",
      };
    case "active":
      return {
        label: dates.supportDate ? `supported to ${dates.supportDate}` : "supported",
        color: "var(--ok)",
        title: "In active support.",
      };
    default:
      return {
        label: "no schedule",
        color: "var(--ink-3)",
        title:
          "No published support dates for this release line — usually a version newer than the data. Not a verdict.",
      };
  }
}

/**
 * What a finding's source is worth, in words.
 *
 * A floor is the weakest reading and says so: `">=8.4"` does not tell you what
 * is running, only what the code claims to work on.
 */
export function confidenceNote(finding: EolFinding): string {
  switch (finding.confidence) {
    case "exact":
      return "pinned";
    case "range":
      return "a range";
    default:
      return "a minimum, not what is running";
  }
}

/** Every file that agreed, for the row's tooltip. */
export function sources(finding: EolFinding): string {
  const all = [finding.source, ...(finding.also ?? [])];
  return all.length === 1 ? all[0]! : `${all[0]} (also ${all.slice(1).join(", ")})`;
}

/** Worst first, matching the order the Rust side already sorted rows into. */
export function severity(support: Support): number {
  switch (support.state) {
    case "ended":
      return 4;
    case "endingSoon":
      return 3;
    case "securityOnly":
      return 2;
    case "active":
      return 1;
    default:
      return 0;
  }
}

/**
 * A one-line summary for the board header.
 *
 * Counts what is wrong, and says nothing at all when nothing is.
 */
export function headline(rows: { worst: Support; url: string | null }[]): string {
  const ended = rows.filter((r) => r.worst.state === "ended");
  const soon = rows.filter((r) => r.worst.state === "endingSoon");
  if (ended.length === 0 && soon.length === 0) {
    return rows.length === 0 ? "Nothing assigned yet." : "Everything watched is still supported.";
  }
  const parts: string[] = [];
  if (ended.length > 0) {
    const live = ended.filter((r) => r.url).length;
    parts.push(
      `${ended.length} out of support${live > 0 ? `, ${live} of them serving` : ""}`,
    );
  }
  if (soon.length > 0) parts.push(`${soon.length} ending soon`);
  return parts.join(" · ");
}

/**
 * What the live check found, in words.
 *
 * `noAnswer` is deliberately not alarming: someone else's server being slow, or
 * behind a CDN that dislikes HEAD, is not evidence that the site is gone.
 */
export function liveNote(live: Liveness | null | undefined): Badge | null {
  if (!live) return null;
  switch (live.state) {
    case "answering":
      return {
        label: "● live",
        color: "var(--ok)",
        title: `Answered ${live.detail}. An unsupported runtime with traffic on it is the dangerous case.`,
      };
    case "noAnswer":
      return {
        label: "● no answer",
        color: "var(--ink-3)",
        title: `${live.detail} — slow or unreachable from here. Not the same as gone.`,
      };
    default:
      return {
        label: "○ not serving",
        color: "var(--ink-3)",
        title: `${live.detail} — nothing is answering at this address.`,
      };
  }
}

/** Whether a schedule is old enough to admit to. */
export function scheduleNote(ageDays: number | null): string | null {
  if (ageDays === null || ageDays < 8) return null;
  return `dates are ${ageDays} days old`;
}
