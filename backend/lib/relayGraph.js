const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Phase 1 of docs/KNOWLEDGE_GRAPH_PLAN.md — event-sourced memory graph.
// events.jsonl is the only writable log; nodes.json/edges.json/working_memory.json
// are materialized views, rebuilt by pure functions, never hand-edited.

const NODE_TYPES = ['File', 'Task', 'Goal', 'Decision', 'Evidence', 'Failure', 'Reflection'];

/**
 * Phase 6: opt-OUT, not opt-in. Absence of a `graph` block (every project
 * that ran `relay init` before this phase existed) now means enabled — only
 * an explicit `"enabled": false` turns it off. Single source of truth so the
 * sync gate (backend/relay.js) and the context-brief gate (relayContext.js)
 * can never drift out of sync with each other.
 */
function isGraphEnabled(config) {
  return config?.graph?.enabled !== false;
}

const DEFAULT_DECAY_RATE = {
  File: 0.03,
  Task: 0.03,
  Goal: 0.005,
  Decision: 0.01,
  Evidence: 0.01,
  Failure: 0.02,
};

const IMPORTANCE_BUMP = 0.1;
const COMMITMENT_RE = /\b(decided|final|going with|confirmed|let'?s go with)\b/i;

function getRelayDir(workspacePath) {
  return path.join(workspacePath, '.relay');
}

function getGraphDir(workspacePath) {
  return path.join(getRelayDir(workspacePath), 'graph');
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (_) {
    return '';
  }
}

/**
 * Software projects don't evolve linearly — "Use Redis" on feature/auth and
 * "Use Postgres" on feature/rag aren't a contradiction, they're two
 * branch-scoped truths. Without this, the contradiction heuristic (§6.5)
 * could flag exactly that as a false positive. Returns null (never throws)
 * if this isn't a git repo, git isn't installed, or detection times out —
 * branch-awareness then degrades to "unknown," which the gating logic below
 * treats as "don't block the comparison" (conservative, backward compatible
 * with every decision recorded before this existed).
 */
function getCurrentGitBranch(workspacePath) {
  try {
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 3000,
    });
    if (result.status !== 0) return null;
    const branch = result.stdout.trim();
    return branch || null;
  } catch (_) {
    return null;
  }
}

/** Unknown branch info on either side means "don't block" — only an explicit, known mismatch counts. */
function sameBranchScope(a, b) {
  if (!a?.branch || !b?.branch) return true;
  return a.branch === b.branch;
}

function safeReadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

/** Deterministic, content-addressed node id — same text always maps to the same node. */
function stableId(prefix, text) {
  const hash = crypto.createHash('sha1').update(String(text || '').trim().toLowerCase()).digest('hex').slice(0, 12);
  return `${prefix}:${hash}`;
}

/**
 * Resolves user-supplied decision text (e.g. from `relay decide supersede`)
 * to a real node id. Exact stableId match first; falls back to a substring
 * match against existing decision texts, since a resolved decision's stored
 * text includes its date prefix ("2026-02-01 — ...") as an internal storage
 * detail a real user typing the bare sentence has no way to know about —
 * found via a real CLI smoke test, not a hypothetical. Ambiguous substring
 * matches are reported, never silently guessed; zero matches fall back to
 * the literal computed id (so pre-registering a not-yet-existing decision
 * still works), never thrown away.
 */
function resolveDecisionRef(text, decisionNodes) {
  const exactId = stableId('decision', text);
  if (decisionNodes.some((n) => n.id === exactId)) return { id: exactId, matched: 'exact' };

  const lower = String(text || '').trim().toLowerCase();
  const candidates = decisionNodes.filter((n) => {
    const nodeLower = String(n.text || '').toLowerCase();
    return lower && (nodeLower.includes(lower) || lower.includes(nodeLower));
  });

  if (candidates.length === 1) return { id: candidates[0].id, matched: 'substring' };
  if (candidates.length > 1) return { id: exactId, matched: 'ambiguous', candidates };
  return { id: exactId, matched: 'none' };
}

/** Sortable, unique-enough event id. Not spec-compliant ULID, same intent (time-ordered + unique). */
function generateEventId() {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(4).toString('hex');
  return `evt_${ts}${rand}`;
}

function appendEvent(workspacePath, event) {
  const graphDir = getGraphDir(workspacePath);
  fs.mkdirSync(graphDir, { recursive: true });

  const full = {
    id: event.id || generateEventId(),
    ts: event.ts || new Date().toISOString(),
    source: event.source || 'relay',
    ...event,
  };
  full.id = full.id || generateEventId();

  fs.appendFileSync(path.join(graphDir, 'events.jsonl'), `${JSON.stringify(full)}\n`, 'utf-8');
  return full;
}

function readEvents(workspacePath) {
  const file = path.join(getGraphDir(workspacePath), 'events.jsonl');
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (_) {
      // skip a corrupt line rather than fail the whole read
    }
  }
  return events;
}

