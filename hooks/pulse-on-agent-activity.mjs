#!/usr/bin/env node
/**
 * Pulse hook — surfaces background-agent progress to Russell automatically,
 * but THROTTLED so it doesn't dump a pulse on every short reply.
 *
 * Fires on two events:
 *   1. PreToolUse(Agent)  — when Claude spawns a new subagent, always run
 *                           pulse so Russell sees baseline at spawn.
 *   2. Stop                — IF any agent is still running AND something has
 *                           CHANGED since the last pulse (new commit OR
 *                           5+ minutes elapsed), emit pulse; otherwise stay
 *                           silent. Russell sees pulses on genuine activity
 *                           events, not on every assistant turn.
 *
 * State file: ~/.claude/state/last-pulse.json — { last_emitted_at, last_sha }
 *
 * Throttle rules (Stop event only — PreToolUse always fires):
 *   - Emit IF the top commit SHA on feature/lenat-in-clear has changed since
 *     last pulse (a new cycle landed).
 *   - Emit IF 5+ minutes have elapsed since last pulse (heartbeat for stall
 *     detection — even without new commits, every 5 min Russell sees state).
 *   - Otherwise stay silent.
 *
 * Fail-open on any unexpected error — never permanently block CC.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

const PULSE_SCRIPT = resolve(homedir(), 'Desktop', 'programming', '.claude', 'state', 'pulse.cjs');
const PULSE_LOG = resolve(homedir(), 'Desktop', 'programming', '.claude', 'state', 'agent-pulse.log');
const STATE_FILE = resolve(homedir(), '.claude', 'state', 'last-pulse.json');
const CLEAR_REPO = resolve(homedir(), 'Desktop', 'programming', 'clear');
const HEARTBEAT_MS = 5 * 60 * 1000;

function runPulse() {
  if (!existsSync(PULSE_SCRIPT)) return null;
  const result = spawnSync('node', [PULSE_SCRIPT], { encoding: 'utf8', shell: false, timeout: 4000 });
  if (result.error || result.status !== 0) return null;
  const out = (result.stdout || '').trim();
  if (!out) return null;
  return out;
}

function currentTopSha() {
  const result = spawnSync('git', ['log', '-1', '--format=%H', 'feature/lenat-in-clear'], {
    cwd: CLEAR_REPO,
    encoding: 'utf8',
    shell: false,
    timeout: 2000,
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').trim() || null;
}

function readState() {
  if (!existsSync(STATE_FILE)) return { last_emitted_at: 0, last_sha: '', last_pulse_log_lines: 0 };
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      last_emitted_at: typeof data.last_emitted_at === 'number' ? data.last_emitted_at : 0,
      last_sha: typeof data.last_sha === 'string' ? data.last_sha : '',
      last_pulse_log_lines: typeof data.last_pulse_log_lines === 'number' ? data.last_pulse_log_lines : 0,
    };
  } catch {
    return { last_emitted_at: 0, last_sha: '', last_pulse_log_lines: 0 };
  }
}

function currentPulseLogLines() {
  if (!existsSync(PULSE_LOG)) return 0;
  try {
    const raw = readFileSync(PULSE_LOG, 'utf8');
    return raw.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function writeState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // fail open — state-file write failure shouldn't break the hook
  }
}

/**
 * Returns the REASON to emit a pulse, or null to stay silent.
 * Reasons: "new commit", "new narrative event", "heartbeat 5min", or null.
 */
function shouldEmit(state) {
  const now = Date.now();
  const topSha = currentTopSha();
  const pulseLogLines = currentPulseLogLines();

  if (topSha && topSha !== state.last_sha) {
    return { reason: 'new commit', topSha, pulseLogLines, now };
  }
  if (pulseLogLines > state.last_pulse_log_lines) {
    const delta = pulseLogLines - state.last_pulse_log_lines;
    return { reason: `${delta} new narrative event${delta === 1 ? '' : 's'}`, topSha: topSha || state.last_sha, pulseLogLines, now };
  }
  if (now - state.last_emitted_at >= HEARTBEAT_MS) {
    return { reason: 'heartbeat 5min', topSha: topSha || state.last_sha, pulseLogLines, now };
  }
  return null;
}

function readTranscriptText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  try { return readFileSync(transcriptPath, 'utf8'); } catch { return ''; }
}

/**
 * Returns true if the transcript shows at least one spawned background subagent
 * that has not yet completed. Borrows the exact detection from never-idle.mjs.
 */
