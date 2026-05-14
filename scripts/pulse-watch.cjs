#!/usr/bin/env node
/**
 * pulse-watch — live Control Tower terminal view, grouped per agent.
 *
 * Each agent gets its own section showing:
 *   - Task name + state (working / silent / dormant / completed)
 *   - Goal (extracted from first pulse — usually "Starting Phase X — ...")
 *   - Newest events first, oldest last (limit per agent)
 *
 * v4 (2026-05-13):
 *   - Per-agent grouping (no more interleaved stream)
 *   - Goal line per agent
 *   - Dropped cryptic ★/⚠ markers — state is in the header, problem events
 *     get a plain "PROBLEM:" prefix instead
 *   - Color per task; oldest agents listed last
 *
 * Usage:
 *   node programming/.claude/state/pulse-watch.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const PULSE_LOG = path.resolve(__dirname, 'agent-pulse.log');
const EVENTS_PER_AGENT = 6;                    // newest N events per agent
const STALL_MS = 3 * 60 * 1000;                // 3 min silence → silent
const DORMANT_MS = 30 * 60 * 1000;             // 30 min silence → dormant
const POLL_MS = 500;
const REDRAW_MS = 5000;

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  brightGreen: '\x1b[92m',
  brightRed: '\x1b[91m',
  brightCyan: '\x1b[96m',
  brightYellow: '\x1b[93m',
};

const TASK_COLORS = [COLORS.cyan, COLORS.green, COLORS.yellow, COLORS.magenta, COLORS.blue, COLORS.red];
const taskColorMap = new Map();
function colorForTask(name) {
  if (!taskColorMap.has(name)) {
    taskColorMap.set(name, TASK_COLORS[taskColorMap.size % TASK_COLORS.length]);
  }
  return taskColorMap.get(name);
}

// task → { events: [{ms, text}], firstEventMs, firstEventText }
const tasksMap = new Map();

const COMPLETION_RE = /\b(all (\d+ )?(remaining )?cycles shipped|all (\d+ )?phases shipped|phase \w+ complete|final test count|summary report)/i;
const MILESTONE_RE = /\b(shipped|GREEN|green\b|landed|committing|cycle \d+(\.\d+)? (green|done|complete))/i;
const PROBLEM_RE = /\b(PROBLEM|failure|failed|crash|stalled|blocked|stuck|conflict|wiped|clobbered|API Error)/i;

function relTime(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function pushEvent(line) {
  const m = line.match(/^\[(\S+)\]\s+\[([^\]]+)\]\s+Agent:\s*(.*)$/);
  if (!m) return false;
  const [, iso, task, text] = m;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  let entry = tasksMap.get(task);
  if (!entry) {
    entry = { events: [], firstEventMs: ms, firstEventText: text };
    tasksMap.set(task, entry);
  }
  entry.events.push({ ms, text });
  return true;
}

function lastEmit(task) {
  const entry = tasksMap.get(task);
  if (!entry || entry.events.length === 0) return 0;
  return entry.events[entry.events.length - 1].ms;
}

function taskState(task) {
  const entry = tasksMap.get(task);
  if (!entry || entry.events.length === 0) return null;
  const last = entry.events[entry.events.length - 1];
  const silentMs = Date.now() - last.ms;
  if (COMPLETION_RE.test(last.text)) {
    return { glyph: `${COLORS.brightCyan}✓${COLORS.reset}`, label: `${COLORS.brightCyan}completed${COLORS.reset}` };
  }
  if (silentMs > DORMANT_MS) {
    return { glyph: `${COLORS.dim}○${COLORS.reset}`, label: `${COLORS.dim}dormant${COLORS.reset}` };
  }
  if (silentMs > STALL_MS) {
    return { glyph: `${COLORS.yellow}⏸${COLORS.reset}`, label: `${COLORS.yellow}silent${COLORS.reset}` };
  }
  return { glyph: `${COLORS.brightGreen}●${COLORS.reset}`, label: `${COLORS.brightGreen}working${COLORS.reset}` };
}

/**
 * Find the goal across ALL events for a task. Three-tier:
 *   1. PREFERRED: any event with literal "Goal: <plain English>" prefix
 *      (orchestrator-emitted or agent-declared)
 *   2. Fallback: drop the goal entirely — show "(no goal stated)"
 *
 * The old em-dash heuristic kept grabbing stat lines ("Baseline check
 * done — 3109 pass") as goals. Stripped that — explicit Goal: prefix
 * is the only reliable signal.
 */
function extractGoal(events) {
  for (const ev of events) {
    const m = ev.text.match(/^Goal:\s*(.+?)(?:\s*$|\.\s)/i);
    if (m) return m[1].trim();
  }
  return '(no goal stated — orchestrator should emit one when spawning)';
}

