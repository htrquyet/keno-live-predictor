/**
 * Vietlott Keno Bậc 2 — Single-Pair Prediction & Walk-Forward Analytics Engine
 *
 * Mục tiêu duy nhất:
 * - Mỗi kỳ quay chốt duy nhất 1 Cặp 2 Số [A, B] (01..80).
 * - Tối ưu hóa riêng cho cách chơi Keno Bậc 2 (cả 2 số cùng nổ trong 20 bóng,
 *   vé 10.000đ thưởng 90.000đ = x9; chuẩn lý thuyết 19/316 = 6.0127%, chu kỳ TB 16.63 kỳ).
 * - Duy trì trạng thái trượt O(N) theo đúng thứ tự thời gian, tuyệt đối không rò rỉ dữ liệu tương lai.
 */

export const THEORETICAL_KENO_PAIR = {
  hit2Rate: 6.01,        // 19 / 316 = 6.0127%
  hit2ProbExact: 19 / 316,
  theoreticalRtp: 54.11, // (19 / 316) * 9 * 100
  expectedCycle: 16.63,  // 316 / 19
  hit1PlusRate: 43.99,   // 1 - (60*59)/(80*79) = 139 / 316
  singleHitRate: 25.00   // 20 / 80
};

export const STRATEGIES = {
  rebound24_pair: {
    key: 'rebound24_pair',
    label: 'Nén Chu Kỳ 24 Kỳ + Điểm Rơi Cặp (Khuyên dùng)',
    shortLabel: 'Nén 24k + Điểm rơi cặp',
    description:
      'Lọc Top 5 số bị nén mạnh nhất trong 24 kỳ (6 chu kỳ Keno chuẩn), sau đó chọn cặp [A, B] có mức độ nén sâu, đồng xuất hiện lịch sử tốt và gan cặp rơi vào vùng chu kỳ 20–38 kỳ.'
  },
  rebound25_core: {
    key: 'rebound25_core',
    label: 'Nén 25 Kỳ + Nền Tảng Tần Suất Dài Hạn',
    shortLabel: 'Nén 25k + Nền dài hạn',
    description:
      'Tìm 2 con số có tần suất xuất hiện thấp nhất trong 25 kỳ gần nhất nhưng sở hữu nền tảng tần suất lịch sử cao nhất để đón nhịp bật hồi.'
  },
  rebound24_lowgap: {
    key: 'rebound24_lowgap',
    label: 'Nén 24 Kỳ An Toàn (Giảm Chuỗi Trượt Dài)',
    shortLabel: 'Nén 24k An toàn',
    description:
      'Chọn 2 con số bị nén sâu nhất trong 24 kỳ kết hợp nền tần suất dài hạn; giúp tăng tỷ lệ nổ ≥1/2 số và giữ chuỗi trượt dài nhất (MaxGap) ở mức thấp.'
  }
};

const BASELINE_STRATEGY = {
  key: 'baseline_01_02',
  label: 'Đối chứng cố định [01, 02]',
  shortLabel: 'Đối chứng [01, 02]',
  description: 'Luôn giữ nguyên cặp [01, 02] ở mọi kỳ để làm mốc so sánh khách quan.'
};

export const DEFAULT_STRATEGY = 'rebound24_pair';
const WARMUP_DRAWS = 50;
const BACKTEST_HISTORY_LIMIT = 150;
const TICKET_STAKE = 10000;
const BAC2_PRIZE = 90000;

const round1 = (v) => Number(v.toFixed(1));
const round2 = (v) => Number(v.toFixed(2));
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Compute Z-score and 95% random binomial interval around theoretical 6.0127%
 */
