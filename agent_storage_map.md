# Agent Storage Map — Chat, Code Edits & Unified Timeline

_Last verified: 2026-06-14 on Windows, portfolio workspace `C:\Users\unnat\Desktop\portfolio` and OrbitOS `C:\Users\unnat\Documents\GitHub\OrbitOS`._

This document replaces earlier exploration notes. It separates **what exists on disk**, **what is possible to extract**, and **what Relay implements today**.

---

## The rule: three storage tiers

Every agent splits durable state across home dot-folders, AppData Roaming (VS Code–family), and sometimes Local caches.

| Tier | Typical paths | Holds |
|------|---------------|--------|
| **Home dot-folders** | `~/.claude`, `~/.codex`, `~/.cursor`, `~/.gemini`, `~/.copilot` | Agent-native JSONL, protobuf convos, brain UUIDs, backups, indexes |
| **AppData Roaming** | `...\Cursor`, `...\Code`, `...\Antigravity IDE` | `workspaceStorage`, `User/History`, extension `globalStorage`, `state.vscdb` |
| **AppData Local** | `...\OpenAI\Codex`, `...\github-copilot`, … | Runtimes, caches; secondary to JSONL for Codex/Copilot |

**LocalLow** had nothing agent-relevant for portfolio in this pass.

There is **no single cipher or folder** for all agents. Unified timeline = **multi-root harvest + workspace join + normalized timestamps**.

---

## Unified timeline event shape (target)

Relay normalizes everything toward:

```json
{
  "ts": "2026-06-14T05:47:21.587Z",
  "kind": "message | code_edit | checkpoint | tool",
  "role": "user | assistant",
  "source": "Claude Code | Codex | Cursor | GitHub Copilot | Antigravity",
  "content": "…",
  "file": "styles.css",
  "path": "c:\\Users\\unnat\\Desktop\\portfolio\\styles.css",
  "sessionId": "…",
  "summary": "…"
}
```

**Timestamp rules**

| Source | Timestamp field |
|--------|-----------------|
| Claude / Codex / Antigravity JSONL | ISO8601 on each line (`timestamp`, `created_at`) |
| Antigravity `conversations/*.pb` | Protobuf — timestamps inside blob (needs decoder) |
| Antigravity `code_tracker/` | File snapshot copies — likely mtime on disk |
| Copilot `transcripts/*.jsonl` | `timestamp` per event |
| Copilot `chatSessions` | Patch log — user ts from sibling transcript `session.start`; edits from `state.vscdb` `chat.ChatSessionStore.index` timing |
| VS Code Local History | Unix ms in `entries.json` → convert to ISO |
| Cursor checkpoints | `startTrackingDateUnixMilliseconds` in `metadata.json` |
| Cursor agent JSONL | **No inline ts** — use file mtime + line order, or join SQLite bubbles |
| SQLite-only blobs | Parse embedded JSON timestamps where present |

**Global merge:** flatten all agents → sort by `ts` → optional correlation (Copilot `Chat Edit: '…'`, Claude same JSONL stream, epoch ordering for Copilot edits).

---

## Portfolio workspace keys (this machine)

| Agent | Workspace link |
|--------|----------------|
| **Claude Code** | Slug: `c--Users-unnat-Desktop-portfolio` → `~/.claude/projects/c--Users-unnat-Desktop-portfolio/` |
| **Codex** | `session_meta.payload.cwd` = portfolio path |
| **Cursor** | `workspaceStorage/cfe1b3cb8edb50f028f11572c1ff26a6` (`workspace.json` → portfolio URI) |
| **Copilot (VS Code)** | Same hash under `Code/User/workspaceStorage/cfe1b3cb…` |
| **Antigravity** | Brain UUID + `.gemini` grep / jetski memento | Same `cfe1b3cb…` under `Antigravity IDE/workspaceStorage` | `aa6f638c`, `ac83ccca` (portfolio transcripts) |

OrbitOS Cursor hash: `cc95b4e7b3cdf036cc31d5744c821378`.

