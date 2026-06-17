const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-graph-test-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

test('appendEvent + readEvents round-trip, time-ordered', () => {
  const ws = makeWorkspace();
  relayGraph.appendEvent(ws, { type: 'FileTouched', ts: '2026-01-01T00:00:01.000Z', file: 'a.js', path: 'a.js' });
  relayGraph.appendEvent(ws, { type: 'FileTouched', ts: '2026-01-01T00:00:00.000Z', file: 'b.js', path: 'b.js' });

  const events = relayGraph.readEvents(ws);
  assert.equal(events.length, 2);
  assert.ok(events[0].id.startsWith('evt_'));
  assert.equal(events[0].source, 'relay');
});

test('materializeGraph skips corrupt/unknown event types without throwing', () => {
  const { nodes, edges } = relayGraph.materializeGraph([
    { type: 'TotallyUnknownType', ts: '2026-01-01T00:00:00.000Z' },
    { type: 'FileTouched', ts: '2026-01-01T00:00:01.000Z', path: 'x.js', file: 'x.js' },
  ]);
  assert.equal(nodes.length, 1);
  assert.equal(edges.length, 0);
  assert.equal(nodes[0].type, 'File');
});

test('DecisionCreated then DecisionSuperseded: old decision demoted, new one active, SUPERSEDES edge added', () => {
  const events = [
    { type: 'DecisionCreated', ts: '2026-01-01T00:00:00.000Z', nodeId: 'decision:a', text: 'Use Postgres', source: 'Cursor' },
    { type: 'DecisionCreated', ts: '2026-01-02T00:00:00.000Z', nodeId: 'decision:b', text: 'Use Redis', source: 'human' },
    { type: 'DecisionSuperseded', ts: '2026-01-02T00:00:01.000Z', nodeId: 'decision:a', supersededBy: 'decision:b' },
  ];
  const { nodes, edges } = relayGraph.materializeGraph(events);
  const a = nodes.find(n => n.id === 'decision:a');
  const b = nodes.find(n => n.id === 'decision:b');

  assert.equal(a.status, 'superseded');
  assert.ok(a.confidence < 0.2, `expected demoted confidence, got ${a.confidence}`);
  assert.equal(b.status, 'active');
  assert.equal(b.confidence, 0.95, 'human-sourced decision should get high initial confidence');

  const edge = edges.find(e => e.relation === 'SUPERSEDES');
  assert.ok(edge);
  assert.equal(edge.from, 'decision:b');
  assert.equal(edge.to, 'decision:a');
});

test('confidence rule stack: human > commitment language > agent-proposed', () => {
  assert.equal(relayGraph.computeInitialConfidence({ source: 'human', text: 'use redis' }), 0.95);
  assert.equal(relayGraph.computeInitialConfidence({ source: 'Claude', text: "let's go with redis" }), 0.85);
  assert.equal(relayGraph.computeInitialConfidence({ source: 'Claude', text: 'maybe redis?' }), 0.6);
  assert.equal(relayGraph.computeInitialConfidence({ source: 'Claude', text: 'x', confidence: 0.42 }), 0.42);
});

test('TaskCreated then TaskStatusChanged updates status on the same node', () => {
  const events = [
    { type: 'TaskCreated', ts: '2026-01-01T00:00:00.000Z', nodeId: 'task:1', text: 'Write tests', status: 'open' },
    { type: 'TaskStatusChanged', ts: '2026-01-02T00:00:00.000Z', nodeId: 'task:1', status: 'done' },
  ];
  const { nodes } = relayGraph.materializeGraph(events);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].status, 'done');
});

