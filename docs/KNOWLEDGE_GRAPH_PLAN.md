# Memory Graph + Context Compiler — Project Plan

> Status: **Draft / not started**. Additive feature, no rewrite — same principle as the planned Conductor layer (see `.relay/decisions.md`, 2026-06-14). Markdown IR (`project.md`, `current_task.md`, `decisions.md`, `failures.md`) keeps working unchanged throughout Phase 1–4; nothing here removes a file or breaks an existing hook/skill/MCP contract until Phase 6, and that flip is explicitly opt-in.
>
> v2 — incorporates a second round of design review. Net effect: a few cheap, high-leverage additions (Goal nodes, evidence/provenance edges, importance decay, retrieval explainability, multi-resolution compiler output, a no-retrieval working-memory fast path) folded in; a few ideas deliberately simplified or deferred to keep this buildable by one contributor in a Node CLI tool rather than a research system (see §6.6 and §6.10 for what got cut and why).

## 1. Problem

`relay compile` / `relay context` currently produce their output by **slicing**, not **selecting**: the last 60 timeline events plus the full text of every IR markdown file get dumped into `compile_brief.md` and `relay_context.md` regardless of relevance (`backend/lib/relayContext.js`). Concrete costs:

1. **Context-window cost.** Free-tier models have small windows. A 619 KB `memory.json` (our own dogfood project, 661 events) already produces a 14 KB `compile_brief.md` — most of it irrelevant to the agent's actual next step.
2. **Staleness.** `decisions.md` and `current_task.md` only grow. A decision that was reversed three sessions ago still gets dumped verbatim next to the decision that replaced it.
3. **No relevance ranking.** Everything in IR is weighted equally — no way to ask "what's relevant to the file I'm about to touch," only "what happened recently."
4. **No provenance.** Nothing currently records *why* a decision exists, so a later agent can't tell a well-evidenced decision from a guess, or trust one agent's claim over another's when they conflict.

## 2. Goals

- Replace **slicing** with **retrieval + ranking + compression** ("Context Compiler") as the last step before `compile_brief.md` / `relay_context.md` are written.
- Model facts as a graph (node/edge types in §5) so multi-hop and temporal questions ("what superseded what," "what touched this file," "why are we doing this") are answerable without re-reading raw transcripts.
- Give every retrieved fact **provenance** (what evidence backs it) and a **confidence/reputation** score, so conflicting claims from different agents resolve deterministically instead of both being dumped into context.
- Emit context at the **smallest size that's still correct**, not just "smaller than before" — the compiler should be able to produce a 200-token answer and a 2000-token answer from the same graph, picked by target model.
- Make it work **with zero paid API calls** — local embeddings, heuristic extraction, deterministic compression. LLM assist stays optional, same pattern as `relayCompileIr.js` today.
- Stay **single-runtime (Node), file-only, no server** — matches every existing architectural decision in `.relay/decisions.md`.
- Ship **additively**: existing markdown IR, hooks, MCP tools, and the `compile_brief.md`/`relay_context.md` *file contract* (same filenames, same consumers) keep working at every phase.

## 3. Non-goals (explicitly out of scope)

- **Real code dependency graphs** (import/call graphs via tree-sitter/ts-morph). "If I edit file X, what breaks" needs static analysis of source code — different work than mining agent transcripts. Cheap co-edit heuristic instead (§6.7); true static analysis is a future RFC.
- **Replacing markdown IR as the editable surface.** Agents/users keep hand-editing `project.md`/`current_task.md`/`decisions.md`; the graph ingests them, it doesn't replace them (until the optional Phase 6 flip).
- **A rigid hierarchical containment tree** (`Workspace → Goal → Architecture → Decision → Task`). Real project structure isn't a clean tree — a Decision can serve two Goals, a Task can matter to three Decisions. Modeled instead as typed nodes + bounded-hop traversal, which gets the same "retrieve at the right level" behavior without forcing facts into a shape they don't fit. See §6.6.
- **Predictive/prefetch retrieval** ("editing file X → preload Y, Z"). Real optimization, zero correctness benefit, meaningfully more complexity (needs a sequence model over edit history). Noted as future work in §6.10, not designed here.
- **LLM-free reflection synthesis.** Summarizing 20 sessions into one insight needs synthesis, not extraction — a heuristic reflection is more likely to inject confidently-wrong noise than to help. Reflection generation is gated behind `llmAssist` and is optional/Phase 7+, never part of the no-LLM core path. See §6.10.
- A graph database server (Neo4j, etc.) or a second language runtime (Python) — decided in the prior design round, recapped in §9.

