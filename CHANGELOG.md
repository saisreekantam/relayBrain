# Changelog: v1 → v2

> v1 = the original Relay: markdown-only IR, full-dump handoff. v2 = everything added in this round of work — an event-sourced memory graph with retrieval, ranking, and compression sitting underneath the same file contract. Every v1 user-facing file (`relay_context.md`, `compile_brief.md`, the CLI commands) still exists and still works exactly as before when the new system is off; v2 is additive, not a rewrite. Design rationale lives in [`docs/KNOWLEDGE_GRAPH_PLAN.md`](docs/KNOWLEDGE_GRAPH_PLAN.md).

## TL;DR

| | v1 | v2 |
|---|---|---|
| How context is selected | Dump the last N timeline events + full IR markdown | Retrieve + rank + compress to a token budget |
| Token cost for a handoff | Grows with project size, unbounded | Stays roughly flat (~120–200 tokens) regardless of project size |
| Relationships between facts | None — flat list of events | A real graph: file co-edits, decision history chains, evidence, goals |
| Works without an API key? | Yes | Yes — still zero required paid calls |
| On by default? | N/A | Yes, opt-out via `graph.enabled: false` |
| Validated how | Manual use | 85 automated tests + synthetic stress tests (10 → 20,000 files) + a real project + a real cross-agent (Copilot) handoff test |

## New: the memory graph (event-sourced, on by default)

