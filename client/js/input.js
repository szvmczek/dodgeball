// Input state — held keys + mouse. Polls in render loop.
const KEYS = new Set();
let mouseX = 0, mouseY = 0;
let mouseDown = false;
let actionDownAt = 0;
let actionUpAt = 0;
let canvasEl = null;

const onKeyDown = (e) => {
  if (e.repeat) return;
  KEYS.add(e.code);
  if (e.code === 'Space') {
    if (!actionDownAt) actionDownAt = performance.now();
    e.preventDefault();
  }
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
};
const onKeyUp = (e) => {
  KEYS.delete(e.code);
  if (e.code === 'Space') actionUpAt = performance.now();
};

const onMouseMove = (e) => {
  if (!canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  mouseX = (e.clientX - rect.left) * (canvasEl.width / rect.width);
  mouseY = (e.clientY - rect.top) * (canvasEl.height / rect.height);
};
const onMouseDown = (e) => {
  if (e.button !== 0) return;
  mouseDown = true;
  actionDownAt = performance.now();
};
const onMouseUp = (e) => {
  if (e.button !== 0) return;
  if (mouseDown) actionUpAt = performance.now();
  mouseDown = false;
};

export const input = {
  init(canvas) {
    canvasEl = canvas;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  },
  destroy() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    if (canvasEl) {
      canvasEl.removeEventListener('mousemove', onMouseMove);
      canvasEl.removeEventListener('mousedown', onMouseDown);
    }
    window.removeEventListener('mouseup', onMouseUp);
    canvasEl = null;
    KEYS.clear();
  },
  /** Snapshot of held movement keys + flags. */
  state(myWorldX, myWorldY) {
    return {
      up: KEYS.has('KeyW') || KEYS.has('ArrowUp'),
      down: KEYS.has('KeyS') || KEYS.has('ArrowDown'),
      left: KEYS.has('KeyA') || KEYS.has('ArrowLeft'),
      right: KEYS.has('KeyD') || KEYS.has('ArrowRight'),
      action: mouseDown || KEYS.has('Space'),
      drop: KEYS.has('KeyE'),
      aim: Math.atan2(mouseY - myWorldY, mouseX - myWorldX),
      mouseX, mouseY,
    };
  },
  /** Pull and clear the latest action edges (down/up timestamps). */
  consumeEdges() {
    const d = actionDownAt, u = actionUpAt;
    actionDownAt = 0; actionUpAt = 0;
    return { down: d, up: u };
  },
  isChatKey(code) {
    return code === 'Enter' || code === 'NumpadEnter';
  },
  rawKey(code) { return KEYS.has(code); },
};
