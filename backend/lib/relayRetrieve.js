const fs = require('fs');
const path = require('path');
const { getGraphDir } = require('./relayGraph');
const { cosineSimilarity } = require('./relayEmbed');

// Phase 2+3 of docs/KNOWLEDGE_GRAPH_PLAN.md — hybrid retrieval (§6.2/§6.3).
// BM25 always runs (zero dependency, zero setup). Embeddings are an optional
// *additional* relevance signal: retrieve() stays fully synchronous and
// BM25-only unless the caller passes a precomputed opts.queryEmbedding (see
// relayEmbed.embedText / the async retrieveWithEmbeddings wrapper below) —
// this avoids forcing the whole sync/compile/context pipeline to become
// async just because embeddings are real model inference (a Promise).
// Every scored node carries a "why" block so `relay graph query --explain`
// can show exactly which seed/path/score-components produced it.

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const DEFAULT_HOPS = 2;
const DEFAULT_TOP_K = 8;
const DEFAULT_HOP_DECAY = 0.6;
const DEFAULT_EMBEDDING_WEIGHT = 0.5;

// Directory-match boost (docs/KNOWLEDGE_GRAPH_PLAN.md §12's previously-deferred
// BM25 limitation) — see buildDirComponentDf/eligibleDirQueryTokens below.
const DIR_BOILERPLATE_DF_RATIO = 0.8;
const MIN_FILES_FOR_DIR_BOILERPLATE_CHECK = 4;
const DIR_MATCH_BOOST = 3;

function safeReadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function nodeSearchText(node) {
  return [node.text, node.type, node.kind].filter(Boolean).join(' ');
}

/**
 * BM25's IDF rewards corpus-wide rarity — but in a codebase with patterned
 * filenames (index.js/utils.js/types.ts repeated across many directories,
 * or our own benchmark's file0.js...file9.js per cluster), a filename that
 * happens to repeat only once-per-directory looks "rare" corpus-wide, while
 * the directory name itself looks "common" because it repeats many times
 * *within its own directory*. That can rank a wrong-directory file above a
 * right-directory one. Fixed not by reweighting BM25's existing statistics
 * (fragile — the contradiction heuristic taught us that the hard way) but by
 * adding an independent, structural signal: does a query token exactly name
 * one of this file's real directory path components? That's a deterministic
 * fact, not a statistical judgment, so corpus-wide rarity can't confuse it.
 * Gated the same way as the contradiction heuristic's anchor check — a
 * directory name only counts if it isn't near-universal across the corpus
 * (so "src"/"lib" matching every file doesn't count as a meaningful signal).
 */
function pathComponents(filePath) {
  return String(filePath || '').toLowerCase().split(/[\\/]+/).filter(Boolean);
}

function buildDirComponentDf(nodes) {
  const df = new Map();
  const fileNodes = nodes.filter(n => n.type === 'File');
  for (const node of fileNodes) {
    const dirTokens = new Set();
    for (const comp of pathComponents(node.text).slice(0, -1)) {
      for (const t of tokenize(comp)) dirTokens.add(t);
    }
    for (const t of dirTokens) df.set(t, (df.get(t) || 0) + 1);
  }
  return { df, totalFiles: fileNodes.length };
}

/** Query tokens that are real, non-boilerplate directory names somewhere in the corpus. */
function eligibleDirQueryTokens(queryTokens, dirDf, totalFiles) {
  return queryTokens.filter((t) => {
    if (!dirDf.has(t)) return false;
    if (totalFiles < MIN_FILES_FOR_DIR_BOILERPLATE_CHECK) return true;
    return dirDf.get(t) / totalFiles <= DIR_BOILERPLATE_DF_RATIO;
  });
}

/** Fraction of eligible directory tokens that are actually this file's own path components. */
function dirMatchRatio(node, eligibleTokens) {
  if (node.type !== 'File' || !eligibleTokens.length) return 0;
  const dirTokens = new Set();
  for (const comp of pathComponents(node.text).slice(0, -1)) {
    for (const t of tokenize(comp)) dirTokens.add(t);
  }
  const matched = eligibleTokens.filter((t) => dirTokens.has(t)).length;
  return matched / eligibleTokens.length;
}

function buildBm25Index(nodes) {
  const docs = new Map(); // nodeId -> { tf: Map, len }
  const df = new Map(); // term -> doc count
  let totalLen = 0;

  for (const node of nodes) {
    const tokens = tokenize(nodeSearchText(node));
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    docs.set(node.id, { tf, len: tokens.length });
    totalLen += tokens.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }

  const N = nodes.length || 1;
  const avgDocLen = totalLen / N || 1;
  const idf = new Map();
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + (N - count + 0.5) / (count + 0.5)));
  }

  return { docs, idf, avgDocLen, N };
}

function bm25Score(queryTokens, nodeId, index) {
  const doc = index.docs.get(nodeId);
  if (!doc) return 0;
  let score = 0;
  for (const term of queryTokens) {
    const tf = doc.tf.get(term) || 0;
    if (!tf) continue;
    const idf = index.idf.get(term) || 0;
    const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.len) / index.avgDocLen);
    score += idf * ((tf * (BM25_K1 + 1)) / denom);
  }
  return score;
}

