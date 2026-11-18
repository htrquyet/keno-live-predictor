/**
 * Vietlott Keno Bậc 2 — Anti-Dead-Ball + Markov Transition + Rebound Pair Engine
 *
 * Cải tiến cốt lõi sau phân tích nguyên nhân 0/2 & 1/2:
 * 1. Khử Bóng Chết (Anti-Dead-Ball): Loại các số bị gan lì quá ngưỡng (gap > 14 hoặc > 13),
 *    tránh kẹt lặp lại 1 cặp số chết nhiều kỳ liên tiếp.
 * 2. Ma trận Chuyển Tiếp Markov 1 bước + Đồng Xuất Hiện 60 kỳ: Kết hợp lực kéo trực tiếp
 *    từ 20 số vừa nổ ở kỳ liền trước (i - 1) và độ ăn ý cặp số gần đây (cooc60).
 * 3. Hệ Thống Bọc Lót Đá Vòng (+C thành 3 số / +D thành 4 số): Biến các kỳ cặp chính
 *    lệch 1 nhịp (1/2) thành trúng trọn Bậc 2 (x9 = 90.000đ/cặp, hoặc x27 nếu về 3/3).
 */

export const THEORETICAL_KENO_PAIR = {
  hit2Rate: 6.01,        // 19 / 316
  hit2ProbExact: 19 / 316,
  theoreticalRtp: 54.11,
  expectedCycle: 16.63,
  hit1PlusRate: 43.99,
  singleHitRate: 25.00,
  bac3Hit2Rate: 14.34,   // C(20,2)*C(60,1)/C(80,3)
  bac3Hit3Rate: 1.39,    // C(20,3)/C(80,3)
  bac3WinRate: 15.73,    // 14.34 + 1.39
  bac3ProbExact: 0.157314,
  bac3TheoreticalRtp: 84.21, // (0.1434*2 + 0.01387*40)*100
  bac3ExpectedCycle: 6.36,
  bac3Hit1PlusRate: 58.34,
  wheel3WinRate: 15.73,  // Xác suất >=2/3 số trong 20 bóng
  wheel4WinRate: 25.89   // Xác suất >=2/4 số trong 20 bóng
};

export const STRATEGIES = {
  hybrid_markov_cooc: {
    key: 'hybrid_markov_cooc',
    label: 'Khử Bóng Chết + Markov + Đồng Xuất Hiện (Tối ưu 2/2)',
    shortLabel: 'Markov + Cooc 60k',
    maxNumGap: 14,
    wCooc60: 25,
    description:
      'Loại bỏ số gan lì >14 kỳ, lọc Top 6 hạt nhân nén 24 kỳ có nền dài hạn & lực kéo Markov kỳ trước mạnh nhất, chọn cặp có tương hợp 60 kỳ & gan cặp 16–38.'
  },
  hybrid_markov_base: {
    key: 'hybrid_markov_base',
    label: 'Khử Bóng Chết + Markov Cân Bằng (Ổn định 2 nửa)',
    shortLabel: 'Markov Cân Bằng',
    maxNumGap: 14,
    wCooc60: 0,
    description:
      'Chỉ dùng đồng xuất hiện dài hạn kết hợp lực kéo Markov từ 20 bóng kỳ trước và nén chu kỳ 24 kỳ; cân bằng đều ở cả nửa đầu & nửa sau dữ liệu.'
  },
  hybrid_strict_gap13: {
    key: 'hybrid_strict_gap13',
    label: 'Cắt Gan Sớm ≤13 Kỳ + Đảo Nhịp Nhanh',
    shortLabel: 'Cắt Gan ≤13k',
    maxNumGap: 13,
    wCooc60: 0,
    description:
      'Cắt sớm hơn các bóng ngủ đông (>13 kỳ) để liên tục bám nhịp các số đang hoạt động, tăng tỷ lệ nổ ≥1/2 và hỗ trợ đá vòng 3 số.'
  }
};

const BASELINE_STRATEGY = {
  key: 'baseline_01_02',
  label: 'Đối chứng cố định [01, 02]',
  shortLabel: 'Đối chứng [01, 02]',
  maxNumGap: 999,
  wCooc60: 0,
  description: 'Luôn giữ nguyên cặp [01, 02] ở mọi kỳ để làm mốc so sánh.'
};

