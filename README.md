# Agent Rescue Board

A local rescue board for parallel Codex and Claude agents.

When you spawn multiple agents in parallel, the expensive failure mode is not "I lack charts." It is "I lost track of which agent is stuck." Agent Rescue Board finds the agent most likely to be stalled, explains why, and gives you a Supervisor action to inspect it before it burns context, money, or momentum.

![Agent Rescue Board preview](./preview.png)

## What you get

- **Rescue-first web board at `localhost:9999`** — rescue queue, run health, agent cards, and detail inspector
- **Rescue Queue** — ranks agents that are silent, dormant, or showing problem signals
- **Rescue Inspector** — click an agent to see its goal, timeline, diagnosis, and recovery actions
- **Supervisor inspect button** — writes a plain-English check request back to the right pulse log
- **Codex + Claude source detection** — watches Windows-friendly `.codex` and `.claude` state paths automatically
- **Light + nixie dark themes** — use the toggle or `?theme=light` / `?theme=dark` for screenshots
- **Static screenshot mode** — add `?static=1` so portfolio captures do not wait on the live event stream
- **Recent commits sidebar** — live `git log` of the active branch
- **Live SSE feed plus first-paint hydration** — events stream live, and screenshots render populated immediately
- **Terminal watcher** as a fallback — `pulse-watch.cjs` does the same thing in a terminal window for headless use
- **4 hooks** that make agent control structural rather than discipline-based:
  - **`worktree-on-agent-spawn`** — refuses to spawn an agent without `isolation: "worktree"` (forces parallel-safe isolation)
  - **`pulse-on-agent-activity`** — gates spawns on a pulse-contract reference + auto-emits a baseline pulse + throttles ambient updates to your replies
  - **`pulse-enforcer-subagent`** — refuses to let a subagent stop without emitting at least one narrative pulse
  - **`parallel-when-possible`** — if 1 agent is in flight while 2+ parallel-safe phases sit unstarted, nudges the orchestrator to spawn the rest

## Why this exists

Parallel coding agents are powerful, but they are easy to lose track of.

One agent may be writing tests, another may be fixing docs, and another may
have gone quiet after touching risky code. Agent Rescue Board gives you one
place to see the live work and spot the run that needs help.

The goal is simple:

- Keep working agents visible.
- Put stalled agents at the top.
- Preserve the goal and latest activity.
- Send a Supervisor inspection request without hunting through logs.

## How it works (30 seconds)

1. Agents append plain-English progress events to a shared log file: `~/.claude/state/agent-pulse.log`. One line per event, format:
   ```
   [2026-05-13T15:34:08Z] [Phase 3] Agent: Wrote the failing test — first 3 calls ask the user, 4th auto-runs. Implementing now.
   ```
2. The dashboard server tails that file and pushes events to your browser via SSE.
3. The hooks make agents actually write pulses (refuse spawn or stop otherwise).
4. You watch your browser tab. No polling. No "let me check status" round-trips.

## Quick start

### Install (one minute)

```bash
git clone <wherever you got this> agent-dashboard
cd agent-dashboard
./scripts/install.sh         # macOS / Linux
# or
./scripts/install.ps1        # Windows PowerShell
```

The installer:
1. Copies the 4 hook files into `~/.claude/hooks/`
2. Patches `~/.claude/settings.json` to wire them up (with a `.bak` backup of the original)
3. Creates `~/.claude/state/agent-pulse.log` if it doesn't exist

### Run the dashboard

```bash
node dashboard/server.cjs
```

Open `http://localhost:9999` in your browser. Leave the tab open.

Optional environment variables:

```powershell
$env:AGENT_DASHBOARD_PORT="9999"
$env:AGENT_DASHBOARD_REPO="C:\Users\rmill\Desktop\programming\clear"
$env:AGENT_PULSE_LOG="C:\path\to\agent-pulse.log"
node dashboard/server.cjs
```

By default the server watches:
- `%USERPROFILE%\.codex\state\agent-pulse.log`
- `%USERPROFILE%\.claude\state\agent-pulse.log`
- `.\agent-pulse.log`

