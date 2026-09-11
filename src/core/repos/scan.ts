/**
 * Walking a folder the user nominated, reading each checkout's origin. Port of
 * `repos/scan.rs`.
 *
 * One level deep and read-only. Depth one is not a limitation to work around —
 * it is what makes the walk fast and predictable, and it matches how people
 * actually lay out a projects folder.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitRemote } from "../projects";

/** One git checkout directly inside a scan root, with its raw origin url. */
export interface Found {
  path: string;
  url: string | null;
}

function isDir(path: string): boolean {
  try {
    // `statSync` follows symlinks, as Rust's `is_dir()` does — a projects
    // folder full of symlinks is a normal layout.
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every git checkout directly inside `root`, sorted, without asking git
 * anything. Split out from `scanRoot` because it is the whole filesystem half
 * and stays synchronous and pure — the Rust does both in one iterator chain,
 * but `gitRemote` is async in this port.
 */
export function candidates(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found = entries
    .map((name) => join(root, name))
    // Existence only, never `.isDirectory()`: `git worktree` and submodules
    // write `.git` as a *file* holding a gitdir: pointer, and those are real
    // checkouts.
    .filter((path) => isDir(path) && existsSync(join(path, ".git")));
  // The Rust sorts the (path, url) pairs after collecting; paths are unique, so
  // sorting them before the lookups is the same order.
  found.sort();
  return found;
}

/**
 * `(directory, raw origin url)` for every git checkout directly inside `root`.
 *
 * The origin is optional and a `null` is kept, not dropped. A checkout with no
 * resolvable origin — a scratch repo, an SSH alias git cannot expand, one whose
 * remote was never added — is still a repository, and discarding it here is how
 * two thirds of a real projects folder became invisible.
 */
export async function scanRoot(root: string): Promise<Found[]> {
  const found: Found[] = [];
  // Sequential, like the Rust's iterator: the order is the stored order, and a
  // scan root is a handful of folders, not a fan-out worth parallelising.
  for (const path of candidates(root)) found.push({ path, url: await gitRemote(path) });
  return found;
}

/**
 * Which protocol the user's existing clones use, so a new clone matches.
 *
 * An HTTPS clone of a private repo fails confusingly without a credential
 * helper, and SSH fails just as confusingly without keys — so guess from
 * evidence rather than from a default.
 */
export function inferProtocol(found: Found[]): string | null {
  // Only checkouts with a readable remote are evidence. A root of entirely
  // remote-less checkouts yields null, the same answer as an empty root and for
  // the same reason: nothing to infer from.
  const urls = found.map((f) => f.url).filter((url): url is string => url !== null);
  if (urls.length === 0) return null;
  const ssh = urls.filter((url) => url.startsWith("git@") || url.startsWith("ssh://")).length;
  return ssh * 2 >= urls.length ? "ssh" : "https";
}
