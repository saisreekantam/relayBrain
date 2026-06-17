#!/usr/bin/env node
/**
 * Does the graph actually find complex entity relationships at scale, and
 * does it do so in fewer tokens than the legacy dump? Unlike
 * benchmarkGraph.js (timing/disk), this tests RECALL/PRECISION of real
 * relationships, per tier, small to huge — and is deliberately designed to
 * expose relationships that DON'T yet have a real ingestion path (schema
 * exists, nothing populates it from real markdown), not just the ones that do.
 *
 * Run: node scripts/benchmarkRelations.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');
const { retrieve } = require('../lib/relayRetrieve');
const { compileForResolution, estimateTokens } = require('../lib/relayContextCompiler');
const { buildCompileBrief } = require('../lib/relayContext');

const TECH_CHOICES = [
  'Stripe webhooks', 'OAuth2 tokens', 'Elasticsearch', 'a message queue', 'a multi-step wizard',
  'nightly batch jobs', 'role-based access control', 'push notifications', 'idempotency keys', 'Terraform',
];
function techFor(i) { return TECH_CHOICES[i % TECH_CHOICES.length]; }

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-relbench-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

function buildSyntheticProject(ws, { clusters, filesPerCluster, tasksPerCluster }) {
  const relayDir = path.join(ws, '.relay');
  const clusterNames = Array.from({ length: clusters }, (_, i) => `area${i}`);

  // Gaps between clusters need to be larger than the 30-min co-edit window
  // (so sessions stay separate) but small relative to the freshness decay
  // timescale (days) — otherwise freshness decay (which is real and correct)
  // swamps whatever else a query is trying to test, by ~100x in practice.
  // Anchored relative to Date.now(), not a fixed calendar date, so this
  // doesn't quietly break again the next time a long session crosses into a
  // new month and "today" drifts further from a hardcoded anchor.
  const CLUSTER_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours
  const timeline = [];
  let clusterStart = Date.now() - (clusters * CLUSTER_GAP_MS) - 24 * 60 * 60 * 1000;
  for (const cluster of clusterNames) {
    let t = clusterStart;
    for (let i = 0; i < filesPerCluster; i++) {
      timeline.push({
        kind: 'code_edit', source: 'Cursor', ts: new Date(t).toISOString(),
        path: `src/${cluster}/file${i}.js`, file: `file${i}.js`, summary: `update ${cluster} file ${i}`,
      });
      t += 60 * 1000;
    }
    clusterStart += CLUSTER_GAP_MS;
  }
  fs.writeFileSync(path.join(relayDir, 'memory.json'), JSON.stringify({ workspace: ws, timeline }));

  const taskLines = [];
  for (const cluster of clusterNames) {
    for (let i = 0; i < tasksPerCluster; i++) {
      taskLines.push(`- [ ] generic task ${i}: improve throughput and reduce error rates`);
    }
  }
  fs.writeFileSync(path.join(relayDir, 'current_task.md'), `# Current Tasks\n\n## In progress\n${taskLines.join('\n')}\n`);

  const goalLines = clusterNames.map((c, i) => `- Reduce latency and improve reliability (owner: ${c})`);
  fs.writeFileSync(path.join(relayDir, 'project.md'), `# Project Summary\n\n## Goals\n${goalLines.join('\n')}\n`);

  // Deliberately: decision text mentions ONLY the tech + cluster name, NOT
  // generic words shared with its goal — isolates whether SERVES traversal
  // (not lexical luck) is what would connect them. Each decision declares
  // its goal via the explicit "Serves:" convention.
  const openDecisions = clusterNames.map((c, i) =>
    `- Use ${techFor(i)} for the ${c} subsystem\n  - Serves: Reduce latency and improve reliability (owner: ${c})`);
  fs.writeFileSync(path.join(relayDir, 'decisions.md'), `# Decisions\n\n## Open\n${openDecisions.join('\n')}\n\n## Resolved\n\n`);

  fs.writeFileSync(path.join(relayDir, 'failures.md'), '# Failures\n\n');
  fs.writeFileSync(path.join(relayDir, 'config.json'), JSON.stringify({ workspace: ws, graph: { enabled: true } }));
}

const TIERS = [
  { name: 'tiny', clusters: 2, filesPerCluster: 5, tasksPerCluster: 3 },
  { name: 'small', clusters: 5, filesPerCluster: 10, tasksPerCluster: 6 },
  { name: 'medium', clusters: 10, filesPerCluster: 20, tasksPerCluster: 6 },
  { name: 'large', clusters: 20, filesPerCluster: 50, tasksPerCluster: 10 },
  { name: 'huge', clusters: 50, filesPerCluster: 100, tasksPerCluster: 10 },
];

function runTier(tier) {
  const ws = makeWorkspace();
  buildSyntheticProject(ws, tier);
  relayGraph.syncGraph(ws);

  const targetIndex = Math.min(3, tier.clusters - 1);
  const targetCluster = `area${targetIndex}`;
  const targetTech = techFor(targetIndex);

  // --- Relation 1: File co-edit (a REAL edge — created by real ingestion) ---
  const fileQuery = `src/${targetCluster}/file0.js`;
  const fileResults = retrieve(ws, fileQuery, { hops: 1, topK: 15 });
  // precision@K, K = the true cluster size CAPPED at the co-edit window limit
  // (CO_EDIT_MAX_WINDOW_FILES=10, a separate, already-documented, deliberately
  // accepted tradeoff — see relayGraph.js's buildCoEditLinks comment). Using
  // the uncapped cluster size here would fail this test for any tier with
  // >10 files/cluster regardless of ranking quality, since the graph
  // structurally cannot connect more than 10 files per session window —
  // that's a different, already-known limitation, not what this test targets.
  const expectedClusterFiles = Math.min(tier.filesPerCluster, 10);
  const topFileResults = fileResults.filter(r => r.node.type === 'File').slice(0, expectedClusterFiles);
  const sameClusterFiles = topFileResults.filter(r => r.nodeId.includes(`src/${targetCluster}/`));
  const otherClusterFiles = topFileResults.filter(r => !r.nodeId.includes(`src/${targetCluster}/`));
  const coEditWorks = sameClusterFiles.length === topFileResults.length && sameClusterFiles.length > 1;

  // --- Relation 2: Decision -> Goal via SERVES (schema exists, no real ingestion path) ---
  const decisionOnlyQuery = targetTech; // deliberately excludes "area3"/"subsystem"/"reliability" etc.
  const decisionResults = retrieve(ws, decisionOnlyQuery, { hops: 2, topK: 15 });
  const foundDecision = decisionResults.some(r => r.node.type === 'Decision' && r.node.text.includes(targetTech));
  const foundGoalViaTraversal = decisionResults.some(r => r.node.type === 'Goal' && r.node.text.includes(`owner: ${targetCluster}`));

  // --- Relation 3: Task -> anything (zero edges exist for Task nodes at all) ---
  const taskQuery = 'generic task improve throughput reduce error rates'; // no cluster-identifying info at all
  const taskResults = retrieve(ws, taskQuery, { hops: 2, topK: 30 });
  const taskHits = taskResults.filter(r => r.node.type === 'Task');
  // every cluster's task text is identical boilerplate -> if Task truly has no
  // edges to disambiguate, scores across clusters should be ~indistinguishable
  const taskScoreSpread = taskHits.length > 1 ? Math.max(...taskHits.map(r => r.score)) - Math.min(...taskHits.map(r => r.score)) : null;

  // --- Token cost for a realistic focused query (combining relation 1+2 themes) ---
  const tFocused = compileForResolution(ws, 'default', { query: `${targetCluster} ${targetTech}`, recordAccess: false });
  const legacyTokens = estimateTokens(Object.values(buildCompileBrief(ws).irSnapshot).join('\n'));

  fs.rmSync(ws, { recursive: true, force: true });

  return {
    tier: tier.name,
    totalFiles: tier.clusters * tier.filesPerCluster,
    coEditWorks,
    sameClusterFileHits: sameClusterFiles.length,
    otherClusterFileLeaks: otherClusterFiles.length,
    foundDecision,
    foundGoalViaTraversal,
    taskHitCount: taskHits.length,
    taskScoreSpread,
    focusedTokens: tFocused.usedTokens,
    legacyTokens,
  };
}

function main() {
  console.log('Complex relationship recall — what the graph can and cannot actually find, small to huge\n');

  const rows = TIERS.map(tier => {
    process.stdout.write(`Running tier "${tier.name}" (${tier.clusters * tier.filesPerCluster} files)... `);
    const r = runTier(tier);
    console.log('done');
    return r;
  });

  console.log('\n=== Relation 1: File co-edit (CO_EDITED — a real edge from real ingestion) ===');
  console.log('tier    same-cluster-files-found  other-cluster-leaks  works?');
  for (const r of rows) {
    console.log(`${r.tier.padEnd(7)} ${String(r.sameClusterFileHits).padStart(24)}  ${String(r.otherClusterFileLeaks).padStart(19)}  ${r.coEditWorks ? 'YES' : 'NO'}`);
  }

  console.log('\n=== Relation 2: Decision -> Goal via SERVES (schema exists; query deliberately has NO lexical overlap with the goal) ===');
  console.log('tier    decision-found-by-keyword  goal-found-via-traversal');
  for (const r of rows) {
    console.log(`${r.tier.padEnd(7)} ${String(r.foundDecision).padStart(25)}  ${String(r.foundGoalViaTraversal).padStart(24)}`);
  }

  console.log('\n=== Relation 3: Task nodes (zero edges to anything, by design today) ===');
  console.log('tier    identical-task-hits  score-spread (0 = indistinguishable, as expected with no edges)');
  for (const r of rows) {
    console.log(`${r.tier.padEnd(7)} ${String(r.taskHitCount).padStart(20)}  ${r.taskScoreSpread === null ? 'n/a' : r.taskScoreSpread.toFixed(4)}`);
  }

  console.log('\n=== Token cost for a focused multi-relation query ===');
  console.log('tier    legacy-tokens  graph-tokens  reduction');
  for (const r of rows) {
    const reduction = (1 - r.focusedTokens / r.legacyTokens) * 100;
    console.log(`${r.tier.padEnd(7)} ${String(r.legacyTokens).padStart(13)}  ${String(r.focusedTokens).padStart(12)}  ${reduction.toFixed(1)}%`);
  }

  console.log('\n=== Verdict ===');
  const coEditAllWork = rows.every(r => r.coEditWorks);
  const servesAnyWork = rows.some(r => r.foundGoalViaTraversal);
  console.log(`File co-edit relationship: ${coEditAllWork ? 'WORKS at every tier' : 'BROKEN at some tier — investigate'}`);
  console.log(`Decision -> Goal relationship (SERVES): ${servesAnyWork ? 'works' : 'DOES NOT WORK — schema exists but no real ingestion path creates this edge from markdown'}`);
  console.log('Task nodes: confirmed islands — no mechanism links a Task to its Decision/Goal/File today.');
}

main();
