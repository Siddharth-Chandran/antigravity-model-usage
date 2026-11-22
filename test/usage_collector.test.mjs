import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatModelSlug,
  buildModelLookup,
  parseQuotaData,
  parseTranscriptText,
  createUsageCollector,
} from '../sidecars/usage_monitor/usage_collector.mjs';

const SAMPLE_USER_STATUS = {
  userStatus: {
    name: 'Example User',
    userTier: {
      id: 'g1-pro-tier',
      name: 'Google AI Pro',
      description: 'Google AI Pro',
    },
    planStatus: {
      planInfo: {
        teamsTier: 'TEAMS_TIER_PRO',
        planName: 'Pro',
        monthlyPromptCredits: 50000,
        monthlyFlowCredits: 150000,
      },
      availablePromptCredits: 500,
      availableFlowCredits: 100,
    },
    cascadeModelConfigData: {
      defaultOverrideModelConfig: {
        modelOrAlias: {
          model: 'MODEL_PLACEHOLDER_M532',
        },
      },
      groupedModels: {
        'gemini-4-argon': {
          displayName: 'Gemini 4 Argon',
          supportedThinkingLevels: [
            { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
            { thinkingSuffix: 'medium', thinkingDisplayName: 'Medium' },
            { thinkingSuffix: 'high', thinkingDisplayName: 'High' },
          ],
        },
        'gemini-4-neon': {
          displayName: 'Gemini 4 Neon',
          supportedThinkingLevels: [
            { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
            { thinkingSuffix: 'high', thinkingDisplayName: 'High' },
            { thinkingSuffix: 'xhigh', thinkingDisplayName: 'Extra High' },
          ],
        },
        'claude-opus-5-5': {
          displayName: 'Claude Opus 5.5',
          supportedThinkingLevels: [
            { thinkingSuffix: 'high', thinkingDisplayName: 'High' },
          ],
        },
      },
      clientModelConfigs: [
        {
          label: 'Gemini 4 Neon (High)',
          modelId: 'gemini-4-neon-high',
          modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' },
          quotaInfo: {
            remainingFraction: 0.85,
            resetTime: '2026-11-22T15:00:00Z',
          },
        },
        {
          label: 'Gemini 4 Neon (XHigh)',
          modelId: 'gemini-4-neon-xhigh',
          modelOrAlias: { model: 'MODEL_PLACEHOLDER_M535' },
          quotaInfo: {
            remainingFraction: 0.85,
            resetTime: '2026-11-22T15:00:00Z',
          },
        },
        {
          label: 'Gemini 4 Argon (High)',
          modelId: 'gemini-4-argon-high',
          modelOrAlias: { model: 'MODEL_PLACEHOLDER_M417' },
          quotaInfo: {
            remainingFraction: 0.91058,
            resetTime: '2026-11-29T06:46:27Z',
          },
        },
        {
          label: 'Gemini 4 Argon (Low)',
          modelId: 'gemini-4-argon-low',
          modelOrAlias: { model: 'MODEL_PLACEHOLDER_M419' },
          quotaInfo: {
            remainingFraction: 0.91058,
            resetTime: '2026-11-29T06:46:27Z',
          },
        },
        {
          label: 'Claude Opus 5.5 (High)',
          modelId: 'claude-opus-5-5-high',
          modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' },
          quotaInfo: {
            remainingFraction: 0,
            resetTime: '2026-11-22T13:00:00Z',
          },
        },
        {
          label: 'Gemini 4 Carbon',
          modelId: 'gemini-4-carbon',
          modelOrAlias: { model: 'MODEL_PLACEHOLDER_M670' },
          quotaInfo: {},
        },
      ],
    },
  },
};

test('formatModelSlug resolves known modelIds, placeholders, slugs with dots, and broken inputs', () => {
  const lookup = buildModelLookup(SAMPLE_USER_STATUS.userStatus.cascadeModelConfigData);

  const argon = formatModelSlug('gemini-4-argon-high', lookup);
  assert.equal(argon.label, 'Gemini 4 Argon (High)');
  assert.equal(argon.familyName, 'Gemini 4 Argon');
  assert.equal(argon.thinkingLevel, 'High');

  const byPlaceholder = formatModelSlug('MODEL_PLACEHOLDER_M532', lookup);
  assert.equal(byPlaceholder.label, 'Gemini 4 Neon (High)');
  assert.equal(byPlaceholder.modelId, 'gemini-4-neon-high');

  const claudeSlug = formatModelSlug('claude-opus-5-5-high', lookup);
  assert.equal(claudeSlug.label, 'Claude Opus 5.5 (High)');
  assert.equal(claudeSlug.familyName, 'Claude Opus 5.5');

  const unknownFlash = formatModelSlug('gemini-3.8-flash-xhigh', lookup);
  assert.equal(unknownFlash.label, 'Gemini 3.8 Flash (XHigh)');
  assert.equal(unknownFlash.familyName, 'Gemini 3.8 Flash');

  const brokenQuote = formatModelSlug('"', lookup);
  assert.equal(brokenQuote.label, 'Default Model');

  const empty = formatModelSlug('', lookup);
  assert.equal(empty.label, 'Default Model');
});

test('parseQuotaData handles normal fractions, 0 exhausted fraction, empty quotaInfo, and shared pools', () => {
  const nowMs = Date.parse('2026-11-22T12:00:00Z');
  const quota = parseQuotaData(SAMPLE_USER_STATUS, nowMs);

  assert.equal(quota.available, true);
  assert.equal(quota.userTier.name, 'Google AI Pro');
  assert.equal(quota.plan.planName, 'Pro');
  assert.equal(quota.plan.availablePromptCredits, 500);
  assert.equal(quota.plan.availableFlowCredits, 100);
  assert.equal(quota.defaultModel.label, 'Gemini 4 Neon (High)');

  // Check Argon family grouping
  const argonFam = quota.families.find((f) => f.familyName === 'Gemini 4 Argon');
  assert.ok(argonFam);
  assert.equal(argonFam.hasQuota, true);
  assert.equal(Math.round(argonFam.remainingPercent * 10) / 10, 91.1);
  assert.equal(Math.round(argonFam.usedPercent * 10) / 10, 8.9);
  assert.equal(argonFam.variants.length, 2);

  // Check zero remainingFraction (exhausted) is NOT treated as missing/unlimited
  const claudeFam = quota.families.find((f) => f.familyName === 'Claude Opus 5.5');
  assert.ok(claudeFam);
  assert.equal(claudeFam.hasQuota, true);
  assert.equal(claudeFam.remainingFraction, 0);
  assert.equal(claudeFam.remainingPercent, 0);
  assert.equal(claudeFam.usedPercent, 100);
  assert.equal(claudeFam.status, 'exhausted');
  assert.equal(claudeFam.resetInMs, 3600 * 1000);

  // Check empty quotaInfo ({}) is treated as unlimited / N/A
  const carbonFam = quota.families.find((f) => f.familyName === 'Gemini 4 Carbon');
  assert.ok(carbonFam);
  assert.equal(carbonFam.hasQuota, false);
  assert.equal(carbonFam.remainingFraction, null);
  assert.equal(carbonFam.remainingPercent, null);
  assert.equal(carbonFam.status, 'unlimited');
});

test('parseTranscriptText handles PLANNER_RESPONSE tokens, torn lines, version-dotted settings changes, and subagents', () => {
  const lookup = buildModelLookup(SAMPLE_USER_STATUS.userStatus.cascadeModelConfigData);
  const lines = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>Hello</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Argon (High) to Claude Opus 5.5 (High). No need to comment on this change.\n</USER_SETTINGS_CHANGE>',
    }),
    // Legacy step without .model field: should inherit Claude Opus 5.5 (High) from USER_SETTINGS_CHANGE
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      input_tokens: 1000,
      output_tokens: 250,
      cache_read_tokens: 4000,
      created_at: '2026-11-22T06:46:25Z',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: {
            Model: '"flash"',
            Role: '"Timeline Analyst"',
            TypeName: '"research"',
          },
        },
      ],
    }),
    JSON.stringify({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created At: 2026-11-22T12:16:36+05:30\nCreated the following subagent:\n{\n  "conversationId": "22222222-3333-4444-5555-666666666666"\n}\nThe subagent will send you a message.',
    }),
    // Modern step with explicit .model field
    JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'gemini-4-argon-high',
      input_tokens: 2000,
      output_tokens: 500,
      cache_read_tokens: 6000,
      created_at: '2026-11-22T06:47:00Z',
      tool_calls: [{ name: 'read_file' }],
    }),
    // Torn/corrupted final line being written right now
    '{"step_index": 4, "type": "PLANNER_RESPONSE", "input_tokens": 999',
  ].join('\n');

  const parsed = parseTranscriptText(lines, { lookup, fallbackModel: 'Gemini 4 Neon (High)' });

  assert.equal(parsed.totalSteps, 2);
  assert.equal(parsed.tokens.input, 3000);
  assert.equal(parsed.tokens.output, 750);
  assert.equal(parsed.tokens.cacheRead, 10000);
  assert.equal(parsed.tokens.total, 13750);
  assert.equal(parsed.activeModel.label, 'Gemini 4 Argon (High)');

  assert.equal(parsed.byModel.length, 2);
  const claudeEntry = parsed.byModel.find((m) => m.label === 'Claude Opus 5.5 (High)');
  assert.ok(claudeEntry);
  assert.equal(claudeEntry.inputTokens, 1000);
  assert.equal(claudeEntry.outputTokens, 250);
  assert.equal(claudeEntry.cacheReadTokens, 4000);

  const argonEntry = parsed.byModel.find((m) => m.label === 'Gemini 4 Argon (High)');
  assert.ok(argonEntry);
  assert.equal(argonEntry.inputTokens, 2000);
  assert.equal(argonEntry.outputTokens, 500);
  assert.equal(argonEntry.cacheReadTokens, 6000);

  // Subagent metadata extracted cleanly
  assert.equal(parsed.subagentRefs.length, 1);
  assert.equal(parsed.subagentRefs[0].conversationId, '22222222-3333-4444-5555-666666666666');
  assert.equal(parsed.subagentRefs[0].role, 'Timeline Analyst');
  assert.equal(parsed.subagentRefs[0].typeName, 'research');
  assert.equal(parsed.subagentRefs[0].requestedModel, 'flash');
});

