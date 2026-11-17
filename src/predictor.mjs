/**
 * Vietlott Bingo18 — Statistics & Transparent Suggestion Engine
 *
 * Nguyên tắc thiết kế (sau kiểm định trên ~2.200 kỳ thực tế):
 * - Kết quả Bingo18 hành xử như 3 xúc xắc công bằng, độc lập giữa các kỳ.
 * - Không có tham số nào được "tinh chỉnh" theo dữ liệu lịch sử (tránh overfitting).
 * - Gợi ý chỉ dùng 3 quy tắc đơn giản, dễ hiểu; mọi tỷ lệ hiển thị đều được đo
 *   walk-forward (chỉ dùng dữ liệu TRƯỚC mỗi kỳ) và đặt cạnh xác suất lý thuyết
 *   kèm khoảng dao động may/rủi 95%.
 */

export const SUM_META = {
  3:  { ways: 1,  prob: Number(((1 / 216) * 100).toFixed(2)),  prize: 1200000, multiplier: 120, group: 'SMALL' },
  4:  { ways: 3,  prob: Number(((3 / 216) * 100).toFixed(2)),  prize: 400000,  multiplier: 40,  group: 'SMALL' },
  5:  { ways: 6,  prob: Number(((6 / 216) * 100).toFixed(2)),  prize: 200000,  multiplier: 20,  group: 'SMALL' },
  6:  { ways: 10, prob: Number(((10 / 216) * 100).toFixed(2)), prize: 120000,  multiplier: 12,  group: 'SMALL' },
  7:  { ways: 15, prob: Number(((15 / 216) * 100).toFixed(2)), prize: 80000,   multiplier: 8,   group: 'SMALL' },
  8:  { ways: 21, prob: Number(((21 / 216) * 100).toFixed(2)), prize: 55000,   multiplier: 5.5, group: 'SMALL' },
  9:  { ways: 25, prob: Number(((25 / 216) * 100).toFixed(2)), prize: 47000,   multiplier: 4.7, group: 'SMALL' },
  10: { ways: 27, prob: Number(((27 / 216) * 100).toFixed(2)), prize: 44000,   multiplier: 4.4, group: 'TIE'   },
  11: { ways: 27, prob: Number(((27 / 216) * 100).toFixed(2)), prize: 44000,   multiplier: 4.4, group: 'TIE'   },
  12: { ways: 25, prob: Number(((25 / 216) * 100).toFixed(2)), prize: 47000,   multiplier: 4.7, group: 'BIG'   },
  13: { ways: 21, prob: Number(((21 / 216) * 100).toFixed(2)), prize: 55000,   multiplier: 5.5, group: 'BIG'   },
  14: { ways: 15, prob: Number(((15 / 216) * 100).toFixed(2)), prize: 80000,   multiplier: 8,   group: 'BIG'   },
  15: { ways: 10, prob: Number(((10 / 216) * 100).toFixed(2)), prize: 120000,  multiplier: 12,  group: 'BIG'   },
  16: { ways: 6,  prob: Number(((6 / 216) * 100).toFixed(2)),  prize: 200000,  multiplier: 20,  group: 'BIG'   },
  17: { ways: 3,  prob: Number(((3 / 216) * 100).toFixed(2)),  prize: 400000,  multiplier: 40,  group: 'BIG'   },
  18: { ways: 1,  prob: Number(((1 / 216) * 100).toFixed(2)),  prize: 1200000, multiplier: 120, group: 'BIG'   }
};

// Dàn 4 tổng có xác suất cao nhất theo toán học: 9, 10, 11, 12 (104/216 tổ hợp)
const TOP4_SUMS = [9, 10, 11, 12];

// Xác suất lý thuyết chính xác (tính trên 216 tổ hợp) — dạng tỷ lệ 0..1
const P = {
  single1: 91 / 216,
  pair2Any: 152 / 216,
  pair2Profit: 80 / 216,
  lhnExact: 81 / 216,
  lhnCover: 135 / 216,
  sumTop4: 104 / 216,
  doubleTop2: 32 / 216
};

