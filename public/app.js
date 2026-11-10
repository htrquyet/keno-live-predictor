let appState = null;
let soundEnabled = true;
let localCountdownSec = 0;
let awaitingResultFlag = false;

const pad2 = (n) => String(n).padStart(2, '0');
const formatVnd = (n) => new Intl.NumberFormat('vi-VN').format(n) + 'đ';

function playNotificationChime() {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12, ctx.currentTime + idx * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.11 + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + idx * 0.11);
      osc.stop(ctx.currentTime + idx * 0.11 + 0.36);
    });
  } catch {
    // Ignore audio context restriction before user gesture
  }
}

function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 7000);
}

function renderPollStatus(info) {
  const dot = document.getElementById('pulseDot');
  const txt = document.getElementById('pollStatusText');
  if (!dot || !txt) return;
  if (info.isPolling) {
    dot.classList.add('polling');
  } else {
    dot.classList.remove('polling');
  }
  if (info.lastPollStatus) {
    txt.textContent = info.lastPollStatus;
  }
}

function renderCountdownUI() {
  const timerEl = document.getElementById('countdownTimer');
  const boxEl = document.getElementById('countdownBox');
  const subEl = document.getElementById('countdownSubStatus');
  if (!timerEl || !boxEl || !subEl) return;

  const mins = Math.floor(localCountdownSec / 60);
  const secs = localCountdownSec % 60;
  timerEl.textContent = `${pad2(mins)}:${pad2(secs)}`;

  if (awaitingResultFlag || localCountdownSec <= 5) {
    boxEl.classList.add('awaiting-hot');
    subEl.innerHTML = `<span style="color:#fbbf24;font-weight:700;">⚡ Đang quét kết quả kỳ mới (4s/lần)...</span>`;
  } else {
    boxEl.classList.remove('awaiting-hot');
    subEl.textContent = `Chu kỳ 8 phút/kỳ · Tự động tính ngay khi nổ`;
  }
}

