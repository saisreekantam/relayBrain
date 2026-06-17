const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-graph-ingestion-test-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

function enableGraph(ws, extra = {}) {
  fs.writeFileSync(path.join(ws, '.relay', 'config.json'), JSON.stringify({ workspace: ws, graph: { enabled: true, ...extra } }));
}

// --- Placeholder-checkbox regression (found via testing on a real,
// freshly-`relay init`'d project — the literal unedited decisions.md scaffold) ---

test('stripCheckboxPrefix: strips a real checkbox prefix, returns empty for a bare placeholder, leaves plain text untouched', () => {
  assert.equal(relayGraph.stripCheckboxPrefix('[x] Some text'), 'Some text');
  assert.equal(relayGraph.stripCheckboxPrefix('[ ] Some text'), 'Some text');
  assert.equal(relayGraph.stripCheckboxPrefix('[ ]'), '');
  assert.equal(relayGraph.stripCheckboxPrefix('Use Kuzu for the embedded graph store'), 'Use Kuzu for the embedded graph store');
});

test('parseOpenDecisionLines: a bare, never-edited "- [ ]" placeholder produces zero events, not a garbage decision named "[ ]"', () => {
  const md = '# Decisions\n\n## Open\n- [ ]\n\n## Resolved\n\n';
  const events = relayGraph.parseOpenDecisionLines(md);
  assert.equal(events.length, 0);
});

test('ingestion: the literal unedited decisions.md scaffold (every fresh relay init) does not create a garbage Decision node', () => {
  const ws = makeWorkspace();
  // exact scaffold from relayContext.js IR_TEMPLATES — not a hand-simplified stand-in
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'), '# Decisions\n\n## Open\n- [ ]\n\n## Resolved\n\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  const result = relayGraph.rebuildGraph(ws);

  const nodes = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'nodes.json'), 'utf-8'));
  assert.equal(nodes.filter(n => n.type === 'Decision').length, 0);
  assert.equal(result.workingMemory.decisions.length, 0);
});

// --- Resolved decisions -----------------------------------------------------

test('parseResolvedDecisionLines: extracts text and date from a dated entry, null ts when undated', () => {
  const md = '# Decisions\n\n## Resolved\n\n- 2026-06-15 — Published to npm\n- No date on this one\n';
  const events = relayGraph.parseResolvedDecisionLines(md);
  assert.equal(events.length, 2);
  assert.equal(events[0].ts, '2026-06-15T00:00:00.000Z');
  assert.equal(events[1].ts, null);
});

test('ingestTimelineIntoEvents: a brand-new Resolved decision becomes a Decision node with status=resolved, excluded from working memory', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'), '# Decisions\n\n## Open\n- [ ]\n\n## Resolved\n\n- 2026-06-15 — Published relay-os to npm\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  const result = relayGraph.rebuildGraph(ws);

  const node = result.workingMemory.decisions.find(n => n.text.includes('Published relay-os to npm'));
  assert.equal(node, undefined, 'resolved decision must not appear in working memory');

  const nodes = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'nodes.json'), 'utf-8'));
  const resolvedNode = nodes.find(n => n.text.includes('Published relay-os to npm'));
  assert.ok(resolvedNode);
  assert.equal(resolvedNode.status, 'resolved');
  assert.equal(resolvedNode.last_verified, '2026-06-15T00:00:00.000Z');
});

test('ingestTimelineIntoEvents: a decision that moves from Open to Resolved (identical text) transitions the existing node instead of creating a duplicate', () => {
  const ws = makeWorkspace();
  const decisionsPath = path.join(ws, '.relay', 'decisions.md');
  fs.writeFileSync(decisionsPath, '# Decisions\n\n## Open\n- Use BM25 before embeddings\n\n## Resolved\n\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);

  fs.writeFileSync(decisionsPath, '# Decisions\n\n## Open\n\n## Resolved\n\n- Use BM25 before embeddings\n');
  const appended = relayGraph.ingestTimelineIntoEvents(ws, []);
  assert.equal(appended, 1, 'should be a single DecisionResolved transition, not a new DecisionCreated');

  const result = relayGraph.rebuildGraph(ws);
  const decisionNodes = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'nodes.json'), 'utf-8'))
    .filter(n => n.type === 'Decision');
  assert.equal(decisionNodes.length, 1, 'must remain a single node, not duplicated');
  assert.equal(decisionNodes[0].status, 'resolved');
});

