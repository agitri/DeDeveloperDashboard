import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_EDITORS, KNOWN_TERMINALS, MAC_APP_ROOTS, detect, detectEditors, detectTerminals, launch, linuxCandidates, openInEditor, resolveTerminal, shellQuote, splitTemplate, writeLaunchScript } from "./launcher";

const tempdir = () => mkdtempSync(join(tmpdir(), "ddd-launcher-test-"));

async function waitFor(path: string): Promise<void> {
  for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 20));
}

describe("terminal preference", () => {
  it("project wins over environment, blanks do not count", () => {
    expect(resolveTerminal("iTerm", "Terminal")).toBe("iTerm");
    expect(resolveTerminal(null, " Terminal ")).toBe("Terminal");
    expect(resolveTerminal("  ", null)).toBeNull();
    expect(resolveTerminal(null, null)).toBeNull();
  });
});

describe("the launch script", () => {
  it("quotes paths containing apostrophes", () => {
    // `~/Projects/Rene's stuff` is a perfectly ordinary directory name and
    // must not be able to break out of the generated script.
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("Rene's")).toBe("'Rene'\\''s'");
    expect(shellQuote("a b")).toBe("'a b'");
  });

  it("splits templates on whitespace honouring quotes", () => {
    expect(splitTemplate("wezterm start --cwd {dir} -- {cmd}")).toEqual(["wezterm", "start", "--cwd", "{dir}", "--", "{cmd}"]);
    expect(splitTemplate('term -e "claude --continue"')).toEqual(["term", "-e", "claude --continue"]);
  });

  it("lands in the directory and leaves a shell behind", () => {
    const dir = tmpdir();
    const path = writeLaunchScript(dir, "claude");
    const body = readFileSync(path, "utf8");
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    expect(body).toContain(`cd ${shellQuote(dir)}`);
    expect(body).toContain("\nclaude\n");
    // Without this the window would slam shut on whatever Claude printed.
    expect(body).toContain('exec "${SHELL:-/bin/sh}" -l');
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o755);
    rmSync(path);
  });
});

describe("linux candidate list", () => {
  it("an empty-string terminal preference is tried on its own, not treated as unset", () => {
    expect(linuxCandidates("", undefined)).toEqual([""]);
  });

  it("no preference falls back to $TERMINAL then the usual suspects", () => {
    expect(linuxCandidates(null, "foot").slice(0, 2)).toEqual(["foot", "x-terminal-emulator"]);
    const defaults = linuxCandidates(null, undefined);
    expect(defaults[0]).toBe("x-terminal-emulator");
    expect(defaults[defaults.length - 1]).toBe("xterm");
  });

  it("a configured terminal wins outright, ignoring $TERMINAL", () => {
    expect(linuxCandidates("kitty", "foot")).toEqual(["kitty"]);
  });
});

describe("launching", () => {
  it("the template branch substitutes and spawns", async () => {
    // Exercises the full template path — the one Linux and Windows users fall
    // back to — without opening a window.
    const dir = tempdir();
    const proof = join(dir, "proof.txt");
    await launch(dir, `/bin/sh -c "echo {cmd} > ${proof}"`, "launched-ok");
    await waitFor(proof);
    expect(readFileSync(proof, "utf8").trim()).toBe("launched-ok");
    rmSync(dir, { recursive: true });
  });

  it("refuses a directory that is not there", async () => {
    const missing = join(tmpdir(), "ddd-definitely-not-here");
    await expect(launch(missing, null, "claude")).rejects.toThrow(`${missing} is not a directory`);
  });

});

describe("opening an editor", () => {
  it("refuses with no editor configured, pointing at Settings", async () => {
    // Silence, or a guessed default, would be worse: the user clicked a
    // button and nothing would happen with no way to find out why.
    await expect(openInEditor(tmpdir(), null)).rejects.toThrow(/Settings/);
    await expect(openInEditor(tmpdir(), "   ")).rejects.toThrow(/Settings/);
  });

  it("refuses a directory that is not there", async () => {
    const missing = join(tmpdir(), "ddd-editor-definitely-not-here");
    await expect(openInEditor(missing, "code")).rejects.toThrow(`${missing} is not a directory`);
  });

  it("an editor template substitutes the directory and spawns", async () => {
    const dir = tempdir();
    const proof = join(dir, "editor-proof.txt");
    await openInEditor(dir, `/bin/sh -c "echo {dir} > ${proof}"`);
    await waitFor(proof);
    expect(readFileSync(proof, "utf8").trim()).toBe(dir);
    rmSync(dir, { recursive: true });
  });

  // macOS never reaches the raw-spawn branch for a non-template editor name
  // (it goes through `open -a`, which must never run in a test), so this only
  // exercises the "unwrap the DddError.io cause" branch off-macOS.
  it.skipIf(process.platform === "darwin")("unwraps the inner spawn error instead of double-wrapping it", async () => {
    await expect(openInEditor(tmpdir(), "ddd-definitely-not-a-real-editor")).rejects.toThrow(
      "could not start ddd-definitely-not-a-real-editor: spawn ddd-definitely-not-a-real-editor ENOENT",
    );
  });
});

describe("the app catalogs", () => {
  it("have unique ids", () => {
    for (const catalog of [KNOWN_EDITORS, KNOWN_TERMINALS]) {
      const ids = catalog.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("every entry is findable on some platform", () => {
    // An entry with neither a bundle nor a CLI can never be detected anywhere,
    // which makes it a typo rather than a catalog row.
    for (const app of [...KNOWN_EDITORS, ...KNOWN_TERMINALS]) {
      expect(app.bundle !== "" || app.cli !== "", app.name).toBe(true);
    }
  });

  it("detection never throws and returns only catalog entries", () => {
    for (const [catalog, found] of [[KNOWN_EDITORS, detectEditors()], [KNOWN_TERMINALS, detectTerminals()]] as const) {
      for (const app of found) {
        expect(catalog.some((k) => k.id === app.id), app.id).toBe(true);
        expect(app.target).not.toBe("");
      }
    }
  });

  it("on macOS the target is the bundle name and the bundle is present", () => {
    if (process.platform !== "darwin") return;
    for (const app of detect([...KNOWN_EDITORS, ...KNOWN_TERMINALS], "darwin")) {
      const known = [...KNOWN_EDITORS, ...KNOWN_TERMINALS].find((k) => k.id === app.id)!;
      expect(app.target).toBe(known.bundle);
      expect(MAC_APP_ROOTS.some((root) => existsSync(join(root, `${known.bundle}.app`)))).toBe(true);
    }
    // Terminal.app ships with every Mac.
    expect(detectTerminals().some((a) => a.id === "terminal")).toBe(true);
  });

  it("off macOS, an app with no CLI is never offered", () => {
    expect(detect([{ id: "x", name: "X", bundle: "X", cli: "" }], "linux")).toEqual([]);
  });
});
