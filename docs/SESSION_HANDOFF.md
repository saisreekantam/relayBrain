# Session handoff — relayBrain knowledge-graph work

Paste this file (or just point to it) at the start of a new chat to resume with full context. It's a navigation aid, not a duplicate of the detailed docs — those are linked below and are the source of truth for design rationale and full history.

## What this project is

`relayBrain` (npm package: `relay`) gives Cursor/Claude Code/Copilot/Codex/Antigravity shared cross-tool project memory via a `.relay/` directory. v1 was markdown-only IR with full-dump handoff. This session's work (v2, in progress) added an event-sourced knowledge graph underneath the same file contract — additive, not a rewrite, opt-out not opt-in.

**Read these first, in order:**
1. [`docs/KNOWLEDGE_GRAPH_PLAN.md`](KNOWLEDGE_GRAPH_PLAN.md) — the design doc. §12 "Open decisions" has a running log of every fix this session, each marked `[x]` resolved with implementation notes, or `[ ]` still open with the reasoning for why it's not built yet.
2. [`../CHANGELOG.md`](../CHANGELOG.md) — v1→v2 changes, organized as v2 (initial), v2.1, v2.2, v2.3 (most recent). Each section: what broke, why, how it was verified.

## Design philosophy (durable constraints — don't relitigate these)

- Single runtime: Node/JS only, no Python, no server, no required database, no required paid API calls.
- Narrow, explicit heuristics over general NLP or LLM-based extraction (contradiction detection, failure self-resolution, supersession all use fixed rules, not inference).
- Explicit markdown conventions (`- Serves: <goal>`, `- Evidence: <text>`) over auto-extracting structure from arbitrary prose — auto-extraction was explicitly rejected as scope creep (would need either an LLM call or fragile general-NLP, violating both constraints above).
- Six node types only: File, Task, Decision, Goal, Evidence, Failure. A `Component`/architecture node type was explicitly considered and declined (would repeat the Task-node adoption-risk pattern: schema + convention nobody reliably annotates).
- Additive only: every v1 file/CLI command still works unchanged when `graph.enabled: false`.
- `node:test` (Node's built-in runner) only — no new test-framework dependency.

## Current state (as of this handoff)

113 tests, 111 passing, 2 skipped (gated behind `RELAY_TEST_LIVE_EMBEDDINGS=1`, need network/model access).

**Uncommitted changes** (nothing has been committed since `9f429f7`, the v2 base commit which is already pushed to `origin` — the user's own fork, `github.com/saisreekantam/relayBrain.git`, safe to push to, distinct from the original upstream they forked from):
- `backend/lib/relayRetrieve.js` — `node.type` removed from BM25 search text; new `queryCoverageRatio()` discount.
- `backend/lib/relayGraph.js` — new `resolveDecisionRef()` (exact match → substring fallback → reports ambiguity, never guesses).
- `backend/lib/relayContextCompiler.js` — history-line date-prefix stripped before truncation (`stripDatePrefixForDisplay`).
- `bin/relay.js` — new `relay decide supersede|contradict "<old text>" "<new text>" [path]` command.
- `backend/scripts/benchmarkMemoryCorpus.js` (new, untracked) — Decision/Goal/Evidence/Failure retrieval benchmark. **Important**: its corpus is hand-authored by Claude, architecturally inspired by exploring the real OpenHands repo structure (sandbox containers, multi-provider git integrations, microagents, enterprise split) but explicitly NOT extracted from OpenHands' real decisions/commits, and it never touches a real OpenHands clone's `.relay/` — runs entirely in its own disposable `fs.mkdtempSync` workspace. This distinction is load-bearing — the user was explicit: *"treat it as a benchmark corpus, not as OpenHands data."*
- `backend/test/relayGraphIngestion.test.js`, `backend/test/relayContextCompiler.test.js` — new regression tests for the above.
- `docs/KNOWLEDGE_GRAPH_PLAN.md`, `CHANGELOG.md` — updated with all of the above.
- `relay.code-workspace` (untracked, unrelated editor artifact — not part of this work).

**Latest benchmark result** (`node backend/scripts/benchmarkMemoryCorpus.js`): 100% Recall@5 across 11 hand-labeled positive queries, MRR 0.624, 1/1 negative control correctly low-confidence. `backend/scripts/benchmarkRelations.js` re-verified clean at all 5 size tiers after these changes.

## Standing instructions (apply to any future work in this repo)

- **Git**: only commit when explicitly asked; only push when explicitly asked; never force-push or other destructive git ops without explicit authorization. `origin` is the user's own fork — pushing there is safe and doesn't touch the original upstream they forked from.
- **Testing discipline**: verify before claiming fixed, verify after, explicitly check for regressions in the *opposite* direction — this session had a real incident where a first-attempt fix (Jaccard → overlap coefficient for the contradiction heuristic) made the original bug worse, not better. Always re-run the full suite plus the relevant benchmark script after any retrieval/ranking change.
- **Real bug vs. benchmark-fixture bug**: when a benchmark fails, check whether the *benchmark's* fixture/threshold/date-anchor is wrong before assuming the product code is wrong. This happened multiple times (stale hardcoded calendar dates, a co-edit window cap mismatch) — fix the fixture, not the product, when the fixture is actually at fault.
- **OpenHands clone** at `/tmp/openhands-relay-test` (shallow clone, 2,434 files) was used earlier for real-world directory-match-boost validation using real paths. Left in place; not yet cleaned up; the user hasn't said whether to delete it.

## Pending / not yet done

- `queryCoverageRatio` is not yet exported from `relayRetrieve.js`'s `module.exports` (every other helper added this session was exported for direct testability — this one wasn't, only indirectly tested via `retrieve()`).
- Decide whether to delete `/tmp/openhands-relay-test`.
- Eventually commit + push this body of work — only on explicit request.