test('FailureObserved: open when no fixedBy, resolved with FIXED_BY edge once fixed', () => {
  const open = relayGraph.materializeGraph([
    { type: 'FailureObserved', ts: '2026-01-01T00:00:00.000Z', nodeId: 'failure:1', text: 'Context overflow', causedBy: [], fixedBy: [] },
  ]);
  assert.equal(open.nodes[0].status, 'open');

  const resolved = relayGraph.materializeGraph([
    { type: 'FailureObserved', ts: '2026-01-01T00:00:00.000Z', nodeId: 'failure:1', text: 'Context overflow', causedBy: ['file:architecture.md'], fixedBy: ['decision:b'] },
  ]);
  assert.equal(resolved.nodes[0].status, 'resolved');
  assert.ok(resolved.edges.some(e => e.relation === 'CAUSED_BY' && e.to === 'file:architecture.md'));
  assert.ok(resolved.edges.some(e => e.relation === 'FIXED_BY' && e.to === 'decision:b'));
});

test('NodeAccessed reinforces importance and access_count', () => {
  const { nodes } = relayGraph.materializeGraph([
    { type: 'DecisionCreated', ts: '2026-01-01T00:00:00.000Z', nodeId: 'decision:a', text: 'x', source: 'human' },
    { type: 'NodeAccessed', ts: '2026-01-02T00:00:00.000Z', nodeId: 'decision:a' },
    { type: 'NodeAccessed', ts: '2026-01-03T00:00:00.000Z', nodeId: 'decision:a' },
  ]);
  const node = nodes.find(n => n.id === 'decision:a');
  assert.equal(node.access_count, 2);
  assert.equal(node.importance, 1.2);
});

test('buildWorkingMemory filters to active/open state only', () => {
  const { nodes } = relayGraph.materializeGraph([
    { type: 'GoalCreated', ts: '2026-01-01T00:00:00.000Z', nodeId: 'goal:1', text: 'Reduce context size' },
    { type: 'TaskCreated', ts: '2026-01-01T00:00:00.000Z', nodeId: 'task:1', text: 'Build retrieval', status: 'open' },
    { type: 'TaskCreated', ts: '2026-01-01T00:00:00.000Z', nodeId: 'task:2', text: 'Done thing', status: 'done' },
    { type: 'DecisionCreated', ts: '2026-01-01T00:00:00.000Z', nodeId: 'decision:a', text: 'Use BM25 first', source: 'human' },
    { type: 'FailureObserved', ts: '2026-01-01T00:00:00.000Z', nodeId: 'failure:1', text: 'overflow', causedBy: [], fixedBy: [] },
    { type: 'FailureObserved', ts: '2026-01-01T00:00:00.000Z', nodeId: 'failure:2', text: 'fixed already', causedBy: [], fixedBy: ['decision:a'] },
  ]);
  const wm = relayGraph.buildWorkingMemory(nodes);

  assert.equal(wm.goals.length, 1);
  assert.equal(wm.tasks.length, 1, 'done task should be excluded');
  assert.equal(wm.tasks[0].id, 'task:1');
  assert.equal(wm.decisions.length, 1);
  assert.equal(wm.blockers.length, 1, 'resolved failure should be excluded');
  assert.equal(wm.blockers[0].id, 'failure:1');
});

test('ingestTimelineIntoEvents parses IR markdown and is idempotent on re-run', () => {
  const ws = makeWorkspace();
  const relayDir = path.join(ws, '.relay');
  fs.writeFileSync(path.join(relayDir, 'current_task.md'), '# Current Tasks\n\n## In progress\n- [ ] Build the graph\n- [x] Write the plan\n');
  fs.writeFileSync(path.join(relayDir, 'project.md'), '# Project Summary\n\n## Goals\n- Reduce context size\n');
  fs.writeFileSync(path.join(relayDir, 'decisions.md'), '# Decisions\n\n## Open\n- Use BM25 before embeddings\n');
  fs.writeFileSync(path.join(relayDir, 'failures.md'), '# Failures\n\n- Context overflow from full markdown dump\n');

  const firstRun = relayGraph.ingestTimelineIntoEvents(ws, []);
  assert.equal(firstRun, 5, 'expect 2 tasks (open + done) + 1 goal + 1 decision + 1 failure');

  relayGraph.rebuildGraph(ws);

  const secondRun = relayGraph.ingestTimelineIntoEvents(ws, []);
  assert.equal(secondRun, 0, 're-ingesting identical IR with no state change should append zero new events');
});

