/**
 * Which local folders are checkouts, and which of them are a known repo.
 * Port of `repos/links.rs` (load/save/upsert; phase 4 adds the rest).
 *
 * Stored outside the item cache on purpose: `replaceForConnection` deletes and
 * reinserts every item on each sync, so anything kept on a repo item would be
 * destroyed every refresh. A mapping the user made must outlive the data it
 * annotates.
 */
import { DddError } from "../error";
import { isArray, isString, optional, record, required } from "../json";
import type { EnvRoot } from "../paths";
import { readJson, writeJson } from "../store";

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
