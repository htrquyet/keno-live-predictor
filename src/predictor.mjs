/**
 * Vietlott Keno 80 Multi-Model Adaptive Prediction Engine (Hot-First Champion Engine)
 * Specialized for Low Tiers: Bậc 2, Bậc 3, Bậc 4, Bậc 5 + Disjoint Top-4 Hot Pairs + Parity/Size
 *
 * Chiến lược Cốt Lõi (Khôi phục & Tối ưu từ kiến trúc gốc Hot-First Champion):
 * 1. ƯU TIÊN TUYỆT ĐỐI SỐ HAY RA / DỄ RA:
 *    - Toàn bộ thuật toán tập trung vào nhóm số có tần suất nổ cao nhất toàn mẫu và phong độ gần đây (10 kỳ & 20 kỳ).
 *    - Tuyệt đối giữ vững số đang nổ, cầu bệt (streak >= 2: 92đ) và nhịp rơi vàng 0–2 kỳ (88–92đ).
 *    - Tự động chống loãng tần suất khi mẫu tích lũy vượt quá 300 kỳ bằng cách pha trộn tần suất 120 kỳ gần nhất (f120).
 *    - Lọc kiệt sức khi bóng nổ quá dày (>= 4/5 kỳ gần nhất) và loại bỏ lô gan dài ngày.
 * 2. BẬC 2 & DÀN 4 CẶP SONG THỦ ĐỘC LẬP TỪ TOP 8 SỐ NÓNG:
 *    - Bậc 2 (VIP #1): Bộ đôi dẫn đầu bảng điểm tổng hợp [Top 1, Top 2].
 *    - Dàn 4 Cặp Song Thủ: Ghép 4 cặp độc lập từ Top 8 số điểm cao nhất ([1-2], [3-4], [5-6], [7-8]) để tối đa hóa tỷ lệ trúng thực tế mỗi kỳ.
 * 3. BACKTEST LŨY TIẾN O(N) KÈM CHỈ SỐ RTP (%) THỰC TẾ:
 *    - Đối soát lũy tiến nhanh O(N) cho cả 4 chế độ chiến lược (Adaptive, Hot, Due, Markov).
 */

const BASE_PAIR_P = (20 * 19) / (80 * 79); // ~0.06012658 (380/6320)

const DEFAULT_WEIGHTS = {
  freq: 0.20,
  momentum10: 0.30,
  momentum20: 0.20,
  markov: 0.15,
  cycle: 0.15
};

const MODE_WEIGHTS = {
  adaptive: DEFAULT_WEIGHTS,
  hot: { freq: 0.15, momentum10: 0.40, momentum20: 0.25, markov: 0.10, cycle: 0.10 },
  due: { freq: 0.15, momentum10: 0.20, momentum20: 0.15, markov: 0.15, cycle: 0.35 },
  markov: { freq: 0.15, momentum10: 0.20, momentum20: 0.15, markov: 0.35, cycle: 0.15 }
};

const MIN_WARMUP_DRAWS = 10;

// Theoretical Keno benchmarks (uniform 20/80 draw, 10,000đ ticket)
export const THEORETICAL_KENO = {
  bac2WinRate: Number((BASE_PAIR_P * 100).toFixed(2)), // 6.01%
  bac2Rtp: Number((BASE_PAIR_P * 9 * 100).toFixed(1)), // 54.1%
  top4DisjointAnyWinRate: 22.3, // Exact inclusion-exclusion 22.26%
  top4DisjointRtp: 54.1,
  bac3WinRate: 15.26,
  bac3Rtp: 72.1,
  bac4WinRate: 25.89,
  bac4Rtp: 64.9,
  bac5WinRate: 8.39,
  bac5Rtp: 54.0
};

/**
 * Normalize an array of 81 items (index 1..80) into 0..100 scale
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
 * Compute effective frequency blending 120-draw window when totalDraws > 300 to prevent long-sample dilution
 */
function computeEffectiveFreq(countAllVal, count120Val, totalDraws) {
  const fBase = countAllVal / totalDraws;
  if (totalDraws <= 300) {
    return fBase;
  }
  const f120 = count120Val / Math.min(120, totalDraws);
  const alpha = Math.min(0.65, ((totalDraws - 300) / 180) * 0.65);
  return alpha * f120 + (1 - alpha) * fBase;
}

/**
 * Compute cycle rhythm score (exact calibrated Hot-First Champion scale)
 */
function computeCycleScore(gap, streak) {
  if (streak >= 2) return 92; // cầu bệt thông
  if (gap === 0) return 88; // bóng vừa nổ kỳ trước (repeat ball)
  if (gap === 1 || gap === 2) return 92; // nhịp rơi vàng 1-2 kỳ
  if (gap >= 3 && gap <= 6) return 65; // nhịp rơi trung bình
  if (gap >= 7 && gap <= 8) return 70; // nhịp chu kỳ lặp
  if (gap >= 9 && gap <= 11) return 40; // gan nhẹ
  return 20; // gan sâu
}