function computeInitialConfidence(ev) {
  if (typeof ev.confidence === 'number') return ev.confidence;
  if (ev.source === 'human' || ev.source === 'user') return 0.95;
  if (COMMITMENT_RE.test(ev.text || '')) return 0.85;
  return 0.6;
}

function makeNode(id, type, ts, author) {
  return {
    id,
    type,
    text: '',
    status: 'open',
    confidence: 0.6,
    importance: 1.0,
    decay_rate: DEFAULT_DECAY_RATE[type] ?? 0.02,
    last_verified: ts || null,
    access_count: 0,
    sourceEventIds: [],
    author: author || null, // who created this node — used for agentReputation, §6.3
    branch: null, // which git branch this was true on — set explicitly for Decision/Task/Goal, §6.5 branch-awareness
  };
}

/**
 * Pure function: events -> { nodes, edges }. Re-run from scratch any time;
 * never mutates events.jsonl. Unknown event types are ignored (forward-compatible).
 */
function materializeGraph(events) {
  const nodes = new Map();
  const edges = [];

  // Stable sort by ts, tie-broken by original log position (not event id) —
  // two events sharing a millisecond must still process in append order, or a
  // TaskStatusChanged can be reordered ahead of the TaskCreated it depends on.
  const sorted = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const ta = Date.parse(a.event.ts || '') || 0;
      const tb = Date.parse(b.event.ts || '') || 0;
      if (ta !== tb) return ta - tb;
      return a.index - b.index;
    })
    .map(({ event }) => event);

  function touch(id, type, ts, author) {
    let node = nodes.get(id);
    if (!node) {
      node = makeNode(id, type, ts, author);
      nodes.set(id, node);
    }
    return node;
  }

  function addEdge(from, to, relation, ts, weight = 1) {
    edges.push({ from, to, relation, weight, valid_from: ts || null, valid_to: null });
  }

  for (const ev of sorted) {
    switch (ev.type) {
      case 'FileTouched': {
        const filePath = ev.path || ev.file;
        if (!filePath) break;
        const node = touch(`file:${filePath}`, 'File', ev.ts, ev.source);
        // Full path, not just basename — BM25 over a bare filename can't tell
        // src/billing/utils.js from src/auth/utils.js apart (an extremely
        // common real-world collision: utils.js, index.js, types.ts...),
        // which silently breaks both relevance ranking and cross-cluster
        // separation in any project with repeated filenames across
        // directories. Found via a relationship-recall benchmark, not a unit
        // test — it only shows up with realistic directory structure.
        node.text = filePath || ev.file;
        node.status = 'active';
        node.last_verified = ev.ts;
        node.sourceEventIds.push(ev.id);
        break;
      }

      case 'TaskCreated': {
        if (!ev.nodeId) break;
        const node = touch(ev.nodeId, 'Task', ev.ts, ev.source);
        node.text = ev.text || node.text;
        node.status = ev.status || 'open';
        node.branch = ev.branch || node.branch || null;
        node.last_verified = ev.ts;
        node.sourceEventIds.push(ev.id);
        break;
      }

      case 'TaskStatusChanged': {
        const node = nodes.get(ev.nodeId);
        if (!node) break;
        node.status = ev.status || node.status;
        node.last_verified = ev.ts;
        node.sourceEventIds.push(ev.id);
        break;
      }

      case 'GoalCreated': {
        if (!ev.nodeId) break;
        const node = touch(ev.nodeId, 'Goal', ev.ts, ev.source);
        node.text = ev.text || node.text;
        node.status = 'open';
        node.branch = ev.branch || node.branch || null;
        node.last_verified = ev.ts;
        node.sourceEventIds.push(ev.id);
        break;
      }

      case 'DecisionCreated': {
        if (!ev.nodeId) break;
        const node = touch(ev.nodeId, 'Decision', ev.ts, ev.source);
        node.text = ev.text || node.text;
        node.status = ev.status || 'active';
        node.confidence = computeInitialConfidence(ev);
        node.branch = ev.branch || node.branch || null;
        node.last_verified = ev.ts;
        node.sourceEventIds.push(ev.id);
        if (ev.goalId) addEdge(ev.nodeId, ev.goalId, 'SERVES', ev.ts);
        break;
      }

      case 'DecisionResolved': {
        const node = nodes.get(ev.nodeId);
        if (!node) break;
        node.status = 'resolved';
        node.last_verified = ev.ts;
        node.sourceEventIds.push(ev.id);
        break;
      }

      case 'DecisionSuperseded': {
        const oldNode = nodes.get(ev.nodeId);
        if (oldNode) {
          oldNode.status = 'superseded';
          oldNode.confidence *= 0.2;
          oldNode.sourceEventIds.push(ev.id);
        }
        addEdge(ev.supersededBy, ev.nodeId, 'SUPERSEDES', ev.ts);
        break;
      }

      case 'DecisionContradicted': {
        const oldNode = nodes.get(ev.nodeId);
        if (oldNode) {
          oldNode.status = 'contradicted';
          oldNode.confidence *= 0.2;
          oldNode.sourceEventIds.push(ev.id);
        }
        addEdge(ev.otherId, ev.nodeId, 'CONTRADICTS', ev.ts);
        break;
      }

      case 'DecisionOutcomeObserved': {
        const node = nodes.get(ev.nodeId);
        if (!node) break;
        node.last_verified = ev.ts;
        node.sourceEventIds.push(ev.id);
        if (ev.outcome === 'confirmed') {
          node.confidence = Math.min(1, node.confidence + 0.1);
        } else if (ev.outcome === 'reverted') {
          node.status = 'superseded';
          node.confidence *= 0.2;
        }
        if (ev.evidenceId) addEdge(ev.nodeId, ev.evidenceId, 'SUPPORTED_BY', ev.ts);
        break;
      }

      case 'EvidenceRecorded': {
        if (!ev.nodeId) break;
        const node = touch(ev.nodeId, 'Evidence', ev.ts, ev.source);
        node.text = ev.text || node.text;
        node.status = 'active';
        node.kind = ev.kind || 'link';
        node.last_verified = ev.ts;
        node.sourceEventIds.push(ev.id);
        if (ev.decisionId) addEdge(ev.decisionId, ev.nodeId, 'SUPPORTED_BY', ev.ts);
        break;
      }

      case 'FailureObserved': {
        if (!ev.nodeId) break;
        const node = touch(ev.nodeId, 'Failure', ev.ts, ev.source);
        node.text = ev.text || node.text;
        node.last_verified = ev.ts;
        node.sourceEventIds.push(ev.id);
        for (const causeId of ev.causedBy || []) addEdge(ev.nodeId, causeId, 'CAUSED_BY', ev.ts);
        if (ev.fixedBy && ev.fixedBy.length) {
          node.status = 'resolved';
          for (const fixId of ev.fixedBy) addEdge(ev.nodeId, fixId, 'FIXED_BY', ev.ts);
        } else if (ev.selfResolved) {
          // no specific fixing node to link to (no FIXED_BY edge), but the
          // failure's own text already says it's resolved — keep it out of
          // working_memory.json's blockers without inventing a fake edge.
          node.status = 'resolved';
        } else {
          node.status = 'open';
        }
        break;
      }

      case 'NodeLinked': {
        if (!ev.from || !ev.to || !ev.relation) break;
        addEdge(ev.from, ev.to, ev.relation, ev.ts, ev.weight ?? 1);
        break;
      }

      case 'NodeAccessed': {
        const node = nodes.get(ev.nodeId);
        if (!node) break;
        node.importance = Math.round((node.importance + IMPORTANCE_BUMP) * 1000) / 1000;
        node.access_count += 1;
        break;
      }

      default:
        // unknown/future event type — forward-compatible no-op
        break;
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/** Pure filter over materialized nodes — no embedding, no traversal. The L1 cache. */
function buildWorkingMemory(nodes) {
  return {
    generatedAt: new Date().toISOString(),
    goals: nodes.filter(n => n.type === 'Goal' && n.status === 'open'),
    tasks: nodes.filter(n => n.type === 'Task' && (n.status === 'open' || n.status === 'active')),
    decisions: nodes.filter(n => n.type === 'Decision' && (n.status === 'active' || n.status === 'open')),
    blockers: nodes.filter(n => n.type === 'Failure' && n.status !== 'resolved'),
  };
}

function rebuildGraph(workspacePath) {
  const events = readEvents(workspacePath);
  const { nodes, edges } = materializeGraph(events);
  const workingMemory = buildWorkingMemory(nodes);

  const graphDir = getGraphDir(workspacePath);
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(graphDir, 'nodes.json'), JSON.stringify(nodes, null, 2));
  fs.writeFileSync(path.join(graphDir, 'edges.json'), JSON.stringify(edges, null, 2));
  fs.writeFileSync(path.join(graphDir, 'working_memory.json'), JSON.stringify(workingMemory, null, 2));

  return { nodeCount: nodes.length, edgeCount: edges.length, eventCount: events.length, workingMemory };
}

function parseTaskLines(markdown) {
  const events = [];
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.trim();
    const m = line.match(/^- \[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    events.push({
      nodeId: stableId('task', text),
      text,
      status: m[1].toLowerCase() === 'x' ? 'done' : 'open',
    });
  }
  return events;
}

/**
 * A single regex with an optional checkbox group (`(?:\[[ xX]\]\s*)?`) is
 * backtracking-ambiguous on a bare, never-edited placeholder line: for
 * "- [ ]" (exactly what every freshly-scaffolded decisions.md ships with,
 * before anyone writes a real decision), the engine can't satisfy `(.+)$`
 * with the checkbox group consumed, so it backtracks to NOT consuming the
 * checkbox — and `(.+)$` then happily captures the literal "[ ]" as if it
 * were decision text, creating a garbage Decision node on every untouched
 * project. Found via testing on a real, freshly-`relay init`'d project, not
 * a synthetic fixture (none of which used the literal unedited scaffold).
 * Stripping the checkbox deterministically first avoids the ambiguity.
 */
function stripCheckboxPrefix(text) {
  return String(text || '').replace(/^\[[ xX]\]\s*/, '').trim();
}

function parseOpenDecisionLines(decisionsMd) {
  const events = [];
  const lines = String(decisionsMd || '').split('\n');
  let inOpen = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s*open/i.test(line)) { inOpen = true; continue; }
    if (/^##\s/.test(line) && inOpen) break;
    if (!inOpen) continue;
    const m = line.match(/^- (.+)$/);
    if (!m) continue;
    const text = stripCheckboxPrefix(m[1]);
    if (!text) continue;
    events.push({ nodeId: stableId('decision', text), text });
  }
  return events;
}

/**
 * `## Resolved` entries are historical decisions invisible to the graph until
 * now — the literal staleness problem from KNOWLEDGE_GRAPH_PLAN.md §1 (this
 * section only ever grows in decisions.md, and used to get dumped verbatim
 * into compile_brief.md while being completely absent from the graph).
 * Ingested with status 'resolved' so they're excluded from working_memory.json
 * (not "current") but still retrievable by BM25 when actually relevant.
 */
function parseResolvedDecisionLines(decisionsMd) {
  const events = [];
  const lines = String(decisionsMd || '').split('\n');
  let inResolved = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s*resolved/i.test(line)) { inResolved = true; continue; }
    if (/^##\s/.test(line) && inResolved) break;
    if (!inResolved) continue;
    const m = line.match(/^- (.+)$/);
    if (!m) continue;
    const text = stripCheckboxPrefix(m[1]);
    if (!text) continue;
    const dateMatch = text.match(/^(\d{4}-\d{2}-\d{2})\s*[—-]\s*/);
    const ts = dateMatch ? new Date(`${dateMatch[1]}T00:00:00.000Z`).toISOString() : null;
    events.push({ nodeId: stableId('decision', text), text, ts });
  }
  return events;
}

