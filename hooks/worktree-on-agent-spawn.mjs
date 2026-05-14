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

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Scan a directory for child git repos. Returns the set of repo paths.
 * Skips dot-directories and node_modules. One level deep — that's enough
 * for the ~/Desktop/programming/ shape (Clear, Lenat, Lenat-clear all
 * sit as sibling directories at depth 1).
 */
function findChildGitRepos(parentDir) {
  const repos = new Set();
  if (!existsSync(parentDir)) return repos;
  let entries = [];
  try { entries = readdirSync(parentDir); } catch { return repos; }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const childPath = join(parentDir, name);
    try {
      if (!statSync(childPath).isDirectory()) continue;
      if (existsSync(join(childPath, '.git'))) repos.add(childPath);
    } catch {}
  }
  return repos;
}

/**
 * Detect whether the prompt indicates the agent will WRITE files in a
 * specific repo. We look for "work in <path>" or "work exclusively in
 * <path>" patterns. If the path resolves to a git repo, this agent is
 * a same-repo write-agent and must NOT use NO_WORKTREE — the agent's
 * `git checkout -b` will switch the parent's working tree.
 */
function detectTargetRepo(prompt, parentCwd) {
  // Match patterns: "work in `<path>`", "work exclusively in `<path>`",
  // "in `<path>`", "branch off `<branch>` on <repoName>", and explicit
  // path mentions. We try the most specific patterns first.
  const patterns = [
    /work(?:\s+exclusively)?\s+in\s+`?([^`\s]+)`?/i,
    /in\s+`(C:\/Users\/[^`]+)`/i,
  ];
  for (const re of patterns) {
    const m = prompt.match(re);
    if (m) {
      const p = m[1].replace(/^['"]|['"]$/g, '');
      // Resolve against parent cwd or as absolute
      const resolved = p.startsWith('C:') || p.startsWith('/') ? p : resolve(parentCwd, p);
      try {
        if (existsSync(join(resolved, '.git'))) return resolved;
      } catch {}
    }
  }
  return null;
}

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
    // TIGHTENED 2026-05-14: NO_WORKTREE is fine for genuinely-different-repo
    // agents but NOT for agents that write to the SAME repo as the parent.
    // The agent's `git checkout -b <branch>` switches the parent's working
    // tree, causing exactly the collision that worktree isolation was meant
    // to prevent. Refuse NO_WORKTREE when the agent's brief targets a repo
    // that's a sibling of the parent's cwd (the ~/programming/ case where
    // parent cwd is not a repo but contains Clear, Lenat, Lenat-clear).
    const parentCwd = event.cwd || process.cwd();
    const parentIsRepo = existsSync(join(parentCwd, '.git'));
    const childRepos = parentIsRepo ? new Set([parentCwd]) : findChildGitRepos(parentCwd);
    const targetRepo = detectTargetRepo(prompt, parentCwd);

    // If the agent targets a repo that's accessible from the parent's cwd
    // (either parent itself or a sibling), the agent's git operations will
    // hit a working tree the parent ALSO sees. Refuse NO_WORKTREE here.
    if (targetRepo) {
      const targetResolved = resolve(targetRepo);
      const collisionRepo = [...childRepos].find(r => resolve(r) === targetResolved);
      if (collisionRepo) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Agent spawn BLOCKED — "${description}" uses NO_WORKTREE but the brief says it works in \`${targetRepo}\`, which is accessible from the parent conversation's cwd (\`${parentCwd}\`). The agent's \`git checkout -b\` will switch the parent's working tree out from under main thread — that's exactly the collision worktree isolation was meant to prevent.

Fix one of three ways:
1. (Preferred) Add isolation: "worktree" — but this requires the parent's cwd to BE a git repo OR have a WorktreeCreate hook configured. If parent cwd is a directory containing multiple repos, neither works today.
2. Have the agent target a repo that is NOT a sibling of the parent's cwd (e.g. work in a temp clone or an unrelated repo).
3. Pause main thread on that repo's working tree, run the agent serially, then resume. Acceptable when the parallelism wasn't going to save real time anyway.

If you're sure the collision risk is managed (rare — most often this is wishful thinking), the only escape is to comment out this block. Don't.`,
          },
        }));
        process.exit(0);
        return;
      }
    }
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
