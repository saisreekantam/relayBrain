#!/usr/bin/env node
/**
 * Comparative File/CO_EDITED retrieval benchmark on REAL data: a real git
 * clone of OpenHands (github.com/All-Hands-AI/OpenHands), real commit
 * history, real file paths, real co-edit timing. No fabricated content —
 * this is the honest counterpart to benchmarkComparative.js, whose
 * Decision/Goal/Evidence/Failure corpus is disclosed as hand-authored and
 * NOT real OpenHands data. Here, everything fed into the graph is real.
 *
 * What "real" means precisely: FileTouched events are derived directly from
 * `git log --name-only` on a local clone — one event per (file, commit),
 * timestamped with the commit's real authored time. CO_EDITED edges then
 * form exactly the way relayGraph already forms them in production: a
 * gap-based time window (30 min) over those touches. Two files that were
 * never lexically or semantically similar but were genuinely changed
 * together in the same real commit get a real CO_EDITED edge — this is
 * the scenario only Relay's graph traversal can find; the non-graph
 * baselines have no signal connecting them at all.
 *
 * Queries are derived mechanically, not hand-labeled: pick a real commit
 * that touched 3-8 non-noise files, query with one file's real path, and
 * the ground truth is simply "the other files from that same commit."
 * No subjective labeling involved.
 *
 * Requires a local OpenHands clone with real commit history (depth > 1).
 * Pass its path as argv[1], or it defaults to /tmp/openhands-relay-test.
 * This script only ever runs read-only git commands against that clone
 * (`git log`) — it never writes into it. All graph state is built in a
 * fresh, disposable `fs.mkdtempSync` workspace, same pattern as every
 * other script in this directory.
 *
 * Run: node scripts/benchmarkComparativeFiles.js [path-to-openhands-clone]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const relayGraph = require('../lib/relayGraph');
const { retrieve, scoreAllNodes } = require('../lib/relayRetrieve');
const { compileForResolution, estimateTokens } = require('../lib/relayContextCompiler');
const { embedText, embedGraphNodes, cosineSimilarity } = require('../lib/relayEmbed');

const REPO = process.argv[2] || '/tmp/openhands-relay-test';
const MAX_COMMITS = 2000; // matches how far this clone was deepened
const QUERY_COMMIT_COUNT = 18;

function isNoisy(file) {
  const f = file.toLowerCase();
  if (f.includes('package.json')) return false;
  return ['lock', '.svg', '.png', '.lockb', '.snap', '.json'].some((x) => f.includes(x));
}

function readRealCommits(repo) {
  const raw = execSync('git log --name-only --no-merges -n ' + MAX_COMMITS + ` --pretty=format:'@@%H|%at|%s'`, {
    cwd: repo, maxBuffer: 1024 * 1024 * 64, encoding: 'utf-8',
  });
  const commits = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      if (cur) commits.push(cur);
      const [hash, ts, ...rest] = line.slice(2).split('|');
      cur = { hash, ts: Number(ts), subject: rest.join('|'), files: [] };
    } else if (line.trim() && cur) {
      cur.files.push(line.trim());
    }
  }
  if (cur) commits.push(cur);
  return commits;
}

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-comparative-files-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.relay', 'config.json'), JSON.stringify({ workspace: dir, graph: { enabled: true } }));
  for (const f of ['project.md', 'decisions.md', 'failures.md', 'current_task.md']) {
    fs.writeFileSync(path.join(dir, '.relay', f), '');
  }
  return dir;
}

function buildTimeline(commits) {
  const timeline = [];
  for (const c of commits) {
    const realFiles = c.files.filter((f) => !isNoisy(f));
    for (const file of realFiles) {
      timeline.push({
        kind: 'code_edit',
        source: 'git',
        ts: new Date(c.ts * 1000).toISOString(),
        path: file,
        file: path.basename(file),
        summary: c.subject,
      });
    }
  }
  return timeline;
}

// --- Fair non-graph baselines (same methodology as benchmarkComparative.js) ---

function bm25OnlyRank(query, nodes) {
  const raw = scoreAllNodes(query, nodes);
  return nodes.map((n) => ({ nodeId: n.id, node: n, score: raw.get(n.id) || 0 })).sort((a, b) => b.score - a.score);
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

function normalize(scoreMap) {
  const max = Math.max(1e-9, ...scoreMap.values());
  const out = new Map();
  for (const [id, s] of scoreMap) out.set(id, s / max);
  return out;
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

// --- Query selection (mechanical — no hand labeling) ---

function pickQueryCommits(commits) {
  const good = commits.filter((c) => {
    const real = c.files.filter((f) => !isNoisy(f));
    return real.length >= 3 && real.length <= 8;
  });
  // Spread across the available history instead of clustering at HEAD.
  const stride = Math.max(1, Math.floor(good.length / QUERY_COMMIT_COUNT));
  const picked = [];
  for (let i = 0; i < good.length && picked.length < QUERY_COMMIT_COUNT; i += stride) picked.push(good[i]);
  return picked;
}

function rankOf(filePath, results) {
  const idx = results.findIndex((r) => r.node.text === filePath);
  return idx === -1 ? null : idx + 1;
}

function evaluate(expectedPaths, results) {
  const top5 = results.slice(0, 5);
  const top10 = results.slice(0, 10);
  const ranks = expectedPaths.map((p) => rankOf(p, results));
  const foundIn5 = expectedPaths.filter((p) => rankOf(p, top5) !== null).length;
  const foundIn10 = expectedPaths.filter((p) => rankOf(p, top10) !== null).length;
  const bestRank = ranks.filter((r) => r !== null).sort((a, b) => a - b)[0] || null;
  return {
    recallAt5: foundIn5 / expectedPaths.length,
    recallAt10: foundIn10 / expectedPaths.length,
    reciprocalRank: bestRank ? 1 / bestRank : 0,
  };
}

// "How many tokens did the naive top-10 dump cost" and "how many tokens did
// Relay's compiler spend" are NOT comparable on their own — Relay's default
// profile greedy-fills toward an 1800-token budget via 2-hop traversal,
// while a fixed top-10 dump is capped by node count, not budget. Comparing
// those two numbers directly is the wrong question. The right one: given the
// SAME token budget, how much of the right answer does each system surface?
// Greedy-fills ranked results in order until the next item would exceed the
// budget — same greedy-fill principle relayContextCompiler.js uses, applied
// to the baselines so the comparison is apples-to-apples.
function fillToTokenBudget(results, tokenBudget) {
  const included = [];
  let used = 0;
  for (const r of results) {
    const cost = estimateTokens(r.node.text);
    if (used + cost > tokenBudget && included.length > 0) break;
    included.push(r);
    used += cost;
  }
  return { included, usedTokens: used };
}

// A handful of queries about things this repo's history genuinely has no
// record of — same negative-control idea as benchmarkComparative.js, just
// file-domain.
const NEGATIVE_QUERIES = [
  'COBOL mainframe batch job scheduler',
  'a Solidity smart contract for token vesting',
  'an Apple Watch companion app target',
];

async function main() {
  if (!fs.existsSync(REPO)) {
    console.error(`No repo found at ${REPO}. Pass a real git clone path as argv[1].`);
    process.exit(1);
  }
  const depth = Number(execSync('git log --oneline | wc -l', { cwd: REPO, encoding: 'utf-8' }).trim());
  console.log(`Real-data File/CO_EDITED benchmark — ${REPO} (${depth} real commits available)\n`);
  if (depth <= 1) {
    console.error('This clone is shallow (depth 1) — no real commit history to derive co-edits from. Run `git fetch --deepen=500` in it first.');
    process.exit(1);
  }

  const commits = readRealCommits(REPO);
  const timeline = buildTimeline(commits);
  console.log(`Parsed ${commits.length} commits, ${timeline.length} real (file, commit) touches.`);

  const ws = makeWorkspace();
  relayGraph.ingestTimelineIntoEvents(ws, timeline);
  const built = relayGraph.rebuildGraph(ws);
  console.log(`Graph: ${built.nodeCount} nodes, ${built.edgeCount} edges (from ${built.eventCount} events).`);

  console.log('Computing local embeddings for every File node (first run downloads the model)...');
  const embedResult = await embedGraphNodes(ws, { force: true });
  console.log(embedResult.available
    ? `Embedded ${embedResult.embeddedCount} nodes.\n`
    : `Embeddings unavailable (${embedResult.reason}) — vector/hybrid baselines will score 0.\n`);

  const { nodes } = relayGraph.materializeGraph(relayGraph.readEvents(ws));
  const graphDir = relayGraph.getGraphDir(ws);
  const embeddingsCache = JSON.parse(fs.readFileSync(path.join(graphDir, 'embeddings.json'), 'utf-8'));

  const queryCommits = pickQueryCommits(commits);
  console.log(`Selected ${queryCommits.length} real commits as query seeds (3-8 real files each, spread across history).\n`);

  const SYSTEMS = ['relay', 'bm25Only', 'vectorOnly', 'hybridNoGraph'];
  const perSystem = Object.fromEntries(SYSTEMS.map((s) => [s, []]));
  const perSystemNeg = Object.fromEntries(SYSTEMS.map((s) => [s, []]));
  const perSystemPosTop1 = Object.fromEntries(SYSTEMS.map((s) => [s, []]));
  const perSystemTokens = Object.fromEntries(SYSTEMS.map((s) => [s, []]));
  const perSystemBudgetRecall = Object.fromEntries(SYSTEMS.map((s) => [s, []]));

  console.log('=== Per-query results ===\n');
  for (const c of queryCommits) {
    const realFiles = c.files.filter((f) => !isNoisy(f));
    const [seed, ...expected] = realFiles;
    const queryEmbedding = embedResult.available ? await embedText(seed) : null;

    const relayResults = retrieve(ws, seed, { hops: 2, topK: 15 }).filter((r) => r.node.text !== seed);
    const bm25Results = bm25OnlyRank(seed, nodes).filter((r) => r.node.text !== seed);
    const vectorResults = vectorOnlyRank(queryEmbedding, nodes, embeddingsCache).filter((r) => r.node.text !== seed);
    const hybridResults = hybridNoGraphRank(seed, queryEmbedding, nodes, embeddingsCache).filter((r) => r.node.text !== seed);
    const bySystem = { relay: relayResults, bm25Only: bm25Results, vectorOnly: vectorResults, hybridNoGraph: hybridResults };

    // Relay's own compiled token spend for this query becomes the shared
    // budget every baseline gets — not an arbitrary constant, and not tuned
    // to favor anyone, just "however many tokens Relay actually needed."
    const relayCompiled = compileForResolution(ws, 'default', { query: seed, recordAccess: false });
    const budget = relayCompiled.usedTokens;

    console.log(`"${c.subject.slice(0, 70)}" — seed: ${seed}  (shared budget: ${budget} tokens)`);
    for (const sys of SYSTEMS) {
      const r = evaluate(expected, bySystem[sys]);
      perSystem[sys].push(r);
      perSystemPosTop1[sys].push(bySystem[sys][0]?.score ?? 0);

      let budgetRecall;
      if (sys === 'relay') {
        const foundInBudget = expected.filter((p) => relayCompiled.text.includes(p)).length;
        budgetRecall = foundInBudget / expected.length;
        perSystemTokens[sys].push(budget);
      } else {
        const { included, usedTokens } = fillToTokenBudget(bySystem[sys], budget);
        const foundInBudget = expected.filter((p) => included.some((r2) => r2.node.text === p)).length;
        budgetRecall = foundInBudget / expected.length;
        perSystemTokens[sys].push(usedTokens);
      }
      perSystemBudgetRecall[sys].push(budgetRecall);

      console.log(`  ${sys.padEnd(16)} Recall@5: ${(r.recallAt5 * 100).toFixed(0)}%  RR: ${r.reciprocalRank.toFixed(2)}  RecallWithinBudget: ${(budgetRecall * 100).toFixed(0)}%`);
    }
    console.log('');
  }

  for (const q of NEGATIVE_QUERIES) {
    const queryEmbedding = embedResult.available ? await embedText(q) : null;
    const bySystem = {
      relay: retrieve(ws, q, { hops: 2, topK: 15 }),
      bm25Only: bm25OnlyRank(q, nodes),
      vectorOnly: vectorOnlyRank(queryEmbedding, nodes, embeddingsCache),
      hybridNoGraph: hybridNoGraphRank(q, queryEmbedding, nodes, embeddingsCache),
    };
    for (const sys of SYSTEMS) perSystemNeg[sys].push(bySystem[sys][0]?.score ?? 0);
  }

  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

  console.log('=== Aggregate (over real commit-derived queries) ===');
  console.log('Recall@5:');
  for (const sys of SYSTEMS) console.log(`  ${sys.padEnd(16)} ${(mean(perSystem[sys].map((r) => r.recallAt5)) * 100).toFixed(1)}%`);
  console.log('Recall@10:');
  for (const sys of SYSTEMS) console.log(`  ${sys.padEnd(16)} ${(mean(perSystem[sys].map((r) => r.recallAt10)) * 100).toFixed(1)}%`);
  console.log('MRR:');
  for (const sys of SYSTEMS) console.log(`  ${sys.padEnd(16)} ${mean(perSystem[sys].map((r) => r.reciprocalRank)).toFixed(3)}`);

  console.log('\nNegative-control separation ratio (mean negative top-1 / mean positive top-1, lower is better):');
  for (const sys of SYSTEMS) {
    const posTop1 = mean(perSystemPosTop1[sys]);
    const negTop1 = mean(perSystemNeg[sys]);
    console.log(`  ${sys.padEnd(16)} ratio: ${posTop1 > 0 ? (negTop1 / posTop1).toFixed(2) : 'n/a'}  (neg top-1: ${negTop1.toFixed(3)}, pos top-1: ${posTop1.toFixed(3)})`);
  }

  console.log('\nRecall within an equal token budget (Relay\'s own per-query compiled spend, given to every baseline too — the real "useful info per token" comparison):');
  for (const sys of SYSTEMS) {
    console.log(`  ${sys.padEnd(16)} ${(mean(perSystemBudgetRecall[sys]) * 100).toFixed(1)}%  (mean tokens actually used: ${mean(perSystemTokens[sys]).toFixed(0)})`);
  }

  fs.rmSync(ws, { recursive: true, force: true });
}

main();
