import {
  ARENA_W, ARENA_H, CENTER_X,
  PLAYER_RADIUS, PLAYER_SPEED, PLAYER_SPEED_CHARGING, PLAYER_HOLD_OFFSET,
  BALL_RADIUS, BALL_FRICTION, BALL_LIVE_SPEED,
  THROW_SPEED_MIN, THROW_SPEED_MAX, THROW_CHARGE_MS, CATCH_RADIUS,
  TICK_MS,
  ROUND_COUNTDOWN_MS, ROUND_END_DELAY_MS, MATCH_END_DELAY_MS, ROUND_TIME_LIMIT_MS,
  POWERUP_RESPAWN_MS, POWERUP_SPAWN_POINTS, POWERUP_TYPES, POWERUP_DURATION_MS,
  TEAM_LEFT, TEAM_RIGHT,
} from './constants.js';

const CATCH_WINDOW_MS = 280;
const PICKUP_RANGE = PLAYER_RADIUS + BALL_RADIUS + 4;
const RESPAWN_NUDGE = 4;
const HIT_GRACE_MS = 350;       // after eliminating someone, ball goes neutral
const SELF_PICKUP_DELAY_MS = 250;

let nextBallId = 1;
let nextPwrId = 1;

export class Match {
  constructor(roomCode, players, settings, listener) {
    this.code = roomCode;
    this.settings = settings;
    this.listener = listener;     // (event, payload) => void
    this.tickHandle = null;
    this.lastTickAt = Date.now();
    this.tickCount = 0;

    this.scores = { [TEAM_LEFT]: 0, [TEAM_RIGHT]: 0 };
    this.round = 0;
    this.state = 'countdown';
    this.stateUntil = Date.now() + ROUND_COUNTDOWN_MS;
    this.matchWinner = null;
    this.lastEvents = [];
    this.roundStartedAt = 0;
    this.roundEndsAt = 0;
    this.roundHits = { [TEAM_LEFT]: 0, [TEAM_RIGHT]: 0 };

    this.players = new Map();
    for (const p of players) {
      this.players.set(p.id, this._mkPlayer(p));
    }

    this.balls = [];
    this.powerups = [];
    this._spawnRoundEntities();

    this.tickHandle = setInterval(() => this._tick(), TICK_MS);
    this.round = 1;
    this._emit('roundStart', { round: this.round });
  }

  _mkPlayer(p) {
    return {
      id: p.id,
      nick: p.nick,
      team: p.team,
      isBot: !!p.isBot,
      x: 0, y: 0, vx: 0, vy: 0,
      input: { up:0, down:0, left:0, right:0, aim:0, action:false },
      alive: true,
      eliminatedAt: 0,
      holdingBallId: null,
      chargingSince: 0,
      catchUntil: 0,
      lastDropAt: 0,
      shieldUntil: 0,
      speedUntil: 0,
      bigBallUntil: 0,
      multiballUntil: 0,
      hitsScored: 0,
      catches: 0,
    };
  }

  _resetForRound() {
    let leftIndex = 0, rightIndex = 0;
    const leftCount = [...this.players.values()].filter(p => p.team === TEAM_LEFT).length;
    const rightCount = [...this.players.values()].filter(p => p.team === TEAM_RIGHT).length;
    for (const p of this.players.values()) {
      p.alive = true;
      p.holdingBallId = null;
      p.chargingSince = 0;
      p.catchUntil = 0;
      p.shieldUntil = 0;
      p.speedUntil = 0;
      p.bigBallUntil = 0;
      p.multiballUntil = 0;
      p.vx = 0; p.vy = 0;
      if (p.team === TEAM_LEFT) {
        const slot = leftIndex++;
        p.x = 120;
        p.y = (ARENA_H / (leftCount + 1)) * (slot + 1);
      } else {
        const slot = rightIndex++;
        p.x = ARENA_W - 120;
        p.y = (ARENA_H / (rightCount + 1)) * (slot + 1);
      }
    }
  }

