#!/usr/bin/env node
/**
 * worktree-on-agent-spawn — gate hook that blocks any Agent spawn missing
 * isolation: "worktree". Forces every background-agent dispatch to use a
 * separate git worktree so concurrent agents physically cannot clobber
 * each other's parser.js / compiler.js / shared-file edits.
 *
 * Why this rule exists:
 * 2026-05-13 — three agents (Phase 3 / 5 / 6) ran in parallel without
 * worktree isolation. They share the same filesystem on the same branch.
 * Phase 3's compiler.js edits got eaten by a stash/pop; Phase 6's
 * parser.js edits were clobbered by Phase 5; Phase 5 was forced into
 * "batch all 4 cycles into one atomic patch" survival mode. The pulse
 * log captured the whole autopsy. Worktree isolation prevents this
 * class of collision entirely.
 *
 * Opt-out: add NO_WORKTREE to the prompt for genuinely-doesn't-write
 * agents (pure research, read-only exploration, planning).
 *
 * Fail-open on unexpected errors.
 */

import { readFileSync } from 'node:fs';

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }

  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'PreToolUse') {
    process.exit(0);
    return;
  }
  if ((event.tool_name || '') !== 'Agent') {
    process.exit(0);
    return;
  }

  const input = event.tool_input || {};
  const isolation = input.isolation || '';
  const description = input.description || '(unnamed)';
  const prompt = input.prompt || '';

  // Already worktree-isolated — allow.
  if (isolation === 'worktree') {
    process.exit(0);
    return;
  }

  // Explicit opt-out for read-only / planning agents.
  if (/NO_WORKTREE/i.test(prompt)) {
    process.exit(0);
    return;
  }

  const reason = `Agent spawn BLOCKED — "${description}" is missing isolation: "worktree".

Russell's rule (added 2026-05-13 after the Phase 3/5/6 collision disaster): every background-agent dispatch MUST use a separate git worktree so concurrent agents physically cannot clobber each other's shared-file edits (parser.js, compiler.js, intent.md, etc).

Fix one of two ways:
1. (Preferred) Add isolation: "worktree" to your Agent tool call. The agent gets its own git worktree on its own branch; the orchestrator merges back when it completes.
2. If this agent is genuinely read-only (no file writes, pure exploration / research / planning), add the marker NO_WORKTREE anywhere in the prompt to bypass this gate.

Re-attempt the Agent spawn with one of these in place.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

main();