function hasActiveAgents(raw) {
  if (!raw) return false;
  const spawnIds = new Set();

  const agentRe = /"id"\s*:\s*"(toolu_[A-Za-z0-9_]+)"[\s\S]{0,200}?"name"\s*:\s*"Agent"[\s\S]{0,3000}?"run_in_background"\s*:\s*true/g;
  for (const m of raw.matchAll(agentRe)) spawnIds.add(m[1]);

  if (spawnIds.size === 0) return false;

  // Clear by task-notification with completed/killed status
  const notificationRe = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  for (const nMatch of raw.matchAll(notificationRe)) {
    const block = nMatch[1];
    if (!/<status>\s*(completed|killed)\s*<\/status>/i.test(block)) continue;
    const idMatch = block.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
    if (idMatch) spawnIds.delete(idMatch[1]);
  }

  // NOTE: we deliberately do NOT clear by inline tool_result references.
  // For run_in_background:true agents, CC's dispatch returns "Async agent
  // launched successfully" as a tool_result IMMEDIATELY — but the agent is
  // still running. The tool_result-presence check would incorrectly mark
  // them as done. Only <task-notification> with completed/killed is the
  // authoritative signal for background-agent completion.

  return spawnIds.size > 0;
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

  // PreToolUse(Agent): two responsibilities.
  // (1) GATE — block any spawn whose prompt is missing a reference to the
  //     pulse-emission contract. Forces Claude to include it every time.
  // (2) PULSE — on a valid spawn, emit baseline pulse so Russell sees the
  //     starting state of the new agent.
  if (eventName === 'PreToolUse') {
    const toolName = event.tool_name || '';
    if (toolName !== 'Agent') {
      process.exit(0);
      return;
    }
    const prompt = (event.tool_input && event.tool_input.prompt) || '';
    const description = (event.tool_input && event.tool_input.description) || '(unnamed)';

    // GATE: prompt must reference the pulse contract. Detection is
    // permissive — any of these markers passes:
    //   - "AGENT-PULSE-CONTRACT" (file name)
    //   - "agent-pulse.log" (the log file path)
    //   - "pulse contract" (prose reference)
    //   - "EMIT PULSES" / "emit pulses" / "emit a pulse" (explicit instruction)
    //   - "[TASK NAME] Agent:" (the format itself, included as example)
    // An OPT-OUT marker lets Claude bypass for genuinely-don't-need-pulses tasks:
    //   - "NO_PULSE_CONTRACT" anywhere in the prompt
    const hasContract = /AGENT-PULSE-CONTRACT|agent-pulse\.log|pulse[- ]?contract|emit[ -](?:a |the )?pulse|emit pulses|\[TASK NAME\]|\[Phase \d|narrative pulse/i.test(prompt);
    const explicitOptOut = /NO_PULSE_CONTRACT/i.test(prompt);

    if (!hasContract && !explicitOptOut) {
      const reason = `Agent spawn BLOCKED — the brief for "${description}" is missing the pulse-emission contract.

Russell's rule (added 2026-05-13): every background agent must emit plain-English narrative progress events to programming/.claude/state/agent-pulse.log so he sees what they're doing without polling git or asking "?".

Fix one of two ways:
1. (Preferred) Add a pulse-emission section to the brief. Reference C:/Users/rmill/Desktop/programming/.claude/state/AGENT-PULSE-CONTRACT.md and tell the agent: "Emit narrative pulses to programming/.claude/state/agent-pulse.log in the format [Task Name] Agent: <plain English status>. Cadence: every 2-3 tool calls or every commit."
2. If this agent genuinely doesn't need pulses (read-only / one-shot / under-30-second job), add the marker NO_PULSE_CONTRACT anywhere in the prompt.

Re-attempt the Agent spawn with the contract included.`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }));
      process.exit(0);
      return;
    }

    // PULSE: emit baseline so Russell sees starting state at agent kickoff.
    const pulse = runPulse();
    if (!pulse) {
      process.exit(0);
      return;
    }
    const message = `PULSE — agent spawn: ${description}\n\n${pulse}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message,
      },
    }));
    process.exit(0);
    return;
  }

  // Stop: throttled. Only emit pulse if (a) a new commit landed since last
  // pulse, OR (b) 5+ minutes have elapsed since last pulse. Stays silent on
  // every short reply where nothing changed.
  if (eventName === 'Stop') {
    if (event.stop_hook_active) {
      process.exit(0);
      return;
    }
    const transcript = readTranscriptText(event.transcript_path);
    if (!hasActiveAgents(transcript)) {
      process.exit(0);
      return;
    }
    const state = readState();
    const decision = shouldEmit(state);
    if (!decision) {
      process.exit(0); // throttled — nothing to say
      return;
    }
    const pulse = runPulse();
    if (!pulse) {
      process.exit(0);
      return;
    }
    writeState({
      last_emitted_at: decision.now,
      last_sha: decision.topSha || '',
      last_pulse_log_lines: decision.pulseLogLines,
    });
    // Stop hooks surface info to Claude via decision: 'block' with reason.
    // The block tells Claude "you can't stop yet — here's a pulse you must
    // surface to Russell in your reply." After Claude includes the pulse in
    // its reply and the next Stop fires, the throttle won't re-emit (same
    // SHA, <5min elapsed), so Claude can stop cleanly.
    const reason = `PULSE (reason: ${decision.reason}) — surface this in your reply so Russell sees fresh agent activity. Russell explicitly asked for throttled ambient pulses; this fires ONLY on new commits or 5min heartbeats, not every reply. Include the box verbatim in your next message to Russell:

${pulse}`;
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
    return;
  }

  process.exit(0);
}

main();
