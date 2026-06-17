const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');
const relayRetrieve = require('../lib/relayRetrieve');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-retrieve-test-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

function writeGraph(ws, nodes, edges) {
  const graphDir = path.join(ws, '.relay', 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(graphDir, 'nodes.json'), JSON.stringify(nodes));
  fs.writeFileSync(path.join(graphDir, 'edges.json'), JSON.stringify(edges));
}

test('tokenize lowercases and strips punctuation', () => {
  assert.deepEqual(relayRetrieve.tokenize('Use Redis, not Postgres!'), ['use', 'redis', 'not', 'postgres']);
});

test('scoreAllNodes ranks an exact-keyword node above an unrelated one', () => {
  const nodes = [
    { id: 'a', text: 'Use Redis for the session cache' },
    { id: 'b', text: 'Unrelated note about the landing page' },
  ];
  const scores = relayRetrieve.scoreAllNodes('redis session cache', nodes);
  assert.ok(scores.get('a') > scores.get('b'));
});

test('retrieve: seed node found directly by text, marked seed=true with full component breakdown', () => {
  const ws = makeWorkspace();
  writeGraph(ws, [
    { id: 'decision:a', type: 'Decision', text: 'Use Redis for session cache', status: 'active', confidence: 0.95, importance: 1, decay_rate: 0.01, last_verified: new Date().toISOString(), author: 'human' },
  ], []);

  const results = relayRetrieve.retrieve(ws, 'redis session cache');
  assert.equal(results.length, 1);
  assert.equal(results[0].why.seed, true);
  assert.ok(results[0].why.components.relevance > 0);
  assert.equal(results[0].why.components.confidence, 0.95);
});

test('retrieve: traversal reaches a connected Goal node not directly matched by the query, with decayed score and explainable path', () => {
  const ws = makeWorkspace();
  const now = new Date().toISOString();
  writeGraph(ws, [
    { id: 'decision:a', type: 'Decision', text: 'Use BM25 before embeddings', status: 'active', confidence: 0.9, importance: 1, decay_rate: 0.01, last_verified: now, author: 'human' },
    { id: 'goal:1', type: 'Goal', text: 'Reduce context window cost', status: 'open', confidence: 0.6, importance: 1, decay_rate: 0.005, last_verified: now },
  ], [
    { from: 'decision:a', to: 'goal:1', relation: 'SERVES', weight: 1, valid_from: now, valid_to: null },
  ]);

  const results = relayRetrieve.retrieve(ws, 'bm25 embeddings', { hops: 1 });
  const goal = results.find(r => r.nodeId === 'goal:1');
  const decision = results.find(r => r.nodeId === 'decision:a');

  assert.ok(decision.why.seed);
  assert.ok(goal, 'goal should be reached via 1-hop traversal');
  assert.equal(goal.why.seed, false);
  assert.deepEqual(goal.why.path, ['decision:a', 'goal:1']);
  assert.equal(goal.why.relation, 'SERVES');
  assert.ok(goal.score < decision.score, 'traversed node should score lower than the seed that led to it');
});

test('retrieve: respects hop limit — a node 2 hops away is not returned when hops=1', () => {
  const ws = makeWorkspace();
  const now = new Date().toISOString();
  writeGraph(ws, [
    { id: 'decision:a', type: 'Decision', text: 'Use BM25', status: 'active', confidence: 0.9, importance: 1, decay_rate: 0.01, last_verified: now },
    { id: 'goal:1', type: 'Goal', text: 'middle hop', status: 'open', confidence: 0.6, importance: 1, decay_rate: 0.005, last_verified: now },
    { id: 'task:1', type: 'Task', text: 'two hops away', status: 'open', confidence: 0.6, importance: 1, decay_rate: 0.03, last_verified: now },
  ], [
    { from: 'decision:a', to: 'goal:1', relation: 'SERVES', weight: 1, valid_from: now, valid_to: null },
    { from: 'goal:1', to: 'task:1', relation: 'RELATES_TO', weight: 1, valid_from: now, valid_to: null },
  ]);

  const oneHop = relayRetrieve.retrieve(ws, 'bm25', { hops: 1 });
  assert.ok(!oneHop.some(r => r.nodeId === 'task:1'));

  const twoHop = relayRetrieve.retrieve(ws, 'bm25', { hops: 2 });
  assert.ok(twoHop.some(r => r.nodeId === 'task:1'));
});

