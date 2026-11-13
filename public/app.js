let appState = null;
let soundEnabled = true;
let localCountdownSec = 0;
let awaitingResultFlag = false;
let sharedAudioCtx = null;

const pad2 = (n) => String(n).padStart(2, '0');
const formatVnd = (n) => new Intl.NumberFormat('vi-VN').format(n) + 'đ';

function unlockAudioContext() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedAudioCtx) {
      sharedAudioCtx = new AudioCtx();
    }
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let errDetail = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      if (text) errDetail += `: ${text.slice(0, 120)}`;
    } catch {
      // Ignore response read failure
    }
    throw new Error(errDetail);
  }
  return res.json();
}

function playNotificationChime() {
  if (!soundEnabled) return;
  try {
    const ctx = unlockAudioContext();
    if (!ctx || ctx.state === 'suspended') return;
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
  if (dot && txt) {
    if (info.isPolling) {
      dot.classList.add('polling');
    } else {
      dot.classList.remove('polling');
    }
    if (info.lastPollStatus) {
      txt.textContent = info.lastPollStatus;
    }
  }

  // Keep client timer and awaiting state synced even when polls find 0 new draws
  if (info.schedule) {
    const s = info.schedule;
    awaitingResultFlag = Boolean(s.awaitingNewResult);
    const nextTimeEl = document.getElementById('headerNextDrawTime');
    if (nextTimeEl) {
      nextTimeEl.textContent = `Giờ quay: ${s.expectedDrawTimeStr}`;
    }
    if (
      !s.awaitingNewResult &&
      (localCountdownSec <= 0 || Math.abs(localCountdownSec - s.secondsUntilNextSchedule) > 3)
    ) {
      localCountdownSec = s.secondsUntilNextSchedule;
    }
    renderCountdownUI();
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

  // Build map of numbers predicted across all tiers in the matching backtest draw
  const predTiersMap = new Map();
  if (latest && latestBacktest && latestBacktest.drawId === latest.drawId) {
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
      const t4 = latestBacktest.top4Pairs;
      const b3 = latestBacktest.bac3;
      const b4 = latestBacktest.bac4;
      const b5 = latestBacktest.bac5;
      const singlePrize = (b2.prize || 0) + (b3.prize || 0) + (b4.prize || 0) + (b5.prize || 0);
      const t4Prize = t4?.prize || 0;

      const chipB2 = `<span class="${b2.prize > 0 ? 'prize-win' : 'stat-pill'}">VIP #1: <strong>${b2.hitCount}/2</strong>${b2.prize > 0 ? ' 🏆' : ''}</span>`;
      const chipT4 = t4
        ? `<span class="${t4.wonAny ? 'prize-win' : 'stat-pill'}">Dàn 4 cặp: <strong>${t4.winCount}/4 nổ</strong>${t4.wonAny ? ' 🏆' : ''}</span>`
        : '';
      const chipB3 = `<span class="${b3.prize > 0 ? 'prize-win' : 'stat-pill'}">Bậc 3: <strong>${b3.hitCount}/3</strong>${b3.prize > 0 ? ' 🏆' : ''}</span>`;
      const chipB4 = `<span class="${b4.prize > 0 ? 'prize-win' : 'stat-pill'}">Bậc 4: <strong>${b4.hitCount}/4</strong>${b4.prize > 0 ? ' 🏆' : ''}</span>`;
      const chipB5 = `<span class="${b5.prize > 0 ? 'prize-win' : 'stat-pill'}">Bậc 5: <strong>${b5.hitCount}/5</strong>${b5.prize > 0 ? ' 🏆' : ''}</span>`;

      hitBanner.innerHTML = `
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;width:100%;">
          <span>🎯 Đối soát kỳ <strong>#${latest.drawId}</strong> (Mẫu: <strong>${latestBacktest.sampleSizeUsed || analysis.totalHistoricalDraws - 1} kỳ</strong>):</span>
          <div style="display:inline-flex;gap:6px;flex-wrap:wrap;">
            ${chipB2} ${chipT4} ${chipB3} ${chipB4} ${chipB5}
          </div>
          ${
            t4Prize > 0 || singlePrize > 0
              ? `<span class="prize-win" style="margin-left:auto;">🏆 ${t4Prize > 0 ? `Dàn 4 cặp +${formatVnd(t4Prize)}` : ''}${t4Prize > 0 && singlePrize > 0 ? ' · ' : ''}${singlePrize > 0 ? `Đơn +${formatVnd(singlePrize)}` : ''}</span>`
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
      name: '🔗 Ma Trận Chuyển Tiếp Shrunk Markov (Alpha=150 LLR)',
      weight: Math.round(w.markov * 100),
      acc: acc.markov,
      desc: 'Tính lực kéo điều kiện từ 20 số kỳ trước với làm mượt Bayesian về nền 25%'
    },
    {
      name: '🔥 Tần Suất Lũy Tiến Empirical-Bayes (Expanding Freq)',
      weight: Math.round(w.freq * 100),
      acc: acc.freq,
      desc: `Đo log-odds xuất hiện của từng số trên toàn bộ ${analysis.totalHistoricalDraws} kỳ lịch sử`
    },
    {
      name: '⚡ Phong Độ Mượt EWMA (HL=12 & HL=28 kỳ)',
      weight: Math.round(((w.momentum10 || 0) + (w.momentum20 || 0)) * 100),
      acc: acc.momentum10,
      desc: 'Trung bình hàm mũ đa khung thời gian tránh nhiễu gãy đoạn khi thay đổi cửa sổ'
    },
    {
      name: '⏳ Nhịp Rơi & Chống Kiệt Sức (Calibrated Cycle Z)',
      weight: Math.round(w.cycle * 100),
      acc: acc.cycle,
      desc: 'Hiệu chuẩn thang Z-score cho nhịp rơi 0–1 kỳ, chu kỳ 7–8 kỳ và phạt bệt >= 4 kỳ'
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
          <div class="weight-bar-fill" style="width: ${Math.min(100, Math.max(4, m.weight))}%"></div>
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
        <td class="t12-rank" data-label="Hạng"><strong>#${idx + 1}</strong></td>
        <td class="t12-num" data-label="Số"><span class="mini-ball hit">${pad2(item.number)}</span></td>
        <td class="t12-score" data-label="Điểm Tổng"><strong style="color:#38bdf8;">${item.totalScore}</strong></td>
        <td class="t12-conf" data-label="Tin Cậy"><span style="color:#34d399;font-weight:700;">${item.confidence}%</span></td>
        <td class="t12-freq" data-label="Tần Suất">${item.countAll}/${analysis.totalHistoricalDraws}k <small style="color:#64748b;">(${item.count10}/10k)</small></td>
        <td class="t12-gap" data-label="Chu Kỳ / Gan">${
          item.gap === 0
            ? `<span style="color:#fbbf24;font-weight:700;">Bệt ${item.streak} kỳ</span>`
            : `Cách ${item.gap} kỳ`
        }</td>
        <td class="t12-status" data-label="Phong Độ">
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
  const theo = btSum.theoretical || {};
  const b2Rate = btSum.bac2WinRate !== undefined ? btSum.bac2WinRate : ((btSum.bac2WinCount || 0) / evalCount * 100).toFixed(1);
  const b3Rate = btSum.bac3WinRate !== undefined ? btSum.bac3WinRate : ((btSum.bac3WinCount || 0) / evalCount * 100).toFixed(1);
  const b4Rate = btSum.bac4WinRate !== undefined ? btSum.bac4WinRate : ((btSum.bac4WinCount || 0) / evalCount * 100).toFixed(1);
  const b5Rate = btSum.bac5WinRate !== undefined ? btSum.bac5WinRate : ((btSum.bac5WinCount || 0) / evalCount * 100).toFixed(1);
  const t4Rate = btSum.top4AnyWinRate ?? 0;
  const l100 = btSum.last100;

  const rtpColor = (rtp) => (rtp >= 100 ? '#34d399' : rtp >= 70 ? '#38bdf8' : '#fbbf24');

  document.getElementById('backtestSummaryBadges').innerHTML = `
    <span class="bt-badge">Kiểm chứng: <strong>${btSum.evaluatedDraws || 0} kỳ</strong></span>
    <span class="bt-badge">VIP #1 (B2): <strong>${btSum.bac2WinCount || 0}</strong> (${b2Rate}% · <span style="color:${rtpColor(btSum.bac2Rtp || 0)}">RTP ${btSum.bac2Rtp ?? '--'}%</span> <small style="opacity:0.75">/ LT ${theo.bac2Rtp ?? 54.1}%</small>)</span>
    <span class="bt-badge" style="background:rgba(56,189,248,0.16);color:#38bdf8;border-color:rgba(56,189,248,0.35);">Dàn 4 Cặp Độc Lập: <strong>${btSum.top4AnyWinCount || 0} kỳ nổ</strong> (${t4Rate}% <small style="opacity:0.75">/ LT ${theo.top4DisjointAnyWinRate ?? 22.3}%</small> · <span style="color:${rtpColor(btSum.top4Rtp || 0)}">RTP ${btSum.top4Rtp ?? '--'}%</span> <small style="opacity:0.75">/ LT ${theo.top4DisjointRtp ?? 54.1}%</small>)</span>
    ${
      l100
        ? `<span class="bt-badge" style="background:rgba(245,158,11,0.14);color:#fde68a;border-color:rgba(245,158,11,0.35);">${l100.evaluatedDraws} kỳ gần nhất: VIP#1 <strong>${l100.bac2WinRate}%</strong> (RTP ${l100.bac2Rtp}%) · Dàn 4 cặp <strong>${l100.top4AnyWinRate}%</strong> (RTP ${l100.top4Rtp}%)</span>`
        : ''
    }
    <span class="bt-badge">Bậc 3: <strong>${b3Rate}%</strong> (RTP ${btSum.bac3Rtp ?? '--'}%)</span>
    <span class="bt-badge">Bậc 4: <strong>${b4Rate}%</strong> (RTP ${btSum.bac4Rtp ?? '--'}%)</span>
    <span class="bt-badge">Bậc 5: <strong>${b5Rate}%</strong> (RTP ${btSum.bac5Rtp ?? '--'}%)</span>
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
      <div class="tier-cell-balls">${balls}</div>
      <div style="font-size:10.5px;color:${color};font-weight:${isWin ? '700' : '500'};margin-top:2px;">
        ${isWin ? `🏆 ${hitLabel} (+${formatVnd(tierObj.prize)})` : hitLabel}
      </div>
    `;
  };

  const renderTop4Cell = (t4Obj) => {
    if (!t4Obj || !t4Obj.pairs) return '<span style="color:#64748b">--</span>';
    const pairTags = t4Obj.pairs
      .map((p) => {
        const hSet = new Set(p.hits || []);
        const cls = p.won ? 'border:1px solid #10b981;background:rgba(16,185,129,0.18);' : 'border:1px solid #23314d;background:#0f172a;';
        const numsHtml = p.numbers
          .map((n) => `<span class="mini-ball ${hSet.has(n) ? 'hit' : ''}" style="width:21px;height:21px;font-size:10.5px;">${pad2(n)}</span>`)
          .join('');
        return `<span style="display:inline-flex;align-items:center;gap:2px;padding:2px 4px;border-radius:6px;${cls}">${numsHtml}</span>`;
      })
      .join(' ');
    const isWin = t4Obj.wonAny;
    const color = isWin ? '#34d399' : '#64748b';
    return `
      <div class="top4-pairs-wrap">${pairTags}</div>
      <div style="font-size:10.5px;color:${color};font-weight:${isWin ? '700' : '500'};margin-top:3px;">
        ${isWin ? `🏆 Nổ ${t4Obj.winCount}/4 cặp (+${formatVnd(t4Obj.prize)})` : '0/4 cặp nổ'}
      </div>
    `;
  };

  document.getElementById('backtestTableBody').innerHTML = (analysis.backtestHistory || [])
    .map((row) => {
      const prizes = [];
      if (row.top4Pairs?.prize > 0) prizes.push(`Dàn 4 cặp (${row.top4Pairs.winCount}/4): +${formatVnd(row.top4Pairs.prize)}`);
      if (row.bac2.prize > 0) prizes.push(`VIP #1: +${formatVnd(row.bac2.prize)}`);
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
          <td class="bt-draw" data-label="Kỳ Quay">
            <strong>#${row.drawId}</strong>
            <div class="bt-draw-meta">
              <div style="font-size:11px;color:#64748b;">${row.time}</div>
              ${
                row.sampleSizeUsed
                  ? `<div style="font-size:10.5px;color:#38bdf8;font-weight:600;">Mẫu: ${row.sampleSizeUsed} kỳ</div>`
                  : ''
              }
            </div>
          </td>
          <td class="bt-bac2" data-label="Bậc 2 (VIP #1)">${renderTierCell(row.bac2)}</td>
          <td class="bt-top4" data-label="Dàn 4 Cặp Độc Lập">${renderTop4Cell(row.top4Pairs)}</td>
          <td class="bt-bac3" data-label="Bậc 3">${renderTierCell(row.bac3)}</td>
          <td class="bt-bac4" data-label="Bậc 4">${renderTierCell(row.bac4)}</td>
          <td class="bt-bac5" data-label="Bậc 5">${renderTierCell(row.bac5)}</td>
          <td class="bt-result" data-label="Kết Quả Đối Soát">${resultCell}</td>
        </tr>
      `;
    })
    .join('');

  // 10. Recent Draw History Table
  document.getElementById('historyTableBody').innerHTML = (recentDraws || [])
    .map(
      (d) => `
      <tr>
        <td class="hist-draw" data-label="Kỳ"><strong>#${d.drawId}</strong></td>
        <td class="hist-time" data-label="Giờ">
          <div><strong>${d.time}</strong></div>
          <div style="font-size:10.5px;color:#64748b;">${d.date}</div>
        </td>
        <td class="hist-balls" data-label="20 Số Kết Quả">
          ${d.numbers.map((n) => `<span class="mini-ball">${pad2(n)}</span>`).join('')}
        </td>
        <td class="hist-meta" data-label="Chẵn/Lẻ · Lớn/Nhỏ">
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
  unlockAudioContext();
  const btn = document.getElementById('btnRefreshNow');
  btn.disabled = true;
  btn.textContent = '⏳ Đang quét...';
  try {
    const data = await fetchJson('/api/refresh', { method: 'POST' });
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
  if (soundEnabled) unlockAudioContext();
  const btn = document.getElementById('btnSoundToggle');
  btn.textContent = soundEnabled ? '🔔 Âm báo: BẬT' : '🔕 Âm báo: TẮT';
});

document.getElementById('btnExpandHistory')?.addEventListener('click', async () => {
  unlockAudioContext();
  const btn = document.getElementById('btnExpandHistory');
  btn.disabled = true;
  btn.textContent = '⏳ Đang nạp sâu...';
  try {
    const data = await fetchJson('/api/expand-history?days=2&pages=8', { method: 'POST' });
    renderAll(data);
    const total = data.analysis?.totalHistoricalDraws || data.refreshResult?.totalSample || '--';
    if (data.refreshResult?.added > 0) {
      showToast(
        `📈 Đã nạp thêm <strong>${data.refreshResult.added} kỳ</strong> cũ! Tổng mẫu tính toán hiện tại: <strong>${total} kỳ</strong>.`
      );
    } else if (data.refreshResult?.limitReached) {
      showToast(`ℹ️ Đã đạt giới hạn bộ nhớ tối đa (<strong>${total} kỳ</strong>).`);
    } else {
      showToast(`ℹ️ Không còn kỳ cũ hơn khả dụng từ nguồn (Tổng mẫu: <strong>${total} kỳ</strong>).`);
    }
  } catch (err) {
    showToast(`⚠️ Lỗi khi mở rộng mẫu: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '📥 Mở Rộng Mẫu (+Kỳ Cũ)';
  }
});

document.getElementById('strategySelect')?.addEventListener('change', async (e) => {
  const selectEl = e.target;
  const mode = selectEl.value;
  const prevMode = appState?.analysis?.mode;
  selectEl.disabled = true;
  try {
    const data = await fetchJson(`/api/state?mode=${encodeURIComponent(mode)}`);
    renderAll(data);
  } catch (err) {
    console.error('Failed to switch strategy mode:', err);
    if (prevMode) selectEl.value = prevMode;
    showToast(`⚠️ Không thể đổi chiến lược: ${err.message}`);
  } finally {
    selectEl.disabled = false;
  }
});

// Start
connectLiveStream();

