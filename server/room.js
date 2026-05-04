import { Match } from './match.js';
import {
  MIN_PLAYERS_TO_START, MAX_PLAYERS_PER_TEAM, DEFAULT_BALLS, ROUNDS_TO_WIN,
  TEAM_LEFT, TEAM_RIGHT,
} from './constants.js';

const ROOM_CODES = new Map();    // code → Room
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable chars

function newCode() {
  for (let i = 0; i < 20; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += ALPHABET[Math.floor(Math.random()*ALPHABET.length)];
    if (!ROOM_CODES.has(c)) return c;
  }
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

export class Room {
  constructor(io) {
    this.io = io;
    this.code = newCode();
    this.players = new Map();   // playerId → {id, socketId, nick, team, isHost, ready}
    this.hostId = null;
    this.match = null;
    this.settings = {
      ballCount: DEFAULT_BALLS,
      roundsToWin: ROUNDS_TO_WIN,
      powerupsEnabled: true,
    };
    ROOM_CODES.set(this.code, this);
  }

  static get(code) { return ROOM_CODES.get(code?.toUpperCase()); }
  static all() { return [...ROOM_CODES.values()]; }

  destroy() {
    if (this.match) this.match.destroy();
    ROOM_CODES.delete(this.code);
  }

  isFull() {
    let l = 0, r = 0;
    for (const p of this.players.values()) {
      if (p.team === TEAM_LEFT) l++; else r++;
    }
    return l >= MAX_PLAYERS_PER_TEAM && r >= MAX_PLAYERS_PER_TEAM;
  }

  addPlayer(id, socketId, nick) {
    if (this.match) return { error: 'matchInProgress' };
    if (this.isFull()) return { error: 'full' };
    let l = 0, r = 0;
    for (const p of this.players.values()) {
      if (p.team === TEAM_LEFT) l++; else r++;
    }
    const team = l <= r ? TEAM_LEFT : TEAM_RIGHT;
    const player = { id, socketId, nick, team, ready: false, isHost: false };
    if (this.hostId === null) {
      this.hostId = id;
      player.isHost = true;
    }
    this.players.set(id, player);
    return { player };
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    // remove from active match
    if (this.match) {
      const mp = this.match.players.get(id);
      if (mp && mp.alive) {
        mp.alive = false;
        // re-check round
      }
      this.match.players.delete(id);
    }
    if (this.hostId === id) {
      const next = [...this.players.values()][0];
      if (next) {
        this.hostId = next.id;
        next.isHost = true;
      } else {
        this.hostId = null;
      }
    }
    if (this.players.size === 0) {
      this.destroy();
    }
  }

  switchTeam(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (this.match) return;
    let l = 0, r = 0;
    for (const pp of this.players.values()) {
      if (pp.id === playerId) continue;
      if (pp.team === TEAM_LEFT) l++; else r++;
    }
    const target = p.team === TEAM_LEFT ? TEAM_RIGHT : TEAM_LEFT;
    const otherCount = target === TEAM_LEFT ? l : r;
    if (otherCount >= MAX_PLAYERS_PER_TEAM) return;
    p.team = target;
  }

  setReady(playerId, ready) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.ready = !!ready;
  }

  updateSettings(playerId, patch) {
    if (this.hostId !== playerId) return;
    if (this.match) return;
    if (typeof patch.ballCount === 'number') {
      this.settings.ballCount = Math.max(1, Math.min(4, Math.floor(patch.ballCount)));
    }
    if (typeof patch.roundsToWin === 'number') {
      this.settings.roundsToWin = Math.max(1, Math.min(5, Math.floor(patch.roundsToWin)));
    }
    if (typeof patch.powerupsEnabled === 'boolean') {
      this.settings.powerupsEnabled = patch.powerupsEnabled;
    }
  }

  canStart() {
    if (this.match) return false;
    let l = 0, r = 0;
    for (const p of this.players.values()) {
      if (p.team === TEAM_LEFT) l++; else r++;
    }
    return l >= 1 && r >= 1 && this.players.size >= MIN_PLAYERS_TO_START;
  }

  startMatch(playerId, leaderboard) {
    if (this.hostId !== playerId) return { error: 'notHost' };
    if (!this.canStart()) return { error: 'cantStart' };
    const players = [...this.players.values()].map(p => ({
      id: p.id, nick: p.nick, team: p.team,
    }));
    this.match = new Match(this.code, players, this.settings, (event, payload) => {
      if (event === 'snapshot') {
        this.io.to(this.code).emit('snapshot', payload);
      } else {
        this.io.to(this.code).emit('matchEvent', { type: event, ...payload });
      }
      if (event === 'matchEnd') {
        // record leaderboard
        if (leaderboard) {
          const winners = [...this.players.values()].filter(p => p.team === payload.winner);
          for (const w of winners) {
            leaderboard.recordWin(w.nick);
          }
          for (const stat of (payload.stats || [])) {
            leaderboard.recordStats(stat.nick, stat.hits, stat.catches);
          }
        }
        this.match = null;
        this.io.to(this.code).emit('lobbyState', this.lobbyState());
      }
    });
    this.io.to(this.code).emit('matchStart', { settings: { ...this.settings } });
    return { ok: true };
  }

  lobbyState() {
    return {
      code: this.code,
      hostId: this.hostId,
      settings: { ...this.settings },
      players: [...this.players.values()].map(p => ({
        id: p.id, nick: p.nick, team: p.team, isHost: p.isHost, ready: p.ready,
      })),
      canStart: this.canStart(),
    };
  }
}
