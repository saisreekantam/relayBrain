const fs = require('fs');
const path = require('path');
const { getGraphDir } = require('./relayGraph');
const { computeAgentReputation } = require('./relayRetrieve');

// Graph analytics — "this turns memory into intelligence" was the pitch, and
// it's nearly free: every number here is either a count over nodes.json/
// edges.json we already write, or computeAgentReputation() which already
// existed for ranking and was never surfaced on its own. No new node types,
// no new heuristic, no new false-positive risk — pure read-only aggregation.

function safeReadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    if (key == null) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/** File reference counts via CO_EDITED edge degree — "most influential files." */
function mostReferencedFiles(nodes, edges, limit = 10) {
  const degree = new Map();
  for (const e of edges) {
    if (e.relation !== 'CO_EDITED') continue;
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  return [...degree.entries()]
    .map(([id, count]) => ({ id, text: nodesById.get(id)?.text || id, coEditCount: count }))
    .sort((a, b) => b.coEditCount - a.coEditCount)
    .slice(0, limit);
}

function decisionStats(nodes) {
  const decisions = nodes.filter((n) => n.type === 'Decision');
  const byStatus = countBy(decisions, (d) => d.status);
  const reversed = (byStatus.superseded || 0) + (byStatus.contradicted || 0);
  return {
    total: decisions.length,
    byStatus,
    reversalRate: decisions.length ? round(reversed / decisions.length) : 0,
  };
}

function failureStats(nodes) {
  const failures = nodes.filter((n) => n.type === 'Failure');
  const open = failures.filter((f) => f.status !== 'resolved');
  return { total: failures.length, open: open.length, resolved: failures.length - open.length };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/** Pure function: nodes + edges -> a stats report. No fs access — easy to test, easy to reuse. */
function buildGraphStats(nodes, edges) {
  return {
    nodeCounts: countBy(nodes, (n) => n.type),
    edgeCounts: countBy(edges, (e) => e.relation),
    mostReferencedFiles: mostReferencedFiles(nodes, edges),
    decisions: decisionStats(nodes),
    failures: failureStats(nodes),
    agentReputation: [...computeAgentReputation(nodes).entries()]
      .map(([author, reputation]) => ({ author, reputation: round(reputation) }))
      .sort((a, b) => b.reputation - a.reputation),
  };
}

function loadGraphStats(workspacePath) {
  const graphDir = getGraphDir(workspacePath);
  const nodes = safeReadJson(path.join(graphDir, 'nodes.json'), []);
  const edges = safeReadJson(path.join(graphDir, 'edges.json'), []);
  return buildGraphStats(nodes, edges);
}

function renderGraphStatsText(stats) {
  const lines = [];
  lines.push('Nodes by type:');
  for (const [type, count] of Object.entries(stats.nodeCounts)) lines.push(`  ${type.padEnd(10)} ${count}`);
  lines.push('', 'Edges by relation:');
  for (const [relation, count] of Object.entries(stats.edgeCounts)) lines.push(`  ${relation.padEnd(14)} ${count}`);

  lines.push('', `Decisions: ${stats.decisions.total} total, reversal rate ${(stats.decisions.reversalRate * 100).toFixed(1)}%`);
  for (const [status, count] of Object.entries(stats.decisions.byStatus)) lines.push(`  ${status.padEnd(14)} ${count}`);

  lines.push('', `Failures: ${stats.failures.total} total, ${stats.failures.open} open, ${stats.failures.resolved} resolved`);

  if (stats.mostReferencedFiles.length) {
    lines.push('', 'Most referenced files (co-edit degree):');
    for (const f of stats.mostReferencedFiles) lines.push(`  ${f.coEditCount}  ${f.text}`);
  }

  if (stats.agentReputation.length) {
    lines.push('', 'Agent reputation (decision reversal rate, Laplace-smoothed):');
    for (const a of stats.agentReputation) lines.push(`  ${a.author.padEnd(16)} ${a.reputation}`);
  }

  return lines.join('\n');
}

module.exports = {
  buildGraphStats,
  loadGraphStats,
  renderGraphStatsText,
  mostReferencedFiles,
  decisionStats,
  failureStats,
};
