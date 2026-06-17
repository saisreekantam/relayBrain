#!/usr/bin/env node
/**
 * Stress test for the Phase 1-6 memory graph: does adding graph structure
 * make things better or worse, at small through very large codebase sizes?
 *
 * For each size tier this generates a synthetic project (clusters of files,
 * tasks, decisions, goals, failures — same shape as
 * test/longCodebaseScale.test.js, generalized to scale), then measures:
 *   - first sync time (cold ingest + materialize)
 *   - repeated re-sync time (3x, to catch idempotency/growth regressions)
 *   - retrieve() time for a representative query
 *   - compileForResolution time per resolution tier
 *   - token cost: legacy full-IR-dump vs each graph profile
 *   - disk cost: .relay/graph/* vs raw IR markdown
 *
 * Run: node scripts/benchmarkGraph.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');
const { retrieve } = require('../lib/relayRetrieve');
const { compileForResolution, estimateTokens } = require('../lib/relayContextCompiler');
const { buildCompileBrief } = require('../lib/relayContext');

const TECH_CHOICES = [
  'OAuth2 tokens', 'Stripe webhooks', 'Elasticsearch', 'a message queue', 'a multi-step wizard',
  'nightly batch jobs', 'role-based access control', 'push notifications', 'idempotency keys', 'Terraform',
  'GraphQL', 'WebSockets', 'a circuit breaker', 'blue-green deploys', 'feature flags',
  'a CDN cache', 'rate limiting', 'sharded storage', 'an event bus', 'canary releases',
];
function techFor(i) {
  const base = TECH_CHOICES[i % TECH_CHOICES.length];
  return i >= TECH_CHOICES.length ? `${base} (variant ${Math.floor(i / TECH_CHOICES.length) + 1})` : base;
}

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-benchmark-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

function buildSyntheticProject(ws, { clusters, filesPerCluster, tasksPerCluster, resolvedDecisions, failureCount }) {
  const relayDir = path.join(ws, '.relay');
  const clusterNames = Array.from({ length: clusters }, (_, i) => `area${i}`);

  const timeline = [];
  let clusterStart = Date.parse('2026-01-01T00:00:00.000Z');
  for (const cluster of clusterNames) {
    let t = clusterStart;
    for (let i = 0; i < filesPerCluster; i++) {
      timeline.push({
        kind: 'code_edit', source: 'Cursor', ts: new Date(t).toISOString(),
        path: `src/${cluster}/file${i}.js`, file: `file${i}.js`, summary: `update ${cluster} file ${i}`,
      });
      t += 60 * 1000;
    }
    clusterStart += 10 * 24 * 60 * 60 * 1000;
  }
  fs.writeFileSync(path.join(relayDir, 'memory.json'), JSON.stringify({ workspace: ws, timeline }));

  const taskLines = [];
  for (const cluster of clusterNames) {
    for (let i = 0; i < tasksPerCluster; i++) {
      taskLines.push(`- [${i < 2 ? 'x' : ' '}] ${cluster}: task ${i} — improve throughput and error handling`);
    }
  }
  fs.writeFileSync(path.join(relayDir, 'current_task.md'), `# Current Tasks\n\n## In progress\n${taskLines.join('\n')}\n`);

  const goalLines = clusterNames.map(c => `- Improve ${c} subsystem reliability and reduce latency`);
  fs.writeFileSync(path.join(relayDir, 'project.md'), `# Project Summary\n\n## Goals\n${goalLines.join('\n')}\n`);

  const openDecisions = clusterNames.map((c, i) => `- Use ${techFor(i)} for the ${c} subsystem`);
  const resolved = Array.from({ length: resolvedDecisions }, (_, i) =>
    `- 2026-0${(i % 9) + 1}-1${i % 9} — Historical resolved decision ${i} about ${clusterNames[i % clusterNames.length]} subsystem configuration, a realistic full sentence with real length to it.`);
  fs.writeFileSync(path.join(relayDir, 'decisions.md'), `# Decisions\n\n## Open\n${openDecisions.join('\n')}\n\n## Resolved\n\n${resolved.join('\n')}\n`);

  const failureLines = Array.from({ length: failureCount }, (_, i) =>
    `- ${clusterNames[i % clusterNames.length]} subsystem hit issue ${i}: context overflow when the full architecture doc was loaded wholesale`);
  fs.writeFileSync(path.join(relayDir, 'failures.md'), `# Failures\n\n${failureLines.join('\n')}\n`);

  fs.writeFileSync(path.join(relayDir, 'config.json'), JSON.stringify({ workspace: ws, graph: { enabled: true } }));
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function irMarkdownSize(ws) {
  const relayDir = path.join(ws, '.relay');
  let total = 0;
  for (const f of ['current_task.md', 'decisions.md', 'project.md', 'failures.md']) {
    try { total += fs.statSync(path.join(relayDir, f)).size; } catch (_) { /* missing is fine */ }
  }
  return total;
}