function evaluateStatisticalEdge(wins, n, p = THEORETICAL_KENO_PAIR.hit2ProbExact) {
  if (n <= 0) {
    return { z: 0, bandLow: 0, bandHigh: 0, verdict: 'Chưa đủ kỳ đối soát' };
  }
  const se = Math.sqrt((p * (1 - p)) / n);
  const emp = wins / n;
  const z = (emp - p) / se;
  const bandLow = round2(Math.max(0, (p - 1.96 * se) * 100));
  const bandHigh = round2(Math.min(100, (p + 1.96 * se) * 100));
  let verdict = 'Nằm trong vùng dao động chuẩn';
  if (z >= 1.96) verdict = 'Vượt ngưỡng ngẫu nhiên 95%';
  else if (z >= 0.8) verdict = 'Cao hơn kỳ vọng chuẩn';
  else if (z <= -1.96) verdict = 'Thấp hơn ngưỡng chuẩn';
  return {
    z: round2(z),
    bandLow,
    bandHigh,
    verdict
  };
}

/**
 * Create incremental O(1)-update sliding window state across sorted draws (oldest -> newest)
 */
function createTrackerState() {
  return {
    totalDraws: 0,
    fAll: new Int32Array(81),
    f25: new Int32Array(81),
    f24: new Int32Array(81),
    f10: new Int32Array(81),
    lastNumIdx: new Int32Array(81).fill(-1),
    coocAll: Array.from({ length: 81 }, () => new Int32Array(81)),
    lastPairIdx: Array.from({ length: 81 }, () => new Int32Array(81).fill(-1))
  };
}

function advanceTrackerState(state, draws, idx) {
  const nums = draws[idx].numbers;
  for (let a = 0; a < nums.length; a++) {
    const u = nums[a];
    state.fAll[u]++;
    state.f25[u]++;
    state.f24[u]++;
    state.f10[u]++;
    state.lastNumIdx[u] = idx;
    for (let b = a + 1; b < nums.length; b++) {
      const v = nums[b];
      state.coocAll[u][v]++;
      state.coocAll[v][u]++;
      state.lastPairIdx[u][v] = idx;
      state.lastPairIdx[v][u] = idx;
    }
  }
  if (idx >= 25) {
    for (const u of draws[idx - 25].numbers) state.f25[u]--;
  }
  if (idx >= 24) {
    for (const u of draws[idx - 24].numbers) state.f24[u]--;
  }
  if (idx >= 10) {
    for (const u of draws[idx - 10].numbers) state.f10[u]--;
  }
  state.totalDraws = idx + 1;
}

/**
 * Select the single best 2-number pair [A, B] using only state available strictly BEFORE draw index `totalDraws`
 */
