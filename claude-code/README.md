# DDD ↔ Claude Code integration

Two small pieces of plumbing that let Claude Code, while it works inside a
project, leave things behind for DDD's UI to pick up.

- **`/todo <what needs doing>`** — captures a one-line todo into
  `<project>/.ddd/todos.json`. This is the file the Todo widget reads.
- **SessionEnd hook** — runs automatically when a Claude Code session ends
  and writes `<project>/.ddd/recap.md`: what was asked, what files were
  touched, and where git ended up. This is the file the recap surface reads.
  Run `/wrapup` mid-session to replace the automatic recap with a fuller,
  model-written checkpoint before the session ends.

Both only ever act on a project that has opted in by having a `.ddd/`
directory — no `.ddd/` folder, no recap written.

## Installing

```sh
./install.sh
```

This symlinks `bin/ddd-todo` and `bin/ddd-recap` into `~/.local/bin`, copies
`commands/todo.md` and `commands/wrapup.md` into `~/.claude/commands`, and
registers the SessionEnd hook in `~/.claude/settings.json` (backing up the
existing file first, and skipping registration if the hook is already
present).

## Shared with the Rust app

These files are byte-for-byte identical to the ones at `../DDD/claude-code/`
— they are path-agnostic and know nothing about which app installed them.
Running `install.sh` once serves both DDD (Rust/Tauri) and nodeDDD
(Electron): whichever one is open, `/todo` and the recap hook write into
the same `<project>/.ddd/` files that either app's UI can read.