export const DEFAULT_STRATEGY = 'hybrid_markov_cooc';
const WARMUP_DRAWS = 50;
const BACKTEST_HISTORY_LIMIT = 150;
const TICKET_STAKE = 10000;
const BAC2_PRIZE = 90000;
const BAC3_PRIZE_2 = 20000;
const BAC3_PRIZE_3 = 400000;

const round1 = (v) => Number(v.toFixed(1));
const round2 = (v) => Number(v.toFixed(2));
const pad2 = (n) => String(n).padStart(2, '0');

function evaluateStatisticalEdge(wins, n, p = THEORETICAL_KENO_PAIR.hit2ProbExact) {
  if (n <= 0) {
    return { z: 0, bandLow: 0, bandHigh: 0, verdict: 'Chưa đủ kỳ đối soát' };
  }
  const se = Math.sqrt((p * (1 - p)) / n);
  const emp = wins / n;
  const z = (emp - p) / se;
  const bandLow = round2(Math.max(0, (p - 1.96 * se) * 100));
  const bandHigh = round2(Math.min(100, (p + 1.96 * se) * 100));
  let verdict = 'Trong vùng dao động chuẩn';
  if (z >= 1.96) verdict = 'Vượt ngưỡng ngẫu nhiên 95%';
  else if (z >= 0.8) verdict = 'Cao hơn kỳ vọng chuẩn';
  else if (z <= -1.96) verdict = 'Thấp hơn ngưỡng chuẩn';
  return { z: round2(z), bandLow, bandHigh, verdict };
}

function createTrackerState() {
  return {
    totalDraws: 0,
    prevNumbers: [],
    fAll: new Int32Array(81),
    f60: new Int32Array(81),
    f25: new Int32Array(81),
    f24: new Int32Array(81),
    f10: new Int32Array(81),
    lastNumIdx: new Int32Array(81).fill(-1),
    coocAll: Array.from({ length: 81 }, () => new Int32Array(81)),
    cooc60: Array.from({ length: 81 }, () => new Int32Array(81)),
    lastPairIdx: Array.from({ length: 81 }, () => new Int32Array(81).fill(-1)),
    trans: Array.from({ length: 81 }, () => new Int32Array(81)),
    mkCacheDraw: -1,
    mkVec: new Float64Array(81)
  };
}

function advanceTrackerState(state, draws, idx) {
  const nums = draws[idx].numbers;
  if (idx > 0) {
    const prev = draws[idx - 1].numbers;
    for (let i = 0; i < prev.length; i++) {
      const p = prev[i];
      const row = state.trans[p];
      for (let j = 0; j < nums.length; j++) {
        row[nums[j]]++;
      }
    }
  }
  for (let a = 0; a < nums.length; a++) {
    const u = nums[a];
    state.fAll[u]++;
    state.f60[u]++;
    state.f25[u]++;
    state.f24[u]++;
    state.f10[u]++;
    state.lastNumIdx[u] = idx;
    for (let b = a + 1; b < nums.length; b++) {
      const v = nums[b];
      state.coocAll[u][v]++;
      state.coocAll[v][u]++;
      state.cooc60[u][v]++;
      state.cooc60[v][u]++;
      state.lastPairIdx[u][v] = idx;
      state.lastPairIdx[v][u] = idx;
    }
  }
  if (idx >= 60) {
    const old60 = draws[idx - 60].numbers;
    for (let a = 0; a < old60.length; a++) {
      const u = old60[a];
      state.f60[u]--;
      for (let b = a + 1; b < old60.length; b++) {
        const v = old60[b];
        state.cooc60[u][v]--;
        state.cooc60[v][u]--;
      }
    }
  }
  if (idx >= 25) for (const u of draws[idx - 25].numbers) state.f25[u]--;
  if (idx >= 24) for (const u of draws[idx - 24].numbers) state.f24[u]--;
  if (idx >= 10) for (const u of draws[idx - 10].numbers) state.f10[u]--;

  state.prevNumbers = nums;
  state.totalDraws = idx + 1;
}