## 4. Architecture overview

```
                 ┌─────────────────────────────────────────────┐
existing:        │  parsers/*.js → buildGlobalTimeline()         │
(unchanged)      │  → memory.json { agents, timeline }            │
                 └───────────────────┬────────────────────────────┘
                                      │
                                      ▼
new:             ┌─────────────────────────────────────────────┐
relayGraph.js     │  Event log (append-only, source of truth)     │
                 │  .relay/graph/events.jsonl                     │
                 │       ↓ materialize (pure fn, rebuildable)     │
                 │  nodes.json / edges.json (cache, derived)      │
                 │       ↓ cheap filter (no retrieval)            │
                 │  working_memory.json (current Goals/Tasks/     │
                 │  active Decisions/open blockers — the L1 cache)│
                 └───────────────────┬────────────────────────────┘
                                      │
                          ┌───────────┴────────────┐
                          │ small/fast query?       │ deeper query?
                          ▼                         ▼
                 working_memory.json direct   ┌─────────────────────────┐
                 (no embedding, no traversal) │ relayRetrieve.js          │
                                               │ embed → seed → traverse  │
                                               │ → ranked nodes + "why"   │
                                               └──────────┬───────────────┘
                                      │                    │
                                      ▼                    ▼
new:             ┌─────────────────────────────────────────────┐
relayContext      │  Context Compiler                              │
Compiler.js       │  ranked/working-memory nodes + token budget →  │
                 │    collapse supersession/contradiction chains  │
                 │    drop stale/low-confidence/low-importance     │
                 │    greedy-fill to budget (one of N resolutions) │
                 │    (optional LLM prose pass if key present)     │
                 └───────────────────┬────────────────────────────┘
                                      │
                                      ▼
existing:        compile_brief.md/.json, relay_context.md/.json
(same contract)  — same filenames, same consumers (hooks, skill, MCP, UI)
```

**Key design choice — event sourcing as the only writable log.** `events.jsonl` is append-only and is the single source of truth. `nodes.json`/`edges.json`/`working_memory.json` are *materialized views*, rebuilt by pure functions, never hand-edited. Mirrors how `memory.json` is already a derived cache of raw transcripts — same pattern, one layer deeper.

## 5. Data model

### 5.1 Node types

| Type | Represents | New in v2? |
|---|---|---|
| `File` | a touched file | — |
| `Task` | an item from `current_task.md` | — |
| `Decision` | an item from `decisions.md` | — |
| `Failure` | an item from `failures.md` | — |
| `Goal` | why a Decision/Task exists | yes |
| `Evidence` | a benchmark, test result, issue link, or other artifact a Decision cites | yes |
| `Session` / `Agent` | provenance scaffolding | — |

`Evidence` subsumes what would otherwise be three separate node types (benchmark/issue/external-link) — one type, a `kind` field. Kept deliberately generic instead of modeling the full `Observation → Hypothesis → Decision → Implementation → Outcome` chain as five rigid node types: that chain is real and worth preserving, but it's expressible with the existing primitives — `Evidence --MOTIVATES--> Decision --SERVES--> Goal`, `Decision --IMPLEMENTED_BY--> Task/File`, and "outcome" is just a later `DecisionOutcomeObserved` event that adjusts the same Decision's confidence/status rather than spawning a new node. Same causal traceability, two new node types instead of five, no rigid stage machine that real conversations won't cleanly fit into.

### 5.2 Event types (`.relay/graph/events.jsonl`, one JSON object per line)