/** Scores every node against a query. Returns Map(nodeId -> raw BM25 score). */
function scoreAllNodes(queryText, nodes) {
  const index = buildBm25Index(nodes);
  const queryTokens = tokenize(queryText);
  const scores = new Map();
  for (const node of nodes) scores.set(node.id, bm25Score(queryTokens, node.id, index));
  return scores;
}

/**
 * Per-author accuracy rate among that author's Decision nodes (Laplace-smoothed
 * so one early reversal doesn't tank a reputation built on few data points).
 * Only applies to Decision nodes — see §6.3 ("a tie-breaker, not a trust system").
 */
function computeAgentReputation(nodes) {
  const total = new Map();
  const reversed = new Map();
  for (const node of nodes) {
    if (node.type !== 'Decision' || !node.author) continue;
    total.set(node.author, (total.get(node.author) || 0) + 1);
    if (node.status === 'superseded' || node.status === 'contradicted') {
      reversed.set(node.author, (reversed.get(node.author) || 0) + 1);
    }
  }
  const reputation = new Map();
  for (const [author, count] of total) {
    const bad = reversed.get(author) || 0;
    reputation.set(author, (count - bad + 1) / (count + 2));
  }
  return reputation;
}

/** Undirected adjacency for traversal purposes; relation/weight kept for explainability. */
function buildAdjacency(edges, { historical, now }) {
  const adjacency = new Map();
  function add(a, b, relation, weight) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    adjacency.get(a).push({ neighborId: b, relation, weight });
  }
  for (const e of edges) {
    if (!historical && e.valid_to && Date.parse(e.valid_to) <= now) continue;
    add(e.from, e.to, e.relation, e.weight ?? 1);
    add(e.to, e.from, e.relation, e.weight ?? 1);
  }
  return adjacency;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function scoreComponents(node, relevanceNorm, reputationByAuthor, now) {
  const ageDays = node.last_verified ? Math.max(0, (now - Date.parse(node.last_verified)) / 86400000) : 0;
  const freshness = Math.exp(-(node.decay_rate ?? 0.02) * ageDays);
  const confidence = typeof node.confidence === 'number' ? node.confidence : 0.6;
  const importance = typeof node.importance === 'number' ? node.importance : 1.0;
  const reputation = node.type === 'Decision' ? (reputationByAuthor.get(node.author) ?? 1) : 1;
  return {
    relevance: round(relevanceNorm),
    confidence: round(confidence),
    freshness: round(freshness),
    importance: round(importance),
    reputation: round(reputation),
  };
}

function finalScoreOf(components) {
  return components.relevance * components.confidence * components.freshness * components.importance * components.reputation;
}

/**
 * embed → score → top-K seeds → traverse → ranked list, each item annotated
 * with why it's there (§6.2). BM25-only for now; embeddings land in Phase 3
 * as an additional relevance signal blended in at the same point.
 */
