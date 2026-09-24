import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';

// 7420 sits clear of the ports used by other local repos (3000, 5433, 6379, 9200, ...).
const PORT = Number(process.env.PORT) || 7420;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_NAME_LENGTH = 24;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

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
// Lobby state (in memory — restarting the server clears it)
// ---------------------------------------------------------------------------

/** @type {Map<string, { id: string, name: string, joinedAt: number, connected: boolean }>} */
const players = new Map();

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

function uniqueName(name, excludeId) {
  const taken = new Set(
    [...players.values()].filter((p) => p.id !== excludeId).map((p) => p.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function lobbySnapshot() {
  return [...players.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(({ id, name, connected }) => ({ id, name, connected }));
}

// ---------------------------------------------------------------------------
// HTTP: static pages + a small info endpoint for the host screen
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const ROUTES = {
  '/': 'host.html',
  '/join': 'join.html',
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

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/api/info') {
    const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ joinUrl, qrSvg }));
    return;
  }

  if (ROUTES[pathname]) return sendFile(res, ROUTES[pathname]);

  // Static assets: only plain filenames from /public, no path traversal.
  const file = pathname.slice(1);
  if (/^[\w-]+\.(css|js|svg)$/.test(file)) return sendFile(res, file);

  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
});

// ---------------------------------------------------------------------------
// WebSocket: hosts watch the lobby, players join / rejoin
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });
const hosts = new Set();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastLobby() {
  const msg = { type: 'lobby', players: lobbySnapshot() };
  for (const ws of hosts) send(ws, msg);
}

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'host': {
        hosts.add(ws);
        send(ws, { type: 'lobby', players: lobbySnapshot() });
        break;
      }

      case 'join': {
        const name = cleanName(msg.name);
        if (!name) {
          send(ws, { type: 'error', message: 'Please enter a name.' });
          return;
        }
        // Reuse the id if this phone already joined (page refresh, screen lock, etc.).
        const existing = typeof msg.playerId === 'string' ? players.get(msg.playerId) : undefined;
        const id = existing?.id ?? randomUUID();
        const player = {
          id,
          name: uniqueName(name, id),
          joinedAt: existing?.joinedAt ?? Date.now(),
          connected: true,
        };
        players.set(id, player);
        playerId = id;
        send(ws, { type: 'joined', player: { id, name: player.name } });
        broadcastLobby();
        console.log(`+ ${player.name} joined (${players.size} in lobby)`);
        break;
      }

      case 'rejoin': {
        const player = typeof msg.playerId === 'string' ? players.get(msg.playerId) : undefined;
        if (!player) {
          send(ws, { type: 'unknown-player' });
          return;
        }
        player.connected = true;
        playerId = player.id;
        send(ws, { type: 'joined', player: { id: player.id, name: player.name } });
        broadcastLobby();
        break;
      }
    }
  });

  ws.on('close', () => {
    hosts.delete(ws);
    if (!playerId) return;
    const player = players.get(playerId);
    // Only mark offline if no other socket has since claimed this player.
    const stillConnected = [...wss.clients].some((c) => c !== ws && c.playerId === playerId);
    if (player && !stillConnected) {
      player.connected = false;
      broadcastLobby();
    }
  });

  // Expose the player id on the socket so the close handler above can check other sockets.
  Object.defineProperty(ws, 'playerId', { get: () => playerId });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Herd Mentality is running');
  console.log(`  Host screen:  http://localhost:${PORT}`);
  console.log(`  Players join: ${joinUrl}`);
  console.log('');
  if (!process.env.PUBLIC_URL && baseUrl.includes('localhost')) {
    console.log('  ⚠ Could not detect a LAN address — phones will not be able to reach localhost.');
    console.log('    Set PUBLIC_URL, e.g. PUBLIC_URL=http://192.168.1.20:7420 npm start');
    console.log('');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=7421 npm start`);
    process.exit(1);
  }
  throw err;
});