---

## Per-agent: chat + code edits + timeline

### Claude Code — `~/.claude/` ✅ chat native | ✅ edits native | ⚠️ Relay partial

| Path | Chat | Code edits | Timestamps |
|------|------|------------|------------|
| `projects/c--Users-unnat-Desktop-portfolio/*.jsonl` | Full user/assistant + tool records | `Edit`/`Write` + `structuredPatch` in same JSONL | ISO8601 per line |
| `file-history/<sessionId>/<hash>@vN` | — | Pre-edit **full file snapshots** | `file-history-snapshot` events in transcript |
| `sessions/`, `session-env/`, `shell-snapshots/` | — | Shell cwd/env context | Session metadata |
| `ide/*.lock` | — | Extension lock | — |

**Discovery:** path slug (`C:\…\portfolio` → `c--Users-unnat-Desktop-portfolio`) or grep handshake token.

**Backup cipher:** `sha256(absPath).slice(0,16)@vN` (Windows path, lowercase drive, backslashes). Folder = session UUID from transcript.

**Relay today:** `parseClaude.js` — **messages only**. Does not emit `code_edit` from `Edit`/`Write` or join `file-history` blobs.

**Timeline possible:** **Yes** — best native pairing (chat + before-snapshots in one JSONL + file-history).

---

### Codex — `~/.codex/` ✅ chat native | ⚠️ edits transcript-only | ⚠️ Relay chat-only