export const THEORETICAL_BINGO18 = {
  single1WinRate: 42.13,
  single1Rtp: 56.94,
  pair2AnyWinRate: 70.37,
  pair2ProfitRate: 37.04,
  pair2Rtp: 56.94,
  triple3AnyWinRate: 87.5,
  bigWinRate: 37.5,
  tieWinRate: 25.0,
  smallWinRate: 37.5,
  lhnExactWinRate: 37.5,
  lhnCoverWinRate: 62.5,
  sumTop4WinRate: 48.15,
  sumTop4Rtp: 54.7,
  doubleSingleWinRate: 7.41,
  doubleTop2WinRate: 14.81,
  doubleTop2Rtp: 55.56,
  anyDoubleOrTripleRate: 44.44,
  anyTripleRate: 2.78
};

export const STRATEGIES = {
  cold: {
    key: 'cold',
    label: 'Mặt ra ít nhất 10 kỳ',
    description: 'Chọn mặt xuất hiện ít nhất trong 10 kỳ gần nhất (hòa thì xét 30 kỳ, rồi xét độ gan).'
  },
  hot: {
    key: 'hot',
    label: 'Mặt ra nhiều nhất 30 kỳ',
    description: 'Chọn mặt xuất hiện nhiều nhất trong 30 kỳ gần nhất (hòa thì xét 10 kỳ).'
  },
  gap: {
    key: 'gap',
    label: 'Mặt gan lâu nhất',
    description: 'Chọn mặt đã lâu nhất chưa xuất hiện (hòa thì xét mặt ra ít hơn trong 30 kỳ).'
  }
};

const BASELINE = { key: 'fixed', label: 'Luôn chọn mặt 1 (đối chứng)', description: 'Không phân tích gì — dùng để so sánh.' };

export const DEFAULT_STRATEGY = 'cold';
const WARMUP = 30;
const BACKTEST_ROWS = 100;

export function calculateSingleFacePrize(appearCount) {
  if (appearCount === 1) return 12000;
  if (appearCount === 2) return 20000;
  if (appearCount >= 3) return 30000;
  return 0;
}

const round1 = (x) => Number(x.toFixed(1));
const toPct = (k, n) => (n > 0 ? round1((k / n) * 100) : 0);

/**
 * Đánh giá một tỷ lệ đo được so với xác suất lý thuyết p (0..1)
 */
function judgeRate(wins, n, p) {
  if (n === 0) {
    return { rate: 0, z: 0, bandLow: 0, bandHigh: 0, verdict: 'Chưa đủ dữ liệu', verdictType: 'neutral' };
  }
  const se = Math.sqrt((p * (1 - p)) / n);
  const rate = wins / n;
  const z = (rate - p) / se;
  let verdict = 'Trong mức may/rủi — không có lợi thế';
  let verdictType = 'neutral';
  if (z >= 1.96) {
    verdict = 'Cao hơn lý thuyết (có thể vẫn do may, cần theo dõi thêm)';
    verdictType = 'up';
  } else if (z <= -1.96) {
    verdict = 'Thấp hơn lý thuyết (do rủi)';
    verdictType = 'down';
  }
  return {
    rate: round1(rate * 100),
    z: Number(z.toFixed(2)),
    bandLow: round1(Math.max(0, p - 1.96 * se) * 100),
    bandHigh: round1(Math.min(1, p + 1.96 * se) * 100),
    verdict,
    verdictType
  };
}

/**
 * Trạng thái từng mặt TRƯỚC mỗi kỳ: states[i] mô tả dữ liệu draws[0..i-1]
 */
