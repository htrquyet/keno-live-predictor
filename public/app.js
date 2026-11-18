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
  const trioForLatest =
    btLatest && btLatest.drawId === latest.drawId ? btLatest.trio || btLatest.predictedPair : [];
  const trioSet = new Set(trioForLatest);

  document.getElementById('latestBallsGrid').innerHTML = latest.numbers
    .map(
      (n) => `
      <div class="keno-ball ${trioSet.has(n) ? 'matched-ball' : ''}" title="${trioSet.has(n) ? 'Trùng số trong Bộ 3 dự đoán!' : ''}">
        ${pad2(n)}
      </div>
    `
    )
    .join('');

  const banner = document.getElementById('latestReconcileBanner');
  if (btLatest && btLatest.drawId === latest.drawId) {
    const trioStr = (btLatest.trioLabels || btLatest.predictedLabels).join(' - ');
    const pairStr = btLatest.predictedLabels.join(' - ');
    const matchedStr = (btLatest.trioMatched || []).join(', ');

    if (btLatest.trioHitCount === 3) {
      banner.className = 'reconcile-banner hit2';
      banner.innerHTML = `🔥 <strong>NỔ TRỌN 3/3 KENO BẬC 3!</strong> Bộ <strong>[${trioStr}]</strong> trúng cả 3 số (${matchedStr}) ở kỳ #${latest.drawId} → Nhận <strong>+400.000đ (x40)</strong>!`;
    } else if (btLatest.trioHitCount === 2) {
      banner.className = 'reconcile-banner hit2';
      banner.innerHTML = `🎉 <strong>TRÚNG 2/3 BẬC 3 (+20.000đ)!</strong> Bộ <strong>[${trioStr}]</strong> nổ 2 số (<strong>${matchedStr}</strong>)${btLatest.wonBac2 ? ` · Trùng đúng Cặp 2/2 [${pairStr}] (+90k Bậc 2)` : ''}.`;
    } else if (btLatest.trioHitCount === 1) {
      banner.className = 'reconcile-banner';
      banner.innerHTML = `✅ <strong>Có 1/3 số (${matchedStr}):</strong> Bộ [${trioStr}] ở kỳ #${latest.drawId}. Chờ B3: ${analysis.backtestSummary?.bac3CurrentGap || 0}k.`;
    } else {
      banner.className = 'reconcile-banner miss';
      banner.innerHTML = `⏭️ <strong>Chưa nổ (0/3):</strong> Bộ [${trioStr}] ở kỳ #${latest.drawId}. Chuỗi chờ B3: ${analysis.backtestSummary?.bac3CurrentGap || 0} kỳ.`;
    }
  } else {
    banner.className = 'reconcile-banner miss';
    banner.textContent = 'Đang đồng bộ đối soát kỳ gần nhất...';
  }
}

/* ==========================================================================
   2. RENDER SINGLE CHOSEN TRIO [A - B - C] FOR NEXT DRAW
   ========================================================================== */
