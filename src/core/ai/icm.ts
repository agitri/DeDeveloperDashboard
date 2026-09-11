/**
 * ICM context assembly. Port of `ai/icm.rs`.
 *
 * "AI output too generic" is a named risk, and the mitigation is that ICM
 * context is a *mandatory input to every AI action*. Files live in
 * `<project>/.ddd/icm/` and are the developer's own words about conventions,
 * architecture and current focus. They are read, never written.
 *
 * Sizes are bytes, as in the Rust (`String::len`), so the budget and the
 * numbers the provenance panel shows agree with the other app.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DddFolder } from "../paths";

/** Total ICM budget. Generous enough for real conventions, bounded so a stray
 *  vendored file cannot turn one board action into a very expensive request. */
export const MAX_CHARS = 24_000;
export const MAX_PER_FILE = 8_000;

/** One ICM file, and what actually happens to it. */
export interface Included {
  name: string;
  path: string;
  /** Size on disk. */
  bytes: number;
  /** How much of it reaches the model. Less than `bytes` when clipped. */
  used: number;
  /** Cut by the per-file cap or by what was left of the total budget. */
  truncated: boolean;
}

/** What an AI action on this project would actually be given. Not a second
 *  implementation of `contextFor`: both come out of one `assemble()`. */
export interface Plan {
  files: Included[];
  /** Files that exist but are past the budget entirely — named, because
   *  "your fourth file is not being read" is the fact worth knowing. */
  skipped: string[];
  totalUsed: number;
  budget: number;
  /** Where the files are, so the panel can offer to open the folder. */
  dir: string;
  /** The folder does not exist. Distinct from existing and being empty. */
  missing: boolean;
}

/** Work out what would be assembled, without assembling it. */
export function planFor(projectDir: string): Plan {
  return assemble(projectDir)[0];
}

/** Read a project's ICM context, in filename order. Empty when a project has
 *  no `.ddd/icm/` — an action still runs, it just produces more generic output. */
export function contextFor(projectDir: string): string {
  return assemble(projectDir)[1];
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

function assemble(projectDir: string): [Plan, string] {
  const dir = DddFolder.of(projectDir).icm();

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [{ files: [], skipped: [], totalUsed: 0, budget: MAX_CHARS, dir, missing: true }, ""];
  }

  const files = names
    .filter((n) => !n.startsWith("."))
    .map((n) => join(dir, n))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  // Sorted so the assembled context is byte-identical between runs — which is
  // what lets prompt caching work at all.
  files.sort();

  const plan: Plan = { files: [], skipped: [], totalUsed: 0, budget: MAX_CHARS, dir, missing: false };
  let out = "";
  let outBytes = 0;

  for (const path of files) {
    const name = path.slice(dir.length + 1);
    if (outBytes >= MAX_CHARS) {
      plan.skipped.push(name);
      continue;
    }
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch {
      // Unreadable is not the same as absent; pretending otherwise makes a
      // permissions problem look like an empty folder.
      plan.skipped.push(name);
      continue;
    }
    const room = Math.min(Math.max(MAX_CHARS - outBytes, 0), MAX_PER_FILE);
    const clipped = clip(body, room);
    const bodyBytes = bytes(body);
    const usedBytes = bytes(clipped);

    plan.files.push({ name, path, bytes: bodyBytes, used: usedBytes, truncated: usedBytes < bodyBytes });
    const chunk = `\n## ${name}\n\n${clipped}\n`;
    out += chunk;
    outBytes += bytes(chunk);
  }

  plan.totalUsed = outBytes;
  return [plan, out];
}

/** Truncate on a character boundary, and say so — a silently cut instruction
 *  reads as a contradictory one. */
function clip(body: string, room: number): string {
  const buf = Buffer.from(body, "utf8");
  if (buf.length <= room) return body;
  let end = Math.min(room, buf.length);
  // Back off any UTF-8 continuation bytes (10xxxxxx) so the cut lands between
  // characters — `is_char_boundary` in the Rust.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf8")}\n\n[…truncated]`;
}
