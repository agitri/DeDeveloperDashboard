/**
 * Where things live on disk. Port of `paths.rs`.
 *
 * Nothing in DDD is allowed to reach for a path directly: every subsystem is
 * handed an `EnvRoot`, which is the whole of the environment isolation
 * guarantee.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DddError } from "./error";

/** `~/.ddd`, or `$DDD_HOME` when set (tests, and dev instances that must not
 *  clobber the real config). */
export function dddHome(): string {
  const custom = process.env.DDD_HOME;
  if (custom) return custom;
  const home = homedir();
  if (!home) throw DddError.config("no home directory");
  return join(home, ".ddd");
}

/** `~/.ddd/global.json` — the environment list and the last active one. */
export function globalFile(): string {
  return join(dddHome(), "global.json");
}

/** `~/.ddd/keymap.json` — one keymap for the whole app. */
export function globalKeymapFile(): string {
  return join(dddHome(), "keymap.json");
}

export function environmentsDir(): string {
  return join(dddHome(), "environments");
}

/** Environment ids become directory names and keychain namespaces, so they
 *  are kept boring on purpose. */
export function validateEnvId(id: string): void {
  const ok = id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);
  if (!ok) {
    throw DddError.config(`invalid environment id ${JSON.stringify(id)}: use letters, digits, - and _ (max 64)`);
  }
}

/** A single environment's config root. Hand this to a subsystem and it is
 *  physically unable to read another environment's data. */
export class EnvRoot {
  private constructor(
    public readonly id: string,
    public readonly dir: string,
  ) {}

  static open(id: string): EnvRoot {
    validateEnvId(id);
    const dir = join(environmentsDir(), id);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (cause) {
      throw DddError.io(cause);
    }
    return new EnvRoot(id, dir);
  }

  settingsFile(): string {
    return join(this.dir, "settings.json");
  }
  layoutFile(): string {
    return join(this.dir, "layout.json");
  }
  keymapFile(): string {
    return join(this.dir, "keymap.json");
  }
  projectsFile(): string {
    return join(this.dir, "projects.json");
  }
  /** Which local folder is which GitHub repo. Outside the item cache, which
   *  is wiped and replaced on every sync. */
  repoLinksFile(): string {
    return join(this.dir, "repo-links.json");
  }
  /** Your own calendar events. Same durability reason as repo-links. */
  calendarFile(): string {
    return join(this.dir, "calendar.json");
  }
  watchlistFile(): string {
    return join(this.dir, "watchlist.json");
  }
  /** Derived data: safe to delete, costs one request per product. */
  eolCacheFile(): string {
    return join(this.dir, "eol-cache.json");
  }
  productsFile(): string {
    return join(this.dir, "products.json");
  }
  productApprovalsFile(): string {
    return join(this.dir, "product-approvals.json");
  }
  productsLogDir(): string {
    return join(this.dir, "products");
  }
  eventsDb(): string {
    return join(this.dir, "events.sqlite");
  }
  cacheDb(): string {
    return join(this.dir, "cache.sqlite");
  }
  /** Keychain service name — secrets are namespaced per environment so work
   *  tokens and personal tokens can never collide. */
  keychainService(): string {
    return `ddd:${this.id}`;
  }
}

/** `<project>/.ddd` — the contract folder shared with Claude Code. */
export class DddFolder {
  constructor(public readonly dir: string) {}
  static of(project: string): DddFolder {
    return new DddFolder(join(project, ".ddd"));
  }
  config(): string {
    return join(this.dir, "config.json");
  }
  todos(): string {
    return join(this.dir, "todos.json");
  }
  recap(): string {
    return join(this.dir, "recap.md");
  }
  icm(): string {
    return join(this.dir, "icm");
  }
}

/** Settings → Data shows where an environment's files are. */
export interface PathsInfo {
  home: string;
  environmentDir: string;
  settingsFile: string;
  layoutFile: string;
  keymapFile: string;
  projectsFile: string;
  eventsDb: string;
}

export function pathsInfo(env: EnvRoot): PathsInfo {
  return {
    home: dddHome(),
    environmentDir: env.dir,
    settingsFile: env.settingsFile(),
    layoutFile: env.layoutFile(),
    keymapFile: env.keymapFile(),
    projectsFile: env.projectsFile(),
    eventsDb: env.eventsDb(),
  };
}
