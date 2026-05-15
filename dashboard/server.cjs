#!/usr/bin/env node
/**
 * Control Tower server - port 9999 by default.
 *
 * Routes:
 *   GET  /              -> main dashboard
 *   GET  /versions/dense-v4 -> dense web mock
 *   GET  /versions/calm -> calm web mock
 *   GET  /api/state     -> snapshot {agents, commits, branch}
 *   GET  /api/stream    -> SSE stream pushing pulse events + state ticks
 *   POST /api/check-status -> writes a Supervisor inspection request
 *
 * Zero npm deps. Reads Codex, Claude, and local pulse logs.
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname);
const APP_ROOT = path.resolve(ROOT, '..');
const ASSET_ROOT = path.join(ROOT, 'assets');
const HOME = os.homedir();
const PORT = Number(process.env.CONTROL_TOWER_PORT || process.env.AGENT_DASHBOARD_PORT || 9999);
const STALL_MS = 3 * 60 * 1000;
const DORMANT_MS = 30 * 60 * 1000;

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.svg') return 'image/svg+xml; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.ico') return 'image/x-icon';
  return 'application/octet-stream';
}

function gitRoot(candidate) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: candidate,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function detectRepo() {
  const candidates = [
    process.env.CONTROL_TOWER_REPO,
    process.env.AGENT_DASHBOARD_REPO,
    process.cwd(),
    path.resolve(ROOT, '..', '..', '..', 'clear'),
    APP_ROOT,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const root = gitRoot(candidate);
    if (root) return root;
  }
  return APP_ROOT;
}

const TARGET_REPO = detectRepo();

function pulseSources() {
  const candidates = [];
  if (process.env.AGENT_PULSE_LOG) {
    candidates.push({
      key: 'custom',
      label: 'Custom',
      file: path.resolve(process.env.AGENT_PULSE_LOG),
    });
  }

  candidates.push(
    {
      key: 'codex',
      label: 'Codex',
      file: path.join(HOME, '.codex', 'state', 'agent-pulse.log'),
    },
    {
      key: 'claude',
      label: 'Claude',
      file: path.join(HOME, '.claude', 'state', 'agent-pulse.log'),
    },
    {
      key: 'local',
      label: 'Local',
      file: path.resolve(APP_ROOT, 'agent-pulse.log'),
    }
  );

  const seen = new Set();
  return candidates.filter((source) => {
    const resolved = path.resolve(source.file).toLowerCase();
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

function safeGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: TARGET_REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function parseEventsFromSource(source) {
  if (!fs.existsSync(source.file)) return [];
  const raw = fs.readFileSync(source.file, 'utf8');
  const events = [];

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/^\uFEFF/, '').trimEnd();
    if (!line.trim()) continue;
    const match = line.match(/^\[(\S+)\]\s+\[([^\]]+)\]\s+Agent:\s*(.*)$/);
    if (!match) continue;
    const ms = Date.parse(match[1]);
    if (Number.isNaN(ms)) continue;
    events.push({
      ms,
      iso: match[1],
      task: match[2],
      text: match[3],
      sourceKey: source.key,
      sourceLabel: source.label,
      sourceFile: source.file,
    });
  }

  return events;
}

function parseEvents() {
  return pulseSources().flatMap(parseEventsFromSource);
}

const COMPLETION_RE = /\b(all (\d+ )?(remaining )?cycles shipped|all (\d+ )?phases shipped|phase \w+ complete|final test count)/i;
const MILESTONE_RE = /\b(shipped|GREEN|green\b|landed|committing|cycle \d+(\.\d+)? (green|done|complete))/i;
const PROBLEM_RE = /\b(PROBLEM|failure|failed|crash|stalled|blocked|stuck|conflict|wiped|clobbered|API Error|no transcript growth)/i;
const PLAN_RE = /^(?:Plan|Replan):\s*(\d+)\s+checkpoints?\s*[-:]\s*(.+)$/i;
const PROGRESS_RE = /^Progress:\s*(\d+)\s*\/\s*(\d+)\s*[-:]\s*(.+)$/i;
const TOKEN_RE = /\b(?:tokens?|tok)\b[^0-9]{0,16}([0-9][0-9,]*)|([0-9][0-9,]*)\s*(?:tokens?|tok)\b/gi;
const COST_RE = /\b(?:cost|spent|usd)\b[^$0-9]{0,16}\$?\s*([0-9]+(?:\.[0-9]{1,4})?)|\$\s*([0-9]+(?:\.[0-9]{1,4})?)\s*(?:cost|spent|usd)?/gi;

function parseUsage(text) {
  let tokens = null;
  let costUsd = null;
  let match;

  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const raw = match[1] || match[2];
    const value = Number(String(raw).replace(/,/g, ''));
    if (Number.isFinite(value)) tokens = Math.max(tokens || 0, value);
  }

  COST_RE.lastIndex = 0;
  while ((match = COST_RE.exec(text)) !== null) {
    const raw = match[1] || match[2];
    const value = Number(raw);
    if (Number.isFinite(value)) costUsd = Math.max(costUsd || 0, value);
  }

  return { tokens, costUsd };
}

function cleanPulseText(text) {
  return String(text || '').trim().replace(/\.+$/, '').trim();
}

function parseCheckpointProgress(events, state) {
  let total = null;
  let planLabel = '';
  let current = null;
  let progressLabel = '';

  for (const event of [...events].reverse()) {
    const planMatch = event.text.match(PLAN_RE);
    if (planMatch) {
      total = parseInt(planMatch[1], 10);
      planLabel = cleanPulseText(planMatch[2]);
    }
    const progressMatch = event.text.match(PROGRESS_RE);
    if (progressMatch) {
      current = parseInt(progressMatch[1], 10);
      total = parseInt(progressMatch[2], 10);
      progressLabel = cleanPulseText(progressMatch[3]);
    }
  }

  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(current) || current < 0) current = 0;
  if (state === 'completed') current = total;
  current = Math.min(current, total);

  return {
    current,
    total,
    pct: Math.round((current / total) * 100),
    summary: `${current}/${total} checkpoints`,
    label: progressLabel || planLabel || 'Checkpoint signal pending.',
  };
}

function buildState() {
  const sources = pulseSources();
  const events = parseEvents();
  const now = Date.now();
  const tasksMap = new Map();

  for (const event of events) {
    const key = `${event.sourceKey}:${event.task}`;
    if (!tasksMap.has(key)) {
      tasksMap.set(key, {
        task: event.task,
        sourceKey: event.sourceKey,
        sourceLabel: event.sourceLabel,
        events: [],
      });
    }
    tasksMap.get(key).events.push(event);
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

    let goal = '(no goal stated - orchestrator should emit one)';
    for (const event of [...entry.events].reverse()) {
      const match = event.text.match(/^Goal:\s*(.+?)(?:\s*$|\.\s)/i);
      if (match) {
        goal = match[1].trim();
        break;
      }
    }

    let tokens = null;
    let costUsd = null;
    for (const event of entry.events) {
      const usage = parseUsage(event.text);
      if (usage.tokens !== null) tokens = Math.max(tokens || 0, usage.tokens);
      if (usage.costUsd !== null) costUsd = Math.max(costUsd || 0, usage.costUsd);
    }
    const progress = parseCheckpointProgress(entry.events, state);

    agents.push({
      task: entry.task,
      sourceKey: entry.sourceKey,
      sourceLabel: entry.sourceLabel,
      state,
      goal,
      progress,
      tokens,
      costUsd,
      lastEmitMs: last.ms,
      lastEmitText: last.text,
      events: entry.events.slice(0, 10).map((event) => ({
        ms: event.ms,
        text: event.text,
        kind: PROBLEM_RE.test(event.text) ? 'problem' : MILESTONE_RE.test(event.text) ? 'milestone' : 'normal',
      })),
    });
  }
  agents.sort((a, b) => b.lastEmitMs - a.lastEmitMs);
  const tokensTotal = agents.reduce((sum, agent) => sum + (agent.tokens || 0), 0);
  const costUsdTotal = Number(agents.reduce((sum, agent) => sum + (agent.costUsd || 0), 0).toFixed(4));

  const branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
  const headLog = safeGit(['log', '-1', '--pretty=format:%h %ar %s']);
  const recentCommitsRaw = safeGit(['log', '--pretty=format:%h%x09%ar%x09%s', '-15']);

  let commitsAhead = 0;
  const aheadRaw = safeGit(['rev-list', '--count', branch, '^main']);
  if (aheadRaw && /^\d+$/.test(aheadRaw)) commitsAhead = parseInt(aheadRaw, 10);

  let testsBaseline = null;
  let testsCurrent = null;
  const testArrowRe = /\btests?\b[^\n0-9]{0,12}(\d{3,5})\s*[-=]?>\s*(\d{3,5})/gi;
  const testsPassingRe = /\b(\d{3,5})\s+(?:tests?\s+)?(?:passing|pass)\b/gi;
  for (const event of events) {
    let match;
    testArrowRe.lastIndex = 0;
    while ((match = testArrowRe.exec(event.text)) !== null) {
      const baseline = parseInt(match[1], 10);
      const current = parseInt(match[2], 10);
      if (testsBaseline === null || baseline < testsBaseline) testsBaseline = baseline;
      if (testsCurrent === null || current > testsCurrent) testsCurrent = current;
    }
    testsPassingRe.lastIndex = 0;
    while ((match = testsPassingRe.exec(event.text)) !== null) {
      const n = parseInt(match[1], 10);
      if (n > 100 && n < 100000 && (testsCurrent === null || n > testsCurrent)) {
        testsCurrent = n;
      }
    }
  }
  const testsGained = testsBaseline !== null && testsCurrent !== null
    ? Math.max(0, testsCurrent - testsBaseline)
    : null;

  const commits = recentCommitsRaw
    ? recentCommitsRaw.split('\n').map((line) => {
        const [sha, when, msg] = line.split('\t');
        return { sha, when, msg };
      })
    : [];

  return {
    agents,
    branch,
    headLog,
    commits,
    commitsAhead,
    testsBaseline,
    testsCurrent,
    testsGained,
    tokensTotal,
    costUsdTotal,
    now,
    repo: TARGET_REPO,
    sources: sources.map((source) => ({
      key: source.key,
      label: source.label,
      file: source.file,
      exists: fs.existsSync(source.file),
    })),
  };
}

const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function pageVersionFor(requestPath) {
  if (requestPath === '/' || requestPath === '/index.html') return 'overview';
  if (requestPath === '/versions/dense-v4' || requestPath === '/dense-v4') return 'dense-v4';
  if (requestPath === '/versions/calm' || requestPath === '/calm') return 'calm';
  return '';
}

function stripMarkedBlock(pageHtml, markerName) {
  const markerPattern = new RegExp(`\\s*<!-- ${markerName}_START -->[\\s\\S]*?<!-- ${markerName}_END -->`, 'g');
  return pageHtml.replace(markerPattern, '');
}

function pageHtmlFor(pageVersion) {
  const initialState = JSON.stringify(buildState()).replace(/</g, '\\u003c');
  let pageHtml = indexHtml
    .replace('window.__INITIAL_STATE__ = null;', `window.__INITIAL_STATE__ = ${initialState};`)
    .replace("window.__DASHBOARD_VERSION__ = 'overview';", `window.__DASHBOARD_VERSION__ = '${pageVersion}';`);

  if (pageVersion === 'overview') {
    pageHtml = stripMarkedBlock(pageHtml, 'VERSION_STACK');
  } else if (pageVersion === 'dense-v4') {
    pageHtml = stripMarkedBlock(pageHtml, 'CALM_VERSION');
  } else if (pageVersion === 'calm') {
    pageHtml = stripMarkedBlock(pageHtml, 'DENSE_VERSION');
  }

  return pageHtml;
}

const sseClients = new Set();
function broadcastState() {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(buildState())}\n\n`;
  for (const response of sseClients) {
    try {
      response.write(payload);
    } catch {}
  }
}

function writeSourceFor(sourceKey) {
  const sources = pulseSources();
  if (sourceKey) {
    const source = sources.find((candidate) => candidate.key === sourceKey);
    if (source) return source;
  }
  return sources.find((source) => fs.existsSync(source.file)) || sources[0];
}

function pulseSizeSignature() {
  return pulseSources()
    .map((source) => `${source.key}:${fs.existsSync(source.file) ? fs.statSync(source.file).size : 0}`)
    .join('|');
}

let lastSize = pulseSizeSignature();
let lastHead = '';
setInterval(() => {
  let push = false;
  const size = pulseSizeSignature();
  if (size !== lastSize) {
    lastSize = size;
    push = true;
  }
  const head = safeGit(['rev-parse', 'HEAD']);
  if (head && head !== lastHead) {
    lastHead = head;
    push = true;
  }
  if (push) broadcastState();
}, 1000);

setInterval(broadcastState, 5000);

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');
  const pageVersion = pageVersionFor(requestUrl.pathname);
  if (pageVersion) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtmlFor(pageVersion));
    return;
  }

  if (requestUrl.pathname.startsWith('/assets/')) {
    const relativePath = requestUrl.pathname.replace(/^\/assets\//, '');
    const filePath = path.resolve(ASSET_ROOT, relativePath);
    if (!filePath.startsWith(ASSET_ROOT + path.sep) && filePath !== ASSET_ROOT) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (requestUrl.pathname === '/api/check-status' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {}

      const task = String(parsed.task || '').slice(0, 80) || '(unknown)';
      const source = writeSourceFor(String(parsed.sourceKey || ''));
      const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const line = `[${ts}] [${task}] Agent: Supervisor asked to inspect this agent because it looks quiet on the dashboard. Check the branch, recent commits, transcript if available, and report what you find in plain English.\n`;

      try {
        fs.mkdirSync(path.dirname(source.file), { recursive: true });
        fs.appendFileSync(source.file, line);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, task, ts, sourceKey: source.key, sourceLabel: source.label }));
        broadcastState();
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (requestUrl.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildState()));
    return;
  }

  if (requestUrl.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
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
  console.log(`Control Tower: http://127.0.0.1:${PORT}`);
  console.log(`Watching repo: ${TARGET_REPO}`);
  console.log(`Pulse logs: ${pulseSources().map((source) => `${source.label}=${source.file}`).join(' | ')}`);
  console.log('Ctrl+C to stop.');
});
