/**
 * Vietlott Keno Bậc 3 & Bậc 2 — Tactical Predictor + 100k Bankroll Player Engine
 *
 * Kết hợp:
 * 1. Ba thuật toán chọn Bộ 3 [A-B-C] & Cặp Chủ Lực [A-B] tối ưu (Khử bóng chết <=10k + Markov + Cooc).
 * 2. Bộ Mô Phỏng Người Chơi Thực Chiến Vốn 100.000đ:
 *    - Chia vốn 5 bước (90k đánh + luôn giữ 10k dự phòng => 0% cháy túi), thắng B1, B3, B4 đều CÓ LÃI:
 *      B1: 10k B3 -> B2: 10k B3 -> B3: 30k B3 -> B4: 30k Đá B2 (3 cặp) -> B5: 10k B2 Phao Cứu Sinh.
 *    - Khóa ví chống cầu lạnh (chờ nổ mồi + né bão quá nhiệt >=4/6 kỳ) & né nhịp xả trước B4 khi >=2/6 kỳ.
 */

export const THEORETICAL_KENO_PAIR = {
  hit2Rate: 6.01,        // 19 / 316
  hit2ProbExact: 19 / 316,
  theoreticalRtp: 54.11,
  expectedCycle: 16.63,
  hit1PlusRate: 43.99,
  singleHitRate: 25.00,
  bac3Hit2Rate: 14.34,
  bac3Hit3Rate: 1.39,
  bac3WinRate: 15.73,
  bac3ProbExact: 0.157314,
  bac3TheoreticalRtp: 84.21,
  bac3ExpectedCycle: 6.36,
  bac3Hit1PlusRate: 58.34,
  wheel3WinRate: 15.73,
  wheel4WinRate: 25.89
};

export const STRATEGIES = {
  hybrid_markov_cooc: {
    key: 'hybrid_markov_cooc',
    label: 'Markov + Cooc 60k (An Toàn Vốn 100k: 67.5% · Lãi 150k +1.050k)',
    shortLabel: 'Markov + Cooc',
    maxNumGap: 10,
    anchorCount: 7,
    wF24: 13,
    wMarkov: 45,
    wCoocAll: 55,
    wCooc60: 35,
    dueMin: 14,
    dueMax: 38,
    description:
      'Khử bóng gan lì >10k, lọc Top 7 hạt nhân nén 24k có lực Markov cao nhất để chốt Cặp [A-B] & Mảnh ghép B3 [C]; cân bằng giữa tỷ lệ nổ 19.43% và bảo toàn vốn 100k.'
  },
  triad_synergy_core: {
    key: 'triad_synergy_core',
    label: 'Bộ 3 Nén Cộng Hưởng (Cặp 2/2: 8.29% · An Toàn 67.5%)',
    shortLabel: 'Nén Cộng Hưởng',
    maxNumGap: 10,
    anchorCount: 7,
    wF24: 12,
    wMarkov: 40,
    wCoocAll: 60,
    wCooc60: 25,
    dueMin: 14,
    dueMax: 38,
    description:
      'Lọc Top 7 hạt nhân nén sâu <=10k, ưu tiên tương hợp lịch sử dài hạn để chốt Cặp 2/2 [A-B] mạnh nhất (8.29%) và Mảnh ghép Bậc 3 [C].'
  },
  triad_jackpot_33: {
    key: 'triad_jackpot_33',
    label: 'Tam Giác Đồng Xuất Hiện (Mở Rộng Top 9 · B3 19.29% · RTP 134%)',
    shortLabel: 'Mở Rộng Top 9',
    maxNumGap: 10,
    anchorCount: 9,
    wF24: 14,
    wMarkov: 45,
    wCoocAll: 50,
    wCooc60: 40,
    dueMin: 14,
    dueMax: 38,
    description:
      'Mở rộng quét Top 9 hạt nhân nén <=10k kết hợp đồng xuất hiện ngắn hạn 60k và Markov mạnh để bắt Bộ 3 ổn định trên mọi khung kỳ.'
  }
};