| Event | Payload | Emitted by |
|---|---|---|
| `FileTouched` | `{id, ts, source, file, path, summary, diff?}` | sync, from existing `code_edit` timeline events |
| `TaskCreated` / `TaskStatusChanged` | `{id, ts, text, status: open\|done}` | sync, parsed from `current_task.md` checkboxes |
| `GoalCreated` | `{id, ts, text, source}` | sync (explicit `## Goals` section in `project.md`) or `relay graph goal "<text>"` |
| `DecisionCreated` | `{id, ts, text, source, confidence}` | sync, parsed from `decisions.md` |
| `DecisionSuperseded` / `DecisionContradicted` | `{id, ts, decisionId, otherId, reason?}` | see §6.5 — explicit signal, narrow opt-in heuristic only |
| `DecisionOutcomeObserved` | `{id, ts, decisionId, outcome: confirmed\|reverted, evidenceId?}` | sync, or explicit `relay decide --outcome` |
| `EvidenceRecorded` | `{id, ts, kind: benchmark\|issue\|link\|test_result, text, decisionId}` | sync, or explicit |
| `FailureObserved` | `{id, ts, text, causedBy: nodeId[], fixedBy: nodeId[]?}` | sync, parsed from `failures.md` + error-pattern detection |
| `NodeLinked` | `{id, ts, from, to, relation, weight}` | generic edge event — relation vocabulary in §5.4 |
| `NodeAccessed` | `{id, ts, nodeId, compiledFor}` | emitted by the Context Compiler each time a node is actually included in output — feeds importance reinforcement, §6.3 |

Every event carries `id` (ULID, sortable + unique), `ts`, and `source` for provenance.

### 5.3 Materialized node schema (`.relay/graph/nodes.json`)

```jsonc
{
  "id": "decision_14",
  "type": "Decision",
  "text": "Use Redis for session cache",
  "status": "active",            // active | superseded | contradicted | resolved | open
  "confidence": 0.95,             // deterministic heuristic, §6.3
  "importance": 1.4,              // base 1.0, reinforced by NodeAccessed events, §6.3
  "decay_rate": 0.01,             // per node type — Decisions/Goals decay slow, Tasks decay fast
  "last_verified": "2026-06-17T10:00:00Z",
  "access_count": 6,
  "sourceEventIds": ["evt_88", "evt_91"]
}
```

### 5.4 Edge schema (`.relay/graph/edges.json`), bi-temporal

```jsonc
{
  "from": "decision_14",
  "to": "decision_11",
  "relation": "SUPERSEDES",
  "weight": 1.0,
  "valid_from": "2026-06-17T10:00:00Z",
  "valid_to": null               // set when this edge itself is superseded
}
```

Relation vocabulary: `MENTIONS`, `CO_EDITED`, `RESOLVES`, `BLOCKS`, `RELATES_TO`, `SUPERSEDES`, `CONTRADICTS`, `MOTIVATED_BY` (Decision → Evidence/Failure), `SUPPORTED_BY` (Decision → Evidence), `SERVES` (Decision/Task → Goal), `IMPLEMENTED_BY` (Decision → Task/File).

Bi-temporal `valid_from`/`valid_to` (Zep/Graphiti pattern) is what lets retrieval ask for "current state only" and skip history unless a query is explicitly historical.

## 6. Component plan

### 6.1 `backend/lib/relayGraph.js` (new)

- `appendEvent(workspacePath, event)` — append-only write to `events.jsonl`, ULID-stamped.
- `materializeGraph(events)` — pure function: events → `{nodes, edges}`.
- `rebuildGraph(workspacePath)` — reads `events.jsonl`, writes `nodes.json`/`edges.json`. Exposed as `relay graph rebuild`.
- `buildWorkingMemory(nodes, edges)` — pure filter, **no embedding, no traversal**: all `Goal` nodes with status `open`, all `Task`/`Decision` nodes with status `active`/`open`, all `Failure` nodes with no `fixedBy` yet. Writes `working_memory.json`. This is the L1 cache — cheap enough to recompute on every `relay sync` with no latency concern on the stop-hook path.
- `ingestTimelineIntoEvents(workspacePath, timeline)` — bridges `buildGlobalTimeline()` output and IR markdown into graph events. Called at the end of `relay sync`, additive, doesn't change `memory.json`.

### 6.2 `backend/lib/relayRetrieve.js` (new)