function parseGoalLines(projectMd) {
  const events = [];
  const lines = String(projectMd || '').split('\n');
  let inGoals = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s*goals/i.test(line)) { inGoals = true; continue; }
    if (/^##\s/.test(line) && inGoals) break;
    if (!inGoals) continue;
    const m = line.match(/^- (.+)$/);
    if (!m) continue;
    const text = m[1].trim();
    if (!text) continue;
    events.push({ nodeId: stableId('goal', text), text });
  }
  return events;
}

// Narrow keyword heuristic, same spirit/risk-profile as the contradiction
// heuristic: without it, a failures.md entry that already says "— fixed" in
// its own text would still show up as an active blocker in working_memory.json
// forever (the exact staleness problem this whole project targets). Negation
// guard first (catches "unresolved", "not fixed yet", "still an issue") since
// a false positive here only hides a node from the L1 cache — it stays fully
// retrievable via BM25 — much lower blast radius than the contradiction
// heuristic, so this runs on by default with no config flag. Still a known,
// documented limitation: "fixed-size buffer" would false-positive on "fixed"
// as a standalone word; acceptable for short lessons-learned notes.
const FAILURE_RESOLVED_RE = /\b(fixed|resolved|patched)\b/i;
const FAILURE_NOT_RESOLVED_RE = /\b(unresolved|not\s+(yet\s+)?(fixed|resolved)|still\s+(broken|unresolved|an?\s+issue))\b/i;

