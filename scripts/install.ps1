# Control Tower - Windows PowerShell installer.
# Copies hooks into ~/.claude/hooks/, patches ~/.claude/settings.json
# (with a timestamped backup), and creates the pulse log directory.

$ErrorActionPreference = "Stop"

$RepoDir   = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"
$HooksDir  = Join-Path $ClaudeDir "hooks"
$StateDir  = Join-Path $ClaudeDir "state"
$Settings  = Join-Path $ClaudeDir "settings.json"

Write-Host "Control Tower installer"
Write-Host "  repo:     $RepoDir"
Write-Host "  target:   $ClaudeDir"
Write-Host ""

New-Item -ItemType Directory -Force -Path $HooksDir | Out-Null
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# 1. Copy hooks
$hooks = @(
  "worktree-on-agent-spawn.mjs",
  "pulse-on-agent-activity.mjs",
  "pulse-enforcer-subagent.mjs",
  "main-thread-pulse.mjs",
  "parallel-when-possible.mjs"
)
foreach ($hook in $hooks) {
  Copy-Item -Force (Join-Path $RepoDir "hooks\$hook") (Join-Path $HooksDir $hook)
  Write-Host "  installed hook: $hook"
}

# 2. Ensure pulse log exists
$pulseLog = Join-Path $StateDir "agent-pulse.log"
if (-not (Test-Path $pulseLog)) { New-Item -ItemType File -Path $pulseLog | Out-Null }
Write-Host "  pulse log:     $pulseLog"

# 3. Back up + patch settings.json
$snippet = @'
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
'@

if (Test-Path $Settings) {
  $ts = Get-Date -Format "yyyyMMdd-HHmmss"
  Copy-Item -Force $Settings "$Settings.bak-$ts"
  Write-Host "  backup:        $Settings.bak-$ts"
  Write-Host ""
  Write-Host "  WARNING: settings.json already exists. Did NOT overwrite."
  Write-Host "  Merge these hook entries into your existing settings.json:"
  Write-Host ""
  Write-Host $snippet
} else {
  Set-Content -Path $Settings -Value $snippet -Encoding UTF8
  Write-Host "  wrote:         $Settings"
}

Write-Host ""
Write-Host "Done. Start the dashboard with:"
Write-Host "  node $RepoDir\dashboard\server.cjs"
Write-Host "Then open http://localhost:9999"
