const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Parse Keno draws from MinhChinh HTML
 */
export function parseMinhChinhHtml(html) {
  const draws = [];
  const rowRegex =
    /<div class="kn-row(?:\s+kn-alt)?">\s*<div class="kn-c-ky"><div class="kn-ky">#?(\d+)<\/div><\/div>\s*<div class="kn-c-time"><div class="kn-time">([^<]+)<\/div><div class="kn-date">([^<]+)<\/div><\/div>\s*<div class="kn-c-balls"><div class="kn-balls">([\s\S]*?)<\/div><\/div>/g;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const rawId = match[1].trim();
    const time = match[2].trim();
    const date = match[3].trim();
    const ballsHtml = match[4];
    const ballMatches = [...ballsHtml.matchAll(/<span class="kn-ball">(\d+)<\/span>/g)];
    const numbers = ballMatches
      .map((m) => parseInt(m[1], 10))
      .filter((n) => !Number.isNaN(n) && n >= 1 && n <= 80);

    if (numbers.length === 20) {
      draws.push(normalizeDraw(rawId, time, date, numbers, 'minhchinh.com'));
    }
  }
  return draws;
}

/**
 * Parse Keno draws from KetQuaDienToan HTML (fallback source)
 */
export function parseKetQuaDienToanHtml(html) {
  const draws = [];
  const blockRegex =
    /<div class="kythuong">\s*Kỳ vé #?(\d+)\s*\|\s*Lúc\s*(\d{1,2}:\d{2})\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*<\/div>\s*<div class="box_ketqua">([\s\S]*?)<\/div>/g;

  let match;
  while ((match = blockRegex.exec(html)) !== null) {
    const rawId = match[1].trim();
    const time = match[2].trim();
    const date = match[3].trim();
    const ballsHtml = match[4];
    const ballMatches = [...ballsHtml.matchAll(/<span class="ball ball_keno">(\d+)<\/span>/g)];
    const numbers = ballMatches
      .map((m) => parseInt(m[1], 10))
      .filter((n) => !Number.isNaN(n) && n >= 1 && n <= 80);

    if (numbers.length === 20) {
      draws.push(normalizeDraw(rawId, time, date, numbers, 'ketquadientoan.com'));
    }
  }
  return draws;
}

/**
 * Normalize draw object with standard 6-digit ID and parity/size stats
 */
