#!/usr/bin/env node
/**
 * Agent dashboard server — port 9999.
 *
 * Routes:
 *   GET  /              → index.html
 *   GET  /api/state     → snapshot {agents, commits, head, branch}
 *   GET  /api/stream    → SSE stream pushing pulse events + state-refresh ticks
 *
 * Zero npm deps. Reads from agent-pulse.log + git in the Clear repo.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname);
const PULSE_LOG = path.resolve(ROOT, '..', 'agent-pulse.log');
const CLEAR_REPO = path.resolve(ROOT, '..', '..', '..', 'clear');
const PORT = 9999;
const STALL_MS = 3 * 60 * 1000;
const DORMANT_MS = 30 * 60 * 1000;

function safeGit(args) {
  try {
    return execFileSync('git', args, { cwd: CLEAR_REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function parseEvents() {
  if (!fs.existsSync(PULSE_LOG)) return [];
  const raw = fs.readFileSync(PULSE_LOG, 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^\[(\S+)\]\s+\[([^\]]+)\]\s+Agent:\s*(.*)$/);
    if (!m) continue;
    const ms = Date.parse(m[1]);
    if (Number.isNaN(ms)) continue;
    events.push({ ms, iso: m[1], task: m[2], text: m[3] });
  }
  return events;
}

const COMPLETION_RE = /\b(all (\d+ )?(remaining )?cycles shipped|all (\d+ )?phases shipped|phase \w+ complete|final test count)/i;
const MILESTONE_RE = /\b(shipped|GREEN|green\b|landed|committing|cycle \d+(\.\d+)? (green|done|complete))/i;
const PROBLEM_RE = /\b(PROBLEM|failure|failed|crash|stalled|blocked|stuck|conflict|wiped|clobbered|API Error)/i;

function buildState() {
  const events = parseEvents();
  const now = Date.now();
  const tasksMap = new Map();
  for (const ev of events) {
    if (!tasksMap.has(ev.task)) tasksMap.set(ev.task, { task: ev.task, events: [] });
    tasksMap.get(ev.task).events.push(ev);
  }
  const agents = [];
  for (const entry of tasksMap.values()) {
    entry.events.sort((a, b) => b.ms - a.ms);
    const last = entry.events[0];
    const silentMs = now - last.ms;
    let state;
    if (COMPLETION_RE.test(last.text)) state = 'completed';
    else if (silentMs > DORMANT_MS) state = 'dormant';
    else if (silentMs > STALL_MS) state = 'silent';
    else state = 'working';
    let goal = '(no goal stated — orchestrator should emit one)';
    for (const ev of [...entry.events].reverse()) {
      const m = ev.text.match(/^Goal:\s*(.+?)(?:\s*$|\.\s)/i);
      if (m) { goal = m[1].trim(); break; }
    }
    agents.push({
      task: entry.task,
      state,
      goal,
      lastEmitMs: last.ms,
      lastEmitText: last.text,
      events: entry.events.slice(0, 10).map((ev) => ({
        ms: ev.ms,
        text: ev.text,
        kind: PROBLEM_RE.test(ev.text) ? 'problem' : MILESTONE_RE.test(ev.text) ? 'milestone' : 'normal',
      })),
    });
  }
  agents.sort((a, b) => b.lastEmitMs - a.lastEmitMs);

  const branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
  const headLog = safeGit(['log', '-1', '--pretty=format:%h %ar %s']);
  const recentCommitsRaw = safeGit(['log', '--pretty=format:%h%x09%ar%x09%s', '-15']);
  const commits = recentCommitsRaw
    ? recentCommitsRaw.split('\n').map((l) => {
        const [sha, when, msg] = l.split('\t');
        return { sha, when, msg };
      })
    : [];

  return { agents, branch, headLog, commits, now };
}

const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const sseClients = new Set();
function broadcastState() {
  if (sseClients.size === 0) return;
  const state = buildState();
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

// Watch pulse log + poll git for changes; push on either signal
let lastSize = fs.existsSync(PULSE_LOG) ? fs.statSync(PULSE_LOG).size : 0;
let lastHead = '';
setInterval(() => {
  let push = false;
  if (fs.existsSync(PULSE_LOG)) {
    const sz = fs.statSync(PULSE_LOG).size;
    if (sz !== lastSize) { lastSize = sz; push = true; }
  }
  const head = safeGit(['rev-parse', 'HEAD']);
  if (head && head !== lastHead) { lastHead = head; push = true; }
  if (push) broadcastState();
}, 1000);

// Heartbeat every 5s so silence counters tick live in the browser
setInterval(broadcastState, 5000);

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
    return;
  }
  if (req.url === '/api/check-status' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const task = String(parsed.task || '').slice(0, 80) || '(unknown)';
      const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const line = `[${ts}] [${task}] Agent: USER-REQUESTED-CHECK: this agent looks silent on the dashboard. Russell clicked the chip — please investigate (git status, recent commits on its branch, agent transcript if visible) and report what you find.\n`;
      try {
        fs.mkdirSync(path.dirname(PULSE_LOG), { recursive: true });
        fs.appendFileSync(PULSE_LOG, line);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, task, ts }));
        broadcastState();
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  if (req.url === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildState()));
    return;
  }
  if (req.url === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(buildState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`Agent dashboard: http://127.0.0.1:${PORT}`);
  console.log('Ctrl+C to stop.');
});