/**
 * Compute multi-model signals: Frequency, Momentum, Markov Transitions, and Cycle Rhythms
 * (Giữ vững số hay ra, cầu bệt và số phong độ cao - Không hạ nhiệt khi số nổ nhiều)
 */
export function computeSubModels(draws) {
  const totalDraws = draws.length;
  const countAll = new Array(81).fill(0);
  const count120 = new Array(81).fill(0);
  const count20 = new Array(81).fill(0);
  const count10 = new Array(81).fill(0);
  const count5 = new Array(81).fill(0);
  const currentGap = new Array(81).fill(totalDraws);
  const currentStreak = new Array(81).fill(0);

  const coMatrix = Array.from({ length: 81 }, () => new Array(81).fill(0));
  const trans1 = Array.from({ length: 81 }, () => new Array(81).fill(0));

  if (totalDraws === 0) {
    const emptyNotes = Array.from({ length: 81 }, () => ({ note: 'Mới', type: 'optimal' }));
    return {
      rawFreq: new Array(81).fill(0),
      rawMomentum: new Array(81).fill(0),
      rawMomentum20: new Array(81).fill(0),
      rawMarkov: new Array(81).fill(0),
      rawCycle: new Array(81).fill(50),
      freqNorm: new Array(81).fill(50),
      momentumNorm: new Array(81).fill(50),
      momentum20Norm: new Array(81).fill(50),
      markovNorm: new Array(81).fill(50),
      cycleNorm: new Array(81).fill(50),
      countAll,
      count20,
      count10,
      count5,
      currentGap,
      currentStreak,
      coMatrix,
      statusNotes: emptyNotes,
      coolingNotes: emptyNotes,
      zoneCounts: new Array(8).fill(0)
    };
  }

  const drawSets = draws.map((d) => new Set(d.numbers));
  const lastDraw = draws[totalDraws - 1];
  const lastNums = lastDraw.numbers;

  for (let idx = 0; idx < totalDraws; idx++) {
    const nums = draws[idx].numbers;
    const age = totalDraws - 1 - idx;

    for (let i = 0; i < nums.length; i++) {
      const a = nums[i];
      countAll[a]++;
      if (age < 120) count120[a]++;
      if (age < 20) count20[a]++;
      if (age < 10) count10[a]++;
      if (age < 5) count5[a]++;

      for (let j = i + 1; j < nums.length; j++) {
        const b = nums[j];
        coMatrix[a][b]++;
        coMatrix[b][a]++;
      }
    }

    if (idx > 0) {
      const prevNums = draws[idx - 1].numbers;
      for (const a of prevNums) {
        for (const b of nums) {
          trans1[a][b]++;
        }
      }
    }
  }

  for (let n = 1; n <= 80; n++) {
    for (let i = totalDraws - 1; i >= 0; i--) {
      if (drawSets[i].has(n)) {
        currentGap[n] = totalDraws - 1 - i;
        break;
      }
    }
    let st = 0;
    for (let i = totalDraws - 1; i >= 0; i--) {
      if (drawSets[i].has(n)) st++;
      else break;
    }
    currentStreak[n] = st;
  }

  const rawFreq = new Array(81).fill(0);
  const rawMomentum = new Array(81).fill(0);
  const rawMomentum20 = new Array(81).fill(0);
  const rawMarkov = new Array(81).fill(0);
  const rawCycle = new Array(81).fill(0);
  const statusNotes = Array.from({ length: 81 }, () => ({ note: '', type: 'optimal' }));

  for (let n = 1; n <= 80; n++) {
    const fAll = computeEffectiveFreq(countAll[n], count120[n], totalDraws);
    const f20 = count20[n] / Math.min(20, totalDraws);
    const f10 = count10[n] / Math.min(10, totalDraws);

    let mkHits = 0;
    for (const a of lastNums) {
      mkHits += trans1[a][n];
    }
    const mNorm = mkHits / Math.max(1, totalDraws * 20);

    const g = currentGap[n];
    const st = currentStreak[n];
    const c5 = count5[n];

    let note = `Số hay ra (${countAll[n]}/${totalDraws}k)`;
    let noteType = 'optimal';

    if (st >= 2) {
      note = `Cầu bệt thông (${st} kỳ liên tiếp · nổ ${countAll[n]}/${totalDraws}k)`;
      noteType = 'hot';
    } else if (g === 0) {
      note = `Vừa nổ kỳ trước (${c5}/5 kỳ gần nhất · nổ ${countAll[n]}/${totalDraws}k)`;
      noteType = 'hot';
    } else if (g >= 1 && g <= 4 && fAll >= 0.25) {
      note = `Số nóng nhịp rơi đẹp (cách ${g}k · nổ ${countAll[n]}/${totalDraws}k)`;
      noteType = 'hot';
    } else if (g >= 1 && g <= 4) {
      note = `Nhịp rơi đều (cách ${g}k · nổ ${countAll[n]}/${totalDraws}k)`;
      noteType = 'optimal';
    } else if (g >= 8) {
      note = `Lô gan (cách ${g} kỳ) - Thấp`;
      noteType = 'cold';
    } else if (fAll < 0.20) {
      note = `Tần suất thấp (${countAll[n]}/${totalDraws}k)`;
      noteType = 'cold';
    }

    statusNotes[n] = { note, type: noteType };

    rawFreq[n] = fAll * 100;
    rawMomentum[n] = f10 * 100;
    rawMomentum20[n] = f20 * 100;
    rawMarkov[n] = mNorm * 100;
    rawCycle[n] = computeCycleScore(g, st);
  }

  // Phân bổ 8 vùng đầu số
  const recentWindow = Math.min(5, totalDraws);
  const zoneCounts = new Array(8).fill(0);
  for (let idx = totalDraws - recentWindow; idx < totalDraws; idx++) {
    if (idx < 0) continue;
    for (const num of draws[idx].numbers) {
      const z = Math.min(7, Math.floor((num - 1) / 10));
      zoneCounts[z]++;
    }
  }

  return {
    rawFreq,
    rawMomentum,
    rawMomentum20,
    rawMarkov,
    rawCycle,
    freqNorm: normalize80(rawFreq),
    momentumNorm: normalize80(rawMomentum),
    momentum20Norm: normalize80(rawMomentum20),
    markovNorm: normalize80(rawMarkov),
    cycleNorm: normalize80(rawCycle),
    countAll,
    count20,
    count10,
    count5,
    currentGap,
    currentStreak,
    coMatrix,
    statusNotes,
    coolingNotes: statusNotes,
    zoneCounts
  };
}

