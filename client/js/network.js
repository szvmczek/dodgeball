// Socket.IO client wrapper. Loaded as global `io` from CDN script.

function resolveServerUrl() {
  const params = new URLSearchParams(location.search);
  const fromQs = params.get('server');
  if (fromQs) return fromQs;
  if (window.__DODGE_SERVER__) return window.__DODGE_SERVER__;
  // Localhost dev fallback
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return `http://${location.hostname}:3001`;
  }
  // Same-origin (when frontend is hosted by same node app)
  return location.origin;
}

const SERVER_URL = resolveServerUrl();

export const net = {
  socket: null,
  url: SERVER_URL,
  myId: null,
  onConnect: null,
  onDisconnect: null,
  onLobby: null,
  onSnapshot: null,
  onMatchStart: null,
  onMatchEvent: null,
  onChat: null,
  onError: null,

  connect() {
    if (this.socket) return this.socket;
    const s = window.io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
    });
    this.socket = s;
    s.on('connect', () => { this.myId = s.id; this.onConnect?.(); });
    s.on('disconnect', () => { this.onDisconnect?.(); });
    s.on('connect_error', (e) => { this.onError?.(e); });
    s.on('lobbyState', (st) => this.onLobby?.(st));
    s.on('snapshot', (snap) => this.onSnapshot?.(snap));
    s.on('matchStart', (info) => this.onMatchStart?.(info));
    s.on('matchEvent', (ev) => this.onMatchEvent?.(ev));
    s.on('chat', (msg) => this.onChat?.(msg));
    return s;
  },

  createRoom(nick) {
    return new Promise((res) => this.socket.emit('createRoom', { nick }, res));
  },
  joinRoom(code, nick) {
    return new Promise((res) => this.socket.emit('joinRoom', { code: (code || '').toUpperCase(), nick }, res));
  },
  leaveRoom() { this.socket?.emit('leaveRoom'); },
  switchTeam() { this.socket?.emit('switchTeam'); },
  setSettings(patch) { this.socket?.emit('settings', patch); },
  startMatch() { return new Promise((res) => this.socket.emit('startMatch', null, res)); },
  sendInput(input) { this.socket?.emit('input', input); },
  charge() { this.socket?.emit('charge'); },
  release(angle) { this.socket?.emit('release', { angle }); },
  drop() { this.socket?.emit('drop'); },
  chat(text) { this.socket?.emit('chat', { text }); },

  async fetchLeaderboard() {
    try {
      const r = await fetch(`${SERVER_URL.replace(/\/$/,'')}/leaderboard?limit=10`);
      if (!r.ok) return [];
      const j = await r.json();
      return j.top || [];
    } catch (e) {
      return [];
    }
  },
};