- **`backend/lib/relayGraph.js`** — `.relay/graph/events.jsonl` is now the source of truth: an append-only log of typed events (`FileTouched`, `TaskCreated`, `DecisionCreated`, `DecisionSuperseded`, `DecisionContradicted`, `EvidenceRecorded`, `FailureObserved`, `NodeLinked`, `NodeAccessed`...). `nodes.json`/`edges.json`/`working_memory.json` are materialized views, rebuilt by a pure function — never hand-edited, always reconstructible from the log.
- **New entity types**: `File`, `Task`, `Decision`, `Goal`, `Evidence`, `Failure` — each with `status`, `confidence`, `importance`, `decay_rate`, `last_verified`.
- **Real relationships, not just a flat timeline**:
  - `CO_EDITED` — files touched in the same session, via gap-based time windowing (capped per window to stay cheap).
  - `SUPERSEDES` / `CONTRADICTS` — decision history chains, from explicit signals or a narrow opt-in heuristic (off by default).
  - `SERVES` — Decision *or* Task → Goal, via an explicit `- Serves: <goal text>` sub-bullet convention (auto-creates the Goal if it isn't already declared in `project.md`).
  - `SUPPORTED_BY` — Decision → Evidence, via the parallel `- Evidence: <text>` sub-bullet convention.
- **Failures that say "fixed" in their own text** (`isFailureSelfResolved`) are excluded from the active-blockers view automatically — a narrow keyword heuristic with an explicit negation guard (`"unresolved"` is correctly never mistaken for `"resolved"`).
- **On by default since this round** (opt-out, not opt-in): absence of a `graph` block in `config.json` now means *enabled* — every project that ran `relay init` before this existed gets it automatically, no migration step.

## New: retrieval and ranking (`backend/lib/relayRetrieve.js`)

- BM25 relevance + graph traversal (1–2 hop), blended with **confidence × freshness × importance × agent-reputation** — not just keyword match.
- **Full explainability**: every retrieved node carries a `why` block (seed match vs. traversal path + relation + the exact score components) — `relay graph query --explain`.
- **Optional local embeddings** (Phase 3): `@huggingface/transformers` running `all-MiniLM-L6-v2` fully offline, shipped as an `optionalDependency` (not a hard dependency — `npm install` never fails because of it). Blended with BM25 only when a precomputed query embedding is supplied; otherwise behaves identically to BM25-only. Verified by physically removing the package and confirming the full suite still passes.
- **No query text no longer means no results** — ranks by confidence/freshness/importance instead of collapsing to empty, which matters because it's what the plain `relay context` (no flags) call actually does.

## New: the Context Compiler (`backend/lib/relayContextCompiler.js`)

- **Four resolution tiers** — `tiny` (~200 tokens, reads `working_memory.json` directly, no retrieval/embedding at all — cheap enough for a stop hook on every turn), `small` (~800), `default` (~1800), `large` (~5000). Same compiler, different budget.
- **Supersession/contradiction chains collapse to one block**: `Current: X` + a compact `History: A → B → (current)` line, instead of dumping every historical version in full.
- **Per-agent ranking weights** (Cursor favors File/Task, Claude favors Decision/Failure) — one weights table, not separate code paths.

## Measured results (not asserted — benchmarked)

- Token reduction vs. the v1 full-dump, **at every project size from 10 to 20,000 synthetic files**: 66% (tiny) → 91% → 94% → 98% → 99.4% → 99.7% (extreme). The gap *widens* as the project grows, not just holds steady.
- Sync/rebuild time stays sub-linear: 5ms at 10 files, 775ms at 20,000 files (~27,000 events) — no quadratic blowup found.
- Both benchmark scripts are committed and re-runnable: `backend/scripts/benchmarkGraph.js` (speed/disk/tokens) and `backend/scripts/benchmarkRelations.js` (relationship recall/precision specifically).

## Bugs found and fixed during this work (via testing, not assumed correct)

1. **Sort tie-break on timestamp collisions** — a `TaskStatusChanged` event could be processed before the `TaskCreated` it depended on; fixed with a stable sort on original log position.
2. **`events.jsonl` grew unboundedly** — `memory.json`'s timeline is full history every sync, not a delta; every `FileTouched` was being re-appended on every single sync. Fixed with a signature-based dedup set.
3. **Co-edit windowing broke idempotency at scale** — a fixed-count slice (`last 50 touches`) cut session windows in a different place on every sync, producing "new" edges that weren't actually new. Fixed with gap-based trailing-window detection instead of a fixed count.
4. **Contradiction heuristic false-positived on templated text** — 10 decisions sharing a boilerplate phrase ("Use a dedicated queue for the X subsystem") cross-matched each other. Fixed by requiring a shared "anchor" token that isn't near-universal across the comparison corpus, gated off for small comparison pools where that signal isn't meaningful.
5. **History-line duplication** — the supersession-chain summary repeated the current decision's text twice (once as "current," once again at the end of the history arrow chain), which could make the "collapsed" block *larger* than dumping every version. Fixed by excluding the head from the history line and tightening truncation.
6. **File search text was basename-only** — `utils.js` in two different directories were indistinguishable to BM25. Fixed by searching the full path; found via a relationship-recall benchmark, not a unit test.
7. **Checkbox-placeholder regex backtracking** — a bare, never-edited `- [ ]` line (the literal scaffold every fresh `relay init` ships) was captured as a decision literally named `"[ ]"`. Found on a real project, not a synthetic fixture — none of the synthetic tests used the unedited scaffold text. Affected every untouched project. Fixed by stripping the checkbox deterministically instead of relying on regex backtracking.
8. **Same-batch contradictions were invisible** — two contradicting decisions added in the *same* sync (both already in `decisions.md` before `relay` ever ran) were never compared to each other, only to pre-existing nodes. Fixed by also comparing within the new batch.

## Real-world validation (not just synthetic benchmarks)

- Deployed to an actual project (`multi-agent-demo`, a SIGDIAL 2026 research demo) — added a real feature (an About page), ran the real pipeline, and that's how bug #7 above was found.
- Tested actual cross-agent handoff: had GitHub Copilot read the generated `relay_context.md` and answer questions whose answers exist *only* in cross-session conversation history (a stale-venv fix, a past request to remove the agent tooling) with zero trace in git or any file. Copilot reproduced a verbatim quote — including a typo — and an exact timestamp, which is only possible if it actually used the handoff.
- Caught and corrected our own confounded test along the way (a "which files are related" question that `git status` could answer without relay at all) — documented as a methodology lesson, not hidden.

## Testing

- **0 → 85 automated tests** (87 total, 2 gated behind `RELAY_TEST_LIVE_EMBEDDINGS=1` since they need network/model access), using Node's built-in `node:test` — no new test-framework dependency.
- Coverage includes false-positive guards for every heuristic (contradiction detection, failure self-resolution), idempotency checks at every scale tier, and dedicated regression tests for every bug above.

## CLI additions

```
relay graph rebuild [path]                  # ingest + materialize the graph
relay graph query "<text>" [path]           # debug retrieval directly
  [--explain] [--history] [--agent <name>] [--embed]
relay graph embed [path] [--force]          # (re)compute the local embedding cache
relay context [path] --profile tiny|small|default|large
relay context [path] --query "<text>"       # focus the handoff on a specific question
```

## What did NOT change

- The v1 file contract: `relay_context.md`, `compile_brief.md`, hook scripts, MCP tools, the Cursor skill — same filenames, same consumers, unchanged when `graph.enabled: false`.
- Zero required external services. No database server, no required LLM API key, no required network access. The embeddings package is optional and the whole system degrades gracefully without it.
- Single language, single runtime (Node) — no Python, no second toolchain.

## Deliberately not done (and why)

- **LLM-gated "reflection" nodes** (periodic AI-synthesized insights across many past sessions) — would be the one feature that costs real API money, and there's no demonstrated case yet where retrieval + ranking + compression weren't already enough. Revisit only if that changes.
- **A real code dependency graph** (parsing actual imports/call graphs) — different engineering effort than mining agent transcripts; the file co-edit graph is the cheap stand-in, by design.
- **An optional embedded graph database (Kuzu) / LLM-assisted relationship suggestion** — real, scoped next steps, intentionally deferred to keep this round's scope to what's tested and proven.

## v2.1 — the directory-aware BM25 fix (closing the gap above)

- **Fixed**: File-node retrieval could rank a wrong-directory file above a right-directory one when filenames repeat across directories (`index.js`/`utils.js`/`file0.js`...). Not fixed by reweighting BM25's own statistics (the contradiction-heuristic mistake taught us that's fragile) — fixed by adding an independent, structural signal: does a query token exactly name one of a file's real directory path components? Gated by the same anchor-token logic as the contradiction heuristic, so a near-universal directory name (`src`, `lib`) can't inflate everything uniformly and pass as a meaningful signal.
- Verified analytically (hand-computed against the exact documented bug numbers) *before* writing code, then empirically: `scripts/benchmarkRelations.js`'s file co-edit precision test went from failing at 3 of 5 size tiers to passing cleanly at all 5.
- Two more issues surfaced and fixed along the way, both in the *benchmark*, not the product: a pass threshold that didn't account for the already-known, already-accepted co-edit window cap, and a fixed calendar-date anchor in synthetic test data that had drifted into producing wildly uneven freshness decay as real time passed during this build — a reminder that synthetic fixtures need to anchor relative to "now," not a hardcoded date.
- 8 new tests, including an explicit no-regression check that plain filename queries (no real directory mentioned) are byte-for-byte unaffected.

