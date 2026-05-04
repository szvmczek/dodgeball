// Quick smoke test: spawn 2 mock socket clients, create room, join, start match, run a few ticks.
import { io as ioc } from 'socket.io-client';

const URL = 'http://localhost:3001';

function p(label, fn) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${label} timeout`)), 5000);
    fn((v) => { clearTimeout(t); res(v); });
  });
}

const a = ioc(URL, { transports: ['websocket'] });
const b = ioc(URL, { transports: ['websocket'] });

let snapsA = 0, snapsB = 0, eventsA = [];
a.on('snapshot', () => snapsA++);
b.on('snapshot', () => snapsB++);
a.on('matchEvent', (e) => eventsA.push(e.type));

await p('a connect', cb => a.on('connect', () => cb()));
await p('b connect', cb => b.on('connect', () => cb()));

const created = await p('create', cb => a.emit('createRoom', { nick: 'Alice' }, cb));
if (created.error) throw new Error('createRoom error: ' + created.error);
const code = created.code;
console.log('room created:', code, 'host:', created.you);

const joined = await p('join', cb => b.emit('joinRoom', { code, nick: 'Bob' }, cb));
if (joined.error) throw new Error('joinRoom error: ' + joined.error);
console.log('bob joined, lobby players:', joined.lobby.players.length);
if (!joined.lobby.canStart) throw new Error('lobby cant start with 2 players');

const started = await p('start', cb => a.emit('startMatch', null, cb));
if (started.error) throw new Error('startMatch error: ' + started.error);
console.log('match started');

a.emit('input', { up: 0, down: 0, left: 0, right: 1, aim: 0, action: false });
b.emit('input', { up: 0, down: 0, left: 1, right: 0, aim: Math.PI, action: false });

await new Promise(r => setTimeout(r, 1500));

console.log('snaps received: A=', snapsA, ' B=', snapsB);
console.log('events for A:', eventsA);

if (snapsA < 5 || snapsB < 5) throw new Error('not enough snapshots received');

a.emit('charge');
await new Promise(r => setTimeout(r, 600));
a.emit('release', { angle: 0 });

await new Promise(r => setTimeout(r, 500));

a.disconnect();
b.disconnect();
console.log('SMOKE TEST PASSED');
process.exit(0);
