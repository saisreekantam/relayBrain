const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');
const { buildCompileBrief } = require('../lib/relayContext');
const { retrieve } = require('../lib/relayRetrieve');
const { compileForResolution, estimateTokens } = require('../lib/relayContextCompiler');

// Simulates a long-lived, multi-subsystem codebase: 10 clusters x 20 files,
// 6 tasks/cluster, a goal/cluster, ~20 historical resolved decisions, one
// real cross-batch contradiction, and edit history spread across "months" so
// co-edit windowing has to correctly separate clusters in time, not just by name.
const CLUSTERS = ['auth', 'billing', 'search', 'notifications', 'onboarding', 'analytics', 'admin', 'mobile', 'payments', 'infra'];
const FILES_PER_CLUSTER = 20;
const TASKS_PER_CLUSTER = 6;
const BASE_TS = Date.parse('2026-01-01T00:00:00.000Z');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-long-codebase-test-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

function buildSyntheticProject(ws) {
  const relayDir = path.join(ws, '.relay');

  // Edit history: each cluster gets a tight burst (1 min apart, well inside the
  // 30-min co-edit window), bursts 10 days apart (so clusters never co-edit
  // across each other) — 200 FileTouched events total.
  const timeline = [];
  let clusterStart = BASE_TS;
  for (const cluster of CLUSTERS) {
    let t = clusterStart;
    for (let i = 0; i < FILES_PER_CLUSTER; i++) {
      timeline.push({
        kind: 'code_edit', source: 'Cursor', ts: new Date(t).toISOString(),
        path: `src/${cluster}/file${i}.js`, file: `file${i}.js`,
        summary: `update ${cluster} file ${i}`,
      });
      t += 60 * 1000;
    }
    clusterStart += 10 * 24 * 60 * 60 * 1000;
  }
  fs.writeFileSync(path.join(relayDir, 'memory.json'), JSON.stringify({ workspace: ws, timeline }));

  const taskLines = [];
  for (const cluster of CLUSTERS) {
    for (let i = 0; i < TASKS_PER_CLUSTER; i++) {
      const checked = i < 2 ? 'x' : ' ';
      taskLines.push(`- [${checked}] ${cluster}: task ${i} — improve ${cluster} subsystem throughput and error handling`);
    }
  }
  fs.writeFileSync(path.join(relayDir, 'current_task.md'), `# Current Tasks\n\n## In progress\n${taskLines.join('\n')}\n`);

  const goalLines = CLUSTERS.map(c => `- Improve ${c} subsystem reliability and reduce latency`);
  fs.writeFileSync(path.join(relayDir, 'project.md'), `# Project Summary\n\n## Goals\n${goalLines.join('\n')}\n`);

  // Deliberately varied phrasing per cluster, not an identical template —
  // a templated "Use X for the {cluster} subsystem" repeated 10 times with
  // only the cluster name differing previously caused a real false-positive
  // (every cluster shared so much boilerplate that the contradiction
  // heuristic flagged unrelated clusters against each other; see relayGraph
  // overlapCoefficient + the false-positive guard test in
  // relayGraphIngestion.test.js for the permanent regression coverage).
  const decisionTechChoice = {
    auth: 'OAuth2 with short-lived tokens', billing: 'Stripe webhooks', search: 'Elasticsearch',
    notifications: 'a dedicated message queue', onboarding: 'a multi-step wizard flow', analytics: 'batched nightly jobs',
    admin: 'role-based access control', mobile: 'native push notifications', payments: 'idempotency keys', infra: 'Terraform',
  };
  const openDecisions = CLUSTERS.map(c => `- Use ${decisionTechChoice[c]} for the ${c} subsystem`);
  // a real, same-batch contradiction for one cluster (billing) — restated closely, as a real reversal would be — should be auto-caught when the heuristic is enabled
  openDecisions.push('- Avoid using Stripe webhooks for the billing subsystem after reliability issues');

  const resolvedDecisions = Array.from({ length: 24 }, (_, i) =>
    `- 2026-0${(i % 9) + 1}-1${i % 9} — Historical resolved decision ${i} about ${CLUSTERS[i % CLUSTERS.length]} subsystem configuration, written as a realistic full sentence with enough length to matter for token counting.`);

  fs.writeFileSync(path.join(relayDir, 'decisions.md'),
    `# Decisions\n\n## Open\n${openDecisions.join('\n')}\n\n## Resolved\n\n${resolvedDecisions.join('\n')}\n`);

  const failureLines = CLUSTERS.slice(0, 5).map(c => `- ${c} subsystem hit a context overflow when the full architecture doc was loaded wholesale`);
  fs.writeFileSync(path.join(relayDir, 'failures.md'), `# Failures\n\n${failureLines.join('\n')}\n`);

  fs.writeFileSync(path.join(relayDir, 'config.json'), JSON.stringify({ workspace: ws, graph: { enabled: true, contradictionHeuristic: true } }));
}

test('long codebase: full sync completes fast, is idempotent, and produces a graph proportional to the synthetic project', () => {
  const ws = makeWorkspace();
  buildSyntheticProject(ws);

  const t0 = Date.now();
  const first = relayGraph.syncGraph(ws);
  const firstMs = Date.now() - t0;

  const t1 = Date.now();
  const second = relayGraph.syncGraph(ws);
  const secondMs = Date.now() - t1;

  console.log(`[scale] first sync: ${first.nodeCount} nodes, ${first.edgeCount} edges, ${first.eventCount} events in ${firstMs}ms`);
  console.log(`[scale] re-sync (no-op): ${secondMs}ms, ingested +${second.ingestedEvents}`);

  assert.ok(firstMs < 2000, `first sync of a 10-cluster/200-file synthetic project should complete well under 2s, took ${firstMs}ms`);
  assert.equal(second.ingestedEvents, 0, 're-syncing an unchanged long codebase must not re-ingest anything');
  assert.ok(secondMs < firstMs, 'a no-op re-sync should be faster than the initial ingest');

  // File: 200, Task: 60, Goal: 10, Decision: open(11) + resolved(24) = 35, Failure: 5
  assert.equal(first.nodeCount, 200 + 60 + 10 + 35 + 5);
});

