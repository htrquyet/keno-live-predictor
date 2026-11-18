/* Vietlott Keno Bậc 2 — Chuyên Gia Dự Đoán 1 Cặp 2 Số [A, B] */

const STORAGE_CACHE_KEY = 'keno_pair_cached_draws_v3';

let appState = {
  schedule: null,
  recentDraws: [],
  syncDraws: [],
  analysis: null,
  lastSeenDrawId: null,
  soundEnabled: true,
  lastZeroTriggerMs: 0,
  customInitialized: false
};

const pad2 = (n) => String(n).padStart(2, '0');
const formatVnd = (n) => Number(n || 0).toLocaleString('vi-VN') + 'đ';

function playNotificationChime() {
  if (!appState.soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    [523.25, 659.25, 783.99].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.1);
      gain.gain.setValueAtTime(0.14, ctx.currentTime + idx * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.1 + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + idx * 0.1);
      osc.stop(ctx.currentTime + idx * 0.1 + 0.32);
    });
  } catch {
    // Ignore autoplay restriction
  }
}

function saveDrawsToLocalCache(draws) {
  if (!Array.isArray(draws) || draws.length === 0) return;
  try {
    localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(draws.slice(-1500)));
  } catch {
    // Ignore quota errors
  }
}

async function syncLocalCacheToServerIfNeeded(serverCount) {
  try {
    const raw = localStorage.getItem(STORAGE_CACHE_KEY);
    if (!raw) return;
    const cached = JSON.parse(raw);
    if (!Array.isArray(cached) || cached.length <= serverCount) return;
    await fetch('/api/client-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draws: cached })
    });
  } catch {
    // Ignore sync errors
  }
}

/* ==========================================================================
   1. RENDER LATEST KENO DRAW + RECONCILE WITH THAT DRAW'S PREDICTED PAIR
   ========================================================================== */
function renderLatestDraw(analysis) {
  const latest = analysis?.latestDraw;
  if (!latest) return;

  document.getElementById('latestDrawId').textContent = `Kỳ #${latest.drawId}`;
  document.getElementById('latestDrawMeta').textContent = `${latest.date} · ${latest.time}`;
  document.getElementById('sampleCountBadge').textContent = `Mẫu đối soát: ${analysis.totalHistoricalDraws} kỳ`;

  const btLatest = analysis.backtestHistory && analysis.backtestHistory[0];
  const predictedForLatest =
    btLatest && btLatest.drawId === latest.drawId ? btLatest.predictedPair : [];
  const predSet = new Set(predictedForLatest);

  document.getElementById('latestBallsGrid').innerHTML = latest.numbers
    .map(
      (n) => `
      <div class="keno-ball ${predSet.has(n) ? 'matched-ball' : ''}" title="${predSet.has(n) ? 'Trùng số trong cặp dự đoán!' : ''}">
        ${pad2(n)}
      </div>
    `
    )
    .join('');

  const banner = document.getElementById('latestReconcileBanner');
  if (btLatest && btLatest.drawId === latest.drawId) {
    const pairStr = btLatest.predictedLabels.join(' - ');
    if (btLatest.wonBac2) {
      banner.className = 'reconcile-banner hit2';
      banner.innerHTML = `🎉 <strong>NỔ TRỌN 2/2 BẬC 2!</strong> Cặp dự đoán <strong>[${pairStr}]</strong> trúng đủ cả 2 số ở kỳ #${latest.drawId} → Nhận <strong>+90.000đ</strong> (vé 10k)!`;
    } else if (btLatest.hitCount === 1) {
      banner.className = 'reconcile-banner';
      banner.innerHTML = `✅ <strong>Có mặt 1/2 số:</strong> Cặp dự đoán <strong>[${pairStr}]</strong> nổ số <strong>${pad2(btLatest.matchedNums[0])}</strong> ở kỳ #${latest.drawId}.`;
    } else {
      banner.className = 'reconcile-banner miss';
      banner.innerHTML = `⏭️ <strong>Chưa nổ:</strong> Cặp dự đoán <strong>[${pairStr}]</strong> (0/2 số) ở kỳ #${latest.drawId}. Chuỗi chờ 2/2 hiện tại: ${analysis.backtestSummary?.currentPairLoseStreak || 0} kỳ.`;
    }
  } else {
    banner.className = 'reconcile-banner miss';
    banner.textContent = 'Đang đồng bộ đối soát kỳ gần nhất...';
  }
}

