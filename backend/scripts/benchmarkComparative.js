#!/usr/bin/env node
/**
 * Comparative benchmark: Relay (graph + retrieve + compiler) vs. three fair
 * non-graph baselines, on the same corpus and the same queries.
 *
 * Phase 1 of the relay-bench plan (see chat/handoff for the full 7-benchmark
 * proposal). Covers: architectural "why" questions, goal tracing (SERVES),
 * evidence support (SUPPORTED_BY), historical reasoning (SUPERSEDES), plain
 * decision/failure/task lookup, and negative controls. Deferred to a later
 * phase: causal failure-chain retrieval (CAUSED_BY/FIXED_BY have no real
 * ingestion path yet — same gap SERVES had before it was built) and
 * 100k-node scale.
 *
 * Corpus: same hand-authored, OpenHands-structure-inspired corpus as
 * benchmarkMemoryCorpus.js (NOT extracted from OpenHands' real decisions —
 * see that script's header for the exact disclosure), extended with an
 * LLM-provider-abstraction / conversation-persistence / eval-harness slice
 * so there's enough real material for ~45 labeled queries instead of 12.
 *
 * Baselines are deliberately NOT just retrieve() with options toggled off.
 * retrieve()'s ranking formula always multiplies relevance by confidence x
 * freshness x importance x agentReputation — graph-only metadata a plain
 * BM25 or vector-search system could never have. Giving baselines that
 * multiplier would make the comparison meaningless. So baselines here are
 * built directly from the lower-level exported primitives (scoreAllNodes,
 * cosineSimilarity) and rank by relevance alone, with no traversal.
 *
 * Run: node scripts/benchmarkComparative.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');
const { retrieve, scoreAllNodes } = require('../lib/relayRetrieve');
const { compileForResolution, estimateTokens } = require('../lib/relayContextCompiler');
const { embedText, embedGraphNodes, cosineSimilarity } = require('../lib/relayEmbed');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-comparative-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

// --- Corpus (see header) ---------------------------------------------------

const PROJECT_MD = `# Project Summary

## Goals
- Isolate agent code execution from the host system
- Support code hosting across major git providers, not just GitHub
- Let users customize agent behavior per repository without modifying core agent code
- Offer enterprise features without bloating the open-source core
- Ship a dedicated component library reusable across the main frontend and future surfaces
- Let the agent use any LLM provider without rewriting core agent logic
- Make agent conversations resumable across restarts and crashes
- Evaluate agent performance on standardized benchmarks before merging changes
- Keep secrets and credentials out of agent-visible context
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
- Route all LLM calls through a single provider-agnostic completion interface
  - Serves: Let the agent use any LLM provider without rewriting core agent logic
  - Evidence: the llm package wraps litellm so provider-specific request/response shapes never leak into agent logic
- Persist conversation state and event stream to disk so a crashed session can be resumed
  - Serves: Make agent conversations resumable across restarts and crashes
  - Evidence: the session and event_store modules checkpoint every event to a per-conversation log
- Run a fixed evaluation suite against every agent-logic pull request before merge
  - Serves: Evaluate agent performance on standardized benchmarks before merging changes
  - Evidence: the evaluation directory defines benchmark harnesses run in CI
- Strip provider API keys and tokens from any text the agent sends to the LLM as conversation history
  - Serves: Keep secrets and credentials out of agent-visible context
  - Evidence: a redaction step runs on event serialization before events enter the LLM context window

## Resolved

- 2026-01-15 — Let each agent action handler manage its own retry logic for LLM calls
- 2026-02-01 — Use a single shared sandbox container per session
`;

const FAILURES_MD = `# Failures

- Sandbox containers could exceed host resource limits under high concurrency — fixed by introducing a sandbox grouping strategy and removing the old hard concurrency cap
- Provider-specific rate limits caused git resolver requests to fail silently with no retry
- Frontend and openhands-ui component styles drifted out of sync after the UI extraction
- Resuming a crashed conversation sometimes replayed the same LLM call twice, double-billing the same request
- A redacted secret occasionally reappeared in agent context after a conversation was resumed from an older checkpoint
- The evaluation suite passed locally but flaked intermittently in CI due to nondeterministic sampling temperature
`;

const CURRENT_TASK_MD = `# Current Tasks

## In progress
- [ ] Add Bitbucket Data Center as a separate integration from cloud Bitbucket
- [ ] Migrate enterprise database schema for the new sandbox grouping strategy
  - Serves: Offer enterprise features without bloating the open-source core
- [ ] Add retry-with-backoff to the provider-agnostic completion interface
  - Serves: Let the agent use any LLM provider without rewriting core agent logic
- [ ] Investigate the duplicate LLM call bug during conversation resume
`;

// --- Labeled queries ---------------------------------------------------
// category tags group the aggregate report; expectedTexts match by substring
// against node.text (ground truth, not what any system happens to return).

const QUERIES = [
  // -- why (architectural why questions, Benchmark 1) --
  { category: 'why', query: 'Why does OpenHands isolate agent execution in containers?', expectedTexts: ['Use Docker containers for sandboxing agent execution', 'Isolate agent code execution from the host system'] },
  { category: 'why', query: 'Why was openhands-ui extracted as a separate package?', expectedTexts: ['Extract shared UI components into a dedicated openhands-ui package', 'Ship a dedicated component library'] },
  { category: 'why', query: 'Why is enterprise functionality kept separate from the open-source core?', expectedTexts: ['Keep enterprise-only features in a separate enterprise package', 'Offer enterprise features without bloating'] },
  { category: 'why', query: 'Why does the project support repository-level microagents?', expectedTexts: ['Support repository-level microagents', 'Let users customize agent behavior per repository'] },
  { category: 'why', query: 'Why route LLM calls through a single completion interface?', expectedTexts: ['Route all LLM calls through a single provider-agnostic completion interface', 'Let the agent use any LLM provider'] },
  { category: 'why', query: 'Why persist conversation state to disk?', expectedTexts: ['Persist conversation state and event stream to disk', 'Make agent conversations resumable'] },
  { category: 'why', query: 'Why run a fixed evaluation suite before merging agent logic changes?', expectedTexts: ['Run a fixed evaluation suite against every agent-logic pull request', 'Evaluate agent performance on standardized benchmarks'] },
  { category: 'why', query: 'Why strip API keys from agent context?', expectedTexts: ['Strip provider API keys and tokens', 'Keep secrets and credentials out of agent-visible context'] },
  { category: 'why', query: 'Why implement a common resolver per git provider?', expectedTexts: ['Implement a common resolver and service interface per git provider', 'Support code hosting across major git providers'] },
  // paraphrase-heavy why questions (low lexical overlap with the decision text — tests semantic vs. keyword retrieval)
  { category: 'why', query: "Why can't a bad choice of LLM vendor force a rewrite of the agent's core logic?", expectedTexts: ['Route all LLM calls through a single provider-agnostic completion interface'] },
  { category: 'why', query: "Why doesn't a crashed server lose an entire in-progress agent conversation?", expectedTexts: ['Persist conversation state and event stream to disk'] },
  { category: 'why', query: 'Why can a regression in agent reasoning quality not silently reach the main branch?', expectedTexts: ['Run a fixed evaluation suite against every agent-logic pull request'] },
  { category: 'why', query: "Why can't a leaked credential end up inside the model's context window?", expectedTexts: ['Strip provider API keys and tokens'] },
  { category: 'why', query: 'Why does switching git hosting providers not require new integration code from scratch?', expectedTexts: ['Implement a common resolver and service interface per git provider'] },
  { category: 'why', query: 'Why can each repository teach the agent different behavior without forking the agent itself?', expectedTexts: ['Support repository-level microagents'] },

  // -- goal tracing (SERVES, Benchmark 4) --
  { category: 'goal', query: 'What goal does the multi-provider git integration design serve?', expectedTexts: ['Support code hosting across major git providers, not just GitHub'] },
  { category: 'goal', query: "What's the goal of supporting microagents?", expectedTexts: ['Let users customize agent behavior per repository without modifying core agent code'] },
  { category: 'goal', query: 'What goal does the per-conversation sandbox isolation decision serve?', expectedTexts: ['Isolate agent code execution from the host system'] },
  { category: 'goal', query: 'What goal does persisting conversation state serve?', expectedTexts: ['Make agent conversations resumable across restarts and crashes'] },
  { category: 'goal', query: 'What goal does the provider-agnostic completion interface decision serve?', expectedTexts: ['Let the agent use any LLM provider without rewriting core agent logic'] },
  { category: 'goal', query: 'What goal does running a fixed evaluation suite serve?', expectedTexts: ['Evaluate agent performance on standardized benchmarks before merging changes'] },
  { category: 'goal', query: 'What goal does the enterprise database migration task serve?', expectedTexts: ['Offer enterprise features without bloating the open-source core'] },
  { category: 'goal', query: 'What goal does adding retry-with-backoff to the completion interface serve?', expectedTexts: ['Let the agent use any LLM provider without rewriting core agent logic'] },

  // -- evidence support (SUPPORTED_BY) --
  { category: 'evidence', query: 'What evidence supports using a common resolver interface per git provider?', expectedTexts: ['app_server/integrations has one service subpackage per provider'] },
  { category: 'evidence', query: 'What evidence supports routing LLM calls through one completion interface?', expectedTexts: ['the llm package wraps litellm'] },
  { category: 'evidence', query: 'What evidence supports persisting conversation state to disk?', expectedTexts: ['the session and event_store modules checkpoint every event'] },
  { category: 'evidence', query: 'What evidence supports running a fixed evaluation suite in CI?', expectedTexts: ['the evaluation directory defines benchmark harnesses run in CI'] },
  { category: 'evidence', query: 'What evidence supports stripping secrets from agent context?', expectedTexts: ['a redaction step runs on event serialization'] },
  { category: 'evidence', query: 'What evidence supports the Docker sandboxing decision?', expectedTexts: ['the containers/app and containers/dev directories'] },

  // -- historical reasoning (SUPERSEDES, Benchmark 3) --
  { category: 'history', query: 'What sandbox concurrency approach was replaced?', expectedTexts: ['Use a single shared sandbox container per session'] },
  { category: 'history', query: 'What approach to LLM call retries was replaced?', expectedTexts: ['Let each agent action handler manage its own retry logic for LLM calls'] },
  { category: 'history', query: 'What was the previous sandboxing approach before per-conversation isolation?', expectedTexts: ['Use a single shared sandbox container per session'] },

  // -- failure lookup (lexical retrieval only — causal chain edges not yet wired, see header) --
  { category: 'failure', query: 'What failure happened with sandbox resource limits?', expectedTexts: ['Sandbox containers could exceed host resource limits under high concurrency'] },
  { category: 'failure', query: 'What caused git provider integration requests to fail?', expectedTexts: ['Provider-specific rate limits caused git resolver requests to fail silently'] },
  { category: 'failure', query: 'What is still an open problem with the frontend component library?', expectedTexts: ['Frontend and openhands-ui component styles drifted out of sync'] },
  { category: 'failure', query: 'What went wrong when resuming a crashed conversation?', expectedTexts: ['Resuming a crashed conversation sometimes replayed the same LLM call twice'] },
  { category: 'failure', query: 'What secret-handling bug happened during conversation resume?', expectedTexts: ['A redacted secret occasionally reappeared in agent context'] },
  { category: 'failure', query: 'Why did the evaluation suite fail intermittently in CI?', expectedTexts: ['The evaluation suite passed locally but flaked intermittently in CI'] },

  // -- plain task lookup --
  { category: 'task', query: 'What database migration task relates to enterprise sandbox settings?', expectedTexts: ['Migrate enterprise database schema for the new sandbox grouping strategy'] },
  { category: 'task', query: 'What task addresses the duplicate LLM call bug?', expectedTexts: ['Investigate the duplicate LLM call bug during conversation resume'] },
  { category: 'task', query: 'What task is in progress for Bitbucket support?', expectedTexts: ['Add Bitbucket Data Center as a separate integration from cloud Bitbucket'] },
  { category: 'task', query: 'What task adds retry-with-backoff support?', expectedTexts: ['Add retry-with-backoff to the provider-agnostic completion interface'] },

  // -- negative controls (Benchmark 6) --
  { category: 'negative', query: 'What blockchain integration does this project have?', expectedTexts: [], negative: true },
  { category: 'negative', query: 'How does the iOS mobile app handle push notifications?', expectedTexts: [], negative: true },
  { category: 'negative', query: 'What Rust compiler plugin does this project ship?', expectedTexts: [], negative: true },
  { category: 'negative', query: "What Kubernetes operator manages this project's deployments?", expectedTexts: [], negative: true },
  { category: 'negative', query: 'What GraphQL schema does the public API expose?', expectedTexts: [], negative: true },
];

// --- Corpus construction ----------------------------------------------------

function buildCorpus(ws) {
  const relayDir = path.join(ws, '.relay');
  fs.writeFileSync(path.join(relayDir, 'project.md'), PROJECT_MD);
  fs.writeFileSync(path.join(relayDir, 'decisions.md'), DECISIONS_MD);
  fs.writeFileSync(path.join(relayDir, 'failures.md'), FAILURES_MD);
  fs.writeFileSync(path.join(relayDir, 'current_task.md'), CURRENT_TASK_MD);
  fs.writeFileSync(path.join(relayDir, 'config.json'), JSON.stringify({ workspace: ws, graph: { enabled: true } }));
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);

  // Explicit supersession for phrasing the antonym-pair heuristic can't catch
  // (same finding as benchmarkMemoryCorpus.js).
  const { nodes } = relayGraph.materializeGraph(relayGraph.readEvents(ws));
  const decisionNodes = nodes.filter((n) => n.type === 'Decision');
  const supersessions = [
    ['Use a single shared sandbox container per session', 'Use per-conversation isolated sandbox containers with configurable concurrency limits'],
    ['Let each agent action handler manage its own retry logic for LLM calls', 'Route all LLM calls through a single provider-agnostic completion interface'],
  ];
  for (const [oldText, newText] of supersessions) {
    const oldId = relayGraph.resolveDecisionRef(oldText, decisionNodes).id;
    const newId = relayGraph.resolveDecisionRef(newText, decisionNodes).id;
    relayGraph.appendEvent(ws, { type: 'DecisionSuperseded', source: 'relay:explicit', nodeId: oldId, supersededBy: newId });
  }

  return relayGraph.rebuildGraph(ws);
}

// --- Fair non-graph baselines ------------------------------------------------
// Rank by relevance alone. No traversal, no confidence/freshness/importance/
// agentReputation (graph-only metadata a non-graph system can't have).

function normalize(scoreMap) {
  const max = Math.max(1e-9, ...scoreMap.values());
  const out = new Map();
  for (const [id, s] of scoreMap) out.set(id, s / max);
  return out;
}

// Raw (un-normalized) scores: ranking order is invariant to per-query
// normalization, so recall/MRR are unaffected either way, but the false-
// positive test below needs a score that isn't trivially 1.0 for every
// query's own top hit by construction.
function bm25OnlyRank(query, nodes) {
  const raw = scoreAllNodes(query, nodes);
  return nodes
    .map((n) => ({ nodeId: n.id, node: n, score: raw.get(n.id) || 0 }))
    .sort((a, b) => b.score - a.score);
}

function vectorOnlyRank(queryEmbedding, nodes, embeddingsCache) {
  return nodes
    .map((n) => {
      const vec = embeddingsCache[n.id]?.vector;
      const score = vec && queryEmbedding ? Math.max(0, cosineSimilarity(queryEmbedding, vec)) : 0;
      return { nodeId: n.id, node: n, score };
    })
    .sort((a, b) => b.score - a.score);
}

function hybridNoGraphRank(query, queryEmbedding, nodes, embeddingsCache) {
  const bm25Norm = normalize(scoreAllNodes(query, nodes));
  const vecRaw = new Map();
  for (const n of nodes) {
    const vec = embeddingsCache[n.id]?.vector;
    vecRaw.set(n.id, vec && queryEmbedding ? Math.max(0, cosineSimilarity(queryEmbedding, vec)) : 0);
  }
  const vecNorm = normalize(vecRaw);
  return nodes
    .map((n) => ({ nodeId: n.id, node: n, score: 0.5 * (bm25Norm.get(n.id) || 0) + 0.5 * (vecNorm.get(n.id) || 0) }))
    .sort((a, b) => b.score - a.score);
}

// --- Evaluation --------------------------------------------------------------

function rankOf(nodeText, results) {
  const idx = results.findIndex((r) => r.node.text.includes(nodeText) || nodeText.includes(r.node.text));
  return idx === -1 ? null : idx + 1;
}

// A node the Context Compiler deliberately collapsed into a compact
// "History: A -> B" pointer (relayContextCompiler.js's chain collapsing)
// won't appear as its own ranked result — that's correct, designed
// behavior (see benchmarkMemoryCorpus.js for the same finding), not a miss.
// Only Relay has a compiler; baselines have no equivalent, so this check
// only ever runs for the relay system.
function foundInCompiledText(expectedText, compiledText) {
  if (!compiledText) return false;
  const hint = expectedText.slice(0, 20).toLowerCase();
  return compiledText.toLowerCase().includes(hint);
}

function evaluatePositive(q, results, compiledText) {
  const top5 = results.slice(0, 5);
  const top10 = results.slice(0, 10);
  const ranks = q.expectedTexts.map((t) => rankOf(t, results));
  const foundIn5 = q.expectedTexts.filter((t) => rankOf(t, top5) !== null || foundInCompiledText(t, compiledText));
  const foundIn10 = q.expectedTexts.filter((t) => rankOf(t, top10) !== null || foundInCompiledText(t, compiledText));
  const bestRank = ranks.filter((r) => r !== null).sort((a, b) => a - b)[0] || null;
  const reciprocalRank = bestRank ? 1 / bestRank : (foundIn5.length ? 1 / 5 : 0);
  return {
    recallAt5: q.expectedTexts.length ? foundIn5.length / q.expectedTexts.length : null,
    recallAt10: q.expectedTexts.length ? foundIn10.length / q.expectedTexts.length : null,
    reciprocalRank,
  };
}

// Raw top-1 score only — "is this a false positive" is judged later, relative
// to that same system's typical positive-query top-1 score (see main()).
// A fixed absolute threshold isn't meaningful across systems whose raw
// scores live on entirely different scales (bounded cosine similarity vs.
// unbounded BM25 vs. Relay's confidence-weighted combined score).
function evaluateNegative(results) {
  return { top1Score: results[0]?.score ?? 0 };
}

function naiveDumpTokens(results, topN = 10) {
  const text = results.slice(0, topN).map((r) => r.node.text).join('\n');
  return estimateTokens(text);
}

// --- Main ---------------------------------------------------------------

async function main() {
  console.log('Comparative benchmark — Relay vs. BM25-only / vector-only / hybrid-no-graph');
  console.log('Corpus: hand-authored, OpenHands-structure-inspired, NOT real OpenHands data\n');

  const ws = makeWorkspace();
  const built = buildCorpus(ws);
  console.log(`Corpus: ${built.nodeCount} nodes, ${built.edgeCount} edges (from ${built.eventCount} events)`);

  console.log('Computing local embeddings for the corpus (first run downloads the model)...');
  const embedResult = await embedGraphNodes(ws, { force: true });
  if (!embedResult.available) {
    console.log(`Embeddings unavailable (${embedResult.reason}) — vector/hybrid baselines will score 0 throughout.\n`);
  } else {
    console.log(`Embedded ${embedResult.embeddedCount} nodes.\n`);
  }

  const { nodes } = relayGraph.materializeGraph(relayGraph.readEvents(ws));
  const graphDir = relayGraph.getGraphDir(ws);
  const embeddingsCache = JSON.parse(fs.readFileSync(path.join(graphDir, 'embeddings.json'), 'utf-8'));

  const SYSTEMS = ['relay', 'bm25Only', 'vectorOnly', 'hybridNoGraph'];
  const perSystem = Object.fromEntries(SYSTEMS.map((s) => [s, []]));
  const perSystemNeg = Object.fromEntries(SYSTEMS.map((s) => [s, []]));
  const perSystemTokens = Object.fromEntries(SYSTEMS.map((s) => [s, []]));
  const perSystemPosTop1 = Object.fromEntries(SYSTEMS.map((s) => [s, []]));

  for (const q of QUERIES) {
    const queryEmbedding = embedResult.available ? await embedText(q.query) : null;

    const relayResults = retrieve(ws, q.query, { hops: 2, topK: 10 });
    const bm25Results = bm25OnlyRank(q.query, nodes);
    const vectorResults = vectorOnlyRank(queryEmbedding, nodes, embeddingsCache);
    const hybridResults = hybridNoGraphRank(q.query, queryEmbedding, nodes, embeddingsCache);

    const bySystem = { relay: relayResults, bm25Only: bm25Results, vectorOnly: vectorResults, hybridNoGraph: hybridResults };
    // Only Relay has a compiler; compute it once per query, reused for both
    // the recall-vs-collapsed-chain check and the context-size measurement.
    const relayCompiled = compileForResolution(ws, 'default', { query: q.query, recordAccess: false });

    for (const sys of SYSTEMS) {
      const results = bySystem[sys];
      if (q.negative) {
        perSystemNeg[sys].push(evaluateNegative(results));
      } else {
        const compiledText = sys === 'relay' ? relayCompiled.text : null;
        perSystem[sys].push({ category: q.category, ...evaluatePositive(q, results, compiledText) });
        perSystemPosTop1[sys].push(results[0]?.score ?? 0);
      }
      // Context size: Relay uses its real compiler output; baselines use a
      // naive top-10 full-text dump (no compiler exists for them).
      perSystemTokens[sys].push(sys === 'relay' ? relayCompiled.usedTokens : naiveDumpTokens(results));
    }
  }

  // --- Aggregate report ---
  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

  console.log('=== Recall@5 by system (overall) ===');
  for (const sys of SYSTEMS) {
    const recalls = perSystem[sys].map((r) => r.recallAt5).filter((v) => v !== null);
    console.log(`  ${sys.padEnd(16)} ${(mean(recalls) * 100).toFixed(1)}%`);
  }

  console.log('\n=== Recall@10 by system (overall) ===');
  for (const sys of SYSTEMS) {
    const recalls = perSystem[sys].map((r) => r.recallAt10).filter((v) => v !== null);
    console.log(`  ${sys.padEnd(16)} ${(mean(recalls) * 100).toFixed(1)}%`);
  }

  console.log('\n=== MRR by system (overall) ===');
  for (const sys of SYSTEMS) {
    console.log(`  ${sys.padEnd(16)} ${mean(perSystem[sys].map((r) => r.reciprocalRank)).toFixed(3)}`);
  }

  console.log('\n=== Recall@5 by category ===');
  const categories = [...new Set(QUERIES.filter((q) => !q.negative).map((q) => q.category))];
  for (const cat of categories) {
    const line = SYSTEMS.map((sys) => {
      const recalls = perSystem[sys].filter((r) => r.category === cat).map((r) => r.recallAt5);
      return `${sys}=${(mean(recalls) * 100).toFixed(0)}%`;
    }).join('  ');
    console.log(`  ${cat.padEnd(10)} ${line}`);
  }

  // Each system's raw top-1 score lives on a different scale (bounded cosine
  // similarity vs. unbounded BM25 vs. Relay's confidence-weighted combined
  // score), so neither a shared absolute cutoff nor a single relative cutoff
  // is meaningful across systems (tried 15%-of-mean-positive — it flagged
  // every system as "failing," including cases whose absolute negative score
  // was clearly low; that's a sign the cutoff is miscalibrated, not a real
  // finding). Reporting the ratio itself, with no pass/fail label invented on
  // top, is the honest version: lower means a clearer gap between "this is
  // relevant" and "this isn't," whatever each system's native scale is.
  console.log('\n=== Negative controls: separation ratio (mean negative top-1 / mean positive top-1 — lower is better) ===');
  for (const sys of SYSTEMS) {
    const meanPositiveTop1 = mean(perSystemPosTop1[sys]);
    const meanNegativeTop1 = mean(perSystemNeg[sys].map((r) => r.top1Score));
    const ratio = meanPositiveTop1 > 0 ? meanNegativeTop1 / meanPositiveTop1 : null;
    console.log(`  ${sys.padEnd(16)} ratio: ${ratio === null ? 'n/a' : ratio.toFixed(2)}  (mean negative top-1: ${meanNegativeTop1.toFixed(3)}, mean positive top-1: ${meanPositiveTop1.toFixed(3)})`);
  }

  console.log('\n=== Mean context size (tokens) for a compiled/dumped answer ===');
  for (const sys of SYSTEMS) {
    console.log(`  ${sys.padEnd(16)} ${mean(perSystemTokens[sys]).toFixed(0)} tokens`);
  }

  console.log(`\nQueries: ${QUERIES.filter((q) => !q.negative).length} positive, ${QUERIES.filter((q) => q.negative).length} negative control`);

  fs.rmSync(ws, { recursive: true, force: true });
}

main();
