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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-tower-'));
  const home = path.join(tmp, 'home');
  const codexState = path.join(home, '.codex', 'state');
  fs.mkdirSync(codexState, { recursive: true });
  const pulseLog = path.join(codexState, 'agent-pulse.log');
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.writeFileSync(
    pulseLog,
    [
      `\ufeff[${iso(0)}] [Phase 1] Agent: Goal: Rename imports safely so Windows Codex users can monitor the run. Tokens: 12,480. Cost: $0.42.`,
      `[${iso(1000)}] [Phase 1] Agent: Plan: 4 checkpoints - parser cases, Windows paths, smoke check, docs.`,
      `[${iso(2000)}] [Phase 1] Agent: Progress: 1/4 - Wrote the failing malformed config test.`,
      `[${iso(3000)}] [Phase 1] Agent: Progress: 2/4 - Parser cases are green and Windows path checks are passing.`,
    ].join('\r\n') + '\r\n',
    'utf8'
  );

  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONTROL_TOWER_PORT: String(port),
      CONTROL_TOWER_REPO: ROOT,
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
  assert.deepEqual(state.agents[0].progress, {
    current: 2,
    total: 4,
    pct: 50,
    summary: '2/4 checkpoints',
    label: 'Parser cases are green and Windows path checks are passing',
  });
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
  assert.match(themedHtml, /Control Tower/);
  assert.match(themedHtml, /Agent traffic control for Codex and Claude/);
  assert.match(themedHtml, /checkpoint-fill/);
  assert.match(themedHtml, /Checkpoint progress/);
  assert.match(themedHtml, /Last 3 actions/);
  assert.ok(!/Right now/.test(themedHtml));
  assert.match(themedHtml, /Watch what your agents do\. Catch them if they go dark\./);
  assert.match(themedHtml, /Needs Supervisor/);
  assert.match(themedHtml, /Live Agent Traffic/);
  assert.match(themedHtml, /Supervisor Console/);
  assert.match(themedHtml, /Tokens/);
  assert.match(themedHtml, /Cost/);
  assert.match(themedHtml, /radar-scope/);
  assert.match(themedHtml, /control-tower-32\.png/);
  assert.match(themedHtml, /control-tower-theme/);
  assert.match(themedHtml, /agent-dashboard-theme/);
  assert.match(themedHtml, /portfolio-card/);
  assert.match(themedHtml, /Russell Miller/);
  assert.match(themedHtml, /rmiller@zavient\.com/);
  assert.match(themedHtml, /Demo preview/);
  assert.match(themedHtml, /Auth cleanup/);
  assert.match(themedHtml, /state: 'dormant'/);
  assert.match(themedHtml, /3 agents are working/);
  assert.match(themedHtml, /2\/4 checkpoints/);
  assert.match(themedHtml, /Tufte TUI/);
  assert.match(themedHtml, /id="tufte-tui"/);
  assert.match(themedHtml, /id="tufte-ledger"/);
  assert.match(themedHtml, /Control Tower Dense v4/);
  assert.match(themedHtml, /id="dense-v4"/);
  assert.match(themedHtml, /id="dense-lanes"/);
  assert.match(themedHtml, /function renderTufteTui\(dashboardState\)/);
  assert.match(themedHtml, /function renderDenseV4\(dashboardState\)/);

  const icon = await fetch(`http://127.0.0.1:${port}/assets/control-tower.svg`);
  assert.equal(icon.status, 200);
  const iconSvg = await icon.text();
  assert.match(iconSvg, /<svg/);
  assert.match(iconSvg, /Control Tower icon/);
});

test('ships a Windows desktop shortcut launcher script', () => {
  const shortcutScript = fs.readFileSync(path.join(ROOT, 'scripts', 'create-desktop-shortcut.ps1'), 'utf8');
  const launcherScript = fs.readFileSync(path.join(ROOT, 'scripts', 'launch-control-tower.ps1'), 'utf8');
  assert.match(shortcutScript, /Control Tower/);
  assert.match(shortcutScript, /dashboard\\server\.cjs/);
  assert.match(shortcutScript, /control-tower\.ico/);
  assert.match(shortcutScript, /TaskBar/);
  assert.match(shortcutScript, /WScript\.Shell/);
  assert.match(launcherScript, /CONTROL_TOWER_PORT/);
  assert.match(launcherScript, /CONTROL_TOWER_REPO/);
  assert.match(launcherScript, /--app=http:\/\/127\.0\.0\.1:\$Port\/\?theme=light/);
  assert.match(launcherScript, /msedge\.exe|chrome\.exe/);
});

test('ships a setup skill and one-click Windows installer', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'control-tower-setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /Control Tower Setup/);
  assert.match(skill, /scripts\/install.ps1/);
  assert.match(skill, /create-desktop-shortcut.ps1/);
  assert.match(skill, /taskbar/i);
  assert.match(skill, /Install Control Tower\.ps1/);
  assert.match(skill, /Install Control Tower\.cmd/);

  const oneClick = fs.readFileSync(path.join(ROOT, 'Install Control Tower.ps1'), 'utf8');
  assert.match(oneClick, /scripts\\install\.ps1/);
  assert.match(oneClick, /create-desktop-shortcut\.ps1/);
  assert.match(oneClick, /Control Tower/);

  const wrapper = fs.readFileSync(path.join(ROOT, 'Install Control Tower.cmd'), 'utf8');
  assert.match(wrapper, /Install Control Tower\.ps1/);

  const mainThreadHook = fs.readFileSync(path.join(ROOT, 'hooks', 'main-thread-pulse.mjs'), 'utf8');
  assert.match(mainThreadHook, /PostToolUse/);
  assert.match(mainThreadHook, /agent-pulse\.log/);

  const installer = fs.readFileSync(path.join(ROOT, 'scripts', 'install.ps1'), 'utf8');
  assert.match(installer, /main-thread-pulse\.mjs/);

  const snippet = fs.readFileSync(path.join(ROOT, 'scripts', 'settings-snippet.json'), 'utf8');
  assert.match(snippet, /PostToolUse/);
  assert.match(snippet, /main-thread-pulse\.mjs/);
});

test('ships a checkpoint progress contract in hooks and setup docs', () => {
  const contract = fs.readFileSync(path.join(ROOT, 'AGENT-PULSE-CONTRACT.md'), 'utf8');
  assert.match(contract, /Plan:\s*4 checkpoints/i);
  assert.match(contract, /Progress:\s*1\/4/i);
  assert.match(contract, /checkpoints/i);

  const setupPrompt = fs.readFileSync(path.join(ROOT, 'SETUP-PROMPT.md'), 'utf8');
  assert.match(setupPrompt, /Plan:\s*<total checkpoints>/i);
  assert.match(setupPrompt, /Progress:\s*<current>\/<total>/i);

  const pulseHook = fs.readFileSync(path.join(ROOT, 'hooks', 'pulse-on-agent-activity.mjs'), 'utf8');
  assert.match(pulseHook, /Plan:/);
  assert.match(pulseHook, /Progress:/);
  assert.match(pulseHook, /checkpoints/);

  const stopHook = fs.readFileSync(path.join(ROOT, 'hooks', 'pulse-enforcer-subagent.mjs'), 'utf8');
  assert.match(stopHook, /Progress:/);
  assert.match(stopHook, /checkpoint/i);
});