test('ingestTimelineIntoEvents emits TaskStatusChanged (not a duplicate TaskCreated) when a task flips to done', () => {
  const ws = makeWorkspace();
  const relayDir = path.join(ws, '.relay');
  fs.writeFileSync(path.join(relayDir, 'current_task.md'), '- [ ] Ship phase 1\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);

  fs.writeFileSync(path.join(relayDir, 'current_task.md'), '- [x] Ship phase 1\n');
  const events = relayGraph.readEvents(ws);
  const before = events.length;
  const appended = relayGraph.ingestTimelineIntoEvents(ws, []);
  assert.equal(appended, 1);

  const all = relayGraph.readEvents(ws);
  assert.equal(all.length, before + 1);
  assert.equal(all[all.length - 1].type, 'TaskStatusChanged');
  assert.equal(all[all.length - 1].status, 'done');

  relayGraph.rebuildGraph(ws);
  const wm = JSON.parse(fs.readFileSync(path.join(relayDir, 'graph', 'working_memory.json'), 'utf-8'));
  assert.equal(wm.tasks.length, 0, 'working memory should no longer list the now-done task');
});

test('syncGraph end-to-end: writes nodes.json/edges.json/working_memory.json from memory.json timeline + IR', () => {
  const ws = makeWorkspace();
  const relayDir = path.join(ws, '.relay');
  fs.writeFileSync(path.join(relayDir, 'current_task.md'), '- [ ] Implement retrieval\n');
  fs.writeFileSync(path.join(relayDir, 'memory.json'), JSON.stringify({
    workspace: ws,
    lastSync: null,
    agents: {},
    timeline: [
      { kind: 'code_edit', source: 'Cursor', ts: '2026-01-01T00:00:00.000Z', path: 'relayGraph.js', file: 'relayGraph.js', summary: 'add materializer' },
    ],
  }));

  const result = relayGraph.syncGraph(ws);
  assert.equal(result.ingestedEvents, 2, '1 FileTouched + 1 TaskCreated');
  assert.ok(result.nodeCount >= 2);

  const graphDir = path.join(relayDir, 'graph');
  assert.ok(fs.existsSync(path.join(graphDir, 'nodes.json')));
  assert.ok(fs.existsSync(path.join(graphDir, 'edges.json')));
  assert.ok(fs.existsSync(path.join(graphDir, 'working_memory.json')));

  const nodes = JSON.parse(fs.readFileSync(path.join(graphDir, 'nodes.json'), 'utf-8'));
  assert.ok(nodes.some(n => n.type === 'File' && n.text === 'relayGraph.js'));
  assert.ok(nodes.some(n => n.type === 'Task'));
});

test('syncGraph called twice with the same full-history timeline does not re-append FileTouched events', () => {
  // memory.json's timeline is the *entire* history on every sync, not a delta —
  // re-syncing with no new activity must not grow events.jsonl.
  const ws = makeWorkspace();
  const relayDir = path.join(ws, '.relay');
  const memoryPath = path.join(relayDir, 'memory.json');
  fs.writeFileSync(memoryPath, JSON.stringify({
    workspace: ws,
    timeline: [
      { kind: 'code_edit', source: 'Cursor', ts: '2026-01-01T00:00:00.000Z', path: 'a.js', file: 'a.js' },
      { kind: 'code_edit', source: 'Cursor', ts: '2026-01-02T00:00:00.000Z', path: 'b.js', file: 'b.js' },
    ],
  }));

  const first = relayGraph.syncGraph(ws);
  assert.equal(first.ingestedEvents, 2);

  const second = relayGraph.syncGraph(ws);
  assert.equal(second.ingestedEvents, 0, 'identical timeline re-synced should append zero new events');
  assert.equal(relayGraph.readEvents(ws).length, 2, 'events.jsonl must not grow on a no-op re-sync');
});

test('stableId is deterministic and content-addressed (same text -> same id, case/whitespace insensitive)', () => {
  const a = relayGraph.stableId('task', 'Build the graph');
  const b = relayGraph.stableId('task', '  build the graph  ');
  const c = relayGraph.stableId('task', 'Build a different thing');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