function isFailureSelfResolved(text) {
  const s = String(text || '');
  if (FAILURE_NOT_RESOLVED_RE.test(s)) return false;
  return FAILURE_RESOLVED_RE.test(s);
}

function parseFailureLines(failuresMd) {
  const events = [];
  for (const raw of String(failuresMd || '').split('\n')) {
    const line = raw.trim();
    const m = line.match(/^- (.+)$/);
    if (!m) continue;
    const text = m[1].trim();
    if (!text) continue;
    events.push({ nodeId: stableId('failure', text), text, selfResolved: isFailureSelfResolved(text) });
  }
  return events;
}

/**
 * Explicit markdown convention (not NLP): a decision bullet followed by a
 * more-indented "Evidence: ..." sub-bullet becomes an Evidence node linked to
 * that decision via SUPPORTED_BY. Same philosophy as current_task.md's `- [ ]`
 * checkbox convention — a small, learnable convention beats guessing intent
 * from free text, and closes the provenance gap (§6.4) that had a schema but
 * no real ingestion path until now.
 *
 *   ## Open
 *   - Use Kuzu for the embedded graph store
 *     - Evidence: benchmark showed 4x lower traversal latency (bench/results.md)
 */
function parseDecisionEvidenceLines(decisionsMd) {
  const events = [];
  let currentDecisionText = null;

  for (const raw of String(decisionsMd || '').split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^(\s*)/)[1].length;
    const trimmed = raw.trim();

    if (/^##\s/.test(trimmed)) {
      currentDecisionText = null;
      continue;
    }

    if (indent > 0 && currentDecisionText) {
      const evidenceMatch = trimmed.replace(/^- /, '').match(/^evidence:\s*(.+)$/i);
      if (evidenceMatch) {
        const text = evidenceMatch[1].trim();
        if (text) events.push({ decisionNodeId: stableId('decision', currentDecisionText), text });
        continue;
      }
    }

    if (indent === 0) {
      const decisionMatch = trimmed.match(/^- (.+)$/);
      currentDecisionText = decisionMatch ? stripCheckboxPrefix(decisionMatch[1]) || null : null;
    }
  }

  return events;
}

