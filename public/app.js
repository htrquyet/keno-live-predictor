/* Vietlott Bingo18 Live Analytics, Calculator & Point-of-Fall Predictor */

const STORAGE_CACHE_KEY = 'bingo18_cached_draws_v1';
const DICE_DOTS = { 1: '⚀', 2: '⚁', 3: '⚂', 4: '⚃', 5: '⚄', 6: '⚅' };

const SUM_PAYOUT_MAP = {
  3: { ways: 1, prize10k: 1200000, mult: 120 },
  4: { ways: 3, prize10k: 400000, mult: 40 },
  5: { ways: 6, prize10k: 200000, mult: 20 },
  6: { ways: 10, prize10k: 120000, mult: 12 },
  7: { ways: 15, prize10k: 80000, mult: 8 },
  8: { ways: 21, prize10k: 55000, mult: 5.5 },
  9: { ways: 25, prize10k: 47000, mult: 4.7 },
  10: { ways: 27, prize10k: 44000, mult: 4.4 },
  11: { ways: 27, prize10k: 44000, mult: 4.4 },
  12: { ways: 25, prize10k: 47000, mult: 4.7 },
  13: { ways: 21, prize10k: 55000, mult: 5.5 },
  14: { ways: 15, prize10k: 80000, mult: 8 },
  15: { ways: 10, prize10k: 120000, mult: 12 },
  16: { ways: 6, prize10k: 200000, mult: 20 },
  17: { ways: 3, prize10k: 400000, mult: 40 },
  18: { ways: 1, prize10k: 1200000, mult: 120 }
};

// Precompute all 216 (6x6x6) outcomes for exact theoretical calculator math
const ALL_216_OUTCOMES = [];
for (let a = 1; a <= 6; a++) {
  for (let b = 1; b <= 6; b++) {
    for (let c = 1; c <= 6; c++) {
      const sum = a + b + c;
      const sizeType = sum >= 12 ? 'BIG' : sum <= 9 ? 'SMALL' : 'TIE';
      ALL_216_OUTCOMES.push({ numbers: [a, b, c], sum, sizeType });
    }
  }
}

let appState = {
  schedule: null,
  recentDraws: [],
  syncDraws: [],
  analysis: null,
  lastSeenDrawId: null,
  soundEnabled: true,
  countdownTimer: null,
  lastZeroTriggerMs: 0,
  calc: {
    playType: 'SINGLE',
    selectedOptions: new Set(['1']),
    stake: 10000,
    range: 100
  }
};

function formatVnd(amount) {
  return Number(amount || 0).toLocaleString('vi-VN') + 'đ';
}

function playNotificationChime() {
  if (!appState.soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const notes = [587.33, 783.99, 1046.5];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.11);
      gain.gain.setValueAtTime(0.14, ctx.currentTime + idx * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.11 + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + idx * 0.11);
      osc.stop(ctx.currentTime + idx * 0.11 + 0.34);
    });
  } catch {
    // Ignore audio context restriction
  }
}

function saveDrawsToLocalCache(draws) {
  if (!Array.isArray(draws) || draws.length === 0) return;
  try {
    const compact = draws.slice(-800).map((d) => ({
      drawId: d.drawId,
      drawNumber: d.drawNumber,
      date: d.date,
      time: d.time,
      numbers: d.numbers,
      source: d.source || 'cache'
    }));
    localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(compact));
  } catch {
    // Ignore storage quota errors
  }
}

async function syncLocalCacheToServerIfNeeded(serverDrawCount) {
  try {
    const raw = localStorage.getItem(STORAGE_CACHE_KEY);
    if (!raw) return;
    const cached = JSON.parse(raw);
    if (!Array.isArray(cached) || cached.length <= serverDrawCount) return;
    await fetch('/api/client-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draws: cached })
    });
  } catch {
    // Ignore sync error
  }
}

/* ==========================================================================
   1. RENDER LATEST DRAW, WINNING DOORS & ROADMAP
   ========================================================================== */
