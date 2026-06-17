const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relayGraph = require('../lib/relayGraph');
const { buildCompileBrief } = require('../lib/relayContext');
const { compileForResolution, compileStructured, estimateTokens } = require('../lib/relayContextCompiler');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-efficiency-test-'));
  fs.mkdirSync(path.join(dir, '.relay'), { recursive: true });
  return dir;
}

// "Efficient" must mean two things at once: fewer tokens AND every ground-truth
// fact still recoverable. A token count alone proves nothing — this file proves
// both, on a fixture sized like our own dogfood .relay/ data.
test('efficiency: tiny-profile graph context keeps 100% of currently-open ground truth at a fraction of the legacy full-IR-dump token cost', () => {
  const ws = makeWorkspace();
  const relayDir = path.join(ws, '.relay');

  const openTasks = [
    'Build BM25 retrieval module',
    'Write the landing page copy',
    'Add relay graph query CLI command',
  ];
  const doneTasks = ['Ship phase 1 event log', 'Write phase 1 tests'];
  fs.writeFileSync(path.join(relayDir, 'current_task.md'),
    `# Current Tasks\n\n## In progress\n${openTasks.map(t => `- [ ] ${t}`).join('\n')}\n${doneTasks.map(t => `- [x] ${t}`).join('\n')}\n`);

  // Resolved section grown to roughly our own dogfood decisions.md's real scale
  // (~15 historical entries) — this is the exact staleness the plan targets.
  const resolvedNoise = Array.from({ length: 12 }, (_, i) =>
    `- 2026-0${(i % 9) + 1}-01 — Historical resolved decision number ${i} about an unrelated subsystem, full sentence of realistic length so the file size is representative.`);
  fs.writeFileSync(path.join(relayDir, 'decisions.md'),
    `# Decisions\n\n## Open\n- [ ]\n\n## Resolved\n\n${resolvedNoise.join('\n')}\n`);
  fs.writeFileSync(path.join(relayDir, 'project.md'), '# Project Summary\n\n## Goals\n- Reduce context window cost\n');
  fs.writeFileSync(path.join(relayDir, 'memory.json'), JSON.stringify({ workspace: ws, timeline: [] }));

  // Legacy baseline: the actual full-IR markdown dump compile_brief.md ships today.
  const legacyBrief = buildCompileBrief(ws);
  const legacyText = Object.values(legacyBrief.irSnapshot).join('\n');
  const legacyTokens = estimateTokens(legacyText);

  // Graph path
  fs.writeFileSync(path.join(relayDir, 'config.json'), JSON.stringify({ workspace: ws, graph: { enabled: true } }));
  relayGraph.syncGraph(ws);
  const graphResult = compileForResolution(ws, 'tiny', { recordAccess: false });

  for (const t of openTasks) {
    assert.ok(graphResult.text.includes(t), `tiny profile dropped an open task: "${t}"`);
  }
  for (const t of doneTasks) {
    assert.ok(!graphResult.text.includes(t), `tiny profile should not surface completed work: "${t}"`);
  }

  const reduction = 1 - graphResult.usedTokens / legacyTokens;
  console.log(`[efficiency] legacy full IR dump: ~${legacyTokens} tokens | tiny graph profile: ~${graphResult.usedTokens} tokens | reduction: ${(reduction * 100).toFixed(1)}%`);

  assert.ok(graphResult.usedTokens < legacyTokens * 0.3, 'tiny profile should use well under 30% of the legacy full-dump token count');
  assert.equal(reduction > 0.7, true);
});

test('efficiency: supersession-chain collapsing keeps the current answer while dropping superseded history from the token budget', () => {
  const item = (id, text) => ({ id, node: { id, type: 'Decision', text }, nodeId: id, score: 0.5, why: { seed: true, path: [id], relation: null, components: {} } });
  // Realistic decision-log text — full sentences with dates, the actual shape
  // of entries in our own dogfood decisions.md (~80-150 chars each), not short
  // clauses. Collapsing only pays off once predecessor text is meaningfully
  // longer than the history-line truncation cap — see relayContextCompiler.js.
  const items = [
    item('decision:a', '2026-01-01 — Use Postgres for session storage; team already has Postgres expertise and it is already provisioned in staging'),
    item('decision:b', '2026-02-01 — Switch off Postgres, use MySQL for session storage instead after hitting connection pool limits under load testing'),
    item('decision:c', '2026-03-01 — Switch again: use Redis for session storage, since session data is ephemeral and Redis TTLs fit the access pattern better'),
  ];
  const edges = [
    { from: 'decision:b', to: 'decision:a', relation: 'SUPERSEDES' },
    { from: 'decision:c', to: 'decision:b', relation: 'SUPERSEDES' },
  ];

  const naiveDumpTokens = estimateTokens(items.map(i => `Decision: ${i.node.text}`).join('\n\n'));
  const collapsed = compileStructured(items, edges, 1800, { applyFloor: false });

  assert.match(collapsed.text, /Redis/, 'the current/correct answer must survive collapsing');
  assert.equal(collapsed.text.match(/Redis/g).length, 1, 'the current decision text must not be duplicated');
  const reduction = 1 - collapsed.usedTokens / naiveDumpTokens;
  console.log(`[efficiency] naive full-chain dump: ~${naiveDumpTokens} tokens | collapsed: ~${collapsed.usedTokens} tokens | reduction: ${(reduction * 100).toFixed(1)}%`);
  assert.ok(collapsed.usedTokens < naiveDumpTokens, 'collapsed chain must use fewer tokens than dumping every historical version in full');
});
