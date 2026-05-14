# Control Tower Setup

Use this skill when someone asks Claude or Codex to install Control Tower,
wire the hooks, create a Windows desktop shortcut, or verify the local
dashboard setup.

## What This Installs

- The Control Tower web server at `http://127.0.0.1:9999`.
- Five Claude Code hooks that make agents emit plain-English progress pulses.
- Hook-enforced checkpoint plans and `current/total` progress pulses per agent.
- A shared pulse log at `~/.claude/state/agent-pulse.log`.
- A Windows desktop + taskbar shortcut named `Control Tower`.

## Windows One-Click Path

From the repo root, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\Install Agent Dashboard.ps1"
```

For a double-clickable install, use:

```powershell
.\Install Agent Dashboard.cmd
```

That wrapper runs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\create-desktop-shortcut.ps1"
```

## Manual Windows Path

Use this when the user wants to see each step:

Portable file names: `scripts/install.ps1`, `scripts/create-desktop-shortcut.ps1`,
and `scripts/launch-agent-dashboard.ps1`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\create-desktop-shortcut.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\launch-agent-dashboard.ps1"
```

Then open:

```text
http://127.0.0.1:9999
```

## macOS / Linux Path

```bash
./scripts/install.sh
node dashboard/server.cjs
```

Then open:

```text
http://127.0.0.1:9999
```

## Verify

Run the test suite:

```powershell
node --test dashboard\server.test.cjs
```

Check the demo preview:

```text
http://127.0.0.1:9999/?demo=1
```

The demo must show:

- Hook-enforced updates.
- Three working agents.
- One agent needing rescue.
- Checkpoint progress on each visible agent tile.
- Tokens and cost per agent.
- Russell Miller contact details in the lower-right footer.
- The Control Tower icon in the browser tab.

## Pulse Format

Any agent system can write to the dashboard if it appends lines like this:

```text
[2026-05-14T14:32:00Z] [Parser tests] Agent: Running malformed config cases. Tokens: 22,600. Cost: $0.71.
```

The dashboard watches Codex and Claude state paths by default. Claude Code gets
the strongest setup because the bundled hooks enforce the pulse contract.