export function selectSinglePairAtStep(state, mode = DEFAULT_STRATEGY) {
  const N = state.totalDraws;
  const { fAll, f25, f24, f10, lastNumIdx, coocAll, lastPairIdx } = state;

  let pair = [1, 2];
  let reason = '';

  if (mode === 'baseline_01_02') {
    pair = [1, 2];
    reason = 'Chế độ đối chứng: luôn giữ cặp [01, 02] ở mọi kỳ.';
  } else if (mode === 'rebound24_pair') {
    const candidates = Array.from({ length: 80 }, (_, k) => k + 1).sort((a, b) => {
      if (f24[a] !== f24[b]) return f24[a] - f24[b];
      const ga = lastNumIdx[a] === -1 ? N : N - 1 - lastNumIdx[a];
      const gb = lastNumIdx[b] === -1 ? N : N - 1 - lastNumIdx[b];
      if (ga !== gb) return gb - ga;
      if (fAll[a] !== fAll[b]) return fAll[b] - fAll[a];
      return a - b;
    });
    const pool = candidates.slice(0, 5);
    let bestScore = -1e9;
    for (let a = 0; a < pool.length; a++) {
      for (let b = a + 1; b < pool.length; b++) {
        const u = pool[a];
        const v = pool[b];
        const pg = lastPairIdx[u][v] === -1 ? N : N - 1 - lastPairIdx[u][v];
        const sc =
          -(f24[u] + f24[v]) * 10 +
          (pg >= 20 && pg <= 38 ? 6 : 0) +
          (N > 0 ? (coocAll[u][v] / N) * 40 : 0);
        if (sc > bestScore) {
          bestScore = sc;
          pair = u < v ? [u, v] : [v, u];
        }
      }
    }
    const [A, B] = pair;
    const pg = lastPairIdx[A][B] === -1 ? N : N - 1 - lastPairIdx[A][B];
    reason =
      `Số ${pad2(A)} (${f24[A]}/24 kỳ) & ${pad2(B)} (${f24[B]}/24 kỳ) nằm trong nhóm bị nén mạnh nhất 24 kỳ` +
      (pg >= 20 && pg <= 38
        ? `, kết hợp gan cặp ${pg} kỳ rơi đúng vùng điểm rơi 20–38 kỳ.`
        : `, có tần suất đồng xuất hiện tốt trong Top 5 nén sâu.`);
  } else if (mode === 'rebound25_core') {
    const candidates = Array.from({ length: 80 }, (_, k) => k + 1).sort((a, b) => {
      if (f25[a] !== f25[b]) return f25[a] - f25[b];
      if (fAll[a] !== fAll[b]) return fAll[b] - fAll[a];
      const ga = lastNumIdx[a] === -1 ? N : N - 1 - lastNumIdx[a];
      const gb = lastNumIdx[b] === -1 ? N : N - 1 - lastNumIdx[b];
      return gb - ga || a - b;
    });
    pair = [candidates[0], candidates[1]].sort((a, b) => a - b);
    const [A, B] = pair;
    reason = `Hai số bị nén sâu nhất trong 25 kỳ (${f25[A]}/25 và ${f25[B]}/25) có nền tần suất dài hạn dẫn đầu (${fAll[A]} và ${fAll[B]} lần).`;
  } else {
    // rebound24_lowgap
    const candidates = Array.from({ length: 80 }, (_, k) => k + 1).sort((a, b) => {
      if (f24[a] !== f24[b]) return f24[a] - f24[b];
      if (fAll[a] !== fAll[b]) return fAll[b] - fAll[a];
      const ga = lastNumIdx[a] === -1 ? N : N - 1 - lastNumIdx[a];
      const gb = lastNumIdx[b] === -1 ? N : N - 1 - lastNumIdx[b];
      return gb - ga || a - b;
    });
    pair = [candidates[0], candidates[1]].sort((a, b) => a - b);
    const [A, B] = pair;
    reason = `Chọn 2 số nén sâu nhất khung 24 kỳ (${f24[A]}/24 và ${f24[B]}/24) có nền tần suất lịch sử tốt nhất để tối ưu nhịp hồi đều.`;
  }

  const [A, B] = pair;
  const buildNumStat = (x) => ({
    num: x,
    label: pad2(x),
    f10: f10[x],
    f24: f24[x],
    f25: f25[x],
    fAll: fAll[x],
    rateAll: N > 0 ? round1((fAll[x] / N) * 100) : 0,
    gap: lastNumIdx[x] === -1 ? N : N - 1 - lastNumIdx[x]
  });

  const coocCount = coocAll[A][B];
  const pairGap = lastPairIdx[A][B] === -1 ? N : N - 1 - lastPairIdx[A][B];

  return {
    pair,
    pairLabels: [pad2(A), pad2(B)],
    numAStats: buildNumStat(A),
    numBStats: buildNumStat(B),
    pairStats: {
      coocCount,
      coocRate: N > 0 ? round2((coocCount / N) * 100) : 0,
      avgCycle: coocCount > 0 ? round1(N / coocCount) : null,
      pairGap,
      expectedCycle: THEORETICAL_KENO_PAIR.expectedCycle,
      reason
    }
  };
}

/**
 * Run O(N) Walk-Forward Backtest for a given single-pair mode
 */
