/**
 * Which local folders are checkouts, and which of them are a known repo.
 * Port of `repos/links.rs` (load/save/upsert; phase 4 adds the rest).
 *
 * Stored outside the item cache on purpose: `replaceForConnection` deletes and
 * reinserts every item on each sync, so anything kept on a repo item would be
 * destroyed every refresh. A mapping the user made must outlive the data it
 * annotates.
 */
import { realpathSync } from "node:fs";
import { DddError } from "../error";
import { isArray, isString, optional, record, required } from "../json";
import type { EnvRoot } from "../paths";
import { readJson, writeJson } from "../store";
import { fallbackKey } from "./remote";

/** `scan`: discovered by walking a scan root. `manual`: the user pointed at it. */
export type LinkSource = "scan" | "manual";
/** `exact`: matched on the full remote including host. `fallback`: on `owner/repo` only. */
export type Confidence = "exact" | "fallback";

/** A checkout DDD knows about, which may or may not link to a remote. `path`
 *  is the identity — a folder is one checkout. */
export interface RepoLink {
  remote: string | null;
  path: string;
  source: LinkSource;
  confidence: Confidence;
}

export interface RepoLinks {
  links: RepoLink[];
  /** Folders the user nominated for scanning. */
  scanRoots: string[];
  /** `ssh` or `https`, inferred from what the user's existing clones use. */
  preferredProtocol: string | null;
}

export function defaultRepoLinks(): RepoLinks {
  return { links: [], scanRoots: [], preferredProtocol: null };
}

const isLinkSource = (v: unknown): v is LinkSource => v === "scan" || v === "manual";
const isConfidence = (v: unknown): v is Confidence => v === "exact" || v === "fallback";

export function repoLinkFromJson(raw: unknown): RepoLink {
  const o = record(raw, "repo link");
  return {
    remote: optional(o, "remote", isString, null as string | null),
    path: required(o, "path", isString),
    source: required(o, "source", isLinkSource),
    confidence: required(o, "confidence", isConfidence),
  };
}

export function repoLinksFromJson(raw: unknown): RepoLinks {
  const o = record(raw, "repo links");
  const links = optional(o, "links", isArray, [] as unknown[]).map(repoLinkFromJson);
  const scanRoots = optional(o, "scanRoots", isArray, [] as unknown[]).map((r) => {
    if (!isString(r)) throw DddError.json("invalid type for field `scanRoots`");
    return r;
  });
  return { links, scanRoots, preferredProtocol: optional(o, "preferredProtocol", isString, null as string | null) };
}

export function load(env: EnvRoot): RepoLinks {
  return readJson(env.repoLinksFile(), repoLinksFromJson, defaultRepoLinks);
}

export function save(env: EnvRoot, links: RepoLinks): void {
  writeJson(env.repoLinksFile(), links);
}

/** Insert or replace, holding both invariants: at most one record per `path`,
 *  and at most one per non-null `remote` (newest claim wins). Null remotes are
 *  exempt: any number of checkouts may have no origin. */
export function upsert(env: EnvRoot, link: RepoLink): void {
  const stored = load(env);
  stored.links = stored.links.filter((existing) => existing.path !== link.path && !(link.remote !== null && existing.remote === link.remote));
  stored.links.push(link);
  save(env, stored);
}

export function remove(env: EnvRoot, remote: string): void {
  const stored = load(env);
  stored.links = stored.links.filter((existing) => existing.remote !== remote);
  save(env, stored);
}

/** Drop the record at `path`. How a local-only checkout is forgotten, since it
 *  may have no remote to name it by. */
export function removeByPath(env: EnvRoot, path: string): void {
  const stored = load(env);
  stored.links = stored.links.filter((existing) => existing.path !== path);
  save(env, stored);
}

/** The exact-tier lookup. Skips records with no remote by construction (`null`
 *  never equals the wanted string): a local-only checkout must never satisfy a
 *  GitHub row's join. */
export function find(links: RepoLinks, wanted: string): RepoLink | null {
  return links.links.find((link) => link.remote === wanted) ?? null;
}

/**
 * Find a link for a repo, and report **which tier matched**.
 *
 * Two tiers: the full normalized remote including host, then `owner/repo`
 * alone. The fallback exists because a stored link may have been made from a
 * remote we can no longer reproduce exactly (an SSH alias, a host that moved, a
 * link created by hand with no `remote:` ref at all).
 *
 * When the two disagree the caller must report the *weaker* of them, because
 * the guess was made here, in this join, not when the link was stored.
 * Reporting the link's own stored confidence would show a guess as a certainty
 * — exactly what the two-tier design exists to prevent.
 */
export function findWithTier(links: RepoLinks, normalized: string, https: string): { link: RepoLink; confidence: Confidence } | null {
  const exact = find(links, normalized);
  if (exact !== null) return { link: exact, confidence: "exact" };
  const wanted = fallbackKey(https);
  if (wanted === null) return null;
  // A checkout with no remote has nothing to fall back *to*; it must never
  // satisfy a GitHub row's join at either tier.
  const match = links.links.find((l) => l.remote !== null && fallbackKey(l.remote) === wanted);
  return match === undefined ? null : { link: match, confidence: "fallback" };
}

/**
 * Canonicalize a path for storage in the link store.
 *
 * The canonical form `projects.register` always stores for a `ProjectRef.path`.
 * `repos_list` resolves a row's `projectId` by comparing a stored link's `path`
 * against that registry with plain string equality — so a path stored in any
 * other form (the raw string the user picked, a trailing slash, through a
 * symlink) would never compare equal, and `projectId` would silently stay null
 * forever: the row would show as linked but never connect to its project card.
 *
 * Every write into the link store must go through this so that join keeps
 * working. A path that vanished between being found and being stored (a race
 * with the picker, or a scan racing a delete) is a real error, not something to
 * paper over by falling back to the raw path.
 */
export function canonicalPath(path: string): string {
  try {
    // Rust's `canonicalize` yields a `\\?\` prefix on Windows; `realpathSync`
    // does not — the same deviation `projects.register` already documents.
    return realpathSync(path);
  } catch (e) {
    throw DddError.io(e);
  }
}
