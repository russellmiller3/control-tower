# Agent Pulse Contract

Every background agent MUST emit narrative progress events to `programming/.claude/state/agent-pulse.log` so Russell sees what they're doing without polling git or asking "?". This file is the contract. Every agent brief includes a copy of it.

## Format (exact)

Append one line per event. Format:

```
[<ISO-timestamp>] [<TASK NAME>] Agent: <plain English status>
```

**ORCHESTRATOR RULE:** before spawning any background agent, the orchestrator (me) writes a Goal pulse FIRST in plain English:

```
[<ISO-timestamp>] [<TASK NAME>] Agent: Goal: <one-sentence plain English statement of what this agent is trying to accomplish, why it matters, no jargon, no function names, no SHAs>.
```

The watcher reads the literal `Goal:` prefix as the highest-priority signal and displays it at the top of the agent's section. Without an orchestrator-emitted Goal pulse, agents' own jargon-laden first pulse leaks into the Goal slot and Russell sees gibberish.

**CHECKPOINT RULE:** every background agent must emit a checkpoint plan before
real work starts, then emit checkpoint progress as it clears those steps.

```
[<ISO-timestamp>] [<TASK NAME>] Agent: Plan: 4 checkpoints - parser cases, Windows paths, smoke test, docs.
[<ISO-timestamp>] [<TASK NAME>] Agent: Progress: 1/4 - Wrote the failing malformed-config test.
[<ISO-timestamp>] [<TASK NAME>] Agent: Progress: 2/4 - Parser cases are green and Windows path checks are passing.
```

The dashboard treats this as **checkpoint progress**, not omniscient truth.
It means "how much of the declared plan is done," which is honest and useful.
If the work changes shape, emit a new `Plan:` line and keep going from the new
truth.

- `<ISO-timestamp>` — `new Date().toISOString()`, looks like `2026-05-13T15:34:08Z`
- `<TASK NAME>` — the phase or epic the agent is working on. Examples: `Phase 3`, `Phase 5.5`, `Import keyword rename`, `Lenat-clear Phase 8`.
- Plain English status — what the agent is actively DOING, in 14-year-old language. No tool names, no file paths unless they aid understanding, no jargon. Past + present + next-step.
- Checkpoint plan — break the goal into **3-7 concrete checkpoints**. Not
  generic filler unless that is genuinely the task.
- Checkpoint progress — `Progress: current/total - what just cleared`.

## PLAIN ENGLISH — non-negotiable (Russell's rule, 2026-05-13)

Pulse events go straight to a dashboard Russell reads ambient. He has ADHD + Mito and cannot afford to translate jargon. Every pulse must pass the 14-year-old test:

- **No function names.** Not `_askAI`, `parseHumanConfirm`, `compileToJSBackend`.
- **No file paths.** Not `parser.js:8682`, `compiler.js:598`.
- **No SHAs.** Not `705584c`, `f8c3059`. (If naming a milestone, say "the cycle-6.1 commit" not the SHA.)
- **No bare cycle numbers without context.** Not `3.2 + 3.3 + 3.5 emit done`. Instead: "The compiler now emits the new graduation code in 3 places. The 4th is the validator check, working on it now."
- **No test-count noise as the goal.** Not "3109 pass, 11 fail." Use it as a one-line status update inside a sentence, not the headline.
- **No CS jargon.** No "async generator", "AST node", "coroutine", "emit path", "dispatch table" unless the audience already knows them — and the audience here is Russell, who reads but isn't writing compiler code in his head.

**The test before emitting a pulse:** read the line out loud and ask "would this make sense to someone who knows the project but isn't reading the source right now?" If no, rewrite.

## Example events (good — plain English)

```
[2026-05-13T15:30:11Z] [Phase 3] Agent: Looking at the existing approval prompt code so I can extend it for graduation.
[2026-05-13T15:31:02Z] [Phase 3] Agent: Plan: 4 checkpoints - understand the existing flow, write the failing test, make the change, prove it end to end.
[2026-05-13T15:34:08Z] [Phase 3] Agent: Wrote the failing test — first 3 calls ask the user, 4th auto-runs. Implementing now.
[2026-05-13T15:34:09Z] [Phase 3] Agent: Progress: 1/4 - Wrote the failing test for the approval counter.
[2026-05-13T15:36:42Z] [Phase 3] Agent: Hit a bug — the counter went up on rejections too. Rolling back to fix it.
[2026-05-13T15:38:15Z] [Phase 3] Agent: First cycle green. 5 new tests. Starting on the compiler side next.
[2026-05-13T15:38:16Z] [Phase 3] Agent: Progress: 2/4 - The compiler side is green now.
[2026-05-13T15:42:01Z] [Phase 3] Agent: Blocked — the new audit shape conflicts with the existing approval-queue audit. Going with two separate tables.
```