/**
 * Same explicit-sub-bullet convention as Evidence, generalized: a `- Serves:
 * <goal text>` line under EITHER a decision bullet (decisions.md) or a task
 * bullet (current_task.md) links that decision/task to a Goal — one parser,
 * two attachment points, instead of a separate convention per node type.
 * Closes the confirmed Decision->Goal gap (relationship-recall benchmark
 * showed SERVES has a real materializer/traversal path but nothing in real
 * ingestion ever set it) and extends the same mechanism to Tasks, which
 * otherwise have zero edges to anything.
 *
 *   ## Open
 *   - Use Kuzu for the embedded graph store
 *     - Serves: Reduce context window cost
 */
function parseServesLines(markdown, parentPrefix) {
  const events = [];
  let currentParentText = null;

  for (const raw of String(markdown || '').split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^(\s*)/)[1].length;
    const trimmed = raw.trim();

    if (/^##\s/.test(trimmed)) {
      currentParentText = null;
      continue;
    }

    if (indent > 0 && currentParentText) {
      const servesMatch = trimmed.replace(/^- /, '').match(/^serves:\s*(.+)$/i);
      if (servesMatch) {
        const goalText = servesMatch[1].trim();
        if (goalText) events.push({ parentNodeId: stableId(parentPrefix, currentParentText), goalText });
        continue;
      }
    }

    if (indent === 0) {
      const bulletMatch = trimmed.match(/^- (.+)$/);
      currentParentText = bulletMatch ? stripCheckboxPrefix(bulletMatch[1]) || null : null;
    }
  }

  return events;
}

// Narrow contradiction heuristic (§6.5) — opt-in via graph.contradictionHeuristic
// in config.json, off by default. Deliberately NOT general NLP: only this fixed
// antonym-verb-pair list, only when the two decisions also share enough subject
// vocabulary. A general detector would need an LLM to be reliable, and a bad
// heuristic here actively hides a still-valid decision — staying narrow and
// explicit is the point, not a limitation to "fix" by growing this list freely.
const ANTONYM_PAIRS = [['use', 'avoid'], ['adopt', 'reject'], ['enable', 'disable']];
const SUBJECT_STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with', 'instead',
  'use', 'using', 'avoid', 'adopt', 'reject', 'enable', 'disable', 'this', 'that', 'will', 'should',
]);
const SUBJECT_OVERLAP_THRESHOLD = 0.4;
// A shared token only counts as "boilerplate, not a real subject anchor" once
// there's enough of a comparison pool to judge that statistically — below this
// many decisions, "appears in every decision compared" is as likely to be
// coincidence as a template, so the anchor check is skipped entirely rather
// than risk rejecting a real (if small-sample) match.
const MIN_CORPUS_FOR_BOILERPLATE_DETECTION = 4;
const BOILERPLATE_DF_RATIO = 0.8;

