# What's Missing — Full Component Spec
## For: DevSecOps / Orbit OS Mission Control UI

---

## The Core Problem With the Current Screenshot

The current UI is **Discord with a reasoning card.** That's it. A Slack-style sidebar, a chat feed, 4 agent cards on the right. The vibe is "team communication tool" not "autonomous AI operating system." 

The doc you have describes something between Datadog, Vercel, Linear, and a NASA control room. You're at 10% of that. Here's every missing piece, categorized brutally.

---

## 1. THE LAYOUT IS WRONG

Current layout: `[nav sidebar] [chat feed] [agent list]`  
Target layout: `[agent swarm / graph] [execution center] [context / memory]` with a persistent infrastructure bar at the bottom.

The chat feed as the centerpiece kills the illusion. Chat = human product. An AI OS doesn't have a "feed" — it has an **execution graph** and a **live state board**.

**Fix: Ditch the chat-first layout entirely.** The main viewport should be the execution/graph view. A collapsible log stream is secondary, not primary.

```
┌─────────────────────────────────────────────────────────────────┐
│  ORBIT OS    [Project: Secure SaaS]    [Global Status]  ●LIVE   │
├────────────┬───────────────────────────────┬────────────────────┤
│            │                               │                    │
│  AGENT     │    EXECUTION CENTER           │  CONTEXT /         │
│  SWARM     │    (graph + active task)      │  MEMORY BANK       │
│            │                               │                    │
│            │                               │                    │
├────────────┼───────────────────────────────┼────────────────────┤
│            │                               │                    │
│  TASK      │    LOG STREAM / TIMELINE      │  SECURITY OPS      │
│  QUEUE     │                               │                    │
│            │                               │                    │
├────────────┴───────────────────────────────┴────────────────────┤
│           INFRASTRUCTURE LAYER  (containers, DB, cache, CDN)    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. MISSING: AGENT DEPENDENCY GRAPH (biggest gap)

This is the #1 thing that makes it look like an OS vs a chat tool. Currently: a flat list of 4 cards.

**What it should be:**

An animated SVG/canvas node graph. Each agent is a node. Edges show task delegation flow. When a task moves from Backend → QA → Security → Deployment, the edge lights up with a traveling pulse animation.

**Node states (color-coded):**
- `IDLE` → dim, grey ring
- `THINKING` → soft blue pulse animation
- `EXECUTING` → green with spinning arc border
- `BLOCKED` → amber, static
- `ERROR` → red pulse
- `REVIEWING` → purple

**Node click → drawer opens showing:**
- Current goal
- Last 3 decisions with confidence %
- Memory usage (tokens used / context window)
- Dependencies (which agents it's waiting on / delegating to)
- Tool calls in progress (e.g., `write_file`, `run_tests`, `git_commit`)

**Gimmick version (no real backend):** Nodes animate on a timer with fake state transitions. CEO → Architect lights up, then Architect → Backend, etc. Looks completely alive.

**Tech: D3-force layout or react-flow with custom nodes.**

---

## 3. MISSING: REAL EXECUTION CENTER

Current: nothing. The "Execution Plan" in the bottom right is a label with no content.

**What it needs to show:**

```
┌─────────────────────────────────────────────┐
│  CURRENT OBJECTIVE                          │
│  Build Secure SaaS Landing Page             │
│                                             │
│  ████████████░░░░  72%                      │
│                                             │
│  CURRENT PHASE    Security Validation       │
│  ACTIVE AGENT     Security Agent            │
│  STARTED          2m 14s ago                │
│  ETA              ~4m                       │
│                                             │
│  SUB-TASKS                                  │
│  ✓ Architecture designed                    │
│  ✓ API endpoints generated                  │
│  ✓ Unit tests passed (47/47)                │
│  ⟳ CVE scan in progress...                  │
│  ○ Deployment pending                       │
│  ○ Smoke tests pending                      │
└─────────────────────────────────────────────┘
```

**Phase progress bar** should pulse/animate when active. Sub-tasks tick off in real time (fake timer is fine).

---

## 4. MISSING: LOG STREAM (Vercel-style, not chat-style)

Current: A Discord chat feed. This is the wrong abstraction entirely.

**What Vercel's build logs look like** is what you want — monospace, timestamped, color-coded by log level, auto-scrolling with a "pause" button.

```
[14:03:22]  ● CEO         Objective dispatched → Architect
[14:03:24]  ● Architect   Analyzing system requirements...
[14:03:31]  ● Architect   Decision: microservice arch (confidence 91%)
[14:03:33]  → Backend     Task received: generate REST API scaffold
[14:03:44]  ● Backend     Generated 12 endpoints
[14:03:45]  → QA          Task received: test coverage
[14:03:52]  ✓ QA          47/47 tests passed
[14:03:53]  → Security    Task received: CVE scan
[14:04:01]  ⚠ Security    Found: outdated OpenSSL (CVE-2024-0553)
[14:04:02]  ● Security    Auto-patching...
[14:04:08]  ✓ Security    Patch applied, re-scanning
[14:04:11]  ✓ Security    Clean. Clearance granted.
[14:04:12]  → Deployment  Task received: canary deploy
```

**Color coding:**
- `●` agent action → blue/purple
- `→` handoff → cyan  
- `✓` success → green
- `⚠` warning → amber
- `✗` error → red

**Features needed:**
- Auto-scroll toggle
- Log level filter (ALL / DECISIONS / ERRORS / HANDOFFS)
- Copy raw log button
- Timestamp toggle (relative vs absolute)
- "Jump to live" button when scrolled up

---

## 5. MISSING: DECISION CENTER

One of the highest-signal UI pieces. Currently: zero.

A dedicated panel (or modal / right drawer) that shows the AI's decision history like a structured audit log.

```
┌──────────────────────────────────────────┐
│  DECISION #47                  14:03:31  │
│  Agent: Architect                        │
│                                          │
│  PROBLEM                                 │
│  Choose service architecture             │
│                                          │
│  OPTIONS CONSIDERED                      │
│  A. Monolith          score: 34%         │
│  B. Microservices     score: 91% ← CHOSEN│
│  C. Serverless        score: 67%         │
│                                          │
│  REASONING                               │
│  Expected user load > 100k. Monolith     │
│  creates single point of failure.        │
│  Serverless cold-start latency too high  │
│  for real-time features.                 │
│                                          │
│  CONFIDENCE   91%   ████████████░░       │
└──────────────────────────────────────────┘
```

Can be a scrollable list of decision cards. Clickable to expand. This alone makes the system feel like it's actually reasoning, not just typing.

---

## 6. MISSING: MEMORY BANK PANEL

Current: nothing. Right panel is just 4 agent cards.

**Two sections:**

**Global Memory** (project-level)
```
/memory
├── /project
│     preferred_stack: NextJS + Postgres
│     environment: production
│     deploy_strategy: blue-green
│     last_deploy: 14:04:12
├── /constraints
│     no_vendor_lock_in: true
│     max_latency_p99: 200ms
└── /user_prefs
      code_style: functional, no classes
      test_coverage_min: 80%