function computeWinningDoorsForDraw(draw) {
  const [a, b, c] = draw.numbers;
  const counts = [0, 0, 0, 0, 0, 0, 0];
  counts[a]++;
  counts[b]++;
  counts[c]++;

  const doors = [];

  // 1. Một số (1..6)
  for (let f = 1; f <= 6; f++) {
    if (counts[f] > 0) {
      const prz = counts[f] === 1 ? 12000 : counts[f] === 2 ? 20000 : 30000;
      doors.push({
        name: `Một số [Mặt ${f}]`,
        val: `Nổ ${counts[f]} nháy`,
        prize: formatVnd(prz)
      });
    }
  }

  // 2. Lớn / Hòa / Nhỏ
  if (draw.sizeType === 'BIG') {
    doors.push({ name: 'Cửa Lớn (12–18)', val: `Tổng ${draw.sum}`, prize: '15.000đ (x1.5)' });
  } else if (draw.sizeType === 'TIE') {
    doors.push({ name: 'Cửa Hòa (10–11)', val: `Tổng ${draw.sum}`, prize: '20.000đ (x2.0)' });
  } else {
    doors.push({ name: 'Cửa Nhỏ (3–9)', val: `Tổng ${draw.sum}`, prize: '15.000đ (x1.5)' });
  }

  // 3. Cộng tổng
  const sumMeta = SUM_PAYOUT_MAP[draw.sum];
  if (sumMeta) {
    doors.push({
      name: `Cộng tổng [${draw.sum}]`,
      val: `Tỷ lệ x${sumMeta.mult}`,
      prize: formatVnd(sumMeta.prize10k)
    });
  }

  // 4. Hai số trùng & Ba số trùng
  for (let f = 1; f <= 6; f++) {
    if (counts[f] >= 2) {
      doors.push({
        name: `Hai số trùng [${f}-${f}]`,
        val: counts[f] === 3 ? 'Nổ Bão 3 số' : 'Nổ Đôi trùng',
        prize: '75.000đ (x7.5)'
      });
    }
    if (counts[f] === 3) {
      doors.push({
        name: `Bão cụ thể [${f}${f}${f}]`,
        val: 'Ba số trùng',
        prize: '1.200.000đ (x120)'
      });
      doors.push({
        name: 'Bão bất kỳ',
        val: '111..666',
        prize: '200.000đ (x20)'
      });
    }
  }

  return doors;
}

function renderLatestDraw(analysis) {
  const latest = analysis?.latestDraw;
  if (!latest) return;

  document.getElementById('latestDrawId').textContent = `Kỳ #${latest.drawId}`;
  document.getElementById('latestDrawMeta').textContent = `${latest.date} · ${latest.time}`;
  document.getElementById('sampleCountBadge').textContent = `Mẫu phân tích: ${analysis.totalHistoricalDraws} kỳ`;
  document.getElementById('latestSlotBadge').textContent = `Kỳ thứ ${latest.slotIndex || '--'}/159 trong ngày`;

  // 3 Dice cards
  const ballsGrid = document.getElementById('latestBallsGrid');
  ballsGrid.innerHTML = latest.numbers
    .map(
      (n) => `
      <div class="dice-card face-${n}">
        <span>${n}</span>
        <span class="dice-dots">${DICE_DOTS[n] || ''}</span>
      </div>
    `
    )
    .join('');

  // Sum Orb
  const sumOrb = document.getElementById('latestSumOrb');
  const sumVal = document.getElementById('latestSumValue');
  sumVal.textContent = latest.sum;
  sumOrb.className = 'sum-orb ' + (latest.sizeType === 'BIG' ? 'sum-big' : latest.sizeType === 'SMALL' ? 'sum-small' : 'sum-tie');

  // Classification Badges
  const badgesRow = document.getElementById('latestBadgesRow');
  const sizeBadgeClass = latest.sizeType === 'BIG' ? 'badge-big' : latest.sizeType === 'SMALL' ? 'badge-small' : 'badge-tie';
  const matchBadgeClass = latest.matchType === 'TRIPLE' ? 'badge-triple' : latest.matchType === 'DOUBLE' ? 'badge-double' : '';
  const sumMeta = SUM_PAYOUT_MAP[latest.sum];

  badgesRow.innerHTML = `
    <span class="result-badge ${sizeBadgeClass}">🎯 ${latest.sizeLabel}</span>
    <span class="result-badge">⚖️ ${latest.parityLabel} (${latest.sum})</span>
    <span class="result-badge ${matchBadgeClass}">🎲 ${latest.matchLabel}</span>
    <span class="result-badge">💰 Thưởng Tổng ${latest.sum}: ${sumMeta ? formatVnd(sumMeta.prize10k) : '--'}/10k</span>
  `;

  // Winning Doors Grid
  const doors = computeWinningDoorsForDraw(latest);
  document.getElementById('latestWinningDoorsGrid').innerHTML = doors
    .map(
      (d) => `
      <div class="door-item">
        <span class="door-name">${d.name}</span>
        <span class="door-val">${d.val}</span>
        <span class="door-prize">${d.prize}</span>
      </div>
    `
    )
    .join('');

  // Instant Reconcile Banner for Latest Draw
  const btLatest = analysis.backtestHistory && analysis.backtestHistory[0];
  const reconcileBanner = document.getElementById('latestReconcileBanner');
  if (btLatest && btLatest.drawId === latest.drawId) {
    const parts = [];
    if (btLatest.single1.won) {
      parts.push(`✅ Độc thủ [${btLatest.single1.predicted}] NỔ ${btLatest.single1.appearCount} nháy (+${formatVnd(btLatest.single1.prize)})`);
    } else {
      parts.push(`❌ Độc thủ [${btLatest.single1.predicted}] trượt`);
    }
    if (btLatest.pair2.wonAny) {
      parts.push(`✅ Song thủ [${btLatest.pair2.predicted.join('-')}] NỔ (${btLatest.pair2.hits.join(', ')})`);
    } else {
      parts.push(`❌ Song thủ [${btLatest.pair2.predicted.join('-')}] trượt`);
    }
    if (btLatest.lhn.coverWon) {
      parts.push(`✅ Cầu [${btLatest.lhn.predictedLabel}] THẮNG`);
    }
    if (btLatest.sumTop4.won) {
      parts.push(`✅ Dàn 4 Tổng NỔ Tổng ${btLatest.actualSum} (+${formatVnd(btLatest.sumTop4.prize)})`);
    }
    reconcileBanner.innerHTML = `<strong>Đối soát kỳ #${latest.drawId}:</strong> ${parts.join(' · ')}`;
  }

  // 24-Draw Road-map
  const lhnSummary = analysis.stats?.lhnSummary;
  if (lhnSummary) {
    document.getElementById('lhnStatsQuickRow').textContent =
      `Lớn: ${lhnSummary.bigRate}% (Gan ${lhnSummary.bigGap}) · Hòa: ${lhnSummary.tieRate}% (Gan ${lhnSummary.tieGap}) · Nhỏ: ${lhnSummary.smallRate}% (Gan ${lhnSummary.smallGap})`;

    document.getElementById('lhnRoadmapRow').innerHTML = (lhnSummary.roadmap24 || [])
      .map(
        (item) => `
        <div class="road-bead bead-${item.sizeType}" title="Kỳ #${item.drawId} (${item.time}): ${item.numbers.join('-')} = Tổng ${item.sum}">
          <span class="bead-code">${item.sizeCode}${item.matchType === 'TRIPLE' ? '★' : item.matchType === 'DOUBLE' ? '•' : ''}</span>
          <span class="bead-sum">T${item.sum}</span>
        </div>
      `
      )
      .join('');
  }
}

