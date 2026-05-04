import {
  ARENA_W, ARENA_H, CENTER_X,
  PLAYER_RADIUS, PLAYER_SPEED, PLAYER_SPEED_CHARGING,
  BALL_RADIUS, THROW_CHARGE_MS, COLORS,
  TEAM_LEFT, TEAM_RIGHT,
} from './constants.js';
import { input } from './input.js';
import { audio } from './audio.js';

const INTERP_DELAY_MS = 110;
const SNAPSHOT_BUFFER_MAX = 16;
const PREDICTION_CORRECTION = 12;   // px/s correction velocity

export class GameClient {
  constructor(canvas, net, hud) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.net = net;
    this.hud = hud;       // { setScore, setRound, setRoundTimer, showCharge, hideCharge, showOverlay, hideOverlay, showMatchEnd, toast }
    this.snapshots = [];
    this.lastServerTime = 0;
    this.serverClockOffset = 0;     // serverNow ≈ Date.now() + offset
    this.predicted = { x: 0, y: 0, has: false };
    this.particles = [];
    this.shake = 0;
    this.flash = 0;
    this.lastInputSentAt = 0;
    this.lastChargeState = false;
    this.lastChargeStarted = 0;
    this.running = false;
    this.lastFrame = performance.now();
    this.matchActive = false;
    this.gotMatchEnd = false;
    this.eventQueue = [];