  _spawnRoundEntities() {
    this._resetForRound();
    this.roundHits = { [TEAM_LEFT]: 0, [TEAM_RIGHT]: 0 };
    this.balls = [];
    const count = this.settings.ballCount;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      this.balls.push(this._mkBall(CENTER_X, 160 + (ARENA_H - 320) * t));
    }
    this.powerups = [];
    if (this.settings.powerupsEnabled) {
      const now = Date.now();
      for (const pt of POWERUP_SPAWN_POINTS) {
        this.powerups.push({
          id: nextPwrId++,
          x: pt.x, y: pt.y,
          type: this._randomPowerup(),
          spawnAt: now + 2500 + Math.random() * 2000,
          available: false,
        });
      }
    }
  }

  _mkBall(x, y) {
    return {
      id: nextBallId++,
      x, y, vx: 0, vy: 0,
      ownerId: null,
      live: false,             // deadly when true
      thrownBy: null,
      bigUntil: 0,
      lastTouchTeam: null,
      thrownAt: 0,
    };
  }

  _randomPowerup() {
    return POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  }

  _emit(type, payload = {}) {
    this.lastEvents.push({ type, ...payload, t: Date.now() });
    if (this.listener) this.listener(type, payload);
  }

  setInput(playerId, input) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (this.state === 'countdown' || this.state === 'matchEnd') {
      // freeze movement during countdown / end
      p.input = { ...p.input, up:0, down:0, left:0, right:0, aim: input.aim ?? p.input.aim };
      return;
    }
    p.input = {
      up: input.up ? 1 : 0,
      down: input.down ? 1 : 0,
      left: input.left ? 1 : 0,
      right: input.right ? 1 : 0,
      aim: typeof input.aim === 'number' ? input.aim : p.input.aim,
      action: !!input.action,
    };
  }

  startCharge(playerId) {
    const p = this.players.get(playerId);
    if (!p || !p.alive || this.state !== 'playing') return;
    if (!p.holdingBallId) {
      // not holding ball → activate catch window
      p.catchUntil = Date.now() + CATCH_WINDOW_MS;
      this._tryPickup(p);
      return;
    }
    p.chargingSince = Date.now();
  }

  releaseAction(playerId, angle) {
    const p = this.players.get(playerId);
    if (!p || !p.alive || this.state !== 'playing') return;
    if (p.holdingBallId && p.chargingSince > 0) {
      this._throw(p, angle);
    }
  }

  dropBall(playerId) {
    const p = this.players.get(playerId);
    if (!p || !p.holdingBallId) return;
    const b = this.balls.find(b => b.id === p.holdingBallId);
    if (!b) return;
    b.ownerId = null;
    b.vx = 0; b.vy = 0;
    b.live = false;
    p.holdingBallId = null;
    p.chargingSince = 0;
    p.lastDropAt = Date.now();
  }

  _tryPickup(p) {
    if (p.holdingBallId) return;
    if (Date.now() - p.lastDropAt < SELF_PICKUP_DELAY_MS) return;
    let nearest = null, dmin = PICKUP_RANGE;
    for (const b of this.balls) {
      if (b.ownerId) continue;
      if (b.live) continue;
      const dx = b.x - p.x, dy = b.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < dmin) { dmin = d; nearest = b; }
    }
    if (nearest) {
      nearest.ownerId = p.id;
      nearest.vx = 0; nearest.vy = 0;
      nearest.live = false;
      p.holdingBallId = nearest.id;
      // if action still held, begin charging immediately for smooth pickup→throw
      if (p.input.action) p.chargingSince = Date.now();
    }
  }

  _throw(p, angle) {
    const ball = this.balls.find(b => b.id === p.holdingBallId);
    if (!ball) return;
    const charge = Math.min(THROW_CHARGE_MS, Date.now() - p.chargingSince) / THROW_CHARGE_MS;
    const speed = THROW_SPEED_MIN + (THROW_SPEED_MAX - THROW_SPEED_MIN) * charge;
    ball.vx = Math.cos(angle) * speed;
    ball.vy = Math.sin(angle) * speed;
    ball.ownerId = null;
    ball.live = true;
    ball.thrownBy = p.id;
    ball.lastTouchTeam = p.team;
    ball.thrownAt = Date.now();
    if (p.bigBallUntil > Date.now()) ball.bigUntil = Date.now() + 2500;
    // separate ball from thrower so it doesn't immediately re-collide
    ball.x = p.x + Math.cos(angle) * (PLAYER_RADIUS + BALL_RADIUS + 6);
    ball.y = p.y + Math.sin(angle) * (PLAYER_RADIUS + BALL_RADIUS + 6);
    p.holdingBallId = null;
    p.chargingSince = 0;
    this._emit('throw', { from: p.id, charge });

    if (p.multiballUntil > Date.now()) {
      // spawn a phantom second throw
      const extra = this._mkBall(p.x, p.y);
      const spread = 0.18;
      extra.vx = Math.cos(angle + spread) * speed * 0.95;
      extra.vy = Math.sin(angle + spread) * speed * 0.95;
      extra.live = true;
      extra.thrownBy = p.id;
      extra.lastTouchTeam = p.team;
      extra.thrownAt = Date.now();
      extra.x = p.x + Math.cos(angle + spread) * (PLAYER_RADIUS + BALL_RADIUS + 6);
      extra.y = p.y + Math.sin(angle + spread) * (PLAYER_RADIUS + BALL_RADIUS + 6);
      this.balls.push(extra);
    }
  }

  _tick() {
    const now = Date.now();
    const dt = Math.min(80, now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    this.tickCount++;

    if (this.state === 'countdown') {
      if (now >= this.stateUntil) {
        this.state = 'playing';
        this.roundStartedAt = now;
        this.roundEndsAt = now + ROUND_TIME_LIMIT_MS;
        this._emit('roundGo', { roundEndsAt: this.roundEndsAt });
      }
    } else if (this.state === 'playing') {
      this._stepPlayers(dt, now);
      this._stepBalls(dt, now);
      this._stepPowerups(now);
      this._checkRoundEnd(now);
    } else if (this.state === 'roundEnd') {
      if (now >= this.stateUntil) {
        if (this.matchWinner) {
          this.state = 'matchEnd';
          this.stateUntil = now + MATCH_END_DELAY_MS;
        } else {
          this.round++;
          this._spawnRoundEntities();
          this.state = 'countdown';
          this.stateUntil = now + ROUND_COUNTDOWN_MS;
          this._emit('roundStart', { round: this.round });
        }
      }
    } else if (this.state === 'matchEnd') {
      if (now >= this.stateUntil) {
        this._emit('matchEnd', {
          winner: this.matchWinner,
          scores: { ...this.scores },
          stats: this._collectStats(),
        });
        this.destroy();
        return;
      }
    }

    this._broadcastState();
  }

  _stepPlayers(dt, now) {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const i = p.input;
      let dx = (i.right - i.left), dy = (i.down - i.up);
      const len = Math.hypot(dx, dy);
      if (len > 0) { dx /= len; dy /= len; }
      let speed = PLAYER_SPEED;
      if (p.holdingBallId && p.chargingSince > 0) speed = PLAYER_SPEED_CHARGING;
      if (p.speedUntil > now) speed *= 1.55;
      p.vx = dx * speed;
      p.vy = dy * speed;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // walls
      p.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_W - PLAYER_RADIUS, p.x));
      p.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_H - PLAYER_RADIUS, p.y));
      // center line
      if (p.team === TEAM_LEFT) {
        p.x = Math.min(p.x, CENTER_X - PLAYER_RADIUS - 2);
      } else {
        p.x = Math.max(p.x, CENTER_X + PLAYER_RADIUS + 2);
      }
    }
  }

  _stepBalls(dt, now) {
    for (const b of this.balls) {
      if (b.ownerId) {
        const owner = this.players.get(b.ownerId);
        if (!owner || !owner.alive) {
          b.ownerId = null;
          continue;
        }
        const a = owner.input.aim || 0;
        b.x = owner.x + Math.cos(a) * PLAYER_HOLD_OFFSET;
        b.y = owner.y + Math.sin(a) * PLAYER_HOLD_OFFSET;
        b.vx = 0; b.vy = 0;
        continue;
      }
      // physics
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const sp = Math.hypot(b.vx, b.vy);
      // walls
      const r = b.bigUntil > now ? BALL_RADIUS * 1.7 : BALL_RADIUS;
      if (b.x < r) { b.x = r; b.vx = -b.vx * 0.6; }
      if (b.x > ARENA_W - r) { b.x = ARENA_W - r; b.vx = -b.vx * 0.6; }
      if (b.y < r) { b.y = r; b.vy = -b.vy * 0.6; }
      if (b.y > ARENA_H - r) { b.y = ARENA_H - r; b.vy = -b.vy * 0.6; }
      // friction
      b.vx *= BALL_FRICTION;
      b.vy *= BALL_FRICTION;
      // live → not live when slow (becomes safe and pickupable)
      if (b.live && sp < BALL_LIVE_SPEED) {
        b.live = false;
      }
      this._ballPlayerCollision(b, now);
    }
  }

  _ballPlayerCollision(b, now) {
    const r = (b.bigUntil > now ? BALL_RADIUS * 1.7 : BALL_RADIUS) + PLAYER_RADIUS;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.holdingBallId) continue;
      const dx = b.x - p.x, dy = b.y - p.y;
      if (dx*dx + dy*dy > r*r) continue;
      // collision
      if (b.live) {
        // hit or catch
        if (b.thrownBy === p.id && now - b.thrownAt < HIT_GRACE_MS) continue; // own ball briefly
        if (p.catchUntil > now) {
          // CATCH! thrower out, catcher gets ball
          b.live = false;
          b.ownerId = p.id;
          p.holdingBallId = b.id;
          p.catchUntil = 0;
          p.catches++;
          if (p.input.action) p.chargingSince = now;  // ready to counter-throw
          const thrower = this.players.get(b.thrownBy);
          if (thrower && thrower.alive) {
            this._eliminate(thrower, p.id);
            this._emit('catch', { catcherId: p.id, throwerId: thrower.id });
          } else {
            this._emit('catch', { catcherId: p.id, throwerId: null });
          }
          return;
        }
        // hit
        if (p.shieldUntil > now) {
          p.shieldUntil = 0;
          b.live = false;
          b.vx *= -0.4; b.vy *= -0.4;
          this._emit('shieldBreak', { playerId: p.id });
          return;
        }
        const thrower = b.thrownBy ? this.players.get(b.thrownBy) : null;
        if (thrower && thrower.team !== p.team) {
          thrower.hitsScored++;
          this.roundHits[thrower.team]++;
        }
        this._eliminate(p, b.thrownBy);
        b.live = false;
        b.vx *= 0.3; b.vy *= 0.3;
        this._emit('hit', { victimId: p.id, throwerId: b.thrownBy });
        return;
      } else {
        // not live → auto-pickup if action held or recently activated
        if (p.input.action || p.catchUntil > now) {
          if (now - p.lastDropAt < SELF_PICKUP_DELAY_MS) continue;
          b.ownerId = p.id;
          b.vx = 0; b.vy = 0;
          p.holdingBallId = b.id;
          if (p.input.action) p.chargingSince = now;  // smooth pickup→throw
          return;
        }
        // soft bump
        const d = Math.hypot(dx, dy) || 1;
        const overlap = r - d;
        b.x += (dx/d) * overlap;
        b.y += (dy/d) * overlap;
      }
    }
  }

  _eliminate(p, byId) {
    p.alive = false;
    p.eliminatedAt = Date.now();
    if (p.holdingBallId) {
      const b = this.balls.find(bb => bb.id === p.holdingBallId);
      if (b) { b.ownerId = null; b.live = false; b.vx = 0; b.vy = 0; }
      p.holdingBallId = null;
    }
  }

  _stepPowerups(now) {
    for (const pw of this.powerups) {
      if (!pw.available) {
        if (now >= pw.spawnAt) {
          pw.available = true;
          pw.type = this._randomPowerup();
        }
        continue;
      }
      // pickup check
      const r2 = (PLAYER_RADIUS + 18);
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = pw.x - p.x, dy = pw.y - p.y;
        if (dx*dx + dy*dy < r2*r2) {
          this._applyPowerup(p, pw.type, now);
          pw.available = false;
          pw.spawnAt = now + POWERUP_RESPAWN_MS;
          this._emit('powerup', { playerId: p.id, type: pw.type });
          break;
        }
      }
    }
  }

  _applyPowerup(p, type, now) {
    switch (type) {
      case 'speed':     p.speedUntil = now + POWERUP_DURATION_MS; break;
      case 'shield':    p.shieldUntil = now + POWERUP_DURATION_MS; break;
      case 'multiball': p.multiballUntil = now + POWERUP_DURATION_MS; break;
      case 'bigball':   p.bigBallUntil = now + POWERUP_DURATION_MS; break;
    }
  }

  _checkRoundEnd(now) {
    let leftAlive = 0, rightAlive = 0;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.team === TEAM_LEFT) leftAlive++;
      else rightAlive++;
    }
    const eliminated = (leftAlive === 0 || rightAlive === 0);
    const timedOut = now >= this.roundEndsAt;
    if (!eliminated && !timedOut) return;

    let winner = null;
    let reason = eliminated ? 'eliminated' : 'timeout';
    if (leftAlive !== rightAlive) {
      winner = leftAlive > rightAlive ? TEAM_LEFT : TEAM_RIGHT;
    } else if (this.roundHits[TEAM_LEFT] !== this.roundHits[TEAM_RIGHT]) {
      winner = this.roundHits[TEAM_LEFT] > this.roundHits[TEAM_RIGHT] ? TEAM_LEFT : TEAM_RIGHT;
      reason = 'tiebreak-hits';
    }
    if (winner) this.scores[winner]++;

    this.state = 'roundEnd';
    this.stateUntil = now + ROUND_END_DELAY_MS;
    this._emit('roundEnd', {
      winner, draw: !winner, reason,
      scores: { ...this.scores }, round: this.round,
      aliveCount: { [TEAM_LEFT]: leftAlive, [TEAM_RIGHT]: rightAlive },
      roundHits: { ...this.roundHits },
    });

    const need = this.settings.roundsToWin;
    if (this.scores[TEAM_LEFT] >= need || this.scores[TEAM_RIGHT] >= need) {
      this.matchWinner = this.scores[TEAM_LEFT] >= need ? TEAM_LEFT : TEAM_RIGHT;
    }
  }

  _collectStats() {
    return [...this.players.values()].map(p => ({
      id: p.id, nick: p.nick, team: p.team,
      hits: p.hitsScored, catches: p.catches,
    }));
  }

  _broadcastState() {
    const now = Date.now();
    const snap = {
      t: now,
      tick: this.tickCount,
      state: this.state,
      stateUntil: this.stateUntil,
      roundEndsAt: this.roundEndsAt,
      round: this.round,
      scores: this.scores,
      roundHits: this.roundHits,
      matchWinner: this.matchWinner,
      players: [...this.players.values()].map(p => ({
        id: p.id, nick: p.nick, team: p.team,
        x: Math.round(p.x*10)/10, y: Math.round(p.y*10)/10,
        alive: p.alive,
        holding: !!p.holdingBallId,
        charging: p.chargingSince > 0 ? Math.min(THROW_CHARGE_MS, now - p.chargingSince) / THROW_CHARGE_MS : 0,
        aim: p.input.aim || 0,
        shield: p.shieldUntil > now,
        speed: p.speedUntil > now,
        multi: p.multiballUntil > now,
        big: p.bigBallUntil > now,
        catchActive: p.catchUntil > now,
      })),
      balls: this.balls.map(b => ({
        id: b.id,
        x: Math.round(b.x*10)/10, y: Math.round(b.y*10)/10,
        vx: Math.round(b.vx), vy: Math.round(b.vy),
        owner: b.ownerId,
        live: b.live,
        big: b.bigUntil > now,
      })),
      powerups: this.powerups.map(pw => ({
        id: pw.id, x: pw.x, y: pw.y, type: pw.type, available: pw.available,
        spawnAt: pw.spawnAt,
      })),
      events: this.lastEvents,
    };
    this.lastEvents = [];
    this.listener('snapshot', snap);
  }

  destroy() {
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = null;
  }
}
