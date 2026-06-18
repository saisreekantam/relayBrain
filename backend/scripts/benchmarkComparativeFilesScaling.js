#!/usr/bin/env node
/**
 * Frozen-query scaling study — does Relay's real-data advantage over BM25/
 * vector/hybrid baselines hold, grow, or shrink as the real graph gets
 * bigger? Same real OpenHands commit data and methodology as
 * benchmarkComparativeFiles.js, but fixing one confound in that script's
 * two single-depth runs: `pickQueryCommits` resampled fresh query seeds at
 * each depth, so a result that changed between the 500-commit and
 * 2000-commit runs could have been caused by corpus size, by a harder/
 * easier query draw, or both — no way to tell which.
 *
 * Fix: pick 18 query commits ONCE from the smallest depth tested (500 real
 * commits) and freeze them to `fixtures/openhandsQueryCommits.json`. Every
 * deeper commit window (`git log -n 1000/1500/2000`) is, by construction, a
 * superset of the 500 most recent commits from the same HEAD — so the exact
 * same query commits (same hash, same file list, same ground truth) exist
 * at every depth tested. Corpus size is now the only variable that changes.
 *
 * Also reports precision, not just recall, per a specific hypothesis: 2-hop
 * graph traversal may find more of the right answer as the graph grows
 * (recall up) while also pulling in more incidentally co-edited noise
 * (precision down) — i.e. retrieval quality improving while the compiler's
 * pruning becomes the next bottleneck. Precision@5 and precision-within-
 * equal-budget are reported specifically to check that hypothesis, not
 * assumed true.
 *
 * Run: node scripts/benchmarkComparativeFilesScaling.js
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
const DEPTHS = [500, 1000, 1500, 2000];
const FREEZE_DEPTH = DEPTHS[0]; // query commits are drawn from this depth only
const QUERY_COMMIT_COUNT = 18;
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'openhandsQueryCommits.json');

function isNoisy(file) {
  const f = file.toLowerCase();
  if (f.includes('package.json')) return false;
  return ['lock', '.svg', '.png', '.lockb', '.snap', '.json'].some((x) => f.includes(x));
}

function readRealCommits(repo, depth) {
  const raw = execSync(`git log --name-only --no-merges -n ${depth} --pretty=format:'@@%H|%at|%s'`, {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-comparative-files-scaling-'));
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
    for (const file of c.files.filter((f) => !isNoisy(f))) {
      timeline.push({ kind: 'code_edit', source: 'git', ts: new Date(c.ts * 1000).toISOString(), path: file, file: path.basename(file), summary: c.subject });
    }
  }
  return timeline;
}

// --- Fair non-graph baselines (same methodology as benchmarkComparative*.js) ---

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
    // precision: of the K slots actually returned, how many were right —
    // the direct "how much noise came along with the recall" measure.
    precisionAt5: foundIn5 / Math.min(5, results.length || 5),
    precisionAt10: foundIn10 / Math.min(10, results.length || 10),
    reciprocalRank: bestRank ? 1 / bestRank : 0,
  };
}

// --- Step 1: freeze (or load) the query commits, from the smallest depth only ---

function pickQueryCommits(commits) {
  const good = commits.filter((c) => {
    const real = c.files.filter((f) => !isNoisy(f));
    return real.length >= 3 && real.length <= 8;
  });
  const stride = Math.max(1, Math.floor(good.length / QUERY_COMMIT_COUNT));
  const picked = [];
  for (let i = 0; i < good.length && picked.length < QUERY_COMMIT_COUNT; i += stride) picked.push(good[i]);
  return picked;
}

function loadOrFreezeQueryCommits() {
  if (fs.existsSync(FIXTURE_PATH)) {
    console.log(`Loaded frozen query commits from ${FIXTURE_PATH}`);
    return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
  }
  const commits = readRealCommits(REPO, FREEZE_DEPTH);
  const picked = pickQueryCommits(commits).map((c) => ({
    hash: c.hash, subject: c.subject, files: c.files.filter((f) => !isNoisy(f)),
  }));
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(picked, null, 2));
  console.log(`Froze ${picked.length} query commits (drawn from the most recent ${FREEZE_DEPTH} real commits) to ${FIXTURE_PATH}`);
  return picked;
}

async function runAtDepth(depth, queryCommits) {
  const commits = readRealCommits(REPO, depth);
  const timeline = buildTimeline(commits);

  const ws = makeWorkspace();
  relayGraph.ingestTimelineIntoEvents(ws, timeline);
  const built = relayGraph.rebuildGraph(ws);

  const embedResult = await embedGraphNodes(ws, { force: true });
  const { nodes } = relayGraph.materializeGraph(relayGraph.readEvents(ws));
  const graphDir = relayGraph.getGraphDir(ws);
  const embeddingsCache = JSON.parse(fs.readFileSync(path.join(graphDir, 'embeddings.json'), 'utf-8'));
  const nodeTexts = new Set(nodes.map((n) => n.text));

  const SYSTEMS = ['relay', 'bm25Only', 'vectorOnly', 'hybridNoGraph'];
  const perSystem = Object.fromEntries(SYSTEMS.map((s) => [s, []]));
  const perSystemBudgetRecall = Object.fromEntries(SYSTEMS.map((s) => [s, []]));
  const perSystemBudgetPrecision = Object.fromEntries(SYSTEMS.map((s) => [s, []]));

  let skipped = 0;
  for (const c of queryCommits) {
    const [seed, ...expected] = c.files;
    // Sanity check the prefix assumption: the frozen seed must exist in
    // this depth's graph (it will, since every tested depth's commit
    // window is a superset of the 500-commit window the queries came
    // from) — skip defensively rather than silently mis-scoring if not.
    if (!nodeTexts.has(seed)) { skipped += 1; continue; }

    const queryEmbedding = embedResult.available ? await embedText(seed) : null;
    const relayResults = retrieve(ws, seed, { hops: 2, topK: 15 }).filter((r) => r.node.text !== seed);
    const bm25Results = bm25OnlyRank(seed, nodes).filter((r) => r.node.text !== seed);
    const vectorResults = vectorOnlyRank(queryEmbedding, nodes, embeddingsCache).filter((r) => r.node.text !== seed);
    const hybridResults = hybridNoGraphRank(seed, queryEmbedding, nodes, embeddingsCache).filter((r) => r.node.text !== seed);
    const bySystem = { relay: relayResults, bm25Only: bm25Results, vectorOnly: vectorResults, hybridNoGraph: hybridResults };

    const relayCompiled = compileForResolution(ws, 'default', { query: seed, recordAccess: false });
    const budget = relayCompiled.usedTokens;

    for (const sys of SYSTEMS) {
      perSystem[sys].push(evaluate(expected, bySystem[sys]));

      if (sys === 'relay') {
        const totalIncluded = relayCompiled.includedNodeIds.length || 1;
        const foundInBudget = expected.filter((p) => relayCompiled.text.includes(p)).length;
        perSystemBudgetRecall[sys].push(foundInBudget / expected.length);
        perSystemBudgetPrecision[sys].push(foundInBudget / totalIncluded);
      } else {
        const { included } = fillToTokenBudget(bySystem[sys], budget);
        const foundInBudget = expected.filter((p) => included.some((r2) => r2.node.text === p)).length;
        perSystemBudgetRecall[sys].push(foundInBudget / expected.length);
        perSystemBudgetPrecision[sys].push(foundInBudget / Math.max(1, included.length));
      }
    }
  }

  if (skipped) console.log(`  (depth ${depth}: skipped ${skipped} frozen query commit(s) not present at this depth — should be 0)`);

  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
  const result = { depth, nodeCount: built.nodeCount, edgeCount: built.edgeCount, bySystem: {} };
  for (const sys of SYSTEMS) {
    result.bySystem[sys] = {
      recallAt5: mean(perSystem[sys].map((r) => r.recallAt5)),
      recallAt10: mean(perSystem[sys].map((r) => r.recallAt10)),
      precisionAt5: mean(perSystem[sys].map((r) => r.precisionAt5)),
      mrr: mean(perSystem[sys].map((r) => r.reciprocalRank)),
      budgetRecall: mean(perSystemBudgetRecall[sys]),
      budgetPrecision: mean(perSystemBudgetPrecision[sys]),
    };
  }

  fs.rmSync(ws, { recursive: true, force: true });
  return result;
}

function printTable(title, results, systems, metric, fmt = (v) => (v * 100).toFixed(1) + '%') {
  console.log(`\n=== ${title} ===`);
  const header = '         ' + DEPTHS.map((d) => String(d).padStart(8)).join('');
  console.log(header);
  for (const sys of systems) {
    const row = results.map((r) => fmt(r.bySystem[sys][metric]).padStart(8)).join('');
    console.log(sys.padEnd(9) + row);
  }
}

async function main() {
  if (!fs.existsSync(REPO)) {
    console.error(`No repo found at ${REPO}. Pass a real git clone path as argv[1].`);
    process.exit(1);
  }
  const depth = Number(execSync('git log --oneline | wc -l', { cwd: REPO, encoding: 'utf-8' }).trim());
  console.log(`Frozen-query scaling study — ${REPO} (${depth} real commits available)`);
  if (depth < DEPTHS[DEPTHS.length - 1]) {
    console.error(`Need at least ${DEPTHS[DEPTHS.length - 1]} commits; this clone only has ${depth}. Run \`git fetch --deepen=N\` first.`);
    process.exit(1);
  }

  const queryCommits = loadOrFreezeQueryCommits();
  console.log(`Using ${queryCommits.length} frozen query commits at every depth: ${DEPTHS.join(', ')}\n`);

  const results = [];
  for (const d of DEPTHS) {
    console.log(`Running at depth ${d}...`);
    const r = await runAtDepth(d, queryCommits);
    console.log(`  graph: ${r.nodeCount} nodes, ${r.edgeCount} edges`);
    results.push(r);
  }

  const SYSTEMS = ['relay', 'bm25Only', 'vectorOnly', 'hybridNoGraph'];
  printTable('Recall@10 by corpus depth (real commits)', results, SYSTEMS, 'recallAt10');
  printTable('MRR by corpus depth', results, SYSTEMS, 'mrr', (v) => v.toFixed(3));
  printTable('Precision@5 by corpus depth (noise check)', results, SYSTEMS, 'precisionAt5');
  printTable('Recall within equal token budget', results, SYSTEMS, 'budgetRecall');
  printTable('Precision within equal token budget (noise check)', results, SYSTEMS, 'budgetPrecision');
}

main();