/* ==========================================================================
   2. RENDER NEXT DRAW TRANSPARENT SUGGESTIONS
   ========================================================================== */
function renderPredictions(analysis) {
  if (!analysis || !analysis.predictions) return;
  const preds = analysis.predictions;

  document.getElementById('predNextDrawId').textContent = `#${analysis.nextDrawId}`;

  // Độc Thủ 1 Số
  document.getElementById('singleVipConf').textContent =
    `Đo: ${preds.singleVip.measuredRate}% · Chuẩn: ${preds.singleVip.theoreticalRate}%`;
  document.getElementById('singleVipFace').innerHTML = `
    <span class="vip-die face-${preds.singleVip.face}">${preds.singleVip.face}</span>
  `;
  document.getElementById('singleVipNote').textContent = preds.singleVip.reason;

  // Song Thủ 2 Số (Tách bạch nổ ≥1 số vs Hòa/Lãi thực >=20k)
  document.getElementById('pairVipConf').textContent =
    `Đo ≥1 số: ${preds.pairVip.measuredAnyRate}% · Chuẩn: ${preds.pairVip.theoreticalAnyRate}%`;
  document.getElementById('pairVipFaces').innerHTML = preds.pairVip.faces
    .map((f) => `<span class="vip-die face-${f}">${f}</span>`)
    .join('');
  document.getElementById('pairVipNote').textContent =
    `Hòa/Lãi ≥20k: ${preds.pairVip.measuredProfitRate}% (Lý thuyết: ${preds.pairVip.theoreticalProfitRate}%)`;

  // Tam Thủ 3 Số Bao Vây
  document.getElementById('tripleCoverConf').textContent = `Chuẩn: ${preds.tripleCoverVip.theoreticalAnyRate}%`;
  document.getElementById('tripleCoverFaces').innerHTML = preds.tripleCoverVip.faces
    .map((f) => `<span class="vip-die face-${f}">${f}</span>`)
    .join('');
  document.getElementById('tripleCoverNote').textContent =
    `Xác suất lý thuyết có ≥1 mặt: ${preds.tripleCoverVip.theoreticalAnyRate}%`;

  // Cầu Lớn / Hòa / Nhỏ
  const lhn = preds.lhnVip;
  if (lhn) {
    document.getElementById('lhnPredConf').textContent = `Chuẩn bọc Hòa: ${lhn.theoreticalCover}%`;
    document.getElementById('lhnPredMain').textContent = `🎯 ${lhn.mainPick}`;
    document.getElementById('lhnPredCover').textContent = `🛡️ ${lhn.comboPick}`;
    document.getElementById('lhnPredProbs').textContent =
      `Đo thực tế — Bọc Hòa: ${lhn.measuredCover}% (Chuẩn ${lhn.theoreticalCover}%) · Đơn cửa: ${lhn.measuredExact}% (${lhn.theoreticalExact}%)`;
    document.getElementById('lhnPredReason').textContent = lhn.reason;
  }

  // Top 2 Cặp Trùng Đôi
  const doubleList = document.getElementById('doubleVipList');
  doubleList.innerHTML = (preds.doubleVip || [])
    .map(
      (d) => `
      <div class="mini-pred-chip" title="${d.statusNote}">
        <span>Đôi trùng <strong>[${d.pairLabel}]</strong></span>
        <span>Gan ${d.currentGap}k · x7.5</span>
      </div>
    `
    )
    .join('');

  // Dàn 4 Tổng Vàng
  const sumList = document.getElementById('sumVipList');
  sumList.innerHTML = (preds.sumVip || [])
    .map(
      (s) => `
      <div class="mini-pred-chip">
        <span>Tổng <strong>${s.sum}</strong></span>
        <span>${formatVnd(s.prize)}/10k (Gan ${s.gap ?? s.currentGap ?? 0}k)</span>
      </div>
    `
    )
    .join('');
}