function retrieve(workspacePath, queryText, opts = {}) {
  const hops = opts.hops ?? DEFAULT_HOPS;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const hopDecay = opts.hopDecay ?? DEFAULT_HOP_DECAY;
  const historical = Boolean(opts.history);
  const now = opts.now ?? Date.now();

  const graphDir = getGraphDir(workspacePath);
  // opts.nodes/opts.edges let a caller (retrieveAsOf) supply a historical
  // snapshot instead of the live materialized graph — same ranking/traversal
  // logic, different input, no special-casing needed downstream.
  let nodes = opts.nodes || safeReadJson(path.join(graphDir, 'nodes.json'), []);
  const edges = opts.edges || safeReadJson(path.join(graphDir, 'edges.json'), []);
  if (opts.agent) nodes = nodes.filter(n => !n.author || n.author === opts.agent);
  if (!nodes.length) return [];

  const nodesById = new Map(nodes.map(n => [n.id, n]));
  // No query text (e.g. a general "give me a handoff" call with nothing
  // specific to ask) means BM25 scores every node 0 — that must NOT collapse
  // to "nothing is relevant." It means "rank everything by general
  // worthiness instead" (confidence/freshness/importance/reputation alone),
  // not "return empty." Found via a real `relay context` smoke test: the
  // default profile silently returned 0 nodes for the single most common
  // call shape (no explicit query), which would have made Phase 6's
  // default-on MEMORY GRAPH section empty for almost everyone.
  const queryTokens = tokenize(queryText);
  const hasQuery = queryTokens.length > 0;
  const bm25 = hasQuery ? scoreAllNodes(queryText, nodes) : new Map();
  const maxBm25 = Math.max(1e-9, ...bm25.values());
  const reputation = computeAgentReputation(nodes);
  const adjacency = buildAdjacency(edges, { historical, now });

  // Directory-match boost — see buildDirComponentDf's comment for why this
  // exists. Computed once per call, not per node.
  const { df: dirDf, totalFiles } = buildDirComponentDf(nodes);
  const eligibleTokens = hasQuery ? eligibleDirQueryTokens(queryTokens, dirDf, totalFiles) : [];

  // Embedding blend is opt-in: only activates if the caller supplies a
  // precomputed query vector AND a node-embedding cache exists on disk.
  // Either missing -> relevance is BM25-only, byte-for-byte the Phase 2 path.
  const embeddingsCache = opts.queryEmbedding
    ? safeReadJson(path.join(graphDir, 'embeddings.json'), null)
    : null;
  const embeddingWeight = opts.embeddingWeight ?? DEFAULT_EMBEDDING_WEIGHT;

  function relevanceFor(nodeId) {
    const bm25Norm = hasQuery ? (bm25.get(nodeId) || 0) / maxBm25 : 1;
    let combined = bm25Norm;
    if (embeddingsCache && opts.queryEmbedding) {
      const nodeVector = embeddingsCache[nodeId]?.vector;
      if (nodeVector) {
        const similarity = Math.max(0, cosineSimilarity(opts.queryEmbedding, nodeVector));
        combined = (1 - embeddingWeight) * bm25Norm + embeddingWeight * similarity;
      }
    }
    // Multiplicative, not additive: matching a directory token always implies
    // some nonzero bm25Norm already (the directory name is part of node.text,
    // so BM25 already saw it) — multiplying can't invent relevance out of
    // nothing, it can only amplify a real, already-present match.
    const node = nodesById.get(nodeId);
    if (node) {
      const ratio = dirMatchRatio(node, eligibleTokens);
      if (ratio > 0) combined *= 1 + DIR_MATCH_BOOST * ratio;
    }
    return combined;
  }

  // best relevanceNorm + path found for each node, seeds first. Seed
  // selection now considers every node (not just bm25>0) so a node with no
  // keyword overlap but high embedding similarity can still seed traversal —
  // the actual point of adding embeddings. Ranked by the FULL combined score
  // (not relevanceNorm alone): with no query text, relevanceNorm is uniformly
  // 1 for every node, so ranking by relevanceNorm alone would make "top K"
  // arbitrary array order — confidence/freshness/importance/reputation are
  // what should decide seed selection when there's no specific question.
  const best = new Map();
  const seeds = nodes
    .map(n => {
      const relevanceNorm = relevanceFor(n.id);
      const combinedScore = finalScoreOf(scoreComponents(n, relevanceNorm, reputation, now));
      return { id: n.id, relevanceNorm, combinedScore };
    })
    .filter(c => c.relevanceNorm > 0)
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, topK);

  for (const seed of seeds) {
    best.set(seed.id, { relevanceNorm: seed.relevanceNorm, depth: 0, path: [seed.id], relation: null });
  }

  let frontier = seeds.map(s => ({ id: s.id, relevanceNorm: s.relevanceNorm, depth: 0, path: [s.id] }));
  for (let depth = 0; depth < hops && frontier.length; depth++) {
    const next = [];
    for (const cur of frontier) {
      for (const nb of adjacency.get(cur.id) || []) {
        const propagated = cur.relevanceNorm * (nb.weight ?? 1) * Math.pow(hopDecay, depth + 1);
        const existing = best.get(nb.neighborId);
        if (!existing || propagated > existing.relevanceNorm) {
          const entry = { relevanceNorm: propagated, depth: depth + 1, path: [...cur.path, nb.neighborId], relation: nb.relation };
          best.set(nb.neighborId, entry);
          next.push({ id: nb.neighborId, relevanceNorm: propagated, depth: depth + 1, path: entry.path });
        }
      }
    }
    frontier = next;
  }

  const results = [];
  for (const [nodeId, entry] of best) {
    const node = nodesById.get(nodeId);
    if (!node) continue;
    const components = scoreComponents(node, entry.relevanceNorm, reputation, now);
    results.push({
      nodeId,
      node,
      score: round(finalScoreOf(components)),
      why: { seed: entry.depth === 0, path: entry.path, relation: entry.relation, components },
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Opt-in async wrapper: embeds the query text (one live model call) then
 * delegates to the synchronous retrieve(). If embeddings are unavailable for
 * any reason (package not installed, no network, model failed to load),
 * embedText resolves null and this degrades transparently to BM25-only —
 * identical to calling retrieve() directly.
 */
async function retrieveWithEmbeddings(workspacePath, queryText, opts = {}) {
  const { embedText } = require('./relayEmbed');
  const queryEmbedding = await embedText(queryText);
  return retrieve(workspacePath, queryText, { ...opts, queryEmbedding: queryEmbedding || undefined });
}

module.exports = {
  tokenize,
  buildBm25Index,
  bm25Score,
  scoreAllNodes,
  computeAgentReputation,
  buildAdjacency,
  pathComponents,
  buildDirComponentDf,
  eligibleDirQueryTokens,
  dirMatchRatio,
  retrieve,
  retrieveWithEmbeddings,
};