```

**Agent Memory** (per-agent)
```
Security Agent Memory
├── past_vulns: [CVE-2024-0553, CVE-2023-1234]
├── blocked_ips: [192.168.1.x range]
├── scan_history: 12 scans this session
└── trust_score: API Gateway 98%, DB 94%
```

Render this as a file-tree component. Expandable nodes. Clicking a key shows the value and when it was last written. Optional: tiny "last modified" timestamp on each leaf.

---

## 7. MISSING: SECURITY OPS CENTER

Currently: nothing. This is supposed to be a DevSecOps tool.

**Threat level indicator** (top of security panel):
```
THREAT LEVEL    ● LOW
Attack Surface  API Gateway ✓  DB ✓  Containers ✓  Deps ⚠
```

**Live vulnerability cards:**
```
┌─────────────────────────────┐
│ ⚠ MEDIUM                   │
│ OpenSSL 3.0.1               │
│ CVE-2024-0553               │
│                             │
│ Affected: api-container     │
│ Patch: 3.0.2 available      │
│                             │
│ [Auto-Patch]  [Dismiss]     │
└─────────────────────────────┘
```

**Compliance status strip:**
```
SOC2  ● PASS    OWASP Top 10  ⚠ 1 WARN    GDPR  ● PASS
```

---

## 8. MISSING: INFRASTRUCTURE LAYER

Bottom bar. Currently: nothing.

Looks like a mini Kubernetes/Vercel deployment view.

```
PRODUCTION ENVIRONMENT                                    ↑ All Systems Nominal

[app-container-1 ●]  [app-container-2 ●]  [postgres ●]  [redis ●]  [cdn ●]  [gateway ●]

CPU  34%  ████░░░░░░    MEM  61%  ██████░░░░    LATENCY  p99: 142ms    UPTIME  99.97%
```

Each container is a clickable pill. Click → tooltip with CPU/mem/restart count/last deploy sha.

---

## 9. MISSING: TASK QUEUE

Left sidebar currently is just project list and nav links.

Needs a **task queue view:**
```
TASK QUEUE                           [4 pending]

⟳ ACTIVE
  CVE patch verification
  Security Agent  •  ~2m left

⏳ QUEUED
  Canary deployment (10%)
  Deployment Agent

  Smoke test suite
  QA Agent

  Notify stakeholders
  CEO Agent

