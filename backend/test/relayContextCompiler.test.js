const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');
const compiler = require('../lib/relayContextCompiler');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-compiler-test-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

function writeGraph(ws, nodes, edges, workingMemory) {
  const graphDir = path.join(ws, '.relay', 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(graphDir, 'nodes.json'), JSON.stringify(nodes));
  fs.writeFileSync(path.join(graphDir, 'edges.json'), JSON.stringify(edges));
  if (workingMemory) {
    fs.writeFileSync(path.join(graphDir, 'working_memory.json'), JSON.stringify(workingMemory));
  }
}

function item(nodeId, node, score) {
  return { nodeId, node, score, why: { seed: true, path: [nodeId], relation: null, components: {} } };
}

test('collapseChains: a 3-link SUPERSEDES chain collapses to one head with a history pointer', () => {
  const items = [
    item('decision:a', { id: 'decision:a', type: 'Decision', text: 'Use Postgres' }, 0.1),
    item('decision:b', { id: 'decision:b', type: 'Decision', text: 'Use MySQL' }, 0.2),
    item('decision:c', { id: 'decision:c', type: 'Decision', text: 'Use Redis' }, 0.9),
  ];
  const edges = [
    { from: 'decision:b', to: 'decision:a', relation: 'SUPERSEDES' },
    { from: 'decision:c', to: 'decision:b', relation: 'SUPERSEDES' },
  ];
  const { chains, consumed } = compiler.collapseChains(items, edges);
  assert.equal(consumed.size, 3);
  assert.ok(chains.has('decision:c'));
  assert.deepEqual(chains.get('decision:c'), ['decision:a', 'decision:b', 'decision:c']);
});

test('compileStructured: collapsed chain renders as one block, not three', () => {
  const items = [
    item('decision:a', { id: 'decision:a', type: 'Decision', text: 'Use Postgres' }, 0.1),
    item('decision:b', { id: 'decision:b', type: 'Decision', text: 'Use Redis' }, 0.9),
  ];
  const edges = [{ from: 'decision:b', to: 'decision:a', relation: 'SUPERSEDES' }];
  const result = compiler.compileStructured(items, edges, 1800, { applyFloor: false });

  assert.equal((result.text.match(/Decision \(current\)/g) || []).length, 1);
  assert.match(result.text, /History: Use Postgres → \(current\)/);
  assert.equal(result.text.match(/Use Redis/g).length, 1, 'the head text must appear exactly once, not duplicated in the history line');
  assert.deepEqual(new Set(result.includedNodeIds), new Set(['decision:b', 'decision:a']));
});

test('compileStructured: a dated history entry has its date prefix stripped before truncation, not after (found via a real benchmark — the date alone was eating most of the truncation budget)', () => {
  const items = [
    item('decision:a', { id: 'decision:a', type: 'Decision', text: '2026-02-01 — Use a single shared sandbox container per session' }, 0.1),
    item('decision:b', { id: 'decision:b', type: 'Decision', text: 'Use per-conversation isolated sandbox containers' }, 0.9),
  ];
  const edges = [{ from: 'decision:b', to: 'decision:a', relation: 'SUPERSEDES' }];
  const result = compiler.compileStructured(items, edges, 1800, { applyFloor: false });

  assert.ok(!result.text.includes('2026-02-01'), 'the date prefix must not consume the history line\'s display budget');
  assert.match(result.text, /History: Use a single shared/, 'real content, not just the date, must survive truncation');
});

test('compileStructured: greedy-fill never exceeds the token budget, and always returns at least one (truncated) block even when the budget is too small for one full block', () => {
  const items = [
    item('decision:a', { id: 'decision:a', type: 'Decision', text: 'x'.repeat(2000) }, 0.9),
    item('task:1', { id: 'task:1', type: 'Task', status: 'open', text: 'small task' }, 0.5),
  ];
  // even after per-field truncation (renderBlock caps text at 80 chars), the
  // rendered block is ~23 tokens — a 5-token budget forces the fallback path.
  const result = compiler.compileStructured(items, [], 5, { applyFloor: false });
  assert.ok(result.usedTokens <= 5);
  assert.ok(result.text.length > 0);
  assert.equal(result.includedNodeIds.length, 1, 'oversized first item consumes the whole budget alone, second item never reached');
});

