const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');
const { compileRelayContext } = require('../lib/relayContext');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-context-graph-test-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

test('compileRelayContext: Phase 6 — no config.json / no graph key at all -> MEMORY GRAPH section is on by default', () => {
  // Phase 6 flips this to opt-out: every project that ran `relay init` before
  // this phase existed (no `graph` key in config.json at all) now gets graph
  // features automatically, with no migration step required.
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'current_task.md'), '- [ ] A pre-existing task from before Phase 6 shipped\n');

  relayGraph.syncGraph(ws); // config.json doesn't exist yet — syncGraph/ingestion must not require one
  const { context, markdown } = compileRelayContext(ws, { recordAccess: false });

  assert.ok(context.graph, 'graph section must be present by default with no config.json at all');
  assert.ok(markdown.includes('## MEMORY GRAPH'));
});

test('compileRelayContext: explicit graph.enabled: false is still respected (the opt-out escape hatch)', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'config.json'), JSON.stringify({ workspace: ws, graph: { enabled: false } }));
  const { context, markdown } = compileRelayContext(ws);
  assert.equal(context.graph, undefined);
  assert.ok(!markdown.includes('## MEMORY GRAPH'));
});

test('compileRelayContext: graph.enabled true -> adds a MEMORY GRAPH section sourced from the compiled graph', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'config.json'), JSON.stringify({ workspace: ws, graph: { enabled: true } }));
  fs.writeFileSync(path.join(ws, '.relay', 'current_task.md'), '- [ ] Build the memory graph context section\n');

  relayGraph.syncGraph(ws);
  const { context, markdown } = compileRelayContext(ws, { query: 'memory graph', recordAccess: false });

  assert.ok(context.graph);
  assert.equal(context.graph.error, undefined);
  assert.ok(markdown.includes('## MEMORY GRAPH'));
  assert.match(markdown, /Build the memory graph context section/);
});