/**
 * Score all 80 numbers prioritizing hot, high-frequency numbers
 */
export function scoreNumbers(subModels, weights = DEFAULT_WEIGHTS) {
  const {
    rawFreq,
    rawMomentum,
    rawMomentum20,
    rawMarkov,
    rawCycle,
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
    statusNotes
  } = subModels;

  const notes = statusNotes || subModels.coolingNotes || [];
  const ranked = [];

  const wFreq = weights.freq ?? 0.20;
  const wM10 = weights.momentum10 ?? 0.30;
  const wM20 = weights.momentum20 ?? 0.20;
  const wMarkov = weights.markov ?? 0.15;
  const wCycle = weights.cycle ?? 0.15;

  for (let n = 1; n <= 80; n++) {
    const fVal = rawFreq ? rawFreq[n] : freqNorm[n];
    const mVal = rawMomentum ? rawMomentum[n] : momentumNorm[n];
    const m20Val = rawMomentum20 ? rawMomentum20[n] : (momentum20Norm ? momentum20Norm[n] : mVal);
    const mkVal = rawMarkov ? rawMarkov[n] : markovNorm[n];
    const cycVal = rawCycle ? rawCycle[n] : cycleNorm[n];
    const c5 = count5[n];
    const g = currentGap[n];

    // Bộ lọc chống quá tải / kiệt sức (khi bóng nổ >= 4 lần trong 5 kỳ gần nhất)
    let fatigueMult = 1.0;
    if (c5 >= 4) fatigueMult = 0.55;
    else if (c5 === 3 && g === 0) fatigueMult = 0.82;

    const rawTotal = (
      wFreq * fVal +
      wM10 * mVal +
      wM20 * m20Val +
      wMarkov * mkVal +
      wCycle * cycVal
    ) * fatigueMult;

    // Chuẩn hóa điểm hiển thị trực quan (thang 0 - 100)
    const displayScore = Number(Math.min(99, Math.max(20, (rawTotal / 45) * 100)).toFixed(2));
    const confidence = Math.min(96, Math.max(50, Math.round(55 + (rawTotal / 45) * 38)));

    const cInfo = notes[n] || { note: 'Số hay ra', type: 'optimal' };

    ranked.push({
      number: n,
      rawTotal,
      totalScore: displayScore,
      confidence,
      freqScore: Number(fVal.toFixed(1)),
      momentumScore: Number(mVal.toFixed(1)),
      momentum20Score: Number(m20Val.toFixed(1)),
      markovScore: Number(mkVal.toFixed(1)),
      cycleScore: Number(cycVal.toFixed(1)),
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

  ranked.sort((a, b) => b.rawTotal - a.rawTotal);
  return ranked;
}

/**
 * Build optimal Bậc 2, 3, 4, 5 combinations + Disjoint Top-4 Song Thủ Pairs from Top 8 Hot Numbers
 */
export function buildLowTierPredictions(ranked, coMatrix, lastSet, totalDraws) {
  const scoreMap = new Map(ranked.map((r) => [r.number, r]));

  // 1. Primary Bậc 2 (VIP #1): Bộ đôi dẫn đầu bảng điểm tổng hợp [Top 1, Top 2]
  const bestBac2 = [ranked[0].number, ranked[1].number].sort((a, b) => a - b);

  // 2. Dàn 4 Cặp Song Thủ Bậc 2 Độc Lập từ Top 8 số nóng nhất ([0,1], [2,3], [4,5], [6,7])
  const pairConfigs = [
    { idxA: 0, idxB: 1, label: 'Song Thủ VIP #1', desc: 'Bộ đôi dẫn đầu bảng điểm (Hạng #1 + #2)' },
    { idxA: 2, idxB: 3, label: 'Song Thủ VIP #2', desc: 'Cặp song thủ phong độ cao (Hạng #3 + #4)' },
    { idxA: 4, idxB: 5, label: 'Song Thủ VIP #3', desc: 'Cặp nhịp rơi vàng bọc lót (Hạng #5 + #6)' },
    { idxA: 6, idxB: 7, label: 'Song Thủ VIP #4', desc: 'Cặp đối ứng đa vùng (Hạng #7 + #8)' }
  ];

  const pairs = [];
  for (const pc of pairConfigs) {
    const a = ranked[pc.idxA];
    const b = ranked[pc.idxB];
    if (!a || !b) continue;

    const sortedNums = [a.number, b.number].sort((x, y) => x - y);
    const coHits = coMatrix[sortedNums[0]]?.[sortedNums[1]] || 0;
    const bothInLast = lastSet && lastSet.has(sortedNums[0]) && lastSet.has(sortedNums[1]);
    const coBonus = 1.0 + (totalDraws > 0 ? (coHits / totalDraws) * 1.5 : 0);
    const avgScore = (a.totalScore + b.totalScore) / 2;
    const synergyScore = Number((avgScore * coBonus).toFixed(2));

    let pairNote = `${pc.desc} · ${coHits} lần nổ chung`;
    if (bothInLast) {
      pairNote = `Cặp vừa cùng nổ kỳ trước · ${coHits} lần toàn mẫu`;
    }

    pairs.push({
      label: pc.label,
      numbers: sortedNums,
      synergyScore,
      confidence: Math.min(96, Math.max(50, Math.round(52 + synergyScore * 0.44))),
      coOccurrences: coHits,
      pairStatus: 'hot',
      pairNote
    });
  }

  // Helper to pick multi-zone combinations starting from Top 1 anchor
  function pickMultiZone(count) {
    const out = [ranked[0].number];
    const zSet = new Set([Math.floor((ranked[0].number - 1) / 10)]);
    for (const item of ranked.slice(1)) {
      if (out.length >= count) break;
      const zone = Math.floor((item.number - 1) / 10);
      if (!zSet.has(zone)) {
        out.push(item.number);
        zSet.add(zone);
      }
    }
    while (out.length < count) {
      for (const item of ranked) {
        if (!out.includes(item.number)) {
          out.push(item.number);
          break;
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  const bac3Nums = pickMultiZone(3);
  const bac4Nums = pickMultiZone(4);
  const bac5Nums = pickMultiZone(5);

  function summarizeTier(tierLevel, nums, prizeInfo) {
    const avgConf = Math.round(
      nums.reduce((acc, n) => acc + (scoreMap.get(n)?.confidence || 75), 0) / nums.length
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
    bac2: summarizeTier(2, bestBac2, 'Trúng 2/2 số nhận 90.000đ (x9 vốn · Hòa vốn: 11.1% · Chuẩn Keno: 6.01%)'),
    bac3: summarizeTier(3, bac3Nums, 'Trúng 2/3 nhận 20.000đ · Trúng 3/3 nhận 400.000đ'),
    bac4: summarizeTier(4, bac4Nums, 'Trúng 2/4 hoàn vốn · 3/4 nhận 50k · 4/4 nhận 1.200.000đ'),
    bac5: summarizeTier(5, bac5Nums, 'Trúng 3/5 nhận 20k · 4/5 nhận 150k · 5/5 nhận 4.400.000đ'),
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
 * Predict Parity (Chẵn / Lẻ / Hòa 10-10) and Size (Lớn / Nhỏ / Hòa 10-10)
 * using calibrated Hot-Ball Top-K composition + Multi-Window Non-Tie Regime + Tie (10-10) Cycle Detector.
 */
export function predictParityAndSize(draws, topRanked = [], fastCounts = null) {
  const N = draws.length;
  if (N === 0) {
    return {
      paritySide: 'EVEN',
      parityPick: 'CHẴN CHỦ ĐẠO (≥11 số)',
      parityComboPick: 'Chẵn 11–12 + Bọc Hòa (10–10)',
      parityTieStatus: 'Đang thu thập dữ liệu',
      parityTieAlert: false,
      parityConfidence: 60,
      parityReason: 'Đang thu thập dữ liệu',
      sizeSide: 'BIG',
      sizePick: 'LỚN CHỦ ĐẠO (≥11 số)',
      sizeComboPick: 'Lớn (≥11) + Bọc Hòa (10–10)',
      sizeTieStatus: 'Đang thu thập dữ liệu',
      sizeTieAlert: false,
      sizeConfidence: 60,
      sizeReason: 'Đang thu thập dữ liệu'
    };
  }

  // 1. Compute pure hot-frequency ball ranking (without fatigue penalty so macro wave is preserved)
  let cAll = fastCounts?.countAll;
  let c20 = fastCounts?.count20;
  let c10 = fastCounts?.count10;
  if (!cAll || !c20 || !c10) {
    cAll = new Int32Array(81);
    c20 = new Int32Array(81);
    c10 = new Int32Array(81);
    for (let i = 0; i < N; i++) {
      const age = N - 1 - i;
      for (const x of draws[i].numbers) {
        cAll[x]++;
        if (age < 20) c20[x]++;
        if (age < 10) c10[x]++;
      }
    }
  }

  const ballScores = [];
  const d20 = Math.min(20, N);
  const d10 = Math.min(10, N);
  for (let n = 1; n <= 80; n++) {
    const sc = (cAll[n] / N) * 30 + (c20[n] / d20) * 35 + (c10[n] / d10) * 35;
    ballScores.push({ n, sc });
  }
  ballScores.sort((a, b) => b.sc - a.sc);

  const top20Even = ballScores.slice(0, 20).filter((x) => x.n % 2 === 0).length;
  const top24Big = ballScores.slice(0, 24).filter((x) => x.n > 40).length;
  const top20EvenRatio = top20Even / 20;
  const top24BigRatio = top24Big / 24;

  // 2. Multi-window non-tie regime rates: W=60 & W=15 for Parity; W=50 for Size
  let e60 = 0, o60 = 0, e15 = 0, o15 = 0;
  let b50 = 0, sm50 = 0;
  let tieParityAll = 0, tieSizeAll = 0;
  let parityTieGap = -1, sizeTieGap = -1;

  for (let i = N - 1; i >= 0; i--) {
    const age = N - 1 - i;
    const ev = draws[i].evenCount;
    const bg = draws[i].bigCount;

    if (ev === 10) {
      tieParityAll++;
      if (parityTieGap === -1) parityTieGap = age;
    } else if (ev >= 11) {
      if (age < 60) e60++;
      if (age < 15) e15++;
    } else {
      if (age < 60) o60++;
      if (age < 15) o15++;
    }

    if (bg === 10) {
      tieSizeAll++;
      if (sizeTieGap === -1) sizeTieGap = age;
    } else if (bg >= 11) {
      if (age < 50) b50++;
    } else {
      if (age < 50) sm50++;
    }
  }
  if (parityTieGap === -1) parityTieGap = N;
  if (sizeTieGap === -1) sizeTieGap = N;

  // Parity ensemble score (K=20 wBall=0.45 + W60(0.70)/W15(0.30) wRegime=0.55)
  const regPE = 0.70 * (e60 / (e60 + o60 || 1)) + 0.30 * (e15 / (e15 + o15 || 1));
  const regPO = 1 - regPE;
  const scoreEven = 0.55 * regPE + 0.45 * top20EvenRatio;
  const scoreOdd = 0.55 * regPO + 0.45 * (1 - top20EvenRatio);
  const parityDiff = Math.abs(scoreEven - scoreOdd);

  const paritySide = scoreEven >= scoreOdd ? 'EVEN' : 'ODD';
  const parityConfidence = Math.min(92, Math.max(62, Math.round(64 + parityDiff * 110)));
  const parityTieRate = Number(((tieParityAll / N) * 100).toFixed(1));
  const parityTieAlert = (parityTieGap >= 4 && parityDiff <= 0.045) || parityTieGap >= 8;

  const lastDraw = draws[N - 1];
  const strongParitySurge =
    (paritySide === 'EVEN' && top20Even >= 13 && e15 > o15) ||
    (paritySide === 'ODD' && top20Even <= 7 && o15 > e15);

  const parityPick =
    paritySide === 'EVEN'
      ? `CHẴN CHỦ ĐẠO (${strongParitySurge ? 'Mạnh Chẵn ≥13 & ' : ''}Chẵn 11–12)`
      : `LẺ CHỦ ĐẠO (${strongParitySurge ? 'Mạnh Lẻ ≥13 & ' : ''}Lẻ 11–12)`;

  const parityComboPick =
    paritySide === 'EVEN'
      ? 'Vé tối ưu: Chẵn 11–12 + Bọc Hòa (10–10) (ăn x2)'
      : 'Vé tối ưu: Lẻ 11–12 + Bọc Hòa (10–10) (ăn x2)';

  const parityTieStatus = parityTieAlert
    ? `⚖️ BÁO ĐỘNG CẦU HÒA (10–10) CAO · Đã gan ${parityTieGap} kỳ (TB nổ ${parityTieRate}%)`
    : `Cửa Hòa (10–10): Cách ${parityTieGap} kỳ · Tần suất ${parityTieRate}%`;

  const parityReason =
    paritySide === 'EVEN'
      ? `Top 20 bóng nóng có ${top20Even}/20 số Chẵn; nhịp 60 kỳ Chẵn thắng ${e60}:${o60} (kỳ trước ${lastDraw.evenCount} Chẵn - ${lastDraw.oddCount} Lẻ).`
      : `Top 20 bóng nóng có ${20 - top20Even}/20 số Lẻ; nhịp 60 kỳ Lẻ thắng ${o60}:${e60} (kỳ trước ${lastDraw.evenCount} Chẵn - ${lastDraw.oddCount} Lẻ).`;

  // Size ensemble score (K=24 wBall=0.50 + W50 wRegime=0.50)
  const regSB = b50 / (b50 + sm50 || 1);
  const regSS = 1 - regSB;
  const scoreBig = 0.50 * regSB + 0.50 * top24BigRatio;
  const scoreSmall = 0.50 * regSS + 0.50 * (1 - top24BigRatio);
  const sizeDiff = Math.abs(scoreBig - scoreSmall);

  const sizeSide = scoreBig >= scoreSmall ? 'BIG' : 'SMALL';
  const sizeConfidence = Math.min(92, Math.max(62, Math.round(64 + sizeDiff * 110)));
  const sizeTieRate = Number(((tieSizeAll / N) * 100).toFixed(1));
  const sizeTieAlert = (sizeTieGap >= 4 && sizeDiff <= 0.045) || sizeTieGap >= 8;

  const strongSizeSurge =
    (sizeSide === 'BIG' && top24Big >= 15 && b50 > sm50) ||
    (sizeSide === 'SMALL' && top24Big <= 9 && sm50 > b50);

  const sizePick =
    sizeSide === 'BIG'
      ? `LỚN CHỦ ĐẠO 41–80 (${strongSizeSurge ? 'Mạnh Lớn ≥13 & ' : ''}Lớn 11–12)`
      : `NHỎ CHỦ ĐẠO 01–40 (${strongSizeSurge ? 'Mạnh Nhỏ ≥13 & ' : ''}Nhỏ 11–12)`;

  const sizeComboPick =
    sizeSide === 'BIG'
      ? 'Cửa bọc an toàn: Lớn (≥11) + Bọc Hòa (10–10)'
      : 'Cửa bọc an toàn: Nhỏ (≥11) + Bọc Hòa (10–10)';

  const sizeTieStatus = sizeTieAlert
    ? `⚖️ BÁO ĐỘNG HÒA LỚN NHỎ (10–10) CAO · Đã gan ${sizeTieGap} kỳ (TB ${sizeTieRate}%)`
    : `Hòa Lớn Nhỏ (10–10): Cách ${sizeTieGap} kỳ · Tần suất ${sizeTieRate}%`;

  const sizeReason =
    sizeSide === 'BIG'
      ? `Top 24 bóng nóng có ${top24Big}/24 số Lớn (41–80); nhịp 50 kỳ Lớn thắng ${b50}:${sm50} (kỳ trước ${lastDraw.bigCount} Lớn - ${lastDraw.smallCount} Nhỏ).`
      : `Top 24 bóng nóng có ${24 - top24Big}/24 số Nhỏ (01–40); nhịp 50 kỳ Nhỏ thắng ${sm50}:${b50} (kỳ trước ${lastDraw.bigCount} Lớn - ${lastDraw.smallCount} Nhỏ).`;

  return {
    paritySide,
    parityPick,
    parityComboPick,
    parityTieStatus,
    parityTieAlert,
    parityConfidence,
    parityReason,
    sizeSide,
    sizePick,
    sizeComboPick,
    sizeTieStatus,
    sizeTieAlert,
    sizeConfidence,
    sizeReason
  };
}

/**
 * Run O(N) Incremental Walk-Forward Backtest across expanding history using Hot-First Champion Engine,
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
        parityExactWinCount: 0,
        parityExactWinRate: 0,
        parityCoverWinCount: 0,
        parityCoverWinRate: 0,
        parity2DoorWinCount: 0,
        parity2DoorWinRate: 0,
        parity2DoorRtp: 0,
        sizeExactWinCount: 0,
        sizeExactWinRate: 0,
        sizeCoverWinCount: 0,
        sizeCoverWinRate: 0,
        avgTop5HitRate: 0,
        theoretical: THEORETICAL_KENO,
        last100: null
      }
    };
  }

  const N = draws.length;
  const countAll = new Int32Array(81);
  const count120 = new Int32Array(81);
  const count20 = new Int32Array(81);
  const count10 = new Int32Array(81);
  const count5 = new Int32Array(81);
  const currentGap = new Int32Array(81);
  const currentStreak = new Int32Array(81);
  const coMatrix = Array.from({ length: 81 }, () => new Int32Array(81));
  const trans1 = Array.from({ length: 81 }, () => new Int32Array(81));

  function addDrawToTracker(idx) {
    const nums = draws[idx].numbers;
    const set = new Set(nums);
    for (let i = 0; i < nums.length; i++) {
      const a = nums[i];
      countAll[a]++;
      count120[a]++;
      count20[a]++;
      count10[a]++;
      count5[a]++;
      for (let j = i + 1; j < nums.length; j++) {
        const b = nums[j];
        coMatrix[a][b]++;
        coMatrix[b][a]++;
      }
    }
    if (idx >= 5) for (const x of draws[idx - 5].numbers) count5[x]--;
    if (idx >= 10) for (const x of draws[idx - 10].numbers) count10[x]--;
    if (idx >= 20) for (const x of draws[idx - 20].numbers) count20[x]--;
    if (idx >= 120) for (const x of draws[idx - 120].numbers) count120[x]--;

    if (idx > 0) {
      const prevNums = draws[idx - 1].numbers;
      for (const a of prevNums) {
        for (const b of nums) {
          trans1[a][b]++;
        }
      }
    }

    for (let n = 1; n <= 80; n++) {
      if (set.has(n)) {
        currentGap[n] = 0;
        currentStreak[n]++;
      } else {
        currentGap[n] = idx === 0 ? 1 : currentGap[n] + 1;
        currentStreak[n] = 0;
      }
    }
  }

  for (let i = 0; i < MIN_WARMUP_DRAWS; i++) {
    addDrawToTracker(i);
  }

  const startIdx = MIN_WARMUP_DRAWS;
  const evalCount = N - startIdx;
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
  let parityExactWinCount = 0;
  let parityCoverWinCount = 0;
  let parity2DoorWinCount = 0;
  let sizeExactWinCount = 0;
  let sizeCoverWinCount = 0;

  const backtestHistory = [];

  for (let idx = startIdx; idx < N; idx++) {
    const sampleSizeUsed = idx;
    const actualDraw = draws[idx];
    const actualSet = new Set(actualDraw.numbers);
    const lastNums = draws[idx - 1].numbers;
    const lastSet = new Set(lastNums);

    const rawFreq = new Array(81).fill(0);
    const rawMomentum = new Array(81).fill(0);
    const rawMomentum20 = new Array(81).fill(0);
    const rawMarkov = new Array(81).fill(0);
    const rawCycle = new Array(81).fill(0);

    for (let n = 1; n <= 80; n++) {
      const fAll = computeEffectiveFreq(countAll[n], count120[n], sampleSizeUsed);
      const f20 = count20[n] / Math.min(20, sampleSizeUsed);
      const f10 = count10[n] / Math.min(10, sampleSizeUsed);

      let mkHits = 0;
      for (const a of lastNums) {
        mkHits += trans1[a][n];
      }
      const mNorm = mkHits / Math.max(1, sampleSizeUsed * 20);

      rawFreq[n] = fAll * 100;
      rawMomentum[n] = f10 * 100;
      rawMomentum20[n] = f20 * 100;
      rawMarkov[n] = mNorm * 100;
      rawCycle[n] = computeCycleScore(currentGap[n], currentStreak[n]);
    }

    const freqNorm = normalize80(rawFreq);
    const momentumNorm = normalize80(rawMomentum);
    const markovNorm = normalize80(rawMarkov);
    const cycleNorm = normalize80(rawCycle);

    const sub = {
      rawFreq,
      rawMomentum,
      rawMomentum20,
      rawMarkov,
      rawCycle,
      freqNorm,
      momentumNorm,
      markovNorm,
      cycleNorm,
      countAll,
      count20,
      count10,
      count5,
      currentGap,
      currentStreak
    };

    const ranked = scoreNumbers(sub, weights);
    const lowTiers = buildLowTierPredictions(ranked, coMatrix, lastSet, sampleSizeUsed);

    const topByModel = (arr) => {
      const indices = Array.from({ length: 80 }, (_, i) => i + 1);
      indices.sort((a, b) => arr[b] - arr[a]);
      return indices.slice(0, 8);
    };

    const fHits = topByModel(freqNorm).filter((n) => actualSet.has(n)).length;
    const mHits = topByModel(momentumNorm).filter((n) => actualSet.has(n)).length;
    const mkHits = topByModel(markovNorm).filter((n) => actualSet.has(n)).length;
    const cycHits = topByModel(cycleNorm).filter((n) => actualSet.has(n)).length;

    modelHits.freq += fHits;
    modelHits.momentum10 += mHits;
    modelHits.markov += mkHits;
    modelHits.cycle += cycHits;

    // Multiplicative Weights Update (Hot-First Champion Learning)
    if (isAdaptive) {
      const lr = 0.03;
      weights.freq *= Math.exp(lr * (fHits - 2.0));
      weights.momentum10 *= Math.exp(lr * (mHits - 2.0));
      weights.markov *= Math.exp(lr * (mkHits - 2.0));
      weights.cycle *= Math.exp(lr * (cycHits - 2.0));

      const sumW = weights.freq + weights.momentum10 + (weights.momentum20 || 0.20) + weights.markov + weights.cycle;
      weights.freq = Math.max(0.10, Math.min(0.28, weights.freq / sumW));
      weights.momentum10 = Math.max(0.20, Math.min(0.38, weights.momentum10 / sumW));
      weights.momentum20 = 0.20;
      weights.markov = Math.max(0.10, Math.min(0.25, weights.markov / sumW));
      weights.cycle = Math.max(0.10, Math.min(0.25, weights.cycle / sumW));
      const sumW2 = weights.freq + weights.momentum10 + weights.momentum20 + weights.markov + weights.cycle;
      weights.freq = Number((weights.freq / sumW2).toFixed(3));
      weights.momentum10 = Number((weights.momentum10 / sumW2).toFixed(3));
      weights.momentum20 = Number((weights.momentum20 / sumW2).toFixed(3));
      weights.markov = Number((weights.markov / sumW2).toFixed(3));
      weights.cycle = Number((1 - weights.freq - weights.momentum10 - weights.momentum20 - weights.markov).toFixed(3));
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

    // Reconcile Parity (Chẵn/Lẻ/Hòa) & Size (Lớn/Nhỏ/Hòa)
    const pBallScores = [];
    const d20 = Math.min(20, sampleSizeUsed);
    const d10 = Math.min(10, sampleSizeUsed);
    for (let n = 1; n <= 80; n++) {
      const sc = (countAll[n] / sampleSizeUsed) * 30 + (count20[n] / d20) * 35 + (count10[n] / d10) * 35;
      pBallScores.push({ n, sc });
    }
    pBallScores.sort((a, b) => b.sc - a.sc);
    const top20EvenRatio = pBallScores.slice(0, 20).filter((x) => x.n % 2 === 0).length / 20;
    const top24BigRatio = pBallScores.slice(0, 24).filter((x) => x.n > 40).length / 24;

    let e60 = 0, o60 = 0, e15 = 0, o15 = 0, b50 = 0, sm50 = 0;
    const lookbackStart = Math.max(0, idx - 60);
    for (let k = idx - 1; k >= lookbackStart; k--) {
      const age = idx - 1 - k;
      const ev = draws[k].evenCount;
      const bg = draws[k].bigCount;
      if (ev >= 11) {
        if (age < 60) e60++;
        if (age < 15) e15++;
      } else if (ev <= 9) {
        if (age < 60) o60++;
        if (age < 15) o15++;
      }
      if (age < 50) {
        if (bg >= 11) b50++;
        else if (bg <= 9) sm50++;
      }
    }
    const regPE = 0.70 * (e60 / (e60 + o60 || 1)) + 0.30 * (e15 / (e15 + o15 || 1));
    const scoreEven = 0.55 * regPE + 0.45 * top20EvenRatio;
    const scoreOdd = 0.55 * (1 - regPE) + 0.45 * (1 - top20EvenRatio);
    const predParitySide = scoreEven >= scoreOdd ? 'EVEN' : 'ODD';

    const regSB = b50 / (b50 + sm50 || 1);
    const scoreBig = 0.50 * regSB + 0.50 * top24BigRatio;
    const scoreSmall = 0.50 * (1 - regSB) + 0.50 * (1 - top24BigRatio);
    const predSizeSide = scoreBig >= scoreSmall ? 'BIG' : 'SMALL';

    const actualParityState = actualDraw.evenCount >= 11 ? 'EVEN' : actualDraw.evenCount === 10 ? 'TIE' : 'ODD';
    const actualSizeState = actualDraw.bigCount >= 11 ? 'BIG' : actualDraw.bigCount === 10 ? 'TIE' : 'SMALL';

    const parityExactWon = predParitySide === actualParityState;
    const parityCoverWon = parityExactWon || actualParityState === 'TIE';
    const parity2DoorWon =
      (predParitySide === 'EVEN' && (actualDraw.evenCount === 10 || actualDraw.evenCount === 11 || actualDraw.evenCount === 12)) ||
      (predParitySide === 'ODD' && (actualDraw.evenCount === 10 || actualDraw.evenCount === 9 || actualDraw.evenCount === 8));

    const sizeExactWon = predSizeSide === actualSizeState;
    const sizeCoverWon = sizeExactWon || actualSizeState === 'TIE';

    if (parityExactWon) parityExactWinCount++;
    if (parityCoverWon) parityCoverWinCount++;
    if (parity2DoorWon) parity2DoorWinCount++;
    if (sizeExactWon) sizeExactWinCount++;
    if (sizeCoverWon) sizeCoverWinCount++;

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
      },
      paritySize: {
        predParitySide,
        actualParityState,
        evenCount: actualDraw.evenCount,
        parityExactWon,
        parityCoverWon,
        parity2DoorWon,
        predSizeSide,
        actualSizeState,
        bigCount: actualDraw.bigCount,
        sizeExactWon,
        sizeCoverWon
      }
    });

    addDrawToTracker(idx);
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
      parityExactWinCount,
      parityExactWinRate: Number(((parityExactWinCount / evalCount) * 100).toFixed(1)),
      parityCoverWinCount,
      parityCoverWinRate: Number(((parityCoverWinCount / evalCount) * 100).toFixed(1)),
      parity2DoorWinCount,
      parity2DoorWinRate: Number(((parity2DoorWinCount / evalCount) * 100).toFixed(1)),
      parity2DoorRtp: Number((((parity2DoorWinCount * 20000) / (evalCount * 20000)) * 2 * 100).toFixed(1)),
      sizeExactWinCount,
      sizeExactWinRate: Number(((sizeExactWinCount / evalCount) * 100).toFixed(1)),
      sizeCoverWinCount,
      sizeCoverWinRate: Number(((sizeCoverWinCount / evalCount) * 100).toFixed(1)),
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
 * learns adaptive weights, prioritizes high-frequency numbers & champion pairs,
 * and returns the complete analytics payload.
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
  const parityAndSize = predictParityAndSize(draws, rankedNumbers, subModels);

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