/* ==========================================================================
   2. RENDER SINGLE PREDICTED PAIR [A, B] FOR NEXT DRAW
   ========================================================================== */
function renderPredictionShowcase(analysis) {
  if (!analysis || !analysis.prediction) return;
  const pred = analysis.prediction;
  const { pairLabels, numAStats, numBStats, pairStats, summary } = pred;

  document.getElementById('predNextDrawId').textContent = `#${analysis.nextDrawId}`;
  document.getElementById('pairHeroBallA').textContent = pairLabels[0];
  document.getElementById('pairHeroBallB').textContent = pairLabels[1];

  const modeSel = document.getElementById('modeSelect');
  if (modeSel.value !== analysis.mode) modeSel.value = analysis.mode;
  document.querySelectorAll('.mode-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === analysis.mode);
  });

  document.getElementById('predAlgoDesc').textContent =
    `${analysis.strategy?.label || ''} — ${analysis.strategy?.description || ''}`;
  document.getElementById('pairSelectionReason').textContent = pairStats.reason;

  const renderNumCard = (st, title) => `
    <div class="profile-title">${title} [${st.label}]</div>
    <div class="profile-row"><span>24 kỳ gần nhất:</span><strong>${st.f24}/24 (chuẩn 6.0)</strong></div>
    <div class="profile-row"><span>25 kỳ / 10 kỳ:</span><strong>${st.f25}/25 · ${st.f10}/10</strong></div>
    <div class="profile-row"><span>Tần suất toàn mẫu:</span><strong>${st.fAll} lần (${st.rateAll}%)</strong></div>
    <div class="profile-row"><span>Gan hiện tại:</span><strong>${st.gap} kỳ</strong></div>
  `;

  document.getElementById('pairNumACard').innerHTML = renderNumCard(numAStats, 'Số thứ nhất');
  document.getElementById('pairNumBCard').innerHTML = renderNumCard(numBStats, 'Số thứ hai');

  document.getElementById('pairMutualMeta').innerHTML = `
    <div class="profile-title">Cặp [${pairLabels[0]} - ${pairLabels[1]}]</div>
    <div class="profile-row"><span>Cùng nổ 2/2:</span><strong>${pairStats.coocCount} lần (${pairStats.coocRate}%)</strong></div>
    <div class="profile-row"><span>Chu kỳ TB của cặp:</span><strong>${pairStats.avgCycle ? pairStats.avgCycle + ' kỳ' : 'Chưa có'}</strong></div>
    <div class="profile-row"><span>Gan cặp hiện tại:</span><strong class="text-gold">${pairStats.pairGap} kỳ</strong></div>
    <div class="profile-row"><span>Chuẩn lý thuyết:</span><strong>6.01% (16.6 kỳ)</strong></div>
  `;

  document.getElementById('predKpiRow').innerHTML = `
    <div class="kpi-card">
      <span>Tỷ lệ nổ 2/2 (${summary.evaluatedDraws} kỳ)</span>
      <strong>${summary.hit2Rate}% (${summary.hit2Count} lần)</strong>
      <small>Chuẩn: 6.01% · z = ${summary.edge.z}</small>
    </div>
    <div class="kpi-card">
      <span>Hoàn trả Bậc 2 (RTP x9)</span>
      <strong class="text-gold">${summary.bac2Rtp}%</strong>
      <small>Chuẩn lý thuyết: 54.11%</small>
    </div>
    <div class="kpi-card">
      <span>Tỷ lệ có ≥ 1/2 số</span>
      <strong class="text-cyan">${summary.hit1PlusRate}%</strong>
      <small>Chuẩn: 43.99% (${summary.hit1PlusCount} kỳ)</small>
    </div>
    <div class="kpi-card">
      <span>Chu kỳ TB · Chuỗi chờ</span>
      <strong>${summary.avgHitCycle || '--'} kỳ/lần</strong>
      <small>Đang chờ: ${summary.currentPairLoseStreak}k · Max: ${summary.maxPairLoseStreak}k</small>
    </div>
  `;

  if (!appState.customInitialized && Array.isArray(pred.pair) && pred.pair.length === 2) {
    appState.customInitialized = true;
    document.getElementById('customNumA').value = pred.pair[0];
    document.getElementById('customNumB').value = pred.pair[1];
  }
}