## v2.2 — branch-awareness and graph analytics

- **Branch-aware contradiction detection.** "Use Redis" on `feature/auth` and "Use Postgres" on `feature/rag` are branch-scoped truths, not a contradiction — but the heuristic had no concept of git branches at all until now. `getCurrentGitBranch()` tags every Decision/Task/Goal with the actual current branch at ingestion time; the contradiction heuristic skips comparisons across a known, differing branch. Unknown branch info (non-git projects, or data recorded before this existed) never blocks — fully backward compatible. Verified with real `git init`/`git checkout -b` integration tests, not mocked branch strings.
- **`relay graph stats`** — node/edge counts, decision reversal rate, most-referenced files (by `CO_EDITED` degree), and agent reputation, as a single report (`--json` for machine-readable output). Almost entirely surfacing computations that already existed internally for ranking purposes and were never exposed on their own — no new node types, no new heuristic, no new false-positive surface.
- Both validated against this repo's own real `.relay/` data, not just synthetic fixtures: branch detection correctly returned `main`; the stats report surfaced real cross-machine collaboration history (a collaborator's Windows file paths) from this project's actual development history.
- Considered and explicitly declined, per external design review: a new `Component`/architecture node type (would repeat the Task-node adoption-risk pattern — schema and convention nobody reliably annotates) and event-log archiving/GC (no demonstrated need yet at the scale already benchmarked). Both recorded as open, not built ahead of evidence.