test('retrieve: expired (valid_to in the past) edge is not traversed unless history=true', () => {
  const ws = makeWorkspace();
  const now = new Date().toISOString();
  const past = '2020-01-01T00:00:00.000Z';
  writeGraph(ws, [
    { id: 'decision:a', type: 'Decision', text: 'Use BM25', status: 'active', confidence: 0.9, importance: 1, decay_rate: 0.01, last_verified: now },
    { id: 'goal:1', type: 'Goal', text: 'old goal', status: 'open', confidence: 0.6, importance: 1, decay_rate: 0.005, last_verified: now },
  ], [
    { from: 'decision:a', to: 'goal:1', relation: 'SERVES', weight: 1, valid_from: past, valid_to: past },
  ]);

  const current = relayRetrieve.retrieve(ws, 'bm25', { hops: 1 });
  assert.ok(!current.some(r => r.nodeId === 'goal:1'));

  const withHistory = relayRetrieve.retrieve(ws, 'bm25', { hops: 1, history: true });
  assert.ok(withHistory.some(r => r.nodeId === 'goal:1'));
});

test('computeAgentReputation: an author with a reversed decision scores lower than one with none', () => {
  const nodes = [
    { id: 'decision:1', type: 'Decision', author: 'Cursor', status: 'superseded' },
    { id: 'decision:2', type: 'Decision', author: 'human', status: 'active' },
  ];
  const reputation = relayRetrieve.computeAgentReputation(nodes);
  assert.ok(reputation.get('Cursor') < reputation.get('human'));
});

test('retrieve: human-confirmed decision outranks a superseded agent decision on the same topic', () => {
  const ws = makeWorkspace();
  const now = new Date().toISOString();
  writeGraph(ws, [
    { id: 'decision:cursor', type: 'Decision', text: 'Use Postgres for sessions', status: 'superseded', confidence: 0.12, importance: 1, decay_rate: 0.01, last_verified: now, author: 'Cursor' },
    { id: 'decision:human', type: 'Decision', text: 'Use Redis for sessions', status: 'active', confidence: 0.95, importance: 1, decay_rate: 0.01, last_verified: now, author: 'human' },
  ], []);

  const results = relayRetrieve.retrieve(ws, 'sessions storage decision');
  const human = results.find(r => r.nodeId === 'decision:human');
  const cursor = results.find(r => r.nodeId === 'decision:cursor');
  assert.ok(human.score > cursor.score);
});

test('end-to-end: syncGraph from real IR markdown, then retrieve finds the matching open task', () => {
  const ws = makeWorkspace();
  const relayDir = path.join(ws, '.relay');
  fs.writeFileSync(path.join(relayDir, 'current_task.md'), '- [ ] Build BM25 retrieval module\n- [ ] Write the landing page copy\n');
  fs.writeFileSync(path.join(relayDir, 'memory.json'), JSON.stringify({ workspace: ws, timeline: [] }));

  relayGraph.syncGraph(ws);
  const results = relayRetrieve.retrieve(ws, 'BM25 retrieval');
  assert.ok(results.length > 0);
  assert.equal(results[0].node.text, 'Build BM25 retrieval module');
});

test('retrieve: empty query text ranks by confidence/freshness/importance instead of returning nothing (regression — found via a real `relay context` smoke test)', () => {
  // BM25 against an empty query scores every node 0. Without the fix, that
  // collapsed to "no seeds, no results" — which would have made Phase 6's
  // default-on MEMORY GRAPH section empty for the single most common call
  // shape (`relay context` with no explicit query).
  const ws = makeWorkspace();
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 200 * 86400000).toISOString();
  writeGraph(ws, [
    { id: 'decision:fresh-confident', type: 'Decision', text: 'Use Redis for session storage', status: 'active', confidence: 0.95, importance: 1.5, decay_rate: 0.01, last_verified: now },
    { id: 'decision:stale-low-confidence', type: 'Decision', text: 'Maybe try a different cache library someday', status: 'active', confidence: 0.6, importance: 1.0, decay_rate: 0.05, last_verified: stale },
  ], []);

  const results = relayRetrieve.retrieve(ws, '');
  assert.ok(results.length > 0, 'empty query must not collapse to zero results');
  assert.equal(results[0].nodeId, 'decision:fresh-confident', 'higher confidence/freshness/importance should win seed selection when there is no textual signal at all');
});

test('retrieve: whitespace-only query behaves the same as empty (also no real tokens)', () => {
  const ws = makeWorkspace();
  writeGraph(ws, [
    { id: 'decision:a', type: 'Decision', text: 'Use Redis for session storage', status: 'active', confidence: 0.9, importance: 1, decay_rate: 0.01, last_verified: new Date().toISOString() },
  ], []);
  const results = relayRetrieve.retrieve(ws, '   ');
  assert.equal(results.length, 1);
});

// --- Directory-match boost (the previously-deferred BM25 path-weighting gap) ---

test('pathComponents: splits a path into lowercase segments, both slash styles', () => {
  assert.deepEqual(relayRetrieve.pathComponents('src/area3/file0.js'), ['src', 'area3', 'file0.js']);
  assert.deepEqual(relayRetrieve.pathComponents('src\\area3\\file0.js'), ['src', 'area3', 'file0.js']);
});