function buildFaceStates(draws) {
  const N = draws.length;
  const states = new Array(N + 1);
  const c10 = new Int32Array(7);
  const c30 = new Int32Array(7);
  const tot = new Int32Array(7);
  const gap = new Int32Array(7);
  const dgap = new Int32Array(7);

  for (let i = 0; i <= N; i++) {
    states[i] = {
      c10: Int32Array.from(c10),
      c30: Int32Array.from(c30),
      tot: Int32Array.from(tot),
      gap: Int32Array.from(gap),
      dgap: Int32Array.from(dgap)
    };
    if (i === N) break;

    const cnt = [0, 0, 0, 0, 0, 0, 0];
    for (const x of draws[i].numbers) cnt[x]++;
    for (let f = 1; f <= 6; f++) {
      if (cnt[f] > 0) {
        c10[f]++;
        c30[f]++;
        tot[f]++;
        gap[f] = 0;
      } else {
        gap[f]++;
      }
      if (cnt[f] >= 2) dgap[f] = 0;
      else dgap[f]++;
    }
    if (i >= 10) for (const x of new Set(draws[i - 10].numbers)) c10[x]--;
    if (i >= 30) for (const x of new Set(draws[i - 30].numbers)) c30[x]--;
  }
  return states;
}

const RANK_KEYS = {
  cold: (s, f) => [-s.c10[f], -s.c30[f], s.gap[f]],
  hot: (s, f) => [s.c30[f], s.c10[f], -s.gap[f]],
  gap: (s, f) => [s.gap[f], -s.c30[f], -s.c10[f]],
  fixed: (s, f) => [f === 1 ? 1 : 0, -f, 0]
};

/**
 * Xếp hạng 6 mặt theo một quy tắc đơn giản (không có tham số tinh chỉnh)
 */
export function rankFaces(state, strategy = DEFAULT_STRATEGY) {
  const keyFn = RANK_KEYS[strategy] || RANK_KEYS[DEFAULT_STRATEGY];
  const faces = [1, 2, 3, 4, 5, 6].map((f) => ({ face: f, key: keyFn(state, f) }));
  faces.sort((a, b) => {
    for (let k = 0; k < a.key.length; k++) {
      if (a.key[k] !== b.key[k]) return b.key[k] - a.key[k];
    }
    return a.face - b.face;
  });
  return faces.map((x, idx) => ({
    face: x.face,
    rank: idx + 1,
    count10: state.c10[x.face],
    count30: state.c30[x.face],
    countAll: state.tot[x.face],
    gap: state.gap[x.face]
  }));
}

function faceReason(strategy, item) {
  if (strategy === 'hot') {
    return `Mặt ${item.face} ra nhiều nhất 30 kỳ gần đây (${item.count30}/30 kỳ · ${item.count10}/10 kỳ)`;
  }
  if (strategy === 'gap') {
    return `Mặt ${item.face} đang gan lâu nhất (${item.gap} kỳ chưa ra · ${item.count30}/30 kỳ)`;
  }
  return `Mặt ${item.face} ra ít nhất 10 kỳ gần đây (${item.count10}/10 kỳ · ${item.count30}/30 kỳ)`;
}

/**
 * Quy tắc Lớn/Nhỏ: theo bên xuất hiện nhiều hơn trong 20 kỳ gần nhất (bỏ qua Hòa)
 */
function pickLhnSide(draws, endIdx) {
  let big = 0, small = 0;
  for (let k = Math.max(0, endIdx - 20); k < endIdx; k++) {
    if (draws[k].sizeType === 'BIG') big++;
    else if (draws[k].sizeType === 'SMALL') small++;
  }
  if (big !== small) return { side: big > small ? 'BIG' : 'SMALL', big, small };
  for (let k = endIdx - 1; k >= 0; k--) {
    if (draws[k].sizeType !== 'TIE') return { side: draws[k].sizeType, big, small };
  }
  return { side: 'BIG', big, small };
}

function pickTop2Doubles(state) {
  return [1, 2, 3, 4, 5, 6]
    .map((f) => ({ f, g: state.dgap[f] }))
    .sort((a, b) => b.g - a.g || a.f - b.f)
    .slice(0, 2)
    .map((x) => x.f);
}

/**
 * Đối soát walk-forward cho một chiến thuật trên toàn bộ lịch sử
 */