const BASELINE_STRATEGY = {
  key: 'baseline_01_02',
  label: 'Đối chứng cố định [01, 02, 03]',
  shortLabel: 'Đối chứng [01-03]',
  maxNumGap: 999,
  anchorCount: 3,
  wF24: 0,
  wMarkov: 0,
  wCoocAll: 0,
  wCooc60: 0,
  dueMin: 14,
  dueMax: 38,
  description: 'Luôn giữ nguyên bộ [01, 02, 03] ở mọi kỳ để làm mốc so sánh.'
};

export const PLAYER_100K_STEPS = [
  { step: 1, type: 'B3', stake: 10000, shortLabel: 'B1: 10k B3', desc: 'Vé Bậc 3 (10k) — Trúng 2/3 thu 20k (Lãi +10k) · 3/3 thu 400k' },
  { step: 2, type: 'B3', stake: 10000, shortLabel: 'B2: 10k B3', desc: 'Vé Bậc 3 (10k) — Trúng 2/3 thu 20k (Hòa 100k) · 3/3 thu 400k' },
  { step: 3, type: 'B3', stake: 30000, shortLabel: 'B3: 30k B3', desc: 'Vé Bậc 3 (30k) — Trúng 2/3 thu 60k (Lãi +10k) · 3/3 thu 1.200k' },
  { step: 4, type: 'W3', stake: 30000, shortLabel: 'B4: 30k Đá B2', desc: 'Đá Vòng 3 Cặp B2 (30k) — Trúng bất kỳ 2/3 số thu 90k (Lãi +10k) · 3/3 thu 270k' },
  { step: 5, type: 'B2', stake: 10000, shortLabel: 'B5: 10k B2', desc: 'Phao Bậc 2 (10k) — Nổ 2/2 thu 90k về lại 100k (Giữ 10k dự phòng)' }
];