test('long codebase: the same-batch contradiction (billing queue) is still caught at scale with the heuristic enabled', () => {
  const ws = makeWorkspace();
  buildSyntheticProject(ws);
  relayGraph.syncGraph(ws);

  const nodes = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'nodes.json'), 'utf-8'));
  const billingQueueDecision = nodes.find(n => n.type === 'Decision' && n.text.includes('Use Stripe webhooks for the billing'));
  assert.ok(billingQueueDecision, 'expected to find the billing decision node');
  assert.equal(billingQueueDecision.status, 'contradicted');

  const edges = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'edges.json'), 'utf-8'));
  assert.ok(edges.some(e => e.relation === 'CONTRADICTS'));

  // other clusters' equivalent decisions must NOT be falsely flagged
  const authQueueDecision = nodes.find(n => n.type === 'Decision' && n.text.includes('for the auth subsystem'));
  assert.equal(authQueueDecision.status, 'active');
});

test('long codebase: co-edit windowing keeps clusters separate — files from different 10-day-apart bursts are not linked', () => {
  const ws = makeWorkspace();
  buildSyntheticProject(ws);
  relayGraph.syncGraph(ws);

  const edges = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'edges.json'), 'utf-8'));
  const coEdits = edges.filter(e => e.relation === 'CO_EDITED');
  assert.ok(coEdits.length > 0, 'expected co-edit edges within at least the most recent cluster window');

  for (const edge of coEdits) {
    const clusterOf = (id) => (id.match(/src\/([a-z]+)\//) || [])[1];
    assert.equal(clusterOf(edge.from), clusterOf(edge.to), `cross-cluster co-edit edge found: ${edge.from} <-> ${edge.to}`);
  }
});

test('long codebase: multi-hop retrieval for one cluster surfaces that cluster\'s Goal/Decision/Task and does not pull in other clusters\' nodes', () => {
  const ws = makeWorkspace();
  buildSyntheticProject(ws);
  relayGraph.syncGraph(ws);

  const results = retrieve(ws, 'notifications subsystem throughput latency', { hops: 2, topK: 10 });
  assert.ok(results.length > 0);

  const top = results.slice(0, 8);
  assert.ok(top.some(r => r.node.text.includes('notifications')), 'expected the notifications cluster to surface in the top results');

  const offTopicClusters = ['payments', 'infra', 'admin', 'mobile'];
  const leaked = top.filter(r => offTopicClusters.some(c => r.node.text.toLowerCase().includes(c)));
  assert.equal(leaked.length, 0, `unrelated clusters leaked into top results: ${JSON.stringify(leaked.map(r => r.node.text))}`);
});

test('long codebase: small/default profile token budgets are respected regardless of total graph size (315 nodes)', () => {
  const ws = makeWorkspace();
  buildSyntheticProject(ws);
  relayGraph.syncGraph(ws);

  const small = compileForResolution(ws, 'small', { query: 'auth subsystem reliability', recordAccess: false });
  const dflt = compileForResolution(ws, 'default', { query: 'auth subsystem reliability', recordAccess: false });

  assert.ok(small.usedTokens <= small.tokenBudget);
  assert.ok(dflt.usedTokens <= dflt.tokenBudget);
});

test('scaling: efficiency gap between legacy full-IR-dump and graph tiny-profile widens, not just holds steady, as the same project keeps accumulating history', () => {
  const ws = makeWorkspace();
  buildSyntheticProject(ws);
  relayGraph.syncGraph(ws);

  const legacySmall = estimateTokens(Object.values(buildCompileBrief(ws).irSnapshot).join('\n'));
  const tinySmall = compileForResolution(ws, 'tiny', { recordAccess: false }).usedTokens;

  // simulate the project growing further: append another 24 resolved decisions
  const decisionsPath = path.join(ws, '.relay', 'decisions.md');
  const more = Array.from({ length: 24 }, (_, i) =>
    `- 2026-1${i % 2}-0${(i % 9) + 1} — Another historical resolved decision ${i + 24}, also a realistic full sentence about subsystem configuration history.`);
  fs.appendFileSync(decisionsPath, `${more.join('\n')}\n`);

  relayGraph.syncGraph(ws);
  const legacyLarge = estimateTokens(Object.values(buildCompileBrief(ws).irSnapshot).join('\n'));
  const tinyLarge = compileForResolution(ws, 'tiny', { recordAccess: false }).usedTokens;

  const gapSmall = legacySmall - tinySmall;
  const gapLarge = legacyLarge - tinyLarge;
  console.log(`[scale] legacy tokens: ${legacySmall} -> ${legacyLarge} (+${legacyLarge - legacySmall}) | tiny graph tokens: ${tinySmall} -> ${tinyLarge} (+${tinyLarge - tinySmall})`);
  console.log(`[scale] absolute token gap: ${gapSmall} -> ${gapLarge}`);

  assert.ok(legacyLarge > legacySmall, 'legacy full dump must grow as more history accumulates');
  assert.ok(tinyLarge <= tinySmall + 20, 'tiny graph profile must stay essentially flat regardless of total history size');
  assert.ok(gapLarge > gapSmall, 'the efficiency gap must widen, not just hold steady, as the codebase grows');
});