function renderPredictionShowcase(analysis) {
  if (!analysis || !analysis.prediction) return;
  const pred = analysis.prediction;
  const { trioLabels, pairLabels, numAStats, numBStats, numCStats, pairStats, wheel4, summary } = pred;

  document.getElementById('predNextDrawId').textContent = `#${analysis.nextDrawId}`;
  document.getElementById('pairHeroBallA').textContent = trioLabels[0];
  document.getElementById('pairHeroBallB').textContent = trioLabels[1];
  document.getElementById('pairHeroBallC').textContent = trioLabels[2];

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
    <div class="profile-row"><span>Lực Markov / Gan:</span><strong>${st.markovPct}% · ${st.gap}k</strong></div>
    <div class="profile-row"><span>Tần suất toàn mẫu:</span><strong>${st.fAll} lần (${st.rateAll}%)</strong></div>
  `;

  document.getElementById('pairNumACard').innerHTML = renderNumCard(numAStats, 'Chủ lực 1 (Cặp 2/2)');
  document.getElementById('pairNumBCard').innerHTML = renderNumCard(numBStats, 'Chủ lực 2 (Cặp 2/2)');

  const cStat = numCStats || numBStats;
  document.getElementById('pairMutualMeta').innerHTML = `
    <div class="profile-title">Mảnh ghép Bậc 3 [${cStat.label}] & Cặp [${pairLabels[0]}-${pairLabels[1]}]</div>
    <div class="profile-row"><span>Số [${cStat.label}] 24k / Markov / Gan:</span><strong>${cStat.f24}/24 · ${cStat.markovPct}% · ${cStat.gap}k</strong></div>
    <div class="profile-row"><span>Cặp chính [${pairLabels[0]}-${pairLabels[1]}] cùng nổ:</span><strong>${pairStats.coocCount} lần · Gan <span class="text-gold">${pairStats.pairGap}k</span></strong></div>
    <div class="profile-row"><span>Bộ 3 Bậc 3 [${trioLabels.join('-')}]:</span><strong>2/3: x2 · 3/3: x40 (Chuẩn 15.73%)</strong></div>
  `;

  document.getElementById('wheelSupportBox').innerHTML = `
    <div class="wheel-row">
      <span>👑 <strong>Cặp 2/2 Mạnh Nhất Bên Trong:</strong> <span class="wheel-badge">${pairLabels.join(' - ')}</span> (Nổ 2/2: <strong>${summary.hit2Rate}%</strong> · RTP B2: <strong>${summary.bac2Rtp}%</strong>)</span>
      <span class="text-gold"><strong>Vé B2 10k ăn 90.000đ</strong></span>
    </div>
    <div class="wheel-row" style="color:var(--text-secondary); font-size:0.7rem;">
      <span>🔥 <strong>Mở rộng Bộ 4 Số (6 cặp B2 / Đá vòng):</strong> [${wheel4.labels.join(' - ')}] → Trúng ≥2/4 số: <strong>${summary.wheel4WinRate}%</strong> (${summary.wheel4AvgCycle}k/lần · MaxGan ${summary.wheel4MaxGap}k)</span>
    </div>
  `;

  const netStr = (summary.bac3NetProfit10k >= 0 ? '+' : '') + formatVnd(summary.bac3NetProfit10k);
  document.getElementById('predKpiRow').innerHTML = `
    <div class="kpi-card">
      <span>Trúng Bậc 3 (${summary.evaluatedDraws} kỳ)</span>
      <strong>${summary.bac3WinRate}% (${summary.bac3WinCount} lần)</strong>
      <small>2/3: ${summary.bac3Hit2Count} (${summary.bac3Hit2Rate}%) · 3/3: ${summary.bac3Hit3Count} (${summary.bac3Hit3Rate}%)</small>
    </div>
    <div class="kpi-card">
      <span>RTP Keno Bậc 3 (Vé 10k)</span>
      <strong class="text-gold">${summary.bac3Rtp}% (${netStr})</strong>
      <small>Chuẩn lý thuyết: 84.21%</small>
    </div>
    <div class="kpi-card">
      <span>Chu kỳ B3 · Có ≥1/3 số</span>
      <strong class="text-cyan">${summary.bac3AvgCycle || '--'} kỳ/lần</strong>
      <small>Chờ: ${summary.bac3CurrentGap}k · Max: ${summary.bac3MaxGap}k · ≥1/3: ${summary.bac3Hit1PlusRate}%</small>
    </div>
    <div class="kpi-card">
      <span>Cặp 2/2 Chủ Lực [${pairLabels.join('-')}]</span>
      <strong>${summary.hit2Rate}% (${summary.hit2Count} lần)</strong>
      <small>RTP B2: ${summary.bac2Rtp}% · ≥1/2: ${summary.hit1PlusRate}%</small>
    </div>
  `;

  if (!appState.customInitialized && Array.isArray(pred.trio) && pred.trio.length === 3) {
    appState.customInitialized = true;
    document.getElementById('customNumA').value = pred.trio[0];
    document.getElementById('customNumB').value = pred.trio[1];
    document.getElementById('customNumC').value = pred.trio[2];
  }
}

/* ==========================================================================
   3. CUSTOM 3-NUMBER TRIO INSPECTOR [X, Y, Z] (KENO BẬC 3) ON FULL HISTORY
   ========================================================================== */
function setCustomPairAndInspect(a, b, c = null) {
  const numA = Math.min(80, Math.max(1, parseInt(a, 10) || 1));
  let numB = Math.min(80, Math.max(1, parseInt(b, 10) || 2));
  if (numB === numA) numB = numA < 80 ? numA + 1 : 1;

  const predThird = appState.analysis?.prediction?.wheel3?.backupNum || 58;
  let numC = c !== null ? Math.min(80, Math.max(1, parseInt(c, 10) || predThird)) : predThird;
  while (numC === numA || numC === numB) {
    numC = numC < 80 ? numC + 1 : 1;
  }

  document.getElementById('customNumA').value = numA;
  document.getElementById('customNumB').value = numB;
  document.getElementById('customNumC').value = numC;
  renderCustomPairInspection();
}

function renderCustomPairInspection() {
  const draws = appState.syncDraws.length > 0 ? appState.syncDraws : appState.recentDraws;
  const rawA = parseInt(document.getElementById('customNumA').value, 10);
  const rawB = parseInt(document.getElementById('customNumB').value, 10);
  const rawC = parseInt(document.getElementById('customNumC').value, 10);

  if (
    !draws ||
    draws.length === 0 ||
    [rawA, rawB, rawC].some((v) => Number.isNaN(v) || v < 1 || v > 80) ||
    new Set([rawA, rawB, rawC]).size !== 3
  ) {
    document.getElementById('customPairSummary').innerHTML =
      `<div style="grid-column:1/-1; color:#f87171;">Vui lòng chọn 3 số khác nhau trong khoảng từ 01 đến 80.</div>`;
    document.getElementById('customPairHitsList').innerHTML = '';
    return;
  }

  const trio = [rawA, rawB, rawC];
  const sorted = [...draws].sort((x, y) => x.drawNumber - y.drawNumber);
  const N = sorted.length;

  let hit3Count = 0;
  let hit2Count = 0;
  let hit1PlusCount = 0;
  let curGap = 0;
  let maxGap = 0;
  const winDraws = [];

  for (let i = 0; i < N; i++) {
    const d = sorted[i];
    const matched = trio.filter((n) => d.numbers.includes(n));
    if (matched.length >= 1) hit1PlusCount++;
    if (matched.length >= 2) {
      if (matched.length === 3) hit3Count++;
      else hit2Count++;
      curGap = 0;
      winDraws.push({ ...d, hitCount: matched.length, prize: matched.length === 3 ? 400000 : 20000 });
    } else {
      curGap++;
      if (curGap > maxGap) maxGap = curGap;
    }
  }

  const winTotal = hit2Count + hit3Count;
  const winRate = ((winTotal / N) * 100).toFixed(2);
  const rate1Plus = ((hit1PlusCount / N) * 100).toFixed(2);
  const avgCycle = winTotal > 0 ? (N / winTotal).toFixed(1) : '--';
  const totalCost = N * 10000;
  const totalPrize = hit2Count * 20000 + hit3Count * 400000;
  const rtp = ((totalPrize / totalCost) * 100).toFixed(1);
  const net = totalPrize - totalCost;
  const labelStr = trio.map(pad2).join('-');

  document.getElementById('customPairSummary').innerHTML = `
    <div class="kpi-card">
      <span>Bộ [${labelStr}] trúng B3</span>
      <strong>${winRate}% (${winTotal}/${N})</strong>
      <small>2/3: ${hit2Count} · 3/3: ${hit3Count} (Chuẩn 15.73%)</small>
    </div>
    <div class="kpi-card">
      <span>RTP Keno Bậc 3 (10k)</span>
      <strong class="${net >= 0 ? 'text-green' : 'text-gold'}">${rtp}%</strong>
      <small>Lãi/Lỗ: ${net >= 0 ? '+' : ''}${formatVnd(net)}</small>
    </div>
    <div class="kpi-card">
      <span>Gan Bậc 3 · MaxGan</span>
      <strong class="text-cyan">${curGap} kỳ</strong>
      <small>Max: ${maxGap}k · TB: ${avgCycle}k/lần</small>
    </div>
    <div class="kpi-card">
      <span>Tỷ lệ có ≥ 1/3 số</span>
      <strong>${rate1Plus}% (${hit1PlusCount} kỳ)</strong>
      <small>Chuẩn lý thuyết: 58.34%</small>
    </div>
  `;

  const recentHits = winDraws.slice(-14).reverse();
  document.getElementById('customPairHitsList').innerHTML =
    recentHits.length > 0
      ? recentHits
          .map(
            (d) =>
              `<span class="hit-pill">Kỳ #${d.drawId} (${d.time}) [${d.hitCount}/3] → +${formatVnd(d.prize)}</span>`
          )
          .join('')
      : `<span style="color:var(--text-muted)">Bộ [${labelStr}] chưa trúng Bậc 3 (≥2/3) trong ${N} kỳ đang có.</span>`;

  renderQuickTop15Numbers(appState.analysis);
}

