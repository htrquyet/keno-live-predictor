import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchInitialHistory,
  fetchLatestDraws,
  fetchMissingGapDraws,
  fetchOlderHistoryDraws,
  getNextDrawSchedule,
  normalizeDraw
} from './crawler.mjs';
import { analyzeAndPredictNextDraw, STRATEGIES, DEFAULT_STRATEGY } from './predictor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bingo18_history.json');
const MAX_HISTORY_DRAWS = 2500;

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3080;

const drawMap = new Map();
let currentMode = DEFAULT_STRATEGY;
let cachedAnalysis = null;
let lastPollTime = null;
let lastPollCompletedMs = 0;
let lastPollStatus = 'Khởi động...';
let isPolling = false;
let activePollPromise = null;
const sseClients = new Set();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadHistoryFromDisk() {
  ensureDataDir();
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && item.drawNumber && Array.isArray(item.numbers) && item.numbers.length === 3) {
            const norm = normalizeDraw(item.drawId || item.drawNumber, item.date, item.numbers, item.source || 'disk', item.time);
            drawMap.set(norm.drawNumber, norm);
          }
        }
      }
      console.log(`[Server] Loaded ${drawMap.size} historical Bingo18 draws from disk.`);
    } catch (err) {
      console.warn('[Server] Could not parse bingo18_history.json:', err.message);
    }
  }
}