function renderLegend() {
  const L = [
    `${COLORS.dim}┌─ LEGEND ─────────────────────────────────────────────────────────────${COLORS.reset}`,
    `${COLORS.dim}│${COLORS.reset} State:    ${COLORS.brightGreen}●${COLORS.reset} working   ${COLORS.brightCyan}✓${COLORS.reset} completed   ${COLORS.yellow}⏸${COLORS.reset} silent (3min+)   ${COLORS.dim}○${COLORS.reset} dormant (30min+)`,
    `${COLORS.dim}│${COLORS.reset} Events:   ${COLORS.brightGreen}★${COLORS.reset} shipped/green/committed   ${COLORS.brightRed}⚠${COLORS.reset} PROBLEM/failure/conflict`,
    `${COLORS.dim}│${COLORS.reset} Per agent: newest events at top of its section; agents sorted by most-recent emit`,
    `${COLORS.dim}└──────────────────────────────────────────────────────────────────────${COLORS.reset}`,
  ];
  return L.join('\n');
}

function render() {
  process.stdout.write('\x1b[H\x1b[2J');
  console.log(renderLegend());
  if (tasksMap.size === 0) {
    console.log(`${COLORS.dim}(no agents have emitted yet — pulse log is empty)${COLORS.reset}`);
    return;
  }

  // Sort tasks by most-recent-emit first (active agents at top)
  const sortedTasks = [...tasksMap.keys()].sort((a, b) => lastEmit(b) - lastEmit(a));

  for (const task of sortedTasks) {
    const entry = tasksMap.get(task);
    const state = taskState(task);
    const color = colorForTask(task);
    const goal = extractGoal(entry.events);

    // Section header: state glyph + task name + state label + last emit
    const lastEmitStr = relTime(entry.events[entry.events.length - 1].ms);
    console.log('');
    console.log(`${state.glyph} ${color}${COLORS.bold}[${task}]${COLORS.reset}  ${state.label}  ${COLORS.dim}— last emit: ${lastEmitStr}${COLORS.reset}`);
    console.log(`   ${COLORS.dim}Goal:${COLORS.reset} ${goal}`);

    // Newest N events first
    const recent = entry.events.slice(-EVENTS_PER_AGENT).reverse();
    for (const ev of recent) {
      const ago = relTime(ev.ms);
      let marker = '  ';
      let textColor = '';
      if (PROBLEM_RE.test(ev.text)) {
        marker = `${COLORS.brightRed}⚠ ${COLORS.reset}`;
        textColor = COLORS.brightRed;
      } else if (MILESTONE_RE.test(ev.text)) {
        marker = `${COLORS.brightGreen}★ ${COLORS.reset}`;
        textColor = COLORS.brightGreen;
      }
      console.log(`   ${marker}${COLORS.dim}${ago.padStart(8)}${COLORS.reset}  ${textColor}${ev.text}${COLORS.reset}`);
    }
  }
  console.log('');
  console.log(`${COLORS.dim}── live, Ctrl+C to stop. Newest events first within each agent. ──${COLORS.reset}`);
}

function loadBacklog() {
  tasksMap.clear();
  taskColorMap.clear();
  if (!fs.existsSync(PULSE_LOG)) return 0;
  const raw = fs.readFileSync(PULSE_LOG, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    pushEvent(line);
  }
  return Buffer.byteLength(raw, 'utf8');
}

let lastSize = loadBacklog();
render();

function pollOnce() {
  if (!fs.existsSync(PULSE_LOG)) return;
  let stat;
  try { stat = fs.statSync(PULSE_LOG); } catch { return; }
  if (stat.size === lastSize) return;
  if (stat.size < lastSize) {
    lastSize = loadBacklog();
    render();
    return;
  }
  const fd = fs.openSync(PULSE_LOG, 'r');
  try {
    const buf = Buffer.alloc(stat.size - lastSize);
    fs.readSync(fd, buf, 0, buf.length, lastSize);
    const newText = buf.toString('utf8');
    let added = 0;
    for (const line of newText.split('\n')) {
      if (line.trim() && pushEvent(line)) added++;
    }
    lastSize = stat.size;
    if (added > 0) render();
  } finally {
    fs.closeSync(fd);
  }
}

let lastRender = Date.now();
function periodicRedraw() {
  if (Date.now() - lastRender < REDRAW_MS) return;
  lastRender = Date.now();
  render();
}

setInterval(() => { pollOnce(); periodicRedraw(); }, POLL_MS);

process.on('SIGINT', () => {
  console.log(`\n${COLORS.dim}── stopped ──${COLORS.reset}`);
  process.exit(0);
});
