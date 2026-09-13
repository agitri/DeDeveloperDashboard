---
description: Write a checkpoint recap to .ddd/recap.md (the SessionEnd hook does this automatically at exit)
allowed-tools: Bash(git:*), Read, Write, Glob, Grep
---

Write a session checkpoint to `.ddd/recap.md` in the project root.

This is the mid-session twin of the SessionEnd hook. The hook guarantees a recap
always exists; this command replaces it with a better one, written while you
still have the full picture in context.

## What to do

1. Run `git status --porcelain` and `git log -5 --pretty='%h %s'` for the state.
2. Look back over this session: what was actually accomplished, what was started
   but not finished, what the obvious next move is.
3. Write `.ddd/recap.md` with exactly this shape:

```markdown
# Recap — <project name>

_Checkpoint <YYYY-MM-DD HH:MM> · branch `<branch>` · <n> uncommitted file(s)_

## What was done
- <concrete, specific, past tense — five lines at most>

## Unfinished
- <what is half-built, and where the seam is>

## Next steps
- <what the next session should pick up first>
```

## Rules

- Concrete over complete. "Wired the sync scheduler to the GitHub adapter; PR
  list renders but comments are stubbed" beats "worked on integrations".
- Name files and functions. This gets read cold, days later, by someone who has
  forgotten everything — which is you.
- Five lines per section, maximum. A recap nobody reads is worth nothing.
- Do not commit anything. Do not push. Just write the file.