/* ==========================================================================
   3. CUSTOM 2-NUMBER PAIR INSPECTOR [X, Y] ON FULL HISTORY
   ========================================================================== */
function setCustomPairAndInspect(a, b) {
  const numA = Math.min(80, Math.max(1, parseInt(a, 10) || 1));
  const numB = Math.min(80, Math.max(1, parseInt(b, 10) || 2));
  document.getElementById('customNumA').value = numA;
  document.getElementById('customNumB').value = numB === numA ? (numA < 80 ? numA + 1 : 1) : numB;
  renderCustomPairInspection();
}

function renderCustomPairInspection() {
  const draws = appState.syncDraws.length > 0 ? appState.syncDraws : appState.recentDraws;
  const rawA = parseInt(document.getElementById('customNumA').value, 10);
  const rawB = parseInt(document.getElementById('customNumB').value, 10);

  if (!draws || draws.length === 0 || Number.isNaN(rawA) || Number.isNaN(rawB) || rawA < 1 || rawA > 80 || rawB < 1 || rawB > 80 || rawA === rawB) {
    document.getElementById('customPairSummary').innerHTML =
      `<div style="grid-column:1/-1; color:#f87171;">Vui lòng chọn 2 số khác nhau trong khoảng từ 01 đến 80.</div>`;
    document.getElementById('customPairHitsList').innerHTML = '';
    return;
  }

  const numA = Math.min(rawA, rawB);
  const numB = Math.max(rawA, rawB);
  const sorted = [...draws].sort((x, y) => x.drawNumber - y.drawNumber);
  const N = sorted.length;

  let hit2Count = 0;
  let hit1PlusCount = 0;
  let curGap = 0;
  let maxGap = 0;
  const hit2Draws = [];

  for (let i = 0; i < N; i++) {
    const d = sorted[i];
    const hasA = d.numbers.includes(numA);
    const hasB = d.numbers.includes(numB);
    if (hasA || hasB) hit1PlusCount++;
    if (hasA && hasB) {
      hit2Count++;
      curGap = 0;
      hit2Draws.push(d);
    } else {
      curGap++;
      if (curGap > maxGap) maxGap = curGap;
    }
  }

  const rate2 = ((hit2Count / N) * 100).toFixed(2);
  const rate1Plus = ((hit1PlusCount / N) * 100).toFixed(2);
  const avgCycle = hit2Count > 0 ? (N / hit2Count).toFixed(1) : '--';
  const totalCost = N * 10000;
  const totalPrize = hit2Count * 90000;
  const rtp = ((totalPrize / totalCost) * 100).toFixed(1);
  const net = totalPrize - totalCost;

  document.getElementById('customPairSummary').innerHTML = `
    <div class="kpi-card">
      <span>Cặp [${pad2(numA)} - ${pad2(numB)}] nổ 2/2</span>
      <strong>${hit2Count} / ${N} kỳ (${rate2}%)</strong>
      <small>Chuẩn lý thuyết: 6.01%</small>
    </div>
    <div class="kpi-card">
      <span>RTP Bậc 2 (vé 10k)</span>
      <strong class="${net >= 0 ? 'text-green' : 'text-gold'}">${rtp}%</strong>
      <small>Lãi/Lỗ: ${net >= 0 ? '+' : ''}${formatVnd(net)}</small>
    </div>
    <div class="kpi-card">
      <span>Gan cặp · MaxGan</span>
      <strong class="text-cyan">${curGap} kỳ</strong>
      <small>Cực đại: ${maxGap} kỳ · TB: ${avgCycle}k</small>
    </div>
    <div class="kpi-card">
      <span>Tỷ lệ có ≥ 1/2 số</span>
      <strong>${rate1Plus}% (${hit1PlusCount} kỳ)</strong>
      <small>Chuẩn lý thuyết: 43.99%</small>
    </div>
  `;

  const recentHits = hit2Draws.slice(-14).reverse();
  document.getElementById('customPairHitsList').innerHTML =
    recentHits.length > 0
      ? recentHits
          .map(
            (d) => `<span class="hit-pill">Kỳ #${d.drawId} (${d.date} · ${d.time}) → +90.000đ</span>`
          )
          .join('')
      : `<span style="color:var(--text-muted)">Cặp [${pad2(numA)} - ${pad2(numB)}] chưa nổ cùng nhau 2/2 trong ${N} kỳ đang có.</span>`;

  renderQuickTop15Numbers(appState.analysis);
}