| Path | Chat | Code edits | Timestamps |
|------|------|------------|------------|
| `sessions/**/rollout-*.jsonl` | `event_msg` user/agent | `function_call`, shell, patches in JSONL | ISO8601 |
| `session_index.jsonl` | Session catalog | — | — |
| `state_*.sqlite`, `logs_*.sqlite`, `memories_*.sqlite`, `goals_*.sqlite` | UI/resume state (unparsed) | Possible tool/log detail | SQLite |
| `memories/` | Agent memory files | — | — |
| `%LocalAppData%\OpenAI\Codex\` | App runtime | Not primary transcript store | — |

**Discovery:** normalize cwd (`\` → `/`, lowercase) on first line `session_meta`.

**Relay today:** `parseCodex.js` — **user_message + agent_message only**. Tool calls not on timeline.

**Timeline possible:** **Mostly yes** — chat + patch-level edits from JSONL; no separate undo tree like Claude.

---

### Cursor — 4+ locations ✅ chat native | ✅ edits native | ❌ Relay not wired

| Path | Chat | Code edits | Timestamps |
|------|------|------------|------------|
| `%AppData%\Cursor\User\globalStorage\state.vscdb` (~363 MB) | **Primary Composer store** — `cursorDiskKV`: `bubbleId:*`, `composerData:*`, `composer.composerHeaders` | `checkpointId:*` blobs | Inside JSON blobs |
| `%AppData%\Cursor\User\workspaceStorage/<hash>/state.vscdb` | Workspace chat index, panel state | — | SQLite `ItemTable` |
| `~/.cursor/projects/c-Users-unnat-Desktop-portfolio/agent-transcripts/<uuid>/*.jsonl` | Agent-mode transcript (`role` + `message.content`) | `tool_use` in JSONL | **No per-line ts** — order + file mtime |
| `%AppData%\Cursor\User\History/<hash>/` | — | Local History snapshots | Unix ms in `entries.json` |
| `globalStorage/anysphere.cursor-commits/checkpoints/<uuid>/` | — | Multi-file Composer rollback (`files/`, `diffs/`, `metadata.json`) | `startTrackingDateUnixMilliseconds` |
| `~/.cursor/ai-tracking/ai-code-tracking.db` (~8.7 MB) | `conversation_summaries` | `ai_code_hashes`, `tracked_file_content` | SQLite (needs parser) |

**History folder cipher:** VS Code `stringHash(resourceUri).toString(16)` — **not MD5**. Use exact `resource` string from `entries.json`.

**Workspace hash:** scan `workspaceStorage/*/workspace.json` — **not derivable** from path alone (MD5 + folder birthtime).

**Relay today:** **None.** Documented in `cursor.md` / `state_report_cursor.json` only.

**Timeline possible:** **Yes**, but needs SQLite extractors (global + workspace `state.vscdb`) plus agent JSONL and checkpoint/History merge.

---

### GitHub Copilot — VS Code Roaming (not `~/.copilot`) ✅ chat native | ✅ edits native | ✅ Relay wired (2026-06-14)

`~/.copilot/session-state` is **empty** on this machine. Real data lives under **Code** `workspaceStorage` for the portfolio hash.

| Path | Chat | Code edits | Timestamps |
|------|------|------------|------------|
| `Code/.../workspaceStorage/cfe1b3cb…/chatSessions/*.jsonl` | Patch log (`kind:0/1/2`) — user text in `<userRequest>` | Tool results embedded in `requests[].result` | `creationDate` + `state.vscdb` index timing |
| `…/GitHub.copilot-chat/transcripts/<sessionId>.jsonl` | `assistant.message`, tools | — | ISO8601 per event |
| `…/chatEditingSessions/<sessionId>/state.json` + `contents/*` | — | `textEdit` ops, checkpoints, file baselines | Epoch + session timing from index |
| `…/state.vscdb` → `chat.ChatSessionStore.index` | Session titles, external sessions | — | `timing.created`, `lastRequestStarted`, `lastRequestEnded` |
| `Code/User/History/<hash>/` | — | Snapshots tagged `"Chat Edit: '…'"` | Unix ms |
| `Code/User/globalStorage/github.copilot-chat/` | Embeddings, CLI workspace refs | — | — |
| `%LocalAppData%\github-copilot\` | Cache | — | — |

**Discovery (Relay):** `discoverWorkspaceStorageDir()` → portfolio hash → parse **entire hash folder**.

**Relay today:** `parseCopilot.js` + `copilotEditingSessions.js` + `lib/vscdb.js`:

- Merges **chatSessions + transcripts** → `kind: message`
- **chatEditingSessions** → `kind: code_edit`, `kind: checkpoint`
- Timestamps from transcript `session.start` + vscdb session index

Verified on portfolio: **19 events** (10 messages, 4 code edits, 5 checkpoints) in chronological order.

**Not yet wired:** `chatEditingSessions/contents/*` blob refs for rewind; `Code/User/History` as secondary edit source.

---

### Antigravity — `~/.gemini/` + `Antigravity IDE` Roaming ⚠️

Antigravity state is **split across three layers**: Gemini home (`.gemini`), IDE Roaming (VS Code fork), and optional desktop app (`antigravity/` vs `antigravity-ide/`). Relay currently reads **one JSONL path** under `antigravity-ide/brain/` only.

---

#### Layer map: `~/.gemini/` (full folder scan, 2026-06-14)

```text
C:\Users\unnat\.gemini\
├── GEMINI.md                      # empty placeholder
├── google_accounts.json           # account metadata
├── oauth_creds.json               # OAuth tokens (sensitive)
├── installation_id                # install UUID
├── projects.json                  # slug map: abs path → project slug (2 entries on disk)
│
├── antigravity/                   # Desktop Agent Manager (34 brain UUIDs)
├── antigravity-ide/               # IDE extension brains (47 UUIDs) ← Relay AGENT_ROOT today
├── antigravity-backup/            # frozen copy of antigravity/ layout (2025-05-21)
├── antigravity-browser-profile/   # Chromium/Electron profile (NOT chat — browser caches)
│
├── config/                        # Gemini CLI / Antigravity config
│   ├── projects/*.json            # 12 project records: id, name, folderUri resources
│   ├── plugins/                   # android-cli, science skills, google-antigravity-sdk
│   ├── sidecars/
│   └── mcp_config.json
│
├── history/                       # per-project git config snapshots (2 slugs)
└── tmp/                           # mirror of history/ project dirs
```

**Parallel subfolders** (exist under both `antigravity/` and `antigravity-ide/` unless noted):

| Subfolder | Files (this machine) | Chat | Code edits | Notes |
|-----------|---------------------|------|------------|--------|
| **`brain/<uuid>/`** | 34 desktop / 47 IDE | ✅ primary | ⚠️ tools in JSONL | See brain layout below |
| **`conversations/<uuid>.pb`** | 33 desktop / 46 IDE | ✅ protobuf archive | ⚠️ likely | Same UUID as brain folder; **binary `.pb`**, not JSONL |
| **`code_tracker/active/`** | 18 files each | — | ✅ file snapshots | `active/no_repo/<md5>_<original_filename>` — copied file contents |
| **`code_tracker/history/`** | present | — | ✅ historical snapshots | Same naming scheme |
| **`browser_recordings/`** | 4976 desktop / 954 IDE | ⚠️ session recordings | — | Not transcript text |
| **`context_state/`** | 0 files | — | — | Empty on disk |
| **`knowledge/`** | dirs exist | ⚠️ RAG/knowledge | — | Needs per-project scan |
| **`prompting/`** | dirs exist | ⚠️ prompt templates | — | |
| **`implicit/`** | dirs exist | ⚠️ implicit context | — | |
| **`html_artifacts/`** | dirs exist | — | ⚠️ generated HTML | |
| **`playground/`** | dirs exist | ⚠️ scratch runs | — | |
| **`annotations/`** | 2 files (desktop only) | — | — | |
| **`bin/`** | 1 file each | — | — | Helper binary/scripts |

**Desktop-only:** `antigravity/antigravity_state.pbtxt` — onboarding flags, `installation_uuid`, selected model placeholder.

**IDE-only:** `antigravity-ide/plugins/` — extension-local plugins.

**Not agent transcripts:** `antigravity-browser-profile/` — standard Chromium tree (`Default/`, `ShaderCache/`, etc.).

---

#### Brain folder layout — `~/.gemini/antigravity-ide/brain/<uuid>/`

Typical structure (portfolio example `aa6f638c-4f01-4128-a9e4-a322da57eb04`):

```text
brain/<uuid>/
├── implementation_plan.md (+ .metadata.json)
├── task.md (+ .metadata.json)
├── walkthrough.md (+ .metadata.json)
├── browser/scratchpad_*.md
└── .system_generated/
    └── logs/transcript.jsonl      ← Relay reads this today
```

**Survey of 47 IDE brains:** 16 have `transcript.jsonl`; others may be artifact-only or WIP. Not every UUID has a transcript.

**Portfolio sessions (grep `portfolio` in transcript):**

| Brain UUID | Transcript lines | Event types (sample) |
|------------|------------------|-------------------|
| `aa6f638c-4f01-4128-a9e4-a322da57eb04` | 34 | `USER_INPUT`(3), `PLANNER_RESPONSE`(15), `CODE_ACTION`(9), `VIEW_FILE`(4), `LIST_DIRECTORY`, `KNOWLEDGE_ARTIFACTS`, `CONVERSATION_HISTORY` |
| `ac83ccca-4933-4b11-8163-18ddfdfd0426` | ~70 | Same family |

**Transcript line shape:** `{ step_index, source, type, status, created_at, content }` — `created_at` is ISO8601.

**Code-edit signals in JSONL (not separate blob store):** `CODE_ACTION`, `VIEW_FILE`, tool steps in content — narrative + patches, **not** Claude-style pre-edit files.

**Relay today:** `parseAntigravity.js` extracts `USER_INPUT` + `PLANNER_RESPONSE` only; also loads sibling `artifacts/*.md`, `tasks/*.log`, `messages/*.json`.

---

#### `conversations/*.pb` — protobuf conversation store

```text
~/.gemini/antigravity-ide/conversations/<uuid>.pb    # 46 files, 166 KB – 10 MB each
~/.gemini/antigravity/conversations/<uuid>.pb        # 33 files (desktop)
```

- Filename UUID **matches** `brain/<uuid>/` folder.
- Format: **Protocol Buffers binary** (not JSONL) — likely canonical full conversation including what JSONL summarizes.
- **Timeline possible:** yes, after protobuf schema decode.
- **Relay today:** ❌ not read.

---

#### `code_tracker/` — file content snapshots

```text
~/.gemini/antigravity-ide/code_tracker/
├── active/no_repo/<md5>_<filename>     # e.g. 5e8ab83d..._xgboost_spectral.py (38 KB)
└── history/                            # older tracked copies
```

- Appears to store **copies of edited files** keyed by content hash + original name.
- **Strong code-edit / rewind candidate** — separate from VS Code Local History.
- **Timeline possible:** yes (file mtime + hash versioning); join to brain UUID via time window or future metadata parse.
- **Relay today:** ❌ not read.

---

#### `config/projects/*.json` — workspace registry (Gemini projects)

Example record:

```json
{
  "id": "cfe9e549-7afa-40b6-a0ca-510e67927f74",
  "name": "Black Box 1 2",
  "projectResources": {
    "resources": [{ "gitFolder": { "folderUri": "file:///c%3A/Users/unnat/Desktop/ASIC/..." } }]
  }
}
```

- 12 project JSON files — maps **project UUID → folder URI(s)**.
- Root `projects.json` only lists 2 slug aliases (EEG, fermat) — partial index.
- **Use:** alternative workspace discovery path alongside brain grep.

---

#### `history/` + `tmp/` — project git snapshots

```text
~/.gemini/history/eegfeatureextraction/   # .gitconfig, .gitignore, .project_root
~/.gemini/history/fermat-ntt-convolution/
~/.gemini/tmp/                            # same slug dirs
```

- Git/environment snapshots per **project slug**, not chat.
- **No portfolio slug** on this machine.

---

#### Layer B: Antigravity IDE Roaming — `%AppData%\Antigravity IDE\User\`

Portfolio example — **same workspace hash as Code/Cursor**:

```text
C:\Users\unnat\AppData\Roaming\Antigravity IDE\User\workspaceStorage\cfe1b3cb8edb50f028f11572c1ff26a6\
  workspace.json          → file:///c:/Users/unnat/Desktop/portfolio
  state.vscdb             → SQLite ItemTable (~40 KB for portfolio)
```

**Scanned on 2026-06-14 — portfolio hash contents:**

| Path / key | Chat | Code edits | Notes |
|------------|------|------------|--------|
| `workspaceStorage/cfe1b3cb…/state.vscdb` | ⚠️ shell only | — | **No** `chatSessions/` or `chatEditingSessions/` (unlike VS Code Copilot) |
| `ItemTable` → `chat.ChatSessionStore.index` | Empty `{}` on portfolio | — | Same key as Copilot, but unused here |
| `ItemTable` → `antigravity.agentViewContainerId.state` | Panel UI state | — | Side panel layout |
| `ItemTable` → `memento/antigravity.jetskiArtifactsEditor` | — | — | **Join key**: lists open artifact URIs under `~/.gemini/antigravity-ide/brain/<uuid>/` |
| `User/History/<hash>/` | — | ✅ VS Code Local History | See **History** subsection below |
| `User/globalStorage/` | — | — | Empty on this pass |

#### C. Antigravity IDE Local History — `%AppData%\Antigravity IDE\User\History\`

Same VS Code Local History layout as Code/Cursor:

```text
History/<hash>/
  entries.json     # { resource, entries: [{ id, timestamp, source? }] }
  <opaqueId>.ext   # snapshot file per version
```

**Cipher:** `vscodeStringHash(resourceFromEntriesJson).toString(16)` — identical to Code/Cursor (e.g. portfolio `index.html` → `-6353a9ac`).

**On this machine (2026-06-14):** 9 History folders active — GoalGuard, EEGFeatureExtraction, hyperthermal, settings.json, etc. **No portfolio hash folder yet** because portfolio edits were done in **Code/Copilot** and **Cursor**, not Antigravity IDE. The folder **exists and is valid**; it will populate when Antigravity IDE saves agent-edited files for that workspace.

**Agent attribution in `entries[].source` (seen on disk):**

| Source string | Example resource |
|---------------|------------------|
| `Accept Agent changes` | EEGFeatureExtraction `template.tex` |
| `Workspace Edit` | EEGFeatureExtraction `arxiv_results.txt` |
| _(empty)_ | Manual saves |

Unlike Copilot’s `"Chat Edit: 'prompt'"`, Antigravity History labels agent work generically — still usable for **`kind: code_edit`** timeline events with Unix-ms timestamps.

**Relay today:** ❌ not scanned (shared extractor with Code/Cursor History pending).

**Timeline possible:** ✅ per-file snapshots + timestamps when workspace files were edited through Antigravity IDE.

**Important:** For portfolio, Antigravity IDE `state.vscdb` is mostly **workbench mementos** (editor layout, explorer, terminal env) — not a second transcript. Chat must still come from **`~/.gemini/.../brain/<uuid>/transcript.jsonl`**.

**Workspace → brain correlation:** `jetskiArtifactsEditor` memento paths like:

```text
file:///c:/Users/unnat/.gemini/antigravity-ide/brain/aa6f638c-4f01-4128-a9e4-a322da57eb04/implementation_plan.md
```

→ extract brain UUID `aa6f638c-…` from URI to link a Roaming workspace hash to the correct brain folder (stronger than grepping `portfolio` alone).

**Other workspace hashes on this machine** (11 total under `Antigravity IDE/workspaceStorage`): EEGFeatureExtraction, relay (`6184cba274c701fcba8470a467d82977`), portfoliotest, GoalGuard, etc. — each has `state.vscdb`; chat keys present but minimal unless a brain session was active in that IDE window.

**Discovery (recommended — multi-root):**

1. `config/projects/*.json` + root `projects.json` — match `folderUri` to workspace.
2. `Antigravity IDE/User/workspaceStorage/*/workspace.json` → same hash as Code/Cursor (`cfe1b3cb…` for portfolio).
3. `state.vscdb` → `memento/antigravity.jetskiArtifactsEditor` → brain UUID from artifact URI.
4. Grep workspace path in `antigravity-ide/brain/*/.system_generated/logs/transcript.jsonl`.
5. Join `conversations/<uuid>.pb` to brain folder by UUID.
6. Handshake token grep (existing Relay path).
7. Desktop-only fallback: `~/.gemini/antigravity/brain/` (34 UUIDs — **no portfolio matches** on this machine; portfolio is IDE-only).

**Relay today:** `parseAntigravity.js` reads **one brain JSONL** (+ artifacts/tasks). Ignores: `.pb` conversations, `code_tracker/`, IDE `History/`, `state.vscdb` joins, desktop `antigravity/brain/`.

**Timeline possible:**

| Source | Chat | Edits |
|--------|------|-------|
| `brain/.../transcript.jsonl` | ✅ ISO timestamps | ⚠️ `CODE_ACTION` / tools in stream |
| `conversations/*.pb` | ✅ likely fuller | ⚠️ after protobuf decode |
| `code_tracker/` | — | ✅ file snapshots |
| `Antigravity IDE/User/History/` | — | ✅ Local History (`Accept Agent changes`) |
| `brain/` artifacts + tasks | context | narrative / shell output |

---

## Shared VS Code layer (Cursor, Code, Antigravity IDE)

| Pattern | Chat | Code edits | Cipher / join |
|---------|------|------------|---------------|
| `%AppData%\*\User\workspaceStorage\<hash>/workspace.json` | Links hash → folder URI | — | Scan `folder` field |
| `%AppData%\*\User\workspaceStorage\<hash>/chatSessions/` | Copilot agent sessions | Edit metadata in session | Session UUID filename |
| `%AppData%\*\User\workspaceStorage\<hash>/chatEditingSessions/` | — | Copilot edit timeline + blobs | Subfolder = session UUID |
| `%AppData%\Antigravity IDE\User\History/<hash>/` | — | Local History; `Accept Agent changes` source labels | Same `vscodeStringHash` as Code/Cursor |
| `%AppData%\Code\User\History/<hash>/` | — | Per-save snapshots; Copilot `"Chat Edit: '…'"` | `vscodeStringHash(resource)` |
| `%AppData%\Cursor\User\History/<hash>/` | — | Per-save snapshots | `vscodeStringHash(resource)` |
| `%AppData%\Antigravity IDE\User\workspaceStorage\<hash>/state.vscdb` | UI mementos; brain join | — | `jetskiArtifactsEditor` → brain UUID |
| `%AppData%\Cursor\User\globalStorage/state.vscdb` | Composer chat (`cursorDiskKV`) | `checkpointId:*` blobs | Key-prefix scan |
| `anysphere.cursor-commits/checkpoints/` (Cursor only) | — | Multi-file rollback | Filter by `metadata.workspaceId` |

---

## Relay implementation status (2026-06-14)

| Agent | Chat in Relay | Code edits in Relay | Unified global timeline | Blocker |
|-------|---------------|---------------------|-------------------------|---------|
| **Claude Code** | ✅ messages | ❌ | ❌ per-agent silo only | Add `Edit`/`Write` + `file-history` extractor |
| **Codex** | ✅ messages | ❌ | ❌ | Parse tool calls from JSONL |
| **Antigravity** | ✅ + artifacts/tasks | ⚠️ JSONL tools + code_tracker + History | ❌ | `.gemini` multi-root not wired |
| **GitHub Copilot** | ✅ chatSessions + transcripts | ✅ chatEditingSessions | ❌ | History folder optional; restart server to load |
| **Cursor** | ❌ | ❌ | ❌ | SQLite + agent JSONL + checkpoints parser |

**Not implemented globally:** `memory.timeline` flatten in `syncWorkspace` (planned in `after_storing.md`); `.relay/history.md` compile.

---

## Harvest checklist (possible → Relay)

| Source | Extractor | Chat | Edits | Relay status |
|--------|-----------|------|-------|--------------|
| `~/.claude/projects/` JSONL | JSONL | ✅ | ✅ in transcript | Chat only |
| `~/.claude/file-history/` | Blob + transcript join | — | ✅ | ❌ |
| `~/.codex/sessions/` JSONL | JSONL | ✅ | ⚠️ tools | Chat only |
| `~/.codex/*.sqlite` | SQLite | ⚠️ | ⚠️ | ❌ |
| `~/.cursor/projects/*/agent-transcripts/` | JSONL | ✅ | ⚠️ tools | ❌ |
| `Cursor/.../globalStorage/state.vscdb` | SQLite `cursorDiskKV` | ✅ | ✅ | ❌ |
| `Cursor/.../workspaceStorage/.../state.vscdb` | SQLite | ✅ | — | ❌ |
| `cursor-commits/checkpoints/` | metadata + files | — | ✅ | ❌ |
| `Cursor/User/History/` | entries.json scan | — | ✅ | ❌ |
| `~/.cursor/ai-tracking/ai-code-tracking.db` | SQLite | ⚠️ | ✅ likely | ❌ |
| `Code/.../chatSessions/` | Patch fold + transcript | ✅ | ⚠️ in session | **✅** |
| `Code/.../chatEditingSessions/` | state.json | — | ✅ | **✅** |
| `Code/.../state.vscdb` session index | SQLite | metadata | timing | **✅ partial** |
| `Code/User/History/` | entries.json | — | ✅ | ❌ |
| `~/.gemini/antigravity-ide/brain/` JSONL | JSONL + grep | ✅ | ⚠️ tools | Chat + artifacts only |
| `~/.gemini/antigravity/brain/` JSONL | JSONL (desktop) | ✅ | ⚠️ | ❌ not scanned |
| `~/.gemini/*/conversations/*.pb` | Protobuf | ✅ | ⚠️ | ❌ |
| `~/.gemini/*/code_tracker/` | File snapshots | — | ✅ | ❌ |
| `~/.gemini/config/projects/*.json` | — | — | workspace join | ❌ |
| `Antigravity IDE/.../workspaceStorage/.../state.vscdb` | SQLite memento | ⚠️ join | — | ❌ |
| `Antigravity IDE/User/History/` | entries.json scan | — | ✅ | ❌ |

---

## What “full chat + full edits” can and cannot mean

**Possible from native storage (portfolio-class setup):**

- All persisted user/assistant messages across agents (with SQLite for Cursor/Copilot panel chat)
- Agent-applied file changes with at least one recoverable snapshot or patch
- Single sorted timeline after normalization

**Not possible without git or continuous capture:**

- Unapplied suggestions never accepted
- Manual edits unless Local History / git caught them
- Evicted History (`workbench.localHistory.maxFileEntries`)
- Perfect chat↔edit pairing except Claude (same JSONL) and Copilot (`Chat Edit: 'prompt'` / same session id)
- Antigravity at full file-rewind fidelity

---

## Recommended build order (updated)

1. **Global timeline flatten** in `syncWorkspace` + `normalizeTs()` (`after_storing.md`).
2. **Claude** — `Edit`/`Write` + `file-history-snapshot` → `code_edit` events with `beforeRef`.
3. **Cursor** — agent JSONL parser + global/workspace `state.vscdb` + `cursor-commits/checkpoints` + `History` scan.
4. **Codex** — tool/`function_call` lines → `code_edit` on timeline.
5. **Copilot** — wire `Code/User/History` + `chatEditingSessions/contents/` for rewind refs.
6. **Antigravity** — multi-root: `brain/` JSONL + `conversations/*.pb` + `code_tracker/` + IDE `History/` + jetski memento join + `config/projects/`.

---

## Reference ciphers (computable where they exist)

```text
VS Code History folder:  vscodeStringHash(resourceFromEntriesJson).toString(16)
Claude project slug:     path → replace non-alnum with `-`; lowercase drive letter
Claude backup blob:      sha256(absFilePath).slice(0,16) + '@v' + version
Codex session match:     normalize(cwd) on session_meta first line
Cursor/Copilot workspace hash:  scan workspaceStorage/*/workspace.json (NOT path-derived)
Cursor checkpoints:      UUID; join via metadata.workspaceId
Antigravity brain:       UUID; join via jetskiArtifactsEditor URI, config/projects folderUri, or transcript grep
Antigravity convo:       conversations/<same-uuid>.pb (protobuf)
Antigravity code_tracker:  md5(filename) snapshot copies under active/ and history/
```

---

## Bottom line

The old mental model (“five JSONL roots in `relay.js`”) is insufficient. **Copilot proved it**: the richest chat + edit data for VS Code lives under `workspaceStorage/<hash>/` (`chatSessions`, `chatEditingSessions`, `GitHub.copilot-chat`, `state.vscdb`), not `~/.copilot/session-state`.

**We are not yet sure for other agents at Copilot’s new fidelity** until each gets the same multi-folder + SQLite pass:

| Agent | Confident full chat? | Confident full edits? | Same depth as Copilot wiring? |
|-------|---------------------|----------------------|-------------------------------|
| Claude | Yes (JSONL) | Yes (file-history) | **No** — data exists, Relay not wired |
| Codex | Yes (JSONL) | Mostly (tools in JSONL) | **No** |
| Cursor | Yes (SQLite + JSONL) | Yes (History + checkpoints) | **No** |
| Copilot | Yes | Yes | **Yes** (workspace hash harvest) |
| Antigravity | Yes (JSONL + `.pb`) | Partial–Yes (code_tracker + History + JSONL tools) | **No** |

Unified chat + edits by timestamp **is possible** for portfolio; Relay today delivers **~40%** of that surface (chat-heavy for 4 agents, edit timeline for Copilot only).