function getMarkovVector(state) {
  const N = state.totalDraws;
  if (state.mkCacheDraw === N) return state.mkVec;
  const mk = state.mkVec;
  mk.fill(0);
  const prev = state.prevNumbers;
  if (N > 0 && prev && prev.length > 0) {
    const denom = N * prev.length;
    for (let i = 0; i < prev.length; i++) {
      const row = state.trans[prev[i]];
      for (let x = 1; x <= 80; x++) {
        mk[x] += row[x];
      }
    }
    for (let x = 1; x <= 80; x++) mk[x] /= denom;
  }
  state.mkCacheDraw = N;
  return mk;
}

const ALL_NUMS_BASE = Array.from({ length: 80 }, (_, k) => k + 1);

/**
 * Select primary pair [A, B] + Wheel-3 backup (+C) & Wheel-4 (+C, +D)
 * using only state strictly BEFORE the draw being evaluated.
 */
export function selectSinglePairAtStep(state, mode = DEFAULT_STRATEGY) {
  const N = Math.max(1, state.totalDraws);
  const d60 = Math.min(60, N);
  const { fAll, f60, f25, f24, f10, lastNumIdx, coocAll, cooc60, lastPairIdx } = state;
  const mk = getMarkovVector(state);

  const cfg = STRATEGIES[mode] || BASELINE_STRATEGY;
  let pair = [1, 2];
  let backupC = 3;
  let backupD = 4;
  let reason = '';

  if (mode === 'baseline_01_02') {
    pair = [1, 2];
    backupC = 3;
    backupD = 4;
    reason = 'Mốc đối chứng cố định cặp [01, 02] qua mọi kỳ.';
  } else {
    const filtered = ALL_NUMS_BASE.filter((x) => {
      const g = lastNumIdx[x] === -1 ? N : N - 1 - lastNumIdx[x];
      return g <= cfg.maxNumGap;
    });
    const poolBase = filtered.length >= 6 ? filtered : [...ALL_NUMS_BASE];
    poolBase.sort((a, b) => {
      if (f24[a] !== f24[b]) return f24[a] - f24[b];
      if (fAll[a] !== fAll[b]) return fAll[b] - fAll[a];
      if (mk[a] !== mk[b]) return mk[b] - mk[a];
      return a - b;
    });
    const anchors = poolBase.slice(0, 6);

    let bestScore = -1e9;
    for (let a = 0; a < anchors.length; a++) {
      for (let b = a + 1; b < anchors.length; b++) {
        const u = anchors[a];
        const v = anchors[b];
        const pg = lastPairIdx[u][v] === -1 ? N : N - 1 - lastPairIdx[u][v];
        const sc =
          -(f24[u] + f24[v]) * 12 +
          ((fAll[u] + fAll[v]) / N) * 30 +
          (mk[u] + mk[v]) * 40 +
          (coocAll[u][v] / N) * 60 +
          (cooc60[u][v] / d60) * cfg.wCooc60 +
          (pg >= 16 && pg <= 38 ? 6 : 0);
        if (sc > bestScore) {
          bestScore = sc;
          pair = u < v ? [u, v] : [v, u];
        }
      }
    }

    const rem = anchors.filter((x) => x !== pair[0] && x !== pair[1]);
    backupC = rem[0] || (pair[1] < 80 ? pair[1] + 1 : 1);
    backupD = rem[1] || (backupC < 80 ? backupC + 1 : 2);

    const [A, B] = pair;
    const pg = lastPairIdx[A][B] === -1 ? N : N - 1 - lastPairIdx[A][B];
    const ga = lastNumIdx[A] === -1 ? N : N - 1 - lastNumIdx[A];
    const gb = lastNumIdx[B] === -1 ? N : N - 1 - lastNumIdx[B];
    reason =
      `Khử bóng chết (gan ${ga}k & ${gb}k ≤ ${cfg.maxNumGap}k), chọn ${pad2(A)} (${f24[A]}/24k) + ${pad2(B)} (${f24[B]}/24k) dẫn đầu điểm nén + Markov` +
      (pg >= 16 && pg <= 38
        ? ` và gan cặp ${pg}k đúng điểm rơi.`
        : `, lót thêm số ${pad2(backupC)} để chống lệch nhịp 1/2.`);
  }

  const [A, B] = pair;
  const buildNumStat = (x) => ({
    num: x,
    label: pad2(x),
    f10: f10[x],
    f24: f24[x],
    f25: f25[x],
    f60: f60[x],
    fAll: fAll[x],
    rateAll: round1((fAll[x] / N) * 100),
    gap: lastNumIdx[x] === -1 ? N : N - 1 - lastNumIdx[x],
    markovPct: round1(mk[x] * 100)
  });

  const coocCount = coocAll[A][B];
  const cooc60Count = cooc60[A][B];
  const pairGap = lastPairIdx[A][B] === -1 ? N : N - 1 - lastPairIdx[A][B];
  const wheel3Nums = [A, B, backupC].sort((x, y) => x - y);
  const wheel4Nums = [A, B, backupC, backupD].sort((x, y) => x - y);

  const trio = [A, B, backupC];
  const trioLabels = [pad2(A), pad2(B), pad2(backupC)];

  return {
    pair,
    pairLabels: [pad2(A), pad2(B)],
    trio,
    trioLabels,
    numAStats: buildNumStat(A),
    numBStats: buildNumStat(B),
    numCStats: buildNumStat(backupC),
    pairStats: {
      coocCount,
      cooc60Count,
      coocRate: round2((coocCount / N) * 100),
      avgCycle: coocCount > 0 ? round1(N / coocCount) : null,
      pairGap,
      expectedCycle: THEORETICAL_KENO_PAIR.expectedCycle,
      reason
    },
    wheel3: {
      numbers: wheel3Nums,
      labels: wheel3Nums.map(pad2),
      backupNum: backupC,
      backupLabel: pad2(backupC),
      pairs: [
        [A, B].sort((x, y) => x - y),
        [A, backupC].sort((x, y) => x - y),
        [B, backupC].sort((x, y) => x - y)
      ]
    },
    wheel4: {
      numbers: wheel4Nums,
      labels: wheel4Nums.map(pad2),
      backupNums: [backupC, backupD],
      backupLabels: [pad2(backupC), pad2(backupD)]
    }
  };
}

