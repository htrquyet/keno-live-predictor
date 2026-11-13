/**
 * Vietlott Keno 80 Pair-First Adaptive Prediction Engine
 * Specialized for Bậc 2 (2-number pairs & Disjoint Top-4 Pair Portfolio) + Bậc 3–5 + RTP Backtesting
 *
 * Kiến trúc:
 * 1. Tín hiệu chuẩn hóa Z-score & Empirical-Bayes Shrinkage:
 *    - Markov bậc 1 (trans1) làm mượt Beta/Dirichlet (alpha = 60 kéo về nền 0.25) dạng Log-Likelihood Ratio.
 *    - Tần suất lũy tiến (Expanding Frequency) & EWMA đa khung (HL = 12, HL = 28) dạng Log-Odds.
 *    - Chu kỳ nhịp rơi & chống kiệt sức hiệu chuẩn về Z-score đồng nhất thang đo.
 * 2. Pair-First Scoring (3.160 cặp):
 *    - Chấm trực tiếp mọi cặp (a, b): tổng Z-score thành phần + Co-occurrence Lift làm mượt + điểm đa vùng.
 *    - Cặp VIP #1 lấy cặp điểm cao nhất (tuân thủ bất đẳng thức hoán vị Best-with-Best).
 *    - Top 4 Song Thủ chọn 4 cặp ĐỘC LẬP (8 số không trùng) để tối đa hóa P(ít nhất 1 cặp trúng).
 * 3. Backtest lũy tiến O(N) kèm chỉ số RTP (%) thực tế và so sánh với RTP lý thuyết Keno.
 */

const BASE_P = 0.25;
const BASE_PAIR_P = (20 * 19) / (80 * 79); // ~0.06012658 (380/6320)

const DEFAULT_WEIGHTS = {
  freq: 0.10,
  momentum10: 0.05,
  momentum20: 0.05,
  markov: 0.75,
  cycle: 0.05
};

const MODE_WEIGHTS = {
  adaptive: DEFAULT_WEIGHTS,
  markov: { freq: 0.04, momentum10: 0.03, momentum20: 0.03, markov: 0.86, cycle: 0.04 },
  hot: { freq: 0.25, momentum10: 0.35, momentum20: 0.25, markov: 0.10, cycle: 0.05 },
  due: { freq: 0.15, momentum10: 0.10, momentum20: 0.10, markov: 0.25, cycle: 0.40 }
};

const MIN_WARMUP_DRAWS = 10;
const PAIR_CO_WEIGHT = 0.15;
const PAIR_ZONE_WEIGHT = 0.10;
const MARKOV_ALPHA = 60;

// Theoretical Keno benchmarks (uniform 20/80 draw, 10,000đ ticket)
export const THEORETICAL_KENO = {
  bac2WinRate: Number((BASE_PAIR_P * 100).toFixed(2)), // 6.01%
  bac2Rtp: Number((BASE_PAIR_P * 9 * 100).toFixed(1)), // 54.1%
  top4DisjointAnyWinRate: 22.3, // Exact inclusion-exclusion 22.26%
  top4DisjointRtp: 54.1,
  bac3WinRate: 15.3,
  bac3Rtp: 83.3,
  bac4WinRate: 25.9,
  bac4Rtp: 79.6,
  bac5WinRate: 9.7,
  bac5Rtp: 63.3
};

/**
 * Standardize an 81-length array (indices 1..80) to zero mean and unit variance.
 */
function zScore80(rawArr) {
  let sum = 0;
  let sum2 = 0;
  for (let n = 1; n <= 80; n++) {
    const v = rawArr[n] || 0;
    sum += v;
    sum2 += v * v;
  }
  const mean = sum / 80;
  const variance = sum2 / 80 - mean * mean;
  const out = new Float64Array(81);
  if (variance <= 1e-12) return out;
  const sd = Math.sqrt(variance);
  for (let n = 1; n <= 80; n++) {
    out[n] = ((rawArr[n] || 0) - mean) / sd;
  }
  return out;
}

/**
 * Normalize an array of 81 items (index 1..80) into 0..100 scale for display/compat.
 */
