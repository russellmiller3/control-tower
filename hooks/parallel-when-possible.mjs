#!/usr/bin/env node
/**
 * parallel-when-possible — Stop hook that catches under-parallelization.
 *
 * Russell's rule "Work In Parallel By Default" (user CLAUDE.md): batch
 * independent tool calls + spawn multiple agents concurrently when the
 * plan allows. The rule existed but was advisory; this hook is the
 * enforcement.
 *
 * Fires on Stop. Inspects:
 *   1. How many background agents are currently alive (transcript scan,
 *      reusing the never-idle / pulse-enforcer detection).
 *   2. Whether the active priority queue or plan has unstarted phases
 *      tagged "parallel-safe" or otherwise compatible with the in-flight
 *      work.
 *
 * Blocks the stop with a reminder if exactly 1 agent is alive while 2+
 * parallel-safe phases sit unstarted. Doesn't block when 0 agents are
 * alive (genuinely idle, or all done) or 2+ agents are alive (already
 * parallel).
 *
 * Sources scanned (any one with a parallel-safe match counts):
 *   - C:/Users/rmill/Desktop/programming/.claude/state/priority-queue.md
 *   - C:/Users/rmill/Desktop/programming/clear/.claude/state/priority-queue.md
 *   - The most recent Lenat plan file (plans/plan-lenat-in-clear-*.md)
 *
 * Suppression markers (any in the recent transcript or queue header
 * suppresses the hook for this run):
 *   - "serial only" / "do not parallelize" / "no parallel"
 *
 * Fail-open on unexpected errors.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const PROGRAMMING = resolve(homedir(), 'Desktop', 'programming');
const QUEUE_PATHS = [
  resolve(PROGRAMMING, '.claude', 'state', 'priority-queue.md'),
  resolve(PROGRAMMING, 'clear', '.claude', 'state', 'priority-queue.md'),
];
const LENAT_PLANS_DIR = resolve(PROGRAMMING, 'Lenat', 'plans');

function safeRead(p) {
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

function activeAgentCount(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return 0; }
  const spawnIds = new Set();

  const agentRe = /"id"\s*:\s*"(toolu_[A-Za-z0-9_]+)"[\s\S]{0,200}?"name"\s*:\s*"Agent"[\s\S]{0,3000}?"run_in_background"\s*:\s*true/g;
  for (const m of raw.matchAll(agentRe)) spawnIds.add(m[1]);
  if (spawnIds.size === 0) return 0;

  const notificationRe = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  for (const nMatch of raw.matchAll(notificationRe)) {
    const block = nMatch[1];
    if (!/<status>\s*(completed|killed)\s*<\/status>/i.test(block)) continue;
    const idMatch = block.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
    if (idMatch) spawnIds.delete(idMatch[1]);
  }
  return spawnIds.size;
}

function latestPlanFile() {
  if (!existsSync(LENAT_PLANS_DIR)) return null;
  try {
    const files = readdirSync(LENAT_PLANS_DIR)
      .filter((f) => /^plan-.*\.md$/.test(f))
      .map((f) => ({ f, full: join(LENAT_PLANS_DIR, f), mtime: statSync(join(LENAT_PLANS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.full || null;
  } catch {
    return null;
  }
}

const PULSE_LOG = resolve(PROGRAMMING, '.claude', 'state', 'agent-pulse.log');

/** Returns the set of "Phase N" identifiers that appear in pulse-log task tags. */
function phasesInPulseLog() {
  const text = safeRead(PULSE_LOG);
  if (!text) return new Set();
  const seen = new Set();
  const re = /\[Phase\s+(\d+(?:\.\d+)?)\]/gi;
  let m;
  while ((m = re.exec(text)) !== null) seen.add(`Phase ${m[1]}`);
  return seen;
}

/**
 * Look for unstarted parallel-safe phases in the queue/plan. Returns
 * a list of human-readable phase titles, or [] if none.
 *
 * A phase is "unstarted" if:
 *   - it carries a "parallel-safe" tag in its plan/queue line
 *   - it is NOT marked done (✅, done, shipped, complete)
 *   - its "Phase N" id does NOT appear in the pulse log (which means no
 *     agent has emitted under that tag yet — phases in flight emit their
 *     own pulses, so they show up)
 */
function unstartedParallelSafePhases() {
  const inFlightOrDone = phasesInPulseLog();
  const sources = [...QUEUE_PATHS, latestPlanFile()].filter(Boolean);
  const phases = new Set();
  for (const source of sources) {
    const text = safeRead(source);
    if (!text) continue;
    const lines = text.split('\n');
    for (const line of lines) {
      if (!/parallel[- ]safe|\(parallel\)/i.test(line)) continue;
      if (/^[\s|]*✅|complete|completed|shipped|done|🔥/i.test(line)) continue;
      const idMatch = line.match(/Phase\s+(\d+(?:\.\d+)?)/i);
      if (idMatch && inFlightOrDone.has(`Phase ${idMatch[1]}`)) continue;
      const titleMatch = line.match(/Phase\s+\d+(?:\.\d+)?\s*[—–\-:|]\s*([^|]+?)(?:\s*\||\s*$)/i);
      const title = titleMatch ? `Phase ${idMatch ? idMatch[1] : '?'} — ${titleMatch[1].trim().slice(0, 60)}` : line.replace(/[|*_`]/g, '').trim().slice(0, 80);
      if (title) phases.add(title);
    }
  }
  return [...phases];
}

function suppressed(transcript) {
  if (!transcript) return false;
  return /serial only|do not parallelize|no parallel/i.test(transcript);
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
  if (event.stop_hook_active) {
    process.exit(0);
    return;
  }

  const transcript = event.transcript_path ? safeRead(event.transcript_path) : '';
  if (suppressed(transcript)) {
    process.exit(0);
    return;
  }

  const activeCount = activeAgentCount(event.transcript_path);
  // Only nudge when exactly 1 agent is in flight — 0 means idle/done, 2+
  // means already parallel.
  if (activeCount !== 1) {
    process.exit(0);
    return;
  }

  const parallelSafe = unstartedParallelSafePhases();
  if (parallelSafe.length < 1) {
    process.exit(0);
    return;
  }

  const list = parallelSafe.slice(0, 6).map((p) => `  - ${p}`).join('\n');
  const reason = `PARALLELIZE — only 1 background agent is in flight, but ${parallelSafe.length} parallel-safe phase(s) are still unstarted in the priority queue / latest plan:

${list}

Russell's rule "Work In Parallel By Default" (user CLAUDE.md): batch independent agents + tool calls. Subagent throughput compounds. Right now you have parallel headroom and are using one slot.

Action: spawn the remaining parallel-safe agent(s) in your next message. The plan explicitly marks them as collision-safe with the in-flight work. If you have a real reason this run must be serial, include "serial only" or "do not parallelize" in your reply and the hook will quiet down.`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

main();