- `embed(text)` / `embedFallback(text)` — local model (`@huggingface/transformers`, `Xenova/all-MiniLM-L6-v2`) with BM25/TF-IDF fallback if the model can't load or `graph.embeddings: false`.
- `scoreNodes(queryVec, nodes)` — brute-force cosine similarity (fine at this scale; revisit past ~50k nodes).
- `traverse(seedIds, edges, hops=2)` — BFS with decay, skips edges past `valid_to` unless query is historical.
- `retrieve(workspacePath, queryText, opts)` — embed → score → top-K seeds → traverse → ranked list, **each item annotated with why it's there**:
  ```jsonc
  { "nodeId": "decision_14", "score": 0.82,
    "why": { "seed": false, "path": ["task_3", "decision_14"], "relation": "RESOLVES",
              "components": { "relevance": 0.7, "confidence": 0.95, "freshness": 0.9, "importance": 1.4, "reputation": 1.0 } } }
  ```
  This is nearly free — the algorithm already computes every one of these numbers internally; the only change is returning them instead of discarding them. `relay graph query` (§7) prints it directly. Debugging *why a node got pulled into context* is otherwise one of the most common failure modes of memory systems, so this is treated as a first-class output, not an afterthought.

### 6.3 Ranking formula

```
finalScore = relevance × confidence × freshnessDecay × importance × agentReputation
```

- `relevance` — cosine/BM25 score from §6.2.
- `confidence` — deterministic rule stack (unchanged from v1): human-stated > strong-commitment language > agent-proposed-unconfirmed > (× 0.2 if superseded/contradicted).
- `freshnessDecay` — `exp(-decay_rate × ageInDays)`, `decay_rate` set per node type (Decision/Goal decay slowly; Task/File decay faster — finished work should stop dominating retrieval).
- `importance` — starts at `1.0`, incremented each time a `NodeAccessed` event fires (i.e. the node was actually useful enough to make it into a compiled context before) — simple frequency reinforcement, not a learned model.
- `agentReputation` — `1 − supersededRate` for the agent that authored the node, Laplace-smoothed (e.g. `(supersededCount + 1) / (totalCount + 2)`) so one early reversal doesn't tank a reputation built on few data points. Deliberately shallow — this is a tie-breaker between conflicting claims, not a trust system.

This directly resolves "Claude says Redis, Cursor says Postgres, human says Redis": the human-confirmed node wins on `confidence` alone, `agentReputation` only matters when confidence is tied.

### 6.4 Provenance: Goals and Evidence

- `Decision --SERVES--> Goal` answers "why are we doing this" without scanning history — `relay graph query --explain decision_14` walks the edge and prints the Goal text directly. **Real ingestion path** (not just schema): an explicit `- Serves: <goal text>` sub-bullet under a decision in `decisions.md`. Auto-creates the Goal node if its text doesn't already match one declared in `project.md`'s `## Goals` section, rather than silently dropping a clearly-stated intention.
- The same `Serves:` convention also attaches under a **task** bullet in `current_task.md` — one parser, two attachment points — closing what would otherwise be a real gap: Task nodes have no other edges to anything (File/Decision/Goal) by design today. Linking only happens where the convention is actually used; an un-annotated task stays an island, which is the correct default (no NLP guessing at what a task "relates to").
- `Decision --SUPPORTED_BY--> Evidence` answers "why do we believe this" via the parallel `- Evidence: <text>` sub-bullet — and because `Evidence` is its own node (not just a `sourceEventIds` pointer), it's reusable across multiple decisions and independently retrievable ("show me the benchmark that justified using Kuzu").
- Found via a relationship-recall benchmark (not a unit test) that empirically checks whether a *deliberately keyword-disjoint* query can still reach the right node via traversal alone — confirmed `SERVES` had zero real ingestion path before this was added; the materializer/traversal support existed but nothing ever set `goalId`. Same finding pattern as the Evidence gap before it.

### 6.5 Supersession & contradiction — explicit-first, narrow heuristic only

Open decision carried over from v1, resolved here: **contradiction/supersession detection defaults to explicit signals**, not general NLP:

1. **Explicit** (always on): a new decision's text references an existing decision's id, or an agent/skill calls `relay decide --supersede <id>` / `--contradicts <id>`.
2. **Narrow heuristic** (opt-in via `graph.contradictionHeuristic: true`, default `false`): only triggers on a small fixed list of antonym verb pairs against the same normalized subject — `use/avoid`, `adopt/reject`, `enable/disable` — nothing more general. A general NLP contradiction detector would need an LLM to be reliable, which contradicts the zero-API-call goal, and a bad heuristic here is actively harmful (false positives silently hide a still-valid decision). Keeping the heuristic narrow and off-by-default is a deliberate scope cut, not an oversight.

Either path emits `DecisionSuperseded`/`DecisionContradicted`, and the Context Compiler (§6.8) collapses the chain the same way regardless of which path produced the edge.

