#!/usr/bin/env node
/**
 * Main-thread pulse hook.
 *
 * Claude Code hook event: PostToolUse on Bash/Edit/Write.
 * Purpose: keep the dashboard alive even when the orchestrator, not a
 * background agent, is doing the work.
 *
 * Fail-open: this hook should never block Claude Code.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_LOG = resolve(homedir(), '.claude', 'state', 'agent-pulse.log');
const PULSE_LOG = process.env.AGENT_PULSE_LOG || DEFAULT_LOG;

function readEvent() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return null;
  }
}

function clip(value, max = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

function bashSummary(command) {
  const text = clip(command);
  if (!text) return 'Ran a shell command.';
  if (/\bgit\s+commit\b/i.test(text)) return 'Committed progress to git.';
  if (/\b(node\s+--test|npm\s+test|pnpm\s+test|yarn\s+test|pytest|cargo\s+test|go\s+test)\b/i.test(text)) {
    return 'Ran the test suite.';
  }
  if (/\b(npm|pnpm|yarn)\s+run\s+build\b|\b(build|tsc)\b/i.test(text)) return 'Ran a build check.';
  return `Ran: ${text}`;
}

function toolSummary(event) {
  const toolName = event.tool_name || event.toolName || '';
  const input = event.tool_input || event.toolInput || {};
  if (toolName === 'Bash') return bashSummary(input.command);
  if (toolName === 'Write') return `Wrote ${clip(input.file_path || input.path || 'a file')}.`;
  if (toolName === 'Edit' || toolName === 'MultiEdit') return `Edited ${clip(input.file_path || input.path || 'a file')}.`;
  return `Used ${clip(toolName || 'a tool')}.`;
}

function appendPulse(text) {
  mkdirSync(dirname(PULSE_LOG), { recursive: true });
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  appendFileSync(PULSE_LOG, `[${stamp}] [Main thread] Agent: ${text}\n`, 'utf8');
}

function main() {
  const event = readEvent();
  if (!event) return;
  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'PostToolUse') return;

  const toolName = event.tool_name || event.toolName || '';
  if (!/^(Bash|Edit|MultiEdit|Write)$/.test(toolName)) return;

  appendPulse(toolSummary(event));
}

try {
  main();
} catch {
  process.exit(0);
}