test('createUsageCollector aggregates child subagents, swarm workers, prevents cycles, caches by mtime, and blocks path traversal', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-usage-test-'));
  try {
    const brainDir = join(tmpRoot, 'brain');
    const parentId = '11111111-2222-3333-4444-555555555555';
    const childId = '22222222-3333-4444-5555-666666666666';
    const swarmWorkerId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const parentLogs = join(brainDir, parentId, '.system_generated', 'logs');
    const parentSwarm = join(brainDir, parentId, '.system_generated', 'swarm');
    const childLogs = join(brainDir, childId, '.system_generated', 'logs');
    const workerLogs = join(brainDir, swarmWorkerId, '.system_generated', 'logs');

    mkdirSync(parentLogs, { recursive: true });
    mkdirSync(parentSwarm, { recursive: true });
    mkdirSync(childLogs, { recursive: true });
    mkdirSync(workerLogs, { recursive: true });

    // Parent invokes childId
    writeFileSync(
      join(parentLogs, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          model: 'gemini-4-argon-high',
          input_tokens: 5000,
          output_tokens: 500,
          cache_read_tokens: 15000,
          created_at: '2026-11-22T06:50:00Z',
          tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Code Reviewer', TypeName: 'self', Model: 'inherit' } }],
        }),
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          status: 'DONE',
          content: `Created the following subagent:\n{\n  "conversationId": "${childId}"\n}`,
        }),
      ].join('\n')
    );

    // Child transcript ALSO tries to reference parentId (cycle test!)
    writeFileSync(
      join(childLogs, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          model: 'gemini-4-argon-high',
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_tokens: 2000,
          created_at: '2026-11-22T06:51:00Z',
          tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Cycle Attempt' } }],
        }),
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          status: 'DONE',
          content: `Created the following subagent:\n{\n  "conversationId": "${parentId}"\n}`,
        }),
      ].join('\n')
    );

    // Swarm members.json adds a swarm worker
    writeFileSync(
      join(parentSwarm, 'members.json'),
      JSON.stringify({
        title: 'Test Swarm',
        members: {
          coordinator: { conversation_id: parentId, role: 'coordinator', model: 'gemini-4-argon-high' },
          'worker-1': { conversation_id: swarmWorkerId, role: 'worker', model: 'gemini-4-neon-high' },
        },
      })
    );

    writeFileSync(
      join(workerLogs, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'gemini-4-neon-high',
        input_tokens: 800,
        output_tokens: 200,
        cache_read_tokens: 1000,
        created_at: '2026-11-22T06:52:00Z',
      })
    );

    const collector = createUsageCollector({
      appDataDirs: () => [tmpRoot],
      fetchUserStatus: async () => SAMPLE_USER_STATUS,
    });

    const snap1 = await collector.getSnapshot({
      conversationId: parentId,
      nowMs: Date.parse('2026-11-22T12:00:00Z'),
    });

    assert.equal(snap1.unchanged, undefined);
    assert.ok(snap1.etag);
    assert.equal(snap1.conversation.id, parentId);
    assert.equal(snap1.conversation.exists, true);
    // Direct tokens on parent: 5000 + 500 + 15000 = 20500
    assert.equal(snap1.conversation.directTokens.total, 20500);
    // Child subagent tokens: 3500, swarm worker tokens: 2000 -> total combined = 26000
    assert.equal(snap1.conversation.subagents.length, 2);
    assert.equal(snap1.conversation.combinedTokens.total, 26000);

    // ETag short-circuit check
    const snap2 = await collector.getSnapshot({
      conversationId: parentId,
      etag: snap1.etag,
      nowMs: Date.parse('2026-11-22T12:00:05Z'),
    });
    assert.equal(snap2.unchanged, true);
    assert.equal(snap2.etag, snap1.etag);

    // Path traversal rejection check
    const traversal = await collector.getSnapshot({
      conversationId: '../../etc/passwd',
      nowMs: Date.parse('2026-11-22T12:00:05Z'),
    });
    assert.equal(traversal.conversation.validId, false);
    assert.equal(traversal.conversation.exists, false);

    // Brand-new conversation (UUID exists in parameter, no transcript file yet)
    const brandNewId = '99999999-8888-7777-6666-555555555555';
    const brandNewSnap = await collector.getSnapshot({
      conversationId: brandNewId,
      nowMs: Date.parse('2026-11-22T12:00:05Z'),
    });
    assert.equal(brandNewSnap.conversation.id, brandNewId);
    assert.equal(brandNewSnap.conversation.validId, true);
    assert.equal(brandNewSnap.conversation.exists, false);
    assert.equal(brandNewSnap.conversation.combinedTokens.total, 0);
    assert.equal(brandNewSnap.quota.available, true);

    // Omitted conversationId falls back to most recent conversation in brain/
    const autoResolved = await collector.getSnapshot({
      conversationId: '',
      nowMs: Date.parse('2026-11-22T12:00:05Z'),
    });
    assert.ok(autoResolved.conversationId);
    assert.equal(autoResolved.conversation.exists, true);
    assert.equal(autoResolved.recentConversations.length, 3);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('createUsageCollector degrades gracefully when Language Server is unreachable', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-usage-offline-'));
  try {
    let shouldFail = false;
    const collector = createUsageCollector({
      appDataDirs: () => [tmpRoot],
      fetchUserStatus: async () => {
        if (shouldFail) throw new Error('connect ECONNREFUSED 127.0.0.1:5387');
        return SAMPLE_USER_STATUS;
      },
    });

    // First call succeeds and populates lastGoodQuota
    const first = await collector.getSnapshot({ nowMs: Date.parse('2026-11-22T12:00:00Z') });
    assert.equal(first.quota.available, true);
    assert.equal(first.quota.stale, false);

    // Second call fails -> keeps lastGoodQuota with stale: true
    shouldFail = true;
    const second = await collector.getSnapshot({ nowMs: Date.parse('2026-11-22T12:00:05Z') });
    assert.equal(second.quota.available, true);
    assert.equal(second.quota.stale, true);
    assert.match(second.quota.error, /ECONNREFUSED/);

    // Fresh collector that fails on first call -> available: false, no crash
    const coldOfflineCollector = createUsageCollector({
      appDataDirs: () => [tmpRoot],
      fetchUserStatus: async () => {
        throw new Error('LS offline');
      },
    });
    const cold = await coldOfflineCollector.getSnapshot({ nowMs: Date.parse('2026-11-22T12:00:10Z') });
    assert.equal(cold.quota.available, false);
    assert.equal(cold.quota.stale, false);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
