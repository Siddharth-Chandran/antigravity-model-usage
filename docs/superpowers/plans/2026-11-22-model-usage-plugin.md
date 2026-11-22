# Model Usage UI Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency, real-time (5-second auto-refreshing) Antigravity UI Plugin (`model-usage`) and sidecar (`usage_monitor`) that displays both Account Model Quotas/Reset Timers and Conversation/Subagent Token Usage with Full and Minimal view modes.

**Architecture:** A native Antigravity plugin bundle (`plugin.json`, `skills/model-usage/SKILL.md`, `sidecars/usage_monitor/sidecar.json`) running a Node.js HTTP sidecar (`main.mjs`) powered by `sidecar_sdk` (with a transparent standalone HTTP fallback for tests). Data collection and caching live in an isolated, pure ES module (`usage_collector.mjs`) that queries `GetUserStatus` on the local Language Server and parses `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` (including child subagents and swarm rosters) using `mtime:size` stat caching and ETag short-circuiting.

**Tech Stack:** Node.js (built-in `node:fs`, `node:path`, `node:http`, `node:test`, `node:assert/strict`), Antigravity `sidecar_sdk`, Vanilla HTML5/CSS3/ES2022 frontend using host theme CSS variables synced by `/preload.js`.

**Spec:** `docs/superpowers/specs/2026-11-22-model-usage-plugin-design.md`

## Global Constraints