function renderAll(state) {
  appState = state;
  const { schedule, analysis, recentDraws } = state;
  if (!analysis) return;

  // Sync schedule & countdown
  localCountdownSec = schedule?.secondsUntilNextSchedule ?? 0;
  awaitingResultFlag = Boolean(schedule?.awaitingNewResult);
  document.getElementById('headerNextDrawId').textContent = `#${analysis.nextDrawId}`;
  document.getElementById('headerNextDrawTime').textContent = schedule
    ? `Giờ quay: ${schedule.expectedDrawTimeStr}`
    : '--:--';
  document.getElementById('predNextDrawId').textContent = `#${analysis.nextDrawId}`;
  const sampleSizeEl = document.getElementById('predSampleSize');
  if (sampleSizeEl) {
    sampleSizeEl.textContent = analysis.totalHistoricalDraws;
  }
  renderPollStatus(state);
  renderCountdownUI();

  // Sync strategy dropdown
  const selectEl = document.getElementById('strategySelect');
  if (selectEl && analysis.mode) {
    selectEl.value = analysis.mode;
  }

  // 1. Latest Draw Result
  const latest = analysis.latestDraw;
  const latestBacktest = analysis.backtestHistory?.[0] || null;

  // Build map of numbers predicted across all tiers in the latest backtest
  const predTiersMap = new Map();
  if (latestBacktest) {
    const addNums = (tierObj, label) => {
      for (const num of tierObj?.predicted || []) {
        if (!predTiersMap.has(num)) predTiersMap.set(num, []);
        predTiersMap.get(num).push(label);
      }
    };
    addNums(latestBacktest.bac2, 'Bậc 2');
    addNums(latestBacktest.bac3, 'Bậc 3');
    addNums(latestBacktest.bac4, 'Bậc 4');
    addNums(latestBacktest.bac5, 'Bậc 5');
  }

  if (latest) {
    document.getElementById('latestDrawMeta').innerHTML =
      `Kỳ quay <strong>#${latest.drawId}</strong> · Lúc <strong>${latest.time}</strong> ngày ${latest.date} · Nguồn: ${latest.source}`;

    document.getElementById('latestDrawBadges').innerHTML = `
      <span class="stat-pill even">Chẵn: ${latest.evenCount}</span>
      <span class="stat-pill odd">Lẻ: ${latest.oddCount}</span>
      <span class="stat-pill big">Lớn: ${latest.bigCount}</span>
      <span class="stat-pill small">Nhỏ: ${latest.smallCount}</span>
      <span class="stat-pill">Tổng: ${latest.sum}</span>
    `;

    const ballsGrid = document.getElementById('latestBallsGrid');
    ballsGrid.innerHTML = latest.numbers
      .map((n) => {
        const tiers = predTiersMap.get(n);
        const isHit = Boolean(tiers && tiers.length > 0);
        const titleText = isHit
          ? `🎯 TRÚNG! Số nằm trong dự đoán ${tiers.join(' & ')} kỳ #${latest.drawId}`
          : `Số #${pad2(n)} nổ kỳ #${latest.drawId}`;
        return `<div class="keno-ball ${isHit ? 'hit-match' : ''}" title="${titleText}">${pad2(n)}</div>`;
      })
      .join('');

    const hitBanner = document.getElementById('latestHitBanner');
    if (latestBacktest && latestBacktest.drawId === latest.drawId) {
      const b2 = latestBacktest.bac2;
      const b3 = latestBacktest.bac3;
      const b4 = latestBacktest.bac4;
      const b5 = latestBacktest.bac5;
      const totalPrize = (b2.prize || 0) + (b3.prize || 0) + (b4.prize || 0) + (b5.prize || 0);

      const chipB2 = `<span class="${b2.prize > 0 ? 'prize-win' : 'stat-pill'}">Bậc 2: <strong>${b2.hitCount}/2</strong>${b2.prize > 0 ? ' 🏆' : ''}</span>`;
      const chipB3 = `<span class="${b3.prize > 0 ? 'prize-win' : 'stat-pill'}">Bậc 3: <strong>${b3.hitCount}/3</strong>${b3.prize > 0 ? ' 🏆' : ''}</span>`;
      const chipB4 = `<span class="${b4.prize > 0 ? 'prize-win' : 'stat-pill'}">Bậc 4: <strong>${b4.hitCount}/4</strong>${b4.prize > 0 ? ' 🏆' : ''}</span>`;
      const chipB5 = `<span class="${b5.prize > 0 ? 'prize-win' : 'stat-pill'}">Bậc 5: <strong>${b5.hitCount}/5</strong>${b5.prize > 0 ? ' 🏆' : ''}</span>`;

      hitBanner.innerHTML = `
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;width:100%;">
          <span>🎯 Đối soát kỳ <strong>#${latest.drawId}</strong> (Mẫu: <strong>${latestBacktest.sampleSizeUsed || analysis.totalHistoricalDraws - 1} kỳ</strong>):</span>
          <div style="display:inline-flex;gap:6px;flex-wrap:wrap;">
            ${chipB2} ${chipB3} ${chipB4} ${chipB5}
          </div>
          ${
            totalPrize > 0
              ? `<span class="prize-win" style="margin-left:auto;">🏆 Ăn thưởng: +${formatVnd(totalPrize)}</span>`
              : `<span style="color:#94a3b8;margin-left:auto;">Đã tích lũy thành <strong>${analysis.totalHistoricalDraws} kỳ</strong></span>`
          }
        </div>
      `;
    } else {
      hitBanner.innerHTML = `<span>Dữ liệu kỳ #${latest.drawId} đã được gộp vào mẫu <strong>${analysis.totalHistoricalDraws} kỳ</strong> để tính kỳ #${analysis.nextDrawId}</span>`;
    }
  }

  // 2. 80-Ball Interactive Matrix
  const drawnSet = new Set(latest ? latest.numbers : []);
  const nextPredTiersMap = new Map();
  if (analysis.lowTiers) {
    const addNext = (tierObj, label) => {
      for (const num of tierObj?.numbers || []) {
        if (!nextPredTiersMap.has(num)) nextPredTiersMap.set(num, []);
        nextPredTiersMap.get(num).push(label);
      }
    };
    addNext(analysis.lowTiers.bac2, 'Bậc 2');
    addNext(analysis.lowTiers.bac3, 'Bậc 3');
    addNext(analysis.lowTiers.bac4, 'Bậc 4');
    addNext(analysis.lowTiers.bac5, 'Bậc 5');
  }
  const board80Grid = document.getElementById('board80Grid');

  board80Grid.innerHTML = (analysis.board80 || [])
    .map((item) => {
      const n = item.number;
      const inDrawn = drawnSet.has(n);
      const nextTiers = nextPredTiersMap.get(n);
      const inPred = Boolean(nextTiers && nextTiers.length > 0);
      let cls = 'cell-80';
      if (inDrawn && inPred) cls += ' is-both';
      else if (inPred) cls += ' is-predicted';
      else if (inDrawn) cls += ' is-drawn';

      const tooltip = `Số ${pad2(n)} | Điểm AI: ${item.totalScore} (${item.confidence}%) | Về ${
        item.count20
      }/20 kỳ | Gan: ${item.gap} kỳ | Bệt: ${item.streak} kỳ${inPred ? ' | Dự đoán: ' + nextTiers.join(', ') : ''}`;
      return `<div class="${cls}" title="${tooltip}">${pad2(n)}</div>`;
    })
    .join('');

  // 3. VIP Low Tiers (Bậc 2, Bậc 3, Bậc 4, Bậc 5)
  const tiers = [
    analysis.lowTiers.bac2,
    analysis.lowTiers.bac3,
    analysis.lowTiers.bac4,
    analysis.lowTiers.bac5
  ];

  document.getElementById('tiersGrid').innerHTML = tiers
    .map(
      (t) => `
      <div class="tier-card tier-${t.tier}">
        <div class="tier-top">
          <span class="tier-name">💎 VIP ${t.label.toUpperCase()} (${t.numbers.length} SỐ)</span>
          <span class="tier-conf">Độ tin cậy: ${t.confidence}%</span>
        </div>
        <div class="tier-balls">
          ${t.numbers.map((num) => `<div class="pred-ball">${pad2(num)}</div>`).join('')}
        </div>
        <div class="tier-prize-note">${t.prizeInfo}</div>
      </div>
    `
    )
    .join('');

  // 4. Top 4 Synergy Pairs for Bậc 2
  const topPairs = analysis.lowTiers.topPairsBac2 || [];
  document.getElementById('topPairsGrid').innerHTML = topPairs
    .map(
      (p, i) => `
      <div class="pair-box">
        <div style="font-size:11px;font-weight:700;color:#38bdf8;">Cặp Song Thủ #${i + 1} (${p.confidence}%)</div>
        <div class="pair-nums">
          <div class="pair-ball">${pad2(p.numbers[0])}</div>
          <div class="pair-ball">${pad2(p.numbers[1])}</div>
        </div>
        <div class="pair-meta">Điểm hợp lực: <strong>${p.synergyScore}</strong></div>
        <div class="pair-status-tag ${p.pairStatus || 'due'}">${p.pairNote || 'Đang vào điểm rơi chu kỳ'}</div>
      </div>
    `
    )
    .join('');

  // 5. Parity & Size Prediction
  const ps = analysis.parityAndSize;
  document.getElementById('paritySizeGrid').innerHTML = `
    <div class="ps-box">
      <div class="ps-header">
        <span>CẦU CHẴN / LẺ KỲ #${analysis.nextDrawId}</span>
        <span style="color:#34d399;font-weight:700;">${ps.parityConfidence}%</span>
      </div>
      <div class="ps-pick">${ps.parityPick}</div>
      <div class="ps-reason">${ps.parityReason}</div>
    </div>
    <div class="ps-box">
      <div class="ps-header">
        <span>CẦU LỚN / NHỎ KỲ #${analysis.nextDrawId}</span>
        <span style="color:#34d399;font-weight:700;">${ps.sizeConfidence}%</span>
      </div>
      <div class="ps-pick">${ps.sizePick}</div>
      <div class="ps-reason">${ps.sizeReason}</div>
    </div>
  `;

  // 6. Adaptive Weights & Zone Bars
  const w = analysis.activeWeights;
  const acc = analysis.modelAccuracy;
  const weightModels = [
    {
      name: '🔥 Tần Suất Lũy Tiến Toàn Mẫu (Expanding Frequency - Ưu tiên số hay ra)',
      weight: Math.round(w.freq * 100),
      acc: acc.freq,
      desc: `Tập trung vào nhóm các con số có tần suất xuất hiện nhiều nhất trên toàn bộ ${analysis.totalHistoricalDraws} kỳ`
    },
    {
      name: '⚡ Phong Độ 10 Kỳ Gần Nhất (Recent Hot Momentum)',
      weight: Math.round(w.momentum10 * 100),
      acc: acc.momentum10,
      desc: 'Bắt nhịp các con số đang có phong độ cao, nổ đều đặn trong 10 kỳ quay gần đây'
    },
    {
      name: '🔗 Ma Trận Kéo Theo Markov (Conditional Transitions)',
      weight: Math.round(w.markov * 100),
      acc: acc.markov,
      desc: 'Tính lực kéo chuyển tiếp trực tiếp từ 20 con số vừa nổ ở kỳ gần nhất'
    },
    {
      name: '⏳ Điểm Rơi Chu Kỳ & Nhịp Rơi (Cycle Rhythms & Gaps)',
      weight: Math.round(w.cycle * 100),
      acc: acc.cycle,
      desc: 'Bắt nhịp rơi cách 0-4 kỳ và chu kỳ xuất hiện của các con số hay về'
    }
  ];

  document.getElementById('weightsList').innerHTML = weightModels
    .map(
      (m) => `
      <div class="weight-item">
        <div class="weight-top">
          <span>${m.name}</span>
          <span style="color:#38bdf8;">Trọng số: ${m.weight}% <small style="color:#94a3b8;">(Tỷ lệ trúng: ${m.acc}%)</small></span>
        </div>
        <div class="weight-bar-bg">
          <div class="weight-bar-fill" style="width: ${Math.min(100, m.weight * 2)}%"></div>
        </div>
        <div class="weight-sub">${m.desc}</div>
      </div>
    `
    )
    .join('');

  document.getElementById('zonesBars').innerHTML = (analysis.zones || [])
    .map(
      (z) => `
      <div class="zone-chip">
        <div class="zone-range">Đầu ${z.range}</div>
        <div class="zone-val">${z.hitsInLast5} lần</div>
        <div style="font-size:10.5px;color:#64748b;">TB ${z.avgPerDraw}/kỳ</div>
      </div>
    `
    )
    .join('');

  // 7. Top 12 Ranked Numbers Table
  document.getElementById('top12TableBody').innerHTML = (analysis.top12Ranked || [])
    .map(
      (item, idx) => `
      <tr>
        <td><strong>#${idx + 1}</strong></td>
        <td><span class="mini-ball hit">${pad2(item.number)}</span></td>
        <td><strong style="color:#38bdf8;">${item.totalScore}</strong></td>
        <td><span style="color:#34d399;font-weight:700;">${item.confidence}%</span></td>
        <td>${item.countAll}/${analysis.totalHistoricalDraws}k <small style="color:#64748b;">(${item.count10}/10k)</small></td>
        <td>${
          item.gap === 0
            ? `<span style="color:#fbbf24;font-weight:700;">Bệt ${item.streak} kỳ</span>`
            : `Cách ${item.gap} kỳ`
        }</td>
        <td>
          <span class="sat-tag ${item.statusType || 'optimal'}">${item.statusNote || 'Số hay ra'}</span>
        </td>
      </tr>
    `
    )
    .join('');

  // 8. Hot / Streak / Cold Lists
  document.getElementById('statTotalDraws').textContent = analysis.totalHistoricalDraws;

  document.getElementById('hotNumbersList').innerHTML = (analysis.hotNumbers || [])
    .map(
      (x) => `
      <div class="stat-chip">
        <span class="mini-ball hot">${pad2(x.number)}</span>
        <span>${x.countAll} lần <small style="color:#64748b;">(${x.count20}/20k)</small></span>
      </div>
    `
    )
    .join('');

  const streaks = analysis.streakNumbers || [];
  document.getElementById('streakNumbersList').innerHTML =
    streaks.length > 0
      ? streaks
          .map(
            (x) => `
          <div class="stat-chip">
            <span class="mini-ball streak">${pad2(x.number)}</span>
            <span>Thông ${x.streak} kỳ</span>
          </div>
        `
          )
          .join('')
      : `<span style="font-size:12px;color:#64748b;">Kỳ vừa rồi không có số thông >= 2 kỳ</span>`;

  document.getElementById('coldNumbersList').innerHTML = (analysis.coldNumbers || [])
    .map(
      (x) => `
      <div class="stat-chip">
        <span class="mini-ball cold">${pad2(x.number)}</span>
        <span>Gan ${x.gap} kỳ</span>
      </div>
    `
    )
    .join('');

  // 9. Walk-Forward Backtest Table
  const btSum = analysis.backtestSummary || {};
  const evalCount = btSum.evaluatedDraws || 1;
  const b2Rate = btSum.bac2WinRate !== undefined ? btSum.bac2WinRate : ((btSum.bac2WinCount || 0) / evalCount * 100).toFixed(1);
  const b3Rate = btSum.bac3WinRate !== undefined ? btSum.bac3WinRate : ((btSum.bac3WinCount || 0) / evalCount * 100).toFixed(1);
  const b4Rate = btSum.bac4WinRate !== undefined ? btSum.bac4WinRate : ((btSum.bac4WinCount || 0) / evalCount * 100).toFixed(1);
  const b5Rate = btSum.bac5WinRate !== undefined ? btSum.bac5WinRate : ((btSum.bac5WinCount || 0) / evalCount * 100).toFixed(1);

  document.getElementById('backtestSummaryBadges').innerHTML = `
    <span class="bt-badge">Kiểm chứng: <strong>${btSum.evaluatedDraws || 0} kỳ</strong></span>
    <span class="bt-badge">Bậc 2 trúng: <strong>${btSum.bac2WinCount || 0} kỳ</strong> (${b2Rate}% · x9)</span>
    <span class="bt-badge">Bậc 3 trúng: <strong>${btSum.bac3WinCount || 0} kỳ</strong> (${b3Rate}%)</span>
    <span class="bt-badge">Bậc 4 trúng: <strong>${btSum.bac4WinCount || 0} kỳ</strong> (${b4Rate}%)</span>
    <span class="bt-badge">Bậc 5 trúng: <strong>${btSum.bac5WinCount || 0} kỳ</strong> (${b5Rate}%)</span>
    <span class="bt-badge" style="background:rgba(56,189,248,0.15);color:#38bdf8;border-color:rgba(56,189,248,0.3);">TB bóng trúng: <strong>${btSum.avgTop5HitRate || 0}%</strong></span>
  `;

  const renderTierCell = (tierObj) => {
    const hitSet = new Set(tierObj.hits || []);
    const balls = (tierObj.predicted || [])
      .map((n) => `<span class="mini-ball ${hitSet.has(n) ? 'hit' : ''}">${pad2(n)}</span>`)
      .join('');
    const isWin = (tierObj.prize || 0) > 0;
    const hitLabel = `Trúng ${tierObj.hitCount}/${tierObj.predicted.length}`;
    const color = isWin ? '#34d399' : (tierObj.hitCount > 0 ? '#38bdf8' : '#64748b');
    return `
      <div>${balls}</div>
      <div style="font-size:10.5px;color:${color};font-weight:${isWin ? '700' : '500'};margin-top:2px;">
        ${isWin ? `🏆 ${hitLabel} (+${formatVnd(tierObj.prize)})` : hitLabel}
      </div>
    `;
  };

  document.getElementById('backtestTableBody').innerHTML = (analysis.backtestHistory || [])
    .map((row) => {
      const prizes = [];
      if (row.bac2.prize > 0) prizes.push(`Bậc 2: +${formatVnd(row.bac2.prize)}`);
      if (row.bac3.prize > 0) prizes.push(`Bậc 3: +${formatVnd(row.bac3.prize)}`);
      if (row.bac4.prize > 0) prizes.push(`Bậc 4: +${formatVnd(row.bac4.prize)}`);
      if (row.bac5.prize > 0) prizes.push(`Bậc 5: +${formatVnd(row.bac5.prize)}`);

      const resultCell = prizes.length > 0
        ? prizes.map((p) => `<div class="prize-win" style="margin:2px 0;">🏆 ${p}</div>`).join('')
        : `
          <div style="font-size:10.5px;line-height:1.4;color:#94a3b8;">
            <span style="color:${row.bac2.hitCount > 0 ? '#38bdf8' : '#64748b'}">B2: ${row.bac2.hitCount}/2</span> · 
            <span style="color:${row.bac3.hitCount > 0 ? '#38bdf8' : '#64748b'}">B3: ${row.bac3.hitCount}/3</span><br/>
            <span style="color:${row.bac4.hitCount > 0 ? '#38bdf8' : '#64748b'}">B4: ${row.bac4.hitCount}/4</span> · 
            <span style="color:${row.bac5.hitCount > 0 ? '#38bdf8' : '#64748b'}">B5: ${row.bac5.hitCount}/5</span>
          </div>
        `;

      return `
        <tr>
          <td>
            <strong>#${row.drawId}</strong>
            <div style="font-size:11px;color:#64748b;">${row.time}</div>
            ${
              row.sampleSizeUsed
                ? `<div style="font-size:10.5px;color:#38bdf8;font-weight:600;">Mẫu: ${row.sampleSizeUsed} kỳ</div>`
                : ''
            }
          </td>
          <td>${renderTierCell(row.bac2)}</td>
          <td>${renderTierCell(row.bac3)}</td>
          <td>${renderTierCell(row.bac4)}</td>
          <td>${renderTierCell(row.bac5)}</td>
          <td>${resultCell}</td>
        </tr>
      `;
    })
    .join('');

  // 10. Recent Draw History Table
  document.getElementById('historyTableBody').innerHTML = (recentDraws || [])
    .map(
      (d) => `
      <tr>
        <td><strong>#${d.drawId}</strong></td>
        <td>
          <div><strong>${d.time}</strong></div>
          <div style="font-size:10.5px;color:#64748b;">${d.date}</div>
        </td>
        <td>
          ${d.numbers.map((n) => `<span class="mini-ball">${pad2(n)}</span>`).join('')}
        </td>
        <td>
          <div style="font-size:11.5px;color:#38bdf8;">${d.parityLabel}</div>
          <div style="font-size:11.5px;color:#fb923c;">${d.sizeLabel}</div>
        </td>
      </tr>
    `
    )
    .join('');
}