test('compileStructured: drops low-score items once budget is exhausted, reports droppedCount', () => {
  const items = [
    item('decision:a', { id: 'decision:a', type: 'Decision', text: 'high priority decision' }, 0.9),
    item('decision:b', { id: 'decision:b', type: 'Decision', text: 'low priority decision' }, 0.1),
  ];
  // budget fits exactly one short block, not two
  const oneBlockTokens = compiler.estimateTokens('Decision: high priority decision');
  const result = compiler.compileStructured(items, [], oneBlockTokens, { applyFloor: false });
  assert.equal(result.includedNodeIds.length, 1);
  assert.equal(result.includedNodeIds[0], 'decision:a');
  assert.equal(result.droppedCount, 1);
});

test('applyAgentWeights: Claude weighting ranks a Decision above a File that BM25 scored higher', () => {
  const items = [
    item('file:a.js', { id: 'file:a.js', type: 'File', text: 'a.js' }, 1.0),
    item('decision:a', { id: 'decision:a', type: 'Decision', text: 'Use Redis' }, 0.8),
  ];
  const weighted = compiler.applyAgentWeights(items, 'Claude Code');
  assert.equal(weighted[0].nodeId, 'decision:a', 'Claude profile weights Decision higher than File');
});

test('compileForResolution: tiny profile reads working_memory.json directly, no retrieval needed', () => {
  const ws = makeWorkspace();
  writeGraph(ws, [], [], {
    goals: [{ id: 'goal:1', type: 'Goal', text: 'Reduce context size', importance: 1 }],
    tasks: [{ id: 'task:1', type: 'Task', status: 'open', text: 'Build compiler', importance: 1 }],
    decisions: [],
    blockers: [],
  });

  const result = compiler.compileForResolution(ws, 'tiny', { recordAccess: false });
  assert.equal(result.profile, 'tiny');
  assert.match(result.text, /Reduce context size/);
  assert.match(result.text, /Build compiler/);
});

test('compileForResolution: default/small/large profiles use increasing token budgets on the same graph', () => {
  const ws = makeWorkspace();
  const now = new Date().toISOString();
  const nodes = Array.from({ length: 30 }, (_, i) => ({
    id: `decision:${i}`, type: 'Decision', text: `decision number ${i} about redis caching strategy`,
    status: 'active', confidence: 0.6, importance: 1, decay_rate: 0.01, last_verified: now,
  }));
  writeGraph(ws, nodes, []);

  const small = compiler.compileForResolution(ws, 'small', { query: 'redis caching', recordAccess: false });
  const large = compiler.compileForResolution(ws, 'large', { query: 'redis caching', recordAccess: false });
  assert.ok(large.usedTokens >= small.usedTokens);
  assert.ok(large.includedNodeIds.length >= small.includedNodeIds.length);
});

test('compileForResolution: recordAccess emits NodeAccessed events that bump importance on the next rebuild', () => {
  const ws = makeWorkspace();
  const now = new Date().toISOString();
  writeGraph(ws, [
    { id: 'decision:a', type: 'Decision', text: 'use redis for caching', status: 'active', confidence: 0.9, importance: 1, decay_rate: 0.01, last_verified: now, sourceEventIds: [] },
  ], []);

  compiler.compileForResolution(ws, 'default', { query: 'redis caching', recordAccess: true });

  const events = relayGraph.readEvents(ws);
  assert.ok(events.some(e => e.type === 'NodeAccessed' && e.nodeId === 'decision:a'));
});