function normalize80(rawArr) {
  let min = Infinity;
  let max = -Infinity;
  for (let n = 1; n <= 80; n++) {
    const v = rawArr[n] || 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const out = new Array(81).fill(0);
  const span = max - min;
  if (span <= 1e-9) {
    for (let n = 1; n <= 80; n++) out[n] = 50;
    return out;
  }
  for (let n = 1; n <= 80; n++) {
    out[n] = ((rawArr[n] - min) / span) * 100;
  }
  return out;
}

/**
 * Compute cycle/fatigue score in Z-ready scale without overriding statistical signals.
 */
function computeCycleSignal(gap, streak) {
  if (streak >= 4) return -1.2;
  if (gap === 0 || gap === 1) return 0.6;
  if (gap >= 7 && gap <= 8) return 0.3;
  if (gap >= 10) return -0.3;
  return 0;
}

/**
 * Create an incremental state tracker so walk-forward backtests run in O(N) instead of O(N^2).
 */
function createIncrementalTracker() {
  const d12 = Math.exp(-Math.LN2 / 12);
  const d28 = Math.exp(-Math.LN2 / 28);
  return {
    totalDraws: 0,
    prevNumbers: null,
    countAll: new Int32Array(81),
    count20Window: [],
    count10Window: [],
    count5Window: [],
    count20: new Int32Array(81),
    count10: new Int32Array(81),
    count5: new Int32Array(81),
    ewma12: new Float64Array(81),
    ewma28: new Float64Array(81),
    wSum12: 0,
    wSum28: 0,
    d12,
    d28,
    lastSeenIdx: new Int32Array(81).fill(-1),
    currentStreak: new Int32Array(81),
    coMatrix: Array.from({ length: 81 }, () => new Int32Array(81)),
    trans1: Array.from({ length: 81 }, () => new Int32Array(81)),
    trans1Count: new Int32Array(81),
    zoneLast5Window: []
  };
}

function pushDrawToTracker(st, draw) {
  const nums = draw.numbers;
  const idx = st.totalDraws;
  const numSet = new Set(nums);

  st.wSum12 = st.wSum12 * st.d12 + 1;
  st.wSum28 = st.wSum28 * st.d28 + 1;

  for (let n = 1; n <= 80; n++) {
    st.ewma12[n] *= st.d12;
    st.ewma28[n] *= st.d28;
    if (numSet.has(n)) {
      st.countAll[n]++;
      st.ewma12[n] += 1;
      st.ewma28[n] += 1;
      st.lastSeenIdx[n] = idx;
      st.currentStreak[n]++;
    } else {
      st.currentStreak[n] = 0;
    }
  }

  for (let i = 0; i < nums.length; i++) {
    const a = nums[i];
    for (let j = i + 1; j < nums.length; j++) {
      const b = nums[j];
      st.coMatrix[a][b]++;
      st.coMatrix[b][a]++;
    }
  }

  if (st.prevNumbers) {
    for (const a of st.prevNumbers) {
      st.trans1Count[a]++;
      for (const b of nums) {
        st.trans1[a][b]++;
      }
    }
  }

  // Rolling exact counts for UI display (last 20, 10, 5 draws)
  st.count20Window.push(nums);
  for (const n of nums) st.count20[n]++;
  if (st.count20Window.length > 20) {
    const old = st.count20Window.shift();
    for (const n of old) st.count20[n]--;
  }

  st.count10Window.push(nums);
  for (const n of nums) st.count10[n]++;
  if (st.count10Window.length > 10) {
    const old = st.count10Window.shift();
    for (const n of old) st.count10[n]--;
  }

  st.count5Window.push(nums);
  for (const n of nums) st.count5[n]++;
  if (st.count5Window.length > 5) {
    const old = st.count5Window.shift();
    for (const n of old) st.count5[n]--;
  }

  st.zoneLast5Window.push(nums);
  if (st.zoneLast5Window.length > 5) {
    st.zoneLast5Window.shift();
  }

  st.prevNumbers = nums;
  st.totalDraws++;
}

function extractSubModelsFromTracker(st, includeNotes = true) {
  const totalDraws = st.totalDraws;
  if (totalDraws === 0) {
    const emptyNotes = Array.from({ length: 81 }, () => ({ note: 'Mới', type: 'optimal' }));
    return {
      totalDraws: 0,
      zFreq: new Float64Array(81),
      zMomentum10: new Float64Array(81),
      zMomentum20: new Float64Array(81),
      zMarkov: new Float64Array(81),
      zCycle: new Float64Array(81),
      freqNorm: new Array(81).fill(50),
      momentumNorm: new Array(81).fill(50),
      momentum20Norm: new Array(81).fill(50),
      markovNorm: new Array(81).fill(50),
      cycleNorm: new Array(81).fill(50),
      countAll: new Array(81).fill(0),
      count20: new Array(81).fill(0),
      count10: new Array(81).fill(0),
      count5: new Array(81).fill(0),
      currentGap: new Array(81).fill(0),
      currentStreak: new Array(81).fill(0),
      coMatrix: Array.from({ length: 81 }, () => new Array(81).fill(0)),
      statusNotes: emptyNotes,
      coolingNotes: emptyNotes,
      zoneCounts: new Array(8).fill(0)
    };
  }

  const lastNums = st.prevNumbers || [];
  const rawFreq = new Float64Array(81);
  const rawMomentum = new Float64Array(81);
  const rawMomentum20 = new Float64Array(81);
  const rawMarkov = new Float64Array(81);
  const rawCycle = new Float64Array(81);
  const currentGap = new Array(81).fill(totalDraws);

  for (let n = 1; n <= 80; n++) {
    const g = st.lastSeenIdx[n] >= 0 ? totalDraws - 1 - st.lastSeenIdx[n] : totalDraws;
    currentGap[n] = g;
    const streak = st.currentStreak[n];

    rawFreq[n] = Math.log((st.countAll[n] + 20 * BASE_P) / (totalDraws + 20) / BASE_P);
    rawMomentum[n] = Math.log((st.ewma12[n] + 6 * BASE_P) / (st.wSum12 + 6) / BASE_P);
    rawMomentum20[n] = Math.log((st.ewma28[n] + 12 * BASE_P) / (st.wSum28 + 12) / BASE_P);

    let mk = 0;
    for (const a of lastNums) {
      const p = (st.trans1[a][n] + MARKOV_ALPHA * BASE_P) / (st.trans1Count[a] + MARKOV_ALPHA);
      mk += Math.log(p / BASE_P);
    }
    rawMarkov[n] = mk;
    rawCycle[n] = computeCycleSignal(g, streak);
  }

  const zFreq = zScore80(rawFreq);
  const zMomentum10 = zScore80(rawMomentum);
  const zMomentum20 = zScore80(rawMomentum20);
  const zMarkov = zScore80(rawMarkov);
  const zCycle = zScore80(rawCycle);

  let statusNotes = null;
  let zoneCounts = null;
  if (includeNotes) {
    statusNotes = Array.from({ length: 81 }, () => ({ note: '', type: 'optimal' }));
    for (let n = 1; n <= 80; n++) {
      const fAll = st.countAll[n] / totalDraws;
      const g = currentGap[n];
      const streak = st.currentStreak[n];
      const c5 = st.count5[n];

      let note = `Cân bằng (${st.countAll[n]}/${totalDraws}k)`;
      let noteType = 'optimal';
      if (streak >= 2) {
        note = `Cầu bệt thông (${streak} kỳ · ${st.countAll[n]}/${totalDraws}k)`;
        noteType = 'hot';
      } else if (g === 0) {
        note = `Vừa nổ kỳ trước (${c5}/5k · ${st.countAll[n]}/${totalDraws}k)`;
        noteType = 'hot';
      } else if (g >= 1 && g <= 4 && fAll >= 0.25) {
        note = `Nhịp nóng (cách ${g}k · ${st.countAll[n]}/${totalDraws}k)`;
        noteType = 'hot';
      } else if (g >= 1 && g <= 4) {
        note = `Nhịp đều (cách ${g}k · ${st.countAll[n]}/${totalDraws}k)`;
        noteType = 'optimal';
      } else if (g >= 8) {
        note = `Lô gan (cách ${g} kỳ)`;
        noteType = 'cold';
      } else if (fAll < 0.20) {
        note = `Tần suất thấp (${st.countAll[n]}/${totalDraws}k)`;
        noteType = 'cold';
      }
      statusNotes[n] = { note, type: noteType };
    }

    zoneCounts = new Array(8).fill(0);
    for (const nums of st.zoneLast5Window) {
      for (const num of nums) {
        const z = Math.min(7, Math.floor((num - 1) / 10));
        zoneCounts[z]++;
      }
    }
  }

  return {
    totalDraws,
    zFreq,
    zMomentum10,
    zMomentum20,
    zMarkov,
    zCycle,
    rawFreq,
    rawMomentum,
    rawMomentum20,
    rawMarkov,
    rawCycle,
    freqNorm: normalize80(zFreq),
    momentumNorm: normalize80(zMomentum10),
    momentum20Norm: normalize80(zMomentum20),
    markovNorm: normalize80(zMarkov),
    cycleNorm: normalize80(zCycle),
    countAll: Array.from(st.countAll),
    count20: Array.from(st.count20),
    count10: Array.from(st.count10),
    count5: Array.from(st.count5),
    currentGap,
    currentStreak: Array.from(st.currentStreak),
    coMatrix: st.coMatrix,
    statusNotes,
    coolingNotes: statusNotes,
    zoneCounts
  };
}

/**
 * Compute calibrated multi-model signals from a draw history array.
 */
export function computeSubModels(draws) {
  const tracker = createIncrementalTracker();
  for (const d of draws) {
    pushDrawToTracker(tracker, d);
  }
  return extractSubModelsFromTracker(tracker, true);
}

/**
 * Score all 80 numbers using Z-score calibrated model weights.
 */
export function scoreNumbers(subModels, weights = DEFAULT_WEIGHTS) {
  const {
    zFreq,
    zMomentum10,
    zMomentum20,
    zMarkov,
    zCycle,
    freqNorm,
    momentumNorm,
    momentum20Norm,
    markovNorm,
    cycleNorm,
    countAll,
    count20,
    count10,
    count5,
    currentGap,
    currentStreak,
    statusNotes,
    coolingNotes
  } = subModels;

  const notes = statusNotes || coolingNotes || [];
  const wFreq = weights.freq ?? DEFAULT_WEIGHTS.freq;
  const wM10 = weights.momentum10 ?? DEFAULT_WEIGHTS.momentum10;
  const wM20 = weights.momentum20 ?? DEFAULT_WEIGHTS.momentum20;
  const wMarkov = weights.markov ?? DEFAULT_WEIGHTS.markov;
  const wCycle = weights.cycle ?? DEFAULT_WEIGHTS.cycle;

  const ranked = [];
  for (let n = 1; n <= 80; n++) {
    const fZ = zFreq ? zFreq[n] : ((freqNorm[n] - 50) / 20);
    const m10Z = zMomentum10 ? zMomentum10[n] : ((momentumNorm[n] - 50) / 20);
    const m20Z = zMomentum20 ? zMomentum20[n] : (momentum20Norm ? (momentum20Norm[n] - 50) / 20 : m10Z);
    const mkZ = zMarkov ? zMarkov[n] : ((markovNorm[n] - 50) / 20);
    const cycZ = zCycle ? zCycle[n] : ((cycleNorm[n] - 50) / 20);

    const rawZ = wFreq * fZ + wM10 * m10Z + wM20 * m20Z + wMarkov * mkZ + wCycle * cycZ;
    const displayScore = Number(Math.min(99, Math.max(15, 55 + rawZ * 16)).toFixed(2));
    const confidence = Math.min(96, Math.max(50, Math.round(62 + rawZ * 12)));
    const cInfo = notes[n] || { note: 'Cân bằng', type: 'optimal' };

    ranked.push({
      number: n,
      rawZ,
      rawTotal: rawZ,
      totalScore: displayScore,
      confidence,
      freqScore: Number((freqNorm ? freqNorm[n] : 50).toFixed(1)),
      momentumScore: Number((momentumNorm ? momentumNorm[n] : 50).toFixed(1)),
      momentum20Score: Number((momentum20Norm ? momentum20Norm[n] : 50).toFixed(1)),
      markovScore: Number((markovNorm ? markovNorm[n] : 50).toFixed(1)),
      cycleScore: Number((cycleNorm ? cycleNorm[n] : 50).toFixed(1)),
      countAll: countAll[n],
      count20: count20 ? count20[n] : countAll[n],
      count10: count10[n],
      count5: count5[n],
      gap: currentGap[n],
      streak: currentStreak[n],
      statusNote: cInfo.note,
      statusType: cInfo.type
    });
  }

  ranked.sort((a, b) => b.rawZ - a.rawZ);
  return ranked;
}

/**
 * Score all 3,160 pairs directly and build:
 * - Bậc 2 (VIP #1): Highest-scoring pair (Best-with-Best Rearrangement Inequality)
 * - Top 4 Disjoint Song Thủ: 4 non-overlapping pairs (8 distinct numbers) to maximize P(>=1 win)
 * - Bậc 3, 4, 5: Zone-diversified combinations from ranked numbers
 */
export function buildLowTierPredictions(ranked, coMatrix, lastSet, totalDraws) {
  const scoreMap = new Map(ranked.map((r) => [r.number, r]));
  const zByNum = new Float64Array(81);
  for (const r of ranked) {
    zByNum[r.number] = r.rawZ !== undefined ? r.rawZ : (r.totalScore - 55) / 16;
  }

  // Score all 3,160 pairs directly using single Z-scores + smoothed co-occurrence lift + zone diversity
  const allPairs = [];
  const safeDraws = Math.max(1, totalDraws || 1);
  for (let a = 1; a <= 80; a++) {
    const zA = Math.floor((a - 1) / 10);
    for (let b = a + 1; b <= 80; b++) {
      const zB = Math.floor((b - 1) / 10);
      const coHits = coMatrix[a]?.[b] || 0;
      const pCo = (coHits + 30 * BASE_PAIR_P) / (safeDraws + 30);
      const coLift = Math.log(pCo / BASE_PAIR_P);
      const diffZone = zA !== zB ? 1 : 0;
      const pairScore = zByNum[a] + zByNum[b] + PAIR_CO_WEIGHT * coLift + PAIR_ZONE_WEIGHT * diffZone;
      allPairs.push({ a, b, pairScore, coHits, coLift, diffZone });
    }
  }
  allPairs.sort((x, y) => y.pairScore - x.pairScore);

  const vipPair = allPairs[0];
  const bestBac2 = [vipPair.a, vipPair.b];

  // Select Top 4 strictly DISJOINT pairs (8 distinct numbers) greedily Best-with-Best
  const pairs = [];
  const usedNums = new Set();
  for (const p of allPairs) {
    if (usedNums.has(p.a) || usedNums.has(p.b)) continue;
    usedNums.add(p.a);
    usedNums.add(p.b);

    const bothInLast = lastSet && lastSet.has(p.a) && lastSet.has(p.b);
    const anyInLast = lastSet && (lastSet.has(p.a) || lastSet.has(p.b));
    const synergyScore = Number(Math.min(99, Math.max(30, 58 + p.pairScore * 11)).toFixed(2));
    const liftPct = ((Math.exp(p.coLift) - 1) * 100).toFixed(0);
    const liftTag = p.coLift >= 0 ? `+${liftPct}% lift` : `${liftPct}% lift`;

    let pairNote = `Độc lập đa vùng · ${p.coHits} lần nổ chung (${liftTag})`;
    if (bothInLast) {
      pairNote = `Cặp rơi lại từ kỳ trước · ${p.coHits} lần chung`;
    } else if (anyInLast && p.diffZone) {
      pairNote = `1 bóng rơi + 1 kéo Markov · ${p.coHits} lần chung`;
    } else if (!p.diffZone) {
      pairNote = `Cùng đầu số hợp lực · ${p.coHits} lần chung`;
    }

    pairs.push({
      numbers: [p.a, p.b],
      synergyScore,
      rawPairScore: Number(p.pairScore.toFixed(3)),
      confidence: Math.min(96, Math.max(52, Math.round(60 + p.pairScore * 9))),
      coOccurrences: p.coHits,
      pairStatus: pairs.length === 0 ? 'hot' : 'optimal',
      pairNote
    });

    if (pairs.length >= 4) break;
  }

  // Helper for zone-diversified selection for Bậc 3, 4, 5
  const pickZoneDiversified = (count) => {
    const out = [];
    const seenZones = new Set();
    for (const item of ranked) {
      if (out.length >= count) break;
      const zone = Math.floor((item.number - 1) / 10);
      if (!seenZones.has(zone)) {
        out.push(item.number);
        seenZones.add(zone);
      }
    }
    for (const item of ranked) {
      if (out.length >= count) break;
      if (!out.includes(item.number)) out.push(item.number);
    }
    return out.sort((a, b) => a - b);
  };

  const bac3Nums = pickZoneDiversified(3);
  const bac4Nums = pickZoneDiversified(4);
  const bac5Nums = pickZoneDiversified(5);

  function summarizeTier(tierLevel, nums, prizeInfo) {
    const avgConf = Math.round(
      nums.reduce((acc, n) => acc + (scoreMap.get(n)?.confidence || 70), 0) / nums.length
    );
    return {
      tier: tierLevel,
      label: `Bậc ${tierLevel}`,
      numbers: nums,
      confidence: avgConf,
      prizeInfo
    };
  }

  return {
    bac2: summarizeTier(2, bestBac2, 'Trúng 2/2 nhận 90.000đ (x9 vốn · RTP lý thuyết 54.1%)'),
    bac3: summarizeTier(3, bac3Nums, 'Trúng 2/3 nhận 20k · 3/3 nhận 400k (RTP lý thuyết 83.3%)'),
    bac4: summarizeTier(4, bac4Nums, 'Trúng 2/4 hoàn 10k · 3/4 50k · 4/4 1.2M (RTP LT 79.6%)'),
    bac5: summarizeTier(5, bac5Nums, 'Trúng 3/5 20k · 4/5 150k · 5/5 4.4M (RTP LT 63.3%)'),
    topPairsBac2: pairs
  };
}

/**
 * Calculate Vietlott Keno payout for a 10,000 VND ticket on Bậc 2..5
 */
export function calculateKenoPrize(tier, hitCount) {
  if (tier === 2) {
    if (hitCount === 2) return 90000;
    return 0;
  }
  if (tier === 3) {
    if (hitCount === 3) return 400000;
    if (hitCount === 2) return 20000;
    return 0;
  }
  if (tier === 4) {
    if (hitCount === 4) return 1200000;
    if (hitCount === 3) return 50000;
    if (hitCount === 2) return 10000;
    return 0;
  }
  if (tier === 5) {
    if (hitCount === 5) return 4400000;
    if (hitCount === 4) return 150000;
    if (hitCount === 3) return 20000;
    return 0;
  }
  return 0;
}

/**
 * Predict Parity (Chẵn/Lẻ) and Size (Lớn/Nhỏ) based on top numbers & equilibrium
 */
export function predictParityAndSize(draws, topRanked) {
  if (draws.length === 0) {
    return {
      parityPick: 'Chẵn',
      parityConfidence: 60,
      parityReason: 'Đang thu thập dữ liệu',
      sizePick: 'Lớn',
      sizeConfidence: 60,
      sizeReason: 'Đang thu thập dữ liệu'
    };
  }

  const recent10 = draws.slice(-10);
  const top10Nums = topRanked.slice(0, 10).map((r) => r.number);
  const top10Even = top10Nums.filter((n) => n % 2 === 0).length;
  const top10Big = top10Nums.filter((n) => n > 40).length;

  const avgEvenAll = draws.reduce((s, d) => s + d.evenCount, 0) / draws.length;
  const avgBigAll = draws.reduce((s, d) => s + d.bigCount, 0) / draws.length;
  const avgEven10 = recent10.reduce((s, d) => s + d.evenCount, 0) / recent10.length;
  const avgBig10 = recent10.reduce((s, d) => s + d.bigCount, 0) / recent10.length;

  const lastDraw = draws[draws.length - 1];

  const evenSignal = (top10Even - 5) * 0.55 + (avgEvenAll - avgEven10) * 0.45;
  let parityPick = 'Cân Bằng / Hòa (9–11 số)';
  let parityConfidence = 68;
  let parityReason = `Tỷ lệ Chẵn/Lẻ trên mẫu ${draws.length} kỳ cân bằng (${avgEvenAll.toFixed(1)} Chẵn : ${(20 - avgEvenAll).toFixed(1)} Lẻ).`;

  if (evenSignal >= 0.4) {
    parityPick = 'Nghiêng CHẴN (11–13+ số)';
    parityConfidence = Math.min(89, Math.round(67 + evenSignal * 10));
    parityReason = `Top 10 số điểm cao có ${top10Even}/10 số Chẵn (kỳ trước ${lastDraw.evenCount} Chẵn - ${lastDraw.oddCount} Lẻ).`;
  } else if (evenSignal <= -0.4) {
    parityPick = 'Nghiêng LẺ (11–13+ số)';
    parityConfidence = Math.min(89, Math.round(67 + Math.abs(evenSignal) * 10));
    parityReason = `Top 10 số điểm cao có ${10 - top10Even}/10 số Lẻ (kỳ trước ${lastDraw.evenCount} Chẵn - ${lastDraw.oddCount} Lẻ).`;
  }

  const bigSignal = (top10Big - 5) * 0.55 + (avgBigAll - avgBig10) * 0.45;
  let sizePick = 'Cân Bằng Lớn/Nhỏ (9–11 số)';
  let sizeConfidence = 68;
  let sizeReason = `Phân bổ Lớn/Nhỏ trên mẫu ${draws.length} kỳ ổn định (${avgBigAll.toFixed(1)} Lớn : ${(20 - avgBigAll).toFixed(1)} Nhỏ).`;

  if (bigSignal >= 0.4) {
    sizePick = 'Nghiêng LỚN (41–80)';
    sizeConfidence = Math.min(89, Math.round(67 + bigSignal * 10));
    sizeReason = `Top 10 số điểm cao có ${top10Big}/10 số Lớn (kỳ trước ${lastDraw.bigCount} Lớn - ${lastDraw.smallCount} Nhỏ).`;
  } else if (bigSignal <= -0.4) {
    sizePick = 'Nghiêng NHỎ (01–40)';
    sizeConfidence = Math.min(89, Math.round(67 + Math.abs(bigSignal) * 10));
    sizeReason = `Top 10 số điểm cao có ${10 - top10Big}/10 số Nhỏ (kỳ trước ${lastDraw.bigCount} Lớn - ${lastDraw.smallCount} Nhỏ).`;
  }

  return {
    parityPick,
    parityConfidence,
    parityReason,
    sizePick,
    sizeConfidence,
    sizeReason
  };
}

/**
 * Run O(N) Incremental Walk-Forward Backtest across expanding history,
 * tracking Win Rates AND RTP (%) for Bậc 2 VIP #1, Disjoint Top-4 Pairs, and Bậc 3–5.
 */
export function runAdaptiveBacktestAndLearn(draws, customMode = 'adaptive') {
  const initWeights = { ...(MODE_WEIGHTS[customMode] || DEFAULT_WEIGHTS) };
  const isAdaptive = customMode === 'adaptive';

  if (draws.length <= MIN_WARMUP_DRAWS) {
    return {
      learnedWeights: initWeights,
      modelAccuracy: { freq: 25, momentum10: 25, markov: 25, cycle: 25 },
      backtestHistory: [],
      summary: {
        evaluatedDraws: 0,
        minSampleSize: draws.length,
        maxSampleSize: draws.length,
        bac2WinCount: 0,
        bac3WinCount: 0,
        bac4WinCount: 0,
        bac5WinCount: 0,
        bac2WinRate: 0,
        bac3WinRate: 0,
        bac4WinRate: 0,
        bac5WinRate: 0,
        bac2Rtp: 0,
        bac3Rtp: 0,
        bac4Rtp: 0,
        bac5Rtp: 0,
        top4AnyWinCount: 0,
        top4AnyWinRate: 0,
        top4TotalPairsWon: 0,
        top4Rtp: 0,
        avgTop5HitRate: 0,
        theoretical: THEORETICAL_KENO,
        last100: null
      }
    };
  }

  const tracker = createIncrementalTracker();
  for (let i = 0; i < MIN_WARMUP_DRAWS; i++) {
    pushDrawToTracker(tracker, draws[i]);
  }

  const startIdx = MIN_WARMUP_DRAWS;
  const evalCount = draws.length - startIdx;
  let weights = { ...initWeights };
  const modelHits = { freq: 0, momentum10: 0, markov: 0, cycle: 0 };

  let totalTop5Hits = 0;
  let bac2WinCount = 0;
  let bac3WinCount = 0;
  let bac4WinCount = 0;
  let bac5WinCount = 0;
  let bac2PrizeTotal = 0;
  let bac3PrizeTotal = 0;
  let bac4PrizeTotal = 0;
  let bac5PrizeTotal = 0;
  let top4AnyWinCount = 0;
  let top4TotalPairsWon = 0;
  let top4PrizeTotal = 0;

  const backtestHistory = [];

  for (let idx = startIdx; idx < draws.length; idx++) {
    const sampleSizeUsed = tracker.totalDraws;
    const actualDraw = draws[idx];
    const actualSet = new Set(actualDraw.numbers);
    const lastSet = new Set(draws[idx - 1].numbers);

    const sub = extractSubModelsFromTracker(tracker, false);
    const ranked = scoreNumbers(sub, weights);
    const lowTiers = buildLowTierPredictions(ranked, sub.coMatrix, lastSet, sampleSizeUsed);

    const top8Hits = (zArr) => {
      const indices = Array.from({ length: 80 }, (_, i) => i + 1);
      indices.sort((a, b) => zArr[b] - zArr[a]);
      let hits = 0;
      for (let i = 0; i < 8; i++) {
        if (actualSet.has(indices[i])) hits++;
      }
      return hits;
    };

    modelHits.freq += top8Hits(sub.zFreq);
    modelHits.momentum10 += top8Hits(sub.zMomentum10);
    modelHits.markov += top8Hits(sub.zMarkov);
    modelHits.cycle += top8Hits(sub.zCycle);

    // Online predictive Z-correlation weight adaptation (bounded around Markov anchor)
    if (isAdaptive) {
      const lr = 0.03;
      const zCorr = (zArr) => {
        let s = 0;
        for (let b = 1; b <= 80; b++) {
          s += zArr[b] * (actualSet.has(b) ? 0.75 : -0.25);
        }
        return s / 20;
      };
      weights.freq = Math.max(0.05, Math.min(0.20, weights.freq * Math.exp(lr * zCorr(sub.zFreq))));
      weights.momentum10 = Math.max(0.02, Math.min(0.15, weights.momentum10 * Math.exp(lr * zCorr(sub.zMomentum10))));
      weights.momentum20 = Math.max(0.02, Math.min(0.15, weights.momentum20 * Math.exp(lr * zCorr(sub.zMomentum20))));
      weights.markov = Math.max(0.60, Math.min(0.85, weights.markov * Math.exp(lr * zCorr(sub.zMarkov))));
      weights.cycle = Math.max(0.02, Math.min(0.12, weights.cycle * Math.exp(lr * zCorr(sub.zCycle))));

      const sumW = weights.freq + weights.momentum10 + weights.momentum20 + weights.markov + weights.cycle;
      weights.freq = Number((weights.freq / sumW).toFixed(3));
      weights.momentum10 = Number((weights.momentum10 / sumW).toFixed(3));
      weights.momentum20 = Number((weights.momentum20 / sumW).toFixed(3));
      weights.markov = Number((weights.markov / sumW).toFixed(3));
      weights.cycle = Number(Math.max(0, 1 - weights.freq - weights.momentum10 - weights.momentum20 - weights.markov).toFixed(3));
    }

    const hitBac2 = lowTiers.bac2.numbers.filter((n) => actualSet.has(n));
    const hitBac3 = lowTiers.bac3.numbers.filter((n) => actualSet.has(n));
    const hitBac4 = lowTiers.bac4.numbers.filter((n) => actualSet.has(n));
    const hitBac5 = lowTiers.bac5.numbers.filter((n) => actualSet.has(n));

    const prizeBac2 = calculateKenoPrize(2, hitBac2.length);
    const prizeBac3 = calculateKenoPrize(3, hitBac3.length);
    const prizeBac4 = calculateKenoPrize(4, hitBac4.length);
    const prizeBac5 = calculateKenoPrize(5, hitBac5.length);

    if (prizeBac2 > 0) bac2WinCount++;
    if (prizeBac3 > 0) bac3WinCount++;
    if (prizeBac4 > 0) bac4WinCount++;
    if (prizeBac5 > 0) bac5WinCount++;

    bac2PrizeTotal += prizeBac2;
    bac3PrizeTotal += prizeBac3;
    bac4PrizeTotal += prizeBac4;
    bac5PrizeTotal += prizeBac5;
    totalTop5Hits += hitBac5.length;

    // Reconcile Top 4 Disjoint Song Thủ portfolio (4 tickets * 10,000đ = 40,000đ)
    const top4Detail = lowTiers.topPairsBac2.map((p) => {
      const hits = p.numbers.filter((n) => actualSet.has(n));
      return {
        numbers: p.numbers,
        hits,
        hitCount: hits.length,
        won: hits.length === 2
      };
    });
    const top4WinsThisDraw = top4Detail.filter((p) => p.won).length;
    const top4PrizeThisDraw = top4WinsThisDraw * 90000;
    if (top4WinsThisDraw > 0) top4AnyWinCount++;
    top4TotalPairsWon += top4WinsThisDraw;
    top4PrizeTotal += top4PrizeThisDraw;

    backtestHistory.push({
      drawId: actualDraw.drawId,
      time: actualDraw.time,
      date: actualDraw.date,
      sampleSizeUsed,
      actualNumbers: actualDraw.numbers,
      bac2: {
        predicted: lowTiers.bac2.numbers,
        hits: hitBac2,
        hitCount: hitBac2.length,
        prize: prizeBac2
      },
      top4Pairs: {
        pairs: top4Detail,
        winCount: top4WinsThisDraw,
        wonAny: top4WinsThisDraw > 0,
        cost: 40000,
        prize: top4PrizeThisDraw
      },
      bac3: {
        predicted: lowTiers.bac3.numbers,
        hits: hitBac3,
        hitCount: hitBac3.length,
        prize: prizeBac3
      },
      bac4: {
        predicted: lowTiers.bac4.numbers,
        hits: hitBac4,
        hitCount: hitBac4.length,
        prize: prizeBac4
      },
      bac5: {
        predicted: lowTiers.bac5.numbers,
        hits: hitBac5,
        hitCount: hitBac5.length,
        prize: prizeBac5
      }
    });

    pushDrawToTracker(tracker, actualDraw);
  }

  // Last-100 draw window stats (newest 100 in chronological order = last 100 pushed)
  const last100Slice = backtestHistory.slice(-100);
  const l100N = last100Slice.length || 1;
  const l100B2Wins = last100Slice.filter((r) => r.bac2.prize > 0).length;
  const l100B2Prize = last100Slice.reduce((s, r) => s + r.bac2.prize, 0);
  const l100T4Any = last100Slice.filter((r) => r.top4Pairs.wonAny).length;
  const l100T4Prize = last100Slice.reduce((s, r) => s + r.top4Pairs.prize, 0);

  const totalSlots = evalCount * 8;
  const modelAccuracy = {
    freq: Number(((modelHits.freq / totalSlots) * 100).toFixed(1)),
    momentum10: Number(((modelHits.momentum10 / totalSlots) * 100).toFixed(1)),
    markov: Number(((modelHits.markov / totalSlots) * 100).toFixed(1)),
    cycle: Number(((modelHits.cycle / totalSlots) * 100).toFixed(1))
  };

  const singleTicketCost = evalCount * 10000;
  const top4TicketCost = evalCount * 40000;

  return {
    learnedWeights: weights,
    modelAccuracy,
    backtestHistory: backtestHistory.reverse(),
    summary: {
      evaluatedDraws: evalCount,
      minSampleSize: startIdx,
      maxSampleSize: draws.length - 1,
      nextPredictionSampleSize: draws.length,
      bac2WinCount,
      bac3WinCount,
      bac4WinCount,
      bac5WinCount,
      bac2WinRate: Number(((bac2WinCount / evalCount) * 100).toFixed(1)),
      bac3WinRate: Number(((bac3WinCount / evalCount) * 100).toFixed(1)),
      bac4WinRate: Number(((bac4WinCount / evalCount) * 100).toFixed(1)),
      bac5WinRate: Number(((bac5WinCount / evalCount) * 100).toFixed(1)),
      bac2Rtp: Number(((bac2PrizeTotal / singleTicketCost) * 100).toFixed(1)),
      bac3Rtp: Number(((bac3PrizeTotal / singleTicketCost) * 100).toFixed(1)),
      bac4Rtp: Number(((bac4PrizeTotal / singleTicketCost) * 100).toFixed(1)),
      bac5Rtp: Number(((bac5PrizeTotal / singleTicketCost) * 100).toFixed(1)),
      top4AnyWinCount,
      top4AnyWinRate: Number(((top4AnyWinCount / evalCount) * 100).toFixed(1)),
      top4TotalPairsWon,
      top4Rtp: Number(((top4PrizeTotal / top4TicketCost) * 100).toFixed(1)),
      avgTop5HitRate: Number(((totalTop5Hits / (evalCount * 5)) * 100).toFixed(1)),
      theoretical: THEORETICAL_KENO,
      last100: {
        evaluatedDraws: last100Slice.length,
        bac2WinRate: Number(((l100B2Wins / l100N) * 100).toFixed(1)),
        bac2Rtp: Number(((l100B2Prize / (l100N * 10000)) * 100).toFixed(1)),
        top4AnyWinRate: Number(((l100T4Any / l100N) * 100).toFixed(1)),
        top4Rtp: Number(((l100T4Prize / (l100N * 40000)) * 100).toFixed(1))
      }
    }
  };
}

/**
 * Full pipeline: Given all accumulated historical draws (sorted oldest -> newest, size N),
 * learns adaptive weights (or runs mode-specific walk-forward backtest),
 * scores all 3,160 pairs for Bậc 2 & Disjoint Top-4, and returns the complete analytics payload.
 */
export function analyzeAndPredictNextDraw(draws, customMode = 'adaptive') {
  const mode = MODE_WEIGHTS[customMode] ? customMode : 'adaptive';
  const learningResult = runAdaptiveBacktestAndLearn(draws, mode);
  const activeWeights = mode === 'adaptive' ? learningResult.learnedWeights : { ...MODE_WEIGHTS[mode] };

  const subModels = computeSubModels(draws);
  const rankedNumbers = scoreNumbers(subModels, activeWeights);
  const lastSet = draws.length > 0 ? new Set(draws[draws.length - 1].numbers) : new Set();
  const lowTiers = buildLowTierPredictions(
    rankedNumbers,
    subModels.coMatrix,
    lastSet,
    draws.length
  );
  const parityAndSize = predictParityAndSize(draws, rankedNumbers);

  const latestDraw = draws.length > 0 ? draws[draws.length - 1] : null;
  const nextDrawId = latestDraw ? String(latestDraw.drawNumber + 1) : '---';

  const allStats = [];
  for (let n = 1; n <= 80; n++) {
    const scoreObj = rankedNumbers.find((r) => r.number === n);
    const cInfo = subModels.coolingNotes[n];
    allStats.push({
      number: n,
      count10: subModels.count10[n],
      count20: subModels.count20[n],
      countAll: subModels.countAll[n],
      gap: subModels.currentGap[n],
      streak: subModels.currentStreak[n],
      statusNote: cInfo ? cInfo.note : '',
      statusType: cInfo ? cInfo.type : 'normal',
      totalScore: scoreObj ? scoreObj.totalScore : 50,
      confidence: scoreObj ? scoreObj.confidence : 50
    });
  }

  const hotNumbers = [...allStats]
    .sort((a, b) => b.countAll - a.countAll || b.count10 - a.count10)
    .slice(0, 10);
  const coldNumbers = [...allStats]
    .sort((a, b) => b.gap - a.gap || a.countAll - b.countAll)
    .slice(0, 10);
  const streakNumbers = [...allStats]
    .filter((x) => x.streak >= 2)
    .sort((a, b) => b.streak - a.streak || b.totalScore - a.totalScore)
    .slice(0, 10);

  const zones = subModels.zoneCounts.map((hitsInLast5, idx) => ({
    zoneIndex: idx + 1,
    range: `${String(idx * 10 + 1).padStart(2, '0')}–${String((idx + 1) * 10).padStart(2, '0')}`,
    hitsInLast5,
    avgPerDraw: Number((hitsInLast5 / Math.min(5, Math.max(1, draws.length))).toFixed(1))
  }));

  return {
    nextDrawId,
    latestDraw,
    totalHistoricalDraws: draws.length,
    mode,
    activeWeights,
    learnedWeights: learningResult.learnedWeights,
    modelAccuracy: learningResult.modelAccuracy,
    lowTiers,
    parityAndSize,
    top12Ranked: rankedNumbers.slice(0, 12),
    board80: allStats,
    hotNumbers,
    coldNumbers,
    streakNumbers,
    zones,
    backtestHistory: learningResult.backtestHistory,
    backtestSummary: learningResult.summary
  };
}
