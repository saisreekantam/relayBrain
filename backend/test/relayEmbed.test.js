const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');
const relayEmbed = require('../lib/relayEmbed');
const { retrieve } = require('../lib/relayRetrieve');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-embed-test-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

// --- Pure math, deterministic, no model/network involved --------------------

test('cosineSimilarity: identical vectors -> 1, orthogonal -> 0, opposite -> -1', () => {
  assert.equal(relayEmbed.cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(relayEmbed.cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(relayEmbed.cosineSimilarity([1, 0], [-1, 0]), -1);
});

test('cosineSimilarity: works correctly on non-normalized vectors (does not assume unit length)', () => {
  const a = [3, 4]; // length 5
  const b = [6, 8]; // length 10, same direction as a
  assert.ok(Math.abs(relayEmbed.cosineSimilarity(a, b) - 1) < 1e-9);
});

test('cosineSimilarity: mismatched lengths or empty vectors return 0, never throw', () => {
  assert.equal(relayEmbed.cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(relayEmbed.cosineSimilarity([], []), 0);
  assert.equal(relayEmbed.cosineSimilarity(null, [1]), 0);
});

test('hashText: deterministic, changes when text changes', () => {
  assert.equal(relayEmbed.hashText('hello'), relayEmbed.hashText('hello'));
  assert.notEqual(relayEmbed.hashText('hello'), relayEmbed.hashText('world'));
});

// --- Blending logic in retrieve(), using a hand-built embeddings cache ------
// (no real model call — proves the wiring/math, independent of whether the
// optional @huggingface/transformers package is even installed)

function writeGraph(ws, nodes, edges, embeddings) {
  const graphDir = path.join(ws, '.relay', 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(graphDir, 'nodes.json'), JSON.stringify(nodes));
  fs.writeFileSync(path.join(graphDir, 'edges.json'), JSON.stringify(edges || []));
  if (embeddings) fs.writeFileSync(path.join(graphDir, 'embeddings.json'), JSON.stringify(embeddings));
}

test('retrieve: without queryEmbedding, behavior is unchanged from Phase 2 (BM25-only) even if an embeddings cache exists on disk', () => {
  const ws = makeWorkspace();
  writeGraph(
    ws,
    [{ id: 'decision:a', type: 'Decision', text: 'Use Redis for session storage', confidence: 0.9, importance: 1, decay_rate: 0.01, last_verified: new Date().toISOString() }],
    [],
    { 'decision:a': { hash: 'x', vector: [1, 0, 0] } },
  );
  const results = retrieve(ws, 'redis session storage');
  assert.equal(results.length, 1);
  assert.equal(results[0].why.components.relevance, 1, 'pure BM25 path must be untouched when no queryEmbedding is passed');
});

test('retrieve: a node with zero BM25 overlap but high embedding similarity still surfaces as a seed when queryEmbedding is supplied', () => {
  const ws = makeWorkspace();
  writeGraph(
    ws,
    [
      { id: 'decision:semantic', type: 'Decision', text: 'Adopt an in-memory cache for ephemeral session data', confidence: 0.8, importance: 1, decay_rate: 0.01, last_verified: new Date().toISOString() },
      { id: 'decision:unrelated', type: 'Decision', text: 'Switch the landing page font to a serif typeface', confidence: 0.8, importance: 1, decay_rate: 0.01, last_verified: new Date().toISOString() },
    ],
    [],
    {
      'decision:semantic': { hash: 'x', vector: [1, 0, 0] },
      'decision:unrelated': { hash: 'y', vector: [0, 1, 0] },
    },
  );

  // Query text shares zero keywords with either node's text (no BM25 match at
  // all), but its embedding is identical in direction to decision:semantic's.
  const results = retrieve(ws, 'redis caching layer', { queryEmbedding: [1, 0, 0] });
  assert.ok(results.length > 0, 'embedding-only relevance must still produce seeds even when BM25 finds nothing');
  assert.equal(results[0].nodeId, 'decision:semantic');
  assert.ok(!results.some(r => r.nodeId === 'decision:unrelated'), 'orthogonal embedding + no keyword overlap must not surface');
});

test('retrieve: blends BM25 and embedding signals — a node strong on both outranks a node strong on only one', () => {
  const ws = makeWorkspace();
  writeGraph(
    ws,
    [
      { id: 'decision:both', type: 'Decision', text: 'Use Redis for the session cache', confidence: 0.8, importance: 1, decay_rate: 0.01, last_verified: new Date().toISOString() },
      { id: 'decision:bm25-only', type: 'Decision', text: 'Use Redis for rate limiting counters', confidence: 0.8, importance: 1, decay_rate: 0.01, last_verified: new Date().toISOString() },
    ],
    [],
    {
      'decision:both': { hash: 'x', vector: [1, 0, 0] },
      'decision:bm25-only': { hash: 'y', vector: [0, 0, 1] }, // orthogonal to the query embedding
    },
  );

  const results = retrieve(ws, 'redis session cache', { queryEmbedding: [1, 0, 0] });
  const both = results.find(r => r.nodeId === 'decision:both');
  const bm25Only = results.find(r => r.nodeId === 'decision:bm25-only');
  assert.ok(both.score > bm25Only.score, 'a node matching on both signals should outrank one matching on keywords alone');
});

test('retrieve: a node missing from the embeddings cache falls back to BM25-only for that node specifically, without erroring', () => {
  const ws = makeWorkspace();
  writeGraph(
    ws,
    [{ id: 'decision:no-vector', type: 'Decision', text: 'Use Redis for session storage', confidence: 0.8, importance: 1, decay_rate: 0.01, last_verified: new Date().toISOString() }],
    [],
    {}, // empty cache — this node was never embedded (e.g. embeddings.json predates the node)
  );
  const results = retrieve(ws, 'redis session storage', { queryEmbedding: [1, 0, 0] });
  assert.equal(results.length, 1);
  assert.equal(results[0].why.components.relevance, 1, 'BM25-only relevance for a node with no cached embedding');
});

// --- embedGraphNodes file I/O, no real model call (empty node set) ---------

test('embedGraphNodes: empty graph writes an empty embeddings.json and reports zero embedded, never throws', async () => {
  const ws = makeWorkspace();
  fs.mkdirSync(path.join(ws, '.relay', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.relay', 'graph', 'nodes.json'), '[]');
  const result = await relayEmbed.embedGraphNodes(ws);
  assert.equal(result.totalNodes, 0);
  assert.equal(result.embeddedCount, 0);
  const cache = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'embeddings.json'), 'utf-8'));
  assert.deepEqual(cache, {});
});

// --- Live, network-dependent test — skipped by default ---------------------
// Keeps `npm test` fast and offline-safe by default (matches the project's
// own "zero paid API calls, zero required network" stance). Run explicitly
// with: RELAY_TEST_LIVE_EMBEDDINGS=1 npm test
const liveEnabled = process.env.RELAY_TEST_LIVE_EMBEDDINGS === '1';

test('LIVE: real local model embeds semantically similar sentences closer than unrelated ones', { skip: !liveEnabled }, async () => {
  relayEmbed._resetForTests();
  const a = await relayEmbed.embedText('Use Redis for the session cache');
  const b = await relayEmbed.embedText('Adopt an in-memory store for session data');
  const c = await relayEmbed.embedText('Switch the landing page font to a serif typeface');

  assert.ok(relayEmbed.isAvailable(), `expected the model to load; reason if not: ${relayEmbed.unavailabilityReason()}`);
  assert.ok(a && b && c);

  const simRelated = relayEmbed.cosineSimilarity(a, b);
  const simUnrelated = relayEmbed.cosineSimilarity(a, c);
  console.log(`[live-embed] sim(redis-cache, in-memory-store)=${simRelated.toFixed(3)} sim(redis-cache, font-change)=${simUnrelated.toFixed(3)}`);
  assert.ok(simRelated > simUnrelated, 'semantically related sentences should be more similar than an unrelated one');
});

test('LIVE: embedGraphNodes end-to-end with the real model, then retrieve via retrieveWithEmbeddings', { skip: !liveEnabled }, async () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'current_task.md'), '- [ ] Pick a cache for session storage\n- [ ] Redesign the landing page typography\n');
  fs.writeFileSync(path.join(ws, '.relay', 'memory.json'), JSON.stringify({ workspace: ws, timeline: [] }));
  relayGraph.syncGraph(ws);

  const embedResult = await relayEmbed.embedGraphNodes(ws);
  assert.ok(embedResult.available, embedResult.reason || '');
  assert.ok(embedResult.embeddedCount > 0);

  const { retrieveWithEmbeddings } = require('../lib/relayRetrieve');
  const results = await retrieveWithEmbeddings(ws, 'in-memory data store for sessions');
  assert.ok(results.some(r => r.node.text.includes('cache for session storage')));
});