function subjectTokens(text) {
  return new Set(
    String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && !SUBJECT_STOPWORDS.has(t))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

// Overlap coefficient (intersection / smaller set), not Jaccard (intersection /
// union) — Jaccard over-penalizes when one decision is phrased as a short
// statement and the other as a longer restatement with extra qualifiers
// ("...after load testing"), which is exactly how real decision reversals
// read. Overlap coefficient asks "is the shorter one's subject contained in
// the longer one," which is the actual question for this heuristic.
function overlapCoefficient(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  return intersection / Math.min(a.size, b.size);
}

function buildDocFrequency(texts) {
  const df = new Map();
  for (const text of texts) {
    for (const t of subjectTokens(text)) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}

/**
 * Token-overlap thresholds alone are fooled by a template repeated across many
 * decisions that differ only in one word (e.g. "Use a dedicated queue for the
 * X subsystem" x10) — every pair shares most of its tokens via the boilerplate
 * alone, regardless of whether X actually matches. Requiring at least one
 * shared token that is NOT near-universal across the comparison corpus (a
 * "subject anchor") fixes this: boilerplate present in ~every decision can't
 * anchor a match, but a genuinely shared, specific term (e.g. "billing",
 * "redis") still can. This was a real false positive caught by the
 * long-codebase stress test — see relayGraphIngestion.test.js.
 */
function hasSubjectAnchor(sharedTokens, df, corpusSize) {
  if (corpusSize < MIN_CORPUS_FOR_BOILERPLATE_DETECTION) return true;
  for (const t of sharedTokens) {
    if ((df.get(t) || 0) / corpusSize <= BOILERPLATE_DF_RATIO) return true;
  }
  return false;
}

function pairContradicts(aText, bText, df, corpusSize) {
  const aTokens = subjectTokens(aText);
  const bTokens = subjectTokens(bText);
  if (overlapCoefficient(aTokens, bTokens) < SUBJECT_OVERLAP_THRESHOLD) return false;

  const shared = [...aTokens].filter(t => bTokens.has(t));
  if (!hasSubjectAnchor(shared, df, corpusSize)) return false;

  const aLower = String(aText || '').toLowerCase();
  const bLower = String(bText || '').toLowerCase();
  return ANTONYM_PAIRS.some(([a, b]) => (aLower.includes(a) && bLower.includes(b)) || (aLower.includes(b) && bLower.includes(a)));
}

/**
 * Compares each newly-ingested decision against existing decision nodes
 * (bounded by newCount × existingDecisionCount, not O(n²) over full history —
 * stays cheap on a long-lived project) AND against every other decision in
 * the same ingest batch — two contradicting lines that were both already in
 * decisions.md before relay ever ran would otherwise never be compared,
 * since neither one is "existing" yet on that first sync.
 */
function detectContradictions(newDecisions, existingDecisionNodes) {
  const matches = [];
  const seenPairs = new Set();

  const corpusTexts = [...existingDecisionNodes.map(n => n.text), ...newDecisions.map(n => n.text)];
  const df = buildDocFrequency(corpusTexts);
  const corpusSize = corpusTexts.length;

  function record(oldId, newId) {
    const key = [oldId, newId].sort().join('|');
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    matches.push({ oldId, newId });
  }

  for (const nd of newDecisions) {
    for (const ed of existingDecisionNodes) {
      if (ed.id === nd.nodeId) continue;
      if (!sameBranchScope(nd, ed)) continue; // branch-scoped truths aren't contradictions
      if (pairContradicts(nd.text, ed.text, df, corpusSize)) record(ed.id, nd.nodeId);
    }
  }

  for (let i = 0; i < newDecisions.length; i++) {
    for (let j = i + 1; j < newDecisions.length; j++) {
      if (!sameBranchScope(newDecisions[i], newDecisions[j])) continue;
      if (pairContradicts(newDecisions[i].text, newDecisions[j].text, df, corpusSize)) {
        record(newDecisions[i].nodeId, newDecisions[j].nodeId); // earlier in the batch treated as "old"
      }
    }
  }

  return matches;
}

// File co-edit graph (§6.7) — cheap dependency-impact, not real static analysis.
// Gap-based session windowing: a run of FileTouched events with no gap larger
// than CO_EDIT_WINDOW_MS between consecutive touches forms one window; files
// within a window get CO_EDITED edges. Capped at CO_EDIT_MAX_WINDOW_FILES per
// window so one huge window can't produce a combinatorial edge blowup.
const CO_EDIT_WINDOW_MS = 30 * 60 * 1000;
const CO_EDIT_MAX_WINDOW_FILES = 10;

function buildCoEditLinks(fileTouchEvents) {
  const sorted = [...fileTouchEvents]
    .filter(e => e.ts && (e.path || e.file))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const links = [];
  let prevTs = null;
  let windowFiles = [];

  function flush() {
    const uniq = [...new Set(windowFiles)].slice(0, CO_EDIT_MAX_WINDOW_FILES);
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        links.push({ from: uniq[i], to: uniq[j] });
      }
    }
  }

  for (const e of sorted) {
    const fileId = `file:${e.path || e.file}`;
    const t = Date.parse(e.ts);
    if (prevTs !== null && t - prevTs > CO_EDIT_WINDOW_MS) {
      flush();
      windowFiles = [];
    }
    windowFiles.push(fileId);
    prevTs = t;
  }
  flush();

  return links;
}

/**
 * Only the still-possibly-growing trailing session, not a fixed event count.
 * A count-based slice (e.g. "last 50 touches") can cut a window in a
 * different place on every sync — sync N caps a cluster's first 10 files,
 * sync N+1's differently-positioned slice caps a *different* 10 files in the
 * same cluster, producing "new" edges every time even though nothing in the
 * project changed. Walking backward by time gap instead means a CLOSED
 * window (a later touch exists more than CO_EDIT_WINDOW_MS after it) is
 * never reconsidered again, ever — so it's computed, capped, and deduped
 * exactly once, regardless of total project history size.
 */