/**
 * Single-pass O(N) walk-forward backtest across all strategies + Wheel-3 & Wheel-4 tracking
 */
function runAllStrategiesSinglePass(draws, activeMode) {
  const N = draws.length;
  const allModes = [...Object.keys(STRATEGIES), BASELINE_STRATEGY.key];
  const statsMap = {};
  for (const m of allModes) {
    statsMap[m] = {
      hit2Count: 0,
      hit1PlusCount: 0,
      curLoseStreak: 0,
      maxLoseStreak: 0,
      bac3Hit2Count: 0,
      bac3Hit3Count: 0,
      bac3Hit1PlusCount: 0,
      wheel3WinDraws: 0,
      wheel3PairsWon: 0,
      wheel3CurGap: 0,
      wheel3MaxGap: 0,
      wheel4WinDraws: 0,
      wheel4PairsWon: 0,
      wheel4CurGap: 0,
      wheel4MaxGap: 0,
      backtestHistory: [],
      allHit2Events: []
    };
  }

  const st = createTrackerState();
  if (N <= WARMUP_DRAWS) {
    for (let i = 0; i < N; i++) advanceTrackerState(st, draws, i);
    return { statsMap, evalCount: 0, finalState: st };
  }

  for (let i = 0; i < WARMUP_DRAWS; i++) {
    advanceTrackerState(st, draws, i);
  }

  const historyFrom = Math.max(WARMUP_DRAWS, N - BACKTEST_HISTORY_LIMIT);
  const evalCount = N - WARMUP_DRAWS;

  for (let idx = WARMUP_DRAWS; idx < N; idx++) {
    const draw = draws[idx];
    const numSet = new Set(draw.numbers);

    for (const m of allModes) {
      const acc = statsMap[m];
      const pick = selectSinglePairAtStep(st, m);
      const [A, B] = pick.pair;

      const matchedNums = [];
      if (numSet.has(A)) matchedNums.push(A);
      if (numSet.has(B)) matchedNums.push(B);

      const wonBac2 = matchedNums.length === 2;
      if (matchedNums.length >= 1) acc.hit1PlusCount++;
      if (wonBac2) {
        acc.hit2Count++;
        acc.curLoseStreak = 0;
      } else {
        acc.curLoseStreak++;
        if (acc.curLoseStreak > acc.maxLoseStreak) acc.maxLoseStreak = acc.curLoseStreak;
      }

      // Wheel-3 & Keno Bậc 3 evaluation
      const w3Matched = pick.trio.filter((x) => numSet.has(x));
      const w3HitCount = w3Matched.length;
      if (w3HitCount >= 1) acc.bac3Hit1PlusCount++;
      if (w3HitCount === 2) acc.bac3Hit2Count++;
      else if (w3HitCount === 3) acc.bac3Hit3Count++;
      const bac3Prize = w3HitCount === 3 ? BAC3_PRIZE_3 : w3HitCount === 2 ? BAC3_PRIZE_2 : 0;

      const w3Pairs = w3HitCount >= 2 ? (w3HitCount * (w3HitCount - 1)) / 2 : 0;
      if (w3Pairs > 0) {
        acc.wheel3WinDraws++;
        acc.wheel3PairsWon += w3Pairs;
        acc.wheel3CurGap = 0;
      } else {
        acc.wheel3CurGap++;
        if (acc.wheel3CurGap > acc.wheel3MaxGap) acc.wheel3MaxGap = acc.wheel3CurGap;
      }

      // Wheel-4 evaluation
      const w4Matched = pick.wheel4.numbers.filter((x) => numSet.has(x));
      const w4Pairs = w4Matched.length >= 2 ? (w4Matched.length * (w4Matched.length - 1)) / 2 : 0;
      if (w4Pairs > 0) {
        acc.wheel4WinDraws++;
        acc.wheel4PairsWon += w4Pairs;
        acc.wheel4CurGap = 0;
      } else {
        acc.wheel4CurGap++;
        if (acc.wheel4CurGap > acc.wheel4MaxGap) acc.wheel4MaxGap = acc.wheel4CurGap;
      }

      if (m === activeMode) {
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
          wonAtLeast1: matchedNums.length >= 1,
          prize: wonBac2 ? BAC2_PRIZE : 0,
          trio: pick.trio,
          trioLabels: pick.trioLabels,
          trioMatched: w3Matched.map(pad2),
          trioHitCount: w3HitCount,
          wonBac3: w3HitCount >= 2,
          bac3Prize,
          backupLabel: pick.wheel3.backupLabel,
          wheel3Labels: pick.wheel3.labels,
          wheel3Matched: w3Matched.map(pad2),
          wheel3PairsWon: w3Pairs,
          wheel3Prize: w3Pairs * BAC2_PRIZE,
          actualNumbers: draw.numbers
        };
        if (idx >= historyFrom) acc.backtestHistory.push(record);
        if (w3HitCount >= 2) acc.allHit2Events.push(record);
      }
    }

    advanceTrackerState(st, draws, idx);
  }

  return { statsMap, evalCount, finalState: st };
}

