const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export const DRAWS_PER_DAY = 159; // 06:05 to 21:53 every 6 minutes

function pad2(n) {
  return String(n).padStart(2, '0');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deterministic daily slot (1..159) and HH:MM time (06:05..21:53) from Bingo18 drawNumber
 */
export function computeDrawTimeFromNumber(drawNumber) {
  const k = (((drawNumber - 10) % DRAWS_PER_DAY) + DRAWS_PER_DAY) % DRAWS_PER_DAY;
  const totalMinutes = 6 * 60 + 5 + k * 6; // 06:05 + 6*k
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return {
    slotIndex: k + 1,
    time: `${pad2(hh)}:${pad2(mm)}`
  };
}

/**
 * Normalize a Bingo18 draw object with complete statistical metadata
 */
export function normalizeDraw(rawId, date, numbers, source = 'live', explicitTime = null) {
  const cleanNum = parseInt(String(rawId).replace(/^#/, '').trim(), 10);
  const drawId = String(cleanNum).padStart(6, '0');
  const nums = numbers.map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= 6);
  const [a, b, c] = nums;
  const sum = a + b + c;

  let sizeType = 'TIE';
  let sizeLabel = 'Hòa (10–11)';
  if (sum >= 12) {
    sizeType = 'BIG';
    sizeLabel = 'Lớn (12–18)';
  } else if (sum <= 9) {
    sizeType = 'SMALL';
    sizeLabel = 'Nhỏ (3–9)';
  }

  let matchType = 'DIFF';
  let matchLabel = '3 số khác nhau';
  let matchedFace = null;

  if (a === b && b === c) {
    matchType = 'TRIPLE';
    matchedFace = a;
    matchLabel = `Bão ${a}-${a}-${a}`;
  } else if (a === b || a === c || b === c) {
    matchType = 'DOUBLE';
    matchedFace = a === b || a === c ? a : b;
    matchLabel = `Trùng đôi ${matchedFace}-${matchedFace}`;
  }

  const scheduleInfo = computeDrawTimeFromNumber(cleanNum);

  return {
    drawId,
    drawNumber: cleanNum,
    date: date || '',
    time: explicitTime || scheduleInfo.time,
    slotIndex: scheduleInfo.slotIndex,
    numbers: [a, b, c],
    sum,
    sizeType,
    sizeLabel,
    parityType: sum % 2 === 0 ? 'EVEN' : 'ODD',
    parityLabel: sum % 2 === 0 ? 'Tổng Chẵn' : 'Tổng Lẻ',
    matchType,
    matchLabel,
    matchedFace,
    source
  };
}

/**
 * Parse Bingo18 draws from XoSoMinhNgoc HTML (both main page and AJAX list fragments)
 */
export function parseMinhNgocBingoHtml(html) {
  const draws = [];

  // 1. Featured top draw (<article class="vk ... vkt-bingo18">)
  const topMatch = html.match(
    /<a class="vk-kyve"[^>]*>[\s\S]*?<b>#?(\d+)<\/b>[\s\S]*?<ul class="vk-bong">\s*<li>(\d)<\/li>\s*<li>(\d)<\/li>\s*<li>(\d)<\/li>/i
  );
  const topDateMatch = html.match(/Mở thưởng[^<]*ngày\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (topMatch) {
    const nums = [parseInt(topMatch[2], 10), parseInt(topMatch[3], 10), parseInt(topMatch[4], 10)];
    if (nums.every((n) => n >= 1 && n <= 6)) {
      draws.push(normalizeDraw(topMatch[1], topDateMatch ? topDateMatch[1] : '', nums, 'xosominhngoc.net.vn'));
    }
  }

  // 2. List items (<li><a class="vlitem" ...)
  const itemRegex =
    /<span class="vlky"><b>#?(\d+)<\/b><time[^>]*>[^<]*?(\d{2}\/\d{2}\/\d{4})<\/time><\/span><span class="vlso"><span class="kq">(\d)<\/span><span class="kq">(\d)<\/span><span class="kq">(\d)<\/span><\/span>/gi;
  let m;
  while ((m = itemRegex.exec(html)) !== null) {
    const nums = [parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10)];
    if (nums.every((n) => n >= 1 && n <= 6)) {
      draws.push(normalizeDraw(m[1], m[2], nums, 'xosominhngoc.net.vn'));
    }
  }

  return draws;
}

/**
 * Parse Bingo18 draws from official Vietlott HTML
 */
export function parseVietlottBingoHtml(html) {
  const draws = [];
  const rowRegex =
    /view-detail-bingo18-result\?nocatche=1&id=\d+"[^>]*>(\d{2}\/\d{2}\/\d{4})<\/a><div><a[^>]*>#?(\d+)<\/a><\/div><\/td>\s*<td[^>]*><div class="day_so_ket_qua_v2">\s*<div class="CssDivBingo"><span class="bong_tron_bingo[^"]*">(\d)<\/span>\s*<span class="bong_tron_bingo[^"]*">(\d)<\/span>\s*<span class="bong_tron_bingo[^"]*">(\d)<\/span>/gi;

  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const date = m[1];
    const rawId = m[2];
    const nums = [parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10)];
    if (nums.every((n) => n >= 1 && n <= 6)) {
      draws.push(normalizeDraw(rawId, date, nums, 'vietlott.vn'));
    }
  }
  return draws;
}

/**
 * Get current Vietnam time parts (UTC+7)
 */
export function getVnNowParts() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = {};
  for (const p of fmt.formatToParts(now)) {
    parts[p.type] = p.value;
  }
  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10);
  const day = parseInt(parts.day, 10);
  const hours = parseInt(parts.hour, 10) % 24;
  const minutes = parseInt(parts.minute, 10);
  const seconds = parseInt(parts.second, 10);

  return {
    year,
    month,
    day,
    hours,
    minutes,
    seconds,
    dateSlash: `${pad2(day)}/${pad2(month)}/${year}`,
    dateIso: `${year}-${pad2(month)}-${pad2(day)}`
  };
}