function trailingOpenWindow(fileTouchEvents) {
  const sorted = [...fileTouchEvents]
    .filter(e => e.ts && (e.path || e.file))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (!sorted.length) return [];

  let start = sorted.length - 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    const gap = Date.parse(sorted[i].ts) - Date.parse(sorted[i - 1].ts);
    if (gap > CO_EDIT_WINDOW_MS) break;
    start = i - 1;
  }
  return sorted.slice(start);
}

/**
 * Bridges buildGlobalTimeline() output + IR markdown into graph events.
 * Idempotent: only emits a *Created event for a nodeId that doesn't already
 * exist in the materialized graph, and only emits TaskStatusChanged when the
 * status actually differs — re-running this on every sync does not spam the log.
 */
function fileTouchSignature(ev) {
  return `${ev.source || ''}::${ev.path || ev.file || ''}::${ev.ts || ''}`;
}

function coEditSignature(from, to) {
  return [from, to].sort().join('|');
}

function ingestTimelineIntoEvents(workspacePath, timeline = []) {
  const graphDir = getGraphDir(workspacePath);
  const existingNodes = safeReadJson(path.join(graphDir, 'nodes.json'), []);
  const existingById = new Map(existingNodes.map(n => [n.id, n]));
  const existingDecisionNodes = existingNodes.filter(n => n.type === 'Decision');
  const existingEdges = safeReadJson(path.join(graphDir, 'edges.json'), []);

  // Read the event log once and reuse it for both dedup checks below, rather
  // than re-reading the full file twice — matters once events.jsonl is large.
  const allEvents = readEvents(workspacePath);
  const allFileTouches = allEvents.filter(e => e.type === 'FileTouched');

  // memory.json's timeline is the full history every time, not just events since
  // the last sync — without this, every FileTouched in history gets re-appended
  // on every single `relay sync`, growing events.jsonl unboundedly.
  const seenFileTouches = new Set(allFileTouches.map(fileTouchSignature));
  const seenCoEdits = new Set(
    existingEdges.filter(e => e.relation === 'CO_EDITED').map(e => coEditSignature(e.from, e.to))
  );
  // SERVES is directional (decision/task -> goal), unlike CO_EDITED — no sort.
  const seenServesLinks = new Set(
    existingEdges.filter(e => e.relation === 'SERVES').map(e => `${e.from}|${e.to}`)
  );

  const relayDir = getRelayDir(workspacePath);
  const config = safeReadJson(path.join(relayDir, 'config.json'), {});
  const currentBranch = getCurrentGitBranch(workspacePath);
  const toAppend = [];
  const newFileTouches = [];
  const newDecisions = []; // for the contradiction heuristic below

  for (const e of timeline) {
    if (e.kind === 'code_edit' && (e.path || e.file)) {
      const candidate = { type: 'FileTouched', source: e.source, file: e.file, path: e.path || e.file, summary: e.summary, ts: e.ts };
      const signature = fileTouchSignature(candidate);
      if (seenFileTouches.has(signature)) continue;
      seenFileTouches.add(signature);
      toAppend.push(candidate);
      newFileTouches.push(candidate);
    }
  }

  const currentTaskMd = safeRead(path.join(relayDir, 'current_task.md'));

  for (const { nodeId, text, status } of parseTaskLines(currentTaskMd)) {
    const existing = existingById.get(nodeId);
    if (!existing) {
      toAppend.push({ type: 'TaskCreated', source: 'ir:current_task.md', nodeId, text, status, branch: currentBranch });
    } else if (existing.status !== status) {
      toAppend.push({ type: 'TaskStatusChanged', source: 'ir:current_task.md', nodeId, status });
    }
  }

  for (const { nodeId, text } of parseGoalLines(safeRead(path.join(relayDir, 'project.md')))) {
    if (!existingById.has(nodeId)) {
      toAppend.push({ type: 'GoalCreated', source: 'ir:project.md', nodeId, text, branch: currentBranch });
    }
  }

  const decisionsMd = safeRead(path.join(relayDir, 'decisions.md'));

  for (const { nodeId, text } of parseOpenDecisionLines(decisionsMd)) {
    if (!existingById.has(nodeId)) {
      const ev = { type: 'DecisionCreated', source: 'ir:decisions.md', nodeId, text, branch: currentBranch };
      toAppend.push(ev);
      newDecisions.push(ev);
    }
  }

  for (const { nodeId, text, ts } of parseResolvedDecisionLines(decisionsMd)) {
    const existing = existingById.get(nodeId);
    if (!existing) {
      const ev = { type: 'DecisionCreated', source: 'ir:decisions.md', nodeId, text, status: 'resolved', branch: currentBranch, ...(ts ? { ts } : {}) };
      toAppend.push(ev);
      newDecisions.push(ev);
    } else if (existing.status !== 'resolved') {
      toAppend.push({ type: 'DecisionResolved', source: 'ir:decisions.md', nodeId, ...(ts ? { ts } : {}) });
    }
  }

  if (config?.graph?.contradictionHeuristic) {
    for (const { oldId, newId } of detectContradictions(newDecisions, existingDecisionNodes)) {
      toAppend.push({ type: 'DecisionContradicted', source: 'relay:contradiction-heuristic', nodeId: oldId, otherId: newId });
    }
  }

  for (const { decisionNodeId, text } of parseDecisionEvidenceLines(decisionsMd)) {
    const nodeId = stableId('evidence', text);
    if (!existingById.has(nodeId)) {
      toAppend.push({ type: 'EvidenceRecorded', source: 'ir:decisions.md', nodeId, text, decisionId: decisionNodeId });
    }
  }

  // SERVES: explicit `- Serves: <goal text>` sub-bullet under EITHER a
  // decision (decisions.md) or a task (current_task.md) — same convention,
  // two attachment points. Auto-creates the Goal node if its text doesn't
  // already match one from project.md's `## Goals` section, rather than
  // silently dropping a clearly-stated intention.
  const servesRefs = [
    ...parseServesLines(decisionsMd, 'decision'),
    ...parseServesLines(currentTaskMd, 'task'),
  ];
  for (const { parentNodeId, goalText } of servesRefs) {
    const goalNodeId = stableId('goal', goalText);
    if (!existingById.has(goalNodeId)) {
      toAppend.push({ type: 'GoalCreated', source: 'ir:serves-reference', nodeId: goalNodeId, text: goalText });
    }
    const linkSignature = `${parentNodeId}|${goalNodeId}`;
    if (!seenServesLinks.has(linkSignature)) {
      seenServesLinks.add(linkSignature);
      toAppend.push({ type: 'NodeLinked', source: 'ir:serves-reference', from: parentNodeId, to: goalNodeId, relation: 'SERVES' });
    }
  }

  for (const { nodeId, text, selfResolved } of parseFailureLines(safeRead(path.join(relayDir, 'failures.md')))) {
    if (!existingById.has(nodeId)) {
      toAppend.push({ type: 'FailureObserved', source: 'ir:failures.md', nodeId, text, causedBy: [], fixedBy: [], selfResolved });
    }
  }

  // Co-edit windowing only over the still-open trailing session (existing) +
  // new touches — not the full historical FileTouched corpus, and not a fixed
  // count either (see trailingOpenWindow for why a fixed count breaks
  // idempotency). Stays cheap regardless of how long-lived the project is.
  const candidateFileTouches = trailingOpenWindow(allFileTouches).concat(newFileTouches);
  for (const { from, to } of buildCoEditLinks(candidateFileTouches)) {
    const signature = coEditSignature(from, to);
    if (seenCoEdits.has(signature)) continue;
    seenCoEdits.add(signature);
    toAppend.push({ type: 'NodeLinked', source: 'relay:co-edit', from, to, relation: 'CO_EDITED', weight: 0.6 });
  }

  for (const ev of toAppend) appendEvent(workspacePath, ev);
  return toAppend.length;
}

