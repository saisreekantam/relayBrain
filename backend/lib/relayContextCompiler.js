const fs = require('fs');
const path = require('path');
const { getGraphDir, appendEvent } = require('./relayGraph');
const { retrieve } = require('./relayRetrieve');

// Phase 2 of docs/KNOWLEDGE_GRAPH_PLAN.md — multi-resolution Context Compiler (§6.8/§6.9).
// Same function, called with a different token budget — not parallel code paths.
// `tiny` skips retrieval entirely and reads working_memory.json directly (§6.9,
// the no-embedding/no-traversal fast path the stop hook can afford on every turn).

const RESOLUTION_PROFILES = {
  tiny: { tokenBudget: 200, source: 'workingMemory' },
  small: { tokenBudget: 800, source: 'retrieval' },
  default: { tokenBudget: 1800, source: 'retrieval' },
  large: { tokenBudget: 5000, source: 'retrieval' },
};

// Per-agent ranking weights (§6.8) — a weights table, not a separate subsystem.
const AGENT_WEIGHTS = {
  Cursor: { File: 1.3, Task: 1.2, Decision: 1.0, Goal: 0.9, Failure: 1.0, Evidence: 0.8 },
  'GitHub Copilot': { File: 1.3, Task: 1.1, Decision: 1.0, Goal: 0.9, Failure: 1.0, Evidence: 0.8 },
  'Claude Code': { File: 0.9, Task: 1.0, Decision: 1.3, Goal: 1.2, Failure: 1.2, Evidence: 1.0 },
  Codex: { File: 1.0, Task: 1.1, Decision: 1.1, Goal: 1.0, Failure: 1.1, Evidence: 0.9 },
  Antigravity: { File: 1.0, Task: 1.0, Decision: 1.1, Goal: 1.1, Failure: 1.0, Evidence: 1.0 },
};

const DEFAULT_SCORE_FLOOR = 0.02;
const TRUNCATE_LEN = 80;
// History-line entries must be much shorter than TRUNCATE_LEN — collapsing only
// saves tokens when each predecessor is compressed well below its original
// length; at ~40 chars typical decision text barely shrinks and the "Decision
// (current):"/"History:" label overhead can make the collapsed block bigger
// than just dumping every version. See docs/KNOWLEDGE_GRAPH_PLAN.md §12.
const HISTORY_ENTRY_LEN = 24;

function safeReadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function truncate(text, max = TRUNCATE_LEN) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function workingMemoryItems(workspacePath) {
  const wm = safeReadJson(path.join(getGraphDir(workspacePath), 'working_memory.json'), {
    goals: [], tasks: [], decisions: [], blockers: [],
  });
  const all = [...wm.goals, ...wm.tasks, ...wm.decisions, ...wm.blockers];
  return all.map(node => ({
    nodeId: node.id,
    node,
    score: typeof node.importance === 'number' ? node.importance : 1,
    why: { seed: true, path: [node.id], relation: null, components: {} },
  }));
}

function applyAgentWeights(items, agentName) {
  const weights = AGENT_WEIGHTS[agentName];
  if (!weights) return items;
  return items
    .map(item => ({ ...item, score: item.score * (weights[item.node.type] ?? 1) }))
    .sort((a, b) => b.score - a.score);
}

/** oldId -> newId and newId -> oldId, from SUPERSEDES/CONTRADICTS edges only. */
function buildSupersessionIndex(edges) {
  const supersededBy = new Map();
  const supersedes = new Map();
  for (const e of edges) {
    if (e.relation === 'SUPERSEDES' || e.relation === 'CONTRADICTS') {
      supersededBy.set(e.to, e.from);
      supersedes.set(e.from, e.to);
    }
  }
  return { supersededBy, supersedes };
}

/**
 * Collapses supersession/contradiction chains within the given item set down to
 * one block per chain: the head (current) item, plus a one-line history pointer.
 * Deterministic, no LLM — the single highest-value piece of this plan (§6.8).
 */
function collapseChains(items, edges) {
  const { supersededBy, supersedes } = buildSupersessionIndex(edges);
  const presentIds = new Set(items.map(i => i.nodeId));
  const consumed = new Set();
  const chains = new Map(); // headId -> [oldest..head] node ids

  for (const item of items) {
    if (consumed.has(item.nodeId)) continue;
    const successor = supersededBy.get(item.nodeId);
    if (successor && presentIds.has(successor)) continue; // not a head — its head will absorb it

    const chain = [item.nodeId];
    let cursor = item.nodeId;
    while (supersedes.has(cursor) && presentIds.has(supersedes.get(cursor))) {
      cursor = supersedes.get(cursor);
      chain.unshift(cursor);
    }
    if (chain.length > 1) {
      for (const id of chain) consumed.add(id);
      chains.set(item.nodeId, chain);
    }
  }

  return { chains, consumed };
}

function renderFailureBlock(item, byId) {
  const node = item.node;
  const lines = [`Failure: ${truncate(node.text)}`];
  if (Array.isArray(node.causedByText) && node.causedByText.length) {
    lines.push(`  caused by: ${node.causedByText.map(t => truncate(t, 40)).join(', ')}`);
  }
  if (Array.isArray(node.fixedByText) && node.fixedByText.length) {
    lines.push(`  fixed by: ${node.fixedByText.map(t => truncate(t, 40)).join(', ')}`);
  }
  return lines.join('\n');
}