## v2.3 — real-repo validation (OpenHands) and a Decision/Goal/Evidence/Failure benchmark

- **Validated the directory-match boost on a real, large, unrelated open-source repo** (OpenHands, 2,434 files) instead of only synthetic fixtures. It organically has the exact pattern the fix targets — `resolver.py`/`base.py`/`branches.py` repeated across 6 real git-provider integrations (GitHub, GitLab, Bitbucket, Azure DevOps, Forgejo, Bitbucket Data Center). A query for GitLab's `resolver.py` correctly ranked all 5 of its real co-edited siblings above GitHub's identically-named file.
- **`scripts/benchmarkMemoryCorpus.js`** — the first benchmark testing Decision/Goal/Evidence/Failure retrieval and the Context Compiler, not just File/`CO_EDITED`. The corpus is hand-authored (architecturally inspired by exploring OpenHands' real structure — sandbox containers, multi-provider integrations, microagents, the enterprise/open-source split — but explicitly NOT extracted from it and never written into a real OpenHands clone's `.relay/`; see the script header). 11 labeled positive queries + 1 negative control, scored with Recall@5 and MRR against the real `retrieve()`/`compileForResolution()` functions.
- Building that benchmark surfaced four more real, fixed issues:
  - **No explicit way to mark "B supersedes A" existed** — only the narrow heuristic did, and it doesn't catch phrasing like "switched from a single shared container to per-conversation isolated ones" (no antonym pair). Added `relay decide supersede|contradict "<old>" "<new>"`, reusing materializer logic that already existed and was already tested.
  - **That command's first version had a real bug**: a resolved decision's stored text always includes its date prefix internally, so requiring an exact text match silently created an event pointing at a node that doesn't exist. Caught by an actual CLI smoke test. Fixed with `resolveDecisionRef` — exact match first, substring fallback, reports ambiguity instead of guessing.
  - **`node.type` was part of the BM25 search text** — so any query containing a word like "goal" gave every Goal node a free match, diluting genuinely relevant ones. Removed (kept `node.kind`, which is a narrow per-node value, not a type-wide label).
  - **A single rare, incidental word match could score deceptively high** — "What blockchain integration does this project have?" scored 0.6 confidence purely from the word "integration" appearing in one unrelated task. Added a query-coverage discount (fraction of distinct query terms actually present in the node's text), applied only to the lexical signal, never to embedding similarity.
  - Also fixed, while verifying the supersession command: a dated history entry's date prefix was eating most of the compiled chain-summary's truncation budget before any real content appeared.
- Final state: 100% Recall@5 across the 11 positive queries, MRR 0.624 (honestly lower than 1.0 — one query's answer is correctly collapsed into a compact history pointer by design, not separately ranked, which the benchmark accounts for rather than treats as a miss), negative control correctly low-confidence. Re-verified `scripts/benchmarkRelations.js` still passes at all 5 tiers after these changes — the type-search and coverage fixes didn't undo the earlier directory-match fix.
- 4 new unit tests for `resolveDecisionRef`, 1 for the date-prefix display fix. 113 tests total (111 passing + 2 live-gated).