- Zero external npm runtime dependencies (must run out-of-the-box with Antigravity's bundled Node runtime).
- Zero LLM/model token usage when polling or rendering.
- All file paths resolved from `conversationId` must validate against `ID_RE = /^[0-9a-f-]{8,64}$/i` to prevent path traversal.
- Strictly follow TDD: write failing unit/integration tests before production code.

---

### Task 1: Core Data Collector & Corner-Case Engine (`usage_collector.mjs`)

**Files:**
- Create: `test/usage_collector.test.mjs`
- Create: `sidecars/usage_monitor/usage_collector.mjs`

**Interfaces:**
- Produces:
  - `formatModelSlug(slugOrLabel, modelLookup)` -> `{ modelId, label, familyId, familyName, thinkingLevel }`
  - `parseQuotaData(userStatusResponse, nowMs)` -> `{ available, userTier, plan, defaultModel, models, families, pools }`
  - `parseTranscriptText(jsonlText, fallbackModel)` -> `{ steps, totalSteps, tokens, byModel, activeModel, subagents, recentSteps }`
  - `createUsageCollector(options)` -> `{ getSnapshot({ conversationId, etag, nowMs }) }`

- [ ] **Step 1: Write failing unit tests in `test/usage_collector.test.mjs`** covering:
  - Model slug formatting (`gemini-4-argon-high` -> `Gemini 4 Argon (High)`, `gemini-4-neon-xhigh` -> `Gemini 4 Neon (XHigh)`, `claude-opus-5-5-high` -> `Claude Opus 5.5 (High)`).
  - Quota parsing & family grouping from `GetUserStatus`, including missing `quotaInfo: {}` (`Gemini 4 Carbon`), depleted quota (`remainingFraction: 0`), and shared pool detection.
  - Transcript parsing with `PLANNER_RESPONSE` steps, torn/partial final JSON line, legacy `<USER_SETTINGS_CHANGE>` model selection containing version dots (`Claude Opus 5.5 (High)`, `Gemini 3.8 Flash (High)`), `invoke_subagent` child discovery, swarm `members.json` worker discovery, cyclic subagent loop prevention, `mtime:size` caching, and invalid `conversationId` rejection.
- [ ] **Step 2: Run `node --test test/usage_collector.test.mjs` and verify RED failure.**
- [ ] **Step 3: Implement `sidecars/usage_monitor/usage_collector.mjs`.**
- [ ] **Step 4: Run `node --test test/usage_collector.test.mjs` and verify GREEN pass.**

---

### Task 2: Sidecar Backend Server & HTTP API (`main.mjs`)

**Files:**
- Create: `test/server.test.mjs`
- Create: `sidecars/usage_monitor/main.mjs`
- Create: `sidecars/usage_monitor/sidecar.json`

**Interfaces:**
- Consumes: `createUsageCollector` from `./usage_collector.mjs`
- Produces:
  - `createSidecarHandler({ collector, staticDir })` and sidecar HTTP routes:
    - `GET /` (`index.html`)
    - `GET /styles.css` (`text/css`)
    - `GET /app.js` (`application/javascript`)
    - `GET /api/usage?conversationId=<id>&etag=<etag>` (JSON snapshot or `{ unchanged: true, etag }`)

- [ ] **Step 1: Write failing HTTP integration tests in `test/server.test.mjs`** testing `GET /api/usage`, ETag short-circuiting (`unchanged: true`), conversation switching, and static asset serving.
- [ ] **Step 2: Run `node --test test/server.test.mjs` and verify RED failure.**
- [ ] **Step 3: Implement `sidecars/usage_monitor/main.mjs` and `sidecars/usage_monitor/sidecar.json`** (supporting both Antigravity's `sidecar_sdk` and standalone `node:http` execution).
- [ ] **Step 4: Run `node --test` and verify GREEN pass.**

---

### Task 3: Side-Pane Frontend UI — Full & Minimal Modes (`index.html`, `styles.css`, `app.js`)

**Files:**
- Create: `sidecars/usage_monitor/index.html`
- Create: `sidecars/usage_monitor/styles.css`
- Create: `sidecars/usage_monitor/app.js`
- Modify: `test/server.test.mjs` (verify frontend HTML/CSS/JS integrity & required test IDs)

**Interfaces:**
- Consumes: `GET /api/usage?conversationId=<id>&etag=<etag>` and `/preload.js` (`window.sidecar.conversationId`, host CSS variables).
- Produces:
  - 5-second live polling loop with visibility pause/resume, manual refresh button, and pause toggle.
  - **Minimal Mode** and **Full Mode** toggle persisted in `localStorage`.
  - Active Model spotlight card with color-coded quota gauge and live reset countdown.
  - Family quota bars with expandable individual model variants (`Low`, `Medium`, `High`, `XHigh`) and shared pool tags.
  - Current conversation & subagent/swarm token breakdown, cache hit rate, per-model table, subagent table, recent step timeline, conversation switcher, and local workspace rollup.

- [ ] **Step 1: Add frontend contract tests in `test/server.test.mjs`** checking that `index.html`, `styles.css`, and `app.js` serve cleanly and contain all required UI views and controls (`Minimal` mode toggle, `5s` refresh interval, quota & conversation sections).
- [ ] **Step 2: Run `node --test test/server.test.mjs` and verify RED failure.**
- [ ] **Step 3: Implement `index.html`, `styles.css`, and `app.js`.**
- [ ] **Step 4: Run `node --test` and verify GREEN pass.**

---

### Task 4: Plugin Packaging, Skill, GitHub Installer & Live Antigravity Verification

**Files:**
- Create: `plugin.json`
- Create: `assets/logo.svg`
- Create: `skills/model-usage/SKILL.md`
- Create: `install.sh`
- Create: `LICENSE`
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Author `plugin.json`, `assets/logo.svg`, `skills/model-usage/SKILL.md`, `install.sh`, `LICENSE`, `.gitignore`, and `README.md`.**
- [ ] **Step 2: Run `./install.sh` to install/symlink into `~/.gemini/config/plugins/model-usage`.**
- [ ] **Step 3: Verify via `lsrpc GetAllPlugins` and `lsrpc GetSidecars` and live HTTP request to `/api/usage` with real Language Server & conversation data.**
- [ ] **Step 4: Commit all files cleanly to git on branch `main`.**
