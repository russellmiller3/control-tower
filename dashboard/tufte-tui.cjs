#!/usr/bin/env node
const DEFAULT_STATE_URL = 'http://127.0.0.1:9999/api/state';
const LEFT_WIDTH = 62;
const RIGHT_WIDTH = 31;

function cleanCell(cellContent, width) {
  const normalizedContent = String(cellContent ?? '').replace(/\s+/g, ' ').trim();
  if (normalizedContent.length <= width) return normalizedContent.padEnd(width, ' ');
  return normalizedContent.slice(0, Math.max(0, width - 1)) + '.';
}

function normalizeCopy(copy) {
  return String(copy ?? '').replace(/\s+/g, ' ').trim();
}

function padLine(lineContent, width) {
  const rawLine = String(lineContent ?? '');
  if (rawLine.length <= width) return rawLine.padEnd(width, ' ');
  return rawLine.slice(0, Math.max(0, width - 1)) + '.';
}

function wrapCopy(copy, width) {
  const words = normalizeCopy(copy).split(' ').filter(Boolean);
  const wrappedLines = [];
  let currentLine = '';
  for (const word of words) {
    const candidateLine = currentLine ? currentLine + ' ' + word : word;
    if (candidateLine.length <= width) {
      currentLine = candidateLine;
    } else {
      if (currentLine) wrappedLines.push(currentLine);
      currentLine = word.length > width ? word.slice(0, width - 1) + '.' : word;
    }
  }
  if (currentLine) wrappedLines.push(currentLine);
  return wrappedLines.length ? wrappedLines : [''];
}

function combineColumns(leftLines, rightLines) {
  const rowCount = Math.max(leftLines.length, rightLines.length);
  const renderedRows = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    renderedRows.push(padLine(leftLines[rowIndex] || '', LEFT_WIDTH) + '  ' + (rightLines[rowIndex] || ''));
  }
  return renderedRows;
}

function formatCost(costUsd) {
  const spend = Number(costUsd || 0);
  return '$' + spend.toFixed(spend >= 10 ? 0 : 2);
}

function formatTokens(tokenCount) {
  const count = Number(tokenCount || 0);
  if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
  if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
  return String(count);
}

function needsSupervisor(agent) {
  return agent.state === 'silent' || agent.state === 'dormant' || agent.state === 'failed';
}

function checkpointLabel(agent) {
  return agent && agent.progress && agent.progress.summary
    ? agent.progress.summary
    : 'no checkpoints';
}

function latestPulseLine(agent) {
  return agent.lastEmitText || (agent.events && agent.events[0] && agent.events[0].text) || agent.goal || 'No pulse yet.';
}

function agentLedgerLines(agent, ordinal) {
  const ledgerLines = [
    String(ordinal + 1).padStart(2, '0') + '  ' + normalizeCopy(agent.task || 'untitled'),
    '    ' + normalizeCopy(agent.state || 'unknown') + ' / ' + normalizeCopy(agent.sourceLabel || 'Agent') + '    ' + checkpointLabel(agent),
  ];
  for (const pulseLine of wrapCopy(latestPulseLine(agent), LEFT_WIDTH - 4)) {
    ledgerLines.push('    ' + pulseLine);
  }
  if (agent.goal) {
    for (const goalLine of wrapCopy('goal: ' + agent.goal, LEFT_WIDTH - 4)) {
      ledgerLines.push('    ' + goalLine);
    }
  }
  return ledgerLines;
}

function marginNoteLines(label, count, detail) {
  const noteLines = [
    cleanCell(label, 20) + cleanCell(count, 8),
  ];
  for (const detailLine of wrapCopy(detail, RIGHT_WIDTH)) {
    noteLines.push(detailLine);
  }
  return noteLines;
}

function renderTufteTerminal(statePayload) {
  const agentList = Array.isArray(statePayload.agents) ? statePayload.agents : [];
  const workingCount = agentList.filter((agent) => agent.state === 'working').length;
  const supervisorCount = agentList.filter(needsSupervisor).length;
  const completedCount = agentList.filter((agent) => agent.state === 'completed').length;
  const totalCount = agentList.length;
  const marginLines = [
    'margin notes',
    '-'.repeat(RIGHT_WIDTH),
    ...marginNoteLines('needs supervisor', supervisorCount, totalCount ? supervisorCount + ' of ' + totalCount + ' lanes' : 'no lanes yet'),
    '',
    ...marginNoteLines('working now', workingCount, 'live pulses still arriving'),
    '',
    ...marginNoteLines('spend seen', formatCost(statePayload.costUsdTotal || 0), formatTokens(statePayload.tokensTotal || 0) + ' tokens'),
  ];
  const ledgerLines = [
    'ledger',
    '-'.repeat(LEFT_WIDTH),
  ];

  if (!agentList.length) {
    ledgerLines.push('00  waiting for first pulse');
    ledgerLines.push('    Start agents to see terminal traffic.');
  } else {
    for (const [agentIndex, agent] of agentList.slice(0, 8).entries()) {
      if (agentIndex > 0) ledgerLines.push('');
      ledgerLines.push(...agentLedgerLines(agent, agentIndex));
    }
  }

  const terminalLines = [
    cleanCell('TUFTE TUI', LEFT_WIDTH) + '  control-tower --live --plain-english',
    'Evidence first, ornament last.',
    'branch ' + (statePayload.branch || 'unknown') + '    agents ' + totalCount + '    working ' + workingCount + '    needs supervisor ' + supervisorCount + '    ready ' + completedCount,
    '',
    ...combineColumns(ledgerLines, marginLines),
  ];

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
