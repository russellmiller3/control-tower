#!/usr/bin/env bash
# Control Tower — macOS/Linux installer.
# Copies hooks into ~/.claude/hooks/, patches ~/.claude/settings.json
# (with a timestamped backup), and creates the pulse log directory.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_DIR="${HOME}/.claude"
HOOKS_DIR="${CLAUDE_DIR}/hooks"
STATE_DIR="${CLAUDE_DIR}/state"
SETTINGS="${CLAUDE_DIR}/settings.json"

echo "Control Tower installer"
echo "  repo:     ${REPO_DIR}"
echo "  target:   ${CLAUDE_DIR}"
echo ""

mkdir -p "${HOOKS_DIR}" "${STATE_DIR}"

# 1. Copy hooks
for hook in worktree-on-agent-spawn.mjs pulse-on-agent-activity.mjs pulse-enforcer-subagent.mjs main-thread-pulse.mjs parallel-when-possible.mjs; do
  cp "${REPO_DIR}/hooks/${hook}" "${HOOKS_DIR}/${hook}"
  echo "  installed hook: ${hook}"
done

# 2. Ensure pulse log exists
touch "${STATE_DIR}/agent-pulse.log"
echo "  pulse log:     ${STATE_DIR}/agent-pulse.log (exists)"

# 3. Back up existing settings.json + patch
if [ -f "${SETTINGS}" ]; then
  ts=$(date +%Y%m%d-%H%M%S)
  cp "${SETTINGS}" "${SETTINGS}.bak-${ts}"
  echo "  backup:        ${SETTINGS}.bak-${ts}"
fi

# Write a minimal settings.json that wires the hooks. If one already exists,
# the user should merge by hand — we don't try to be clever with JSON patching.
if [ ! -f "${SETTINGS}" ]; then
  cat > "${SETTINGS}" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Agent",
        "hooks": [
          { "type": "command", "command": "node ~/.claude/hooks/worktree-on-agent-spawn.mjs", "timeout": 4, "statusMessage": "Enforcing worktree isolation on Agent spawn..." },
          { "type": "command", "command": "node ~/.claude/hooks/pulse-on-agent-activity.mjs", "timeout": 6, "statusMessage": "Pulse contract gate + baseline emit..." }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Edit|MultiEdit|Write",
        "hooks": [
          { "type": "command", "command": "node ~/.claude/hooks/main-thread-pulse.mjs", "timeout": 4, "statusMessage": "Writing main-thread pulse..." }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node ~/.claude/hooks/pulse-on-agent-activity.mjs", "timeout": 6, "statusMessage": "Emitting pulse for active agents..." },
          { "type": "command", "command": "node ~/.claude/hooks/pulse-enforcer-subagent.mjs", "timeout": 4, "statusMessage": "Enforcing subagent pulse emission..." },
          { "type": "command", "command": "node ~/.claude/hooks/parallel-when-possible.mjs", "timeout": 4, "statusMessage": "Checking for missed parallelism..." }
        ]
      }
    ]
  }
}
EOF
  echo "  wrote:         ${SETTINGS}"
else
  echo ""
  echo "  WARNING: ~/.claude/settings.json already exists."
  echo "  Did NOT overwrite. Merge these hook entries into your existing settings.json:"
  echo ""
  cat "${REPO_DIR}/scripts/settings-snippet.json"
  echo ""
fi

echo ""
echo "Done. Start the dashboard with:"
echo "  node ${REPO_DIR}/dashboard/server.cjs"
echo "Then open http://localhost:9999"
