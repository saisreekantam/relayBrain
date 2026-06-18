#!/usr/bin/env node
/**
 * Tier 1 of the multi-agent continuation experiment (see chat for the full
 * 2-tier design). Tests the actual claim Relay makes — "a fresh agent
 * invocation can continue real work using the handoff artifact alone" —
 * not retrieval ranking (that's benchmarkComparative*.js).
 *
 * Three arms, same 15 held-out questions, same model:
 *   1. no-context   — the bare question, nothing else.
 *   2. raw-dump      — full, unfiltered text of this real project's own
 *                      .relay/{decisions,current_task,failures,project}.md
 *                      (the v1 "dump everything" behavior).
 *   3. relay-compiled — compileForResolution()'s default-profile output over
 *                       that same real IR, generic/query-less, exactly what
 *                       a real `relay context .` produces at session start.
 *
 * Each arm/question pair is answered by a genuinely fresh, isolated
 * `claude -p --bare` process — no conversation history, no auto-memory, no
 * CLAUDE.md auto-discovery, no filesystem access (no --add-dir). The only
 * information available is whatever's in that arm's constructed prompt.
 * --no-session-persistence keeps these 45 throwaway runs out of normal
 * session history; --max-budget-usd caps spend defensively; --model haiku
 * is deliberate, not a corner cut — the "can't afford pro plans" framing
 * this whole project is built around makes the cheap-model case the
 * actually relevant one to test.
 *
 * Questions and their grading keywords are pinned to this real project's
 * real .relay/ state as of when this script was written (see decisions.md/
 * current_task.md/failures.md/project.md history around the relay-os npm
 * publish and OrbitOS/Conductor hackathon reframe). If that real content
 * changes substantially, the keyword sets will need revisiting — this is
 * a snapshot benchmark, not a self-updating one.
 *
 * Grading is mechanical (case-insensitive keyword containment), not an
 * LLM judge — same "deterministic over inferred" preference as the rest of
 * this codebase's heuristics. Score per question = fraction of that
 * question's keywords found in the response; pass = score >= 0.5.
 *
 * Run: node scripts/agentHandoffExperiment.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const relayGraph = require('../lib/relayGraph');
const { compileForResolution, estimateTokens } = require('../lib/relayContextCompiler');

const PROJECT_ROOT = path.join(__dirname, '..', '..'); // relayBrain/
const RELAY_DIR = path.join(PROJECT_ROOT, '.relay');
const IR_FILES = ['project.md', 'decisions.md', 'current_task.md', 'failures.md'];

const MODEL = 'haiku';
const MAX_BUDGET_USD = '0.20';

// --- 15 held-out questions, real facts, real grading keywords -------------

const QA_SET = [
  { q: 'Why did the first npm publish attempt for relay-os fail?', keywords: ['403', '2fa', 'two-factor', 'bypass 2fa', 'granular access token'] },
  { q: 'What alternative package name was considered for relay-os, and was it adopted?', keywords: ['relay-brain', 'rejected', 'no rename', 'decided against', 'kept'] },
  { q: 'What discrepancy was found with the npm pack tarball during a real publish attempt, and is it resolved?', keywords: ['node_modules', 'unresolved', 'dry-run', 'discrepancy'] },
  { q: 'What crashed the API server during Mission Control development, and was it a real code bug?', keywords: ['uiport', 'duplicate', 'server.js', 'crashed'] },
  { q: "Was the 'relay serve' interruption seen during background testing a real code bug?", keywords: ['not a code bug', 'terminal', 'health check'] },
  { q: 'Why can’t Cursor, Copilot, or Antigravity agents run directly from the Mission Control browser UI?', keywords: ['ide', 'cli', 'required', 'browser'] },
  { q: 'What environment variable must be set for `relay mcp` to use the correct working directory?', keywords: ['relay_workspace_path'] },
  { q: 'What does `relay init` do differently from `relay serve` regarding the UI?', keywords: ['background', 'foreground', 'no-serve'] },
  { q: 'What is the difference between `relay watch` and `relay refresh`?', keywords: ['sync', 'compile', 'context'] },
  { q: "What is the new strategic codename for OrbitOS's agentic layer, decided during the hackathon?", keywords: ['conductor', 'autonomous', 'orchestration', 'control plane', 'additive'] },
  { q: 'Does Mission Control support GitHub OAuth or team accounts?', keywords: ['local-only', 'removed', 'nextauth', 'no'] },
  { q: 'What existing primitives does the planned Conductor feature plan to reuse, instead of building new ones?', keywords: ['spawnsync', 'callllm', 'memory.timeline', 'relaycompileir'] },
  { q: "Where is Mission Control's collaborators and chat data stored?", keywords: ['mission_control.json'] },
  { q: 'Does Relay require MongoDB or Redis to run?', keywords: ['no', 'sqlite3', 'optional'] },
  { q: "What does Mission Control's UI show when the IR appears empty because the API is offline?", keywords: ['hint', 'relay serve', 'relay init', 'offline'] },
];

// --- Context construction ----------------------------------------------

function readRealIR() {
  const out = {};
  for (const f of IR_FILES) out[f] = fs.readFileSync(path.join(RELAY_DIR, f), 'utf-8');
  return out;
}

function buildRawDump(ir) {
  return IR_FILES.map((f) => `## ${f}\n\n${ir[f]}`).join('\n\n---\n\n');
}

function buildRelayCompiled(ir) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-handoff-experiment-'));
  const relayDir = path.join(ws, '.relay');
  fs.mkdirSync(relayDir, { recursive: true });
  for (const f of IR_FILES) fs.writeFileSync(path.join(relayDir, f), ir[f]);
  fs.writeFileSync(path.join(relayDir, 'config.json'), JSON.stringify({ workspace: ws, graph: { enabled: true } }));

  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);
  // Generic, query-less compile — exactly what a real `relay context .`
  // produces at session start, not a per-question cherry-picked retrieval.
  const compiled = compileForResolution(ws, 'default', { query: '', recordAccess: false });

  fs.rmSync(ws, { recursive: true, force: true });
  return compiled.text;
}

// --- Running a fresh, isolated agent -----------------------------------

function buildPrompt(contextBlock, question) {
  const contextSection = contextBlock
    ? `Here is some context about the project:\n\n${contextBlock}\n\n`
    : '';
  return `You are continuing work on a software project called Relay (npm package relay-os, also referred to as OrbitOS).\n\n${contextSection}Based ONLY on the context given above (if any), answer the following question as concisely as possible. If the context provided doesn't contain the answer, say "I don't know" rather than guessing.\n\nQuestion: ${question}`;
}

function askFreshAgent(prompt) {
  try {
    const out = execSync(
      `claude -p --bare --model ${MODEL} --no-session-persistence --max-budget-usd ${MAX_BUDGET_USD}`,
      { input: prompt, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 8, timeout: 60000 },
    );
    return out.trim();
  } catch (err) {
    return `[error invoking claude -p: ${err.message}]`;
  }
}

function grade(response, keywords) {
  const lower = response.toLowerCase();
  const matched = keywords.filter((k) => lower.includes(k.toLowerCase()));
  return { score: matched.length / keywords.length, matched, missed: keywords.filter((k) => !matched.includes(k)) };
}

// --- Main ----------------------------------------------------------------

async function main() {
  console.log('Tier 1: agent handoff experiment — real facts from this project\'s real .relay/ state\n');

  const ir = readRealIR();
  const rawDump = buildRawDump(ir);
  const relayCompiled = buildRelayCompiled(ir);

  const ARMS = {
    noContext: { label: 'no-context', context: null },
    rawDump: { label: 'raw-dump (v1)', context: rawDump },
    relayCompiled: { label: 'relay-compiled (v2)', context: relayCompiled },
  };

  for (const [key, arm] of Object.entries(ARMS)) {
    arm.tokens = arm.context ? estimateTokens(arm.context) : 0;
  }

  console.log('Context size per arm:');
  for (const arm of Object.values(ARMS)) console.log(`  ${arm.label.padEnd(20)} ${arm.tokens} tokens`);
  console.log(`\nRunning ${QA_SET.length} questions x ${Object.keys(ARMS).length} arms = ${QA_SET.length * Object.keys(ARMS).length} fresh agent invocations (model: ${MODEL})...\n`);

  const results = Object.fromEntries(Object.keys(ARMS).map((k) => [k, []]));

  for (const [qi, { q, keywords }] of QA_SET.entries()) {
    console.log(`[${qi + 1}/${QA_SET.length}] ${q}`);
    for (const [key, arm] of Object.entries(ARMS)) {
      const prompt = buildPrompt(arm.context, q);
      const response = askFreshAgent(prompt);
      const graded = grade(response, keywords);
      results[key].push(graded);
      console.log(`   ${arm.label.padEnd(20)} score: ${(graded.score * 100).toFixed(0)}%  ${graded.score >= 0.5 ? 'PASS' : 'FAIL'}`);
    }
  }

  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

  console.log('\n=== Aggregate ===');
  for (const [key, arm] of Object.entries(ARMS)) {
    const scores = results[key].map((r) => r.score);
    const passRate = results[key].filter((r) => r.score >= 0.5).length / results[key].length;
    console.log(`${arm.label.padEnd(20)} mean score: ${(mean(scores) * 100).toFixed(1)}%   pass rate: ${(passRate * 100).toFixed(1)}%   context: ${arm.tokens} tokens`);
  }

  console.log('\n=== Information loss detail (keywords missed per question, relay-compiled arm) ===');
  QA_SET.forEach((qa, i) => {
    const r = results.relayCompiled[i];
    if (r.missed.length) console.log(`  "${qa.q.slice(0, 60)}..." missed: ${r.missed.join(', ')}`);
  });
}

main();