## Example events (BAD — do not write like this)

```
[Phase 3] Agent: parser.js read complete, beginning HUMAN_CONFIRM extension                           # function name jargon
[Phase 3] Agent: parseHumanConfirm() now accepts graduation metadata via _grade flag                   # function names, jargon-heavy
[Phase 3] Agent: 3.2 + 3.3 + 3.5 emit done — pre-commit blocked by 3.4 validator failures             # cycle numbers as the message
[Phase 3] Agent: working                                                                                # useless
[Phase 3] Agent: Plan: 12 checkpoints - think, code, more code, more code, more code                  # too many vague checkpoints
[Phase 3] Agent: Progress: 80%                                                                          # guessed percent, not declared checkpoints
[Phase 3] Agent: _askAI lives at compiler.js:598 (JS Node), _askAI_workers at 1041, _askAIStream at 708 # function names + file paths + line numbers
[Phase 3] Agent: Baseline check done — 3109 pass, 11 fail. Starting cycle 6.1 parser for 'ai provider' # stat-line goal extracted as headline
[Phase 3] Agent: Surveyed compiler — _askAI lives at compiler.js:598. Next: find Python ask_ai helper   # file paths + function names
```

## Translation cheatsheet

| Don't write | Write |
|---|---|
| `parser.js:8682` | "in the parser, near where we handle display blocks" |
| `_askAI` | "the function that calls the LLM" |
| `HUMAN_CONFIRM emit path` | "the code that writes out the approval prompt" |
| `cycle 3.2 GREEN` | "the compiler side is green now" |
| `3109 pass, 11 fail` | (don't lead with this — it's a stat, not a status) |
| `parseDisplay shorthand (lines 8076-8115)` | "the shorthand the parser handles for `display X as ...`" |
| `f8c3059` | "the parser-side commit from earlier this run" |

## When to emit

- **Before real work starts** — emit `Plan: N checkpoints - ...`
- **At start of each TDD cycle** ("Starting cycle X.N — about to write the failing test for Y.")
- **After each commit** ("X.N green. <test count delta>. Moving to X.N+1.")
- **Whenever a checkpoint clears** — emit `Progress: current/total - ...`
- **At any branch in reasoning** — when you hit a fork ("Two ways to handle this. Going with B because Z.").
- **When you hit a problem** — describe the problem and the fix. ("Hit X failure. Cause is Y. Rolling back the bad commit and trying Z.")
- **When you're blocked** — describe the blocker + what you tried + what would unblock you.
- **At end of phase** — single summary event.

Rough cadence: every 2-3 tool calls OR every commit, whichever is sooner. Don't spam every micro-action; don't go silent for 10 minutes either.

## How to emit (JavaScript)

```js
import { appendFileSync } from 'node:fs';
const PULSE = 'C:/Users/rmill/Desktop/programming/.claude/state/agent-pulse.log';
function pulse(taskName, status) {
  const iso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  appendFileSync(PULSE, `[${iso}] [${taskName}] Agent: ${status}\n`);
}

// Then in your code:
pulse('Phase 3', 'Reading parser.js to find HUMAN_CONFIRM emit path.');
```

## How to emit (Bash)

```bash
PULSE=/c/Users/rmill/Desktop/programming/.claude/state/agent-pulse.log
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "[$ts] [Phase 3] Agent: Wrote failing test for graduation counter. Implementing now." >> "$PULSE"
```

## Why this matters

Russell can't see your transcript. Without pulses, he has to ping "?" and wait for me to run git log. With pulses, every 2-3 tool calls he sees what you're actually doing in plain English. The pulse hook surfaces these to him automatically when commits land or every 5 minutes — but the hook can only show what YOU wrote. Silent agents = silent UI.

## Failure mode if you forget

The pulse hook falls back to git activity (commits + diff stats). That's a worse signal because it only fires on commits and doesn't explain blockers. Russell flagged this as a problem 2026-05-13: "I want to see what the agent is doing, not just commit messages." Emit pulses.