export function runPairBacktest(draws, mode = DEFAULT_STRATEGY, includeDetails = false) {
  const N = draws.length;
  if (N <= WARMUP_DRAWS) {
    return {
      summary: {
        mode,
        evaluatedDraws: 0,
        hit2Count: 0,
        hit2Rate: 0,
        bac2Rtp: 0,
        netProfit10k: 0,
        hit1PlusCount: 0,
        hit1PlusRate: 0,
        avgHitCycle: null,
        currentPairLoseStreak: 0,
        maxPairLoseStreak: 0,
        edge: evaluateStatisticalEdge(0, 0),
        theoretical: THEORETICAL_KENO_PAIR
      },
      backtestHistory: [],
      allHit2Events: [],
      finalState: (() => {
        const st = createTrackerState();
        for (let i = 0; i < N; i++) advanceTrackerState(st, draws, i);
        return st;
      })()
    };
  }

  const st = createTrackerState();
  for (let i = 0; i < WARMUP_DRAWS; i++) {
    advanceTrackerState(st, draws, i);
  }

  let hit2Count = 0;
  let hit1PlusCount = 0;
  let curLoseStreak = 0;
  let maxLoseStreak = 0;
  const evalCount = N - WARMUP_DRAWS;
  const historyFrom = Math.max(WARMUP_DRAWS, N - BACKTEST_HISTORY_LIMIT);

  const backtestHistory = [];
  const allHit2Events = [];

  for (let idx = WARMUP_DRAWS; idx < N; idx++) {
    const pick = selectSinglePairAtStep(st, mode);
    const [A, B] = pick.pair;
    const draw = draws[idx];
    const numSet = new Set(draw.numbers);

    const matchedNums = [];
    if (numSet.has(A)) matchedNums.push(A);
    if (numSet.has(B)) matchedNums.push(B);

    const wonBac2 = matchedNums.length === 2;
    const wonAtLeast1 = matchedNums.length >= 1;

    if (wonAtLeast1) hit1PlusCount++;
    if (wonBac2) {
      hit2Count++;
      curLoseStreak = 0;
    } else {
      curLoseStreak++;
      if (curLoseStreak > maxLoseStreak) maxLoseStreak = curLoseStreak;
    }

    if (includeDetails) {
      const record = {
        drawId: draw.drawId,
        drawNumber: draw.drawNumber,
        time: draw.time,
        date: draw.date,
        predictedPair: pick.pair,
        predictedLabels: pick.pairLabels,
        matchedNums,
        hitCount: matchedNums.length,
        wonBac2,
        wonAtLeast1,
        prize: wonBac2 ? BAC2_PRIZE : 0,
        actualNumbers: draw.numbers
      };
      if (idx >= historyFrom) {
        backtestHistory.push(record);
      }
      if (wonBac2) {
        allHit2Events.push(record);
      }
    }

    advanceTrackerState(st, draws, idx);
  }

  const totalCost = evalCount * TICKET_STAKE;
  const totalPrize = hit2Count * BAC2_PRIZE;
  const hit2Rate = round2((hit2Count / evalCount) * 100);
  const bac2Rtp = round1((totalPrize / totalCost) * 100);
  const hit1PlusRate = round2((hit1PlusCount / evalCount) * 100);
  const avgHitCycle = hit2Count > 0 ? round1(evalCount / hit2Count) : null;

  return {
    summary: {
      mode,
      evaluatedDraws: evalCount,
      hit2Count,
      hit2Rate,
      bac2Rtp,
      totalCost10k: totalCost,
      totalPrize10k: totalPrize,
      netProfit10k: totalPrize - totalCost,
      hit1PlusCount,
      hit1PlusRate,
      avgHitCycle,
      currentPairLoseStreak: curLoseStreak,
      maxPairLoseStreak: maxLoseStreak,
      edge: evaluateStatisticalEdge(hit2Count, evalCount),
      theoretical: THEORETICAL_KENO_PAIR
    },
    backtestHistory: backtestHistory.reverse(),
    allHit2Events: allHit2Events.reverse(),
    finalState: st
  };
}

/**
 * Compute deep pair co-occurrence, due-rebound pairs, and individual number compression ranking
 */
