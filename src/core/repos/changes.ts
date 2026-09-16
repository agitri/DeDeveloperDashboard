import { lines, type Runner } from "../dev/run";

export interface RepoChanges {
  commits: number;
  filesChanged: number;
  messages: string[];
}

/**
 * What changed in a git repo since an ISO timestamp: commit count, the set of
 * files those commits touched, and the commit subjects. Behind the Runner seam
 * so tests use a fake. A git failure (not a repo, path gone) is a normal empty
 * answer, like the dev-server scans — never an error.
 */
export async function changesSince(runner: Runner, repoPath: string, sinceIso: string): Promise<RepoChanges> {
  const base = ["-C", repoPath];
  const log = await runner("git", [...base, "log", `--since=${sinceIso}`, "--format=%h%x09%s"]);
  if (!log.ok) return { commits: 0, filesChanged: 0, messages: [] };
  const rows = lines(log.stdout).filter((l) => l.length > 0);
  const messages = rows.map((l) => l.split("\t").slice(1).join("\t")).filter((s) => s.length > 0);
  const names = await runner("git", [...base, "log", `--since=${sinceIso}`, "--name-only", "--format="]);
  const files = new Set(lines(names.stdout).map((l) => l.trim()).filter((l) => l.length > 0));
  return { commits: rows.length, filesChanged: files.size, messages };
}