export function runWalkForward(draws, states, strategy, withHistory = false) {
  const N = draws.length;
  const acc = {
    n: 0,
    s1Win: 0, s1Prize: 0,
    p2Any: 0, p2Profit: 0, p2Prize: 0,
    lhnExact: 0, lhnCover: 0,
    sumWin: 0, sumPrize: 0,
    dblWin: 0, dblPrize: 0
  };
  const rows = [];
  const historyFrom = Math.max(WARMUP, N - BACKTEST_ROWS);

  for (let idx = WARMUP; idx < N; idx++) {
    const d = draws[idx];
    const st = states[idx];
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const x of d.numbers) counts[x]++;

    const ranked = rankFaces(st, strategy);
    const pick1 = ranked[0].face;
    const pick2 = [ranked[0].face, ranked[1].face];

    const c1 = counts[pick1];
    const s1Prize = calculateSingleFacePrize(c1);
    const p2Prize = calculateSingleFacePrize(counts[pick2[0]]) + calculateSingleFacePrize(counts[pick2[1]]);
    const p2Any = counts[pick2[0]] > 0 || counts[pick2[1]] > 0;

    const lhn = pickLhnSide(draws, idx);
    const lhnExact = lhn.side === d.sizeType;
    const lhnCover = lhnExact || d.sizeType === 'TIE';

    const sumWon = TOP4_SUMS.includes(d.sum);
    const sumPrize = sumWon ? SUM_META[d.sum].prize : 0;

    const dbl = pickTop2Doubles(st);
    const dblHits = dbl.filter((f) => counts[f] >= 2).length;

    acc.n++;
    if (c1 > 0) acc.s1Win++;
    acc.s1Prize += s1Prize;
    if (p2Any) acc.p2Any++;
    if (p2Prize >= 20000) acc.p2Profit++;
    acc.p2Prize += p2Prize;
    if (lhnExact) acc.lhnExact++;
    if (lhnCover) acc.lhnCover++;
    if (sumWon) acc.sumWin++;
    acc.sumPrize += sumPrize;
    if (dblHits > 0) acc.dblWin++;
    acc.dblPrize += dblHits * 75000;

    if (withHistory && idx >= historyFrom) {
      rows.push({
        drawId: d.drawId,
        time: d.time,
        date: d.date,
        actualNumbers: d.numbers,
        actualSum: d.sum,
        actualSizeLabel: d.sizeLabel,
        single1: { predicted: pick1, appearCount: c1, won: c1 > 0, prize: s1Prize },
        pair2: {
          predicted: pick2,
          hits: pick2.filter((f) => counts[f] > 0),
          wonAny: p2Any,
          profitable: p2Prize >= 20000,
          prize: p2Prize
        },
        lhn: {
          predictedSide: lhn.side,
          predictedLabel: lhn.side === 'BIG' ? 'Lớn + Hòa' : 'Nhỏ + Hòa',
          actualType: d.sizeType,
          exactWon: lhnExact,
          coverWon: lhnCover
        },
        sumTop4: { predicted: TOP4_SUMS, actualSum: d.sum, won: sumWon, prize: sumPrize },
        doubleTop2: { predicted: dbl.map((f) => `${f}-${f}`), won: dblHits > 0, prize: dblHits * 75000 }
      });
    }
  }

  const n = acc.n;
  const single = judgeRate(acc.s1Win, n, P.single1);
  const pair = judgeRate(acc.p2Any, n, P.pair2Any);

  return {
    summary: {
      evaluatedDraws: n,
      single1WinCount: acc.s1Win,
      single1WinRate: single.rate,
      single1Rtp: n ? round1((acc.s1Prize / (n * 10000)) * 100) : 0,
      single1Judge: single,
      pair2AnyWinCount: acc.p2Any,
      pair2AnyWinRate: pair.rate,
      pair2ProfitCount: acc.p2Profit,
      pair2ProfitRate: toPct(acc.p2Profit, n),
      pair2Rtp: n ? round1((acc.p2Prize / (n * 20000)) * 100) : 0,
      pair2Judge: pair,
      lhnExactWinCount: acc.lhnExact,
      lhnExactWinRate: toPct(acc.lhnExact, n),
      lhnCoverWinCount: acc.lhnCover,
      lhnCoverWinRate: toPct(acc.lhnCover, n),
      lhnCoverJudge: judgeRate(acc.lhnCover, n, P.lhnCover),
      sumTop4WinCount: acc.sumWin,
      sumTop4WinRate: toPct(acc.sumWin, n),
      sumTop4Rtp: n ? round1((acc.sumPrize / (n * 40000)) * 100) : 0,
      sumTop4Judge: judgeRate(acc.sumWin, n, P.sumTop4),
      doubleTop2WinCount: acc.dblWin,
      doubleTop2WinRate: toPct(acc.dblWin, n),
      doubleTop2Rtp: n ? round1((acc.dblPrize / (n * 20000)) * 100) : 0,
      doubleTop2Judge: judgeRate(acc.dblWin, n, P.doubleTop2),
      theoretical: THEORETICAL_BINGO18
    },
    history: rows.reverse()
  };
}

