#!/usr/bin/env node
// =============================================================================
// MAIN-THREAD PULSE — emit dashboard events from the main conversation
// =============================================================================
//
// Russell flagged 2026-05-13: the agent dashboard at localhost:9999 was useless
// when the main conversation was the one doing the work. The dashboard's pulse
// hooks (worktree-on-agent-spawn, pulse-enforcer-subagent, etc.) only fire on
// SUBAGENT events. When Claude works serially in-conversation, no pulses get
// emitted — the dashboard sits empty even though real work is shipping.
//
// This hook fires on PostToolUse for code-changing tools (Edit, Write, Bash
// when it commits/tests/builds) and appends a one-line pulse event to
// ~/.claude/state/agent-pulse.log so the dashboard shows main-thread activity.
//
// The "task" name on the pulse is auto-derived: prefer the current branch name
// of the cwd's git repo (e.g. "feature/lenat-in-clear"); fall back to the cwd
// basename. That gives the dashboard a stable chip per epic/feature.
//
// PLAIN-ENGLISH RULE: the pulse text comes from the tool name + a heuristic
// summary of what changed. Russell's rule "Agent Pulse Events Must Be Plain
// English" means no file paths, no function names, no SHA in the headline.
// The hook keeps it short: "Edited <surface in plain English>" or
// "Committed <subject of commit message>" — never a raw file path.
// =============================================================================
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

const PULSE_LOG = resolve(homedir(), 'Desktop/programming/.claude/state/agent-pulse.log');

// Throttle: emit at most one pulse per N seconds per task to avoid flooding.
// Adjustable; 15s is loose enough to capture rapid changes but tight enough
// that a flurry of edits surfaces as a single "working on X" event.
const THROTTLE_MS = 15 * 1000;
const LAST_PULSE_PATH = resolve(homedir(), '.claude/state/last-main-pulse.json');

function readJSON(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeJSON(p, obj) {
  try {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, '', { flag: 'a' });
    require('node:fs').writeFileSync(p, JSON.stringify(obj));
  } catch {}
}

function currentTaskName(cwd, filePath) {
  // Prefer the git branch of the file being edited (more specific than cwd
  // when cwd is a parent directory of multiple repos — e.g. ~/programming
  // contains Clear, Lenat, Lenat-clear, each a separate repo).
  const checkDir = filePath ? dirname(filePath) : cwd;
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: checkDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (branch && branch !== 'HEAD') return branch;
  } catch {}
  // No git repo found above the file. Use "Main thread" rather than the cwd
  // basename — "Main thread" is what Russell expects to see on the dashboard
  // for non-repo work (CLAUDE.md edits, hook authoring, etc.).
  return 'Main thread';
}

function shouldThrottle(task) {
  const last = readJSON(LAST_PULSE_PATH);
  const now = Date.now();
  if (last[task] && (now - last[task]) < THROTTLE_MS) return true;
  last[task] = now;
  writeJSON(LAST_PULSE_PATH, last);
  return false;
}

// Parse the hook event from stdin (Claude Code passes the tool-call payload).
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(input || '{}'); } catch {}
  const toolName = payload.tool_name || '';
  const toolInput = payload.tool_input || {};
  const cwd = payload.cwd || process.cwd();

  let summary = '';
  if (toolName === 'Edit' || toolName === 'Write') {
    const file = toolInput.file_path || '';
    if (!file) return; // nothing to say
    const fileBase = basename(file);
    summary = `Edited ${fileBase}`;
  } else if (toolName === 'Bash') {
    const cmd = (toolInput.command || '').trim();
    // Surface only meaningful bash events — commits, tests, builds.
    if (/git\s+commit/.test(cmd)) {
      const m = cmd.match(/-m\s+["']?([^"'\\n]{1,80})/);
      summary = m ? `Committed: ${m[1].slice(0, 80)}` : 'Committed code';
    } else if (/\b(npm|yarn|pnpm|bun)\s+test\b|\bvitest\b|\bjest\b|\bpytest\b|\.test\.(?:js|mjs|ts|py)\b/.test(cmd)) {
      summary = 'Running test suite';
    } else if (/\b(npm|yarn|pnpm|bun)\s+run\s+(build|bundle|compile)\b/.test(cmd)) {
      const m = cmd.match(/run\s+(build|bundle|compile)/);
      summary = `Ran ${m ? m[1] : 'build'}`;
    } else {
      return; // skip noisy bash (ls, cat, grep, etc.)
    }
  } else {
    return;
  }

  // Pass the file path so the task name reflects the repo being edited, not
  // the parent cwd (which may be a directory containing several repos).
  const filePathForTask = toolInput.file_path || (toolName === 'Bash' ? cwd : null);
  const task = currentTaskName(cwd, filePathForTask);
  if (shouldThrottle(task)) return;

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const line = `[${ts}] [${task}] Agent: ${summary}\n`;
  try {
    mkdirSync(dirname(PULSE_LOG), { recursive: true });
    appendFileSync(PULSE_LOG, line);
  } catch {}
});