/* ==========================================================================
   3. INTERACTIVE TICKET CALCULATOR & HISTORICAL BACKTEST CHECKER
   ========================================================================== */
function getAvailableOptionsForPlayType(playType) {
  if (playType === 'SINGLE') {
    return [1, 2, 3, 4, 5, 6].map((f) => ({ id: String(f), label: `Mặt số ${f}` }));
  }
  if (playType === 'LHN') {
    return [
      { id: 'BIG', label: 'Lớn (12–18) · x1.5' },
      { id: 'TIE', label: 'Hòa (10–11) · x2.0' },
      { id: 'SMALL', label: 'Nhỏ (3–9) · x1.5' }
    ];
  }
  if (playType === 'SUM') {
    const arr = [];
    for (let s = 3; s <= 18; s++) {
      arr.push({ id: String(s), label: `Tổng ${s} (x${SUM_PAYOUT_MAP[s].mult})` });
    }
    return arr;
  }
  if (playType === 'DOUBLE') {
    return [1, 2, 3, 4, 5, 6].map((f) => ({ id: String(f), label: `Đôi ${f}-${f} (x7.5)` }));
  }
  if (playType === 'TRIPLE') {
    return [
      { id: 'ANY', label: 'Bão Bất Kỳ (111..666) · x20' },
      ...[1, 2, 3, 4, 5, 6].map((f) => ({ id: String(f), label: `Bão ${f}${f}${f} · x120` }))
    ];
  }
  return [];
}

function evaluateTicketOnSingleOutcome(playType, selectedSet, stakePerOption, outcome) {
  const ratio = stakePerOption / 10000;
  const [a, b, c] = outcome.numbers;
  let totalPrize = 0;

  if (playType === 'SINGLE') {
    for (const opt of selectedSet) {
      const face = parseInt(opt, 10);
      const cnt = (a === face ? 1 : 0) + (b === face ? 1 : 0) + (c === face ? 1 : 0);
      if (cnt === 1) totalPrize += 12000 * ratio;
      else if (cnt === 2) totalPrize += 20000 * ratio;
      else if (cnt === 3) totalPrize += 30000 * ratio;
    }
  } else if (playType === 'LHN') {
    for (const opt of selectedSet) {
      if (opt === outcome.sizeType) {
        totalPrize += (opt === 'TIE' ? 20000 : 15000) * ratio;
      }
    }
  } else if (playType === 'SUM') {
    for (const opt of selectedSet) {
      const s = parseInt(opt, 10);
      if (outcome.sum === s && SUM_PAYOUT_MAP[s]) {
        totalPrize += SUM_PAYOUT_MAP[s].prize10k * ratio;
      }
    }
  } else if (playType === 'DOUBLE') {
    for (const opt of selectedSet) {
      const face = parseInt(opt, 10);
      const cnt = (a === face ? 1 : 0) + (b === face ? 1 : 0) + (c === face ? 1 : 0);
      if (cnt >= 2) {
        totalPrize += 75000 * ratio;
      }
    }
  } else if (playType === 'TRIPLE') {
    const isTriple = a === b && b === c;
    if (isTriple) {
      for (const opt of selectedSet) {
        if (opt === 'ANY') {
          totalPrize += 200000 * ratio;
        } else if (parseInt(opt, 10) === a) {
          totalPrize += 1200000 * ratio;
        }
      }
    }
  }

  return Math.round(totalPrize);
}

function renderCalculatorChips() {
  const { playType, selectedOptions } = appState.calc;
  const options = getAvailableOptionsForPlayType(playType);
  if (selectedOptions.size === 0 && options.length > 0) {
    selectedOptions.add(options[0].id);
  }

  document.getElementById('calcSelectedCount').textContent = `Đã chọn: ${selectedOptions.size} cửa`;

  const container = document.getElementById('calcOptionChips');
  container.innerHTML = options
    .map(
      (opt) => `
      <button type="button" class="calc-chip ${selectedOptions.has(opt.id) ? 'active' : ''}" data-opt-id="${opt.id}">
        ${opt.label}
      </button>
    `
    )
    .join('');

  container.querySelectorAll('.calc-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-opt-id');
      if (selectedOptions.has(id)) {
        if (selectedOptions.size > 1) selectedOptions.delete(id);
      } else {
        selectedOptions.add(id);
      }
      renderCalculatorChips();
      updateCalculatorResults();
    });
  });
}

