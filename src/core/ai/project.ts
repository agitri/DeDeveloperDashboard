/**
 * Map an item back to a registered project directory, so its ICM can be
 * found. Port of `project_dir_for` / `resolve_project_dir` in `commands.rs`.
 *
 * The link store is consulted first: it holds an actual git remote, which is a
 * fact. Name matching is the fallback, and it is guesswork — two projects
 * called `api` in different orgs are indistinguishable that way.
 */
import { statSync } from "node:fs";
import type { Item } from "../models";
import type { EnvRoot } from "../paths";
import { identity, registry } from "../projects";
import * as links from "../repos/links";
import { fallbackKey } from "../repos/remote";

export function projectDirFor(env: EnvRoot, item: Item): string | null {
  if (item.project === undefined || item.project === null) return null;
  return resolveProjectDir(env, item.project.toLowerCase());
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The lookup itself, taking the already-lowercased key. */
export function resolveProjectDir(env: EnvRoot, wanted: string): string | null {
  // Fact first: a repo whose remote we have actually read.
  let stored: links.RepoLinks | null;
  try {
    stored = links.load(env);
  } catch {
    stored = null;
  }
  if (stored !== null) {
    const byRemote = stored.links.find((link) => link.remote !== null && fallbackKey(link.remote) === wanted);
    if (byRemote !== undefined && isDir(byRemote.path)) return byRemote.path;
  }

  // Guesswork second — on names alone. `projects.load` would answer this too,
  // and runs three `git` subprocesses per project; the registry is enough.
  const tail = wanted.includes("/") ? wanted.slice(wanted.lastIndexOf("/") + 1) : wanted;
  let entries: { id: string; path: string }[];
  try {
    entries = registry(env).projects;
  } catch {
    return null;
  }
  for (const entry of entries) {
    const who = identity(entry.id, entry.path);
    const name = who.name.toLowerCase();
    const matches = name === wanted || name === tail || who.repos.some((repo) => repo.toLowerCase() === wanted);
    if (matches) return entry.path;
  }
  return null;
}