/**
 * Fetch main page of XoSoMinhNgoc Bingo18
 */
export async function fetchMinhNgocMainPage() {
  const res = await fetch('https://xosominhngoc.net.vn/ket-qua-xo-so-bingo18.html', {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`MinhNgoc HTTP ${res.status}`);
  const html = await res.text();
  return parseMinhNgocBingoHtml(html);
}

/**
 * Fetch paginated AJAX batch from XoSoMinhNgoc (start = 10, 20, 30, ...)
 */
export async function fetchMinhNgocAjaxBatch(start = 10, moilan = 10, dateIso = null) {
  const vn = getVnNowParts();
  const ngay = dateIso || vn.dateIso;
  const url = `https://xosominhngoc.net.vn/ajax/kqxs_vietlott_list.php?tinh=121&start=${start}&moilan=${moilan}&ngay=${ngay}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`MinhNgoc AJAX HTTP ${res.status}`);
  const html = await res.text();
  return parseMinhNgocBingoHtml(html);
}

/**
 * Fetch latest draws from official Vietlott page
 */
export async function fetchVietlottOfficialLatest() {
  const res = await fetch('https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/winning-number-bingo18', {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`Vietlott HTTP ${res.status}`);
  const html = await res.text();
  return parseVietlottBingoHtml(html);
}

/**
 * Poll latest Bingo18 draws from both sources in parallel for lowest latency
 */
export async function fetchLatestDraws() {
  const results = await Promise.allSettled([
    fetchMinhNgocMainPage(),
    fetchVietlottOfficialLatest()
  ]);

  const map = new Map();
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      for (const item of r.value) {
        if (!map.has(item.drawNumber)) {
          map.set(item.drawNumber, item);
        }
      }
    }
  }
  return [...map.values()].sort((a, b) => a.drawNumber - b.drawNumber);
}

/**
 * Fetch initial history on startup, stopping early once connected with stored draws
 */
export async function fetchInitialHistory(maxBatches = 15, options = {}) {
  const { knownIds = null, maxKnownId = 0, onProgress = null } = options;
  const map = new Map();

  try {
    const firstBatch = await fetchLatestDraws();
    const newFirst = [];
    for (const d of firstBatch) {
      map.set(d.drawNumber, d);
      if (!knownIds || !knownIds.has(d.drawNumber)) {
        newFirst.push(d);
      }
    }
    if (newFirst.length > 0 && typeof onProgress === 'function') {
      onProgress(newFirst);
    }

    // Check if we already connected with knownIds
    if (knownIds && knownIds.size >= 200 && maxKnownId > 0 && firstBatch.length > 0) {
      const minFirst = Math.min(...firstBatch.map((x) => x.drawNumber));
      if (minFirst <= maxKnownId + 1) {
        return [...map.values()].sort((a, b) => a.drawNumber - b.drawNumber);
      }
    }
  } catch (err) {
    console.warn('[Crawler] Initial latest fetch warn:', err.message);
  }

  for (let b = 1; b <= maxBatches; b++) {
    const start = b * 10;
    try {
      await sleep(180);
      const list = await fetchMinhNgocAjaxBatch(start, 10);
      if (!list || list.length === 0) break;

      const batchNew = [];
      let hitKnown = false;
      for (const item of list) {
        if (knownIds && knownIds.has(item.drawNumber)) {
          hitKnown = true;
        }
        if (!map.has(item.drawNumber)) {
          map.set(item.drawNumber, item);
          if (!knownIds || !knownIds.has(item.drawNumber)) {
            batchNew.push(item);
          }
        }
      }

      if (batchNew.length > 0 && typeof onProgress === 'function') {
        onProgress(batchNew);
      }

      const minInBatch = Math.min(...list.map((x) => x.drawNumber));
      if (knownIds && knownIds.size >= 200 && maxKnownId > 0 && (hitKnown || minInBatch <= maxKnownId + 1)) {
        break;
      }
    } catch (err) {
      console.warn(`[Crawler] Batch start=${start} warn:`, err.message);
      break;
    }
  }

  return [...map.values()].sort((a, b) => a.drawNumber - b.drawNumber);
}

/**
 * Fetch older historical draws strictly preceding the current oldest stored draw
 */
export async function fetchOlderHistoryDraws(oldestDraw = null, batchesToFetch = 12, currentTotalSize = 0) {
  const map = new Map();
  const startOffset = Math.max(10, Math.floor(currentTotalSize / 10) * 10);

  for (let i = 0; i < batchesToFetch; i++) {
    const start = startOffset + i * 10;
    try {
      if (i > 0) await sleep(180);
      const list = await fetchMinhNgocAjaxBatch(start, 10);
      if (!list || list.length === 0) break;
      for (const item of list) {
        if (!oldestDraw || item.drawNumber < oldestDraw.drawNumber) {
          map.set(item.drawNumber, item);
        }
      }
    } catch (err) {
      console.warn(`[Crawler] Older history start=${start} warn:`, err.message);
      break;
    }
  }

  return [...map.values()].sort((a, b) => a.drawNumber - b.drawNumber);
}

/**
 * Backfill any missing draws between startDrawNumber and endDrawNumber
 */
export async function fetchMissingGapDraws(startDrawNumber, endDrawNumber) {
  const map = new Map();
  for (let b = 1; b <= 35; b++) {
    const start = b * 10;
    try {
      if (b > 1) await sleep(160);
      const list = await fetchMinhNgocAjaxBatch(start, 10);
      if (!list || list.length === 0) break;
      for (const item of list) {
        if (item.drawNumber >= startDrawNumber && item.drawNumber <= endDrawNumber) {
          map.set(item.drawNumber, item);
        }
      }
      const minOnBatch = Math.min(...list.map((x) => x.drawNumber));
      if (minOnBatch < startDrawNumber) break;
    } catch (err) {
      console.warn(`[Crawler] Gap heal start=${start} warn:`, err.message);
      break;
    }
  }
  return [...map.values()].sort((a, b) => a.drawNumber - b.drawNumber);
}

/**
 * Compute next Bingo18 draw schedule (every 6 minutes from 06:05 to 21:53 VN time)
 */
export function getNextDrawSchedule(latestDraw = null) {
  const vn = getVnNowParts();
  const nowTotalSec = vn.hours * 3600 + vn.minutes * 60 + vn.seconds;
  const firstDrawSec = (6 * 60 + 5) * 60; // 06:05:00
  const lastDrawSec = (21 * 60 + 53) * 60; // 21:53:00
  const intervalSec = 6 * 60; // 360s

  const isOperatingHours = nowTotalSec >= firstDrawSec - 300 && nowTotalSec <= lastDrawSec + 300;
  let nextSlotIdx = 0;
  let secondsUntilNextSchedule = 0;

  if (nowTotalSec < firstDrawSec) {
    nextSlotIdx = 0;
    secondsUntilNextSchedule = firstDrawSec - nowTotalSec;
  } else if (nowTotalSec > lastDrawSec) {
    nextSlotIdx = 0;
    secondsUntilNextSchedule = 86400 - nowTotalSec + firstDrawSec;
  } else {
    const elapsedSinceFirst = nowTotalSec - firstDrawSec;
    const completedSlots = Math.floor(elapsedSinceFirst / intervalSec);
    nextSlotIdx = Math.min(DRAWS_PER_DAY - 1, completedSlots + 1);
    const nextDrawSec = firstDrawSec + nextSlotIdx * intervalSec;
    secondsUntilNextSchedule = Math.max(0, nextDrawSec - nowTotalSec);
  }

  const nextTotalMin = 6 * 60 + 5 + nextSlotIdx * 6;
  const nextHH = Math.floor(nextTotalMin / 60);
  const nextMM = nextTotalMin % 60;
  const nextDrawTimeStr = `${pad2(nextHH)}:${pad2(nextMM)}`;

  // Check if latestDraw from today is behind the most recently completed slot
  let awaitingNewResult = false;
  let expectedDrawTimeStr = nextDrawTimeStr;
  const expectedDrawId = latestDraw ? String(latestDraw.drawNumber + 1).padStart(6, '0') : '------';

  if (isOperatingHours && nowTotalSec >= firstDrawSec + 15 && latestDraw && latestDraw.date === vn.dateSlash) {
    const latestSlotZero = latestDraw.slotIndex - 1;
    const expectedLatestSlotZero = Math.floor((nowTotalSec - firstDrawSec) / intervalSec);
    if (expectedLatestSlotZero > latestSlotZero) {
      awaitingNewResult = true;
      const expMin = 6 * 60 + 5 + (latestSlotZero + 1) * 6;
      expectedDrawTimeStr = `${pad2(Math.floor(expMin / 60))}:${pad2(expMin % 60)}`;
    }
  }

  return {
    nowTimeStr: `${pad2(vn.hours)}:${pad2(vn.minutes)}:${pad2(vn.seconds)}`,
    nextDrawTimeStr,
    expectedDrawTimeStr,
    expectedDrawId,
    nextDrawId: expectedDrawId,
    secondsUntilNextSchedule,
    targetTimestampMs: Date.now() + secondsUntilNextSchedule * 1000,
    awaitingNewResult,
    awaitingResult: awaitingNewResult,
    isOperatingHours
  };
}
