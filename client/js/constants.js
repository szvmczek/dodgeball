// Mirror of server/constants.js — keep in sync.
export const ARENA_W = 1280;
export const ARENA_H = 720;
export const CENTER_X = ARENA_W / 2;

export const PLAYER_RADIUS = 22;
export const PLAYER_SPEED = 280;
export const PLAYER_SPEED_CHARGING = 140;
export const PLAYER_HOLD_OFFSET = 28;

export const BALL_RADIUS = 14;
export const BALL_LIVE_SPEED = 220;
export const THROW_CHARGE_MS = 750;
export const THROW_SPEED_MIN = 460;
export const THROW_SPEED_MAX = 1020;

export const TICK_RATE = 30;

export const ROUND_COUNTDOWN_MS = 3000;
export const ROUND_TIME_LIMIT_MS = 90000;

export const POWERUP_TYPES = ['speed', 'shield', 'multiball', 'bigball'];

export const TEAM_LEFT = 'left';
export const TEAM_RIGHT = 'right';

export const COLORS = {
  bgFloor: '#1a1d29',
  bgPattern: '#22273a',
  centerLine: '#3a4060',
  wallTop: '#2c3148',
  wallShadow: '#0e1019',
  teamLeft: '#4cc9f0',
  teamLeftDim: '#284d62',
  teamRight: '#f72585',
  teamRightDim: '#5e2240',
  ball: '#ffd166',
  ballHot: '#ff5a3c',
  shield: '#9bf6ff',
  speed: '#caffbf',
  multiball: '#ffadad',
  bigball: '#bdb2ff',
  text: '#e6e9f2',
  textDim: '#8a90a8',
};