function updateCalculatorResults() {
  const { playType, selectedOptions, stake, range } = appState.calc;
  const doorCount = selectedOptions.size;
  const costPerDraw = doorCount * stake;

  // 1. Compute exact theoretical probability & max prize across all 216 outcomes
  let winWays = 0;
  let maxPrize = 0;
  let minWinPrize = Infinity;
  for (const outcome of ALL_216_OUTCOMES) {
    const prz = evaluateTicketOnSingleOutcome(playType, selectedOptions, stake, outcome);
    if (prz > 0) {
      winWays++;
      if (prz > maxPrize) maxPrize = prz;
      if (prz < minWinPrize) minWinPrize = prz;
    }
  }
  if (minWinPrize === Infinity) minWinPrize = 0;
  const theoProb = ((winWays / 216) * 100).toFixed(2);

  document.getElementById('calcTotalCost').textContent = formatVnd(costPerDraw);
  document.getElementById('calcTheoProb').textContent = `${theoProb}% (${winWays}/216 tổ hợp)`;
  document.getElementById('calcMaxPrize').textContent = formatVnd(maxPrize);

  document.getElementById('calcPayoutBreakdown').innerHTML =
    minWinPrize === maxPrize
      ? `💡 <strong>Cơ cấu trả thưởng vé đang chọn:</strong> Vốn <strong>${formatVnd(costPerDraw)}/kỳ</strong> (${doorCount} cửa × ${formatVnd(stake)}). Khi trúng nhận <strong>${formatVnd(maxPrize)}</strong> (Lãi ròng <strong>+${formatVnd(maxPrize - costPerDraw)}</strong>/kỳ).`
      : `💡 <strong>Cơ cấu trả thưởng vé đang chọn:</strong> Vốn <strong>${formatVnd(costPerDraw)}/kỳ</strong> (${doorCount} cửa × ${formatVnd(stake)}). Khi nổ nhận từ <strong>${formatVnd(minWinPrize)}</strong> đến tối đa <strong>${formatVnd(maxPrize)}</strong> tùy số nháy/cửa nổ cùng lúc.`;

  // 2. Run historical check across actual draws
  const allDraws = appState.syncDraws.length > 0 ? appState.syncDraws : appState.recentDraws;
  const slice = allDraws.slice(-range);
  const totalTested = slice.length;

  if (totalTested === 0) return;

  let hitDraws = 0;
  let totalSpent = totalTested * costPerDraw;
  let totalWon = 0;
  const recentHitItems = [];

  for (let i = slice.length - 1; i >= 0; i--) {
    const d = slice[i];
    const prz = evaluateTicketOnSingleOutcome(playType, selectedOptions, stake, d);
    if (prz > 0) {
      hitDraws++;
      totalWon += prz;
      if (recentHitItems.length < 8) {
        recentHitItems.push({
          drawId: d.drawId,
          time: d.time,
          numbers: d.numbers,
          prize: prz
        });
      }
    }
  }

  const empWinRate = ((hitDraws / totalTested) * 100).toFixed(1);
  const netProfit = totalWon - totalSpent;
  const rtp = totalSpent > 0 ? ((totalWon / totalSpent) * 100).toFixed(1) : '0.0';
  const netClass = netProfit >= 0 ? 'text-green' : 'text-red';

  document.getElementById('calcBacktestSummary').innerHTML = `
    <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:6px;">
      <span>📊 <strong>Kết quả dò trên ${totalTested} kỳ lịch sử thực tế:</strong></span>
      <span>Trúng <strong>${hitDraws}/${totalTested} kỳ (${empWinRate}%)</strong> · Tỷ lệ hoàn trả (RTP): <strong>${rtp}%</strong></span>
    </div>
    <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px;">
      <span>Tổng vốn: <strong>${formatVnd(totalSpent)}</strong> · Tổng thưởng nhận: <strong class="text-gold">${formatVnd(totalWon)}</strong></span>
      <span>Chênh lệch: <strong class="${netClass}">${netProfit >= 0 ? '+' : ''}${formatVnd(netProfit)}</strong></span>
    </div>
  `;

  document.getElementById('calcBacktestHitsList').innerHTML =
    recentHitItems.length > 0
      ? recentHitItems
          .map(
            (h) => `
          <span class="hit-pill">Kỳ #${h.drawId} (${h.numbers.join('-')}) → +${formatVnd(h.prize)}</span>
        `
          )
          .join('')
      : `<span style="color:var(--text-muted)">Vé này chưa nổ trong ${totalTested} kỳ gần nhất.</span>`;
}

function applyAiRecommendationToCalculator() {
  const preds = appState.analysis?.predictions;
  if (!preds) return;

  const { playType } = appState.calc;
  appState.calc.selectedOptions.clear();

  if (playType === 'SINGLE') {
    for (const f of preds.pairVip.faces) {
      appState.calc.selectedOptions.add(String(f));
    }
  } else if (playType === 'LHN') {
    appState.calc.selectedOptions.add(preds.lhnVip.mainSide || 'BIG');
    appState.calc.selectedOptions.add('TIE');
  } else if (playType === 'SUM') {
    for (const item of preds.sumVip) {
      appState.calc.selectedOptions.add(String(item.sum));
    }
  } else if (playType === 'DOUBLE') {
    for (const item of preds.doubleVip) {
      appState.calc.selectedOptions.add(String(item.face));
    }
  } else if (playType === 'TRIPLE') {
    appState.calc.selectedOptions.add('ANY');
    appState.calc.selectedOptions.add(String(preds.singleVip.face));
  }

  renderCalculatorChips();
  updateCalculatorResults();
}