    this.net.onSnapshot = (s) => this._onSnapshot(s);
    this.net.onMatchEvent = (ev) => this._onEvent(ev);
    this.net.onMatchStart = () => { this.matchActive = true; this.gotMatchEnd = false; };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.matchActive = true;
    this.gotMatchEnd = false;
    input.init(this.canvas);
    this.lastFrame = performance.now();
    this._loop();
  }

  stop() {
    this.running = false;
    input.destroy();
  }

  _onSnapshot(snap) {
    snap.recvAt = performance.now();
    this.snapshots.push(snap);
    if (this.snapshots.length > SNAPSHOT_BUFFER_MAX) this.snapshots.shift();
    // server clock alignment: snap.t is server epoch ms; we offset by recv-time
    if (this.snapshots.length === 1 || this.snapshots.length % 30 === 0) {
      this.serverClockOffset = snap.t - Date.now();
    }
    this.lastServerTime = snap.t;

    // initialize prediction from server position on first snapshot or after a respawn
    const me = snap.players.find(p => p.id === this.net.myId);
    if (me) {
      if (!this.predicted.has) {
        this.predicted.x = me.x;
        this.predicted.y = me.y;
        this.predicted.has = true;
      }
    }

    // queue server events for visual processing
    if (snap.events?.length) {
      for (const ev of snap.events) this.eventQueue.push(ev);
    }
  }

  _onEvent(ev) {
    switch (ev.type) {
      case 'roundStart':
        this.hud.showOverlay('start', `Runda ${ev.round}`);
        setTimeout(() => this.hud.hideOverlay('start'), 800);
        audio.countdown();
        break;
      case 'roundGo':
        this.hud.showOverlay('go', 'GO!');
        setTimeout(() => this.hud.hideOverlay('go'), 600);
        audio.go();
        break;
      case 'roundEnd': {
        let label;
        if (ev.draw) label = 'Remis rundy!';
        else if (ev.reason === 'timeout' || ev.reason === 'tiebreak-hits') {
          label = (ev.winner === TEAM_LEFT ? 'Niebiescy' : 'Różowi') + ' wygrywają na czas!';
        } else {
          label = (ev.winner === TEAM_LEFT ? 'Niebiescy' : 'Różowi') + ' biorą rundę!';
        }
        this.hud.showOverlay('roundEnd', label);
        setTimeout(() => this.hud.hideOverlay('roundEnd'), 2000);
        break;
      }
      case 'matchEnd':
        this.gotMatchEnd = true;
        this.matchActive = false;
        this.hud.showMatchEnd(ev);
        const myTeam = this._myTeam();
        if (myTeam && ev.winner === myTeam) audio.win(); else audio.lose();
        break;
    }
  }

  _myTeam() {
    const last = this.snapshots[this.snapshots.length - 1];
    if (!last) return null;
    const me = last.players.find(p => p.id === this.net.myId);
    return me?.team || null;
  }

  _loop = () => {
    if (!this.running) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    this._sendInputs(dt);
    this._processQueuedEvents();
    this._updatePrediction(dt);
    this._render(dt);
    requestAnimationFrame(this._loop);
  }

  _sendInputs(dt) {
    if (!this.matchActive) return;
    // get aim from current predicted position
    const px = this.predicted.x, py = this.predicted.y;
    const st = input.state(px, py);

    // edge events for action
    const edges = input.consumeEdges();
    if (edges.down) {
      this.net.charge();
      this.lastChargeStarted = performance.now();
    }
    if (edges.up) {
      // If we were charging or about to throw, send release with current aim
      this.net.release(st.aim);
      this.lastChargeStarted = 0;
    }
    if (st.drop) {
      this.net.drop();
    }

    // throttle input state to ~30 Hz
    const now = performance.now();
    if (now - this.lastInputSentAt > 33) {
      this.lastInputSentAt = now;
      this.net.sendInput({
        up: st.up, down: st.down, left: st.left, right: st.right,
        action: st.action, aim: st.aim,
      });
    }

    // HUD: charge meter
    const last = this.snapshots[this.snapshots.length - 1];
    const me = last?.players.find(p => p.id === this.net.myId);
    if (me?.charging > 0) {
      this.hud.showCharge(me.charging);
    } else {
      this.hud.hideCharge();
    }

    // HUD: round info
    if (last) {
      this.hud.setScore(last.scores[TEAM_LEFT], last.scores[TEAM_RIGHT]);
      const stateLabel = (() => {
        if (last.state === 'countdown') return `START ZA…`;
        if (last.state === 'roundEnd') return `KONIEC RUNDY`;
        if (last.state === 'matchEnd') return `KONIEC MECZU`;
        return `RUNDA ${last.round}`;
      })();
      this.hud.setRound(stateLabel);
      const serverNow = Date.now() + this.serverClockOffset;
      if (last.state === 'countdown') {
        const ms = Math.max(0, last.stateUntil - serverNow);
        this.hud.setRoundTimer(Math.ceil(ms / 1000) || '', false);
      } else if (last.state === 'playing' && last.roundEndsAt) {
        const ms = Math.max(0, last.roundEndsAt - serverNow);
        const sec = Math.ceil(ms / 1000);
        const m = Math.floor(sec / 60), s = sec % 60;
        this.hud.setRoundTimer(`${m}:${String(s).padStart(2,'0')}`, ms < 10000);
      } else {
        this.hud.setRoundTimer('', false);
      }
    }
  }

  _processQueuedEvents() {
    if (!this.eventQueue.length) return;
    for (const ev of this.eventQueue) {
      switch (ev.type) {
        case 'throw':
          audio.throw(ev.charge ?? 0.5);
          this._spawnThrowFx(ev.from);
          break;
        case 'hit':
          audio.hit();
          this._spawnHitFx(ev.victimId);
          this.shake = Math.min(18, this.shake + 14);
          this.flash = Math.min(0.7, this.flash + 0.5);
          break;
        case 'catch':
          audio.catch_();
          this._spawnCatchFx(ev.catcherId);
          this.flash = Math.min(0.5, this.flash + 0.3);
          break;
        case 'shieldBreak':
          audio.shieldBreak();
          this._spawnShieldFx(ev.playerId);
          break;
        case 'powerup':
          audio.powerup();
          this._spawnPickupFx(ev.playerId);
          break;
      }
    }
    this.eventQueue.length = 0;
  }

  _spawnThrowFx(playerId) {
    const last = this.snapshots[this.snapshots.length - 1];
    const p = last?.players.find(pp => pp.id === playerId);
    if (!p) return;
    for (let i = 0; i < 8; i++) {
      const a = p.aim + (Math.random() - 0.5) * 0.5;
      const sp = 60 + Math.random() * 120;
      this.particles.push({
        x: p.x + Math.cos(p.aim) * 28,
        y: p.y + Math.sin(p.aim) * 28,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.3 + Math.random()*0.2, age: 0,
        size: 3, color: '#ffd166', kind: 'spark',
      });
    }
  }
  _spawnHitFx(playerId) {
    const last = this.snapshots[this.snapshots.length - 1];
    const p = last?.players.find(pp => pp.id === playerId);
    if (!p) return;
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 240;
      this.particles.push({
        x: p.x, y: p.y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.5 + Math.random() * 0.3, age: 0,
        size: 4, color: p.team === TEAM_LEFT ? COLORS.teamLeft : COLORS.teamRight,
        kind: 'splat',
      });
    }
  }
  _spawnCatchFx(playerId) {
    const last = this.snapshots[this.snapshots.length - 1];
    const p = last?.players.find(pp => pp.id === playerId);
    if (!p) return;
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 50 + Math.random() * 120;
      this.particles.push({
        x: p.x, y: p.y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.6, age: 0,
        size: 4, color: '#9bf6ff', kind: 'ring',
      });
    }
  }
  _spawnShieldFx(playerId) {
    const last = this.snapshots[this.snapshots.length - 1];
    const p = last?.players.find(pp => pp.id === playerId);
    if (!p) return;
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 160;
      this.particles.push({
        x: p.x, y: p.y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.5, age: 0,
        size: 3, color: '#caf0f8', kind: 'spark',
      });
    }
  }
  _spawnPickupFx(playerId) {
    const last = this.snapshots[this.snapshots.length - 1];
    const p = last?.players.find(pp => pp.id === playerId);
    if (!p) return;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 80;
      this.particles.push({
        x: p.x, y: p.y - 10,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        life: 0.6, age: 0,
        size: 3, color: '#ffd166', kind: 'star',
      });
    }
  }

  _updatePrediction(dt) {
    if (!this.predicted.has) return;
    const last = this.snapshots[this.snapshots.length - 1];
    const me = last?.players.find(p => p.id === this.net.myId);
    if (!me) return;
    if (!me.alive) {
      // sync exactly to server when dead
      this.predicted.x = me.x;
      this.predicted.y = me.y;
      return;
    }
    if (last.state !== 'playing') {
      this.predicted.x = me.x;
      this.predicted.y = me.y;
      return;
    }
    // apply input at expected speed
    const st = input.state(this.predicted.x, this.predicted.y);
    let dx = (st.right ? 1 : 0) - (st.left ? 1 : 0);
    let dy = (st.down ? 1 : 0) - (st.up ? 1 : 0);
    const len = Math.hypot(dx, dy);
    if (len > 0) { dx /= len; dy /= len; }
    let speed = me.charging > 0 ? PLAYER_SPEED_CHARGING : PLAYER_SPEED;
    if (me.speed) speed *= 1.55;
    this.predicted.x += dx * speed * dt;
    this.predicted.y += dy * speed * dt;
    // walls + center line
    this.predicted.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_W - PLAYER_RADIUS, this.predicted.x));
    this.predicted.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_H - PLAYER_RADIUS, this.predicted.y));
    if (me.team === TEAM_LEFT) this.predicted.x = Math.min(this.predicted.x, CENTER_X - PLAYER_RADIUS - 2);
    else this.predicted.x = Math.max(this.predicted.x, CENTER_X + PLAYER_RADIUS + 2);

    // soft correction toward server position (Lerp)
    const ex = me.x - this.predicted.x, ey = me.y - this.predicted.y;
    const d = Math.hypot(ex, ey);
    if (d > 60) {
      // hard snap if drift too big
      this.predicted.x = me.x;
      this.predicted.y = me.y;
    } else {
      // smooth blend
      const t = Math.min(1, dt * 6);
      this.predicted.x += ex * t;
      this.predicted.y += ey * t;
    }
  }

  _render(dt) {
    // age particles
    for (const p of this.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy *= 0.94;
      if (p.kind === 'star') p.vy += 220 * dt;
    }
    this.particles = this.particles.filter(p => p.age < p.life);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - 60 * dt);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 1.4 * dt);

    const ctx = this.ctx;
    ctx.save();
    if (this.shake > 0) {
      ctx.translate((Math.random() - .5) * this.shake, (Math.random() - .5) * this.shake);
    }

    this._drawArena(ctx);

    const interp = this._interpolatedSnapshot();
    if (!interp) {
      ctx.restore();
      return;
    }

    this._drawPowerups(ctx, interp);
    this._drawPlayers(ctx, interp);
    this._drawBalls(ctx, interp);
    this._drawParticles(ctx);
    this._drawAimLine(ctx, interp);

    ctx.restore();

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  _drawArena(ctx) {
    // floor
    ctx.fillStyle = COLORS.bgFloor;
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);
    // diamond pattern
    ctx.fillStyle = COLORS.bgPattern;
    const grid = 60;
    for (let y = 0; y < ARENA_H; y += grid) {
      for (let x = (y / grid) % 2 === 0 ? 0 : grid/2; x < ARENA_W; x += grid) {
        ctx.fillRect(x, y, 2, 2);
      }
    }
    // team-side tints
    ctx.fillStyle = 'rgba(76, 201, 240, 0.05)';
    ctx.fillRect(0, 0, CENTER_X, ARENA_H);
    ctx.fillStyle = 'rgba(247, 37, 133, 0.05)';
    ctx.fillRect(CENTER_X, 0, ARENA_W - CENTER_X, ARENA_H);
    // center line
    ctx.strokeStyle = COLORS.centerLine;
    ctx.lineWidth = 4;
    ctx.setLineDash([10, 10]);
    ctx.beginPath();
    ctx.moveTo(CENTER_X, 0);
    ctx.lineTo(CENTER_X, ARENA_H);
    ctx.stroke();
    ctx.setLineDash([]);
    // outer frame
    ctx.strokeStyle = COLORS.wallTop;
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, ARENA_W - 6, ARENA_H - 6);
  }

  _interpolatedSnapshot() {
    const buf = this.snapshots;
    if (buf.length === 0) return null;
    if (buf.length === 1) return buf[0];
    const targetT = (Date.now() + this.serverClockOffset) - INTERP_DELAY_MS;
    let a = null, b = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= targetT) { a = buf[i]; b = buf[i+1] || buf[i]; break; }
    }
    if (!a) { a = buf[0]; b = buf[1] || buf[0]; }
    if (a === b) return a;
    const t = Math.min(1, Math.max(0, (targetT - a.t) / Math.max(1, (b.t - a.t))));
    return this._lerpSnapshot(a, b, t);
  }

  _lerpSnapshot(a, b, t) {
    const map = new Map(a.players.map(p => [p.id, p]));
    const players = b.players.map(pb => {
      const pa = map.get(pb.id) || pb;
      return {
        ...pb,
        x: pa.x + (pb.x - pa.x) * t,
        y: pa.y + (pb.y - pa.y) * t,
        aim: lerpAngle(pa.aim || 0, pb.aim || 0, t),
        charging: pb.charging,
      };
    });
    const ballMap = new Map(a.balls.map(b => [b.id, b]));
    const balls = b.balls.map(bb => {
      const ba = ballMap.get(bb.id) || bb;
      return { ...bb, x: ba.x + (bb.x - ba.x) * t, y: ba.y + (bb.y - ba.y) * t };
    });
    return { ...b, players, balls };
  }

  _drawPlayers(ctx, snap) {
    for (const p of snap.players) {
      const isMe = p.id === this.net.myId;
      let x = p.x, y = p.y;
      if (isMe && this.predicted.has) { x = this.predicted.x; y = this.predicted.y; }
      const teamColor = p.team === TEAM_LEFT ? COLORS.teamLeft : COLORS.teamRight;
      const dim = p.team === TEAM_LEFT ? COLORS.teamLeftDim : COLORS.teamRightDim;

      if (!p.alive) {
        // ghost / eliminated marker
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = dim;
        ctx.beginPath(); ctx.arc(x, y, PLAYER_RADIUS, 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = COLORS.textDim;
        ctx.font = 'bold 13px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('OUT', x, y + 4);
        ctx.fillText(p.nick, x, y - PLAYER_RADIUS - 8);
        continue;
      }

      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(x, y + PLAYER_RADIUS - 2, PLAYER_RADIUS * 0.9, PLAYER_RADIUS * 0.32, 0, 0, Math.PI*2); ctx.fill();

      // shield ring
      if (p.shield) {
        ctx.strokeStyle = COLORS.shield;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, PLAYER_RADIUS + 6, 0, Math.PI*2); ctx.stroke();
      }
      // speed buff trail aura
      if (p.speed) {
        ctx.fillStyle = 'rgba(202,255,191,0.18)';
        ctx.beginPath(); ctx.arc(x, y, PLAYER_RADIUS + 9, 0, Math.PI*2); ctx.fill();
      }
      // catch active glow
      if (p.catchActive) {
        ctx.strokeStyle = 'rgba(255,209,102,0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, PLAYER_RADIUS + 4, 0, Math.PI*2); ctx.stroke();
      }

      // body
      const grad = ctx.createRadialGradient(x - 6, y - 6, 4, x, y, PLAYER_RADIUS);
      grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.2, teamColor); grad.addColorStop(1, dim);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(x, y, PLAYER_RADIUS, 0, Math.PI*2); ctx.fill();
      // outline
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, PLAYER_RADIUS, 0, Math.PI*2); ctx.stroke();

      // direction indicator
      const ax = x + Math.cos(p.aim) * (PLAYER_RADIUS - 3);
      const ay = y + Math.sin(p.aim) * (PLAYER_RADIUS - 3);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(ax, ay, 4, 0, Math.PI*2); ctx.fill();

      // charge ring
      if (p.charging > 0) {
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(x, y, PLAYER_RADIUS + 8, -Math.PI/2, -Math.PI/2 + p.charging * Math.PI*2);
        ctx.stroke();
      }

      // nick
      ctx.fillStyle = isMe ? COLORS.text : COLORS.textDim;
      ctx.font = (isMe ? 'bold ' : '') + '13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(p.nick, x, y - PLAYER_RADIUS - 8);
    }
  }

  _drawBalls(ctx, snap) {
    for (const b of snap.balls) {
      if (b.owner) continue;        // drawn relative to player elsewhere if needed
      const r = b.big ? BALL_RADIUS * 1.7 : BALL_RADIUS;
      // motion trail
      const sp = Math.hypot(b.vx || 0, b.vy || 0);
      if (b.live && sp > 0) {
        const len = Math.min(40, sp / 30);
        const ang = Math.atan2(b.vy, b.vx);
        const tx = b.x - Math.cos(ang) * len, ty = b.y - Math.sin(ang) * len;
        const grad = ctx.createLinearGradient(tx, ty, b.x, b.y);
        grad.addColorStop(0, 'rgba(255,90,60,0)');
        grad.addColorStop(1, 'rgba(255,90,60,0.7)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = r * 1.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      const grad = ctx.createRadialGradient(b.x - 3, b.y - 3, 1, b.x, b.y, r);
      grad.addColorStop(0, '#fff8c5'); grad.addColorStop(0.6, b.live ? COLORS.ballHot : COLORS.ball); grad.addColorStop(1, '#a07215');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI*2); ctx.stroke();
    }
    // balls held by players
    for (const b of snap.balls) {
      if (!b.owner) continue;
      const r = b.big ? BALL_RADIUS * 1.7 : BALL_RADIUS;
      ctx.fillStyle = COLORS.ball;
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI*2); ctx.stroke();
    }
  }

  _drawPowerups(ctx, snap) {
    const now = Date.now() + this.serverClockOffset;
    for (const pw of snap.powerups || []) {
      if (!pw.available) {
        // pending — show ghost timer
        const remain = Math.max(0, (pw.spawnAt - now) / 1000);
        if (remain > 0 && remain < 3) {
          ctx.globalAlpha = 0.3 + 0.4 * (1 - remain / 3);
          this._drawPowerupIcon(ctx, pw.x, pw.y, pw.type);
          ctx.globalAlpha = 1;
        }
        continue;
      }
      // bobbing
      const bob = Math.sin(now / 220) * 4;
      this._drawPowerupIcon(ctx, pw.x, pw.y + bob, pw.type);
    }
  }
  _drawPowerupIcon(ctx, x, y, type) {
    const color = type === 'speed' ? COLORS.speed : type === 'shield' ? COLORS.shield : type === 'multiball' ? COLORS.multiball : COLORS.bigball;
    const r = 18;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath(); ctx.arc(x, y + 4, r * 0.95, 0, Math.PI*2); ctx.fill();
    const grad = ctx.createRadialGradient(x - 4, y - 4, 2, x, y, r);
    grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.stroke();
    // icon
    ctx.fillStyle = '#1a1d29';
    ctx.font = 'bold 18px system-ui';
    ctx.textAlign = 'center';
    const sym = type === 'speed' ? '»' : type === 'shield' ? '◊' : type === 'multiball' ? '⁂' : '●';
    ctx.fillText(sym, x, y + 6);
  }

  _drawParticles(ctx) {
    for (const p of this.particles) {
      const a = Math.max(0, 1 - p.age / p.life);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const s = p.size * (p.kind === 'splat' ? (1 - a) + 0.3 : 1);
      if (p.kind === 'ring') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size + (1 - a) * 14, 0, Math.PI*2); ctx.stroke();
      } else {
        ctx.fillRect(p.x - s/2, p.y - s/2, s, s);
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawAimLine(ctx, snap) {
    const me = snap.players.find(p => p.id === this.net.myId);
    if (!me || !me.alive) return;
    const px = this.predicted.x, py = this.predicted.y;
    const st = input.state(px, py);
    const angle = st.aim;
    const length = me.charging > 0 ? 220 + me.charging * 240 : 70;
    const tx = px + Math.cos(angle) * length;
    const ty = py + Math.sin(angle) * length;
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.lineDashOffset = -performance.now() / 30;
    ctx.strokeStyle = me.charging > 0 ? '#ff5a3c' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = me.charging > 0 ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.restore();
    // aim reticle at cursor
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(st.mouseX, st.mouseY, 8, 0, Math.PI*2);
    ctx.moveTo(st.mouseX - 12, st.mouseY); ctx.lineTo(st.mouseX - 4, st.mouseY);
    ctx.moveTo(st.mouseX + 4, st.mouseY); ctx.lineTo(st.mouseX + 12, st.mouseY);
    ctx.moveTo(st.mouseX, st.mouseY - 12); ctx.lineTo(st.mouseX, st.mouseY - 4);
    ctx.moveTo(st.mouseX, st.mouseY + 4); ctx.lineTo(st.mouseX, st.mouseY + 12);
    ctx.stroke();
  }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