function renderQuickTop15Numbers(analysis) {
  const list = analysis?.analytics?.numberRankingTop15 || [];
  const curA = parseInt(document.getElementById('customNumA').value, 10);
  const curB = parseInt(document.getElementById('customNumB').value, 10);
  const strip = document.getElementById('quickCompressedNumbers');

  strip.innerHTML = list
    .map((item) => {
      const cls =
        item.num === curA || item.num === curB
          ? 'selected-custom'
          : item.inPredictedPair
          ? 'active-pred'
          : '';
      return `
        <button type="button" class="num-pill ${cls}" data-num="${item.num}" title="24k: ${item.f24}/24 | Toàn mẫu: ${item.fAll} lần | Gan: ${item.gap}k">
          ${item.label} <small style="opacity:0.7">(${item.f24}/24)</small>
        </button>
      `;
    })
    .join('');

  strip.querySelectorAll('.num-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const clicked = parseInt(btn.getAttribute('data-num'), 10);
      const oldA = parseInt(document.getElementById('customNumA').value, 10) || 1;
      const oldB = parseInt(document.getElementById('customNumB').value, 10) || 2;
      if (clicked === oldA || clicked === oldB) return;
      document.getElementById('customNumA').value = oldB;
      document.getElementById('customNumB').value = clicked;
      renderCustomPairInspection();
    });
  });
}

/* ==========================================================================
   4. RENDER ALL HIT-2 LOG, WALK-FORWARD BACKTEST & PAIR TABLES
   ========================================================================== */
