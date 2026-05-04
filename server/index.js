import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import cors from 'cors';
import { Room } from './room.js';
import { Leaderboard } from './leaderboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

const leaderboard = new Leaderboard(process.env.DATA_DIR || './data');

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, rooms: Room.all().length }));
app.get('/leaderboard', (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
  res.json({ top: leaderboard.top(limit) });
});

// Serve client statically when running locally with sibling client/ folder
const clientDir = path.resolve(__dirname, '../client');
if (fs.existsSync(path.join(clientDir, 'index.html'))) {
  app.use(express.static(clientDir));
  console.log('[dodgeball-arena] serving client from', clientDir);
} else {
  app.get('/', (req, res) => res.json({ ok: true, service: 'dodgeball-arena' }));
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS, credentials: true },
});

const sanitizeNick = (raw) => {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[^\p{L}\p{N}_\-. ]/gu, '').trim().slice(0, 16);
  return s.length >= 2 ? s : null;
};

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerId = socket.id;

  const broadcastLobby = () => {
    if (!currentRoom) return;
    io.to(currentRoom.code).emit('lobbyState', currentRoom.lobbyState());
  };

  socket.on('createRoom', ({ nick }, cb) => {
    const clean = sanitizeNick(nick);
    if (!clean) return cb?.({ error: 'badNick' });
    if (currentRoom) return cb?.({ error: 'alreadyInRoom' });
    const room = new Room(io);
    const result = room.addPlayer(playerId, socket.id, clean);
    if (result.error) { room.destroy(); return cb?.({ error: result.error }); }
    currentRoom = room;
    socket.join(room.code);
    cb?.({ code: room.code, you: playerId, lobby: room.lobbyState() });
    broadcastLobby();
  });

  socket.on('joinRoom', ({ code, nick }, cb) => {
    const clean = sanitizeNick(nick);
    if (!clean) return cb?.({ error: 'badNick' });
    if (currentRoom) return cb?.({ error: 'alreadyInRoom' });
    const room = Room.get(code);
    if (!room) return cb?.({ error: 'noRoom' });
    const result = room.addPlayer(playerId, socket.id, clean);
    if (result.error) return cb?.({ error: result.error });
    currentRoom = room;
    socket.join(room.code);
    cb?.({ code: room.code, you: playerId, lobby: room.lobbyState() });
    broadcastLobby();
  });

  socket.on('leaveRoom', () => {
    if (!currentRoom) return;
    const code = currentRoom.code;
    currentRoom.removePlayer(playerId);
    socket.leave(code);
    const room = Room.get(code);
    if (room) io.to(code).emit('lobbyState', room.lobbyState());
    currentRoom = null;
  });

  socket.on('switchTeam', () => {
    if (!currentRoom) return;
    currentRoom.switchTeam(playerId);
    broadcastLobby();
  });

  socket.on('settings', (patch) => {
    if (!currentRoom) return;
    currentRoom.updateSettings(playerId, patch || {});
    broadcastLobby();
  });

  socket.on('startMatch', (_, cb) => {
    if (!currentRoom) return cb?.({ error: 'noRoom' });
    const r = currentRoom.startMatch(playerId, leaderboard);
    cb?.(r);
  });

  // Gameplay messages
  socket.on('input', (input) => {
    if (!currentRoom?.match) return;
    currentRoom.match.setInput(playerId, input || {});
  });

  socket.on('charge', () => {
    if (!currentRoom?.match) return;
    currentRoom.match.startCharge(playerId);
  });

  socket.on('release', ({ angle } = {}) => {
    if (!currentRoom?.match) return;
    if (typeof angle !== 'number') return;
    currentRoom.match.releaseAction(playerId, angle);
  });

  socket.on('drop', () => {
    if (!currentRoom?.match) return;
    currentRoom.match.dropBall(playerId);
  });

  socket.on('chat', ({ text }) => {
    if (!currentRoom) return;
    if (typeof text !== 'string') return;
    const t = text.slice(0, 80);
    if (!t.trim()) return;
    const p = currentRoom.players.get(playerId);
    io.to(currentRoom.code).emit('chat', { from: p?.nick || '???', text: t, t: Date.now() });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const code = currentRoom.code;
      currentRoom.removePlayer(playerId);
      const room = Room.get(code);
      if (room) io.to(code).emit('lobbyState', room.lobbyState());
      currentRoom = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`[dodgeball-arena] listening on :${PORT}`);
});