That means the dashboard works on Windows with Codex as soon as Codex, a hook, or a harness writes the same pulse format.

### Use it with Claude Code

In a fresh Claude Code session, paste the contents of `SETUP-PROMPT.md` as your first message. Claude will:
- Verify the hooks are wired
- Read the pulse contract
- Confirm it understands the orchestrator-emit-Goal-first rule

Then ask Claude to do anything that involves background agents. The hooks enforce the rest.

### Use it with Codex, Claude Cowork, or other agent tools

The bundled hook layer is Claude Code-specific today, but the dashboard works with **any** agent system that can append to an agent pulse log in the expected format. For Codex or Cowork:

1. Skip the Claude hook installer step unless you are using Claude Code.
2. Run the dashboard server.
3. Have the agent, hook, or harness append events to one of the watched pulse logs. Format:
   ```
   [<ISO timestamp>] [<task name>] Agent: <plain English status>
   ```
4. Same dashboard, same view.

The dashboard is platform-agnostic by design. The hooks are the accelerator, not the dependency.

## What "plain English" means

The dashboard reads the agent's events directly to you. If your agent writes `parseHumanConfirm() now accepts graduation metadata via _grade flag` you'll see exactly that. To make the dashboard valuable, agents need to emit **plain-English narrative**, not jargon.

The pulse contract enforces this:
- No function names (`_askAI`, `parseHumanConfirm`)
- No file paths (`parser.js:8682`)
- No commit SHAs in event bodies
- No bare cycle numbers as the headline
- 14-year-old test: would someone who isn't reading the source understand?

Full rules + examples in `AGENT-PULSE-CONTRACT.md`.

## Files in this repo

```
agent-dashboard/
├── README.md                       ← you are here
├── SETUP-PROMPT.md                 ← paste into Claude Code to wire it up
├── AGENT-PULSE-CONTRACT.md         ← format spec for agents
├── LICENSE.md                      ← Fair Source: free personal, paid commercial
├── dashboard/
│   ├── server.cjs                  ← Node HTTP + SSE server, port 9999, zero deps
│   └── index.html                  ← single-file UI, Lucide icons, dark mode
├── hooks/
│   ├── worktree-on-agent-spawn.mjs ← refuses unisolated agent spawns
│   ├── pulse-on-agent-activity.mjs ← gates spawn + ambient pulse emission
│   ├── pulse-enforcer-subagent.mjs ← refuses silent agent stops
│   └── parallel-when-possible.mjs  ← nudges toward parallel agent dispatch
├── scripts/
    ├── install.sh                  ← macOS / Linux installer
    ├── install.ps1                 ← Windows PowerShell installer
    └── pulse-watch.cjs             ← terminal-based alternative to the web UI
```

## Licensing & pricing

**Free for personal use.** Indie projects, learning, hobby work, your own toolchain — go nuts.

**Commercial use requires a license.** If you or your company uses this dashboard for work that generates revenue, you need a commercial license:

- **Solo / freelance** (you work for yourself, < $1M ARR): **free** — same as personal
- **Team** (1-50 seats, employer-paid): **$8 per seat per month** — covers small teams that want to coordinate Claude Code work across multiple agents
- **Enterprise** (50+ seats, audit logs, SSO, on-prem): **contact for pricing**

Email **rmiller@zavient.com** to license commercial use.

Why this model: this dashboard is the kind of thing a solo dev would gladly build for themselves, but engineering teams running multiple Claude agents in coordinated workflows get real production-grade value from it — they can afford to pay. Fair Source license keeps the personal-use door wide open while making the commercial track honest.

See `LICENSE.md` for the formal license text.

## Built by

**Russell Miller** — [rmiller@zavient.com](mailto:rmiller@zavient.com) · [LinkedIn](https://www.linkedin.com/in/russellmiller) · [GitHub](https://github.com/russellmiller3)

If this saves you time, tell people. Pull requests welcome.