### 6.6 Multi-level retrieval without a rigid hierarchy

Rejected the literal `Workspace → Goal → Architecture → Decision → Task` containment tree from the review (see §3) because real projects aren't trees — but the underlying need ("retrieve at the right level of granularity") is real and already satisfiable with what's here:

- "Project goals" = `retrieve` filtered to `type: Goal`.
- "Architecture-level context" = `Goal`/`Decision` nodes 1 hop out, files excluded.
- "Current task context" = `working_memory.json` directly (§6.1), no retrieval needed at all.
- "Relevant files" = `File` nodes reached via `CO_EDITED`/`IMPLEMENTED_BY` traversal from the active Task.

Same effect as a level-tagged hierarchy, expressed as a traversal-depth + type-filter parameter instead of a second storage structure that has to stay in sync with the graph.

### 6.7 File co-edit graph (cheap dependency-impact, not real static analysis)

- During `ingestTimelineIntoEvents`, group `FileTouched` events by session/task window — same windowing logic the **planned** `lib/relayCollision.js` already needs (`current_task.md`) — and emit `CO_EDITED` edges between files repeatedly touched together.
- `traverse(seed=File:X, relation=CO_EDITED)` → "files historically touched alongside X." Not as precise as a real import graph, zero new tooling.
- Real import/call-graph traversal stays explicit future work (§3).

### 6.8 `backend/lib/relayContextCompiler.js` (new) — multi-resolution

