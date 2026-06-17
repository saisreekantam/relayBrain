const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');
const stats = require('../lib/relayGraphStats');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-graphstats-test-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

test('buildGraphStats: counts nodes by type and edges by relation', () => {
  const nodes = [
    { id: 'd1', type: 'Decision', status: 'active' },
    { id: 'd2', type: 'Decision', status: 'superseded' },
    { id: 'f1', type: 'File', text: 'a.js' },
  ];
  const edges = [{ from: 'd2', to: 'd1', relation: 'SUPERSEDES' }];
  const report = stats.buildGraphStats(nodes, edges);
  assert.deepEqual(report.nodeCounts, { Decision: 2, File: 1 });
  assert.deepEqual(report.edgeCounts, { SUPERSEDES: 1 });
});

test('mostReferencedFiles: ranks by CO_EDITED degree, ignores other relations', () => {
  const nodes = [
    { id: 'file:a.js', type: 'File', text: 'a.js' },
    { id: 'file:b.js', type: 'File', text: 'b.js' },
    { id: 'file:c.js', type: 'File', text: 'c.js' },
  ];
  const edges = [
    { from: 'file:a.js', to: 'file:b.js', relation: 'CO_EDITED' },
    { from: 'file:a.js', to: 'file:c.js', relation: 'CO_EDITED' },
    { from: 'decision:x', to: 'file:a.js', relation: 'IMPLEMENTED_BY' }, // must not count
  ];
  const top = stats.mostReferencedFiles(nodes, edges);
  assert.equal(top[0].id, 'file:a.js');
  assert.equal(top[0].coEditCount, 2);
});

test('decisionStats: reversal rate counts superseded + contradicted, not active/resolved', () => {
  const nodes = [
    { type: 'Decision', status: 'active' },
    { type: 'Decision', status: 'superseded' },
    { type: 'Decision', status: 'contradicted' },
    { type: 'Decision', status: 'resolved' },
  ];
  const report = stats.decisionStats(nodes);
  assert.equal(report.total, 4);
  assert.equal(report.reversalRate, 0.5);
});

test('failureStats: splits open vs resolved', () => {
  const nodes = [
    { type: 'Failure', status: 'open' },
    { type: 'Failure', status: 'resolved' },
    { type: 'Failure', status: 'resolved' },
  ];
  const report = stats.failureStats(nodes);
  assert.deepEqual(report, { total: 3, open: 1, resolved: 2 });
});

test('buildGraphStats: agent reputation is sorted descending and present for decision authors', () => {
  const nodes = [
    { type: 'Decision', status: 'active', author: 'human' },
    { type: 'Decision', status: 'superseded', author: 'Cursor' },
    { type: 'Decision', status: 'active', author: 'Cursor' },
  ];
  const report = stats.buildGraphStats(nodes, []);
  assert.equal(report.agentReputation[0].author, 'human');
  assert.ok(report.agentReputation[0].reputation > report.agentReputation[1].reputation);
});

test('renderGraphStatsText: produces readable text without throwing on an empty graph', () => {
  const text = stats.renderGraphStatsText(stats.buildGraphStats([], []));
  assert.match(text, /Nodes by type/);
  assert.match(text, /Decisions: 0 total/);
});

test('loadGraphStats: end-to-end against a real synced workspace', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'current_task.md'), '- [ ] Ship the stats command\n');
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'), '# Decisions\n\n## Open\n- Use BM25 before embeddings\n');
  fs.writeFileSync(path.join(ws, '.relay', 'memory.json'), JSON.stringify({ workspace: ws, timeline: [] }));
  relayGraph.syncGraph(ws);

  const report = stats.loadGraphStats(ws);
  assert.equal(report.nodeCounts.Task, 1);
  assert.equal(report.nodeCounts.Decision, 1);
  assert.equal(report.decisions.total, 1);
});