test('buildDirComponentDf: counts directory tokens only, not the terminal filename', () => {
  const nodes = [
    { type: 'File', text: 'src/area3/file0.js' },
    { type: 'File', text: 'src/area3/file1.js' },
    { type: 'File', text: 'src/area4/file0.js' },
    { type: 'Decision', text: 'area3 mentioned in prose, not a path' }, // must be ignored — not a File node
  ];
  const { df, totalFiles } = relayRetrieve.buildDirComponentDf(nodes);
  assert.equal(totalFiles, 3);
  assert.equal(df.get('src'), 3, '"src" is a directory component of every file');
  assert.equal(df.get('area3'), 2);
  assert.equal(df.get('area4'), 1);
  assert.equal(df.get('file0'), undefined, 'the terminal filename must not be counted as a directory token');
});

test('eligibleDirQueryTokens: excludes a near-universal directory name, keeps a specific one', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ type: 'File', text: `src/area${i % 2}/file${i}.js` }));
  const { df, totalFiles } = relayRetrieve.buildDirComponentDf(nodes);
  // "src" is in 100% of files (boilerplate); "area0"/"area1" are each in 50%
  const eligible = relayRetrieve.eligibleDirQueryTokens(['src', 'area0', 'nonexistent'], df, totalFiles);
  assert.deepEqual(eligible, ['area0']);
});

test('eligibleDirQueryTokens: small-corpus escape hatch — below the minimum, nothing is excluded as boilerplate', () => {
  const nodes = [{ type: 'File', text: 'src/area0/file0.js' }, { type: 'File', text: 'src/area1/file1.js' }];
  const { df, totalFiles } = relayRetrieve.buildDirComponentDf(nodes);
  assert.deepEqual(relayRetrieve.eligibleDirQueryTokens(['src'], df, totalFiles), ['src'], 'too few files to judge "src" as boilerplate yet');
});

test('dirMatchRatio: 0 for non-File nodes and for nodes with no path overlap, fractional for partial matches', () => {
  const fileNode = { type: 'File', text: 'src/area3/file0.js' };
  const decisionNode = { type: 'Decision', text: 'Use Redis' };
  assert.equal(relayRetrieve.dirMatchRatio(decisionNode, ['area3']), 0, 'non-File nodes never get this boost');
  assert.equal(relayRetrieve.dirMatchRatio(fileNode, ['area9']), 0, 'no matching directory component');
  assert.equal(relayRetrieve.dirMatchRatio(fileNode, ['area3', 'area9']), 0.5, 'one of two eligible tokens matched');
  assert.equal(relayRetrieve.dirMatchRatio(fileNode, []), 0, 'no eligible tokens at all');
});

test('retrieve: a path query correctly ranks every same-directory file above a different-directory file that only matches on filename (the documented bug)', () => {
  const ws = makeWorkspace();
  const now = new Date().toISOString(); // identical freshness for every node — isolates the directory-match effect cleanly
  const mk = (p) => ({ id: `file:${p}`, type: 'File', text: p, status: 'active', confidence: 0.6, importance: 1, decay_rate: 0.03, last_verified: now });
  writeGraph(ws, [
    mk('src/area3/file0.js'), mk('src/area3/file1.js'),
    mk('src/area4/file0.js'), // wrong directory, but shares the exact filename
  ], []);

  const results = relayRetrieve.retrieve(ws, 'src/area3/file0.js');
  const ranked = results.map(r => r.nodeId);
  const idx = (id) => ranked.indexOf(id);
  assert.ok(idx('file:src/area3/file1.js') < idx('file:src/area4/file0.js'),
    'a same-directory sibling must outrank a different-directory file that only matches on filename');
});

test('retrieve: a query about a specific file by distinctive name (no real directory anywhere in the corpus) is unaffected by the directory-match boost', () => {
  const ws = makeWorkspace();
  const now = new Date().toISOString();
  writeGraph(ws, [
    { id: 'file:backend/lib/relayGraph.js', type: 'File', text: 'backend/lib/relayGraph.js', status: 'active', confidence: 0.6, importance: 1, decay_rate: 0.03, last_verified: now },
    { id: 'file:backend/lib/relayRetrieve.js', type: 'File', text: 'backend/lib/relayRetrieve.js', status: 'active', confidence: 0.6, importance: 1, decay_rate: 0.03, last_verified: now },
  ], []);

  const results = relayRetrieve.retrieve(ws, 'relayGraph.js');
  assert.equal(results[0].nodeId, 'file:backend/lib/relayGraph.js', 'exact filename match must still win on its own, untouched by this mechanism');
});