/**
 * Bảng thống kê đầy đủ: 6 mặt, Trùng đôi, Bão, 16 tổng, Lớn/Hòa/Nhỏ
 */
export function computeFullStatistics(draws, rankedFaces = []) {
  const N = draws.length;
  const rankMap = new Map(rankedFaces.map((x) => [x.face, x]));

  // 1. Sáu mặt số
  const faceStats = [];
  for (let f = 1; f <= 6; f++) {
    let drawHits = 0, hit1x = 0, hit2x = 0, hit3x = 0, curGap = 0, maxGap = 0;
    for (let i = 0; i < N; i++) {
      const c = draws[i].numbers.filter((x) => x === f).length;
      if (c > 0) {
        drawHits++;
        if (c === 1) hit1x++;
        else if (c === 2) hit2x++;
        else hit3x++;
        curGap = 0;
      } else {
        curGap++;
        if (curGap > maxGap) maxGap = curGap;
      }
    }
    const r = rankMap.get(f);
    faceStats.push({
      face: f,
      drawHits,
      hitRate: toPct(drawHits, N),
      theoreticalRate: 42.13,
      hit1x,
      hit2x,
      hit3x,
      currentGap: curGap,
      maxGap,
      count10: r ? r.count10 : 0,
      count30: r ? r.count30 : 0,
      rank: r ? r.rank : null
    });
  }

  // 2. Trùng đôi & Bão
  const doublesStats = [];
  const triplesStats = [];
  let anyDoubleCount = 0, anyDoubleCurGap = 0, anyDoubleMaxGap = 0;
  let anyTripleCount = 0, anyTripleCurGap = 0, anyTripleMaxGap = 0;

  for (let i = 0; i < N; i++) {
    const [a, b, c] = draws[i].numbers;
    if (a === b || a === c || b === c) {
      anyDoubleCount++;
      anyDoubleCurGap = 0;
    } else {
      anyDoubleCurGap++;
      if (anyDoubleCurGap > anyDoubleMaxGap) anyDoubleMaxGap = anyDoubleCurGap;
    }
    if (a === b && b === c) {
      anyTripleCount++;
      anyTripleCurGap = 0;
    } else {
      anyTripleCurGap++;
      if (anyTripleCurGap > anyTripleMaxGap) anyTripleMaxGap = anyTripleCurGap;
    }
  }

  for (let f = 1; f <= 6; f++) {
    let dHits = 0, dCurGap = 0, dMaxGap = 0, tHits = 0, tCurGap = 0, tMaxGap = 0;
    for (let i = 0; i < N; i++) {
      const c = draws[i].numbers.filter((x) => x === f).length;
      if (c >= 2) {
        dHits++;
        dCurGap = 0;
      } else {
        dCurGap++;
        if (dCurGap > dMaxGap) dMaxGap = dCurGap;
      }
      if (c === 3) {
        tHits++;
        tCurGap = 0;
      } else {
        tCurGap++;
        if (tCurGap > tMaxGap) tMaxGap = tCurGap;
      }
    }
    doublesStats.push({
      face: f,
      pairLabel: `${f}-${f}`,
      hits: dHits,
      rate: toPct(dHits, N),
      theoreticalRate: 7.41,
      avgCycle: dHits > 0 ? round1(N / dHits) : null,
      currentGap: dCurGap,
      maxGap: dMaxGap,
      prize: 75000,
      statusNote:
        dCurGap > 13.5
          ? `Đang gan ${dCurGap} kỳ (dài hơn chu kỳ TB 13,5)`
          : `Cách lần ra gần nhất ${dCurGap} kỳ`
    });
    triplesStats.push({
      face: f,
      tripleLabel: `${f}-${f}-${f}`,
      hits: tHits,
      rate: N > 0 ? Number(((tHits / N) * 100).toFixed(2)) : 0,
      theoreticalRate: 0.46,
      currentGap: tCurGap,
      maxGap: tMaxGap,
      prize: 1200000
    });
  }

  const top2Doubles = [...doublesStats].sort((a, b) => b.currentGap - a.currentGap || a.face - b.face).slice(0, 2);

  // 3. 16 mức tổng
  const sumsStats = [];
  for (let s = 3; s <= 18; s++) {
    let hits = 0, curGap = 0, maxGap = 0;
    for (let i = 0; i < N; i++) {
      if (draws[i].sum === s) {
        hits++;
        curGap = 0;
      } else {
        curGap++;
        if (curGap > maxGap) maxGap = curGap;
      }
    }
    const meta = SUM_META[s];
    const expectedCycle = round1(216 / meta.ways);
    sumsStats.push({
      sum: s,
      ...meta,
      hits,
      rate: toPct(hits, N),
      expectedCycle,
      currentGap: curGap,
      maxGap,
      isLongGap: curGap >= expectedCycle * 1.25
    });
  }

  // 4. Lớn / Hòa / Nhỏ + Chẵn/Lẻ
  let bigCount = 0, tieCount = 0, smallCount = 0, evenSumCount = 0;
  let bigGap = 0, tieGap = 0, smallGap = 0;
  for (let i = 0; i < N; i++) {
    const st = draws[i].sizeType;
    bigGap = st === 'BIG' ? 0 : bigGap + 1;
    tieGap = st === 'TIE' ? 0 : tieGap + 1;
    smallGap = st === 'SMALL' ? 0 : smallGap + 1;
    if (st === 'BIG') bigCount++;
    else if (st === 'TIE') tieCount++;
    else smallCount++;
    if (draws[i].sum % 2 === 0) evenSumCount++;
  }

  const roadmap24 = draws.slice(-24).map((d) => ({
    drawId: d.drawId,
    time: d.time,
    sum: d.sum,
    sizeType: d.sizeType,
    sizeCode: d.sizeType === 'BIG' ? 'L' : d.sizeType === 'TIE' ? 'H' : 'N',
    matchType: d.matchType,
    numbers: d.numbers
  }));

  return {
    faceStats,
    doublesStats,
    top2Doubles,
    triplesStats,
    anyDoubleSummary: {
      hits: anyDoubleCount,
      rate: toPct(anyDoubleCount, N),
      theoreticalRate: 44.4,
      currentGap: anyDoubleCurGap,
      maxGap: anyDoubleMaxGap
    },
    anyTripleSummary: {
      hits: anyTripleCount,
      rate: N > 0 ? Number(((anyTripleCount / N) * 100).toFixed(2)) : 0,
      theoreticalRate: 2.78,
      currentGap: anyTripleCurGap,
      maxGap: anyTripleMaxGap,
      prize: 200000
    },
    sumsStats,
    lhnSummary: {
      bigCount,
      bigRate: toPct(bigCount, N),
      bigGap,
      tieCount,
      tieRate: toPct(tieCount, N),
      tieGap,
      smallCount,
      smallRate: toPct(smallCount, N),
      smallGap,
      evenSumCount,
      evenSumRate: toPct(evenSumCount, N),
      oddSumCount: N - evenSumCount,
      oddSumRate: toPct(N - evenSumCount, N),
      roadmap24
    }
  };
}