function renderAllTables(analysis) {
  if (!analysis) return;

  // 1. All 2/2 Winning Events Log (Compact 4 columns for Mobile + Desktop)
  const hit2Events = analysis.allHit2Events || [];
  document.getElementById('allHit2CountBadge').textContent = `Tổng: ${hit2Events.length} kỳ nổ 2/2`;
  document.getElementById('allHit2TableBody').innerHTML = hit2Events
    .map((r) => {
      const pSet = new Set(r.predictedPair);
      return `
        <tr>
          <td style="font-family:var(--font-mono);">
            <strong>#${r.drawId}</strong><br />
            <small style="color:var(--text-muted); font-size:0.66rem;">${r.date.slice(0, 5)} · ${r.time}</small>
          </td>
          <td><span class="pair-chip">[${r.predictedLabels.join(' - ')}]</span></td>
          <td>
            ${r.actualNumbers
              .map((n) => `<span class="mini-ball ${pSet.has(n) ? 'hit' : ''}">${pad2(n)}</span>`)
              .join('')}
          </td>
          <td style="font-family:var(--font-mono); white-space:nowrap;" class="text-green"><strong>+90k</strong></td>
        </tr>
      `;
    })
    .join('');

  // 2. Walk-Forward 150 Draws Table
  const summary = analysis.backtestSummary;
  document.getElementById('btEvalBadge').textContent = `Đã đối soát: ${summary?.evaluatedDraws || 0} kỳ`;
  document.getElementById('backtestTableBody').innerHTML = (analysis.backtestHistory || [])
    .map((r) => {
      const pSet = new Set(r.predictedPair);
      const hitBallsOnly = r.actualNumbers.filter((n) => pSet.has(n));
      const statusHtml = r.wonBac2
        ? `<span class="text-gold"><strong>🎉 NỔ 2/2</strong></span>`
        : r.hitCount === 1
        ? `<span class="text-green">✅ Có 1/2 (${pad2(hitBallsOnly[0])})</span>`
        : `<span style="color:var(--text-muted)">0/2</span>`;
      const prizeHtml = r.wonBac2
        ? `<strong class="text-gold">+${formatVnd(r.prize)}</strong>`
        : `<span style="color:var(--text-muted)">0đ</span>`;

      return `
        <tr class="${r.wonBac2 ? 'row-highlight' : ''}">
          <td style="font-family:var(--font-mono);">#${r.drawId} <small style="color:var(--text-muted)">(${r.time})</small></td>
          <td><span class="pair-chip">[${r.predictedLabels.join(' - ')}]</span></td>
          <td>${statusHtml}</td>
          <td style="font-family:var(--font-mono);">${r.hitCount}/2</td>
          <td style="font-family:var(--font-mono);">${prizeHtml}</td>
        </tr>
      `;
    })
    .join('');

  // 3. Strategy Comparison Table
  document.getElementById('strategyCompTableBody').innerHTML = (analysis.strategyComparison || [])
    .map(
      (s) => `
      <tr class="${s.isSelected ? 'row-highlight' : ''}" title="${s.description}">
        <td>
          <strong>${s.isSelected ? '👉 ' : ''}${s.shortLabel}</strong>
        </td>
        <td style="font-family:var(--font-mono);" class="${s.hit2Rate > 6.01 ? 'text-green' : ''}">
          <strong>${s.hit2Rate}%</strong> <small>(${s.hit2Count})</small>
        </td>
        <td style="font-family:var(--font-mono);">${s.bac2Rtp}%</td>
        <td style="font-family:var(--font-mono);">${s.hit1PlusRate}%</td>
        <td style="font-family:var(--font-mono);">${s.maxPairLoseStreak}k</td>
        <td style="font-family:var(--font-mono);">${s.avgHitCycle || '--'}k</td>
      </tr>
    `
    )
    .join('');

  // 4. Top 12 Rebound Due Pairs
  const renderPairRow = (p, isCoocTable) => `
    <tr class="${p.isSelected ? 'row-highlight' : ''}">
      <td><span class="pair-chip">[${p.pairLabel}]</span></td>
      <td style="font-family:var(--font-mono);">${isCoocTable ? p.coocCount + ' lần' : p.sumF24 + '/48'}</td>
      <td style="font-family:var(--font-mono);">${isCoocTable ? p.coocRate + '%' : p.pairGap + 'k'}</td>
      <td style="font-family:var(--font-mono);">${isCoocTable ? (p.avgCycle ? p.avgCycle + 'k' : '--') : p.coocCount + ' lần'}</td>
      <td style="font-family:var(--font-mono);">${isCoocTable ? p.pairGap + 'k' : p.reboundScore}</td>
      <td><button type="button" class="btn-tiny inspect-pair-quick" data-a="${p.pair[0]}" data-b="${p.pair[1]}">Dò</button></td>
    </tr>
  `;

  document.getElementById('duePairsTableBody').innerHTML = (analysis.analytics?.topDueReboundPairs || [])
    .map((p) => renderPairRow(p, false))
    .join('');

  document.getElementById('coocPairsTableBody').innerHTML = (analysis.analytics?.topCooccurringPairs || [])
    .map((p) => renderPairRow(p, true))
    .join('');

  document.querySelectorAll('.inspect-pair-quick').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = btn.getAttribute('data-a');
      const b = btn.getAttribute('data-b');
      setCustomPairAndInspect(a, b);
      switchMainTab('inspector');
      if (window.innerWidth >= 1100) {
        document.getElementById('customNumA').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });
}