function summarizeModeStats(mode, acc, evalCount) {
  if (evalCount <= 0) {
    return {
      mode,
      evaluatedDraws: 0,
      hit2Count: 0,
      hit2Rate: 0,
      bac2Rtp: 0,
      totalCost10k: 0,
      totalPrize10k: 0,
      netProfit10k: 0,
      hit1PlusCount: 0,
      hit1PlusRate: 0,
      avgHitCycle: null,
      currentPairLoseStreak: 0,
      maxPairLoseStreak: 0,
      bac3Hit2Count: 0,
      bac3Hit3Count: 0,
      bac3Hit1PlusCount: 0,
      bac3WinCount: 0,
      bac3WinRate: 0,
      bac3Hit2Rate: 0,
      bac3Hit3Rate: 0,
      bac3Hit1PlusRate: 0,
      bac3TotalCost10k: 0,
      bac3TotalPrize10k: 0,
      bac3NetProfit10k: 0,
      bac3Rtp: 0,
      bac3AvgCycle: null,
      bac3CurrentGap: 0,
      bac3MaxGap: 0,
      bac3Edge: evaluateStatisticalEdge(0, 0, THEORETICAL_KENO_PAIR.bac3ProbExact),
      wheel3WinDraws: 0,
      wheel3WinRate: 0,
      wheel3PairsWon: 0,
      wheel3Rtp: 0,
      wheel3AvgCycle: null,
      wheel3MaxGap: 0,
      wheel3CurrentGap: 0,
      wheel4WinDraws: 0,
      wheel4WinRate: 0,
      wheel4PairsWon: 0,
      wheel4Rtp: 0,
      wheel4AvgCycle: null,
      wheel4MaxGap: 0,
      edge: evaluateStatisticalEdge(0, 0),
      theoretical: THEORETICAL_KENO_PAIR
    };
  }

  const totalCost = evalCount * TICKET_STAKE;
  const totalPrize = acc.hit2Count * BAC2_PRIZE;
  const bac3WinCount = acc.bac3Hit2Count + acc.bac3Hit3Count;
  const bac3TotalPrize = acc.bac3Hit2Count * BAC3_PRIZE_2 + acc.bac3Hit3Count * BAC3_PRIZE_3;

  return {
    mode,
    evaluatedDraws: evalCount,
    hit2Count: acc.hit2Count,
    hit2Rate: round2((acc.hit2Count / evalCount) * 100),
    bac2Rtp: round1((totalPrize / totalCost) * 100),
    totalCost10k: totalCost,
    totalPrize10k: totalPrize,
    netProfit10k: totalPrize - totalCost,
    hit1PlusCount: acc.hit1PlusCount,
    hit1PlusRate: round2((acc.hit1PlusCount / evalCount) * 100),
    avgHitCycle: acc.hit2Count > 0 ? round1(evalCount / acc.hit2Count) : null,
    currentPairLoseStreak: acc.curLoseStreak,
    maxPairLoseStreak: acc.maxLoseStreak,
    bac3Hit2Count: acc.bac3Hit2Count,
    bac3Hit3Count: acc.bac3Hit3Count,
    bac3Hit1PlusCount: acc.bac3Hit1PlusCount,
    bac3WinCount,
    bac3WinRate: round2((bac3WinCount / evalCount) * 100),
    bac3Hit2Rate: round2((acc.bac3Hit2Count / evalCount) * 100),
    bac3Hit3Rate: round2((acc.bac3Hit3Count / evalCount) * 100),
    bac3Hit1PlusRate: round2((acc.bac3Hit1PlusCount / evalCount) * 100),
    bac3TotalCost10k: totalCost,
    bac3TotalPrize10k: bac3TotalPrize,
    bac3NetProfit10k: bac3TotalPrize - totalCost,
    bac3Rtp: round1((bac3TotalPrize / totalCost) * 100),
    bac3AvgCycle: bac3WinCount > 0 ? round1(evalCount / bac3WinCount) : null,
    bac3CurrentGap: acc.wheel3CurGap,
    bac3MaxGap: acc.wheel3MaxGap,
    bac3Edge: evaluateStatisticalEdge(bac3WinCount, evalCount, THEORETICAL_KENO_PAIR.bac3ProbExact),
    wheel3WinDraws: acc.wheel3WinDraws,
    wheel3WinRate: round2((acc.wheel3WinDraws / evalCount) * 100),
    wheel3PairsWon: acc.wheel3PairsWon,
    wheel3Rtp: round1(((acc.wheel3PairsWon * BAC2_PRIZE) / (evalCount * 3 * TICKET_STAKE)) * 100),
    wheel3AvgCycle: acc.wheel3WinDraws > 0 ? round1(evalCount / acc.wheel3WinDraws) : null,
    wheel3MaxGap: acc.wheel3MaxGap,
    wheel3CurrentGap: acc.wheel3CurGap,
    wheel4WinDraws: acc.wheel4WinDraws,
    wheel4WinRate: round2((acc.wheel4WinDraws / evalCount) * 100),
    wheel4PairsWon: acc.wheel4PairsWon,
    wheel4Rtp: round1(((acc.wheel4PairsWon * BAC2_PRIZE) / (evalCount * 6 * TICKET_STAKE)) * 100),
    wheel4AvgCycle: acc.wheel4WinDraws > 0 ? round1(evalCount / acc.wheel4WinDraws) : null,
    wheel4MaxGap: acc.wheel4MaxGap,
    edge: evaluateStatisticalEdge(acc.hit2Count, evalCount),
    theoretical: THEORETICAL_KENO_PAIR
  };
}