Replaces the body of `buildCompileBrief`/`compileRelayContext` in `relayContext.js` (same function names/signatures — hooks, MCP, and the skill don't need updates).

- `compile(rankedOrWorkingMemoryNodes, tokenBudget)`:
  1. **Collapse supersession/contradiction chains** — `Current: <latest>` + one-line `History: A → B → C`, not three full bodies. Deterministic, no LLM. Highest-value, lowest-cost piece of this whole plan.
  2. **Emit failure triples** compactly: `Failure → caused_by → Fix`.
  3. **Drop nodes below a combined-score floor** before budget-filling.
  4. **Greedy-fill to `tokenBudget`** (`chars/4` estimate, no tokenizer dependency).
  5. **Optional LLM prose pass** if an LLM key is present (reuses `relayCompileIr.js`'s `callLlm()`); otherwise emit the structured compact form directly.
  6. **Emit a `NodeAccessed` event** for every node that made it into the output, feeding `importance` reinforcement (§6.3) for next time.
- `compile()` takes a **resolution tier**, not a single fixed budget — `tiny` (~200 tokens, served straight from `working_memory.json`, skips retrieval entirely), `small` (~800), `default` (~1800), `large` (~5000). Same graph, different compilation target picked by the calling agent/model — this is the same function called with a different number, not parallel code paths. `relay context --profile tiny|small|default|large` selects it; default profile preserved for existing callers.
- `compileForAgent(rankedNodes, agentName)` — per-agent ranking weights (Cursor weights `File`/`Task` higher; Claude weights `Decision`/`Failure` higher) — a weights table keyed by agent name, not a separate subsystem.

### 6.9 Working memory fast path

`working_memory.json` (§6.1) is the direct input to the `tiny` resolution tier — no embedding model load, no traversal, just a filter over already-materialized nodes. This matters because it's the path the **stop hook** can afford to take on every single turn-end without adding latency; the heavier `retrieve()` path is reserved for `default`/`large` profile requests where the cost is already justified.

### 6.10 Deliberately deferred

- **Reflection nodes** (periodic LLM-synthesized summaries of N raw events into one insight) — real value, but only with actual synthesis, which means an LLM call. Slot as Phase 7, gated behind `graph.llmAssist`, never required. No heuristic substitute attempted — a wrong "reflection" is worse than none.
- **Predictive/prefetch retrieval** — an optimization (latency hiding), not a correctness improvement, and needs a sequence model over edit history to do well. Left as a future-work note; not designed or scheduled here.
- **Agent reputation as a deep trust system** — implemented only as the shallow `agentReputation` multiplier in §6.3, not a standalone subsystem. A richer version (cross-project reputation, per-domain trust) is future work if the shallow version proves insufficient in practice.

## 7. CLI / surface changes

| Command | Behavior |
|---|---|
| `relay sync` | unchanged output; gains a side-effect call to `ingestTimelineIntoEvents` + `buildWorkingMemory` (behind `graph.enabled` flag, default `false` until Phase 6) |
| `relay graph rebuild` | new — recompute `nodes.json`/`edges.json`/`working_memory.json` from `events.jsonl` |
| `relay graph query "<text>" [--history] [--agent <name>] [--explain]` | new — debug/inspect retrieval; `--explain` prints the `why` block from §6.2 |
| `relay context [--profile tiny\|small\|default\|large]` | same file outputs at default profile; new profiles are additive |
| `relay compile` | same file outputs; internals route through the compiler when `graph.enabled: true` |
| MCP | add `relay_graph_query` tool alongside the existing 5 |

New `.relay/config.json` section:

```jsonc
"graph": {
  "enabled": false,                  // feature flag — flips to default true at Phase 6
  "embeddings": "local",             // "local" | "bm25" | "off"
  "tokenBudget": 1800,               // default-profile budget
  "contradictionHeuristic": false,   // narrow opt-in, §6.5
  "llmAssist": false
}
```

## 8. Integration with the existing Conductor plan

`current_task.md` and `decisions.md` already commit to building `lib/relayCollision.js` (`groupBy(path)` + overlapping windows over `memory.timeline`) for the planned Conductor/orchestration layer — the *exact same primitive* §6.7 needs for `CO_EDITED` edges. Whichever lands first implements the windowed-groupBy-by-path helper as a shared utility (`relayCollision.js` exporting `groupOverlappingEdits(timeline)`); the other consumes it. Avoids two slightly-different collision-detection implementations.

## 9. Why Node, not Python (recap)

Python would require a venv/pip step in `postinstall` (breaks the single `npm install` promise), adds interpreter startup cost on every stop-hook invocation, and isn't needed — `@huggingface/transformers` covers local embeddings and the graph is small enough that hand-rolled JS traversal beats networkx/igraph. Also matters for mergeability: a same-stack PR is realistic for a "one language, file-only" project; a second runtime likely isn't.

## 10. Phased rollout

| Phase | Deliverable | Risk if skipped |
|---|---|---|
| **0** | This doc; schema frozen (incl. Goal/Evidence types, relation vocabulary) | — |
| **1** | `relayGraph.js`: event log + materializer + `relay graph rebuild` + `buildWorkingMemory`. Flag off by default. No change to compile/context output. | none — pure addition |
| **2** | `relayRetrieve.js` with **BM25 only** + `relayContextCompiler.js` (all 4 resolution tiers, working-memory fast path, retrieval explainability) wired in behind `graph.enabled`. Side-by-side with legacy slicing. | validates ranking/compression before adding the embedding dependency |
| **3** | Local embeddings via `@huggingface/transformers`, hybrid retrieval | — |
| **4** | Full ranking formula live (confidence/freshness/importance/reputation), supersession + narrow contradiction collapsing, `failures.md` → `Failure` nodes with causal edges, Goal/Evidence ingestion from `project.md` | — |
| **5** | File co-edit graph (§6.7), shared util with `relayCollision.js` (§8) | duplicate collision-detection logic in two places |
| **6** (stretch) | Flip `graph.enabled` default to `true`; markdown IR becomes an optional generated view instead of the primary source | — |
| **7** (optional, never required) | LLM-gated reflection nodes (§6.10) | none — explicitly optional |

Each phase is independently mergeable and leaves the system in a working state — consistent with "additive, no rewrite."

## 11. Testing plan

- **Materializer**: unit tests, `events.jsonl` fixture → expected `nodes.json`/`edges.json`/`working_memory.json` (pure, deterministic, no LLM in the loop).
- **Retrieval**: golden-file tests with BM25 fallback (`query in fixture graph → expected ranked node IDs + why blocks`) — deterministic, no flakiness from a real embedding model.
- **Ranking formula**: unit tests per component (confidence rule stack, freshness decay curve, importance reinforcement after N `NodeAccessed` events, reputation smoothing with few data points).
- **Contradiction heuristic**: explicit false-positive guard tests — fixture pairs that *should not* trigger the narrow verb-pair heuristic, to keep it conservative as the verb list grows.
- **Compiler**: snapshot tests across all 4 resolution tiers; assert supersession/contradiction chains always collapse and output never exceeds budget at any tier.
- **Backward-compat**: existing hook/MCP/skill integration re-run unchanged with `graph.enabled: false` to confirm zero behavior change when the flag is off.

## 12. Open decisions

Resolved during implementation:

- [x] Default `tokenBudget` per resolution tier — shipped as `tiny: 200, small: 800, default: 1800, large: 5000` (`RESOLUTION_PROFILES` in `relayContextCompiler.js`). Validated at scale: stays within budget from 10 to 20,000 synthetic files (`scripts/benchmarkGraph.js`).
- [x] Initial contradiction verb-pair list (§6.5) — shipped narrow, exactly `use/avoid`, `adopt/reject`, `enable/disable`. Not grown since — see the boilerplate false-positive finding below for why growing it casually is risky.
- [x] Importance reinforcement constants — `IMPORTANCE_BUMP = 0.1` per `NodeAccessed` event, grows only, never decays back down. Revisit if a node's importance ends up dominating ranking purely from repeated access rather than relevance.
- [x] `@huggingface/transformers` dependency — shipped as `optionalDependency`. Verified by physically removing it from `node_modules` and confirming the full test suite (63/63 non-skipped) still passes.
- [x] Auto-rebuild on every sync — shipped as full rebuild every time (not staleness-gated). Benchmarked: 775ms at 20,000 files / ~27,000 events, sub-linear growth, no cliff found up to that scale.
- [x] **BM25 directory/path-token mis-prioritization for File nodes** — fixed via candidate (b): an independent, structural "directory-match boost" (`buildDirComponentDf`/`eligibleDirQueryTokens`/`dirMatchRatio` in `relayRetrieve.js`), not a reweighting of BM25's own statistics. A query token that exactly names one of a file's real directory path components multiplies that file's relevance by `1 + 3 × (matched eligible tokens / eligible tokens)`, gated by the same anchor-token logic as the contradiction heuristic (a directory name only counts if it isn't near-universal across the corpus, e.g. `src`/`lib`). Verified empirically before writing any code (hand-computed the exact numbers from the documented bug scenario), then confirmed via `scripts/benchmarkRelations.js`: File co-edit precision went from failing at 3 of 5 tiers to working cleanly at all 5. Caught two more issues along the way, neither in the fix itself: the benchmark's pass threshold didn't account for the already-known `CO_EDIT_MAX_WINDOW_FILES` cap, and the fixture's fixed `2026-01-01` date anchor had drifted into producing wildly uneven freshness decay as real time passed during this session — both fixed in the benchmark, not the product code.

- [x] **Branch-aware contradiction detection** — "Use Redis" on `feature/auth` and "Use Postgres" on `feature/rag` are branch-scoped truths, not a contradiction, but the heuristic had no concept of branches. Fixed: `getCurrentGitBranch()` (via `git rev-parse --abbrev-ref HEAD`, never throws — null for non-git projects) tags every Decision/Task/Goal at creation; `sameBranchScope()` gates both comparison loops in `detectContradictions`. Unknown branch info on either side never blocks (backward compatible with every decision recorded before this existed, and with non-git projects). Verified with real `git init`/`git checkout -b` integration tests, not just mocked branch strings.
- [x] **Graph analytics** (`relay graph stats`) — node/edge counts, decision reversal rate, most-referenced files (`CO_EDITED` degree), agent reputation. Almost entirely exposing computations that already existed internally (`computeAgentReputation` was built for ranking and never surfaced on its own) — no new node types, no new heuristic, no new false-positive surface.

Still open:

- [ ] `Evidence` node granularity — one node per benchmark run, or one per benchmark *type* with updated values over time? Affects whether evidence itself needs supersession edges.
- [ ] Should `relay graph rebuild`/`buildWorkingMemory` run on a staleness check instead of unconditionally on every sync? Not needed yet given the benchmark results above, but worth revisiting if a project's event log grows past what we've tested (~30k events).
- [ ] **Component/architecture grouping** — considered (per external design review) and deliberately not built as a new node type: it would repeat the exact adoption-risk pattern Task nodes already hit (schema + convention nobody reliably annotates). If a real need shows up, extend the directory-path machinery already built for the BM25 fix (`pathComponents`/`buildDirComponentDf`) instead of adding a new node type.
- [ ] **Event log archiving/GC** — same treatment as the Kuzu/backend question: real future possibility, no demonstrated need yet (benchmarked clean to ~27k events), don't build ahead of evidence.
