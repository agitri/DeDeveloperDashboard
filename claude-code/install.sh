#!/usr/bin/env sh
# Installs the DDD ↔ Claude Code contract:
#
#   ddd-todo / ddd-recap  →  ~/.local/bin
#   /todo, /wrapup        →  ~/.claude/commands
#   SessionEnd hook       →  ~/.claude/settings.json
#
# Everything is idempotent, and settings.json is backed up before it is touched.

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
BIN_DIR="${HOME}/.local/bin"
CLAUDE_DIR="${HOME}/.claude"

echo "→ installing helpers into ${BIN_DIR}"
mkdir -p "${BIN_DIR}"
ln -sf "${HERE}/bin/ddd-todo" "${BIN_DIR}/ddd-todo"
ln -sf "${HERE}/bin/ddd-recap" "${BIN_DIR}/ddd-recap"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "  ! ${BIN_DIR} is not on your PATH — add it, or /todo will not resolve" ;;
esac

echo "→ installing slash commands into ${CLAUDE_DIR}/commands"
mkdir -p "${CLAUDE_DIR}/commands"
cp "${HERE}/commands/todo.md" "${CLAUDE_DIR}/commands/todo.md"
cp "${HERE}/commands/wrapup.md" "${CLAUDE_DIR}/commands/wrapup.md"

echo "→ registering the SessionEnd hook in ${CLAUDE_DIR}/settings.json"
HOOK_CMD="${BIN_DIR}/ddd-recap" python3 - "${CLAUDE_DIR}/settings.json" <<'PY'
import json, os, shutil, sys

path = sys.argv[1]
command = os.environ["HOOK_CMD"]

settings = {}
if os.path.exists(path):
    shutil.copyfile(path, path + ".ddd-backup")
    with open(path) as fh:
        text = fh.read().strip()
    settings = json.loads(text) if text else {}

hooks = settings.setdefault("hooks", {})
entries = hooks.setdefault("SessionEnd", [])

already = any(
    h.get("command") == command
    for entry in entries
    for h in entry.get("hooks", [])
)
if already:
    print("  already registered")
else:
    entries.append({"hooks": [{"type": "command", "command": command}]})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(settings, fh, indent=2)
        fh.write("\n")
    print("  added (previous file saved as settings.json.ddd-backup)")
PY

cat <<'EOF'

Done. In any project you want DDD to track:

    mkdir -p .ddd            # the opt-in — no .ddd folder, no recap written
    /todo something to remember
    # …and every session exit now leaves .ddd/recap.md behind

Set DDD_RECAP_AI=1 in your environment for a model-written recap instead of the
deterministic one (costs tokens, adds a few seconds to session exit).
EOF