/**
 * Scan all 3,160 pairs for Top Rebound & Top Co-occurring tables, plus Top 15 compressed active numbers
 */
export function computePairAnalytics(draws, finalState, predictedPair, mode = DEFAULT_STRATEGY) {
  const N = Math.max(1, finalState.totalDraws);
  const d60 = Math.min(60, N);
  const cfg = STRATEGIES[mode] || STRATEGIES[DEFAULT_STRATEGY];
  const { fAll, f24, f25, f10, lastNumIdx, coocAll, cooc60, lastPairIdx } = finalState;
  const mk = getMarkovVector(finalState);
  const predKey = `${predictedPair[0]}-${predictedPair[1]}`;

  const allPairs = [];
  for (let u = 1; u <= 80; u++) {
    for (let v = u + 1; v <= 80; v++) {
      const cooc = coocAll[u][v];
      const pg = lastPairIdx[u][v] === -1 ? N : N - 1 - lastPairIdx[u][v];
      const ga = lastNumIdx[u] === -1 ? N : N - 1 - lastNumIdx[u];
      const gb = lastNumIdx[v] === -1 ? N : N - 1 - lastNumIdx[v];
      const sumF24 = f24[u] + f24[v];
      const deadPenalty = ga > cfg.maxNumGap || gb > cfg.maxNumGap ? -400 : 0;
      const reboundScore =
        deadPenalty -
        sumF24 * 12 +
        ((fAll[u] + fAll[v]) / N) * 30 +
        (mk[u] + mk[v]) * 40 +
        (cooc / N) * 60 +
        (cooc60[u][v] / d60) * cfg.wCooc60 +
        (pg >= 16 && pg <= 38 ? 6 : 0);

      allPairs.push({
        pair: [u, v],
        pairLabel: `${pad2(u)} - ${pad2(v)}`,
        coocCount: cooc,
        coocRate: round2((cooc / N) * 100),
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

  const topDueReboundPairs = [...allPairs]
    .sort((a, b) => b.reboundScore - a.reboundScore || b.coocCount - a.coocCount)
    .slice(0, 12);

  const numberRankingTop15 = ALL_NUMS_BASE.filter((x) => {
    const g = lastNumIdx[x] === -1 ? N : N - 1 - lastNumIdx[x];
    return g <= cfg.maxNumGap;
  })
    .sort((a, b) => f24[a] - f24[b] || fAll[b] - fAll[a] || mk[b] - mk[a] || a - b)
    .slice(0, 15)
    .map((x, idx) => ({
      rank: idx + 1,
      num: x,
      label: pad2(x),
      f10: f10[x],
      f24: f24[x],
      f25: f25[x],
      fAll: fAll[x],
      rateAll: round1((fAll[x] / N) * 100),
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
 * Main Entry Point
 */
export function analyzeAndPredictNextDraw(draws, customMode = DEFAULT_STRATEGY) {
  const mode = STRATEGIES[customMode] ? customMode : DEFAULT_STRATEGY;
  const N = draws.length;

  const { statsMap, evalCount, finalState } = runAllStrategiesSinglePass(draws, mode);
  const activeAcc = statsMap[mode];
  const activeSummary = summarizeModeStats(mode, activeAcc, evalCount);

  const strategyComparison = [...Object.keys(STRATEGIES), BASELINE_STRATEGY.key].map((key) => {
    const meta = STRATEGIES[key] || BASELINE_STRATEGY;
    const sm = summarizeModeStats(key, statsMap[key], evalCount);
    return {
      key,
      label: meta.label,
      shortLabel: meta.shortLabel,
      description: meta.description,
      isSelected: key === mode,
      isBaseline: key === BASELINE_STRATEGY.key,
      ...sm
    };
  });

  const nextSelection = selectSinglePairAtStep(finalState, mode);
  const analytics = computePairAnalytics(draws, finalState, nextSelection.pair, mode);

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
      summary: activeSummary
    },
    strategyComparison,
    analytics,
    backtestHistory: activeAcc.backtestHistory.reverse(),
    allHit2Events: activeAcc.allHit2Events.reverse(),
    backtestSummary: activeSummary
  };
}
