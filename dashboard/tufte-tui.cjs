#!/usr/bin/env node
const DEFAULT_STATE_URL = 'http://127.0.0.1:9999/api/state';

function cleanCell(cellContent, width) {
  const normalizedContent = String(cellContent || '').replace(/\s+/g, ' ').trim();
  if (normalizedContent.length <= width) return normalizedContent.padEnd(width, ' ');
  return normalizedContent.slice(0, Math.max(0, width - 1)) + '.';
}

function checkpointLabel(agent) {
  return agent && agent.progress && agent.progress.summary
    ? agent.progress.summary
    : 'no checkpoints';
}

function latestPulseLine(agent) {
  return agent.lastEmitText || (agent.events && agent.events[0] && agent.events[0].text) || agent.goal || 'No pulse yet.';
}

function agentLine(agent, ordinal) {
  return [
    String(ordinal + 1).padStart(2, '0'),
    cleanCell(agent.state || 'unknown', 10),
    cleanCell(agent.sourceLabel || 'Agent', 8),
    cleanCell(agent.task || 'untitled', 24),
    cleanCell(checkpointLabel(agent), 17),
    cleanCell(latestPulseLine(agent), 48),
  ].join('  ');
}

function renderTufteTerminal(statePayload) {
  const agentList = Array.isArray(statePayload.agents) ? statePayload.agents : [];
  const workingCount = agentList.filter((agent) => agent.state === 'working').length;
  const quietCount = agentList.filter((agent) => agent.state === 'silent' || agent.state === 'dormant').length;
  const completedCount = agentList.filter((agent) => agent.state === 'completed').length;
  const terminalLines = [
    'TUFTE TUI',
    'branch ' + (statePayload.branch || 'unknown') + '    agents ' + agentList.length + '    working ' + workingCount + '    quiet ' + quietCount + '    ready ' + completedCount,
    '',
    ' #  state       source    task                      checkpoint         latest pulse',
    '--  ----------  --------  ------------------------  -----------------  ------------------------------------------------',
  ];

  if (!agentList.length) {
    terminalLines.push('00  waiting     Agent     no live lanes             no checkpoints    Start agents to see terminal traffic.');
  } else {
    for (const [agentIndex, agent] of agentList.slice(0, 12).entries()) {
      terminalLines.push(agentLine(agent, agentIndex));
    }
  }

  terminalLines.push('');
  terminalLines.push('margin notes');
  terminalLines.push('- Interrupt only when quiet is non-zero.');
  terminalLines.push('- Review completed lanes before merging.');
  for (const agent of agentList.slice(0, 4)) {
    terminalLines.push('- ' + (agent.task || 'untitled') + ': ' + (agent.goal || latestPulseLine(agent)));
  }

  return terminalLines.join('\n');
}

function demoTerminalState() {
  return {
    branch: 'demo/control-tower',
    agents: [
      {
        task: 'Auth cleanup',
        state: 'working',
        sourceLabel: 'Codex',
        progress: { summary: '2/4 checkpoints' },
        goal: 'Keep the launch branch clean while the review runs.',
        lastEmitText: 'Progress: 2/4 - Tests are green and browser proof is next.',
      },
      {
        task: 'Docs pass',
        state: 'completed',
        sourceLabel: 'Claude',
        progress: { summary: '4/4 checkpoints' },
        goal: 'Make the setup path readable.',
        lastEmitText: 'All remaining checks passed.',
      },
    ],
  };
}

async function readLiveState(stateUrl) {
  const httpReply = await fetch(stateUrl);
  if (!httpReply.ok) {
    throw new Error('State endpoint returned ' + httpReply.status);
  }
  return httpReply.json();
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const demoRequested = cliArgs.includes('--demo');
  const urlFlagIndex = cliArgs.indexOf('--url');
  const stateUrl = urlFlagIndex >= 0 && cliArgs[urlFlagIndex + 1]
    ? cliArgs[urlFlagIndex + 1]
    : DEFAULT_STATE_URL;
  const statePayload = demoRequested ? demoTerminalState() : await readLiveState(stateUrl);
  process.stdout.write(renderTufteTerminal(statePayload) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('Tufte TUI failed: ' + err.message + '\n');
    process.exit(1);
  });
}

module.exports = { renderTufteTerminal, demoTerminalState };
