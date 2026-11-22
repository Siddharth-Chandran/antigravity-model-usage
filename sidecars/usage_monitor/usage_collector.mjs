/**
 * Pure data collector and corner-case engine for the Antigravity Model Usage sidecar.
 *
 * Responsibilities:
 * 1. Query and normalize account-level model quotas & credits from LanguageServerService/GetUserStatus.
 * 2. Parse conversation transcripts (<appData>/brain/<conv>/.system_generated/logs/transcript.jsonl),
 *    child subagents (invoke_subagent), and swarm rosters (.system_generated/swarm/members.json).
 * 3. Cache parsed transcript summaries by file (mtimeMs, size) and short-circuit unchanged polls via ETag.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const ID_RE = /^[0-9a-f-]{8,64}$/i;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024; // 64 MB safety cap
const MAX_SUBAGENT_DEPTH = 3;
const RECENT_STEPS_LIMIT = 20;
const RECENT_CONVS_LIMIT = 12;

const THINKING_LABELS = {
  low: 'Low',
  medium: 'Medium',
  med: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
};

const KNOWN_TOKEN_CASING = {
  gemini: 'Gemini',
  claude: 'Claude',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  argon: 'Argon',
  neon: 'Neon',
  hydrogen: 'Hydrogen',
  carbon: 'Carbon',
  flash: 'Flash',
  pro: 'Pro',
  lite: 'Lite',
  orchestrator: 'Orchestrator',
  gpt: 'GPT',
  oss: 'OSS',
  openai: 'OpenAI',
  model: 'Model',
};

/**
 * Unwraps optional surrounding double quotes from transcript tool_call argument strings.
 */
function unwrapQuotes(val) {
  if (typeof val !== 'string') return '';
  let s = val.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') return parsed.trim();
    } catch {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

/**
 * Discovers Antigravity appData directories containing a `brain/` subdirectory.
 */
export function findAppDataDirs(env = process.env) {
  const dataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      if (existsSync(join(appData, 'brain'))) return [appData];
    }
  }
  const root = join(homedir(), '.gemini');
  const preferred = join(root, 'antigravity');
  const out = [];
  if (existsSync(join(preferred, 'brain'))) out.push(preferred);
  try {
    for (const name of readdirSync(root).sort()) {
      const candidate = join(root, name);
      if (candidate !== preferred && existsSync(join(candidate, 'brain'))) {
        out.push(candidate);
      }
    }
  } catch {
    // Ignore missing ~/.gemini in isolated test environments
  }
  return out;
}

/**
 * Extracts family display name and thinking level from a human-readable model label
 * such as "Gemini 4 Argon (High)" or "Orchestrator (Neon)" or "Gemini 4 Carbon".
 */
function splitHumanLabel(label) {
  const trimmed = String(label || '').trim();
  const match = /^(.+?)\s*\(([^)]+)\)$/.exec(trimmed);
  if (!match) {
    return {
      familyName: trimmed || 'Default Model',
      thinkingLevel: null,
    };
  }
  const base = match[1].trim();
  const paren = match[2].trim();
  const lowerParen = paren.toLowerCase();
  if (THINKING_LABELS[lowerParen] || lowerParen === 'extra high') {
    return {
      familyName: base,
      thinkingLevel: THINKING_LABELS[lowerParen] || 'XHigh',
    };
  }
  // E.g. "Orchestrator (Neon)" -> family is "Orchestrator", variant is "Neon"
  return {
    familyName: base,
    thinkingLevel: paren,
  };
}

