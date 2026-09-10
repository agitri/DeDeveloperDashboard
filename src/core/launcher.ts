/**
 * Opening a terminal in a project and starting Claude Code, and opening a
 * project in an editor. Port of `launcher.rs`.
 *
 * Terminals disagree about almost everything on the command line, so rather
 * than encoding six dialects, we write a tiny shell script and hand that to the
 * terminal — every terminal on earth knows how to run a script.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { DddError } from "./error";
import type { FoundApp } from "./models";

/** Where the terminal preference came from, in precedence order. */
export function resolveTerminal(projectPref: string | null | undefined, envPref: string | null | undefined): string | null {
  const chosen = (projectPref ?? envPref ?? "").trim();
  return chosen === "" ? null : chosen;
}

/** POSIX single-quoting: wrap in quotes and turn each `'` into `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A script that lands you in the project directory with Claude Code running,
 *  and — crucially — leaves you at a shell when it exits instead of slamming
 *  the window shut on whatever it printed.
 *
 *  The path is predictable, in a shared `/tmp` — a local-user race on Linux
 *  (another user on the box can pre-create or replace the file before we
 *  write it), inherited from the Rust on purpose (spec §1). `mkdtempSync`
 *  with mode `0o700` is the fix, if this ever needs to be hardened. */
export function writeLaunchScript(dir: string, command: string): string {
  const script = `#!/bin/sh\ncd ${shellQuote(dir)} || exit 1\n${command}\nexec "\${SHELL:-/bin/sh}" -l\n`;
  const name = `ddd-launch-${(basename(dir) || "project").replace(/[^A-Za-z0-9]/gu, "-")}.command`;
  const path = join(tmpdir(), name);
  try {
    writeFileSync(path, script);
    if (process.platform !== "win32") chmodSync(path, 0o755);
  } catch (e) {
    throw DddError.io(e);
  }
  return path;
}

/** Split a template on whitespace, honouring quoted segments — enough of a
 *  shell parser for `wezterm start --cwd {dir} -- {cmd}`. */
export function splitTemplate(template: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of template) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Start a program and let go of it. Resolves once the process exists,
 *  rejects if it could not be started — the Rust's `Command::spawn()`. */
export function spawnDetached(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", (e) => reject(DddError.io(e)));
  });
}

function templateParts(template: string, substitute: (part: string) => string, emptyMessage: string): [string, string[]] {
  const parts = splitTemplate(template).map(substitute);
  const [program, ...args] = parts;
  if (program === undefined) throw DddError.config(emptyMessage);
  return [program, args];
}

export async function launch(dir: string, terminal: string | null | undefined, command: string): Promise<void> {
  if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);

  // A preference containing a placeholder is a full command template, and the
  // user is telling us they know their terminal better than we do.
  if (terminal && (terminal.includes("{dir}") || terminal.includes("{cmd}"))) {
    const [program, args] = templateParts(
      terminal,
      (part) => part.replaceAll("{dir}", dir).replaceAll("{cmd}", command),
      "empty terminal template",
    );
    await spawnDetached(program, args);
    return;
  }

  await launchPlatform(dir, terminal ?? null, command);
}

/** The Linux candidate list: the configured terminal on its own — even an
 *  empty string, which the Rust also tries and lets fail — else `$TERMINAL`,
 *  else the usual suspects, in this exact order. */
export function linuxCandidates(terminal: string | null, envTerminal: string | undefined): string[] {
  if (terminal !== null) return [terminal];
  return [
    ...(envTerminal ? [envTerminal] : []),
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "wezterm",
    "alacritty",
    "kitty",
    "xfce4-terminal",
    "xterm",
  ];
}

async function launchPlatform(dir: string, terminal: string | null, command: string): Promise<void> {
  if (process.platform === "darwin") {
    const script = writeLaunchScript(dir, command);
    // `open -a` hands the .command file to the terminal app, which runs it —
    // this works identically for Terminal.app, iTerm2 and friends.
    await spawnDetached("open", ["-a", terminal ?? "Terminal", script]);
    return;
  }

  if (process.platform === "win32") {
    // Windows Terminal takes a working directory directly, which is by far the
    // cleanest path when it is present. Written blind, as the Rust was.
    if (terminal === null || terminal === "wt") {
      try {
        await spawnDetached("wt", ["-d", dir, "cmd", "/K", command]);
        return;
      } catch {
        // fall through to cmd
      }
    }
    await spawnDetached("cmd", ["/C", "start", "", terminal ?? "cmd", "/K", `cd /d ${dir} && ${command}`]);
    return;
  }

  // Linux: the configured terminal, else $TERMINAL, else the usual suspects.
  const script = writeLaunchScript(dir, command);
  const candidates = linuxCandidates(terminal, process.env.TERMINAL);
  for (const candidate of candidates) {
    // gnome-terminal dropped `-e` in favour of `--`; everything else kept `-e`.
    const separator = candidate.includes("gnome-terminal") ? "--" : "-e";
    try {
      await spawnDetached(candidate, [separator, script]);
      return;
    } catch {
      // try the next one
    }
  }
  throw DddError.config(
    `no terminal could be launched (tried: ${candidates.join(", ")}). Set one in Settings → Appearance, ` +
      "or use a template like `alacritty --working-directory {dir} -e {cmd}`.",
  );
}

// ---------------------------------------------------------------------------
// Finding the apps a developer already has
// ---------------------------------------------------------------------------

/** An app DDD knows how to find and hand a directory to. Catalogs make the
 *  common case one click; anything installed stays reachable by name. */