function saveHistoryToDisk() {
  ensureDataDir();
  const sorted = getSortedDraws();
  if (sorted.length > MAX_HISTORY_DRAWS) {
    const dropped = sorted.slice(0, sorted.length - MAX_HISTORY_DRAWS);
    for (const d of dropped) {
      drawMap.delete(d.drawNumber);
    }
  }
  const trimmed = sorted.slice(-MAX_HISTORY_DRAWS);
  const jsonText = JSON.stringify(trimmed, null, 2);
  const tmpFile = `${DATA_FILE}.tmp`;
  try {
    fs.writeFileSync(tmpFile, jsonText, 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
  } catch {
    fs.writeFileSync(DATA_FILE, jsonText, 'utf8');
  }
}

function getSortedDraws() {
  return [...drawMap.values()].sort((a, b) => a.drawNumber - b.drawNumber);
}

function getCurrentSchedule() {
  const draws = getSortedDraws();
  const latestDraw = draws.length > 0 ? draws[draws.length - 1] : null;
  return getNextDrawSchedule(latestDraw);
}

function recomputeAnalysis() {
  const draws = getSortedDraws();
  cachedAnalysis = analyzeAndPredictNextDraw(draws, currentMode);
  return cachedAnalysis;
}

function buildStatePayload(mode = currentMode) {
  const draws = getSortedDraws();
  const analysis =
    mode === currentMode && cachedAnalysis
      ? cachedAnalysis
      : analyzeAndPredictNextDraw(draws, mode);
  const latestDraw = draws.length > 0 ? draws[draws.length - 1] : null;
  const schedule = getNextDrawSchedule(latestDraw);

  return {
    serverTime: new Date().toISOString(),
    lastPollTime,
    lastPollStatus,
    isPolling,
    schedule,
    recentDraws: [...draws].reverse().slice(0, 50),
    syncDraws: draws.slice(-1000),
    analysis
  };
}

function broadcastSse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

/**
 * Poll live sources and merge any new Bingo18 draws into the dataset
 */
async function pollNow(isInitial = false, maxBatches = 15) {
  if (activePollPromise) {
    return activePollPromise;
  }

  activePollPromise = (async () => {
    isPolling = true;
    lastPollStatus = isInitial
      ? 'Đang đồng bộ lịch sử Bingo18...'
      : 'Đang quét kết quả Bingo18 kỳ mới...';
    broadcastSse('poll_status', { isPolling, lastPollStatus, schedule: getCurrentSchedule() });

    let added = 0;
    let newestDraw = null;

    try {
      const prevMaxDraw = drawMap.size > 0 ? Math.max(...drawMap.keys()) : 0;
      const knownIds = new Set(drawMap.keys());

      const mergeAndFlushBatch = (batch) => {
        let batchAdded = 0;
        for (const d of batch) {
          if (!drawMap.has(d.drawNumber)) {
            drawMap.set(d.drawNumber, d);
            added++;
            batchAdded++;
            if (d.drawNumber > prevMaxDraw && (!newestDraw || d.drawNumber > newestDraw.drawNumber)) {
              newestDraw = d;
            }
          }
        }
        if (batchAdded > 0) {
          lastPollTime = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
          saveHistoryToDisk();
          recomputeAnalysis();
          lastPollStatus = newestDraw
            ? `Kỳ mới #${newestDraw.drawId} (${newestDraw.time}) · Mẫu: ${drawMap.size} kỳ`
            : `Đã cập nhật mẫu: ${drawMap.size} kỳ`;
          broadcastSse('state_update', buildStatePayload(currentMode));
        }
      };

      const fetched = isInitial
        ? await fetchInitialHistory(maxBatches, {
            knownIds,
            maxKnownId: prevMaxDraw,
            onProgress: mergeAndFlushBatch
          })
        : await fetchLatestDraws();

      for (const d of fetched) {
        if (!drawMap.has(d.drawNumber)) {
          drawMap.set(d.drawNumber, d);
          added++;
          if (d.drawNumber > prevMaxDraw && (!newestDraw || d.drawNumber > newestDraw.drawNumber)) {
            newestDraw = d;
          }
        }
      }

      if (prevMaxDraw > 0 && newestDraw && newestDraw.drawNumber - prevMaxDraw > 1) {
        let gapStillExists = false;
        for (let k = prevMaxDraw + 1; k < newestDraw.drawNumber; k++) {
          if (!drawMap.has(k)) {
            gapStillExists = true;
            break;
          }
        }
        if (gapStillExists) {
          console.log(`[Poll] Auto-healing gap #${prevMaxDraw + 1}..#${newestDraw.drawNumber - 1}`);
          try {
            const gapDraws = await fetchMissingGapDraws(prevMaxDraw + 1, newestDraw.drawNumber - 1);
            for (const gd of gapDraws) {
              if (!drawMap.has(gd.drawNumber)) {
                drawMap.set(gd.drawNumber, gd);
                added++;
              }
            }
          } catch (err) {
            console.warn('[Poll] Gap heal error:', err.message);
          }
        }
      }

      lastPollTime = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      lastPollCompletedMs = Date.now();

      if (added > 0) {
        saveHistoryToDisk();
        recomputeAnalysis();
        lastPollStatus = newestDraw
          ? `Kỳ mới #${newestDraw.drawId} (${newestDraw.time}) · Mẫu tích lũy: ${drawMap.size} kỳ`
          : `Đã mở rộng mẫu: ${drawMap.size} kỳ`;

        const fullState = buildStatePayload(currentMode);
        broadcastSse(newestDraw && !isInitial ? 'new_draw' : 'state_update', fullState);
      } else {
        lastPollStatus = `Mẫu tích lũy: ${drawMap.size} kỳ · Lúc ${lastPollTime}`;
      }
    } catch (err) {
      lastPollStatus = `Lỗi kết nối nguồn (${err.message}) - dùng mẫu ${drawMap.size} kỳ`;
      console.warn('[Poll] Error:', err.message);
    } finally {
      isPolling = false;
      activePollPromise = null;
      broadcastSse('poll_status', {
        isPolling,
        lastPollStatus,
        lastPollTime,
        schedule: getCurrentSchedule()
      });
    }

    return { added, newestDraw, totalSample: drawMap.size };
  })();

  return activePollPromise;
}

/**
 * Load older historical draws strictly preceding the oldest stored draw
 */
async function expandHistoryNow(batches = 15) {
  if (activePollPromise) {
    try {
      await activePollPromise;
    } catch {
      // Ignore prior error
    }
  }

  if (drawMap.size >= MAX_HISTORY_DRAWS) {
    return { added: 0, limitReached: true, totalSample: drawMap.size };
  }

  activePollPromise = (async () => {
    isPolling = true;
    lastPollStatus = `Đang nạp thêm ${batches * 10} kỳ Bingo18 cũ hơn...`;
    broadcastSse('poll_status', { isPolling, lastPollStatus, schedule: getCurrentSchedule() });

    let added = 0;
    let limitReached = false;

    try {
      const sorted = getSortedDraws();
      const oldestDraw = sorted.length > 0 ? sorted[0] : null;
      const fetched = await fetchOlderHistoryDraws(oldestDraw, batches, drawMap.size);

      const beforeIds = new Set(drawMap.keys());
      for (const d of fetched) {
        if (!drawMap.has(d.drawNumber)) {
          drawMap.set(d.drawNumber, d);
        }
      }

      if (drawMap.size > MAX_HISTORY_DRAWS) {
        limitReached = true;
      }
      saveHistoryToDisk();

      for (const id of drawMap.keys()) {
        if (!beforeIds.has(id)) added++;
      }

      lastPollTime = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

      if (added > 0) {
        recomputeAnalysis();
        lastPollStatus = `Đã nạp thêm ${added} kỳ cũ · Tổng mẫu: ${drawMap.size} kỳ`;
        broadcastSse('state_update', buildStatePayload(currentMode));
      } else {
        lastPollStatus = `Mẫu tích lũy: ${drawMap.size} kỳ · Lúc ${lastPollTime}`;
      }
    } catch (err) {
      lastPollStatus = `Lỗi nạp kỳ cũ (${err.message}) - dùng mẫu ${drawMap.size} kỳ`;
    } finally {
      isPolling = false;
      activePollPromise = null;
      broadcastSse('poll_status', {
        isPolling,
        lastPollStatus,
        lastPollTime,
        schedule: getCurrentSchedule()
      });
    }

    return { added, limitReached, totalSample: drawMap.size };
  })();

  return activePollPromise;
}

// Smart 6-Minute Scheduler Loop
let lastQuickPollMs = 0;
let lastRegularPollMs = 0;

function startSmartPollingLoop() {
  setInterval(() => {
    const schedule = getCurrentSchedule();
    const nowMs = Date.now();

    const isHotWindow =
      schedule.awaitingNewResult ||
      (schedule.isOperatingHours &&
        (schedule.secondsUntilNextSchedule <= 5 ||
          (schedule.secondsUntilNextSchedule >= 340 && schedule.secondsUntilNextSchedule <= 360)));

    if (isHotWindow) {
      if (nowMs - lastQuickPollMs >= 4000) {
        lastQuickPollMs = nowMs;
        lastRegularPollMs = nowMs;
        pollNow(false);
      }
    } else {
      const intervalMs = schedule.isOperatingHours ? 18000 : 120000;
      if (nowMs - lastRegularPollMs >= intervalMs) {
        lastRegularPollMs = nowMs;
        pollNow(false);
      }
    }
  }, 1000);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    res.write(`event: init\ndata: ${JSON.stringify(buildStatePayload(currentMode))}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    const sched = getCurrentSchedule();
    if (!isPolling && (Date.now() - lastPollCompletedMs > 15000 || sched.awaitingNewResult)) {
      pollNow(false);
    }
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const reqMode = urlObj.searchParams.get('mode') || currentMode;
    if (STRATEGIES[reqMode] && reqMode !== currentMode) {
      currentMode = reqMode;
      recomputeAnalysis();
    }
    const payload = buildStatePayload(currentMode);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (pathname === '/api/client-sync' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 512000) break;
    }
    let added = 0;
    try {
      const parsed = JSON.parse(body || '{}');
      const clientDraws = Array.isArray(parsed.draws) ? parsed.draws : [];
      for (const item of clientDraws) {
        if (
          item &&
          (item.drawId || item.drawNumber) &&
          item.date &&
          Array.isArray(item.numbers) &&
          item.numbers.length === 3
        ) {
          const norm = normalizeDraw(item.drawId || item.drawNumber, item.date, item.numbers, item.source || 'client-cache', item.time);
          if (norm.drawNumber > 0 && !drawMap.has(norm.drawNumber)) {
            drawMap.set(norm.drawNumber, norm);
            added++;
          }
        }
      }
      if (added > 0) {
        saveHistoryToDisk();
        recomputeAnalysis();
        broadcastSse('state_update', buildStatePayload(currentMode));
      }
    } catch (err) {
      console.warn('[ClientSync] Invalid payload:', err.message);
    }
    const payload = buildStatePayload(currentMode);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...payload, syncAdded: added }));
    return;
  }

  if (pathname === '/api/refresh' && req.method === 'POST') {
    const result = await pollNow(false);
    const payload = buildStatePayload(currentMode);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...payload, refreshResult: result }));
    return;
  }

  if (pathname === '/api/expand-history' && req.method === 'POST') {
    const rawBatches = parseInt(urlObj.searchParams.get('batches') || '15', 10);
    const batches = Math.min(30, Math.max(5, Number.isNaN(rawBatches) ? 15 : rawBatches));
    const result = await expandHistoryNow(batches);
    const payload = buildStatePayload(currentMode);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...payload, refreshResult: result }));
    return;
  }

  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

loadHistoryFromDisk();
recomputeAnalysis();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🎲 VIETLOTT BINGO18 LIVE ANALYTICS & PREDICTOR RUNNING`);
  console.log(`🌐 Mở trình duyệt tại: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
  pollNow(true);
  startSmartPollingLoop();
});
