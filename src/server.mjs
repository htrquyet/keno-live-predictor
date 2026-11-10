import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchInitialHistory,
  fetchLatestDraws,
  getNextDrawSchedule
} from './crawler.mjs';
import { analyzeAndPredictNextDraw } from './predictor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'keno_history.json');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3080;

// In-memory store
const drawMap = new Map();
let currentMode = 'adaptive';
let cachedAnalysis = null;
let lastPollTime = null;
let lastPollStatus = 'Khởi động...';
let isPolling = false;
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
  // Keep up to 2000 draws so the expanding window (N -> N+1 -> N+2...) continuously grows without losing history
  const trimmed = sorted.slice(-2000);
  fs.writeFileSync(DATA_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

function getSortedDraws() {
  return [...drawMap.values()].sort((a, b) => a.drawNumber - b.drawNumber);
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
  if (isPolling) return { added: 0 };
  isPolling = true;
  lastPollStatus = isInitial
    ? `Đang nạp sâu mẫu lịch sử (${pagesToFetch} trang)...`
    : 'Đang quét kết quả kỳ mới...';
  broadcastSse('poll_status', { isPolling, lastPollStatus });

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
    broadcastSse('poll_status', { isPolling, lastPollStatus, lastPollTime });
  }

  return { added, newestDraw, totalSample: drawMap.size };
}

// Smart Scheduler Loop
let lastQuickPollMs = 0;
let lastRegularPollMs = 0;

function startSmartPollingLoop() {
  setInterval(() => {
    const draws = getSortedDraws();
    const latestDraw = draws.length > 0 ? draws[draws.length - 1] : null;
    const schedule = getNextDrawSchedule(latestDraw);
    const nowMs = Date.now();

    // If a draw time just passed and we are awaiting the new draw result, poll every 4 seconds!
    // Also poll rapidly when secondsUntilNextSchedule <= 5 or >= 465 (just after 8-min mark)
    const isHotWindow =
      schedule.awaitingNewResult ||
      schedule.secondsUntilNextSchedule <= 4 ||
      schedule.secondsUntilNextSchedule >= 460;

    if (isHotWindow) {
      if (nowMs - lastQuickPollMs >= 4500) {
        lastQuickPollMs = nowMs;
        lastRegularPollMs = nowMs;
        pollNow(false);
      }
    } else {
      // Otherwise poll every 20 seconds to stay fresh
      if (nowMs - lastRegularPollMs >= 20000) {
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

  // Deep History Sample Expansion API (fetch up to 10 pages from MinhChinh to enlarge N)
  if (pathname === '/api/expand-history' && req.method === 'POST') {
    const pages = Math.min(12, Math.max(4, parseInt(urlObj.searchParams.get('pages') || '10', 10)));
    const result = await pollNow(true, pages);
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