export interface KnownApp {
  id: string;
  name: string;
  /** macOS bundle name without `.app`; empty when there is no bundle. */
  bundle: string;
  /** CLI launcher on Linux and Windows; empty when there is none. */
  cli: string;
}

export const KNOWN_EDITORS: readonly KnownApp[] = [
  { id: "vscode", name: "VS Code", bundle: "Visual Studio Code", cli: "code" },
  { id: "cursor", name: "Cursor", bundle: "Cursor", cli: "cursor" },
  { id: "zed", name: "Zed", bundle: "Zed", cli: "zed" },
  { id: "phpstorm", name: "PhpStorm", bundle: "PhpStorm", cli: "pstorm" },
  { id: "webstorm", name: "WebStorm", bundle: "WebStorm", cli: "webstorm" },
  { id: "idea", name: "IntelliJ IDEA", bundle: "IntelliJ IDEA", cli: "idea" },
  { id: "pycharm", name: "PyCharm", bundle: "PyCharm", cli: "pycharm" },
  { id: "goland", name: "GoLand", bundle: "GoLand", cli: "goland" },
  { id: "rustrover", name: "RustRover", bundle: "RustRover", cli: "rustrover" },
  { id: "sublime", name: "Sublime Text", bundle: "Sublime Text", cli: "subl" },
  { id: "xcode", name: "Xcode", bundle: "Xcode", cli: "xed" },
  { id: "androidstudio", name: "Android Studio", bundle: "Android Studio", cli: "studio" },
];

/** Terminals, in rough order of "if you installed this, you meant it".
 *  Terminal.app is last precisely because everyone has it. */
export const KNOWN_TERMINALS: readonly KnownApp[] = [
  { id: "iterm", name: "iTerm", bundle: "iTerm", cli: "" },
  { id: "ghostty", name: "Ghostty", bundle: "Ghostty", cli: "ghostty" },
  { id: "warp", name: "Warp", bundle: "Warp", cli: "" },
  { id: "wezterm", name: "WezTerm", bundle: "WezTerm", cli: "wezterm" },
  { id: "alacritty", name: "Alacritty", bundle: "Alacritty", cli: "alacritty" },
  { id: "kitty", name: "kitty", bundle: "kitty", cli: "kitty" },
  { id: "hyper", name: "Hyper", bundle: "Hyper", cli: "hyper" },
  { id: "gnome-terminal", name: "GNOME Terminal", bundle: "", cli: "gnome-terminal" },
  { id: "konsole", name: "Konsole", bundle: "", cli: "konsole" },
  { id: "xfce4-terminal", name: "Xfce Terminal", bundle: "", cli: "xfce4-terminal" },
  { id: "terminal", name: "Terminal", bundle: "Terminal", cli: "" },
];

/** Where macOS keeps applications. `/System/Applications/Utilities` is where
 *  Terminal.app has lived since Catalina. */
export const MAC_APP_ROOTS = ["/Applications", "/System/Applications", "/System/Applications/Utilities", join(homedir(), "Applications")];

function onPath(command: string): boolean {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return paths.some((dir) => {
    try {
      return statSync(join(dir, command)).isFile() || statSync(join(dir, command + ".exe")).isFile();
    } catch {
      return false;
    }
  });
}

function appTarget(app: KnownApp, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "darwin") {
    // `open -a` needs only the bundle name, and works whether or not the user
    // ever installed a CLI launcher.
    if (app.bundle === "") return null;
    return MAC_APP_ROOTS.some((root) => existsSync(join(root, `${app.bundle}.app`))) ? app.bundle : null;
  }
  if (app.cli === "") return null;
  return onPath(app.cli) ? app.cli : null;
}

/** Which apps in a catalog are installed. Best-effort: never errors. */
export function detect(catalog: readonly KnownApp[], platform: NodeJS.Platform = process.platform): FoundApp[] {
  const found: FoundApp[] = [];
  for (const app of catalog) {
    const target = appTarget(app, platform);
    if (target !== null) found.push({ id: app.id, name: app.name, target });
  }
  return found;
}

export const detectEditors = (): FoundApp[] => detect(KNOWN_EDITORS);
export const detectTerminals = (): FoundApp[] => detect(KNOWN_TERMINALS);

/** Open a directory in an editor: no script, no shell dialect — an editor
 *  takes a directory and that is the whole interface. */
export async function openInEditor(dir: string, editor: string | null | undefined): Promise<void> {
  if (!isDir(dir)) throw DddError.notFound(`${dir} is not a directory`);
  const chosen = (editor ?? "").trim();
  if (chosen === "") throw DddError.config("no editor is configured — set one in Settings → Appearance");

  if (chosen.includes("{dir}")) {
    const [program, args] = templateParts(chosen, (part) => part.replaceAll("{dir}", dir), "empty editor template");
    await spawnDetached(program, args);
    return;
  }

  if (process.platform === "darwin") {
    await spawnDetached("open", ["-a", chosen, dir]);
    return;
  }
  try {
    await spawnDetached(chosen, [dir]);
  } catch (e) {
    // spawnDetached rejects with a DddError.io(cause), whose message is
    // "io: <cause>" — strip that prefix so the user sees the raw spawn
    // error (e.g. "spawn code ENOENT"), not "io: spawn code ENOENT".
    const message = e instanceof DddError && e.kind === "io" ? e.message.replace(/^io: /, "") : e instanceof Error ? e.message : String(e);
    throw DddError.config(`could not start ${chosen}: ${message}`);
  }
}
