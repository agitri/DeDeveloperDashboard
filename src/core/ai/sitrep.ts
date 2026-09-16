/**
 * The `tab.sitrep` AI action: a per-tab "what happened while I was away"
 * summary. Pure prompt construction only — no electron, no IPC, no I/O.
 */
import type { Completion } from "./provider";

export const ACTION = "tab.sitrep";

export interface SitrepInput {
  projectName: string;
  awayDays: number;
  processesStopped: string[];
  processesRunning: number;
  commits: number;
  filesChanged: number;
  commitMessages: string[];
  aiActions: { action: string; count: number }[];
}

const SYSTEM =
  "You write a brief situation report for a developer returning to a project " +
  "after time away. Two or three short sentences, plain and factual, no " +
  "preamble, no bullet points, no markdown. Say what changed; do not speculate.";

export function completionFor(input: SitrepInput, model: string): Completion {
  const facts = [
    `Project: ${input.projectName}.`,
    `Away for about ${input.awayDays} days.`,
    input.commits > 0
      ? `${input.commits} commit(s) touched ${input.filesChanged} file(s)${input.commitMessages.length ? ": " + input.commitMessages.slice(0, 5).join("; ") : ""}.`
      : "No new commits.",
    input.processesStopped.length > 0
      ? `Processes that stopped: ${input.processesStopped.join(", ")}. ${input.processesRunning} still running.`
      : `${input.processesRunning} process(es) running.`,
    input.aiActions.length > 0
      ? "AI activity: " + input.aiActions.map((a) => `${a.action} ×${a.count}`).join(", ") + "."
      : "No AI activity.",
  ].join("\n");
  return {
    system: SYSTEM,
    prompt: `Here is what happened while the developer was away:\n\n${facts}\n\nWrite the situation report.`,
    maxTokens: 400,
    model,
  };
}
