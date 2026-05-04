// Shared with client/js/constants.js — keep in sync.
export const ARENA_W = 1280;
export const ARENA_H = 720;
export const CENTER_X = ARENA_W / 2;

export const PLAYER_RADIUS = 22;
export const PLAYER_SPEED = 280;            // px/s
export const PLAYER_SPEED_CHARGING = 140;   // slower while charging throw
export const PLAYER_HOLD_OFFSET = 28;       // ball offset while held

export const BALL_RADIUS = 14;
export const BALL_FRICTION = 0.985;         // per tick when rolling
export const BALL_LIVE_SPEED = 220;         // below this, ball becomes pickupable
export const THROW_SPEED_MIN = 460;
export const THROW_SPEED_MAX = 1020;
export const THROW_CHARGE_MS = 750;
export const CATCH_RADIUS = PLAYER_RADIUS + BALL_RADIUS + 6;

export const TICK_RATE = 30;
export const TICK_MS = Math.floor(1000 / TICK_RATE);

export const ROUND_COUNTDOWN_MS = 3000;
export const ROUND_END_DELAY_MS = 2500;
export const MATCH_END_DELAY_MS = 5000;
export const ROUNDS_TO_WIN = 2;             // best of 3
export const ROUND_TIME_LIMIT_MS = 90000;   // 90s per round

export const POWERUP_RESPAWN_MS = 9000;
export const POWERUP_SPAWN_POINTS = [
  { x: CENTER_X, y: 180 },
  { x: CENTER_X, y: ARENA_H - 180 },
  { x: CENTER_X, y: ARENA_H / 2 },
];
export const POWERUP_TYPES = ['speed', 'shield', 'multiball', 'bigball'];
export const POWERUP_DURATION_MS = 6500;

export const DEFAULT_BALLS = 2;
export const MAX_PLAYERS_PER_TEAM = 6;
export const MIN_PLAYERS_TO_START = 2;

export const TEAM_LEFT = 'left';
export const TEAM_RIGHT = 'right';