function renderQuickTop15Numbers(analysis) {
  const list = analysis?.analytics?.numberRankingTop15 || [];
  const curA = parseInt(document.getElementById('customNumA').value, 10);
  const curB = parseInt(document.getElementById('customNumB').value, 10);
  const curC = parseInt(document.getElementById('customNumC').value, 10);
  const strip = document.getElementById('quickCompressedNumbers');

  strip.innerHTML = list
    .map((item) => {
      const cls =
        item.num === curA || item.num === curB || item.num === curC
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
      const oldC = parseInt(document.getElementById('customNumC').value, 10) || 3;
      if ([oldA, oldB, oldC].includes(clicked)) return;
      document.getElementById('customNumA').value = oldB;
      document.getElementById('customNumB').value = oldC;
      document.getElementById('customNumC').value = clicked;
      renderCustomPairInspection();
    });
  });
}

/* ==========================================================================
   4. RENDER ALL HIT-2 LOG, WALK-FORWARD BACKTEST & PAIR TABLES
   ========================================================================== */
function renderAllTables(analysis) {
  if (!analysis) return;

  // 1. All Keno Bac 3 Winning Events Log (2/3 +20k & 3/3 +400k)
  const hitEvents = analysis.allHit2Events || [];
  const summary = analysis.backtestSummary;
  document.getElementById('allHit2CountBadge').textContent =
    `Tổng: ${hitEvents.length} kỳ (${summary?.bac3Hit3Count || 0} kỳ 3/3 · ${summary?.bac3Hit2Count || 0} kỳ 2/3)`;

  document.getElementById('allHit2TableBody').innerHTML = hitEvents
    .map((r) => {
      const tSet = new Set(r.trio || r.predictedPair);
      const trioArr = r.trioLabels || r.predictedLabels;
      const is33 = r.trioHitCount === 3;
      return `
        <tr class="${is33 ? 'row-highlight' : ''}">
          <td style="font-family:var(--font-mono);">
            <strong>#${r.drawId}</strong><br />
            <small style="color:var(--text-muted); font-size:0.66rem;">${r.date.slice(0, 5)} · ${r.time}</small>
          </td>
          <td>
            <span class="pair-chip">${trioArr.join(' - ')}</span><br />
            <small style="font-size:0.65rem;" class="${is33 ? 'text-gold' : 'text-cyan'}">${is33 ? '🔥 3/3 Số' : '2/3 Số'}</small>
          </td>
          <td>
            ${r.actualNumbers
              .map((n) => `<span class="mini-ball ${tSet.has(n) ? 'hit' : ''}">${pad2(n)}</span>`)
              .join('')}
          </td>
          <td style="font-family:var(--font-mono); white-space:nowrap;" class="${is33 ? 'text-gold' : 'text-green'}">
            <strong>+${is33 ? '400k' : '20k'}</strong>
          </td>
        </tr>
      `;
    })
    .join('');

  // 2. Walk-Forward 150 Draws Table
  document.getElementById('btEvalBadge').textContent = `Đã đối soát: ${summary?.evaluatedDraws || 0} kỳ`;
  document.getElementById('backtestTableBody').innerHTML = (analysis.backtestHistory || [])
    .map((r) => {
      const trioArr = r.trioLabels || r.predictedLabels;
      const matchedStr = (r.trioMatched || []).join(', ');

      let b3Html = `<span style="color:var(--text-muted)">0/3</span>`;
      if (r.trioHitCount === 3) {
        b3Html = `<span class="text-gold"><strong>🔥 3/3 (${matchedStr})</strong></span>`;
      } else if (r.trioHitCount === 2) {
        b3Html = `<span class="text-green"><strong>🎉 2/3 (${matchedStr})</strong></span>`;
      } else if (r.trioHitCount === 1) {
        b3Html = `<span style="color:var(--text-secondary)">1/3 (${matchedStr})</span>`;
      }

      const b2Html = r.wonBac2
        ? `<span class="text-gold"><strong>✅ [${r.predictedLabels.join('-')}]</strong></span>`
        : `<span style="color:var(--text-muted)">[${r.predictedLabels.join('-')}] (${r.hitCount}/2)</span>`;

      const prizeHtml = r.bac3Prize > 0
        ? `<strong class="${r.trioHitCount === 3 ? 'text-gold' : 'text-green'}">+${formatVnd(r.bac3Prize)}</strong>`
        : `<span style="color:var(--text-muted)">0đ</span>`;

      return `
        <tr class="${r.wonBac3 ? 'row-highlight' : ''}">
          <td style="font-family:var(--font-mono);">#${r.drawId} <small style="color:var(--text-muted)">(${r.time})</small></td>
          <td><span class="pair-chip">[${trioArr.join(' - ')}]</span></td>
          <td style="font-family:var(--font-mono);">${b3Html}</td>
          <td style="font-family:var(--font-mono);">${b2Html}</td>
          <td style="font-family:var(--font-mono);">${prizeHtml}</td>
        </tr>
      `;
    })
    .join('');

  // 3. Strategy Comparison Table (Bac 3 + Bac 2)
  document.getElementById('strategyCompTableBody').innerHTML = (analysis.strategyComparison || [])
    .map(
      (s) => `
      <tr class="${s.isSelected ? 'row-highlight' : ''}" title="${s.description}">
        <td>
          <strong>${s.isSelected ? '👉 ' : ''}${s.shortLabel}</strong>
        </td>
        <td style="font-family:var(--font-mono);" class="${s.bac3WinRate > 15.73 ? 'text-green' : ''}">
          <strong>${s.bac3WinRate}%</strong> <small>(${s.bac3WinCount})</small>
        </td>
        <td style="font-family:var(--font-mono);">${s.bac3Hit3Count} lần (${s.bac3Hit3Rate}%)</td>
        <td style="font-family:var(--font-mono);" class="${s.bac3Rtp >= 100 ? 'text-gold' : ''}"><strong>${s.bac3Rtp}%</strong></td>
        <td style="font-family:var(--font-mono);">${s.hit2Rate}% (${s.bac2Rtp}%)</td>
        <td style="font-family:var(--font-mono);">${s.bac3MaxGap}k</td>
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
  document.getElementById('customNumC').addEventListener('change', renderCustomPairInspection);

  document.getElementById('applyPredToInspectorBtn').addEventListener('click', () => {
    const trio = appState.analysis?.prediction?.trio;
    if (Array.isArray(trio) && trio.length === 3) {
      setCustomPairAndInspect(trio[0], trio[1], trio[2]);
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
