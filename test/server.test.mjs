import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startUsageSidecarServer, checkIsMainModule } from '../sidecars/usage_monitor/main.mjs';
import { createUsageCollector } from '../sidecars/usage_monitor/usage_collector.mjs';
import { symlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

test('checkIsMainModule resolves relative paths and symlinks accurately', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agy-main-check-'));
  try {
    const realFile = join(tmpDir, 'real_main.mjs');
    const linkFile = join(tmpDir, 'link_main.mjs');
    writeFileSync(realFile, '// test');
    symlinkSync(realFile, linkFile);

    const metaUrl = pathToFileURL(realFile).href;
    assert.equal(checkIsMainModule(metaUrl, realFile), true);
    assert.equal(checkIsMainModule(metaUrl, linkFile), true);
    assert.equal(checkIsMainModule(metaUrl, join(tmpDir, 'other.mjs')), false);
    assert.equal(checkIsMainModule(metaUrl, ''), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sidecar HTTP server serves /api/usage, supports ETag unchanged responses, and serves static UI assets', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-sidecar-srv-'));
  let serverInstance = null;

  try {
    const convId = '11111111-2222-3333-4444-555555555555';
    const logsDir = join(tmpRoot, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'gemini-4-argon-high',
        input_tokens: 4200,
        output_tokens: 800,
        cache_read_tokens: 15000,
        created_at: '2026-11-22T07:00:00Z',
      })
    );

    const collector = createUsageCollector({
      appDataDirs: () => [tmpRoot],
      fetchUserStatus: async () => ({
        userStatus: {
          userTier: { id: 'pro', name: 'Google AI Pro' },
          planStatus: {
            planInfo: { planName: 'Pro', monthlyPromptCredits: 50000, monthlyFlowCredits: 150000 },
            availablePromptCredits: 480,
            availableFlowCredits: 95,
          },
          cascadeModelConfigData: {
            clientModelConfigs: [
              {
                label: 'Gemini 4 Argon (High)',
                modelId: 'gemini-4-argon-high',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M417' },
                quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-29T06:46:27Z' },
              },
            ],
          },
        },
      }),
    });

    serverInstance = await startUsageSidecarServer({
      collector,
      port: 0,
      defaultConversationId: convId,
      forceStandaloneHttp: true,
    });

    const port = serverInstance.port;
    assert.ok(port > 0);
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Test /api/usage initial poll
    const res1 = await fetch(`${baseUrl}/api/usage?conversationId=${convId}`);
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.refreshIntervalMs, 5000);
    assert.equal(data1.conversationId, convId);
    assert.equal(data1.conversation.combinedTokens.total, 20000);
    assert.equal(data1.quota.available, true);
    assert.equal(data1.quota.families[0].familyName, 'Gemini 4 Argon');
    assert.ok(data1.etag);

    // 2. Test /api/usage with matching ETag -> unchanged: true
    const res2 = await fetch(
      `${baseUrl}/api/usage?conversationId=${convId}&etag=${encodeURIComponent(data1.etag)}`
    );
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.unchanged, true);
    assert.equal(data2.etag, data1.etag);

    // 3. Test static assets (/, /styles.css, /app.js, /preload.js) and UI contract
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get('content-type') || '', /text\/html/);
    const htmlText = await htmlRes.text();
    assert.match(htmlText, /\/preload\.js/);
    assert.match(htmlText, /data-testid="usage-mode-toggle"/);
    assert.match(htmlText, /data-testid="usage-pause-toggle"/);
    assert.match(htmlText, /data-testid="usage-refresh-btn"/);
    assert.match(htmlText, /data-testid="usage-active-model-card"/);
    assert.match(htmlText, /data-testid="usage-quota-section"/);
    assert.match(htmlText, /data-testid="usage-conversation-section"/);
    assert.match(htmlText, /data-testid="usage-rollup-section"/);

    const cssRes = await fetch(`${baseUrl}/styles.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type') || '', /text\/css/);
    const cssText = await cssRes.text();
    assert.match(cssText, /--background/);
    assert.match(cssText, /minimal-mode/);

    const jsRes = await fetch(`${baseUrl}/app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type') || '', /javascript/);
    const jsText = await jsRes.text();
    assert.match(jsText, /5000/);
    assert.match(jsText, /agy_model_usage_minimal/);
    assert.match(jsText, /visibilitychange/);
  } finally {
    if (serverInstance?.close) {
      await serverInstance.close();
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