✓ COMPLETED TODAY  (12)
```

Visual priority indicators. Drag to reorder (gimmick, doesn't need to work). Expand to see sub-steps.

---

## 10. MISSING: GLOBAL HEADER WITH REAL STATUS

Current header: just a title and "SYSTEM ONLINE".

**What it should have:**
```
[ORBIT OS logo]  Secure SaaS  ▼    [●LIVE]  [Pause]  [Step]    Tokens: 142k  Cost: $0.34    [Settings]
```

- Project switcher dropdown
- **Play / Pause / Step** controls (makes it feel like you can control execution)
- Global token counter + estimated cost (huge psychological signal — makes it look real)
- Session timer
- Emergency STOP button (red, right side)

---

## 11. VISUAL / POLISH GAPS

Things making it look "noob" beyond missing components:

**Typography**
- Body font is system default. Use `JetBrains Mono` for logs/code/agent outputs, `Inter` for UI chrome.
- Label hierarchy is flat — everything looks the same size. Section labels (ACTIVE AGENTS, EXECUTION PLAN) should be `10px uppercase tracking-widest opacity-50`, not `14px regular`.

**Color system is weak**
- Right now: `#1a1a1a` background, some gradients on agent cards. That's it.
- Need: a proper semantic color system.
  - `--color-idle` → `#4a4a5e`
  - `--color-active` → `#3b82f6`
  - `--color-success` → `#22c55e`
  - `--color-warning` → `#f59e0b`
  - `--color-critical` → `#ef4444`
  - `--color-surface-1` → `#0d0d14`
  - `--color-surface-2` → `#12121f`
  - `--color-surface-3` → `#1a1a2e`
  - `--color-border` → `#ffffff0d`

**Glassmorphism is absent**
- Cards are just `background: #1e1e1e`. Should be `backdrop-filter: blur(12px)` with `background: rgba(255,255,255,0.04)` and `border: 1px solid rgba(255,255,255,0.08)`.

**Animations are absent**
- Agent status dots are static. They should pulse.
- DEPLOYING status on Deployment Agent should have a spinner or traveling bar.
- Log stream should auto-scroll.
- Progress bars should animate width on mount.
- Node graph edges should have traveling light dots.

**Agent cards are toy-sized**
- 4 cards is not a swarm. Show 8–12 agents, with most in IDLE/STANDBY dim state. Only 1-2 should be actively pulsing. The contrast between idle and active agents is the whole visual story.

**No data density**
- Palantir, Datadog, Linear all have HIGH information density. They're not sparse. Right now 70% of the screen is whitespace or a chat feed. Fill it with data.

---

## 12. CODEX-SPECIFIC MISSING PIECES

Since you want Codex (code execution / solve) vibes:

**Code Diff View** — when Backend Agent generates code, show a mini diff view inline in the log:
```diff
- const db = require('pg')
+ import { Pool } from 'pg'
+ const pool = new Pool({ ssl: { rejectUnauthorized: false } })
```

**File Tree Output** — when Architect designs structure, show it as a file tree:
```
/api
├── /routes
│     ├── auth.ts  ✓ generated
│     ├── users.ts ✓ generated  
│     └── metrics.ts ⟳ generating...
├── /middleware
│     └── rateLimit.ts ✓
└── /tests
      └── auth.test.ts ⟳ pending
```

**Test Run Output** — QA Agent should show this, not just "passed":
```
● auth.test.ts
  ✓ should register user (23ms)
  ✓ should reject duplicate email (8ms)
  ✓ should return JWT on login (12ms)

● metrics.test.ts
  ✓ should return 200 (4ms)
  ✗ should handle empty dataset — TypeError: Cannot read property 'map'
```

**Terminal-style agent output block** — monospace, dark, with a blinking cursor when active. Not a styled chat bubble.

---

## BUILD PRIORITY ORDER

If you're building this as a gimmick/demo first:

1. **Fix the layout** — 3-column grid, remove chat-first, add infra bar
2. **Agent graph** — even a static one with fake pulse animations
3. **Log stream** — replace chat with a monospace auto-scrolling log
4. **Execution center** — progress bar + phase + subtask checklist
5. **Global header** — add token counter, play/pause, stop button
6. **Typography + color system** — biggest bang-for-buck visual fix
7. **Decision cards** — structured reasoning display
8. **Infrastructure bar** — container pills with health dots
9. **Memory bank** — file-tree component
10. **Security panel** — threat level + vuln cards
11. **Code diff / file tree in logs** — Codex feel
12. **Task queue** — left panel redesign

---

## REFERENCE SCREENSHOTS TO STEAL FROM

| Product | What to steal |
|---|---|
| **Vercel** | Build log stream, deployment status pills, infra map |
| **Datadog** | Service map (agent graph), metric cards, alert severity |
| **Linear** | Task queue design, typography, keyboard-first density |
| **Palantir Gotham** | Data density, dark color system, structured object cards |
| **GitHub Actions** | Job dependency graph, step checklist, log output |
| **OpenAI Codex** | Code diff output, file generation view, terminal blocks |
| **Grafana** | Time-series panels, threshold alerts, dashboard density |
| **AWS Console** | Infrastructure topology map, service health indicators |

---

*The current UI is a communication tool. The target is a control room. Those are different products with completely different information architectures.*