export function normalizeDraw(rawId, time, date, numbers, source = 'live') {
  // Note: ketquadientoan sometimes omits leading '3' (e.g. '02442' vs '302442')
  let cleanId = String(rawId).replace(/^#/, '').trim();
  if (cleanId.length === 5 && cleanId.startsWith('0')) {
    cleanId = '3' + cleanId;
  }
  const sortedNumbers = [...numbers].sort((a, b) => a - b);
  const evenCount = sortedNumbers.filter((n) => n % 2 === 0).length;
  const oddCount = 20 - evenCount;
  const bigCount = sortedNumbers.filter((n) => n > 40).length;
  const smallCount = 20 - bigCount;

  let parityLabel = 'Hòa Chẵn Lẻ (10-10)';
  if (evenCount >= 13) parityLabel = `Chẵn (${evenCount}-${oddCount})`;
  else if ( evenCount >= 11) parityLabel = `Chẵn nhẹ (${evenCount}-${oddCount})`;
  else if (oddCount >= 13) parityLabel = `Lẻ (${evenCount}-${oddCount})`;
  else if (oddCount >= 11) parityLabel = `Lẻ nhẹ (${evenCount}-${oddCount})`;

  let sizeLabel = 'Hòa Lớn Nhỏ (10-10)';
  if (bigCount >= 13) sizeLabel = `Lớn (${bigCount}-${smallCount})`;
  else if (bigCount >= 11) sizeLabel = `Lớn nhẹ (${bigCount}-${smallCount})`;
  else if (smallCount >= 13) sizeLabel = `Nhỏ (${bigCount}-${smallCount})`;
  else if (smallCount >= 11) sizeLabel = `Nhỏ nhẹ (${bigCount}-${smallCount})`;

  return {
    drawId: cleanId,
    drawNumber: parseInt(cleanId, 10),
    time,
    date,
    numbers: sortedNumbers,
    evenCount,
    oddCount,
    bigCount,
    smallCount,
    parityLabel,
    sizeLabel,
    sum: sortedNumbers.reduce((acc, v) => acc + v, 0),
    source
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Reliable Vietnam timezone (UTC+7) calendar & clock components
 */
export function getVnNowParts(nowDate = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(nowDate);

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const hours = parseInt(map.hour, 10) % 24;
  const minutes = parseInt(map.minute, 10);
  const seconds = parseInt(map.second, 10);

  return {
    day: parseInt(map.day, 10),
    month: parseInt(map.month, 10),
    year: parseInt(map.year, 10),
    hours,
    minutes,
    seconds,
    dateSlash: `${map.day}/${map.month}/${map.year}`,
    dateDash: `${map.day}-${map.month}-${map.year}`
  };
}

/**
 * Helper to get date string in DD-MM-YYYY format for Vietnam timezone (UTC+7)
 */
export function getVnDateStr(offsetDays = 0) {
  const vn = getVnNowParts();
  const utc = new Date(Date.UTC(vn.year, vn.month - 1, vn.day - offsetDays));
  return `${pad2(utc.getUTCDate())}-${pad2(utc.getUTCMonth() + 1)}-${utc.getUTCFullYear()}`;
}

function parseSlashDateToUtcMs(dateSlashStr) {
  if (!dateSlashStr || typeof dateSlashStr !== 'string') return null;
  const m = dateSlashStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const yyyy = parseInt(m[3], 10);
  return Date.UTC(yyyy, mm - 1, dd);
}

function formatUtcMsToDash(utcMs) {
  const d = new Date(utcMs);
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/**
 * Fetch a single page of Keno results from MinhChinh
 */
export async function fetchMinhChinhPage(page = 1, dateStr = null) {
  const url = 'https://www.minhchinh.com/xo-so-dien-toan-keno.html';
  const postBody = new URLSearchParams({
    date: dateStr || '',
    ky: '',
    number: '',
    page: String(page)
  }).toString();

  const options = {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: postBody,
    signal: AbortSignal.timeout(9000)
  };

  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`MinhChinh HTTP ${res.status}`);
  }
  const html = await res.text();
  return parseMinhChinhHtml(html);
}

/**
 * Fetch latest draw from KetQuaDienToan fallback
 */
export async function fetchKetQuaDienToanLatest() {
  const url = 'https://www.ketquadientoan.com/tat-ca-ky-xo-so-keno.html';
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    throw new Error(`KetQuaDienToan HTTP ${res.status}`);
  }
  const html = await res.text();
  return parseKetQuaDienToanHtml(html);
}

/**
 * Fetch multiple pages across multiple days (today, yesterday, day before) to guarantee no missing draws
 */
export async function fetchInitialHistory(pagesPerDay = 6) {
  const map = new Map();
  const dates = [getVnDateStr(0), getVnDateStr(1), getVnDateStr(2)];

  for (const d of dates) {
    let consecutiveEmpty = 0;
    for (let p = 1; p <= pagesPerDay; p++) {
      try {
        const list = await fetchMinhChinhPage(p, d);
        if (!list || list.length === 0) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
          continue;
        }
        consecutiveEmpty = 0;
        let newCount = 0;
        for (const item of list) {
          if (!map.has(item.drawNumber)) {
            map.set(item.drawNumber, item);
            newCount++;
          }
        }
        if (newCount === 0 && p > 2) {
          // Already have all draws from this page onward
          break;
        }
      } catch (err) {
        console.warn(`[Crawler] Warn fetching page ${p} date ${d}:`, err.message);
      }
    }
  }

  // Also check fallback in case it has a brand-new draw
  try {
    const fallbackList = await fetchKetQuaDienToanLatest();
    for (const item of fallbackList) {
      if (!map.has(item.drawNumber)) {
        map.set(item.drawNumber, item);
      }
    }
  } catch (err) {
    // Ignore fallback error if primary succeeded
  }

  // Sort ascending by drawNumber (oldest -> newest)
  return [...map.values()].sort((a, b) => a.drawNumber - b.drawNumber);
}

/**
 * Fetch older historical days strictly earlier than the current oldest stored draw
 */
export async function fetchOlderHistoryDraws(oldestDraw = null, daysToFetch = 2, pagesPerDay = 7) {
  const map = new Map();
  const vn = getVnNowParts();
  const todayUtcMs = Date.UTC(vn.year, vn.month - 1, vn.day);
  const parsedOldestMs = oldestDraw ? parseSlashDateToUtcMs(oldestDraw.date) : null;
  const anchorUtcMs = parsedOldestMs ?? todayUtcMs;

  // If the oldest draw is already the opening draw (06:08) of that day, step straight to prior days
  const hasOpeningDraw = oldestDraw && oldestDraw.time === '06:08';
  const startStep = parsedOldestMs !== null ? (hasOpeningDraw ? 1 : 0) : 3;

  const dates = [];
  for (let i = 0; i < daysToFetch; i++) {
    const dayMs = anchorUtcMs - (startStep + i) * 86400000;
    dates.push(formatUtcMsToDash(dayMs));
  }

  for (const d of dates) {
    let consecutiveEmpty = 0;
    for (let p = 1; p <= pagesPerDay; p++) {
      try {
        const list = await fetchMinhChinhPage(p, d);
        if (!list || list.length === 0) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
          continue;
        }
        consecutiveEmpty = 0;
        let newCount = 0;
        for (const item of list) {
          if (!map.has(item.drawNumber)) {
            map.set(item.drawNumber, item);
            newCount++;
          }
        }
        if (newCount === 0 && p > 2) {
          break;
        }
      } catch (err) {
        console.warn(`[Crawler] Warn fetching older page ${p} date ${d}:`, err.message);
      }
    }
  }

  return [...map.values()].sort((a, b) => a.drawNumber - b.drawNumber);
}

