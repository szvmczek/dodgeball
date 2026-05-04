// Web Audio synthesis — no asset files needed.
let ctx = null;
let masterGain = null;
let muted = false;

function ensure() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.45;
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone({ freq = 440, dur = 0.12, type = 'sine', gain = 0.4, slide = 0, attack = 0.005, release = 0.08 } = {}) {
  if (muted) return;
  ensure();
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur + release);
  osc.connect(g).connect(masterGain);
  osc.start(t);
  osc.stop(t + dur + release + 0.05);
}

function noiseBurst({ dur = 0.12, gain = 0.3, hp = 1200 } = {}) {
  if (muted) return;
  ensure();
  const t = ctx.currentTime;
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = 'highpass';
  filt.frequency.value = hp;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(filt).connect(g).connect(masterGain);
  src.start(t);
}

export const audio = {
  setMuted(m) { muted = !!m; },
  pickup() { tone({ freq: 620, dur: 0.06, type: 'square', gain: 0.18 }); },
  charge() { tone({ freq: 280, dur: 0.04, type: 'triangle', gain: 0.08 }); },
  throw(power = 0.5) {
    tone({ freq: 240 + power * 200, dur: 0.18, type: 'sawtooth', gain: 0.18, slide: -160 });
    noiseBurst({ dur: 0.10, gain: 0.10, hp: 1500 });
  },
  hit() {
    tone({ freq: 90, dur: 0.18, type: 'square', gain: 0.32, slide: -50 });
    noiseBurst({ dur: 0.18, gain: 0.18, hp: 600 });
  },
  catch_() {
    tone({ freq: 520, dur: 0.10, type: 'triangle', gain: 0.22 });
    setTimeout(() => tone({ freq: 880, dur: 0.14, type: 'triangle', gain: 0.22 }), 60);
    setTimeout(() => tone({ freq: 1320, dur: 0.18, type: 'triangle', gain: 0.22 }), 130);
  },
  shieldBreak() {
    noiseBurst({ dur: 0.22, gain: 0.20, hp: 2400 });
    tone({ freq: 1400, dur: 0.10, type: 'sine', gain: 0.10, slide: -800 });
  },
  powerup() {
    tone({ freq: 660, dur: 0.08, type: 'square', gain: 0.18 });
    setTimeout(() => tone({ freq: 990, dur: 0.10, type: 'square', gain: 0.18 }), 70);
  },
  countdown() { tone({ freq: 700, dur: 0.10, type: 'square', gain: 0.18 }); },
  go()        { tone({ freq: 1200, dur: 0.30, type: 'square', gain: 0.22, slide: 400 }); },
  win()       {
    [0, 110, 220, 380].forEach((d, i) =>
      setTimeout(() => tone({ freq: [523, 659, 784, 1046][i], dur: 0.18, type: 'triangle', gain: 0.22 }), d)
    );
  },
  lose()      {
    [0, 150, 320].forEach((d, i) =>
      setTimeout(() => tone({ freq: [400, 320, 220][i], dur: 0.22, type: 'triangle', gain: 0.20 }), d)
    );
  },
};