export function computePairAnalytics(draws, finalState, predictedPair) {
  const N = finalState.totalDraws;
  const { fAll, f24, f25, f10, lastNumIdx, coocAll, lastPairIdx } = finalState;
  const predKey = `${predictedPair[0]}-${predictedPair[1]}`;

  // 1. Scan all 3,160 pairs once for Top Co-occurring & Top Rebound Pairs
  const allPairs = [];
  for (let u = 1; u <= 80; u++) {
    for (let v = u + 1; v <= 80; v++) {
      const cooc = coocAll[u][v];
      const pg = lastPairIdx[u][v] === -1 ? N : N - 1 - lastPairIdx[u][v];
      const sumF24 = f24[u] + f24[v];
      const reboundScore =
        -sumF24 * 10 +
        (pg >= 20 && pg <= 38 ? 6 : 0) +
        (N > 0 ? (cooc / N) * 40 : 0);

      allPairs.push({
        pair: [u, v],
        pairLabel: `${pad2(u)} - ${pad2(v)}`,
        coocCount: cooc,
        coocRate: N > 0 ? round2((cooc / N) * 100) : 0,
        avgCycle: cooc > 0 ? round1(N / cooc) : null,
        pairGap: pg,
        sumF24,
        reboundScore: round1(reboundScore),
        isSelected: `${u}-${v}` === predKey
      });
    }
  }

  const topCooccurringPairs = [...allPairs]
    .sort((a, b) => b.coocCount - a.coocCount || a.pairGap - b.pairGap)
    .slice(0, 12);

  // Top Rebound Candidates (prioritizing compressed numbers + due cycle 18..42 + historical affinity)
  const topDueReboundPairs = [...allPairs]
    .sort((a, b) => b.reboundScore - a.reboundScore || b.coocCount - a.coocCount)
    .slice(0, 12);

  // 2. Top 15 compressed individual numbers for next draw
  const numberRankingTop15 = Array.from({ length: 80 }, (_, k) => k + 1)
    .sort((a, b) => {
      if (f24[a] !== f24[b]) return f24[a] - f24[b];
      const ga = lastNumIdx[a] === -1 ? N : N - 1 - lastNumIdx[a];
      const gb = lastNumIdx[b] === -1 ? N : N - 1 - lastNumIdx[b];
      return gb - ga || fAll[b] - fAll[a] || a - b;
    })
    .slice(0, 15)
    .map((x, idx) => ({
      rank: idx + 1,
      num: x,
      label: pad2(x),
      f10: f10[x],
      f24: f24[x],
      f25: f25[x],
      fAll: fAll[x],
      rateAll: N > 0 ? round1((fAll[x] / N) * 100) : 0,
      gap: lastNumIdx[x] === -1 ? N : N - 1 - lastNumIdx[x],
      inPredictedPair: predictedPair.includes(x)
    }));

  return {
    totalPairsScanned: allPairs.length,
    topCooccurringPairs,
    topDueReboundPairs,
    numberRankingTop15
  };
}

/**
 * Main entry point: run walk-forward backtest across all strategies + predict single best [A, B] for next draw
 */
export function analyzeAndPredictNextDraw(draws, customMode = DEFAULT_STRATEGY) {
  const mode = STRATEGIES[customMode] ? customMode : DEFAULT_STRATEGY;
  const N = draws.length;

  const strategyComparison = [];
  let selectedResult = null;

  for (const key of [...Object.keys(STRATEGIES), BASELINE_STRATEGY.key]) {
    const meta = STRATEGIES[key] || BASELINE_STRATEGY;
    const bt = runPairBacktest(draws, key, key === mode);
    if (key === mode) selectedResult = bt;
    strategyComparison.push({
      key,
      label: meta.label,
      shortLabel: meta.shortLabel,
      description: meta.description,
      isSelected: key === mode,
      isBaseline: key === BASELINE_STRATEGY.key,
      ...bt.summary
    });
  }

  const finalState = selectedResult.finalState;
  const nextSelection = selectSinglePairAtStep(finalState, mode);
  const analytics = computePairAnalytics(draws, finalState, nextSelection.pair);

  const latestDraw = N > 0 ? draws[N - 1] : null;
  const nextDrawId = latestDraw ? String(latestDraw.drawNumber + 1) : '------';

  return {
    nextDrawId,
    latestDraw,
    totalHistoricalDraws: N,
    mode,
    strategy: STRATEGIES[mode],
    prediction: {
      ...nextSelection,
      summary: selectedResult.summary
    },
    strategyComparison,
    analytics,
    backtestHistory: selectedResult.backtestHistory,
    allHit2Events: selectedResult.allHit2Events,
    backtestSummary: selectedResult.summary
  };
}
