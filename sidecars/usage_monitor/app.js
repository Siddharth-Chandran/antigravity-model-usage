/*
 * Antigravity Model Usage sidecar frontend controller.
 *
 * - Polls GET /api/usage every 5,000 ms (5 seconds) with ETag short-circuiting.
 * - Pauses automatically when hidden (visibilitychange) and resumes on focus.
 * - Supports instant toggling between Full Dashboard mode and Minimal mode (persisted in localStorage).
 */
(() => {
  const POLL_INTERVAL_MS = 5000;
  const MINIMAL_STORAGE_KEY = 'agy_model_usage_minimal';

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);

  const state = {
    minimal: loadMinimalPreference(),
    paused: false,
    showAllVariants: false,
    selectedConversationId: params.get('conversationId') || '',
    etag: '',
    snapshot: null,
    lastFetchOkMs: 0,
    inFlight: false,
    timerId: null,
  };

  function loadMinimalPreference() {
    if (params.get('mode') === 'minimal') return true;
    if (params.get('mode') === 'full') return false;
    try {
      return window.localStorage.getItem(MINIMAL_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function saveMinimalPreference(val) {
    try {
      window.localStorage.setItem(MINIMAL_STORAGE_KEY, val ? '1' : '0');
    } catch {
      // Ignore storage errors in sandboxed iframes
    }
  }

  function hostConversationId() {
    return state.selectedConversationId || window.sidecar?.conversationId || params.get('conversationId') || '';
  }

  // Sync light/dark theme attribute from host's --background luminance
  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #0f1115)';
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3) {
      const scale = computed.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const theme = lum > 0.55 ? 'light' : 'dark';
      if (document.documentElement.dataset.theme !== theme) {
        document.documentElement.dataset.theme = theme;
      }
    }
  }
  syncThemeScheme();
  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // Formatting utilities
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtCompact(num) {
    const n = Number(num) || 0;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
    return String(n);
  }

  function fmtExact(num) {
    return (Number(num) || 0).toLocaleString();
  }

  function fmtPercent(pct) {
    if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'Unlimited';
    if (pct <= 0) return '0%';
    if (pct >= 99.95 && pct < 100) return '99.9%';
    return `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%`;
  }

  function fmtCountdown(resetTimeIso) {
    if (!resetTimeIso) return 'No reset timer';
    const targetMs = Date.parse(resetTimeIso);
    if (!Number.isFinite(targetMs)) return '';
    const diffMs = targetMs - Date.now();
    if (diffMs <= 0) return 'Resetting now';
    const totalSec = Math.floor(diffMs / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (days > 0) return `Resets in ${days}d ${hours}h`;
    if (hours > 0) return `Resets in ${hours}h ${mins}m`;
    if (mins > 0) return `Resets in ${mins}m ${secs}s`;
    return `Resets in ${secs}s`;
  }

  function applyMinimalModeUI() {
    document.body.classList.toggle('minimal-mode', state.minimal);
    const btn = $('mode-toggle');
    if (btn) {
      btn.setAttribute('aria-pressed', state.minimal ? 'true' : 'false');
      btn.textContent = state.minimal ? 'Minimal: On' : 'Minimal';
    }
    if (state.snapshot) renderQuotaSection(state.snapshot);
  }

  function applyPauseUI() {
    const pill = $('live-pill');
    const liveText = $('live-text');
    const pauseBtn = $('pause-toggle');
    const iconPath = $('pause-icon-path');

    if (state.paused) {
      pill.classList.add('paused');
      liveText.textContent = 'Paused';
      pauseBtn.setAttribute('aria-pressed', 'true');
      pauseBtn.setAttribute('title', 'Resume 5-second auto-refresh');
      // Play triangle icon
      iconPath.setAttribute('d', 'M5 3.5l7 4.5-7 4.5V3.5z');
    } else {
      pill.classList.remove('paused');
      liveText.textContent = 'Live · 5s';
      pauseBtn.setAttribute('aria-pressed', 'false');
      pauseBtn.setAttribute('title', 'Pause 5-second auto-refresh');
      // Pause bars icon
      iconPath.setAttribute('d', 'M5 3.5h2v9H5zm4 0h2v9H9z');
    }
  }

  function renderActiveModelCard(snap) {
    const conv = snap.conversation || {};
    const activeModel = conv.activeModel || snap.quota?.defaultModel || { label: 'Default Model' };
    const q = conv.activeModelQuota;

    $('active-model-name').textContent = activeModel.label || 'Default Model';

    const actBadge = $('conv-activity-badge');
    if (conv.activityState === 'working') {
      actBadge.textContent = 'Active Turn';
      actBadge.className = 'status-badge working';
    } else {
      actBadge.textContent = conv.exists ? 'Ready' : 'Waiting';
      actBadge.className = 'status-badge idle';
    }

    const bar = $('active-model-bar');
    if (q && q.hasQuota) {
      const remPct = Math.max(0, Math.min(100, q.remainingPercent ?? 0));
      const usedPct = Math.max(0, Math.min(100, q.usedPercent ?? 0));
      $('active-model-quota-num').textContent = `${fmtPercent(remPct)} left`;
      bar.style.width = `${remPct}%`;
      bar.className = `progress-fill ${q.status || 'healthy'}`;
      $('active-model-used').textContent = `${fmtPercent(usedPct)} used`;
      $('active-model-reset').textContent = fmtCountdown(q.resetTime);
      $('active-model-reset').title = q.resetTime ? `Resets at ${new Date(q.resetTime).toLocaleString()}` : '';
    } else if (snap.quota?.available) {
      $('active-model-quota-num').textContent = 'Unlimited';
      bar.style.width = '100%';
      bar.className = 'progress-fill unlimited';
      $('active-model-used').textContent = 'No rate-limit cap reported';
      $('active-model-reset').textContent = '';
    } else {
      $('active-model-quota-num').textContent = 'Quota offline';
      bar.style.width = '0%';
      bar.className = 'progress-fill warning';
      $('active-model-used').textContent = 'Language Server status unavailable';
      $('active-model-reset').textContent = '';
    }
  }

  function renderConversationSection(snap) {
    const conv = snap.conversation || {};
    const comb = conv.combinedTokens || { input: 0, output: 0, cacheRead: 0, billable: 0, total: 0, cacheHitRate: 0 };
    const totalSteps = (conv.totalSteps || 0) + (conv.subagentSteps || 0);
    const subCount = Array.isArray(conv.subagents) ? conv.subagents.length : 0;

    $('conv-steps-badge').textContent =
      subCount > 0 ? `${conv.totalSteps || 0} + ${conv.subagentSteps || 0} sub steps` : `${totalSteps} steps`;

    $('conv-empty-notice').classList.toggle('hidden', Boolean(conv.exists && totalSteps > 0));

    $('tok-total').textContent = fmtCompact(comb.total);
    $('tok-total').title = `${fmtExact(comb.total)} total tokens`;
    $('tok-billable').textContent = `${fmtCompact(comb.billable)} uncached`;

    $('tok-input').textContent = fmtCompact(comb.input);
    $('tok-input').title = `${fmtExact(comb.input)} input tokens`;
    $('tok-turns').textContent = `${conv.userTurns || 0} user turns`;

    $('tok-output').textContent = fmtCompact(comb.output);
    $('tok-output').title = `${fmtExact(comb.output)} output tokens`;
    $('tok-subagents-count').textContent = `${subCount} subagent${subCount === 1 ? '' : 's'}`;

    $('tok-cache').textContent = fmtCompact(comb.cacheRead);
    $('tok-cache').title = `${fmtExact(comb.cacheRead)} cached tokens read`;
    $('tok-cache-rate').textContent = `${(comb.cacheHitRate || 0).toFixed(1)}% hit rate`;

    $('min-conv-meta').textContent = `${totalSteps} steps · ${conv.userTurns || 0} user turns · ${subCount} subagents`;

    // Populate conversation selector dropdown
    const select = $('conv-select');
    const recent = Array.isArray(snap.recentConversations) ? snap.recentConversations : [];
    const currentId = snap.conversationId || '';
    if (select) {
      const optionsHtml = [];
      const hostId = window.sidecar?.conversationId || params.get('conversationId') || '';
      if (hostId && !recent.some((r) => r.id === hostId)) {
        optionsHtml.push(
          `<option value="${esc(hostId)}"${currentId === hostId ? ' selected' : ''}>Current (${esc(hostId.slice(0, 8))})</option>`
        );
      }
      for (const r of recent) {
        const isHost = r.id === hostId;
        const prefix = isHost ? 'Current' : r.shortId;
        const label = `${prefix} · ${fmtCompact(r.totalTokens)} tok (${r.steps} steps)`;
        optionsHtml.push(
          `<option value="${esc(r.id)}"${r.id === currentId ? ' selected' : ''}>${esc(label)}</option>`
        );
      }
      if (optionsHtml.length > 0) {
        select.innerHTML = optionsHtml.join('');
      }
    }

    // Per-Model table
    const byModel = Array.isArray(conv.byModel) ? conv.byModel : [];
    const byModelWrap = $('by-model-wrap');
    const byModelTbody = $('by-model-tbody');
    if (byModel.length > 0) {
      byModelWrap.classList.remove('hidden');
      byModelTbody.innerHTML = byModel
        .map(
          (m) => `
          <tr>
            <td><strong>${esc(m.label)}</strong></td>
            <td class="num">${m.steps}</td>
            <td class="num" title="${esc(fmtExact(m.inputTokens))}">${fmtCompact(m.inputTokens)}</td>
            <td class="num" title="${esc(fmtExact(m.outputTokens))}">${fmtCompact(m.outputTokens)}</td>
            <td class="num" title="${esc(fmtExact(m.cacheReadTokens))}">${fmtCompact(m.cacheReadTokens)}</td>
            <td class="num" title="${esc(fmtExact(m.totalTokens))}"><strong>${fmtCompact(m.totalTokens)}</strong></td>
          </tr>`
        )
        .join('');
    } else {
      byModelWrap.classList.add('hidden');
      byModelTbody.innerHTML = '';
    }

    // Subagents table
    const subagents = Array.isArray(conv.subagents) ? conv.subagents : [];
    const subWrap = $('subagents-wrap');
    const subTbody = $('subagents-tbody');
    if (subagents.length > 0) {
      subWrap.classList.remove('hidden');
      subTbody.innerHTML = subagents
        .map(
          (s) => `
          <tr>
            <td>
              <strong>${esc(s.role)}</strong>
              <span class="meta-text">(${esc(s.typeName)})</span>
            </td>
            <td>${esc(s.activeModel?.label || s.requestedModel || 'inherit')}</td>
            <td class="num">${s.steps}</td>
            <td class="num" title="${esc(fmtExact(s.tokens?.total || 0))}"><strong>${fmtCompact(s.tokens?.total || 0)}</strong></td>
          </tr>`
        )
        .join('');
    } else {
      subWrap.classList.add('hidden');
      subTbody.innerHTML = '';
    }

    // Recent turns timeline
    const recentSteps = Array.isArray(conv.recentSteps) ? conv.recentSteps : [];
    const detailsEl = $('recent-steps-details');
    const stepsTbody = $('recent-steps-tbody');
    if (recentSteps.length > 0) {
      detailsEl.classList.remove('hidden');
      $('recent-steps-count').textContent = `Last ${recentSteps.length} planner steps`;
      stepsTbody.innerHTML = recentSteps
        .map(
          (st) => `
          <tr>
            <td class="mono">#${st.stepIndex}</td>
            <td>${esc(st.modelLabel)}</td>
            <td class="num">${fmtCompact(st.inputTokens)}</td>
            <td class="num">${fmtCompact(st.outputTokens)}</td>
            <td class="num">${fmtCompact(st.cacheReadTokens)}</td>
            <td class="meta-text">${esc((st.toolNames || []).slice(0, 3).join(', ') || 'reply')}</td>
          </tr>`
        )
        .join('');
    } else {
      detailsEl.classList.add('hidden');
      stepsTbody.innerHTML = '';
    }
  }

  function renderQuotaSection(snap) {
    const quota = snap.quota || {};
    const activeFamilyId = snap.conversation?.activeModel?.familyId || '';
    const activeModelId = snap.conversation?.activeModel?.modelId || '';

    $('tier-badge').textContent = quota.userTier?.name || quota.plan?.planName || 'Local';

    const creditsBar = $('plan-credits-bar');
    if (quota.plan && (quota.plan.availablePromptCredits > 0 || quota.plan.availableFlowCredits > 0)) {
      creditsBar.classList.remove('hidden');
      $('credits-prompt').textContent = fmtExact(quota.plan.availablePromptCredits);
      $('credits-flow').textContent = fmtExact(quota.plan.availableFlowCredits);
    } else {
      creditsBar.classList.add('hidden');
    }

    const listEl = $('quota-list');
    if (!quota.available) {
      listEl.innerHTML = `<div class="empty-inline">Account quota data unavailable (${esc(quota.error || 'Language Server offline')}).</div>`;
      return;
    }

    if (state.showAllVariants && !state.minimal) {
      const models = Array.isArray(quota.models) ? quota.models : [];
      listEl.innerHTML = models
        .map((m) => {
          const isActive = m.modelId === activeModelId;
          const remPct = m.hasQuota ? Math.max(0, Math.min(100, m.remainingPercent ?? 0)) : 100;
          return `
            <div class="quota-row" role="listitem">
              <div class="quota-row-top">
                <div class="quota-name-wrap">
                  <span class="quota-name">${esc(m.label)}</span>
                  ${isActive ? '<span class="quota-active-tag">ACTIVE</span>' : ''}
                </div>
                <div class="quota-right">
                  <span class="quota-pct">${m.hasQuota ? `${fmtPercent(remPct)} left` : 'Unlimited'}</span>
                  <span class="quota-reset" title="${esc(m.resetTime || '')}">${esc(fmtCountdown(m.resetTime))}</span>
                </div>
              </div>
              <div class="progress-track">
                <div class="progress-fill ${esc(m.status)}" style="width: ${remPct}%"></div>
              </div>
            </div>`;
        })
        .join('');
      return;
    }

    let families = Array.isArray(quota.families) ? quota.families : [];
    if (state.minimal) {
      // In Minimal Mode, prioritize active family + families with used quota (< 100% remaining)
      const nonFull = families.filter(
        (f) => f.familyId === activeFamilyId || (f.hasQuota && f.remainingFraction < 0.999)
      );
      families = nonFull.length > 0 ? nonFull : families.slice(0, 3);
    }

    listEl.innerHTML = families
      .map((fam) => {
        const isActive = fam.familyId === activeFamilyId;
        const remPct = fam.hasQuota ? Math.max(0, Math.min(100, fam.remainingPercent ?? 0)) : 100;
        const usedPct = fam.hasQuota ? Math.max(0, Math.min(100, fam.usedPercent ?? 0)) : 0;
        const sharedHint =
          !state.minimal && Array.isArray(fam.sharedWith) && fam.sharedWith.length > 0
            ? `Shares quota pool with ${fam.sharedWith.join(', ')}`
            : '';
        const variantsHtml =
          !state.minimal && Array.isArray(fam.variants) && fam.variants.length > 1
            ? `<div class="variant-pills">${fam.variants
                .map((v) => `<span class="variant-pill">${esc(v.thinkingLevel)}</span>`)
                .join('')}</div>`
            : '';

        return `
          <div class="quota-row" role="listitem">
            <div class="quota-row-top">
              <div class="quota-name-wrap">
                <span class="quota-name">${esc(fam.familyName)}</span>
                ${isActive ? '<span class="quota-active-tag">ACTIVE</span>' : ''}
              </div>
              <div class="quota-right">
                <span class="quota-pct">${fam.hasQuota ? `${fmtPercent(remPct)} left` : 'Unlimited'}</span>
                <span class="quota-reset" title="${esc(fam.resetTime || '')}">${esc(fmtCountdown(fam.resetTime))}</span>
              </div>
            </div>
            <div class="progress-track">
              <div class="progress-fill ${esc(fam.status)}" style="width: ${remPct}%"></div>
            </div>
            ${
              !state.minimal
                ? `<div class="quota-sub">
                    <span>${fam.hasQuota ? `${fmtPercent(usedPct)} used` : 'No quota limit'}</span>
                    <span>${esc(sharedHint)}</span>
                  </div>`
                : ''
            }
            ${variantsHtml}
          </div>`;
      })
      .join('');
  }

  function renderRollupSection(snap) {
    const rollup = snap.rollup;
    const sec = $('rollup-section');
    if (!rollup) {
      sec.classList.add('hidden');
      return;
    }
    sec.classList.remove('hidden');
    $('rollup-conv-count').textContent = `${rollup.scannedConversations || 0} recent convs`;
    $('rollup-total').textContent = fmtCompact(rollup.totalTokens);
    $('rollup-total').title = `${fmtExact(rollup.totalTokens)} total tokens across recent conversations`;
    $('rollup-inout').textContent = `${fmtCompact(rollup.inputTokens)} / ${fmtCompact(rollup.outputTokens)}`;
    $('rollup-cache').textContent = fmtCompact(rollup.cacheReadTokens);
    $('rollup-steps').textContent = fmtExact(rollup.totalSteps);
  }

  function updateFreshnessLabel() {
    const el = $('last-updated');
    if (!state.lastFetchOkMs) return;
    const secAgo = Math.max(0, Math.floor((Date.now() - state.lastFetchOkMs) / 1000));
    const suffix = secAgo <= 1 ? 'just now' : `${secAgo}s ago`;
    el.textContent = `Updated ${suffix} · auto-refresh every 5s`;

    // Also tick live reset countdowns without requiring a backend change
    if (state.snapshot?.conversation?.activeModelQuota?.resetTime) {
      $('active-model-reset').textContent = fmtCountdown(
        state.snapshot.conversation.activeModelQuota.resetTime
      );
    }
  }

  async function pollUsage({ force = false } = {}) {
    if (state.inFlight) return;
    if (state.paused && !force) return;
    if (document.hidden && !force) return;

    state.inFlight = true;
    try {
      const convId = hostConversationId();
      const qs = new URLSearchParams();
      if (convId) qs.set('conversationId', convId);
      if (!force && state.etag) qs.set('etag', state.etag);

      const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : window.fetch;
      const res = await fetcher(`/api/usage?${qs.toString()}`, { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      state.lastFetchOkMs = Date.now();
      $('error-banner').classList.add('hidden');
      $('live-pill').classList.toggle('stale', Boolean(data.quota?.stale));

      if (!data.unchanged) {
        state.etag = data.etag || '';
        state.snapshot = data;
        renderActiveModelCard(data);
        renderConversationSection(data);
        renderQuotaSection(data);
        renderRollupSection(data);
      }
      updateFreshnessLabel();
    } catch (err) {
      const banner = $('error-banner');
      banner.textContent = `Live refresh warning: ${err?.message || 'Unable to reach sidecar'}. Retrying in 5s…`;
      banner.classList.remove('hidden');
      $('live-pill').classList.add('stale');
    } finally {
      state.inFlight = false;
    }
  }

  // Wire up interactive controls
  $('mode-toggle')?.addEventListener('click', () => {
    state.minimal = !state.minimal;
    saveMinimalPreference(state.minimal);
    applyMinimalModeUI();
  });

  $('pause-toggle')?.addEventListener('click', () => {
    state.paused = !state.paused;
    applyPauseUI();
    if (!state.paused) pollUsage({ force: true });
  });

  $('refresh-btn')?.addEventListener('click', () => {
    pollUsage({ force: true });
  });

  $('variants-toggle')?.addEventListener('click', () => {
    state.showAllVariants = !state.showAllVariants;
    const btn = $('variants-toggle');
    btn.setAttribute('aria-pressed', state.showAllVariants ? 'true' : 'false');
    btn.textContent = state.showAllVariants ? 'Group by family' : 'Show all variants';
    if (state.snapshot) renderQuotaSection(state.snapshot);
  });

  $('conv-select')?.addEventListener('change', (e) => {
    state.selectedConversationId = e.target.value || '';
    state.etag = '';
    pollUsage({ force: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.paused) {
      pollUsage({ force: false });
    }
  });

  // Initialize UI and start 5-second polling timer
  applyMinimalModeUI();
  applyPauseUI();
  pollUsage({ force: true });
  state.timerId = window.setInterval(() => pollUsage({ force: false }), POLL_INTERVAL_MS);
  window.setInterval(updateFreshnessLabel, 1000);
})();