/* ==========================================================================
   4. RENDER DEEP STATISTICS (6 FACES, DOUBLES/TRIPLES, 16 SUMS)
   ========================================================================== */
function renderStatistics(analysis) {
  const stats = analysis?.stats;
  if (!stats) return;

  // 1. 6 Faces Table
  const faceBody = document.getElementById('faceStatsTableBody');
  faceBody.innerHTML = (stats.faceStats || [])
    .map(
      (f) => `
      <tr>
        <td><span class="die-mini face-${f.face}">${f.face}</span></td>
        <td><strong>${f.drawHits}</strong> kỳ (${f.hitRate}%)</td>
        <td style="font-family:var(--font-mono); font-size:0.74rem;">${f.hit1x} / ${f.hit2x} / ${f.hit3x}</td>
        <td style="font-family:var(--font-mono);">${f.currentGap}k <span style="color:var(--text-muted)">(${f.maxGap}k)</span></td>
        <td style="font-family:var(--font-mono);">${f.count10}/10 · ${f.count30}/30</td>
        <td><strong class="${f.rank === 1 ? 'text-gold' : f.rank <= 3 ? 'text-cyan' : ''}">#${f.rank ?? '-'}</strong></td>
      </tr>
    `
    )
    .join('');

  // Strategy Comparison vs Baseline
  const comp = analysis.strategyComparison || [];
  document.getElementById('weightsBarContainer').innerHTML = comp
    .map(
      (item) => `
      <div class="weight-item" title="${item.description}">
        <div class="weight-item-top">
          <span>${item.isSelected ? '👉 ' : ''}${item.label}</span>
          <strong>${item.single1WinRate}% · RTP ${item.single1Rtp}%</strong>
        </div>
        <div style="font-size:0.68rem; color:var(--text-muted); margin-bottom:4px;">
          Khoảng ngẫu nhiên 95%: ${item.judge.bandLow}%–${item.judge.bandHigh}% (z=${item.judge.z}) · ${item.judge.verdict}
        </div>
        <div class="weight-bar-track">
          <div class="weight-bar-fill" style="width:${Math.min(100, Math.round(item.single1WinRate))}%"></div>
        </div>
      </div>
    `
    )
    .join('');

  // 2. Doubles & Triples Summary + Tables
  const anyD = stats.anyDoubleSummary;
  const anyT = stats.anyTripleSummary;
  document.getElementById('doubleTripleSummaryRow').innerHTML = `
    <div class="dt-box">
      <div style="color:var(--text-muted); font-size:0.7rem;">BẤT KỲ TRÙNG ĐÔI (11..66)</div>
      <div>Đã nổ: <strong>${anyD.hits} kỳ (${anyD.rate}%)</strong> vs chuẩn 44.4%</div>
      <div>Gan hiện tại: <strong class="text-cyan">${anyD.currentGap} kỳ</strong> (Max: ${anyD.maxGap}k)</div>
    </div>
    <div class="dt-box">
      <div style="color:var(--text-muted); font-size:0.7rem;">BÃO BẤT KỲ (111..666 — x20)</div>
      <div>Đã nổ: <strong>${anyT.hits} kỳ (${anyT.rate}%)</strong> vs chuẩn 2.78%</div>
      <div>Gan hiện tại: <strong class="text-gold">${anyT.currentGap} kỳ</strong> (Max: ${anyT.maxGap}k)</div>
    </div>
  `;

  document.getElementById('doublesTableBody').innerHTML = (stats.doublesStats || [])
    .map(
      (d) => `
      <tr>
        <td>
          <span class="die-mini face-${d.face}">${d.face}</span>
          <span class="die-mini face-${d.face}">${d.face}</span>
        </td>
        <td><strong>${d.hits}</strong> (${d.rate}%)</td>
        <td style="font-family:var(--font-mono);">${d.avgCycle}k</td>
        <td style="font-family:var(--font-mono);"><strong>${d.currentGap}k</strong> (${d.maxGap}k)</td>
        <td style="font-size:0.73rem;">${d.statusNote}</td>
      </tr>
    `
    )
    .join('');

  document.getElementById('triplesTableBody').innerHTML = (stats.triplesStats || [])
    .map(
      (t) => `
      <div class="triple-mini-card">
        <div>
          <strong class="text-gold">Bão ${t.tripleLabel}</strong>
          <span style="float:right; font-family:var(--font-mono);">${t.hits} lần</span>
        </div>
        <div style="color:var(--text-muted); font-size:0.7rem;">
          Gan: <strong style="color:var(--text-main)">${t.currentGap}k</strong> · Max: ${t.maxGap}k
        </div>
      </div>
    `
    )
    .join('');

  // 3. 16 Sums Table
  document.getElementById('sumsTableBody').innerHTML = (stats.sumsStats || [])
    .map(
      (s) => `
      <tr>
        <td>
          <strong style="font-family:var(--font-mono); font-size:0.86rem;" class="${s.sum >= 12 ? 'text-red' : s.sum <= 9 ? 'text-cyan' : 'text-gold'}">
            Tổng ${s.sum}
          </strong>
        </td>
        <td style="font-family:var(--font-mono); color:#34d399;">${formatVnd(s.prize)} <small>(x${s.multiplier})</small></td>
        <td><strong>${s.hits}</strong> (${s.rate}%)</td>
        <td style="font-family:var(--font-mono); color:var(--text-muted);">${s.prob}% (${s.ways}/216)</td>
        <td style="font-family:var(--font-mono);">
          <strong class="${s.isLongGap ? 'text-gold' : ''}">${s.currentGap}k</strong> / ${s.expectedCycle}k (${s.maxGap}k)
        </td>
      </tr>
    `
    )
    .join('');
}

