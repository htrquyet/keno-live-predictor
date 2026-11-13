import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchInitialHistory,
  fetchLatestDraws,
  fetchMissingGapDraws,
  fetchOlderHistoryDraws,
  getNextDrawSchedule
} from './crawler.mjs';
import { analyzeAndPredictNextDraw } from './predictor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'keno_history.json');
const MAX_HISTORY_DRAWS = 2000;

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3080;

// In-memory store
const drawMap = new Map();
let currentMode = 'adaptive';
let cachedAnalysis = null;
let lastPollTime = null;
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
          if (item && item.drawNumber && Array.isArray(item.numbers) && item.numbers.length === 20) {
            drawMap.set(item.drawNumber, item);
          }
        }
      }
      console.log(`[Server] Loaded ${drawMap.size} historical draws from disk.`);
    } catch (err) {
      console.warn('[Server] Could not parse keno_history.json:', err.message);
    }
  }
}

function saveHistoryToDisk() {
  ensureDataDir();
  const sorted = getSortedDraws();
  // Keep up to MAX_HISTORY_DRAWS draws in both memory and disk so expanding history stays bounded and synced
  if (sorted.length > MAX_HISTORY_DRAWS) {
    const dropped = sorted.slice(0, sorted.length - MAX_HISTORY_DRAWS);
    for (const d of dropped) {
      drawMap.delete(d.drawNumber);
    }
  }
  const trimmed = sorted.slice(-MAX_HISTORY_DRAWS);
  fs.writeFileSync(DATA_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
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
    recentDraws: [...draws].reverse().slice(0, 30),
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
 * Poll live sources and merge any new draws into the expanding dataset
 */
async function pollNow(isInitial = false, pagesToFetch = 6) {
  if (activePollPromise) {
    return activePollPromise;
  }

  activePollPromise = (async () => {
    isPolling = true;
    lastPollStatus = isInitial
      ? `Đang nạp sâu mẫu lịch sử (${pagesToFetch} trang)...`
      : 'Đang quét kết quả kỳ mới...';
    broadcastSse('poll_status', { isPolling, lastPollStatus, schedule: getCurrentSchedule() });

    let added = 0;
    let newestDraw = null;

    try {
      const fetched = isInitial ? await fetchInitialHistory(pagesToFetch) : await fetchLatestDraws();
      const prevMaxDraw = drawMap.size > 0 ? Math.max(...drawMap.keys()) : 0;

      for (const d of fetched) {
        if (!drawMap.has(d.drawNumber)) {
          drawMap.set(d.drawNumber, d);
          added++;
          if (d.drawNumber > prevMaxDraw) {
            newestDraw = d;
          }
        }
      }

      // Auto-detect and heal any gaps if Render slept or draws were missed
      if (prevMaxDraw > 0 && newestDraw && newestDraw.drawNumber - prevMaxDraw > 1) {
        const missingCount = newestDraw.drawNumber - prevMaxDraw - 1;
        console.log(`[Poll] Detected gap of ${missingCount} draws between #${prevMaxDraw} and #${newestDraw.drawNumber}. Auto-healing...`);
        try {
          const gapDraws = await fetchMissingGapDraws(prevMaxDraw + 1, newestDraw.drawNumber - 1);
          for (const gd of gapDraws) {
            if (!drawMap.has(gd.drawNumber)) {
              drawMap.set(gd.drawNumber, gd);
              added++;
            }
          }
        } catch (err) {
          console.warn('[Poll] Gap healing error:', err.message);
        }
      }

      // Check for any internal historical gaps on initial load
      if (isInitial && drawMap.size > 1) {
        const sortedKeys = [...drawMap.keys()].sort((a, b) => a - b);
        for (let i = 1; i < sortedKeys.length; i++) {
          const prevId = sortedKeys[i - 1];
          const currId = sortedKeys[i];
          if (currId - prevId > 1 && currId - prevId <= 250) {
            console.log(`[Poll] Healing startup internal gap between #${prevId} and #${currId}...`);
            try {
              const healed = await fetchMissingGapDraws(prevId + 1, currId - 1);
              for (const hd of healed) {
                if (!drawMap.has(hd.drawNumber)) {
                  drawMap.set(hd.drawNumber, hd);
                  added++;
                }
              }
            } catch (err) {
              console.warn('[Poll] Startup gap heal error:', err.message);
            }
          }
        }
      }

      lastPollTime = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

      if (added > 0) {
        saveHistoryToDisk();
        recomputeAnalysis();
        lastPollStatus = newestDraw
          ? `Kỳ mới #${newestDraw.drawId} (${newestDraw.time}) · Mẫu tích lũy: ${drawMap.size} kỳ`
          : `Đã mở rộng mẫu tính toán: ${drawMap.size} kỳ`;

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
 * Load older historical days strictly preceding the oldest draw currently stored
 */
async function expandHistoryNow(days = 2, pagesPerDay = 7) {
  if (activePollPromise) {
    try {
      await activePollPromise;
    } catch {
      // Proceed even if prior poll failed
    }
  }

  if (drawMap.size >= MAX_HISTORY_DRAWS) {
    return { added: 0, limitReached: true, totalSample: drawMap.size };
  }

  activePollPromise = (async () => {
    isPolling = true;
    lastPollStatus = `Đang nạp thêm ${days} ngày kỳ cũ hơn để mở rộng mẫu...`;
    broadcastSse('poll_status', { isPolling, lastPollStatus, schedule: getCurrentSchedule() });

    let added = 0;
    let limitReached = false;

    try {
      const sorted = getSortedDraws();
      const oldestDraw = sorted.length > 0 ? sorted[0] : null;
      const fetched = await fetchOlderHistoryDraws(oldestDraw, days, pagesPerDay);

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
      console.warn('[ExpandHistory] Error:', err.message);
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

// Smart Scheduler Loop
let lastQuickPollMs = 0;
let lastRegularPollMs = 0;

function startSmartPollingLoop() {
  setInterval(() => {
    const schedule = getCurrentSchedule();
    const nowMs = Date.now();

    // Hot window: waiting for overdue/closing draw or right around an 8-min draw boundary during operating hours
    const isHotWindow =
      schedule.awaitingNewResult ||
      (schedule.isOperatingHours &&
        (schedule.secondsUntilNextSchedule <= 4 ||
          (schedule.secondsUntilNextSchedule >= 460 && schedule.secondsUntilNextSchedule <= 480)));

    if (isHotWindow) {
      if (nowMs - lastQuickPollMs >= 4500) {
        lastQuickPollMs = nowMs;
        lastRegularPollMs = nowMs;
        pollNow(false);
      }
    } else {
      const intervalMs = schedule.isOperatingHours ? 20000 : 120000;
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

  // Enable CORS for local dev convenience
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE Endpoint
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
    return;
  }

  // State API
  if (pathname === '/api/state' && req.method === 'GET') {
    const reqMode = urlObj.searchParams.get('mode') || currentMode;
    if (['adaptive', 'hot', 'due', 'markov'].includes(reqMode)) {
      currentMode = reqMode;
      recomputeAnalysis();
    }
    const payload = buildStatePayload(currentMode);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return;
  }

  // Force Refresh API
  if (pathname === '/api/refresh' && req.method === 'POST') {
    const result = await pollNow(false);
    const payload = buildStatePayload(currentMode);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...payload, refreshResult: result }));
    return;
  }

  // Deep History Sample Expansion API (crawl older days preceding current oldest stored draw)
  if (pathname === '/api/expand-history' && req.method === 'POST') {
    const rawDays = parseInt(urlObj.searchParams.get('days') || '2', 10);
    const rawPages = parseInt(urlObj.searchParams.get('pages') || '7', 10);
    const days = Math.min(5, Math.max(1, Number.isNaN(rawDays) ? 2 : rawDays));
    const pages = Math.min(10, Math.max(5, Number.isNaN(rawPages) ? 7 : rawPages));
    const result = await expandHistoryNow(days, pages);
    const payload = buildStatePayload(currentMode);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...payload, refreshResult: result }));
    return;
  }

  // Static files
  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  // Prevent directory traversal
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

// Initialize
loadHistoryFromDisk();
recomputeAnalysis();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🎯 KENO 80 LIVE PREDICTOR SERVER RUNNING`);
  console.log(`🌐 Mở trình duyệt tại: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
  // Trigger initial multi-page crawl in background
  pollNow(true);
  startSmartPollingLoop();
});