test('resolved decisions are still retrievable by BM25 even though excluded from working memory', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'), '# Decisions\n\n## Resolved\n\n- 2026-06-15 — Chose npm over GitHub-only install for distribution\n');
  fs.writeFileSync(path.join(ws, '.relay', 'memory.json'), JSON.stringify({ workspace: ws, timeline: [] }));
  relayGraph.syncGraph(ws);

  const { retrieve } = require('../lib/relayRetrieve');
  const results = retrieve(ws, 'npm distribution install');
  assert.ok(results.some(r => r.node.text.includes('npm over GitHub-only')));
});

// --- Contradiction heuristic -------------------------------------------------

test('detectContradictions: flags an antonym-pair match with sufficient subject overlap', () => {
  const newDecisions = [{ nodeId: 'decision:new', text: 'Avoid Redis for session storage going forward' }];
  const existing = [{ id: 'decision:old', type: 'Decision', text: 'Use Redis for session storage' }];
  const matches = relayGraph.detectContradictions(newDecisions, existing);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].oldId, 'decision:old');
  assert.equal(matches[0].newId, 'decision:new');
});

test('detectContradictions: catches a contradiction between two decisions in the SAME batch (both new, neither "existing" yet)', () => {
  const newDecisions = [
    { nodeId: 'decision:use', text: 'Use a dedicated queue for billing background jobs' },
    { nodeId: 'decision:avoid', text: 'Avoid using a dedicated queue for billing background jobs after load testing' },
  ];
  const matches = relayGraph.detectContradictions(newDecisions, []);
  assert.equal(matches.length, 1, 'a same-sync contradiction must still be caught, not only against pre-existing nodes');
  assert.equal(matches[0].oldId, 'decision:use', 'earlier line in the batch is treated as the one being superseded');
  assert.equal(matches[0].newId, 'decision:avoid');
});

test('detectContradictions: false-positive guard — shared boilerplate template across many unrelated decisions must not cross-contradict (regression: found via the long-codebase stress test)', () => {
  // 10 decisions sharing an identical template, differing only by subsystem
  // name, plus one real contradiction about a SPECIFIC subsystem. Plain
  // Jaccard over raw token sets flagged unrelated subsystems against each
  // other here, purely from the shared boilerplate phrase ("dedicated
  // background job queue for the X subsystem") outweighing the one word that
  // actually differs. overlapCoefficient + realistic phrasing fixes it.
  const clusters = ['auth', 'billing', 'search', 'notifications', 'onboarding'];
  const newDecisions = clusters.map(c => ({ nodeId: `decision:${c}`, text: `Use a dedicated background job queue for the ${c} subsystem` }));
  newDecisions.push({ nodeId: 'decision:billing-avoid', text: 'Avoid using a dedicated background job queue for the billing subsystem after load testing' });

  const matches = relayGraph.detectContradictions(newDecisions, []);
  assert.equal(matches.length, 1, `expected exactly the billing contradiction, got ${JSON.stringify(matches)}`);
  assert.equal(matches[0].newId, 'decision:billing-avoid');
  assert.equal(matches[0].oldId, 'decision:billing');
});

test('detectContradictions: false-positive guard — antonym words present but unrelated subjects must not match', () => {
  const newDecisions = [{ nodeId: 'decision:new', text: 'Avoid using emoji in commit messages' }];
  const existing = [{ id: 'decision:old', type: 'Decision', text: 'Use Redis for session storage' }];
  const matches = relayGraph.detectContradictions(newDecisions, existing);
  assert.equal(matches.length, 0, 'shared word "use/avoid" alone must not be enough — subjects do not overlap');
});

test('detectContradictions: false-positive guard — same subject, no antonym pair present, must not match', () => {
  const newDecisions = [{ nodeId: 'decision:new', text: 'Redis session storage now uses a 10 minute TTL' }];
  const existing = [{ id: 'decision:old', type: 'Decision', text: 'Use Redis for session storage' }];
  const matches = relayGraph.detectContradictions(newDecisions, existing);
  assert.equal(matches.length, 0, 'related topic without an antonym-pair signal must not be flagged as a contradiction');
});