function fmtMs(ms) { return `${ms.toFixed(1)}ms`; }
function fmtBytes(b) { return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)}MB` : `${(b / 1024).toFixed(1)}KB`; }

const TIERS = [
  { name: 'tiny', clusters: 2, filesPerCluster: 5, tasksPerCluster: 3, resolvedDecisions: 5, failureCount: 2 },
  { name: 'small', clusters: 5, filesPerCluster: 10, tasksPerCluster: 6, resolvedDecisions: 20, failureCount: 5 },
  { name: 'medium', clusters: 10, filesPerCluster: 20, tasksPerCluster: 6, resolvedDecisions: 24, failureCount: 5 },
  { name: 'large', clusters: 20, filesPerCluster: 50, tasksPerCluster: 10, resolvedDecisions: 100, failureCount: 20 },
  { name: 'huge', clusters: 50, filesPerCluster: 100, tasksPerCluster: 10, resolvedDecisions: 300, failureCount: 50 },
  { name: 'extreme', clusters: 100, filesPerCluster: 200, tasksPerCluster: 15, resolvedDecisions: 600, failureCount: 100 },
];

function runTier(tier) {
  const ws = makeWorkspace();
  buildSyntheticProject(ws, tier);

  const totalFiles = tier.clusters * tier.filesPerCluster;
  const totalTasks = tier.clusters * tier.tasksPerCluster;

  const t0 = Date.now();
  const first = relayGraph.syncGraph(ws);
  const firstSyncMs = Date.now() - t0;

  const resyncTimes = [];
  let eventCounts = [first.eventCount];
  let edgeCounts = [first.edgeCount];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const r = relayGraph.syncGraph(ws);
    resyncTimes.push(Date.now() - t);
    eventCounts.push(r.eventCount);
    edgeCounts.push(r.edgeCount);
  }
  const idempotent = eventCounts.every(c => c === eventCounts[0]) && edgeCounts.every(c => c === edgeCounts[0]);

  const query = `${'area0'} subsystem reliability throughput`;
  const tRetrieve = Date.now();
  const retrieveResults = retrieve(ws, query);
  const retrieveMs = Date.now() - tRetrieve;

  const profileTimings = {};
  const profileTokens = {};
  for (const profile of ['tiny', 'small', 'default', 'large']) {
    const t = Date.now();
    const result = compileForResolution(ws, profile, { query, recordAccess: false });
    profileTimings[profile] = Date.now() - t;
    profileTokens[profile] = result.usedTokens;
  }

  const legacyTokens = estimateTokens(Object.values(buildCompileBrief(ws).irSnapshot).join('\n'));

  const graphDir = path.join(ws, '.relay', 'graph');
  const graphDiskBytes = dirSize(graphDir);
  const irDiskBytes = irMarkdownSize(ws);

  fs.rmSync(ws, { recursive: true, force: true });

  return {
    tier: tier.name,
    totalFiles,
    totalTasks,
    nodeCount: first.nodeCount,
    edgeCount: first.edgeCount,
    eventCount: first.eventCount,
    firstSyncMs,
    avgResyncMs: resyncTimes.reduce((a, b) => a + b, 0) / resyncTimes.length,
    idempotent,
    retrieveMs,
    retrieveHits: retrieveResults.length,
    profileTimings,
    profileTokens,
    legacyTokens,
    graphDiskBytes,
    irDiskBytes,
  };
}

function runContradictionHeuristicCost(tier) {
  const ws = makeWorkspace();
  buildSyntheticProject(ws, tier);
  const cfgPath = path.join(ws, '.relay', 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ workspace: ws, graph: { enabled: true, contradictionHeuristic: true } }));

  const t0 = Date.now();
  relayGraph.syncGraph(ws);
  const ms = Date.now() - t0;

  fs.rmSync(ws, { recursive: true, force: true });
  return ms;
}

function main() {
  console.log('Phase 1-6 memory graph stress test — small to huge synthetic codebases\n');

  const rows = TIERS.map(tier => {
    process.stdout.write(`Running tier "${tier.name}" (${tier.clusters * tier.filesPerCluster} files)... `);
    const result = runTier(tier);
    console.log('done');
    return result;
  });

  console.log('\n=== Scale & correctness ===');
  console.log('tier    files  tasks  nodes  edges  events  idempotent-after-3-resyncs');
  for (const r of rows) {
    console.log(
      `${r.tier.padEnd(7)} ${String(r.totalFiles).padStart(5)}  ${String(r.totalTasks).padStart(5)}  ${String(r.nodeCount).padStart(5)}  ${String(r.edgeCount).padStart(5)}  ${String(r.eventCount).padStart(6)}  ${r.idempotent ? 'yes' : 'NO <-- BUG'}`
    );
  }

  console.log('\n=== Timing ===');
  console.log('tier    first-sync  avg-resync  retrieve   tiny-compile  small-compile  default-compile  large-compile');
  for (const r of rows) {
    console.log(
      `${r.tier.padEnd(7)} ${fmtMs(r.firstSyncMs).padStart(10)}  ${fmtMs(r.avgResyncMs).padStart(10)}  ${fmtMs(r.retrieveMs).padStart(8)}   ${fmtMs(r.profileTimings.tiny).padStart(12)}  ${fmtMs(r.profileTimings.small).padStart(13)}  ${fmtMs(r.profileTimings.default).padStart(15)}  ${fmtMs(r.profileTimings.large).padStart(13)}`
    );
  }

  console.log('\n=== Token efficiency (legacy full-IR-dump vs graph profile) ===');
  console.log('tier    legacy-tokens  tiny    small   default  large   reduction-vs-default');
  for (const r of rows) {
    const reduction = (1 - r.profileTokens.default / r.legacyTokens) * 100;
    console.log(
      `${r.tier.padEnd(7)} ${String(r.legacyTokens).padStart(13)}  ${String(r.profileTokens.tiny).padStart(6)}  ${String(r.profileTokens.small).padStart(6)}  ${String(r.profileTokens.default).padStart(7)}  ${String(r.profileTokens.large).padStart(6)}  ${reduction.toFixed(1)}%`
    );
  }

  console.log('\n=== Disk overhead (.relay/graph/* vs raw IR markdown) ===');
  console.log('tier    raw-ir-size  graph-dir-size  overhead-ratio');
  for (const r of rows) {
    console.log(
      `${r.tier.padEnd(7)} ${fmtBytes(r.irDiskBytes).padStart(11)}  ${fmtBytes(r.graphDiskBytes).padStart(14)}  ${(r.graphDiskBytes / r.irDiskBytes).toFixed(1)}x`
    );
  }

  console.log('\n=== Contradiction heuristic added cost (opt-in, off by default) ===');
  const hugeTier = TIERS.find(t => t.name === 'huge');
  const withHeuristicMs = runContradictionHeuristicCost(hugeTier);
  const hugeRow = rows.find(r => r.tier === 'huge');
  console.log(`huge tier first-sync without heuristic: ${fmtMs(hugeRow.firstSyncMs)}`);
  console.log(`huge tier first-sync WITH heuristic enabled: ${fmtMs(withHeuristicMs)}`);

  console.log('\n=== Verdict ===');
  const allIdempotent = rows.every(r => r.idempotent);
  const worstSyncRow = rows.reduce((a, b) => (b.firstSyncMs > a.firstSyncMs ? b : a));
  const worstResyncRow = rows.reduce((a, b) => (b.avgResyncMs > a.avgResyncMs ? b : a));
  const minReductionRow = rows.reduce((a, b) => {
    const ra = (1 - a.profileTokens.default / a.legacyTokens) * 100;
    const rb = (1 - b.profileTokens.default / b.legacyTokens) * 100;
    return rb < ra ? b : a;
  });
  const minReduction = (1 - minReductionRow.profileTokens.default / minReductionRow.legacyTokens) * 100;
  console.log(`Idempotent at every tier: ${allIdempotent ? 'YES' : 'NO — investigate before trusting this at scale'}`);
  console.log(`Worst-case first sync (${worstSyncRow.tier} tier, ${worstSyncRow.totalFiles} files): ${fmtMs(worstSyncRow.firstSyncMs)}`);
  console.log(`Worst-case re-sync (${worstResyncRow.tier} tier): ${fmtMs(worstResyncRow.avgResyncMs)}`);
  console.log(`Minimum token reduction across all tiers (default profile vs legacy, worst at "${minReductionRow.tier}"): ${minReduction.toFixed(1)}%`);
}

main();