/* ==========================================================================
   5. MOBILE NAVIGATION & CONTROLS
   ========================================================================== */
function switchMainTab(tabName) {
  document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === tabName);
  });
  document.querySelectorAll('[data-tab-target]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab-target') === tabName);
  });
  if (window.innerWidth < 1100) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function switchBacktestSubtab(subtabName) {
  document.querySelectorAll('[data-bt-subtab]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-bt-subtab') === subtabName);
  });
  document.querySelectorAll('[data-bt-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-bt-panel') === subtabName);
  });
}

async function selectStrategyMode(mode) {
  try {
    const res = await fetch(`/api/state?mode=${encodeURIComponent(mode)}`);
    if (res.ok) {
      const data = await res.json();
      appState.customInitialized = false;
      applyServerState(data);
    }
  } catch {
    // Ignore network error
  }
}

/* ==========================================================================
   6. COUNTDOWN & LIVE SSE STREAM
   ========================================================================== */
function updateCountdownDisplay() {
  const sch = appState.schedule;
  if (!sch) return;

  document.getElementById('nextTargetId').textContent = `#${sch.nextDrawId || sch.expectedDrawId || '------'}`;
  document.getElementById('nextExpectedTime').textContent = `(${sch.expectedDrawTimeStr || sch.nextDrawTimeStr || '--:--'})`;

  const remMs = Math.max(0, (sch.targetTimestampMs || 0) - Date.now());
  const totalSec = Math.floor(remMs / 1000);
  const mins = pad2(Math.floor(totalSec / 60));
  const secs = pad2(totalSec % 60);

  const timerEl = document.getElementById('countdownValue');
  const labelEl = document.getElementById('countdownLabel');

  if (sch.awaitingNewResult || totalSec === 0) {
    labelEl.textContent = 'Đang mở thưởng kỳ';
    timerEl.textContent = 'QUAY...';
    if (Date.now() - appState.lastZeroTriggerMs > 18000) {
      appState.lastZeroTriggerMs = Date.now();
      fetch('/api/refresh', { method: 'POST' }).catch(() => {});
    }
  } else {
    labelEl.textContent = sch.isOperatingHours ? 'Đếm ngược kỳ' : 'Chờ phiên 06:08';
    timerEl.textContent = `${mins}:${secs}`;
  }
}

function applyServerState(payload) {
  if (!payload) return;

  appState.schedule = payload.schedule || appState.schedule;
  appState.recentDraws = payload.recentDraws || appState.recentDraws;
  appState.syncDraws = payload.syncDraws || appState.syncDraws;
  appState.analysis = payload.analysis || appState.analysis;

  if (appState.syncDraws.length > 0) {
    saveDrawsToLocalCache(appState.syncDraws);
    syncLocalCacheToServerIfNeeded(appState.analysis?.totalHistoricalDraws || 0);
  }

  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  if (payload.isPolling) {
    dot.classList.add('polling');
    statusText.textContent = payload.lastPollStatus || 'Đang quét kỳ mới...';
  } else {
    dot.classList.remove('polling');
    statusText.textContent = payload.lastPollStatus || 'Trực tiếp (Live SSE)';
  }

  if (payload.lastPollTime) {
    document.getElementById('lastPollTimeLabel').textContent = `Cập nhật: ${payload.lastPollTime}`;
  }

  const newestId = appState.analysis?.latestDraw?.drawId;
  if (newestId && appState.lastSeenDrawId && newestId !== appState.lastSeenDrawId) {
    playNotificationChime();
  }
  if (newestId) {
    appState.lastSeenDrawId = newestId;
  }

  renderLatestDraw(appState.analysis);
  renderPredictionShowcase(appState.analysis);
  renderAllTables(appState.analysis);
  renderCustomPairInspection();
  updateCountdownDisplay();
}

