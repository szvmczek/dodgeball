import { net } from './network.js';
import { audio } from './audio.js';
import { GameClient } from './game.js';
import { TEAM_LEFT, TEAM_RIGHT } from './constants.js';

const $ = (id) => document.getElementById(id);

const screens = {
  menu:  $('screen-menu'),
  lobby: $('screen-lobby'),
  game:  $('screen-game'),
};
const showScreen = (name) => {
  for (const k of Object.keys(screens)) {
    if (k === name) screens[k].classList.remove('hidden');
    else screens[k].classList.add('hidden');
  }
};

let game = null;
let lobbyState = null;
let storedNick = localStorage.getItem('dodge:nick') || '';

const toast = (msg, ms = 2000) => {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
};

const errorMsg = (code) => ({
  badNick: 'Wpisz ksywę (2-16 znaków).',
  alreadyInRoom: 'Jesteś już w pokoju.',
  noRoom: 'Nie ma takiego pokoju.',
  full: 'Pokój pełny.',
  matchInProgress: 'Mecz w toku, spróbuj za chwilę.',
  notHost: 'Tylko host może to zrobić.',
  cantStart: 'Potrzeba min. 1 gracz w każdej drużynie.',
}[code] || code || 'Coś poszło nie tak.');

// ============== HUD adapter passed to game ==============
const hud = {
  setScore(left, right) {
    $('score-left').textContent = left;
    $('score-right').textContent = right;
  },
  setRound(label) { $('round-state').textContent = label; },
  setRoundTimer(text, urgent) {
    const el = $('round-timer');
    el.textContent = text;
    el.classList.toggle('urgent', !!urgent);
  },
  showCharge(charge01) {
    const el = $('charge-meter');
    el.classList.remove('hidden');
    $('charge-fill').style.width = (Math.max(0, Math.min(1, charge01)) * 100) + '%';
  },
  hideCharge() { $('charge-meter').classList.add('hidden'); },
  showOverlay(_kind, text) {
    const ov = $('round-overlay');
    $('round-overlay-text').textContent = text;
    ov.classList.remove('hidden');
  },
  hideOverlay() { $('round-overlay').classList.add('hidden'); },
  showMatchEnd(payload) {
    const card = $('match-end');
    card.classList.remove('hidden');
    const winner = payload.winner;
    $('match-end-title').textContent = winner === TEAM_LEFT ? 'Wygrali Niebiescy!' : winner === TEAM_RIGHT ? 'Wygrali Różowi!' : 'Remis';
    const tbody = $('match-end-stats');
    tbody.innerHTML = '';
    const stats = payload.stats || [];
    stats.sort((a, b) => (b.hits + b.catches) - (a.hits + a.catches));
    for (const s of stats) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="${s.team === TEAM_LEFT ? 'team-left-cell' : 'team-right-cell'}">${escapeHtml(s.nick)}</td>
                      <td>${s.hits}</td><td>${s.catches}</td>`;
      tbody.appendChild(tr);
    }
  },
  toast,
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ============== Menu ==============
$('input-nick').value = storedNick;
$('input-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); });

$('btn-create').addEventListener('click', async () => {
  const nick = $('input-nick').value.trim();
  if (!nick) return toast('Wpisz ksywę');
  localStorage.setItem('dodge:nick', nick);
  storedNick = nick;
  const r = await net.createRoom(nick);
  if (r.error) return toast(errorMsg(r.error));
  enterLobby(r.lobby);
});

$('btn-join').addEventListener('click', async () => {
  const nick = $('input-nick').value.trim();
  const code = $('input-code').value.trim().toUpperCase();
  if (!nick) return toast('Wpisz ksywę');
  if (code.length !== 4) return toast('Kod ma 4 znaki');
  localStorage.setItem('dodge:nick', nick);
  const r = await net.joinRoom(code, nick);
  if (r.error) return toast(errorMsg(r.error));
  enterLobby(r.lobby);
});

// Enter triggers join
$('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
$('input-nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create').click(); });

// ============== Lobby ==============
function enterLobby(lobby) {
  lobbyState = lobby;
  $('room-code').textContent = lobby.code;
  renderLobby();
  showScreen('lobby');
  audio.pickup(); // prime audio context
}

function renderLobby() {
  if (!lobbyState) return;
  const left = lobbyState.players.filter(p => p.team === TEAM_LEFT);
  const right = lobbyState.players.filter(p => p.team === TEAM_RIGHT);
  const renderList = (arr) => arr.map(p => `
    <li>
      <span><span class="crown">${p.isHost ? '👑 ' : ''}</span>${escapeHtml(p.nick)}</span>
      ${p.id === net.myId ? '<span class="me">TY</span>' : ''}
    </li>`).join('');
  $('team-left-list').innerHTML = renderList(left);
  $('team-right-list').innerHTML = renderList(right);

  // host can start when canStart is true
  const me = lobbyState.players.find(p => p.id === net.myId);
  const isHost = me?.isHost;
  $('btn-start').disabled = !isHost || !lobbyState.canStart;
  $('btn-start').textContent = isHost ? (lobbyState.canStart ? 'Start' : 'Czekamy na graczy…') : 'Czekaj na hosta…';

  // settings — only host edits
  $('set-balls').value = String(lobbyState.settings.ballCount);
  $('set-rounds').value = String(lobbyState.settings.roundsToWin);
  $('set-powerups').checked = !!lobbyState.settings.powerupsEnabled;
  for (const el of [$('set-balls'), $('set-rounds'), $('set-powerups')]) el.disabled = !isHost;
}

$('btn-leave').addEventListener('click', () => {
  net.leaveRoom();
  lobbyState = null;
  showScreen('menu');
  refreshLeaderboard();
});

$('btn-switch').addEventListener('click', () => net.switchTeam());

$('btn-copy').addEventListener('click', async () => {
  const code = $('room-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast('Kod skopiowany');
  } catch (e) { toast(code); }
});

$('set-balls').addEventListener('change', (e) => net.setSettings({ ballCount: parseInt(e.target.value, 10) }));
$('set-rounds').addEventListener('change', (e) => net.setSettings({ roundsToWin: parseInt(e.target.value, 10) }));
$('set-powerups').addEventListener('change', (e) => net.setSettings({ powerupsEnabled: !!e.target.checked }));

$('btn-start').addEventListener('click', async () => {
  const r = await net.startMatch();
  if (r?.error) toast(errorMsg(r.error));
});

// chat
const chatInput = $('chat-input');
const chatLog = $('chat-log');
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const t = chatInput.value.trim();
    if (t) net.chat(t);
    chatInput.value = '';
  }
});
net.onChat = (msg) => {
  const line = document.createElement('div');
  line.className = 'chat-line';
  line.innerHTML = `<span class="nick">${escapeHtml(msg.from)}</span><span>${escapeHtml(msg.text)}</span>`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
};

// lobby state updates
net.onLobby = (st) => {
  lobbyState = st;
  if (screens.lobby.classList.contains('hidden') && screens.game.classList.contains('hidden')) {
    // got lobby update while in menu? ignore
    return;
  }
  // returning from match → back to lobby
  if (!screens.lobby.classList.contains('hidden') === false && !screens.game.classList.contains('hidden')) {
    // we're in game, server telling us match is over → show button to go back
  }
  renderLobby();
};

// ============== Match start / end ==============
net.onMatchStart = () => {
  // hide match-end overlay
  $('match-end').classList.add('hidden');
  showScreen('game');
  fitCanvas();
  if (game) game.stop();
  game = new GameClient($('canvas'), net, hud);
  game.start();
};

$('btn-back-lobby').addEventListener('click', () => {
  $('match-end').classList.add('hidden');
  if (game) { game.stop(); game = null; }
  showScreen('lobby');
  renderLobby();
});

// ============== Connection lifecycle ==============
const status = $('server-status');
const setStatus = (txt, kind) => {
  status.textContent = txt;
  status.classList.remove('ok', 'bad');
  if (kind) status.classList.add(kind);
};

net.onConnect = () => { setStatus('Połączono z serwerem', 'ok'); refreshLeaderboard(); };
net.onDisconnect = () => { setStatus('Rozłączono — próbuję ponownie…', 'bad'); };
net.onError = () => { setStatus(`Brak połączenia (${net.url})`, 'bad'); };

net.connect();

// ============== Leaderboard ==============
async function refreshLeaderboard() {
  const top = await net.fetchLeaderboard();
  const list = $('leaderboard-list');
  if (!top.length) { list.innerHTML = '<li class="empty">Brak danych</li>'; return; }
  list.innerHTML = top.map(r => `<li><span class="nick">${escapeHtml(r.nick)}</span><span class="num">${r.wins} W · ${r.hits} H · ${r.catches} C</span></li>`).join('');
}

// ============== Canvas fit ==============
function fitCanvas() {
  const c = $('canvas');
  const stage = c.parentElement;
  const sW = stage.clientWidth, sH = stage.clientHeight;
  const targetRatio = 1280 / 720;
  let w, h;
  if (sW / sH > targetRatio) {
    h = sH * 0.96; w = h * targetRatio;
  } else {
    w = sW * 0.98; h = w / targetRatio;
  }
  c.style.width = w + 'px';
  c.style.height = h + 'px';
}
window.addEventListener('resize', fitCanvas);

// ============== Initial state ==============
showScreen('menu');
refreshLeaderboard();

// ============== Click anywhere to unlock audio (Chrome/Safari policy) ==============
const unlockAudio = () => {
  audio.pickup();
  window.removeEventListener('click', unlockAudio);
  window.removeEventListener('keydown', unlockAudio);
};
window.addEventListener('click', unlockAudio);
window.addEventListener('keydown', unlockAudio);
