const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Phase 3 of docs/KNOWLEDGE_GRAPH_PLAN.md — local embeddings, fully optional.
// @huggingface/transformers is an optionalDependency (backend/package.json):
// `npm install` never fails because of it, and every function here degrades
// to "embeddings unavailable" (null) rather than throwing, so retrieve() can
// always fall back to BM25-only — the zero-paid-API-call, zero-extra-runtime
// goal holds even if this package isn't installed or the model can't be
// downloaded (no network, unsupported platform, anything).

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

let extractorPromise = null;
let unavailable = false;
let unavailableReason = null;

function getCacheDir() {
  return path.join(os.homedir(), '.relay-os', 'models');
}

async function loadExtractor() {
  if (unavailable) return null;
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        // eslint-disable-next-line global-require
        const { pipeline, env } = require('@huggingface/transformers');
        env.cacheDir = getCacheDir();
        return await pipeline('feature-extraction', MODEL_ID, { quantized: true });
      } catch (err) {
        unavailable = true;
        unavailableReason = err.message || String(err);
        return null;
      }
    })();
  }
  return extractorPromise;
}

/** Returns a plain array embedding, or null if embeddings are unavailable for any reason. */
async function embedText(text) {
  try {
    const extractor = await loadExtractor();
    if (!extractor) return null;
    const out = await extractor(String(text || ''), { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  } catch (err) {
    unavailable = true;
    unavailableReason = err.message || String(err);
    return null;
  }
}

/** True cosine similarity — does not assume inputs are pre-normalized (safer for hand-built test vectors). */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function isAvailable() {
  return !unavailable;
}

function unavailabilityReason() {
  return unavailableReason;
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

function safeReadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * Embeds every node missing a (still-valid) cached vector and writes
 * `.relay/graph/embeddings.json`. Explicit/on-demand — not called
 * automatically by relayGraph's sync pipeline, so the existing synchronous
 * sync/compile/context flow never has to become async because of this.
 */
async function embedGraphNodes(workspacePath, opts = {}) {
  const { getGraphDir } = require('./relayGraph');
  const graphDir = getGraphDir(workspacePath);
  const nodes = safeReadJson(path.join(graphDir, 'nodes.json'), []);
  const embeddingsPath = path.join(graphDir, 'embeddings.json');
  const existing = safeReadJson(embeddingsPath, {});
  const updated = { ...existing };

  let embeddedCount = 0;
  let skippedCount = 0;

  for (const node of nodes) {
    const hash = hashText(node.text);
    if (!opts.force && existing[node.id]?.hash === hash) {
      skippedCount += 1;
      continue;
    }
    const vector = await embedText(node.text);
    if (!vector) break; // model unavailable — stop, leave the rest uncached, caller falls back to BM25
    updated[node.id] = { hash, vector };
    embeddedCount += 1;
  }

  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(embeddingsPath, JSON.stringify(updated));

  return { embeddedCount, skippedCount, totalNodes: nodes.length, available: isAvailable(), reason: unavailabilityReason() };
}

function _resetForTests() {
  extractorPromise = null;
  unavailable = false;
  unavailableReason = null;
}

module.exports = {
  MODEL_ID,
  EMBEDDING_DIM,
  getCacheDir,
  embedText,
  cosineSimilarity,
  isAvailable,
  unavailabilityReason,
  hashText,
  embedGraphNodes,
  _resetForTests,
};