function slugToFamilyId(familyName) {
  return String(familyName || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

/**
 * Builds fast lookup tables from `cascadeModelConfigData`.
 */
export function buildModelLookup(cascadeModelConfigData = {}) {
  const byId = new Map();
  const byPlaceholder = new Map();
  const byLabel = new Map();
  const grouped = cascadeModelConfigData?.groupedModels || {};

  const configs = Array.isArray(cascadeModelConfigData?.clientModelConfigs)
    ? cascadeModelConfigData.clientModelConfigs
    : [];

  for (const cfg of configs) {
    const label = typeof cfg?.label === 'string' ? cfg.label.trim() : '';
    const modelId = typeof cfg?.modelId === 'string' ? cfg.modelId.trim() : '';
    const placeholder = typeof cfg?.modelOrAlias?.model === 'string' ? cfg.modelOrAlias.model.trim() : '';
    if (!label) continue;

    let familyId = '';
    let familyName = '';
    let thinkingLevel = null;

    // Check if modelId starts with one of the groupedModels keys
    for (const [gKey, gVal] of Object.entries(grouped)) {
      if (modelId === gKey || modelId.startsWith(`${gKey}-`)) {
        familyId = gKey;
        familyName = gVal?.displayName || splitHumanLabel(label).familyName;
        const suffix = modelId.slice(gKey.length + 1).toLowerCase();
        thinkingLevel = THINKING_LABELS[suffix] || splitHumanLabel(label).thinkingLevel;
        break;
      }
    }

    if (!familyName) {
      const split = splitHumanLabel(label);
      familyName = split.familyName;
      thinkingLevel = split.thinkingLevel;
      familyId = slugToFamilyId(familyName);
    }

    const entry = {
      modelId: modelId || slugToFamilyId(label),
      placeholder: placeholder || null,
      label,
      familyId,
      familyName,
      thinkingLevel,
      tagTitle: cfg?.tagTitle || null,
      tagDescription: cfg?.tagDescription || null,
      quotaInfo: cfg?.quotaInfo || {},
    };

    if (modelId) byId.set(modelId.toLowerCase(), entry);
    if (placeholder) byPlaceholder.set(placeholder, entry);
    byLabel.set(label.toLowerCase(), entry);
  }

  return { byId, byPlaceholder, byLabel, grouped };
}

/**
 * Converts any model identifier (slug, placeholder, human label, or malformed string)
 * into a normalized descriptor `{ modelId, label, familyId, familyName, thinkingLevel }`.
 */
export function formatModelSlug(rawInput, lookup = null) {
  const cleaned = unwrapQuotes(typeof rawInput === 'string' ? rawInput : '')
    .replace(/^\\+|^"+|"+$/g, '')
    .trim();

  if (
    !cleaned ||
    cleaned === 'None' ||
    cleaned === 'none' ||
    cleaned === 'inherit' ||
    cleaned === 'default' ||
    cleaned.length < 2
  ) {
    return {
      modelId: 'default',
      label: 'Default Model',
      familyId: 'default',
      familyName: 'Default Model',
      thinkingLevel: null,
    };
  }

  if (lookup) {
    const lower = cleaned.toLowerCase();
    if (lookup.byId?.has(lower)) return lookup.byId.get(lower);
    if (lookup.byPlaceholder?.has(cleaned)) return lookup.byPlaceholder.get(cleaned);
    if (lookup.byLabel?.has(lower)) return lookup.byLabel.get(lower);

    // Check groupedModels prefix match
    if (lookup.grouped) {
      for (const [gKey, gVal] of Object.entries(lookup.grouped)) {
        if (lower === gKey || lower.startsWith(`${gKey}-`)) {
          const suffix = lower.slice(gKey.length + 1);
          const thinkingLevel = THINKING_LABELS[suffix] || (suffix ? suffix.toUpperCase() : null);
          const familyName = gVal?.displayName || gKey;
          const label = thinkingLevel ? `${familyName} (${thinkingLevel})` : familyName;
          return {
            modelId: lower,
            label,
            familyId: gKey,
            familyName,
            thinkingLevel,
          };
        }
      }
    }
  }

  // If already a human-readable label with spaces/parentheses
  if (cleaned.includes(' ') || cleaned.includes('(')) {
    const { familyName, thinkingLevel } = splitHumanLabel(cleaned);
    return {
      modelId: slugToFamilyId(cleaned),
      label: cleaned,
      familyId: slugToFamilyId(familyName),
      familyName,
      thinkingLevel,
    };
  }

  // Heuristic slug formatter (e.g. "claude-opus-5-5-high", "gemini-3.8-flash-xhigh", "gpt-oss-120b-medium")
  let normalized = cleaned.toLowerCase().replace(/^model_/, '').replace(/_/g, '-');
  // Collapse version numbers like "claude-opus-5-5-high" -> "claude-opus-5.5-high"
  normalized = normalized.replace(/-(opus|sonnet|haiku)-(\d+)-(\d+)(?=-|$)/g, '-$1-$2.$3');

  const parts = normalized.split('-').filter(Boolean);
  let thinkingLevel = null;
  if (parts.length > 1 && THINKING_LABELS[parts[parts.length - 1]]) {
    thinkingLevel = THINKING_LABELS[parts.pop()];
  }

  const formattedWords = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 'gpt' && parts[i + 1] === 'oss') {
      formattedWords.push('GPT-OSS');
      i++;
      continue;
    }
    if (KNOWN_TOKEN_CASING[p]) {
      formattedWords.push(KNOWN_TOKEN_CASING[p]);
    } else if (/^\d+(\.\d+)?b$/i.test(p)) {
      formattedWords.push(p.toUpperCase());
    } else if (/^\d+(\.\d+)?$/.test(p)) {
      formattedWords.push(p);
    } else {
      formattedWords.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }

  const familyName = formattedWords.join(' ') || 'Default Model';
  const label = thinkingLevel ? `${familyName} (${thinkingLevel})` : familyName;
  return {
    modelId: cleaned.toLowerCase(),
    label,
    familyId: slugToFamilyId(familyName),
    familyName,
    thinkingLevel,
  };
}

/**
 * Classifies a remaining quota fraction [0, 1] or null into a health status string.
 */
function quotaStatusOf(hasQuota, remainingFraction) {
  if (!hasQuota || remainingFraction === null) return 'unlimited';
  if (remainingFraction <= 0) return 'exhausted';
  if (remainingFraction < 0.2) return 'low';
  if (remainingFraction < 0.5) return 'warning';
  return 'healthy';
}

/**
 * Parses the Language Server `GetUserStatus` response into structured quota models,
 * model families, shared quota pools, and plan credit metrics.
 */
export function parseQuotaData(userStatusPayload, nowMs = Date.now()) {
  const us = userStatusPayload?.userStatus || userStatusPayload;
  if (!us || typeof us !== 'object') {
    return {
      available: false,
      stale: false,
      error: 'No userStatus payload',
      userTier: null,
      plan: null,
      defaultModel: formatModelSlug('default'),
      models: [],
      families: [],
      pools: [],
    };
  }

  const cascadeData = us.cascadeModelConfigData || {};
  const lookup = buildModelLookup(cascadeData);

  const defaultPlaceholder = cascadeData?.defaultOverrideModelConfig?.modelOrAlias?.model || '';
  const defaultModel = defaultPlaceholder
    ? formatModelSlug(defaultPlaceholder, lookup)
    : formatModelSlug('default', lookup);

  const planInfo = us.planStatus?.planInfo || {};
  const plan = {
    planName: planInfo.planName || us.userTier?.name || 'Standard',
    teamsTier: planInfo.teamsTier || null,
    availablePromptCredits: Number(us.planStatus?.availablePromptCredits ?? 0),
    monthlyPromptCredits: Number(planInfo.monthlyPromptCredits ?? 0),
    availableFlowCredits: Number(us.planStatus?.availableFlowCredits ?? 0),
    monthlyFlowCredits: Number(planInfo.monthlyFlowCredits ?? 0),
  };

  const userTier = us.userTier
    ? {
        id: us.userTier.id || '',
        name: us.userTier.name || plan.planName,
        description: us.userTier.description || '',
      }
    : { id: '', name: plan.planName, description: '' };

  const rawConfigs = Array.isArray(cascadeData.clientModelConfigs)
    ? cascadeData.clientModelConfigs
    : [];

  const models = [];
  const familyMap = new Map();

  for (const cfg of rawConfigs) {
    const info = formatModelSlug(cfg.modelId || cfg.label || cfg.modelOrAlias?.model, lookup);
    const q = cfg.quotaInfo || {};
    const hasQuota = typeof q.remainingFraction === 'number' && Number.isFinite(q.remainingFraction);
    const remainingFraction = hasQuota ? Math.max(0, Math.min(1, q.remainingFraction)) : null;
    const remainingPercent = hasQuota ? remainingFraction * 100 : null;
    const usedPercent = hasQuota ? (1 - remainingFraction) * 100 : null;

    const resetTime = typeof q.resetTime === 'string' && q.resetTime ? q.resetTime : null;
    const resetEpochMs = resetTime ? Date.parse(resetTime) : NaN;
    const resetInMs = Number.isFinite(resetEpochMs) ? Math.max(0, resetEpochMs - nowMs) : null;
    const status = quotaStatusOf(hasQuota, remainingFraction);

    const modelEntry = {
      modelId: info.modelId,
      label: cfg.label || info.label,
      familyId: info.familyId,
      familyName: info.familyName,
      thinkingLevel: info.thinkingLevel,
      hasQuota,
      remainingFraction,
      remainingPercent,
      usedPercent,
      resetTime,
      resetInMs,
      status,
      tagTitle: cfg.tagTitle || null,
      tagDescription: cfg.tagDescription || null,
    };
    models.push(modelEntry);

    let fam = familyMap.get(info.familyId);
    if (!fam) {
      fam = {
        familyId: info.familyId,
        familyName: info.familyName,
        hasQuota,
        remainingFraction,
        remainingPercent,
        usedPercent,
        resetTime,
        resetInMs,
        status,
        poolId: null,
        sharedWith: [],
        variants: [],
      };
      familyMap.set(info.familyId, fam);
    }
    fam.variants.push({
      modelId: modelEntry.modelId,
      label: modelEntry.label,
      thinkingLevel: modelEntry.thinkingLevel || 'Default',
      remainingFraction: modelEntry.remainingFraction,
      remainingPercent: modelEntry.remainingPercent,
      resetTime: modelEntry.resetTime,
      status: modelEntry.status,
    });
    // Keep lowest remaining fraction if variants differ
    if (modelEntry.hasQuota && (!fam.hasQuota || modelEntry.remainingFraction < fam.remainingFraction)) {
      fam.hasQuota = true;
      fam.remainingFraction = modelEntry.remainingFraction;
      fam.remainingPercent = modelEntry.remainingPercent;
      fam.usedPercent = modelEntry.usedPercent;
      fam.resetTime = modelEntry.resetTime;
      fam.resetInMs = modelEntry.resetInMs;
      fam.status = modelEntry.status;
    }
  }

  const families = [...familyMap.values()];

  // Group families into shared quota pools when they share the exact same resetTime and remainingFraction
  const poolMap = new Map();
  for (const fam of families) {
    if (!fam.hasQuota || !fam.resetTime) continue;
    const key = `${fam.resetTime}|${fam.remainingFraction.toFixed(5)}`;
    let pool = poolMap.get(key);
    if (!pool) {
      pool = {
        poolId: `pool-${poolMap.size + 1}`,
        resetTime: fam.resetTime,
        resetInMs: fam.resetInMs,
        remainingFraction: fam.remainingFraction,
        remainingPercent: fam.remainingPercent,
        usedPercent: fam.usedPercent,
        status: fam.status,
        familyNames: [],
      };
      poolMap.set(key, pool);
    }
    pool.familyNames.push(fam.familyName);
    fam.poolId = pool.poolId;
  }

  const pools = [...poolMap.values()];
  for (const fam of families) {
    if (!fam.poolId) continue;
    const pool = pools.find((p) => p.poolId === fam.poolId);
    if (pool && pool.familyNames.length > 1) {
      fam.sharedWith = pool.familyNames.filter((n) => n !== fam.familyName);
    }
  }

  return {
    available: true,
    stale: false,
    fetchedAtMs: nowMs,
    userTier,
    plan,
    defaultModel,
    lookup,
    models,
    families,
    pools,
  };
}

// Matches `<USER_SETTINGS_CHANGE>` model selection lines, including model names with dots like "Claude Opus 5.5 (High)"
const SETTINGS_MODEL_RE = /The user changed setting `Model Selection` from .+? to ([^\n]+?)\.(?:\s|$|<)/;
const CREATED_SUBAGENT_RE = /Created the following subagent:\s*\{[\s\S]*?"conversationId":\s*"([0-9a-f-]{8,64})"/i;

/**
 * Parses a conversation's `transcript.jsonl` content into token totals, per-model breakdown,
 * active model, recent steps, and spawned subagent references.
 */
export function parseTranscriptText(jsonlText, { lookup = null, fallbackModel = 'Default Model' } = {}) {
  const tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    billable: 0,
    total: 0,
    cacheHitRate: 0,
  };

  const modelStatsMap = new Map();
  const recentSteps = [];
  const pendingSubagentArgs = [];
  const subagentRefs = [];
  const seenSubagentIds = new Set();

  let currentSelectedModel = fallbackModel;
  let lastActiveModel = formatModelSlug(fallbackModel, lookup);
  let totalSteps = 0;
  let userTurns = 0;
  let firstStepAt = null;
  let lastStepAt = null;
  let lastStepType = null;
  let lastStepHasTools = false;

  const lines = typeof jsonlText === 'string' ? jsonlText.split('\n') : [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let step;
    try {
      step = JSON.parse(trimmed);
    } catch {
      // Torn final line during live write: skip safely
      continue;
    }
    if (!step || typeof step !== 'object') continue;

    if (typeof step.created_at === 'string' && step.created_at) {
      if (!firstStepAt) firstStepAt = step.created_at;
      lastStepAt = step.created_at;
    }
    lastStepType = step.type || null;

    if (step.type === 'USER_INPUT') {
      userTurns++;
      if (typeof step.content === 'string' && step.content.includes('<USER_SETTINGS_CHANGE>')) {
        const m = SETTINGS_MODEL_RE.exec(step.content);
        if (m && m[1]) {
          currentSelectedModel = m[1].trim();
          lastActiveModel = formatModelSlug(currentSelectedModel, lookup);
        }
      }
      continue;
    }

    if (step.type === 'GENERIC' && typeof step.content === 'string') {
      const subMatch = CREATED_SUBAGENT_RE.exec(step.content);
      if (subMatch && subMatch[1]) {
        const subId = subMatch[1];
        const meta = pendingSubagentArgs.shift() || {};
        if (!seenSubagentIds.has(subId)) {
          seenSubagentIds.add(subId);
          subagentRefs.push({
            conversationId: subId,
            role: meta.role || 'Subagent',
            typeName: meta.typeName || 'self',
            requestedModel: meta.requestedModel || 'inherit',
            parentModel: meta.parentModel || lastActiveModel.label,
            createdAt: step.created_at || lastStepAt || null,
          });
        }
      }
      continue;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      totalSteps++;
      const rawModel = typeof step.model === 'string' && step.model.trim()
        ? step.model.trim()
        : currentSelectedModel;
      const modelInfo = formatModelSlug(rawModel, lookup);
      lastActiveModel = modelInfo;

      const inTok = Math.max(0, Number(step.input_tokens) || 0);
      const outTok = Math.max(0, Number(step.output_tokens) || 0);
      const cacheTok = Math.max(0, Number(step.cache_read_tokens) || 0);
      const stepTotal = inTok + outTok + cacheTok;

      tokens.input += inTok;
      tokens.output += outTok;
      tokens.cacheRead += cacheTok;
      tokens.billable += inTok + outTok;
      tokens.total += stepTotal;

      let mStat = modelStatsMap.get(modelInfo.label);
      if (!mStat) {
        mStat = {
          modelId: modelInfo.modelId,
          label: modelInfo.label,
          familyId: modelInfo.familyId,
          familyName: modelInfo.familyName,
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          billableTokens: 0,
          totalTokens: 0,
          lastUsedAt: null,
        };
        modelStatsMap.set(modelInfo.label, mStat);
      }
      mStat.steps++;
      mStat.inputTokens += inTok;
      mStat.outputTokens += outTok;
      mStat.cacheReadTokens += cacheTok;
      mStat.billableTokens += inTok + outTok;
      mStat.totalTokens += stepTotal;
      if (step.created_at) mStat.lastUsedAt = step.created_at;

      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      lastStepHasTools = toolCalls.length > 0;
      const toolNames = [];

      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        if (typeof tc.name === 'string') toolNames.push(tc.name);
        if (tc.name === 'invoke_subagent') {
          const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
          pendingSubagentArgs.push({
            role: unwrapQuotes(args.Role) || 'Subagent',
            typeName: unwrapQuotes(args.TypeName) || 'self',
            requestedModel: unwrapQuotes(args.Model) || 'inherit',
            parentModel: modelInfo.label,
          });
        }
      }

      recentSteps.push({
        stepIndex: Number(step.step_index ?? totalSteps),
        createdAt: step.created_at || null,
        modelId: modelInfo.modelId,
        modelLabel: modelInfo.label,
        inputTokens: inTok,
        outputTokens: outTok,
        cacheReadTokens: cacheTok,
        totalTokens: stepTotal,
        toolNames,
      });
    }
  }

  const promptContextTotal = tokens.input + tokens.cacheRead;
  tokens.cacheHitRate = promptContextTotal > 0 ? (tokens.cacheRead / promptContextTotal) * 100 : 0;

  const byModel = [...modelStatsMap.values()]
    .map((m) => ({
      ...m,
      sharePercent: tokens.total > 0 ? (m.totalTokens / tokens.total) * 100 : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const activityState =
    lastStepType === 'PLANNER_RESPONSE' && lastStepHasTools ? 'working' : 'idle';

  return {
    totalSteps,
    userTurns,
    firstStepAt,
    lastStepAt,
    activityState,
    activeModel: lastActiveModel,
    tokens,
    byModel,
    subagentRefs,
    recentSteps: recentSteps.slice(-RECENT_STEPS_LIMIT).reverse(),
  };
}

/**
 * Calls LanguageServerService/GetUserStatus over HTTP on loopback.
 */
export async function defaultFetchUserStatus(env = process.env) {
  const lsAddr = env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) {
    throw new Error('Missing ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(
      `http://${lsAddr}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrf,
        },
        body: '{}',
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      throw new Error(`GetUserStatus HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates a stateful usage collector with `mtime:size` transcript caching and ETag generation.
 */
export function createUsageCollector({
  appDataDirs = () => findAppDataDirs(),
  fetchUserStatus = () => defaultFetchUserStatus(),
} = {}) {
  const parsedTranscriptCache = new Map(); // filePath -> { key, parsed }
  const rosterCache = new Map();           // filePath -> { key, roster }
  let lastGoodQuota = null;

  function statKey(path) {
    try {
      const s = statSync(path);
      if (s.size > MAX_TRANSCRIPT_BYTES) return { exists: false, tooLarge: true, key: 'too-large', mtimeMs: s.mtimeMs, size: s.size };
      return { exists: true, key: `${s.mtimeMs}:${s.size}`, mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return { exists: false, key: 'missing', mtimeMs: 0, size: -1 };
    }
  }

  function findBrainDirForConv(convId) {
    const dirs = appDataDirs();
    for (const appData of dirs) {
      const candidate = join(appData, 'brain', convId);
      if (existsSync(candidate)) return { appData, brainDir: join(appData, 'brain') };
    }
    const primary = dirs[0];
    return primary ? { appData: primary, brainDir: join(primary, 'brain') } : { appData: null, brainDir: null };
  }

  function readTranscriptCached(brainDir, convId, lookup, fallbackModel) {
    const filePath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    const st = statKey(filePath);
    if (!st.exists) {
      return {
        exists: false,
        key: `${convId}:missing`,
        mtimeMs: 0,
        parsed: parseTranscriptText('', { lookup, fallbackModel }),
      };
    }
    const cacheKey = `${st.key}|${fallbackModel}`;
    const hit = parsedTranscriptCache.get(filePath);
    if (hit && hit.key === cacheKey) {
      return { exists: true, key: `${convId}:${st.key}`, mtimeMs: st.mtimeMs, parsed: hit.parsed };
    }
    let text = '';
    try {
      text = readFileSync(filePath, 'utf-8');
    } catch {
      return {
        exists: false,
        key: `${convId}:read-error`,
        mtimeMs: 0,
        parsed: parseTranscriptText('', { lookup, fallbackModel }),
      };
    }
    const parsed = parseTranscriptText(text, { lookup, fallbackModel });
    parsedTranscriptCache.set(filePath, { key: cacheKey, parsed });
    return { exists: true, key: `${convId}:${st.key}`, mtimeMs: st.mtimeMs, parsed };
  }

  function readSwarmMembersCached(brainDir, convId) {
    const filePath = join(brainDir, convId, '.system_generated', 'swarm', 'members.json');
    const st = statKey(filePath);
    if (!st.exists) return { key: '', members: [] };
    const hit = rosterCache.get(filePath);
    if (hit && hit.key === st.key) return { key: st.key, members: hit.members };
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      const membersObj = raw?.members && typeof raw.members === 'object' ? raw.members : {};
      const members = [];
      for (const [name, m] of Object.entries(membersObj)) {
        const cid = typeof m?.conversation_id === 'string' ? m.conversation_id.trim() : '';
        if (!cid || cid === convId || !ID_RE.test(cid)) continue;
        members.push({
          conversationId: cid,
          role: `Swarm: ${name}`,
          typeName: m?.role || 'worker',
          requestedModel: m?.model || 'inherit',
        });
      }
      rosterCache.set(filePath, { key: st.key, members });
      return { key: st.key, members };
    } catch {
      return { key: '', members: [] };
    }
  }

  function collectConversationTree(brainDir, rootConvId, lookup, fallbackModel) {
    const visited = new Set([rootConvId]);
    const rootEntry = readTranscriptCached(brainDir, rootConvId, lookup, fallbackModel);
    const keyParts = [rootEntry.key];

    const subagents = [];
    const queue = [];

    // Seed queue with direct invoke_subagent references + swarm members
    for (const ref of rootEntry.parsed.subagentRefs) {
      queue.push({ ...ref, depth: 1 });
    }
    const swarm = readSwarmMembersCached(brainDir, rootConvId);
    if (swarm.key) keyParts.push(`swarm:${swarm.key}`);
    for (const sm of swarm.members) {
      queue.push({ ...sm, depth: 1 });
    }

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item || !ID_RE.test(item.conversationId)) continue;
      if (visited.has(item.conversationId)) continue;
      visited.add(item.conversationId);

      const effectiveFallback =
        item.requestedModel && item.requestedModel !== 'inherit'
          ? item.requestedModel
          : item.parentModel || fallbackModel;

      const subEntry = readTranscriptCached(brainDir, item.conversationId, lookup, effectiveFallback);
      keyParts.push(subEntry.key);

      subagents.push({
        conversationId: item.conversationId,
        role: item.role,
        typeName: item.typeName,
        requestedModel: item.requestedModel,
        activeModel: subEntry.parsed.activeModel,
        exists: subEntry.exists,
        steps: subEntry.parsed.totalSteps,
        activityState: subEntry.parsed.activityState,
        lastStepAt: subEntry.parsed.lastStepAt,
        tokens: subEntry.parsed.tokens,
        depth: item.depth,
      });

      if (item.depth < MAX_SUBAGENT_DEPTH) {
        for (const childRef of subEntry.parsed.subagentRefs) {
          if (!visited.has(childRef.conversationId)) {
            queue.push({ ...childRef, depth: item.depth + 1 });
          }
        }
      }
    }

    // Combine direct + subagent tokens and per-model breakdown
    const directTokens = rootEntry.parsed.tokens;
    const subagentTokens = {
      input: 0,
      output: 0,
      cacheRead: 0,
      billable: 0,
      total: 0,
      cacheHitRate: 0,
    };

    const combinedModelMap = new Map();
    for (const m of rootEntry.parsed.byModel) {
      combinedModelMap.set(m.label, { ...m, directSteps: m.steps, subagentSteps: 0 });
    }

    for (const sub of subagents) {
      subagentTokens.input += sub.tokens.input;
      subagentTokens.output += sub.tokens.output;
      subagentTokens.cacheRead += sub.tokens.cacheRead;
      subagentTokens.billable += sub.tokens.billable;
      subagentTokens.total += sub.tokens.total;

      const subEntry = readTranscriptCached(
        brainDir,
        sub.conversationId,
        lookup,
        sub.activeModel?.label || fallbackModel
      );
      for (const m of subEntry.parsed.byModel) {
        let cm = combinedModelMap.get(m.label);
        if (!cm) {
          cm = {
            modelId: m.modelId,
            label: m.label,
            familyId: m.familyId,
            familyName: m.familyName,
            steps: 0,
            directSteps: 0,
            subagentSteps: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            billableTokens: 0,
            totalTokens: 0,
            lastUsedAt: m.lastUsedAt,
          };
          combinedModelMap.set(m.label, cm);
        }
        cm.steps += m.steps;
        cm.subagentSteps += m.steps;
        cm.inputTokens += m.inputTokens;
        cm.outputTokens += m.outputTokens;
        cm.cacheReadTokens += m.cacheReadTokens;
        cm.billableTokens += m.billableTokens;
        cm.totalTokens += m.totalTokens;
        if (m.lastUsedAt && (!cm.lastUsedAt || m.lastUsedAt > cm.lastUsedAt)) {
          cm.lastUsedAt = m.lastUsedAt;
        }
      }
    }

    const subPromptTotal = subagentTokens.input + subagentTokens.cacheRead;
    subagentTokens.cacheHitRate = subPromptTotal > 0 ? (subagentTokens.cacheRead / subPromptTotal) * 100 : 0;

    const combinedTokens = {
      input: directTokens.input + subagentTokens.input,
      output: directTokens.output + subagentTokens.output,
      cacheRead: directTokens.cacheRead + subagentTokens.cacheRead,
      billable: directTokens.billable + subagentTokens.billable,
      total: directTokens.total + subagentTokens.total,
      cacheHitRate: 0,
    };
    const combinedPromptTotal = combinedTokens.input + combinedTokens.cacheRead;
    combinedTokens.cacheHitRate =
      combinedPromptTotal > 0 ? (combinedTokens.cacheRead / combinedPromptTotal) * 100 : 0;

    const byModelCombined = [...combinedModelMap.values()]
      .map((m) => ({
        ...m,
        sharePercent: combinedTokens.total > 0 ? (m.totalTokens / combinedTokens.total) * 100 : 0,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      treeKey: keyParts.join(';'),
      conversation: {
        id: rootConvId,
        validId: true,
        exists: rootEntry.exists,
        totalSteps: rootEntry.parsed.totalSteps,
        subagentSteps: subagents.reduce((acc, s) => acc + s.steps, 0),
        userTurns: rootEntry.parsed.userTurns,
        firstStepAt: rootEntry.parsed.firstStepAt,
        lastStepAt: rootEntry.parsed.lastStepAt,
        activityState: rootEntry.parsed.activityState,
        activeModel: rootEntry.parsed.activeModel,
        directTokens,
        subagentTokens,
        combinedTokens,
        byModel: byModelCombined,
        subagents,
        recentSteps: rootEntry.parsed.recentSteps,
      },
    };
  }

  function scanRecentConversations(brainDir, lookup, fallbackModel) {
    if (!brainDir || !existsSync(brainDir)) {
      return { recentConversations: [], rollup: { totalConversations: 0, totalSteps: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
    }
    let entries = [];
    try {
      for (const name of readdirSync(brainDir)) {
        if (!ID_RE.test(name)) continue;
        const tPath = join(brainDir, name, '.system_generated', 'logs', 'transcript.jsonl');
        const st = statKey(tPath);
        if (st.exists) {
          entries.push({ id: name, mtimeMs: st.mtimeMs });
        }
      }
    } catch {
      return { recentConversations: [], rollup: { totalConversations: 0, totalSteps: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
    }

    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const top = entries.slice(0, RECENT_CONVS_LIMIT);

    const recentConversations = [];
    const rollup = {
      totalConversations: entries.length,
      scannedConversations: top.length,
      totalSteps: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    };

    for (const item of top) {
      const tr = readTranscriptCached(brainDir, item.id, lookup, fallbackModel);
      rollup.totalSteps += tr.parsed.totalSteps;
      rollup.totalTokens += tr.parsed.tokens.total;
      rollup.inputTokens += tr.parsed.tokens.input;
      rollup.outputTokens += tr.parsed.tokens.output;
      rollup.cacheReadTokens += tr.parsed.tokens.cacheRead;

      recentConversations.push({
        id: item.id,
        shortId: item.id.slice(0, 8),
        mtimeMs: item.mtimeMs,
        lastStepAt: tr.parsed.lastStepAt,
        steps: tr.parsed.totalSteps,
        activeModel: tr.parsed.activeModel.label,
        totalTokens: tr.parsed.tokens.total,
      });
    }

    return { recentConversations, rollup };
  }

  async function getQuotaSnapshot(nowMs) {
    try {
      const raw = await fetchUserStatus();
      const parsed = parseQuotaData(raw, nowMs);
      if (parsed.available) {
        lastGoodQuota = parsed;
        return parsed;
      }
    } catch (err) {
      if (lastGoodQuota) {
        return {
          ...lastGoodQuota,
          stale: true,
          error: err?.message || 'Language server unreachable',
        };
      }
      return {
        available: false,
        stale: false,
        error: err?.message || 'Language server unreachable',
        userTier: null,
        plan: null,
        defaultModel: formatModelSlug('default'),
        lookup: null,
        models: [],
        families: [],
        pools: [],
      };
    }
    return parseQuotaData(null, nowMs);
  }

  async function getSnapshot({ conversationId = '', etag = '', nowMs = Date.now() } = {}) {
    const quota = await getQuotaSnapshot(nowMs);
    const lookup = quota.lookup || null;
    const fallbackModel = quota.defaultModel?.label || 'Default Model';

    const trimmedConv = typeof conversationId === 'string' ? conversationId.trim() : '';

    // Reject path traversal or malformed IDs immediately
    if (trimmedConv && !ID_RE.test(trimmedConv)) {
      return {
        timestampMs: nowMs,
        refreshIntervalMs: 5000,
        etag: `invalid|${nowMs}`,
        quota: stripInternalLookup(quota),
        conversation: {
          id: trimmedConv,
          validId: false,
          exists: false,
          error: 'Invalid conversation ID format',
          totalSteps: 0,
          subagentSteps: 0,
          userTurns: 0,
          activeModel: quota.defaultModel,
          directTokens: { input: 0, output: 0, cacheRead: 0, billable: 0, total: 0, cacheHitRate: 0 },
          subagentTokens: { input: 0, output: 0, cacheRead: 0, billable: 0, total: 0, cacheHitRate: 0 },
          combinedTokens: { input: 0, output: 0, cacheRead: 0, billable: 0, total: 0, cacheHitRate: 0 },
          byModel: [],
          subagents: [],
          recentSteps: [],
        },
        recentConversations: [],
        rollup: null,
      };
    }

    const { brainDir } = findBrainDirForConv(trimmedConv);
    const { recentConversations, rollup } = scanRecentConversations(brainDir, lookup, fallbackModel);

    // If no conversationId was provided, pick the most recent one from brainDir
    const effectiveConvId = trimmedConv || recentConversations[0]?.id || '';

    let tree;
    if (effectiveConvId && brainDir) {
      tree = collectConversationTree(brainDir, effectiveConvId, lookup, fallbackModel);
    } else {
      tree = {
        treeKey: 'none',
        conversation: {
          id: effectiveConvId || null,
          validId: true,
          exists: false,
          totalSteps: 0,
          subagentSteps: 0,
          userTurns: 0,
          firstStepAt: null,
          lastStepAt: null,
          activityState: 'idle',
          activeModel: quota.defaultModel,
          directTokens: { input: 0, output: 0, cacheRead: 0, billable: 0, total: 0, cacheHitRate: 0 },
          subagentTokens: { input: 0, output: 0, cacheRead: 0, billable: 0, total: 0, cacheHitRate: 0 },
          combinedTokens: { input: 0, output: 0, cacheRead: 0, billable: 0, total: 0, cacheHitRate: 0 },
          byModel: [],
          subagents: [],
          recentSteps: [],
        },
      };
    }

    // Match the active conversation model against quota models/families so UI can spotlight its exact quota
    const activeModelInfo = tree.conversation.activeModel || quota.defaultModel;
    const activeQuotaModel =
      quota.models.find(
        (m) =>
          m.modelId === activeModelInfo.modelId ||
          m.label.toLowerCase() === activeModelInfo.label.toLowerCase()
      ) ||
      quota.families.find((f) => f.familyId === activeModelInfo.familyId) ||
      null;

    tree.conversation.activeModelQuota = activeQuotaModel
      ? {
          hasQuota: activeQuotaModel.hasQuota,
          remainingFraction: activeQuotaModel.remainingFraction,
          remainingPercent: activeQuotaModel.remainingPercent,
          usedPercent: activeQuotaModel.usedPercent,
          resetTime: activeQuotaModel.resetTime,
          resetInMs: activeQuotaModel.resetInMs,
          status: activeQuotaModel.status,
        }
      : null;

    const quotaFingerprint = quota.available
      ? quota.families
          .map((f) => `${f.familyId}:${f.remainingFraction ?? 'u'}:${f.resetTime ?? ''}`)
          .join(',') + `|${quota.plan?.availablePromptCredits}:${quota.plan?.availableFlowCredits}|${quota.stale}`
      : `unavail:${quota.error}`;

    const computedEtag = `${effectiveConvId}|${tree.treeKey}|${quotaFingerprint}`;

    if (etag && etag === computedEtag) {
      return {
        unchanged: true,
        etag: computedEtag,
        conversationId: effectiveConvId || null,
        timestampMs: nowMs,
      };
    }

    return {
      timestampMs: nowMs,
      refreshIntervalMs: 5000,
      etag: computedEtag,
      conversationId: effectiveConvId || null,
      quota: stripInternalLookup(quota),
      conversation: tree.conversation,
      recentConversations,
      rollup,
    };
  }

  return { getSnapshot };
}

function stripInternalLookup(quota) {
  const { lookup, ...rest } = quota;
  return rest;
}
