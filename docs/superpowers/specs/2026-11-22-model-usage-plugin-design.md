# Antigravity Model Usage UI Plugin (`model-usage`) — Design Specification

**Date:** 2026-11-22
**Repository:** `antigravity-model-usage`
**Install Target:** `~/.gemini/config/plugins/model-usage`

---

## 1. Overview & Goals

Build a zero-dependency, open-source-ready Antigravity UI Plugin (`model-usage`) backed by a sidecar web panel (`usage_monitor`) that users can select directly from any conversation's auxiliary (side) pane `+` menu (or open via a `[Model Usage](sidecar://model-usage/usage_monitor/)` pill in chat).

### Core Requirements
1. **5-Second Real-Time Auto-Refresh (Zero Token Cost):**
   - Refreshes automatically every 5 seconds via a local `GET /api/usage` endpoint without invoking any LLM or consuming any model tokens or prompt/flow credits.
   - Uses `mtime:size` file caching and `etag` diffing so idle polls perform zero disk reads and zero DOM re-renders.
   - Pauses polling automatically when the side pane is hidden (`document.hidden`) and refreshes immediately on visibility restore.
2. **Dual Usage Metrics (Both Account Quotas & Conversation Tokens):**
   - **Account-Wide Model Quotas & Rate Limits:** Queried from the local Language Server `GetUserStatus` RPC (`cascadeModelConfigData.clientModelConfigs`, `groupedModels`, `defaultOverrideModelConfig`, `planStatus`, `userTier`). Shows remaining quota percentage (`remainingFraction`), used percentage, and live reset countdown (`resetTime`), grouped into shared quota pools / model families with expandable individual variants.
   - **Current Conversation & Subagent Token Usage:** Parsed from `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`, plus child subagents (`invoke_subagent`) and native swarm workers (`.system_generated/swarm/members.json`). Tracks `input_tokens`, `output_tokens`, `cache_read_tokens`, total tokens, cache hit ratio, step count, active model, per-model breakdown, per-subagent breakdown, and recent turn token history.
3. **Full Dashboard + Minimal Mode Toggle:**
   - **Full Mode (default):** Unified scrollable dashboard with Active Model & Quota status banner, Quota Pools (with expandable model variants), Plan Credits card, Current Conversation summary metrics + Per-Model & Subagent tables + Recent Steps token timeline, and Local Workspace Rollup across recent conversations.
   - **Minimal Mode (user-selectable toggle persisted in `localStorage`):** Ultra-compact card layout showing only the Active Model's remaining quota bar + reset timer, Current Conversation total tokens (Input / Output / Cached), and non-100% quota pools.
4. **GitHub & Marketplace Ready:**
   - Clean repository layout with `plugin.json`, `README.md`, `LICENSE` (MIT), `install.sh` (one-command local installer), bundled SVG logo (`assets/logo.svg`), agent navigation skill (`skills/model-usage/SKILL.md`), and comprehensive unit & integration tests (`node --test`).

---

## 2. Architecture & Component Boundaries

```text
antigravity-model-usage/
├── plugin.json                        # Antigravity plugin manifest
├── README.md                          # User & GitHub documentation + Marketplace publishing guide
├── LICENSE                            # MIT License
├── .gitignore                         # Ignores temporary files / OS metadata
├── install.sh                         # Helper script to symlink/install into ~/.gemini/config/plugins/model-usage
├── assets/
│   └── logo.svg                       # 128x128 high-contrast square SVG icon with 10% margin
├── skills/
│   └── model-usage/
│       └── SKILL.md                   # Skill teaching the agent to surface the sidecar:// pill
├── sidecars/
│   └── usage_monitor/
│       ├── sidecar.json               # Sidecar configuration (SIDECAR_UI_ENTRYPOINT_AUX_PANE)
│       ├── main.mjs                   # HTTP server (sidecar_sdk fallback to node:http for standalone tests)
│       ├── usage_collector.mjs        # Pure data collection, caching, grouping, and corner-case handling
│       ├── index.html                 # Responsive side-pane HTML shell
│       ├── styles.css                 # Host-theme-synced CSS (--background, --foreground, --primary)
│       └── app.js                     # 5s polling loop, Full/Minimal mode toggle, rendering
└── test/
    ├── usage_collector.test.mjs       # Unit tests for transcript parsing, subagents, quota grouping, caching
    └── server.test.mjs                # HTTP endpoint tests (/api/usage, etag 304/unchanged, static assets)
```

---

## 3. Data Sources & Corner-Case Handling