/* ==========================================================================
   5. RENDER WALK-FORWARD BACKTEST & RECENT DRAW HISTORY
   ========================================================================== */
function renderBacktestAndHistory(analysis, recentDraws) {
  const summary = analysis?.backtestSummary;
  if (summary) {
    document.getElementById('btEvalCountBadge').textContent = `Đã đối soát: ${summary.evaluatedDraws} kỳ`;

    document.getElementById('btSummaryGrid').innerHTML = `
      <div class="bt-kpi-card">
        <span>Độc Thủ 1 Số</span>
        <strong>${summary.single1WinRate}% (${summary.single1WinCount} kỳ)</strong>
        <small>Lý thuyết: 42.13% · RTP: ${summary.single1Rtp}% (z=${summary.single1Judge.z})</small>
      </div>
      <div class="bt-kpi-card">
        <span>Song Thủ 2 Số (20k/kỳ)</span>
        <strong>≥1 số: ${summary.pair2AnyWinRate}% · Lãi ≥20k: ${summary.pair2ProfitRate}%</strong>
        <small>Chuẩn: 70.37% / 37.04% · RTP: ${summary.pair2Rtp}%</small>
      </div>
      <div class="bt-kpi-card">
        <span>Cầu Lớn/Nhỏ + Bọc Hòa</span>
        <strong>${summary.lhnCoverWinRate}% (${summary.lhnCoverWinCount} kỳ)</strong>
        <small>Chuẩn: 62.5% · Đơn cửa: ${summary.lhnExactWinRate}% (37.5%)</small>
      </div>
      <div class="bt-kpi-card">
        <span>Dàn 4 Tổng (9,10,11,12)</span>
        <strong>${summary.sumTop4WinRate}% (${summary.sumTop4WinCount} kỳ)</strong>
        <small>Chuẩn: 48.15% · RTP: ${summary.sumTop4Rtp}%</small>
      </div>
    `;
  }

  const btRows = (analysis?.backtestHistory || []).slice(0, 60);
  document.getElementById('backtestTableBody').innerHTML = btRows
    .map((r) => {
      const s1Badge = r.single1.won
        ? `<span class="text-green">✅ [${r.single1.predicted}] (${r.single1.appearCount}N)</span>`
        : `<span style="color:var(--text-muted)">❌ [${r.single1.predicted}]</span>`;

      const p2Badge = r.pair2.wonAny
        ? `<span class="text-green">✅ [${r.pair2.predicted.join('-')}]</span>`
        : `<span style="color:var(--text-muted)">❌ [${r.pair2.predicted.join('-')}]</span>`;

      const lhnBadge = r.lhn.coverWon
        ? `<span class="text-green">✅ ${r.lhn.predictedLabel}</span>`
        : `<span style="color:var(--text-muted)">❌ ${r.lhn.predictedLabel}</span>`;

      const sumBadge = r.sumTop4.won
        ? `<span class="text-gold">✅ [${r.sumTop4.predicted.join(',')}]</span>`
        : `<span style="color:var(--text-muted)">[${r.sumTop4.predicted.join(',')}]</span>`;

      return `
        <tr>
          <td style="font-family:var(--font-mono);">#${r.drawId} <small style="color:var(--text-muted)">(${r.time})</small></td>
          <td>
            ${r.actualNumbers.map((n) => `<span class="die-mini face-${n}">${n}</span>`).join('')}
            <strong style="font-family:var(--font-mono); margin-left:4px;">= ${r.actualSum}</strong>
          </td>
          <td style="font-family:var(--font-mono);">${s1Badge}</td>
          <td style="font-family:var(--font-mono);">${p2Badge}</td>
          <td>${lhnBadge}</td>
          <td style="font-family:var(--font-mono);">${sumBadge}</td>
        </tr>
      `;
    })
    .join('');

  // Recent History Table
  document.getElementById('historyTableBody').innerHTML = (recentDraws || [])
    .map((d) => {
      const sizeClass = d.sizeType === 'BIG' ? 'text-red' : d.sizeType === 'SMALL' ? 'text-cyan' : 'text-gold';
      return `
        <tr>
          <td style="font-family:var(--font-mono); font-weight:700;">#${d.drawId}</td>
          <td style="font-family:var(--font-mono); font-size:0.74rem; color:var(--text-secondary);">${d.date} · ${d.time}</td>
          <td>${d.numbers.map((n) => `<span class="die-mini face-${n}">${n}</span>`).join('')}</td>
          <td style="font-family:var(--font-mono); font-weight:800;">${d.sum}</td>
          <td><strong class="${sizeClass}">${d.sizeLabel}</strong></td>
          <td style="font-size:0.75rem;">${d.matchLabel}</td>
        </tr>
      `;
    })
    .join('');
}

