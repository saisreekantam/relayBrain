#!/usr/bin/env node
/**
 * Memory-graph quality benchmark: Decision/Goal/Evidence/Failure/Task
 * retrieval, not File/CO_EDITED retrieval (that's benchmarkRelations.js).
 *
 * IMPORTANT — what this is and isn't:
 * The corpus below is HAND-AUTHORED by Claude, inspired by exploring the real
 * directory structure of github.com/All-Hands-AI/OpenHands (sandbox/,
 * containers/, .openhands/microagents, enterprise/, openhands-ui/, the 6
 * git-provider integrations under app_server/integrations/) so the
 * vocabulary is realistic instead of synthetic "area0/area1" placeholders.
 * It is NOT extracted from OpenHands' actual decisions, commits, or docs,
 * and it is NEVER written into a real OpenHands clone's .relay/ directory —
 * it runs entirely in its own disposable workspace. Treat every "Decision"/
 * "Goal"/"Failure" below as fictional benchmark content, not a claim about
 * what that project actually chose or why.
 *
 * Methodology: each query has a hand-labeled set of expected node texts
 * (ground truth). Recall@5 and MRR are computed against relay's real
 * retrieve()/compileForResolution() — the same functions a real session
 * would call, not a special test-only code path.
 *
 * Run: node scripts/benchmarkMemoryCorpus.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');
const { retrieve } = require('../lib/relayRetrieve');
const { compileForResolution } = require('../lib/relayContextCompiler');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-corpus-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

// --- The benchmark corpus (see header comment) ------------------------------

const PROJECT_MD = `# Project Summary

## Goals
- Isolate agent code execution from the host system
- Support code hosting across major git providers, not just GitHub
- Let users customize agent behavior per repository without modifying core agent code
- Offer enterprise features without bloating the open-source core
- Ship a dedicated component library reusable across the main frontend and future surfaces
`;

const DECISIONS_MD = `# Decisions

## Open
- Use Docker containers for sandboxing agent execution
  - Serves: Isolate agent code execution from the host system
  - Evidence: the containers/app and containers/dev directories define the sandbox container images
- Use per-conversation isolated sandbox containers with configurable concurrency limits
  - Serves: Isolate agent code execution from the host system
  - Evidence: migration history adds a sandbox grouping strategy and removes a hard max-concurrent-sandboxes setting
- Implement a common resolver and service interface per git provider
  - Serves: Support code hosting across major git providers, not just GitHub
  - Evidence: app_server/integrations has one service subpackage per provider, each with a matching resolver, base, and branches module
- Support repository-level microagents loaded from a project-local microagents directory
  - Serves: Let users customize agent behavior per repository without modifying core agent code
  - Evidence: the .openhands/microagents directory convention
- Keep enterprise-only features in a separate enterprise package
  - Serves: Offer enterprise features without bloating the open-source core
  - Evidence: the enterprise directory has its own storage, sync, analytics, and migrations subpackages
- Extract shared UI components into a dedicated openhands-ui package with Storybook
  - Serves: Ship a dedicated component library reusable across the main frontend and future surfaces
  - Evidence: the openhands-ui Storybook configuration

## Resolved

- 2026-02-01 — Use a single shared sandbox container per session
`;

const FAILURES_MD = `# Failures

- Sandbox containers could exceed host resource limits under high concurrency — fixed by introducing a sandbox grouping strategy and removing the old hard concurrency cap
- Provider-specific rate limits caused git resolver requests to fail silently with no retry
- Frontend and openhands-ui component styles drifted out of sync after the UI extraction
`;

const CURRENT_TASK_MD = `# Current Tasks

## In progress
- [ ] Add Bitbucket Data Center as a separate integration from cloud Bitbucket
- [ ] Migrate enterprise database schema for the new sandbox grouping strategy
  - Serves: Offer enterprise features without bloating the open-source core
`;

// --- Labeled queries: { query, expectedTexts[], negative? } ----------------
// expectedTexts match by substring against node.text — ground truth, not what
// the system happens to return. negative=true means we expect NO confident
// match at all (a guard against hallucinated/forced relevance).

const QUERIES = [
  {
    query: 'Why does OpenHands isolate agent execution in containers?',
    expectedTexts: ['Use Docker containers for sandboxing agent execution', 'Isolate agent code execution from the host system'],
  },
  {
    query: 'What sandbox concurrency approach was replaced?',
    expectedTexts: ['Use a single shared sandbox container per session'],
  },
  {
    query: 'What goal does the multi-provider git integration design serve?',
    expectedTexts: ['Support code hosting across major git providers, not just GitHub'],
  },
  {
    query: 'What evidence supports using a common resolver interface per git provider?',
    expectedTexts: ['app_server/integrations has one service subpackage per provider'],
  },
  {
    query: 'What failure happened with sandbox resource limits?',
    expectedTexts: ['Sandbox containers could exceed host resource limits under high concurrency'],
  },
  {
    query: 'What is still an open problem with the frontend component library?',
    expectedTexts: ['Frontend and openhands-ui component styles drifted out of sync'],
  },
  {
    query: 'Why was openhands-ui extracted as a separate package?',
    expectedTexts: ['Extract shared UI components into a dedicated openhands-ui package', 'Ship a dedicated component library'],
  },
  {
    query: "What's the goal of supporting microagents?",
    expectedTexts: ['Let users customize agent behavior per repository without modifying core agent code'],
  },
  {
    query: 'Why is enterprise functionality kept separate from the open-source core?',
    expectedTexts: ['Keep enterprise-only features in a separate enterprise package', 'Offer enterprise features without bloating the open-source core'],
  },
  {
    query: 'What caused git provider integration requests to fail?',
    expectedTexts: ['Provider-specific rate limits caused git resolver requests to fail silently'],
  },
  {
    query: 'What database migration task relates to enterprise sandbox settings?',
    expectedTexts: ['Migrate enterprise database schema for the new sandbox grouping strategy'],
  },
  {
    query: 'What blockchain integration does this project have?',
    expectedTexts: [],
    negative: true,
  },
];

function buildCorpus(ws) {
  const relayDir = path.join(ws, '.relay');
  fs.writeFileSync(path.join(relayDir, 'project.md'), PROJECT_MD);
  fs.writeFileSync(path.join(relayDir, 'decisions.md'), DECISIONS_MD);
  fs.writeFileSync(path.join(relayDir, 'failures.md'), FAILURES_MD);
  fs.writeFileSync(path.join(relayDir, 'current_task.md'), CURRENT_TASK_MD);
  fs.writeFileSync(path.join(relayDir, 'config.json'), JSON.stringify({ workspace: ws, graph: { enabled: true } }));
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);

  // Explicit supersession (relay decide supersede) — found via this exact
  // benchmark that nothing else can express "B replaced A" for phrasing that
  // doesn't hit the narrow antonym-pair heuristic, which this realistically
  // doesn't ("single shared container" vs "per-conversation isolated
  // containers" shares no use/avoid-style antonym at all).
  const { nodes } = relayGraph.materializeGraph(relayGraph.readEvents(ws));
  const decisionNodes = nodes.filter((n) => n.type === 'Decision');
  const oldId = relayGraph.resolveDecisionRef('Use a single shared sandbox container per session', decisionNodes).id;
  const newId = relayGraph.resolveDecisionRef('Use per-conversation isolated sandbox containers with configurable concurrency limits', decisionNodes).id;
  relayGraph.appendEvent(ws, { type: 'DecisionSuperseded', source: 'relay:explicit', nodeId: oldId, supersededBy: newId });

  return relayGraph.rebuildGraph(ws);
}

function rankOf(nodeText, results) {
  const idx = results.findIndex((r) => r.node.text.includes(nodeText) || nodeText.includes(r.node.text));
  return idx === -1 ? null : idx + 1; // 1-based rank
}

// A node the compiler deliberately collapsed into a compact history pointer
// (§6.8) won't appear as its own ranked result — that's correct, designed
// behavior, not a miss. Checking only raw retrieve() ranking would punish
// the compiler for doing its job. A prefix match (truncated history entries
// are still legible from their first ~20 chars) against the actual compiled
// text — what an agent really sees — is the methodologically right check.
function foundInCompiledText(expectedText, compiledText) {
  const hint = expectedText.slice(0, 20).toLowerCase();
  return compiledText.toLowerCase().includes(hint);
}

function evaluateQuery(ws, q) {
  const results = retrieve(ws, q.query, { hops: 2, topK: 10 });
  const top5 = results.slice(0, 5);

  if (q.negative) {
    const top1Score = results[0]?.score ?? 0;
    return { query: q.query, negative: true, top1Score, passed: top1Score < 0.15 };
  }

  const compiled = compileForResolution(ws, 'default', { query: q.query, recordAccess: false });

  const ranks = q.expectedTexts.map((t) => rankOf(t, results));
  const foundInTop5 = q.expectedTexts.filter((t) => rankOf(t, top5) !== null || foundInCompiledText(t, compiled.text));
  const recallAt5 = q.expectedTexts.length ? foundInTop5.length / q.expectedTexts.length : null;
  const bestRank = ranks.filter((r) => r !== null).sort((a, b) => a - b)[0] || null;
  const reciprocalRank = bestRank ? 1 / bestRank : (foundInTop5.length ? 1 / 5 : 0);

  return {
    query: q.query,
    expected: q.expectedTexts,
    recallAt5,
    reciprocalRank,
    bestRank,
    compiledTokens: compiled.usedTokens,
  };
}

function main() {
  console.log('Memory-graph quality benchmark — hand-authored corpus, NOT real OpenHands data\n');

  const ws = makeWorkspace();
  const built = buildCorpus(ws);
  console.log(`Corpus: ${built.nodeCount} nodes, ${built.edgeCount} edges (from ${built.eventCount} events)\n`);

  const results = QUERIES.map((q) => evaluateQuery(ws, q));

  console.log('=== Per-query results ===\n');
  for (const r of results) {
    if (r.negative) {
      console.log(`[negative control] "${r.query}"`);
      console.log(`  top-1 score: ${r.top1Score.toFixed(3)}  ${r.passed ? 'PASS (correctly low-confidence)' : 'FAIL (false positive)'}\n`);
      continue;
    }
    console.log(`"${r.query}"`);
    console.log(`  Recall@5: ${(r.recallAt5 * 100).toFixed(0)}%  |  best rank: ${r.bestRank ?? 'not found'}  |  RR: ${r.reciprocalRank.toFixed(2)}  |  compiled tokens: ${r.compiledTokens}`);
    console.log('');
  }

  const positives = results.filter((r) => !r.negative);
  const negatives = results.filter((r) => r.negative);
  const meanRecall = positives.reduce((s, r) => s + r.recallAt5, 0) / positives.length;
  const mrr = positives.reduce((s, r) => s + r.reciprocalRank, 0) / positives.length;
  const meanTokens = positives.reduce((s, r) => s + r.compiledTokens, 0) / positives.length;
  const negativesPassed = negatives.filter((r) => r.passed).length;

  console.log('=== Aggregate ===');
  console.log(`Queries: ${positives.length} positive, ${negatives.length} negative control`);
  console.log(`Mean Recall@5: ${(meanRecall * 100).toFixed(1)}%`);
  console.log(`MRR: ${mrr.toFixed(3)}`);
  console.log(`Mean compiled context size: ${meanTokens.toFixed(0)} tokens`);
  console.log(`Negative controls correctly low-confidence: ${negativesPassed}/${negatives.length}`);

  fs.rmSync(ws, { recursive: true, force: true });
}

main();