/**
 * Backfill any missing draws between two IDs (self-healing)
 */
export async function fetchMissingGapDraws(startDrawNumber, endDrawNumber) {
  const map = new Map();
  const dates = [getVnDateStr(0), getVnDateStr(1), getVnDateStr(2)];

  for (const d of dates) {
    for (let p = 1; p <= 7; p++) {
      try {
        const list = await fetchMinhChinhPage(p, d);
        if (!list || list.length === 0) break;
        let anyInRange = false;
        for (const item of list) {
          if (item.drawNumber >= startDrawNumber && item.drawNumber <= endDrawNumber) {
            map.set(item.drawNumber, item);
            anyInRange = true;
          }
        }
        // If oldest on page is already older than startDrawNumber, stop this date
        const minOnPage = Math.min(...list.map(x => x.drawNumber));
        if (minOnPage < startDrawNumber && !anyInRange) {
          break;
        }
      } catch (err) {
        console.warn(`[Crawler] Gap healing error on date ${d} p${p}:`, err.message);
      }
    }
  }

  return [...map.values()].sort((a, b) => a.drawNumber - b.drawNumber);
}

/**
 * Poll latest results from both sources in parallel for lowest latency
 */
export async function fetchLatestDraws() {
  const results = await Promise.allSettled([
    fetchMinhChinhPage(1),
    fetchMinhChinhPage(2),
    fetchKetQuaDienToanLatest()
  ]);

  const map = new Map();
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      for (const item of r.value) {
        map.set(item.drawNumber, item);
      }
    }
  }

  return [...map.values()].sort((a, b) => a.drawNumber - b.drawNumber);
}

/**
 * Compute next Keno draw schedule info (8-minute cycle from 06:08 to 21:52 Vietnam Time)
 */
export function getNextDrawSchedule(latestDraw = null) {
  const vn = getVnNowParts();
  const { hours, minutes, seconds, dateSlash } = vn;
  const totalMinutes = hours * 60 + minutes;

  const firstDrawMin = 6 * 60 + 8; // 06:08 (368) - actual first Vietlott Keno draw of day
  const lastDrawMin = 21 * 60 + 52; // 21:52 (1312) - actual final draw of day

  let nextDrawTotalMin;
  let isOperatingHours = true;

  if (totalMinutes < firstDrawMin) {
    nextDrawTotalMin = firstDrawMin;
    isOperatingHours = false;
  } else if (totalMinutes >= lastDrawMin) {
    nextDrawTotalMin = firstDrawMin + 24 * 60;
    isOperatingHours = false;
  } else {
    // Next multiple of 8 minutes strictly greater than current minute
    const remainder = totalMinutes % 8;
    nextDrawTotalMin = totalMinutes + (8 - remainder);
  }

  const secondsUntilNextSchedule =
    (nextDrawTotalMin - totalMinutes) * 60 - seconds;

  const nextHour = Math.floor((nextDrawTotalMin % (24 * 60)) / 60);
  const nextMin = nextDrawTotalMin % 60;
  const nextTimeStr = `${pad2(nextHour)}:${pad2(nextMin)}`;

  let awaitingNewResult = false;
  let expectedDrawTimeStr = nextTimeStr;
  const expectedDrawId = latestDraw ? String(latestDraw.drawNumber + 1) : '---';

  // Grace window up to 21:57 so the 21:52 closing draw is caught after 21:52:00
  const isPostCloseGrace = totalMinutes >= lastDrawMin && totalMinutes <= lastDrawMin + 5;

  if (isOperatingHours || isPostCloseGrace) {
    const isLatestToday = latestDraw && latestDraw.date === dateSlash;

    if (isLatestToday) {
      const [latestH, latestM] = (latestDraw.time || '').split(':').map((x) => parseInt(x, 10));
      if (!Number.isNaN(latestH) && !Number.isNaN(latestM)) {
        const latestTotalMin = latestH * 60 + latestM;
        const currentSlotMin = totalMinutes >= lastDrawMin ? lastDrawMin : totalMinutes - (totalMinutes % 8);
        if (
          currentSlotMin >= firstDrawMin &&
          currentSlotMin > latestTotalMin &&
          currentSlotMin - latestTotalMin <= 60
        ) {
          awaitingNewResult = true;
          const expMin = Math.min(lastDrawMin, latestTotalMin + 8);
          expectedDrawTimeStr = `${pad2(Math.floor(expMin / 60))}:${pad2(expMin % 60)}`;
        }
      }
    } else if (totalMinutes >= firstDrawMin && totalMinutes < firstDrawMin + 16) {
      // Waiting for today's opening draw(s) starting 06:08 while latestDraw is from previous day
      awaitingNewResult = true;
      expectedDrawTimeStr = '06:08';
    }
  }

  return {
    nowTimeStr: `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`,
    nextDrawTimeStr: nextTimeStr,
    expectedDrawTimeStr,
    expectedDrawId,
    secondsUntilNextSchedule: Math.max(0, secondsUntilNextSchedule),
    awaitingNewResult,
    isOperatingHours
  };
}

