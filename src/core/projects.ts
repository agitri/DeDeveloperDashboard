/**
 * The projects registry and the `.ddd/` contract. Port of `projects.rs`.
 *
 * DDD watches the files that Claude Code writes — `todos.json` from `/todo`,
 * `recap.md` from the SessionEnd hook — and never writes them itself, which
 * keeps the coupling one-directional and loose.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { DddError } from "./error";
import { DddFolder, type EnvRoot } from "./paths";
import { readJson, readJsonOpt, writeJson } from "./store";
import {
  defaultGitStatus,
  defaultProjectConfig,
  defaultProjectRegistry,
  defaultTodoFile,
  projectConfigFromJson,
  projectRegistryFromJson,
  todoFileFromJson,
  type GitStatus,
  type Project,
  type ProjectConfig,
  type ProjectRef,
  type ProjectRegistry,
  type Todo,
} from "./models";

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
    // Rust's `canonicalize` yields a `\\?\` prefix on Windows; `realpathSync`
    // does not, so a registered project's id may differ from the Rust's
    // there (ported blind, spec §10).
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
  const base = (basename(path) || "project").toLowerCase().replace(/[^a-z0-9]/gu, "-");
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

const execFileAsync = promisify(execFile);

/** Every git we run: never prompt, never hang, never truncate. Phase 4's
 *  repos/* and dev/* shell out from the same process and should reuse this. */
export const GIT_EXEC_OPTIONS = {
  encoding: "utf8" as const,
  maxBuffer: 64 * 1024 * 1024,
  timeout: 30_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
};

/** `git -C <dir> <args>`; stdout trimmed, or null when git fails or is absent.
 *  Shelled out rather than linked so the user's own git config (worktrees,
 *  includes) is honoured. */
async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args], GIT_EXEC_OPTIONS);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function gitStatus(dir: string): Promise<GitStatus> {
  if ((await git(dir, ["rev-parse", "--is-inside-work-tree"])) !== "true") return defaultGitStatus();

  // `--porcelain` counts staged + unstaged + untracked in one shot.
  const porcelain = await git(dir, ["status", "--porcelain"]);
  const dirtyFiles = porcelain === null ? 0 : porcelain.split("\n").filter((l) => l !== "").length;

  // Fails on a repo with no upstream; absent counts are the honest answer.
  let ahead = 0;
  let behind = 0;
  const counts = await git(dir, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  if (counts !== null) {
    const [b, a] = counts.split(/\s+/);
    const bn = Number(b);
    const an = Number(a);
    if (Number.isInteger(bn) && Number.isInteger(an)) {
      behind = bn;
      ahead = an;
    }
  }

  return {
    isRepo: true,
    branch: await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirtyFiles,
    ahead,
    behind,
    lastCommitSummary: await git(dir, ["log", "-1", "--pretty=%s"]),
    lastCommitAt: await git(dir, ["log", "-1", "--pretty=%cI"]),
  };
}

/** The `origin` remote of a checkout, if it has one. Read-only. */
export async function gitRemote(dir: string): Promise<string | null> {
  const url = await git(dir, ["remote", "get-url", "origin"]);
  return url ? url : null;
}

/** Just `<project>/.ddd/config.json`. Any failure is the default config: a
 *  repo can ship a broken file and the rest of the board must not care. */
export function configOf(path: string): ProjectConfig {
  try {
    const raw = readJsonOpt(DddFolder.of(path).config());
    return raw === null ? defaultProjectConfig() : projectConfigFromJson(raw);
  } catch {
    return defaultProjectConfig();
  }
}

/** Just enough to answer "is this project called X?" — no git, no recap. */
export function identity(id: string, path: string): { name: string; repos: string[] } {
  const config = configOf(path);
  return { name: config.name ?? (basename(path) || id), repos: config.repos };
}

/** Assemble one project card. A malformed config.json is an error here (the
 *  Rust's `read_json_opt(..)?`), unlike `configOf`. */
export async function load(id: string, path: string): Promise<Project> {
  const ddd = DddFolder.of(path);
  const exists = isDir(path);

  let config = defaultProjectConfig();
  if (exists) {
    const raw = readJsonOpt(ddd.config());
    if (raw !== null) config = projectConfigFromJson(raw);
  }

  let recap: string | null;
  let recapUpdatedAt: string | null;
  try {
    recap = readFileSync(ddd.recap(), "utf8");
    // The Rust writes chrono's RFC 3339 (`+00:00`, nanoseconds); this is the
    // same instant in ISO 8601 (`Z`, milliseconds). Readers parse both.
    recapUpdatedAt = statSync(ddd.recap()).mtime.toISOString();
  } catch {
    recap = null;
    recapUpdatedAt = null;
  }

  let todos: Todo[];
  try {
    todos = readJson(ddd.todos(), todoFileFromJson, defaultTodoFile).todos;
  } catch {
    todos = [];
  }

  let icmFiles: string[];
  try {
    icmFiles = readdirSync(ddd.icm())
      .filter((n) => !n.startsWith("."))
      .sort();
  } catch {
    icmFiles = [];
  }

  const name = config.name ?? (basename(path) || id);

  return {
    id,
    path,
    name,
    exists,
    config,
    git: exists ? await gitStatus(path) : defaultGitStatus(),
    recap,
    recapUpdatedAt,
    todos,
    icmFiles,
  };
}

/** Every card, in parallel: each costs three `git` subprocesses and they are
 *  independent. The Rust used scoped threads; `Promise.all` is the same shape,
 *  including "first failure fails the list". */
export function loadAll(entries: ProjectRef[]): Promise<Project[]> {
  return Promise.all(entries.map((e) => load(e.id, e.path)));
}