### 3.1 Language Server `GetUserStatus` RPC
- **Endpoint:** `POST http://${ANTIGRAVITY_LS_ADDRESS}/exa.language_server_pb.LanguageServerService/GetUserStatus` with header `x-codeium-csrf-token: ${ANTIGRAVITY_CSRF_TOKEN}` and body `{}`.
- **Timeout & Resilience:** 2,500 ms request timeout. If the Language Server is temporarily unreachable or running in standalone test mode without an LS, `fetchUserStatus` returns `{ available: false, error: "..." }` and keeps the last known good quota snapshot (marked `stale: true` with timestamp) rather than crashing or blanking the UI.
- **Model ID & Label Normalization:**
  - Builds a lookup map from `clientModelConfigs`:
    - `modelId` (e.g., `"gemini-4-argon-high"`) → `label` (`"Gemini 4 Argon (High)"`) and `quotaInfo`.
    - `modelOrAlias.model` (e.g., `"MODEL_PLACEHOLDER_M417"`) → `label` and `modelId`.
    - Normalized lowercase label → canonical `label`.
  - When a transcript step contains a slug not in `clientModelConfigs` (or when offline), a deterministic slug formatter converts `"gemini-4-argon-high"` → `"Gemini 4 Argon (High)"`, `"gemini-4-neon-xhigh"` → `"Gemini 4 Neon (XHigh)"`, `"claude-opus-5-5-high"` → `"Claude Opus 5.5 (High)"`.
- **Quota Pool Grouping:**
  - Multiple thinking levels of the same model family (and sometimes multiple model families such as Neon, Hydrogen, and 3.8 Flash) share the exact same backend quota bucket (`remainingFraction` + `resetTime`).
  - We provide two grouping levels:
    1. **Family Cards:** Group variants by base family (e.g., `Gemini 4 Argon`, `Gemini 4 Neon`, `Gemini 4 Hydrogen`, `Gemini 3.8 Flash`, `Claude Opus 5.5`, `Claude Sonnet 5.5`, `GPT-OSS 120B`, `Orchestrator`, `Gemini 4 Carbon`), showing the shared `remainingFraction`, used percentage, `resetTime`, and variant pills (`Low`, `Medium`, `High`, `XHigh`).
    2. **Shared Bucket Indicator:** Highlights which families share the same reset timestamp & remaining fraction so the user understands why using one family affects another in the same pool.
  - **Missing `quotaInfo` Corner Case:** Some models (e.g., `Gemini 4 Carbon` with `quotaInfo: {}`) omit `remainingFraction`. These are rendered with an `"Unlimited / N/A"` badge instead of `NaN%` or `0%`.

