const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(__dirname, 'server.cjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with ${code}: ${output}`));
    });
  });
}

test('discovers a Windows Codex pulse log and writes Supervisor checks back to it', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dashboard-'));
  const home = path.join(tmp, 'home');
  const codexState = path.join(home, '.codex', 'state');
  fs.mkdirSync(codexState, { recursive: true });
  const pulseLog = path.join(codexState, 'agent-pulse.log');
  const iso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.writeFileSync(
    pulseLog,
    `\ufeff[${iso}] [Phase 1] Agent: Goal: Rename imports safely so Windows Codex users can monitor the run. Tokens: 12,480. Cost: $0.42.\r\n`,
    'utf8'
  );

  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_DASHBOARD_PORT: String(port),
      AGENT_DASHBOARD_REPO: ROOT,
      HOME: home,
      USERPROFILE: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  await waitForServer(child, port);

  const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].task, 'Phase 1');
  assert.equal(state.agents[0].sourceLabel, 'Codex');
  assert.match(state.agents[0].goal, /Rename imports safely so Windows Codex users can monitor the run/);
  assert.equal(state.agents[0].tokens, 12480);
  assert.equal(state.agents[0].costUsd, 0.42);
  assert.equal(state.tokensTotal, 12480);
  assert.equal(state.costUsdTotal, 0.42);

  const check = await fetch(`http://127.0.0.1:${port}/api/check-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Phase 1', sourceKey: state.agents[0].sourceKey }),
  }).then((r) => r.json());
  assert.equal(check.ok, true);
  assert.match(fs.readFileSync(pulseLog, 'utf8'), /Supervisor asked to inspect this agent/);

  const themedPage = await fetch(`http://127.0.0.1:${port}/?theme=light`);
  assert.equal(themedPage.status, 200);
  const themedHtml = await themedPage.text();
  assert.match(themedHtml, /window\.__INITIAL_STATE__ = /);
  assert.match(themedHtml, /<html lang="en" data-theme="light">/);
  assert.match(themedHtml, /Agent Dashboard/);
  assert.match(themedHtml, /Hook-enforced updates/);
  assert.match(themedHtml, /Watch what your agents do/);
  assert.match(themedHtml, /Needs Supervisor/);
  assert.match(themedHtml, /Supervisor Agent/);
  assert.match(themedHtml, /Tokens/);
  assert.match(themedHtml, /Cost/);
  assert.match(themedHtml, /portfolio-card/);
  assert.match(themedHtml, /Russell Miller/);
  assert.match(themedHtml, /rmiller@zavient\.com/);
  assert.match(themedHtml, /Demo preview/);
  assert.match(themedHtml, /Auth cleanup/);
  assert.match(themedHtml, /state: 'dormant'/);
  assert.match(themedHtml, /3 agents are working/);
});

test('ships a Windows desktop shortcut launcher script', () => {
  const shortcutScript = fs.readFileSync(path.join(ROOT, 'scripts', 'create-desktop-shortcut.ps1'), 'utf8');
  assert.match(shortcutScript, /Agent Dashboard/);
  assert.match(shortcutScript, /dashboard\\server\.cjs/);
  assert.match(shortcutScript, /WScript\.Shell/);
});

test('ships a setup skill and one-click Windows installer', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'agent-dashboard-setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /Agent Dashboard Setup/);
  assert.match(skill, /scripts\/install.ps1/);
  assert.match(skill, /create-desktop-shortcut.ps1/);

  const oneClick = fs.readFileSync(path.join(ROOT, 'Install Agent Dashboard.ps1'), 'utf8');
  assert.match(oneClick, /scripts\\install\.ps1/);
  assert.match(oneClick, /create-desktop-shortcut\.ps1/);

  const mainThreadHook = fs.readFileSync(path.join(ROOT, 'hooks', 'main-thread-pulse.mjs'), 'utf8');
  assert.match(mainThreadHook, /PostToolUse/);
  assert.match(mainThreadHook, /agent-pulse\.log/);

  const installer = fs.readFileSync(path.join(ROOT, 'scripts', 'install.ps1'), 'utf8');
  assert.match(installer, /main-thread-pulse\.mjs/);

  const snippet = fs.readFileSync(path.join(ROOT, 'scripts', 'settings-snippet.json'), 'utf8');
  assert.match(snippet, /PostToolUse/);
  assert.match(snippet, /main-thread-pulse\.mjs/);
});