// Connect Server-Sent Events (SSE)
function connectLiveStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('init', (e) => {
    const data = JSON.parse(e.data);
    renderAll(data);
  });

  es.addEventListener('state_update', (e) => {
    const data = JSON.parse(e.data);
    renderAll(data);
  });

  es.addEventListener('new_draw', (e) => {
    const data = JSON.parse(e.data);
    renderAll(data);
    playNotificationChime();
    const latest = data.analysis?.latestDraw;
    if (latest) {
      showToast(
        `🎉 Đã có kết quả kỳ mới <strong>#${latest.drawId} (${latest.time})</strong>! Đã tính xong dự đoán kỳ <strong>#${data.analysis.nextDrawId}</strong>.`
      );
    }
  });

  es.addEventListener('poll_status', (e) => {
    const info = JSON.parse(e.data);
    renderPollStatus(info);
  });

  es.onerror = () => {
    document.getElementById('pollStatusText').textContent = 'Đang tự động kết nối lại stream...';
  };
}

// Local 1-second countdown ticker
setInterval(() => {
  if (localCountdownSec > 0) {
    localCountdownSec--;
  } else {
    awaitingResultFlag = true;
  }
  renderCountdownUI();
}, 1000);

// Event Listeners
document.getElementById('btnRefreshNow')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnRefreshNow');
  btn.disabled = true;
  btn.textContent = '⏳ Đang quét...';
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const data = await res.json();
    renderAll(data);
    if (data.refreshResult?.added > 0) {
      showToast(`✅ Đã cập nhật thêm ${data.refreshResult.added} kỳ quay mới!`);
    } else {
      showToast(`ℹ️ Dữ liệu hiện tại đã là kỳ mới nhất (#${data.analysis?.latestDraw?.drawId || '---'}).`);
    }
  } catch (err) {
    showToast(`⚠️ Lỗi khi quét thủ công: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Quét Kết Quả Ngay';
  }
});

document.getElementById('btnSoundToggle')?.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  const btn = document.getElementById('btnSoundToggle');
  btn.textContent = soundEnabled ? '🔔 Âm báo: BẬT' : '🔕 Âm báo: TẮT';
});

document.getElementById('btnExpandHistory')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnExpandHistory');
  btn.disabled = true;
  btn.textContent = '⏳ Đang nạp sâu...';
  try {
    const res = await fetch('/api/expand-history?pages=10', { method: 'POST' });
    const data = await res.json();
    renderAll(data);
    const total = data.analysis?.totalHistoricalDraws || data.refreshResult?.totalSample || '--';
    if (data.refreshResult?.added > 0) {
      showToast(
        `📈 Đã nạp thêm <strong>${data.refreshResult.added} kỳ</strong> lịch sử! Tổng mẫu tính toán hiện tại: <strong>${total} kỳ</strong>.`
      );
    } else {
      showToast(`ℹ️ Đã nạp tối đa nguồn lịch sử hiện có (Tổng mẫu: <strong>${total} kỳ</strong>).`);
    }
  } catch (err) {
    showToast(`⚠️ Lỗi khi mở rộng mẫu: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '📥 Mở Rộng Mẫu (+Kỳ Cũ)';
  }
});

document.getElementById('strategySelect')?.addEventListener('change', async (e) => {
  const mode = e.target.value;
  try {
    const res = await fetch(`/api/state?mode=${encodeURIComponent(mode)}`);
    const data = await res.json();
    renderAll(data);
  } catch (err) {
    console.error('Failed to switch strategy mode:', err);
  }
});

// Start
connectLiveStream();