/* ==========================================================================
   6. COUNTDOWN & LIVE STREAM HANDLING
   ========================================================================== */
function updateCountdownDisplay() {
  const sch = appState.schedule;
  if (!sch) return;

  document.getElementById('nextTargetId').textContent = `#${sch.nextDrawId || '------'}`;
  document.getElementById('nextExpectedTime').textContent = `Giờ quay: ${sch.expectedDrawTimeStr || '--:--'}`;

  const remMs = Math.max(0, (sch.targetTimestampMs || 0) - Date.now());
  const totalSec = Math.floor(remMs / 1000);
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');

  const timerEl = document.getElementById('countdownValue');
  const labelEl = document.getElementById('countdownLabel');

  if (sch.awaitingResult || totalSec === 0) {
    labelEl.textContent = 'Đang mở thưởng kỳ';
    timerEl.textContent = 'QUAY...';
    if (Date.now() - appState.lastZeroTriggerMs > 18000) {
      appState.lastZeroTriggerMs = Date.now();
      fetch('/api/refresh', { method: 'POST' }).catch(() => {});
    }
  } else {
    labelEl.textContent = sch.statusText || 'Đếm ngược kỳ';
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
  renderPredictions(appState.analysis);
  renderStatistics(appState.analysis);
  renderBacktestAndHistory(appState.analysis, appState.recentDraws);
  updateCalculatorResults();
  updateCountdownDisplay();
}

function initControls() {
  // Mode Selector
  const modeSelect = document.getElementById('modeSelect');
  modeSelect.addEventListener('change', async () => {
    const mode = modeSelect.value;
    try {
      const res = await fetch(`/api/state?mode=${encodeURIComponent(mode)}`);
      if (res.ok) {
        const data = await res.json();
        applyServerState(data);
      }
    } catch {
      // Ignore error
    }
  });

  // Sound Toggle
  const soundBtn = document.getElementById('soundToggleBtn');
  soundBtn.addEventListener('click', () => {
    appState.soundEnabled = !appState.soundEnabled;
    soundBtn.textContent = appState.soundEnabled ? '🔔 Âm báo: Bật' : '🔕 Âm báo: Tắt';
  });

  // Manual Refresh
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.state) applyServerState(data.state);
      }
    } finally {
      setTimeout(() => {
        refreshBtn.disabled = false;
      }, 800);
    }
  });

  // Expand History (+150 draws)
  const expandBtn = document.getElementById('expandHistoryBtn');
  expandBtn.addEventListener('click', async () => {
    expandBtn.disabled = true;
    const origText = expandBtn.innerHTML;
    expandBtn.innerHTML = '<span>⏳</span> Đang tải...';
    try {
      const res = await fetch('/api/expand-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pages: 15 })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.state) applyServerState(data.state);
      }
    } finally {
      expandBtn.innerHTML = origText;
      expandBtn.disabled = false;
    }
  });

  // Calculator Controls
  const playTypeEl = document.getElementById('calcPlayType');
  playTypeEl.addEventListener('change', () => {
    appState.calc.playType = playTypeEl.value;
    appState.calc.selectedOptions.clear();
    const opts = getAvailableOptionsForPlayType(appState.calc.playType);
    if (opts.length > 0) appState.calc.selectedOptions.add(opts[0].id);
    renderCalculatorChips();
    updateCalculatorResults();
  });

  const stakeEl = document.getElementById('calcStakeSelect');
  stakeEl.addEventListener('change', () => {
    appState.calc.stake = parseInt(stakeEl.value, 10) || 10000;
    updateCalculatorResults();
  });

  const rangeEl = document.getElementById('calcBacktestRange');
  rangeEl.addEventListener('change', () => {
    appState.calc.range = parseInt(rangeEl.value, 10) || 100;
    updateCalculatorResults();
  });

  document.getElementById('calcApplyAiBtn').addEventListener('click', () => {
    applyAiRecommendationToCalculator();
  });

  renderCalculatorChips();
}

function connectSseStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('state_update', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      applyServerState(data);
    } catch {
      // Ignore parse error
    }
  });

  es.addEventListener('poll_status', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const dot = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');
      if (data.isPolling) {
        dot.classList.add('polling');
      } else {
        dot.classList.remove('polling');
      }
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