export const DEFAULT_STRATEGY = 'hybrid_markov_cooc';
const WARMUP_DRAWS = 50;
const BACKTEST_HISTORY_LIMIT = 150;
const INITIAL_BANKROLL = 100000;
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
      const row = state.trans[prev[i]];
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
 * Select Trio [A, B, C] & Strongest Inner Pair [A, B] using only state strictly BEFORE the draw
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
    reason = 'Mốc đối chứng cố định bộ [01, 02, 03] qua mọi kỳ.';
  } else {
    const anchorCount = cfg.anchorCount ?? 7;
    const wF24 = cfg.wF24 ?? 13;
    const wMarkov = cfg.wMarkov ?? 45;
    const wCoocAll = cfg.wCoocAll ?? 55;
    const wCooc60 = cfg.wCooc60 ?? 35;
    const dueMin = cfg.dueMin ?? 14;
    const dueMax = cfg.dueMax ?? 38;

    const filtered = ALL_NUMS_BASE.filter((x) => {
      const g = lastNumIdx[x] === -1 ? N : N - 1 - lastNumIdx[x];
      return g <= cfg.maxNumGap;
    });
    const poolBase = filtered.length >= Math.max(8, anchorCount) ? filtered : [...ALL_NUMS_BASE];
    poolBase.sort((a, b) => {
      if (f24[a] !== f24[b]) return f24[a] - f24[b];
      if (fAll[a] !== fAll[b]) return fAll[b] - fAll[a];
      if (mk[a] !== mk[b]) return mk[b] - mk[a];
      return a - b;
    });

    const anchors = poolBase.slice(0, anchorCount);
    let bestScore = -1e9;
    for (let a = 0; a < anchors.length; a++) {
      for (let b = a + 1; b < anchors.length; b++) {
        const u = anchors[a];
        const v = anchors[b];
        const pg = lastPairIdx[u][v] === -1 ? N : N - 1 - lastPairIdx[u][v];
        const sc =
          -(f24[u] + f24[v]) * wF24 +
          ((fAll[u] + fAll[v]) / N) * 30 +
          (mk[u] + mk[v]) * wMarkov +
          (coocAll[u][v] / N) * wCoocAll +
          (cooc60[u][v] / d60) * wCooc60 +
          (pg >= dueMin && pg <= dueMax ? 6 : 0);
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

    const focusDesc =
      mode === 'triad_synergy_core'
        ? `tối đa hóa cặp 2/2`
        : mode === 'triad_jackpot_33'
        ? `quét Top ${anchorCount} cộng hưởng Bộ 3`
        : `dẫn đầu điểm nén + Markov`;
    reason =
      `Khử bóng chết (gan ${ga}k & ${gb}k ≤ ${cfg.maxNumGap}k), lọc Top ${anchorCount} chọn Cặp [${pad2(A)}-${pad2(B)}] ${focusDesc}` +
      (pg >= dueMin && pg <= dueMax
        ? ` (gan cặp ${pg}k đúng điểm rơi) + mảnh ghép B3 [${pad2(backupC)}].`
        : ` kết hợp mảnh ghép B3 [${pad2(backupC)}] tối ưu hóa chu kỳ nổ.`);
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
 * Single-pass O(N) Walk-Forward + 100k Smart Bankroll Player Simulator across all modes
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
      // 100k Player Session State
      pSessionId: 1,
      pSessionBank: INITIAL_BANKROLL,
      pStepIdx: 0,
      pWaitingForTrigger: false,
      pJustSkippedCooldown: false,
      pRecentB3HitsWindow: [],
      pCompletedSessions: 0,
      pWinSessions: 0,
      pEvenSessions: 0,
      pStopLossSessions: 0,
      pTotalSpent: 0,
      pTotalReturned: 0,
      pNetProfit: 0,
      pPlayedDraws: 0,
      pSkippedDraws: 0,
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

      const w3Matched = pick.trio.filter((x) => numSet.has(x));
      const w3HitCount = w3Matched.length;
      if (w3HitCount >= 1) acc.bac3Hit1PlusCount++;
      if (w3HitCount === 2) acc.bac3Hit2Count++;
      else if (w3HitCount === 3) acc.bac3Hit3Count++;
      const bac3Prize = w3HitCount === 3 ? BAC3_PRIZE_3 : w3HitCount === 2 ? BAC3_PRIZE_2 : 0;

      const w3Pairs = w3HitCount >= 2 ? (w3HitCount * (w3HitCount - 1)) / 2 : 0;
      const w3Prize = w3Pairs * BAC2_PRIZE;

      // IMPORTANT: Read virtual gap & recent 6-draw density STRICTLY BEFORE updating with this draw
      const preDrawVGapB3 = acc.wheel3CurGap;
      const recentHits6 = acc.pRecentB3HitsWindow.reduce((s, v) => s + v, 0);

      // Update 100k Smart Player Wallet
      let pActionLabel = '⏸️ Nghỉ 0đ (Chờ cầu mồi)';
      let pStake = 0;
      let pPrize = 0;
      let pBankAfter = acc.pSessionBank;
      let pOutcome = 'SKIP';
      let pStepNum = acc.pStepIdx + 1;
      const pSessionNum = acc.pSessionId;

      if (acc.pWaitingForTrigger && preDrawVGapB3 === 0 && recentHits6 < 4) {
        acc.pWaitingForTrigger = false;
      }
      if (!acc.pWaitingForTrigger && acc.pStepIdx === 0 && recentHits6 >= 4) {
        acc.pWaitingForTrigger = true;
      }

      if (acc.pWaitingForTrigger) {
        acc.pSkippedDraws++;
        pActionLabel = recentHits6 >= 4 ? '⏸️ Nghỉ 0đ (Xả nhiệt)' : '⏸️ Nghỉ 0đ (Chờ cầu mồi)';
      } else if (acc.pStepIdx === 3 && !acc.pJustSkippedCooldown && recentHits6 >= 2) {
        acc.pJustSkippedCooldown = true;
        acc.pSkippedDraws++;
        pActionLabel = '⏸️ Nghỉ 0đ (Né nhịp xả)';
      } else {
        acc.pJustSkippedCooldown = false;
        acc.pPlayedDraws++;
        const stepCfg = PLAYER_100K_STEPS[acc.pStepIdx];
        pStake = stepCfg.stake;
        pActionLabel = stepCfg.shortLabel;
        acc.pSessionBank -= pStake;
        acc.pTotalSpent += pStake;

        if (stepCfg.type === 'B3') {
          pPrize = bac3Prize * (pStake / TICKET_STAKE);
        } else if (stepCfg.type === 'W3') {
          pPrize = w3Prize * (pStake / (3 * TICKET_STAKE));
        } else {
          pPrize = (wonBac2 ? BAC2_PRIZE : 0) * (pStake / TICKET_STAKE);
        }
        acc.pSessionBank += pPrize;
        acc.pTotalReturned += pPrize;
        pBankAfter = acc.pSessionBank;

        if (acc.pSessionBank >= INITIAL_BANKROLL && pPrize > 0) {
          acc.pCompletedSessions++;
          const net = acc.pSessionBank - INITIAL_BANKROLL;
          acc.pNetProfit += net;
          if (net > 0) {
            acc.pWinSessions++;
            pOutcome = 'WIN_RESET';
          } else {
            acc.pEvenSessions++;
            pOutcome = 'EVEN_RESET';
          }
          acc.pSessionId++;
          acc.pSessionBank = INITIAL_BANKROLL;
          acc.pStepIdx = 0;
          acc.pWaitingForTrigger = false;
        } else if (acc.pStepIdx === PLAYER_100K_STEPS.length - 1) {
          acc.pCompletedSessions++;
          acc.pStopLossSessions++;
          acc.pNetProfit += acc.pSessionBank - INITIAL_BANKROLL;
          pOutcome = 'STOP_LOSS_KEEP_10K';
          acc.pSessionId++;
          acc.pSessionBank = INITIAL_BANKROLL;
          acc.pStepIdx = 0;
          acc.pWaitingForTrigger = true;
        } else {
          pOutcome = 'IN_PROGRESS';
          acc.pStepIdx++;
        }
      }

      if (w3Pairs > 0) {
        acc.wheel3WinDraws++;
        acc.wheel3PairsWon += w3Pairs;
        acc.wheel3CurGap = 0;
      } else {
        acc.wheel3CurGap++;
        if (acc.wheel3CurGap > acc.wheel3MaxGap) acc.wheel3MaxGap = acc.wheel3CurGap;
      }

      acc.pRecentB3HitsWindow.push(w3HitCount >= 2 ? 1 : 0);
      if (acc.pRecentB3HitsWindow.length > 6) acc.pRecentB3HitsWindow.shift();

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
          wheel3Prize: w3Prize,
          preDrawVGapB3,
          recentHits6,
          player: {
            sessionId: pSessionNum,
            stepNum: pStepNum,
            actionLabel: pActionLabel,
            stake: pStake,
            prize: pPrize,
            bankAfter: pBankAfter,
            outcome: pOutcome
          },
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
  const safeRate =
    acc.pCompletedSessions > 0
      ? round1(((acc.pWinSessions + acc.pEvenSessions) / acc.pCompletedSessions) * 100)
      : 0;
  const playerSummary = {
    initialBank: INITIAL_BANKROLL,
    completedSessions: acc.pCompletedSessions,
    winSessions: acc.pWinSessions,
    evenSessions: acc.pEvenSessions,
    safeSessions: acc.pWinSessions + acc.pEvenSessions,
    stopLossSessions: acc.pStopLossSessions,
    safeRate,
    bustCount: 0,
    bustRate: 0,
    playedDraws: acc.pPlayedDraws,
    skippedDraws: acc.pSkippedDraws,
    totalSpent: acc.pTotalSpent,
    totalReturned: acc.pTotalReturned,
    playerRtp: acc.pTotalSpent > 0 ? round1((acc.pTotalReturned / acc.pTotalSpent) * 100) : 0,
    cumulativeNetProfit: acc.pNetProfit
  };

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
      player100k: playerSummary,
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
    player100k: playerSummary,
    edge: evaluateStatisticalEdge(acc.hit2Count, evalCount),
    theoretical: THEORETICAL_KENO_PAIR
  };
}

function buildNextPlayerAction(acc, nextSelection, nextDrawId) {
  const recentHits6 = acc.pRecentB3HitsWindow.reduce((s, v) => s + v, 0);
  let waitingForTrigger = acc.pWaitingForTrigger;
  if (waitingForTrigger && acc.wheel3CurGap === 0 && recentHits6 < 4) {
    waitingForTrigger = false;
  }
  if (!waitingForTrigger && acc.pStepIdx === 0 && recentHits6 >= 4) {
    waitingForTrigger = true;
  }
  const isCooldownSkip =
    !waitingForTrigger && acc.pStepIdx === 3 && !acc.pJustSkippedCooldown && recentHits6 >= 2;
  const isSkip = waitingForTrigger || isCooldownSkip;

  const curStepIdx = acc.pStepIdx;
  const stepCfg = PLAYER_100K_STEPS[curStepIdx];
  const trioStr = nextSelection.trioLabels.join(' - ');
  const pairStr = nextSelection.pairLabels.join(' - ');
  const spentSoFar = INITIAL_BANKROLL - acc.pSessionBank;

  let actionType =
    stepCfg.type === 'B3' ? 'BET_B3' : stepCfg.type === 'W3' ? 'BET_W3_WHEEL' : 'BET_B2_RESCUE';
  let recommendedStake = stepCfg.stake;
  let ticketInstruction = '';

  if (waitingForTrigger) {
    actionType = 'SKIP_OBSERVE';
    recommendedStake = 0;
    if (recentHits6 >= 4) {
      ticketInstruction = `⏸️ Kỳ #${nextDrawId} NGHỈ XẢ NHIỆT (0đ): Bộ số vừa nổ dày (${recentHits6}/6 kỳ gần nhất). Giữ nguyên ví ${acc.pSessionBank.toLocaleString('vi-VN')}đ chờ nhịp xả xong và có kỳ nổ mồi mới!`;
    } else {
      ticketInstruction = `⏸️ Kỳ #${nextDrawId} KHÓA VÍ CHỜ CẦU MỒI (0đ): Đang giữ nguyên ${acc.pSessionBank.toLocaleString('vi-VN')}đ tránh chuỗi gan lạnh (đang trượt ${acc.wheel3CurGap}k). Chỉ mở phiên B1 khi có 1 kỳ nổ mồi 2/3 hoặc 3/3!`;
    }
  } else if (isCooldownSkip) {
    actionType = 'SKIP_OBSERVE';
    recommendedStake = 0;
    ticketInstruction = `⏸️ Kỳ #${nextDrawId} ĐỨNG NGOÀI QUAN SÁT (0đ): Cầu đã nổ ${recentHits6}/6 kỳ gần nhất nên tạm né 1 kỳ xả trước khi vào Bước 4/5 (30k Đá B2). Giữ nguyên ví ${acc.pSessionBank.toLocaleString('vi-VN')}đ!`;
  } else if (stepCfg.type === 'B3') {
    const mult = stepCfg.stake / TICKET_STAKE;
    const ret2 = 20000 * mult;
    const ret3 = 400000 * mult;
    const afterBank2 = acc.pSessionBank - stepCfg.stake + ret2;
    const outcomeWord =
      afterBank2 > INITIAL_BANKROLL
        ? `LÃI +${(afterBank2 - INITIAL_BANKROLL).toLocaleString('vi-VN')}đ`
        : `HÒA ĐÚNG 100.000đ`;
    ticketInstruction = `🎯 Kỳ #${nextDrawId} (Bước ${stepCfg.step}/5): Mua vé Keno BẬC 3 bộ [${trioStr}] mệnh giá ${stepCfg.stake.toLocaleString('vi-VN')}đ. Trúng 2/3 thu ${ret2.toLocaleString('vi-VN')}đ (${outcomeWord}) · Trúng 3/3 thu ${ret3.toLocaleString('vi-VN')}đ!`;
  } else if (stepCfg.type === 'W3') {
    const pairsText = nextSelection.wheel3.pairs.map((p) => `[${pad2(p[0])}-${pad2(p[1])}]`).join(', ');
    const afterWin1 = acc.pSessionBank - stepCfg.stake + BAC2_PRIZE;
    const net1 = afterWin1 - INITIAL_BANKROLL;
    ticketInstruction = `🔥 Kỳ #${nextDrawId} (Bước 4/5 — Đá Vòng 3 Cặp B2): Mua 3 vé BẬC 2 (${pairsText}) x 10.000đ = 30.000đ. Trúng bất kỳ 2/3 số thu 90.000đ (${net1 >= 0 ? `LÃI +${net1.toLocaleString('vi-VN')}đ` : `còn ${afterWin1.toLocaleString('vi-VN')}đ`}) · Nổ 3/3 thu 270.000đ!`;
  } else {
    ticketInstruction = `🛡️ Kỳ #${nextDrawId} (Bước 5/5 — Phao Cứu Sinh Bậc 2): Mua vé Keno BẬC 2 Cặp Chủ Lực [${pairStr}] mệnh giá 10.000đ (luôn giữ 10.000đ dự phòng). Nổ 2/2 thu 90.000đ đưa ví về đúng 100.000đ HÒA VỐN!`;
  }

  return {
    sessionId: acc.pSessionId,
    currentBank: acc.pSessionBank,
    spentSoFar,
    reserveProtected: 10000,
    vGapB3: acc.wheel3CurGap,
    recentHits6,
    isCooldownSkip: isSkip,
    actionType,
    stepNumber: stepCfg.step,
    activeStepIdx: curStepIdx,
    recommendedStake,
    targetMode: stepCfg.type,
    ticketInstruction,
    stepsPlan: PLAYER_100K_STEPS.map((s, idx) => ({
      ...s,
      status: idx < curStepIdx ? 'done_miss' : idx === curStepIdx ? (isSkip ? 'waiting_skip' : 'current') : 'upcoming'
    }))
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

  const wF24 = cfg.wF24 ?? 13;
  const wMarkov = cfg.wMarkov ?? 45;
  const wCoocAll = cfg.wCoocAll ?? 55;
  const wCooc60 = cfg.wCooc60 ?? 35;
  const dueMin = cfg.dueMin ?? 14;
  const dueMax = cfg.dueMax ?? 38;

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
        sumF24 * wF24 +
        ((fAll[u] + fAll[v]) / N) * 30 +
        (mk[u] + mk[v]) * wMarkov +
        (cooc / N) * wCoocAll +
        (cooc60[u][v] / d60) * wCooc60 +
        (pg >= dueMin && pg <= dueMax ? 6 : 0);

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
  const nextPlayerAction = buildNextPlayerAction(activeAcc, nextSelection, nextDrawId);

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
    player100k: {
      nextAction: nextPlayerAction,
      summary: activeSummary.player100k
    },
    strategyComparison,
    analytics,
    backtestHistory: activeAcc.backtestHistory.reverse(),
    allHit2Events: activeAcc.allHit2Events.reverse(),
    backtestSummary: activeSummary
  };
}