/** Convenience: ingest current memory.json timeline + IR, then rebuild the materialized graph. */
function syncGraph(workspacePath) {
  const memoryPath = path.join(getRelayDir(workspacePath), 'memory.json');
  const memory = safeReadJson(memoryPath, null);
  const timeline = Array.isArray(memory?.timeline) ? memory.timeline : [];

  const ingestedEvents = ingestTimelineIntoEvents(workspacePath, timeline);
  const result = rebuildGraph(workspacePath);
  return { ...result, ingestedEvents };
}

module.exports = {
  NODE_TYPES,
  DEFAULT_DECAY_RATE,
  getGraphDir,
  stableId,
  resolveDecisionRef,
  generateEventId,
  appendEvent,
  readEvents,
  materializeGraph,
  buildWorkingMemory,
  rebuildGraph,
  ingestTimelineIntoEvents,
  syncGraph,
  computeInitialConfidence,
  parseOpenDecisionLines,
  parseResolvedDecisionLines,
  detectContradictions,
  subjectTokens,
  jaccard,
  overlapCoefficient,
  buildDocFrequency,
  hasSubjectAnchor,
  buildCoEditLinks,
  trailingOpenWindow,
  ANTONYM_PAIRS,
  isFailureSelfResolved,
  parseFailureLines,
  parseDecisionEvidenceLines,
  parseServesLines,
  stripCheckboxPrefix,
  getCurrentGitBranch,
  sameBranchScope,
  isGraphEnabled,
};
