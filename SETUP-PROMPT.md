# Setup prompt for Claude Code

Paste the entire contents of this file as your first message to a fresh Claude Code session. Claude will verify the hooks are wired, learn the pulse contract, and confirm it understands the orchestrator-emit-Goal-first rule.

---

I just installed Control Tower. From this point forward, every background agent you spawn must follow these rules:

## 1. Worktree isolation

Every Agent tool call must include `isolation: "worktree"`. This prevents parallel agents from clobbering each other's `parser.js` / `compiler.js` / shared-file edits. The `worktree-on-agent-spawn` hook will block any spawn missing this flag.

Opt-out: if the agent is genuinely read-only (pure exploration, no writes), include the marker `NO_WORKTREE` in the prompt. Use this sparingly.

## 2. Pulse contract

Every background agent must emit plain-English narrative progress events to `~/.claude/state/agent-pulse.log` (or `$AGENT_PULSE_HOME/agent-pulse.log` if set).

Format:

```
[<ISO timestamp>] [<Task Name>] Agent: <plain English status>
```

Example bash snippet to include in every agent brief:

```bash
PULSE=~/.claude/state/agent-pulse.log
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "[$ts] [<Task Name>] Agent: <status>" >> "$PULSE"
```

Cadence: every 2-3 tool calls, after each commit, on any problem, and at end of phase.

The `pulse-on-agent-activity` hook will block any Agent spawn whose prompt doesn't reference the pulse contract, `agent-pulse.log`, and checkpoint progress. The `pulse-enforcer-subagent` hook will block the subagent's stop if it didn't emit at least one pulse during its run.

Every background agent must also emit checkpoint signals:

```text
[<ISO timestamp>] [<Task Name>] Agent: Plan: <total checkpoints> - <3-7 concrete checkpoints in plain English>
[<ISO timestamp>] [<Task Name>] Agent: Progress: <current>/<total> - <checkpoint that just cleared>
```

Do not guess percent complete. Break the goal into checkpoints first, then
advance the checkpoint count as real work lands. If the work changes shape,
emit a new `Plan:` line with the new checkpoint truth.

## 3. Plain English — non-negotiable

Pulses are read on a dashboard by a human who doesn't have your source open. Every pulse must pass the 14-year-old test:

- **No function names** (`_askAI`, `parseHumanConfirm`, `compileToJSBackend`)
- **No file paths** (`parser.js:8682`, `compiler.js:598`)
- **No commit SHAs in the event body** ("the cycle-6.1 commit" instead of `705584c`)
- **No bare cycle numbers as the headline** (don't lead with "3.2 + 3.3 + 3.5 emit done"; lead with what those cycles DID)
- **No CS jargon** unless the audience already knows it

Before emitting each pulse, read the sentence aloud. Would someone who knows the project but isn't reading the source understand it? If no, rewrite.

## 4. Orchestrator emits Goal pulses

When YOU (the orchestrator) spawn a background agent, write a `Goal: <one-sentence plain English>` pulse to the log FIRST, before the agent starts. Format:

```bash
PULSE=~/.claude/state/agent-pulse.log
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "[$ts] [<Task Name>] Agent: Goal: <one-sentence plain English statement of what this agent is trying to accomplish and why it matters>." >> "$PULSE"
```

The dashboard reads the literal `Goal:` prefix and displays it at the top of the agent's section. Without an orchestrator-emitted Goal, the agent's first jargon-laden pulse leaks into the Goal slot.

## 4b. Agent emits checkpoint plans

Before the agent does real work, it must emit a checkpoint plan in plain
English. Ask it to break the goal into 3-7 concrete checkpoints, then emit
`Progress:` lines as those checkpoints clear.

## 5. Parallel by default

If a plan has multiple parallel-safe phases, spawn the agents in PARALLEL via worktree isolation. The `parallel-when-possible` hook will nudge if you're running 1 agent while 2+ parallel-safe items sit unstarted.

## Confirm you understand

Before doing any work, please reply with:

1. The path to the pulse log on this system
2. The exact format of a pulse event line (timestamp + task + agent line)
3. One example of a BAD pulse event and how you'd rewrite it
4. The opt-out marker that bypasses the worktree gate

Then we'll proceed with whatever I ask you to build.
