#!/usr/bin/env node
/**
 * pulse-enforcer-subagent — fires inside background-agent sessions to
 * REFUSE the stop if the agent hasn't emitted any narrative pulse during
 * this run. Forces every subagent to drop at least one summary pulse
 * describing what it did before completion.
 *
 * Detection: subagents have a transcript_path under the temp directory
 * (Windows: %LOCALAPPDATA%\Temp\claude\.../tasks/<agent-id>.output).
 * Parent sessions have transcripts in ~/.claude/projects/. We only fire
 * when the path looks like a subagent.
 *
 * If the agent emitted at least one pulse in agent-pulse.log within the
 * last hour, allow stop. Otherwise block with a reminder.
 *
 * Russell's rule (added 2026-05-13): every background agent must emit
 * plain-English narrative progress events to agent-pulse.log so he sees
 * what they're doing without polling. The PreToolUse gate ensures the
 * brief includes the contract; this Stop hook ensures the agent actually
 * honored it.
 *
 * Fail-open on any unexpected error — never permanently trap a subagent.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const PULSE_LOG = resolve(homedir(), 'Desktop', 'programming', '.claude', 'state', 'agent-pulse.log');
const RECENCY_MS = 60 * 60 * 1000; // pulse must have been written within last hour

function isSubagentTranscript(transcriptPath) {
  if (!transcriptPath) return false;
  const normalized = transcriptPath.replace(/\\/g, '/').toLowerCase();
  // Subagent transcripts live under <temp>/claude/.../tasks/<id>.output
  return /\/tasks\//.test(normalized) && /\.output$/.test(normalized);
}

function pulseLogHasRecentCheckpointEntry() {
  if (!existsSync(PULSE_LOG)) return false;
  try {
    const stat = statSync(PULSE_LOG);
    if (Date.now() - stat.mtimeMs > RECENCY_MS) return false;
    const raw = readFileSync(PULSE_LOG, 'utf8');
    return /Agent:\s*(?:Plan|Replan|Progress):/i.test(raw);
  } catch {
    return false;
  }
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }

  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'Stop') {
    process.exit(0);
    return;
  }

  // Only fire inside subagents — parent sessions are exempt
  if (!isSubagentTranscript(event.transcript_path || '')) {
    process.exit(0);
    return;
  }

  // Prevent infinite re-blocking
  if (event.stop_hook_active) {
    process.exit(0);
    return;
  }

  if (pulseLogHasRecentCheckpointEntry()) {
    process.exit(0);
    return;
  }

  // Block — agent hasn't emitted any pulse in this run
  const reason = `STOP BLOCKED — you (the background subagent) did not emit a single narrative checkpoint pulse during this run.

Russell's rule: every background agent must emit plain-English progress events to programming/.claude/state/agent-pulse.log so he sees what you did without polling git.

Before completing, append:
1. a Plan: <total checkpoints> - ... pulse if you never emitted one
2. a Progress: <current>/<total> - ... pulse describing the checkpoint you just cleared

Use this format:

[<ISO timestamp>] [<TASK NAME from your brief>] Agent: Plan: 4 checkpoints - parser pass, implementation, smoke test, docs
[<ISO timestamp>] [<TASK NAME from your brief>] Agent: Progress: 1/4 - Wrote the failing test and confirmed the bug

How (bash):
  PULSE=/c/Users/rmill/Desktop/programming/.claude/state/agent-pulse.log
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "[$ts] [<TASK NAME>] Agent: Plan: 4 checkpoints - parser pass, implementation, smoke test, docs" >> "$PULSE"
  echo "[$ts] [<TASK NAME>] Agent: Progress: 1/4 - Wrote the failing test and confirmed the bug" >> "$PULSE"

How (Node):
  import { appendFileSync } from 'node:fs';
  const PULSE = '/c/Users/rmill/Desktop/programming/.claude/state/agent-pulse.log';
  const ts = new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z');
  appendFileSync(PULSE, '[' + ts + '] [<TASK NAME>] Agent: Plan: 4 checkpoints - parser pass, implementation, smoke test, docs\\n');
  appendFileSync(PULSE, '[' + ts + '] [<TASK NAME>] Agent: Progress: 1/4 - Wrote the failing test and confirmed the bug\\n');

Then try to stop again. The hook will check for the entry and allow stop on the second pass.`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

main();