### 3.2 Conversation Transcript & Subagent Tree Parsing
- **Locating `appData`:**
  - Derived from `ANTIGRAVITY_EXECUTABLE_DATA_DIR` (walking up to `sidecar_data`'s parent directory) or `~/.gemini/antigravity` (and scanning `~/.gemini/*/brain` if standalone).
- **Corner Cases in `transcript.jsonl`:**
  1. **Torn / Partial Last Line:** While the agent is mid-write, the last line of `transcript.jsonl` may be truncated JSON. The parser parses line-by-line and silently skips an unparseable line without failing the file.
  2. **Legacy Transcripts Without `step.model`:** Older transcripts omit `"model"` on `PLANNER_RESPONSE` steps. The parser tracks `<USER_SETTINGS_CHANGE>` blocks in `USER_INPUT` steps matching ``The user changed setting `Model Selection` from .+ to ([^\n]+?)\.(?:\s|$|<)`` (carefully handling dots in version numbers like `Claude Opus 5.5 (High)` and `Gemini 3.8 Flash (High)`) and attributes subsequent steps to that selected model, falling back to the LS `defaultOverrideModelConfig` or `"Default Model"`.
  3. **Subagent Discovery (`invoke_subagent` & Swarm `members.json`):**
     - Scans `PLANNER_RESPONSE` tool calls for `name === "invoke_subagent"` (handling both raw JSON strings and double-quoted strings in `args.Role`, `args.TypeName`, `args.Model`).
     - Matches subsequent `GENERIC` tool result steps containing `"Created the following subagent:"` and extracts `"conversationId": "<uuid>"`.
     - Also checks `<appData>/brain/<conversationId>/.system_generated/swarm/members.json` (if the conversation coordinates or belongs to a native swarm) to include all swarm workers.
     - Recursively aggregates child transcripts up to `MAX_SUBAGENT_DEPTH = 3` using a `visited` `Set` to guarantee no infinite loops even on cyclic references.
  4. **Missing or Brand-New Conversation:**
     - If `conversationId` is valid (`ID_RE = /^[0-9a-f-]{8,}$/i`) but `<appData>/brain/<conversationId>` has no `transcript.jsonl` yet, returns an empty conversation usage object (`exists: false, steps: 0`) so the UI shows `"No turns recorded in this conversation yet"` while still displaying live Account Quotas and the active/default model.
     - If `conversationId` is omitted (e.g., opened standalone in a browser), automatically resolves to the most recently modified conversation in `<appData>/brain/` and exposes `recentConversations` so the user can switch conversations in the UI.
  5. **Path Traversal Protection:**
     - Any `conversationId` query parameter is strictly validated against `/^[0-9a-f-]{8,64}$/i` before joining with `<appData>/brain/`. Invalid IDs are rejected safely without touching the filesystem.

---

## 4. UI Design (Full Mode & Minimal Mode)

### 4.1 Header Bar (Always Visible)
- **Title & Live Status Pill:** `"Model Usage"` + green pulsing dot (`Live · 5s`), or `Paused` / `Offline` badge.
- **Controls:**
  - **Minimal / Full Toggle Button:** Switches between `"Minimal"` and `"Full"` view (`aria-pressed`, saved in `localStorage` under `agy_model_usage_minimal`).
  - **Pause / Resume Auto-Refresh Button (`5s`):** Allows pausing the 5-second timer.
  - **Manual Refresh Button:** Triggers an immediate poll.

### 4.2 Minimal Mode View
Designed for narrow panes or distraction-free monitoring:
1. **Active Model Spotlight Card:**
   - Model name (e.g., `Gemini 4 Argon (High)`), remaining quota percentage (`91.1% left`), progress bar (color-coded green `>50%`, amber `20–50%`, red `<20%`), and live countdown (`Resets in 6d 18h`).
2. **Current Conversation Compact Strip:**
   - Total Tokens (`485.2K`), Input (`78.1K`), Output (`6.4K`), Cache Read (`400.7K` · `83.7% hit`), Steps (`10`), Subagents (`0`).
3. **Other Active Quota Pools (Compact List):**
   - One single-line progress row per model family whose quota is `< 100%` (or top 3 families if all are 100%).

### 4.3 Full Mode View
Includes everything in Minimal Mode plus:
1. **All Model Families & Quota Pools Card:**
   - Shows every model family from `GetUserStatus` with its quota progress bar, exact remaining %, used %, reset countdown + local reset time tooltip, and a toggle to expand all 24 individual effort variants (`Low`, `Medium`, `High`, `XHigh`).
2. **Plan & Credits Strip:**
   - Displays `userTier.name` (`Google AI Pro`), `planName`, `availablePromptCredits`, and `availableFlowCredits`.
3. **Conversation Breakdown Card (with Conversation Picker):**
   - Dropdown to switch between current conversation and recent local conversations.
   - **Per-Model Breakdown Table:** Model name, turns/steps, input tokens, output tokens, cached tokens, total tokens, and % share of conversation.
   - **Subagents & Swarm Workers Table (shown when subagents > 0):** Role/name, subagent type, model, steps, total tokens, status.
   - **Recent Turns Timeline (collapsible):** Last 15 `PLANNER_RESPONSE` steps showing step `#`, timestamp, model, input/cache/output tokens, and tool calls invoked.
4. **All Local Conversations Summary Card:**
   - Aggregate token usage across the recent conversations in `<appData>/brain/` (Today / Last 7 Days / Total scanned) so the user can see their overall local token footprint.

---

## 5. Testing & Verification Strategy

1. **Unit Tests (`test/usage_collector.test.mjs`):**
   - Tests model slug normalization and `clientModelConfigs` matching.
   - Tests quota pool & family grouping, including missing `quotaInfo` (`{}`), depleted quota (`0`), and reset time calculation.
   - Tests `transcript.jsonl` parsing: normal steps, torn/corrupted JSON lines, legacy steps using `<USER_SETTINGS_CHANGE>` with dots in model names (`Claude Opus 5.5 (High)`), `invoke_subagent` extraction, swarm `members.json` integration, cycle prevention, and `mtime:size` cache hit verification.
   - Tests security validation against path traversal in `conversationId`.
2. **HTTP Server Integration Tests (`test/server.test.mjs`):**
   - Starts the HTTP server on an ephemeral port with mock LS and temp `brain/` directory.
   - Verifies `GET /`, `GET /styles.css`, `GET /app.js`, `GET /api/usage`, and `etag` `{ unchanged: true }` response.
3. **Live Antigravity Language Server Verification:**
   - Installs the plugin into `~/.gemini/config/plugins/model-usage`.
   - Verifies discovery via `lsrpc GetAllPlugins` and `lsrpc GetSidecars`.
   - Requests `/api/usage` against the live Language Server and active conversation to confirm real quota and token numbers return cleanly.