function renderBlock(item, byId, chains) {
  const node = item.node;
  if (chains.has(item.nodeId)) {
    const chain = chains.get(item.nodeId);
    const label = node.type === 'Decision' ? 'Decision' : node.type;
    const predecessors = chain.slice(0, -1); // exclude the head — it's already shown below, don't repeat its text
    if (!predecessors.length) return `${label} (current): ${truncate(node.text)}`;
    const historyText = predecessors.map(id => truncate(byId.get(id)?.node.text || id, HISTORY_ENTRY_LEN)).join(' → ');
    return `${label} (current): ${truncate(node.text)}\nHistory: ${historyText} → (current)`;
  }

  switch (node.type) {
    case 'Failure':
      return renderFailureBlock(item, byId);
    case 'Goal':
      return `Goal: ${truncate(node.text)}`;
    case 'Task':
      return `Task [${node.status}]: ${truncate(node.text)}`;
    case 'Decision':
      return `Decision: ${truncate(node.text)}`;
    case 'Evidence':
      return `Evidence (${node.kind || 'link'}): ${truncate(node.text)}`;
    case 'File':
      return `File touched: ${truncate(node.text, 120)}`;
    default:
      return `${node.type}: ${truncate(node.text)}`;
  }
}

/**
 * Pure: items + edges + tokenBudget -> { text, includedNodeIds, droppedCount }.
 * No fs, no LLM call — the deterministic structured form that works with zero
 * paid API calls. Steps 1-4 of §6.8.
 */
function compileStructured(items, edges, tokenBudget, opts = {}) {
  const byId = new Map(items.map(i => [i.nodeId, i]));
  const { chains, consumed } = collapseChains(items, edges);

  // one representative entry per chain (the head), everything else folded away
  const collapsedItems = items.filter(i => !consumed.has(i.nodeId) || chains.has(i.nodeId));

  const scoreFloor = opts.scoreFloor ?? (opts.applyFloor === false ? -Infinity : DEFAULT_SCORE_FLOOR);
  const filtered = opts.applyFloor === false
    ? collapsedItems
    : collapsedItems.filter(i => i.score >= scoreFloor);

  const ranked = [...filtered].sort((a, b) => b.score - a.score);

  const blocks = [];
  const includedNodeIds = [];
  let usedTokens = 0;
  let droppedCount = 0;

  for (const item of ranked) {
    const block = renderBlock(item, byId, chains);
    const cost = estimateTokens(block);
    if (usedTokens === 0 && cost > tokenBudget) {
      // always return *something* — truncate the single best item to fit
      const charBudget = Math.max(20, tokenBudget * 4);
      blocks.push(truncate(block, charBudget));
      includedNodeIds.push(item.nodeId, ...(chains.get(item.nodeId) || []));
      usedTokens = tokenBudget;
      droppedCount = ranked.length - 1;
      break;
    }
    if (usedTokens + cost > tokenBudget) {
      droppedCount += 1;
      continue;
    }
    blocks.push(block);
    includedNodeIds.push(item.nodeId, ...(chains.get(item.nodeId) || []));
    usedTokens += cost;
  }

  return {
    text: blocks.join('\n\n'),
    includedNodeIds: [...new Set(includedNodeIds)],
    droppedCount,
    usedTokens,
    tokenBudget,
  };
}

/**
 * compile() for a named resolution tier (tiny/small/default/large) — §6.8/§6.9.
 * tiny reads working_memory.json directly, skipping retrieval/embedding entirely.
 * Emits a NodeAccessed event per included node, feeding importance reinforcement
 * (relayGraph §6.3) for next time, unless opts.recordAccess === false.
 */
function compileForResolution(workspacePath, profileName = 'default', opts = {}) {
  const profile = RESOLUTION_PROFILES[profileName] || RESOLUTION_PROFILES.default;
  const edges = safeReadJson(path.join(getGraphDir(workspacePath), 'edges.json'), []);

  let items = profile.source === 'workingMemory'
    ? workingMemoryItems(workspacePath)
    : retrieve(workspacePath, opts.query || '', opts.retrieve || {});

  if (opts.agent) items = applyAgentWeights(items, opts.agent);

  const result = compileStructured(items, edges, opts.tokenBudget ?? profile.tokenBudget, {
    applyFloor: profile.source === 'retrieval',
    ...opts,
  });

  if (opts.recordAccess !== false) {
    for (const nodeId of result.includedNodeIds) {
      try {
        appendEvent(workspacePath, { type: 'NodeAccessed', nodeId, compiledFor: opts.agent || null });
      } catch (_) {
        // best-effort — a failed access-tracking write should never break compile
      }
    }
  }

  return { ...result, profile: profileName };
}

module.exports = {
  RESOLUTION_PROFILES,
  AGENT_WEIGHTS,
  estimateTokens,
  truncate,
  buildSupersessionIndex,
  collapseChains,
  compileStructured,
  compileForResolution,
  workingMemoryItems,
  applyAgentWeights,
};