test('contradictionHeuristic flag: off by default — a real contradiction in the IR is NOT auto-detected unless explicitly enabled', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'), '# Decisions\n\n## Open\n- Use Redis for session storage\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);

  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'), '# Decisions\n\n## Open\n- Use Redis for session storage\n- Avoid Redis for session storage after all\n');
  relayGraph.ingestTimelineIntoEvents(ws, []); // no config.json at all -> contradictionHeuristic undefined/false
  const result = relayGraph.rebuildGraph(ws);

  const events = relayGraph.readEvents(ws);
  assert.ok(!events.some(e => e.type === 'DecisionContradicted'), 'heuristic must stay off without explicit opt-in');
  assert.equal(result.workingMemory.decisions.length, 2, 'both decisions remain active since nothing demoted either');
});

test('contradictionHeuristic flag: enabled -> the older decision is demoted and a CONTRADICTS edge is added', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'), '# Decisions\n\n## Open\n- Use Redis for session storage\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);

  enableGraph(ws, { contradictionHeuristic: true });
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'), '# Decisions\n\n## Open\n- Use Redis for session storage\n- Avoid Redis for session storage after all\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  const result = relayGraph.rebuildGraph(ws);

  const oldDecision = result.workingMemory.decisions.find(n => n.text === 'Use Redis for session storage')
    || JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'nodes.json'), 'utf-8')).find(n => n.text === 'Use Redis for session storage');
  assert.equal(oldDecision.status, 'contradicted');
  assert.ok(oldDecision.confidence < 0.2);

  const edges = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'edges.json'), 'utf-8'));
  assert.ok(edges.some(e => e.relation === 'CONTRADICTS'));
});

// --- File co-edit graph ------------------------------------------------------

test('buildCoEditLinks: files touched within the window get linked, a file touched after a large gap does not', () => {
  const base = Date.parse('2026-01-01T10:00:00.000Z');
  const events = [
    { path: 'a.js', ts: new Date(base).toISOString() },
    { path: 'b.js', ts: new Date(base + 5 * 60 * 1000).toISOString() },
    { path: 'c.js', ts: new Date(base + 90 * 60 * 1000).toISOString() }, // 90 min gap -> new window
  ];
  const links = relayGraph.buildCoEditLinks(events);
  const pairs = links.map(l => `${l.from}|${l.to}`);
  assert.ok(pairs.includes('file:a.js|file:b.js'));
  assert.ok(!pairs.some(p => p.includes('c.js')), 'file after the gap must not be linked to the earlier window');
});

