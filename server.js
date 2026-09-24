import './src/env.js'; // must be first: loads .env before anything reads process.env
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { createStore } from './src/store.js';
import { Game } from './src/game.js';
import { converse, MODELS, defaultModelId, region, toBedrockError, checkCredentials } from './src/llm/bedrock.js';
import { createJudge } from './src/llm/grouping.js';
import { createBotBrain } from './src/bots.js';

// 7420 sits clear of the ports used by other local repos (3000, 5433, 6379, 9200, ...).
const PORT = Number(process.env.PORT) || 7420;
const HOST = process.env.HOST || '0.0.0.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

// ---------------------------------------------------------------------------
// Join URL: PUBLIC_URL wins (e.g. a tunnel or deployed URL), otherwise the LAN IP.
// ---------------------------------------------------------------------------

function findLanAddress() {
  const skip = /^(lo|docker|br-|veth|utun|awdl|llw|bridge|vboxnet|vmnet|tailscale|gif|stf|anpi|ap)/i;
  const preferred = /^(en|eth|wlan|wl)/i;
  const candidates = [];

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue; // link-local, unreachable
      candidates.push({ name, address: addr.address });
    }
  }

  candidates.sort((a, b) => {
    const pa = preferred.test(a.name) ? 0 : 1;
    const pb = preferred.test(b.name) ? 0 : 1;
    return pa - pb || a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  return candidates[0]?.address ?? 'localhost';
}

const baseUrl = (process.env.PUBLIC_URL || `http://${findLanAddress()}:${PORT}`).replace(/\/+$/, '');
const joinUrl = `${baseUrl}/join`;

// ---------------------------------------------------------------------------
// Storage + game
// ---------------------------------------------------------------------------

const store = createStore(DATA_DIR);

// Host controls are allowed from this laptop (localhost) without a key. From any other
// device, or through a tunnel, the host needs ?key=... (printed on startup).
const HOST_KEY =
  process.env.HOST_KEY ||
  store.read('host-key.json', null)?.key ||
  (() => {
    const key = randomBytes(6).toString('hex');
    store.writeNow('host-key.json', { key });
    return key;
  })();

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const playerSockets = new Map();
const hostSockets = new Set();

// AI grouping for free-text answers. On by default; any failure falls back to text matching.
const judge = createJudge({
  converse,
  enabled: !/^(off|false|0|no)$/i.test(process.env.LLM_GROUPING ?? ''),
  modelId: process.env.LLM_GROUPING_MODEL_ID || undefined,
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 8000,
});

// Bots fill games with fewer than BOTS_MIN_PLAYERS humans (default 3; 0 turns bots off).
// Their free-text answers come from the LLM when available, otherwise from canned lists.
const minPlayers = process.env.BOTS_MIN_PLAYERS === undefined ? 3 : Math.max(0, Number(process.env.BOTS_MIN_PLAYERS) || 0);
const botBrain = createBotBrain({
  converse,
  enabled: judge.status.enabled && !/^(off|false|0|no)$/i.test(process.env.LLM_BOTS ?? ''),
  modelId: process.env.LLM_GROUPING_MODEL_ID || undefined,
});

const game = new Game(store, {
  onChange: () => scheduleBroadcast(),
  isOnline: (id) => (playerSockets.get(id)?.size ?? 0) > 0,
  judge,
  botBrain,
  minPlayers,
});

function isHostRequest(req, key) {
  if (key && key === HOST_KEY) return true;
  const addr = req.socket.remoteAddress ?? '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  // Tunnels (cloudflared, ngrok) connect from localhost but add forwarding headers.
  const proxied = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'];
  return loopback && !proxied;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const PAGES = {
  '/': 'host.html',
  '/join': 'join.html',
  '/questions': 'questions.html',
  '/llm': 'llm.html',
};

async function sendFile(res, file) {
  try {
    const body = await readFile(path.join(PUBLIC_DIR, file));
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;

  try {
    if (pathname === '/api/info') {
      const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return sendJson(res, 200, { joinUrl, qrSvg });
    }

    if (pathname.startsWith('/api/questions')) {
      const key = url.searchParams.get('key') || req.headers['x-host-key'];
      if (!isHostRequest(req, key)) return sendJson(res, 403, { error: 'Host only.' });
      const editable = game.state.phase === 'lobby';

      if (pathname === '/api/questions' && req.method === 'GET') {
        return sendJson(res, 200, { ...game.library, editable });
      }
      if (pathname === '/api/questions' && req.method === 'PUT') {
        const library = game.setLibrary(await readJsonBody(req));
        return sendJson(res, 200, { ...library, editable });
      }
      if (pathname === '/api/questions/reset' && req.method === 'POST') {
        const library = game.resetLibrary();
        return sendJson(res, 200, { ...library, editable });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (pathname.startsWith('/api/llm')) {
      const key = url.searchParams.get('key') || req.headers['x-host-key'];
      if (!isHostRequest(req, key)) return sendJson(res, 403, { error: 'Host only.' });
      return handleLlm(req, res, pathname);
    }

    if (PAGES[pathname]) return sendFile(res, PAGES[pathname]);

    // Static assets: only plain filenames from /public, no path traversal.
    const file = pathname.slice(1);
    if (/^[\w-]+\.(css|js|svg)$/.test(file)) return sendFile(res, file);

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

// ---------------------------------------------------------------------------
// LLM test route: each request is a single, history-free prompt to Bedrock.
// ---------------------------------------------------------------------------

function llmModels() {
  const models = { ...MODELS };
  const configured = defaultModelId();
  if (!models[configured]) models[configured] = `${configured} (BEDROCK_MODEL_ID)`;
  return models;
}

async function handleLlm(req, res, pathname) {
  if (pathname === '/api/llm/models' && req.method === 'GET') {
    return sendJson(res, 200, { models: llmModels(), defaultModelId: defaultModelId(), region: region() });
  }
  if (pathname !== '/api/llm' || req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' });

  const body = await readJsonBody(req);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const system = typeof body.system === 'string' ? body.system.trim() : '';
  const modelId = body.modelId || defaultModelId();
  const maxTokens = body.maxTokens === undefined ? 1024 : Number(body.maxTokens);
  const temperature = body.temperature === undefined || body.temperature === '' ? undefined : Number(body.temperature);

  if (!prompt) return sendJson(res, 400, { error: 'Type a prompt first.' });
  if (prompt.length > 8000 || system.length > 4000) return sendJson(res, 400, { error: 'Prompt is too long.' });
  if (!llmModels()[modelId]) return sendJson(res, 400, { error: `Unknown model "${modelId}".` });
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
    return sendJson(res, 400, { error: 'Max tokens must be a whole number from 1 to 4096.' });
  }
  if (temperature !== undefined && !(temperature >= 0 && temperature <= 1)) {
    return sendJson(res, 400, { error: 'Temperature must be between 0 and 1.' });
  }

  try {
    const result = await converse({
      modelId,
      system: system || undefined,
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
      temperature,
    });
    console.log(`LLM ${modelId}: ${result.latencyMs} ms, ${result.usage?.outputTokens ?? '?'} output tokens`);
    return sendJson(res, 200, result);
  } catch (err) {
    const e = toBedrockError(err, { modelId });
    console.error(`LLM error: ${e.message}`);
    return sendJson(res, e.status, { error: e.message, code: e.code });
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// Coalesce many changes in the same tick (e.g. a burst of answers) into one broadcast.
let broadcastQueued = false;
function scheduleBroadcast() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setImmediate(() => {
    broadcastQueued = false;
    const hostState = game.hostView();
    for (const ws of hostSockets) send(ws, { type: 'state', state: hostState });

    const board = game.leaderboard();
    for (const [playerId, sockets] of playerSockets) {
      const state = game.playerView(playerId, board);
      for (const ws of sockets) send(ws, { type: 'state', state });
    }
    for (const ws of wss.clients) {
      if (!ws.isHost && !ws.playerId) send(ws, { type: 'state', state: game.playerView(null, board) });
    }
  });
}

function attachPlayer(ws, playerId) {
  if (ws.playerId && ws.playerId !== playerId) detachPlayer(ws);
  ws.playerId = playerId;
  if (!playerSockets.has(playerId)) playerSockets.set(playerId, new Set());
  playerSockets.get(playerId).add(ws);
}

function detachPlayer(ws) {
  const sockets = playerSockets.get(ws.playerId);
  if (sockets) {
    sockets.delete(ws);
    if (sockets.size === 0) playerSockets.delete(ws.playerId);
  }
  ws.playerId = null;
}

function handleHostCommand(ws, msg) {
  switch (msg.action) {
    case 'next':
      return game.next();
    case 'close':
      return game.close();
    case 'settings':
      return game.setSettings(msg.settings);
    case 'restart':
      return game.restart({ clearPlayers: false });
    case 'reset':
      return game.restart({ clearPlayers: true });
    case 'kick': {
      const sockets = [...(playerSockets.get(msg.playerId) ?? [])];
      if (game.kick(msg.playerId)) {
        for (const s of sockets) {
          send(s, { type: 'kicked' });
          detachPlayer(s);
        }
      }
      return;
    }
    default:
      throw new Error('Unknown command.');
  }
}

wss.on('connection', (ws, req) => {
  ws.isHost = false;
  ws.playerId = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    try {
      switch (msg.type) {
        case 'host':
          if (!isHostRequest(req, msg.key)) {
            send(ws, { type: 'host-denied' });
            return;
          }
          ws.isHost = true;
          hostSockets.add(ws);
          send(ws, { type: 'state', state: game.hostView() });
          return;

        case 'cmd':
          if (!ws.isHost) throw new Error('Host only.');
          handleHostCommand(ws, msg);
          return;

        case 'hello': // a phone that hasn't joined yet (or whose player was reset)
          send(ws, { type: 'state', state: game.playerView(null) });
          return;

        case 'join': {
          const player = game.join(msg.name, msg.playerId);
          attachPlayer(ws, player.id);
          send(ws, { type: 'joined', player: { id: player.id, name: player.name } });
          console.log(`+ ${player.name} joined (${Object.keys(game.state.players).length} players)`);
          scheduleBroadcast();
          return;
        }

        case 'rejoin': {
          const player = game.getPlayer(msg.playerId);
          if (!player) {
            send(ws, { type: 'unknown-player' });
            send(ws, { type: 'state', state: game.playerView(null) });
            return;
          }
          attachPlayer(ws, player.id);
          send(ws, { type: 'joined', player: { id: player.id, name: player.name } });
          scheduleBroadcast();
          return;
        }

        case 'answer':
          if (!ws.playerId) throw new Error('Join the game first.');
          game.answer(ws.playerId, msg.value);
          return;
      }
    } catch (err) {
      send(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    hostSockets.delete(ws);
    if (ws.playerId) {
      detachPlayer(ws);
      scheduleBroadcast();
    }
  });
});

// Keep connections healthy: phones that sleep can leave half-open sockets behind.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.alive === false) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 15000);
wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
});

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

server.listen(PORT, HOST, () => {
  const s = game.state;
  console.log('');
  console.log('  Herd Mentality is running');
  console.log(`  Host screen:   http://localhost:${PORT}`);
  console.log(`  Players join:  ${joinUrl}`);
  console.log(`  Host from another device: ${baseUrl}/?key=${HOST_KEY}`);
  console.log(`  Saving to:     ${DATA_DIR}`);
  console.log(`  AI grouping:   ${judge.status.enabled ? `${judge.status.modelName} (checking AWS credentials…)` : 'off'}`);
  if (s.phase !== 'lobby') {
    console.log(`  Resumed game in progress (question ${s.questionIndex + 1}/${s.questions.length}, ${s.phase}).`);
  }
  console.log('');
  if (!process.env.PUBLIC_URL && baseUrl.includes('localhost')) {
    console.log('  ⚠ Could not detect a LAN address — phones will not be able to reach localhost.');
    console.log('    Set PUBLIC_URL, e.g. PUBLIC_URL=http://192.168.1.20:7420 npm start');
    console.log('');
  }
});

// Check AWS credentials once at startup so the host knows whether AI grouping will work.
// Purely informational: free-text questions fall back to text matching either way.
if (judge.status.enabled) {
  checkCredentials().then((result) => {
    if (result.ok) {
      Object.assign(judge.status, { state: 'ready', message: 'AWS credentials OK' });
      console.log(`  ✓ AI grouping ready (${judge.status.modelName}, profile ${process.env.AWS_PROFILE ?? 'default'})`);
    } else {
      Object.assign(judge.status, { state: 'error', message: result.message });
      console.log(`  ⚠ AI grouping unavailable — ${result.message}. Free text will use text matching.`);
    }
    scheduleBroadcast();
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=7421 npm start`);
    process.exit(1);
  }
  throw err;
});

function shutdown() {
  clearInterval(heartbeat);
  store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
// Never take the game down mid-meeting over a stray async error (e.g. a network hiccup).
process.on('unhandledRejection', (err) => console.error('Unhandled rejection (ignored):', err));
process.on('SIGTERM', shutdown);
