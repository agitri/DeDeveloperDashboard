/**
 * The projects registry and the `.ddd/` contract. Port of `projects.rs`.
 *
 * DDD watches the files that Claude Code writes — `todos.json` from `/todo`,
 * `recap.md` from the SessionEnd hook — and never writes them itself, which
 * keeps the coupling one-directional and loose.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DddError } from "./error";
import type { EnvRoot } from "./paths";
import { readJson, writeJson } from "./store";
import { defaultProjectRegistry, projectRegistryFromJson, type ProjectRef, type ProjectRegistry } from "./models";

export function registry(env: EnvRoot): ProjectRegistry {
  return readJson(env.projectsFile(), projectRegistryFromJson, defaultProjectRegistry);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function register(env: EnvRoot, rawPath: string): ProjectRef {
  const path = shellexpandHome(rawPath);
  if (!isDir(path)) throw DddError.notFound(`${path} is not a directory`);
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch (e) {
    throw DddError.io(e);
  }

  const reg = registry(env);
  const existing = reg.projects.find((p) => p.path === canonical);
  if (existing) return existing;
  const entry: ProjectRef = { id: slug(canonical), path: canonical };
  reg.projects.push(entry);
  writeJson(env.projectsFile(), reg);
  return entry;
}

export function unregister(env: EnvRoot, id: string): void {
  const reg = registry(env);
  reg.projects = reg.projects.filter((p) => p.id !== id);
  writeJson(env.projectsFile(), reg);
}

/**
 * The lowercased folder name, non-alphanumerics dashed, plus a hash of the
 * whole path so two checkouts of the same repo name stay distinguishable.
 * The hash is the Rust's `fold(5381, |h, b| h.wrapping_mul(33) ^ b)` over the
 * UTF-8 bytes, in u64, masked to 24 bits — ids must match across the two apps.
 */
export function slug(path: string): string {
  const base = (basename(path) || "project")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "-");
  let h = 5381n;
  for (const b of Buffer.from(path, "utf8")) {
    h = ((h * 33n) & 0xffffffffffffffffn) ^ BigInt(b);
  }
  return `${base}-${(h & 0xffffffn).toString(16)}`;
}

export function shellexpandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