test('buildCoEditLinks: a window with more than the cap still produces a bounded number of edges', () => {
  const base = Date.parse('2026-01-01T10:00:00.000Z');
  const events = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}.js`, ts: new Date(base + i * 1000).toISOString() }));
  const links = relayGraph.buildCoEditLinks(events);
  // capped at 10 files -> at most C(10,2) = 45 edges, regardless of 15 files touched
  assert.ok(links.length <= 45, `expected <=45 edges, got ${links.length}`);
});

test('co-edit ingestion is idempotent: re-syncing the same touch history does not duplicate CO_EDITED edges', () => {
  const ws = makeWorkspace();
  const base = Date.parse('2026-01-01T10:00:00.000Z');
  fs.writeFileSync(path.join(ws, '.relay', 'memory.json'), JSON.stringify({
    workspace: ws,
    timeline: [
      { kind: 'code_edit', source: 'Cursor', path: 'a.js', file: 'a.js', ts: new Date(base).toISOString() },
      { kind: 'code_edit', source: 'Cursor', path: 'b.js', file: 'b.js', ts: new Date(base + 1000).toISOString() },
    ],
  }));

  relayGraph.syncGraph(ws);
  const firstEdgeCount = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'edges.json'), 'utf-8')).length;
  relayGraph.syncGraph(ws);
  const secondEdgeCount = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'edges.json'), 'utf-8')).length;

  assert.ok(firstEdgeCount >= 1, 'expected at least one CO_EDITED edge from the first sync');
  assert.equal(secondEdgeCount, firstEdgeCount, 're-syncing identical history must not duplicate edges');
});

// --- Failure self-resolution heuristic --------------------------------------

test('isFailureSelfResolved: positive cases', () => {
  assert.equal(relayGraph.isFailureSelfResolved('Duplicate uiPort declaration crashed API start — fixed; smoke-test after serve changes'), true);
  assert.equal(relayGraph.isFailureSelfResolved('Memory leak in the worker pool — resolved by capping pool size'), true);
  assert.equal(relayGraph.isFailureSelfResolved('Race condition on startup, patched in v0.2'), true);
});

test('isFailureSelfResolved: negation guard — "unresolved" must not match despite containing "resolved"', () => {
  assert.equal(relayGraph.isFailureSelfResolved('Second npm publish attempt: cause of discrepancy unresolved, re-check before next attempt'), false);
});

test('isFailureSelfResolved: negation guard — "not fixed yet" and "still an issue" must not match', () => {
  assert.equal(relayGraph.isFailureSelfResolved('Flaky test on CI, not fixed yet'), false);
  assert.equal(relayGraph.isFailureSelfResolved('Slow cold start, still an issue on Windows'), false);
});

test('isFailureSelfResolved: a plain note with no resolution language stays open (conservative default)', () => {
  assert.equal(relayGraph.isFailureSelfResolved('relay mcp cwd is backend unless RELAY_WORKSPACE_PATH is set — document in MCP config'), false);
});

test('ingestion: a self-resolved failure does not appear in working_memory.json blockers', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'failures.md'), '# Failures\n\n- Duplicate uiPort declaration crashed API start — fixed; smoke-test after serve changes\n- Cause of discrepancy unresolved, re-check before next publish attempt\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  const result = relayGraph.rebuildGraph(ws);

  assert.equal(result.workingMemory.blockers.length, 1);
  assert.match(result.workingMemory.blockers[0].text, /unresolved/);
});

// --- Evidence ingestion (explicit "Evidence:" sub-bullet convention) -------

test('parseDecisionEvidenceLines: extracts evidence linked to the immediately preceding top-level decision', () => {
  const md = [
    '# Decisions',
    '',
    '## Open',
    '- Use Kuzu for the embedded graph store',
    '  - Evidence: benchmark showed 4x lower traversal latency (bench/results.md)',
    '- Use BM25 before embeddings',
  ].join('\n');
  const events = relayGraph.parseDecisionEvidenceLines(md);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, 'benchmark showed 4x lower traversal latency (bench/results.md)');
  assert.equal(events[0].decisionNodeId, relayGraph.stableId('decision', 'Use Kuzu for the embedded graph store'));
});

test('parseDecisionEvidenceLines: an evidence line before any decision bullet is ignored', () => {
  const md = '## Open\n  - Evidence: orphaned, no decision above it\n';
  const events = relayGraph.parseDecisionEvidenceLines(md);
  assert.equal(events.length, 0);
});

test('ingestion: Evidence node is created and linked to its Decision via SUPPORTED_BY', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'),
    '# Decisions\n\n## Open\n- Use Kuzu for the embedded graph store\n  - Evidence: benchmark showed 4x lower traversal latency\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  const result = relayGraph.rebuildGraph(ws);

  const nodes = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'nodes.json'), 'utf-8'));
  const evidenceNode = nodes.find(n => n.type === 'Evidence');
  const decisionNode = nodes.find(n => n.type === 'Decision');
  assert.ok(evidenceNode);
  assert.equal(evidenceNode.text, 'benchmark showed 4x lower traversal latency');

  const edges = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'edges.json'), 'utf-8'));
  assert.ok(edges.some(e => e.relation === 'SUPPORTED_BY' && e.from === decisionNode.id && e.to === evidenceNode.id));
});

test('ingestion: evidence ingestion is idempotent across re-syncs', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'),
    '# Decisions\n\n## Open\n- Use Kuzu for the embedded graph store\n  - Evidence: benchmark showed 4x lower traversal latency\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);
  const appended = relayGraph.ingestTimelineIntoEvents(ws, []);
  assert.equal(appended, 0, 're-ingesting identical decisions.md must not duplicate the Evidence node');
});

// --- SERVES (Decision/Task -> Goal, explicit "Serves:" sub-bullet convention) ---

test('parseServesLines: extracts a goal reference under a decision bullet', () => {
  const md = '## Open\n- Use Kuzu for the embedded graph store\n  - Serves: Reduce context window cost\n';
  const events = relayGraph.parseServesLines(md, 'decision');
  assert.equal(events.length, 1);
  assert.equal(events[0].goalText, 'Reduce context window cost');
  assert.equal(events[0].parentNodeId, relayGraph.stableId('decision', 'Use Kuzu for the embedded graph store'));
});

test('parseServesLines: same parser works under a task bullet with the task prefix', () => {
  const md = '## In progress\n- [ ] Ship phase 1\n  - Serves: Reduce context window cost\n';
  const events = relayGraph.parseServesLines(md, 'task');
  assert.equal(events.length, 1);
  assert.equal(events[0].parentNodeId, relayGraph.stableId('task', 'Ship phase 1'));
});

test('ingestion: a decision with a Serves: reference creates a SERVES edge to an existing project.md goal (no duplicate Goal node)', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'project.md'), '# Project Summary\n\n## Goals\n- Reduce context window cost\n');
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'),
    '# Decisions\n\n## Open\n- Use Kuzu for the embedded graph store\n  - Serves: Reduce context window cost\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);

  const nodes = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'nodes.json'), 'utf-8'));
  const goalNodes = nodes.filter(n => n.type === 'Goal');
  assert.equal(goalNodes.length, 1, 'must reuse the existing Goal node, not create a duplicate');

  const edges = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'edges.json'), 'utf-8'));
  const decisionNode = nodes.find(n => n.type === 'Decision');
  assert.ok(edges.some(e => e.relation === 'SERVES' && e.from === decisionNode.id && e.to === goalNodes[0].id));
});

test('ingestion: a Serves: reference to a goal text not present in project.md auto-creates the Goal rather than dropping it', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'),
    '# Decisions\n\n## Open\n- Use Kuzu for the embedded graph store\n  - Serves: A goal never declared in project.md\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  const result = relayGraph.rebuildGraph(ws);

  const goal = result.workingMemory.goals.find(g => g.text === 'A goal never declared in project.md');
  assert.ok(goal, 'goal should be auto-created from the Serves: reference, not silently dropped');
});

test('ingestion: a task with a Serves: reference links Task -> Goal (closes the "Task nodes are islands" gap)', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'current_task.md'),
    '# Current Tasks\n\n## In progress\n- [ ] Ship phase 1\n  - Serves: Reduce context window cost\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);

  const nodes = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'nodes.json'), 'utf-8'));
  const taskNode = nodes.find(n => n.type === 'Task');
  const goalNode = nodes.find(n => n.type === 'Goal');
  const edges = JSON.parse(fs.readFileSync(path.join(ws, '.relay', 'graph', 'edges.json'), 'utf-8'));
  assert.ok(edges.some(e => e.relation === 'SERVES' && e.from === taskNode.id && e.to === goalNode.id));
});

test('ingestion: SERVES links are idempotent across re-syncs', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'),
    '# Decisions\n\n## Open\n- Use Kuzu for the embedded graph store\n  - Serves: Reduce context window cost\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);
  const appended = relayGraph.ingestTimelineIntoEvents(ws, []);
  assert.equal(appended, 0, 're-ingesting identical decisions.md must not duplicate the Goal node or the SERVES edge');
});

test('retrieve: a decision is now reachable from its Goal via SERVES traversal (the gap the relationship benchmark found)', () => {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'),
    '# Decisions\n\n## Open\n- Use a message queue for the billing subsystem\n  - Serves: Reduce billing latency\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);

  const { retrieve } = require('../lib/relayRetrieve');
  // query deliberately has NO lexical overlap with the decision text at all
  const results = retrieve(ws, 'reduce billing latency', { hops: 2 });
  assert.ok(results.some(r => r.node.type === 'Decision' && r.node.text.includes('message queue')),
    'the decision should be reachable via SERVES traversal from its goal, not just by keyword match');
});

// --- Branch-awareness: "use Redis on feature/auth" and "use Postgres on
// feature/rag" are branch-scoped truths, not a contradiction. ---

function initGitRepo(ws, branch) {
  const { execSync } = require('child_process');
  execSync('git init -q', { cwd: ws });
  execSync('git config user.email test@example.com', { cwd: ws });
  execSync('git config user.name Test', { cwd: ws });
  fs.writeFileSync(path.join(ws, '.gitkeep'), '');
  execSync('git add .gitkeep', { cwd: ws });
  execSync('git commit -q -m init', { cwd: ws });
  if (branch) execSync(`git checkout -q -b ${branch}`, { cwd: ws });
}

test('getCurrentGitBranch: returns the real branch name in a git repo, null in a non-git directory', () => {
  const ws = makeWorkspace();
  assert.equal(relayGraph.getCurrentGitBranch(ws), null, 'not a git repo yet');

  initGitRepo(ws, 'feature/auth');
  assert.equal(relayGraph.getCurrentGitBranch(ws), 'feature/auth');
});

test('sameBranchScope: blocks only on an explicit, known mismatch — unknown branch info on either side never blocks', () => {
  assert.equal(relayGraph.sameBranchScope({ branch: 'main' }, { branch: 'main' }), true);
  assert.equal(relayGraph.sameBranchScope({ branch: 'feature/auth' }, { branch: 'feature/rag' }), false);
  assert.equal(relayGraph.sameBranchScope({ branch: 'main' }, {}), true, 'unknown branch on one side never blocks');
  assert.equal(relayGraph.sameBranchScope({}, {}), true, 'unknown on both sides never blocks');
});

test('detectContradictions: decisions on different branches are never flagged as contradicting, even with antonym + subject overlap', () => {
  const newDecisions = [{ nodeId: 'decision:rag', text: 'Avoid using Redis for the cache layer', branch: 'feature/rag' }];
  const existing = [{ id: 'decision:auth', text: 'Use Redis for the cache layer', branch: 'feature/auth' }];
  const matches = relayGraph.detectContradictions(newDecisions, existing);
  assert.equal(matches.length, 0, 'branch-scoped truths must not contradict each other');
});

test('detectContradictions: the SAME contradiction on the SAME branch is still caught (no regression)', () => {
  const newDecisions = [{ nodeId: 'decision:b', text: 'Avoid using Redis for the cache layer', branch: 'main' }];
  const existing = [{ id: 'decision:a', text: 'Use Redis for the cache layer', branch: 'main' }];
  const matches = relayGraph.detectContradictions(newDecisions, existing);
  assert.equal(matches.length, 1, 'same-branch contradictions must still be detected');
});

test('detectContradictions: decisions with no branch info at all (legacy data, non-git project) are still compared — backward compatible', () => {
  const newDecisions = [{ nodeId: 'decision:b', text: 'Avoid using Redis for the cache layer' }];
  const existing = [{ id: 'decision:a', text: 'Use Redis for the cache layer' }];
  const matches = relayGraph.detectContradictions(newDecisions, existing);
  assert.equal(matches.length, 1, 'missing branch info must not silently disable the existing heuristic');
});

test('ingestion end-to-end: a real git repo attaches the actual current branch to new Decision nodes', () => {
  const ws = makeWorkspace();
  initGitRepo(ws, 'feature/auth');
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'), '# Decisions\n\n## Open\n- Use Redis for the cache layer\n');

  relayGraph.ingestTimelineIntoEvents(ws, []);
  const result = relayGraph.rebuildGraph(ws);
  const decision = result.workingMemory.decisions[0];
  assert.equal(decision.branch, 'feature/auth');
});

test('ingestion end-to-end: the same contradiction recorded on two different real git branches does not fire, with the heuristic enabled', () => {
  const ws = makeWorkspace();
  initGitRepo(ws, 'feature/auth');
  enableGraph(ws, { contradictionHeuristic: true });
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'), '# Decisions\n\n## Open\n- Use Redis for the cache layer\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  relayGraph.rebuildGraph(ws);

  const { execSync } = require('child_process');
  execSync('git checkout -q -b feature/rag', { cwd: ws });
  fs.writeFileSync(path.join(ws, '.relay', 'decisions.md'),
    '# Decisions\n\n## Open\n- Use Redis for the cache layer\n- Avoid using Redis for the cache layer after all\n');
  relayGraph.ingestTimelineIntoEvents(ws, []);
  const result = relayGraph.rebuildGraph(ws);

  const useRedis = result.workingMemory.decisions.find(d => d.text === 'Use Redis for the cache layer');
  assert.ok(useRedis, 'the feature/auth decision must remain active — a different branch must not contradict it');
  assert.equal(useRedis.status, 'active');
});