/**
 * Pipeline đầy đủ: thống kê + gợi ý kỳ tới + đối soát minh bạch
 */
export function analyzeAndPredictNextDraw(draws, customMode = DEFAULT_STRATEGY) {
  const mode = STRATEGIES[customMode] ? customMode : DEFAULT_STRATEGY;
  const N = draws.length;
  const states = buildFaceStates(draws);
  const current = states[N];

  const rankedFaces = rankFaces(current, mode);
  const stats = computeFullStatistics(draws, rankedFaces);

  // Đối soát walk-forward cho tất cả chiến thuật + đối chứng
  const comparison = [];
  let selected = null;
  for (const key of [...Object.keys(STRATEGIES), BASELINE.key]) {
    const meta = STRATEGIES[key] || BASELINE;
    const wf = runWalkForward(draws, states, key, key === mode);
    if (key === mode) selected = wf;
    comparison.push({
      key,
      label: meta.label,
      description: meta.description,
      isSelected: key === mode,
      isBaseline: key === BASELINE.key,
      evaluatedDraws: wf.summary.evaluatedDraws,
      single1WinRate: wf.summary.single1WinRate,
      single1Rtp: wf.summary.single1Rtp,
      pair2AnyWinRate: wf.summary.pair2AnyWinRate,
      pair2ProfitRate: wf.summary.pair2ProfitRate,
      judge: wf.summary.single1Judge
    });
  }

  const latestDraw = N > 0 ? draws[N - 1] : null;
  const nextDrawId = latestDraw ? String(latestDraw.drawNumber + 1).padStart(6, '0') : '------';
  const sm = selected.summary;

  const lhn = pickLhnSide(draws, N);
  const lhnLabel = lhn.side === 'BIG' ? 'LỚN (Tổng 12–18 · x1.5)' : 'NHỎ (Tổng 3–9 · x1.5)';

  const predictions = {
    singleVip: {
      face: rankedFaces[0].face,
      reason: faceReason(mode, rankedFaces[0]),
      theoreticalRate: THEORETICAL_BINGO18.single1WinRate,
      measuredRate: sm.single1WinRate,
      measuredRtp: sm.single1Rtp
    },
    pairVip: {
      faces: [rankedFaces[0].face, rankedFaces[1].face],
      theoreticalAnyRate: THEORETICAL_BINGO18.pair2AnyWinRate,
      theoreticalProfitRate: THEORETICAL_BINGO18.pair2ProfitRate,
      measuredAnyRate: sm.pair2AnyWinRate,
      measuredProfitRate: sm.pair2ProfitRate
    },
    tripleCoverVip: {
      faces: rankedFaces.slice(0, 3).map((x) => x.face),
      theoreticalAnyRate: THEORETICAL_BINGO18.triple3AnyWinRate
    },
    lhnVip: {
      mainSide: lhn.side,
      mainPick: lhnLabel,
      comboPick: `${lhn.side === 'BIG' ? 'Lớn' : 'Nhỏ'} + Bọc Hòa (10–11)`,
      reason: `20 kỳ gần nhất: Lớn ${lhn.big} – Nhỏ ${lhn.small} → theo bên ra nhiều hơn.`,
      theoreticalExact: THEORETICAL_BINGO18.lhnExactWinRate,
      theoreticalCover: THEORETICAL_BINGO18.lhnCoverWinRate,
      measuredExact: sm.lhnExactWinRate,
      measuredCover: sm.lhnCoverWinRate
    },
    doubleVip: stats.top2Doubles,
    sumVip: TOP4_SUMS.map((s) => {
      const st = stats.sumsStats.find((x) => x.sum === s);
      return { sum: s, prize: SUM_META[s].prize, ways: SUM_META[s].ways, gap: st ? st.currentGap : 0 };
    })
  };

  return {
    nextDrawId,
    latestDraw,
    totalHistoricalDraws: N,
    mode,
    strategy: STRATEGIES[mode],
    rankedFaces,
    predictions,
    strategyComparison: comparison,
    stats,
    backtestHistory: selected.history,
    backtestSummary: sm
  };
}