function initControls() {
  const modeSelect = document.getElementById('modeSelect');
  modeSelect.addEventListener('change', () => {
    selectStrategyMode(modeSelect.value);
  });

  document.querySelectorAll('.mode-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = btn.getAttribute('data-mode');
      if (m) selectStrategyMode(m);
    });
  });

  document.querySelectorAll('[data-tab-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchMainTab(btn.getAttribute('data-tab-target'));
    });
  });

  document.querySelectorAll('[data-bt-subtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchBacktestSubtab(btn.getAttribute('data-bt-subtab'));
    });
  });

  const soundBtn = document.getElementById('soundToggleBtn');
  soundBtn.addEventListener('click', () => {
    appState.soundEnabled = !appState.soundEnabled;
    soundBtn.textContent = appState.soundEnabled ? '🔔 Bật' : '🔕 Tắt';
  });

  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        applyServerState(data);
      }
    } finally {
      setTimeout(() => {
        refreshBtn.disabled = false;
      }, 800);
    }
  });

  const expandBtn = document.getElementById('expandHistoryBtn');
  expandBtn.addEventListener('click', async () => {
    expandBtn.disabled = true;
    const origText = expandBtn.textContent;
    expandBtn.textContent = '⏳ Đang tải...';
    try {
      const res = await fetch('/api/expand-history?days=2&pages=8', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        applyServerState(data);
      }
    } finally {
      expandBtn.textContent = origText;
      expandBtn.disabled = false;
    }
  });

  document.getElementById('inspectPairBtn').addEventListener('click', () => {
    renderCustomPairInspection();
  });

  document.getElementById('customNumA').addEventListener('change', renderCustomPairInspection);
  document.getElementById('customNumB').addEventListener('change', renderCustomPairInspection);

  document.getElementById('applyPredToInspectorBtn').addEventListener('click', () => {
    const pair = appState.analysis?.prediction?.pair;
    if (Array.isArray(pair) && pair.length === 2) {
      setCustomPairAndInspect(pair[0], pair[1]);
    }
  });
}

function connectSseStream() {
  const es = new EventSource('/api/stream');

  const handlePayloadEvent = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      applyServerState(data);
    } catch {
      // Ignore parse error
    }
  };

  es.addEventListener('init', handlePayloadEvent);
  es.addEventListener('state_update', handlePayloadEvent);
  es.addEventListener('new_draw', handlePayloadEvent);

  es.addEventListener('poll_status', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const dot = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');
      if (data.isPolling) dot.classList.add('polling');
      else dot.classList.remove('polling');
      if (data.lastPollStatus) statusText.textContent = data.lastPollStatus;
      if (data.schedule) {
        appState.schedule = data.schedule;
        updateCountdownDisplay();
      }
    } catch {
      // Ignore parse error
    }
  });

  es.onerror = () => {
    document.getElementById('statusText').textContent = 'Đang kết nối lại...';
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  initControls();
  setInterval(updateCountdownDisplay, 1000);

  try {
    const res = await fetch('/api/state');
    if (res.ok) {
      const data = await res.json();
      applyServerState(data);
    }
  } catch {
    // Fallback to SSE
  }

  connectSseStream();
});
