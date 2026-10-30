// Turbo Crew — сервер мультиплеерных гонок (Node.js + WebSocket)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (e, d) => {
      if (e) { res.writeHead(500); return res.end('index.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
  } else if (url === '/health') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

const COLORS = ['#ff4d4d', '#4da6ff', '#ffd24d', '#5fe08a', '#c77dff', '#ff9f43', '#2ee6d6', '#ff6bd6'];
const MAX_PLAYERS = 8;
const MODE_KEYS = ['race', 'time', 'elim', 'sumo'];
const LAP_OPTS = [2, 3, 5, 8];
const TIME_LIMIT = 90;      // «Лучший круг», секунд
const ELIM_FIRST = 20;      // «Выбывание»: первое выбывание через N с
const ELIM_STEP = 15;       // дальше каждые N с
const SUMO_LIMIT = 150;     // «Сумо»: максимум секунд
const FIN_GRACE = 20000;    // «Классика»: сколько ждём остальных после первого финиша, мс

const rooms = new Map();
let nextId = 1;

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const bc = (r, o) => {
  const s = JSON.stringify(o);
  for (const p of r.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
};

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[(Math.random() * A.length) | 0]).join(''); } while (rooms.has(c));
  return c;
}

const cleanName = n => String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 14) || 'Гонщик';

function roomInfo(r) {
  return {
    t: 'room', code: r.code, host: r.host, mode: r.mode, laps: r.laps, phase: r.phase,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color })),
  };
}

function resetPlayer(p) {
  p.st = { x: 0, y: 0, a: 0, v: 0, p: 0, b: null };
  p.fin = null;
  p.out = false;
  p.outAt = 0;
}

function addPlayer(r, me) {
  const used = new Set([...r.players.values()].map(p => p.color));
  me.color = COLORS.find(c => !used.has(c)) || COLORS[0];
  me.room = r;
  r.players.set(me.id, me);
  resetPlayer(me);
  send(me.ws, { t: 'joined', id: me.id, code: r.code });
  bc(r, roomInfo(r));
}

function markOut(r, p) {
  p.out = true;
  p.outAt = Date.now();
  r.outOrder.push(p.id);
}

function checkEnd(r) {
  if (r.phase !== 'race') return;
  const ps = [...r.players.values()];
  if (r.mode === 'race') {
    if (ps.length && ps.every(p => p.fin !== null)) finish(r);
  } else if (r.mode === 'elim' || r.mode === 'sumo') {
    if (ps.filter(p => !p.out).length <= 1) finish(r);
  }
}

function startRace(r) {
  r.phase = 'count';
  r.finOrder = [];
  r.outOrder = [];
  r.deadline = 0;
  r.nextElim = ELIM_FIRST;
  const ps = [...r.players.values()];
  const slots = {};
  ps.forEach((p, i) => { resetPlayer(p); slots[p.id] = i; });
  bc(r, { t: 'start', mode: r.mode, laps: r.laps, slots, n: ps.length });
  let n = 3;
  bc(r, { t: 'cd', n });
  r.cdTimer = setInterval(() => {
    n--;
    if (n > 0) { bc(r, { t: 'cd', n }); return; }
    clearInterval(r.cdTimer);
    r.phase = 'race';
    r.t0 = Date.now();
    bc(r, { t: 'go' });
  }, 1000);
  r.tick = setInterval(() => tick(r), 50);
}

function tick(r) {
  const now = Date.now();
  const el = r.phase === 'race' ? (now - r.t0) / 1000 : 0;
  if (r.phase === 'race') {
    if (r.mode === 'race' && r.deadline && now > r.deadline) return finish(r);
    if (r.mode === 'time' && el >= TIME_LIMIT) return finish(r);
    if (r.mode === 'sumo' && el >= SUMO_LIMIT) return finish(r);
    if (r.mode === 'elim' && el >= r.nextElim) {
      const alive = [...r.players.values()].filter(p => !p.out);
      if (alive.length > 1) {
        alive.sort((a, b) => a.st.p - b.st.p);
        const v = alive[0];
        markOut(r, v);
        bc(r, { t: 'elim', id: v.id });
      }
      r.nextElim += ELIM_STEP;
      checkEnd(r);
      if (r.phase === 'done') return;
    }
  }
  bc(r, {
    t: 'snap', el,
    cars: [...r.players.values()].map(p => ({
      id: p.id, x: p.st.x, y: p.st.y, a: p.st.a, v: p.st.v, p: p.st.p, b: p.st.b, out: p.out,
    })),
  });
}

function finish(r) {
  if (r.phase === 'done') return;
  r.phase = 'done';
  clearInterval(r.tick);
  clearInterval(r.cdTimer);
  const ps = [...r.players.values()];
  let order;
  if (r.mode === 'race') {
    const fin = r.finOrder.map(id => r.players.get(id)).filter(Boolean);
    const rest = ps.filter(p => p.fin === null).sort((a, b) => b.st.p - a.st.p);
    order = [...fin, ...rest];
  } else if (r.mode === 'time') {
    order = ps.slice().sort((a, b) => (a.st.b ?? 1e9) - (b.st.b ?? 1e9));
  } else {
    const alive = ps.filter(p => !p.out).sort((a, b) => b.st.p - a.st.p);
    const outs = r.outOrder.map(id => r.players.get(id)).filter(Boolean).reverse();
    order = [...alive, ...outs];
  }
  bc(r, {
    t: 'results', mode: r.mode,
    list: order.map((p, i) => ({
      id: p.id, name: p.name, color: p.color, place: i + 1, time: p.fin, best: p.st.b, out: p.out,
    })),
  });
}

function leave(me) {
  const r = me.room;
  if (!r) return;
  r.players.delete(me.id);
  me.room = null;
  if (r.players.size === 0) {
    clearInterval(r.tick);
    clearInterval(r.cdTimer);
    rooms.delete(r.code);
    return;
  }
  if (r.host === me.id) r.host = r.players.keys().next().value;
  bc(r, roomInfo(r));
  checkEnd(r);
}

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

wss.on('connection', ws => {
  const me = { id: nextId++, ws, room: null, name: 'Гонщик', color: COLORS[0], alive: true };
  ws.on('pong', () => { me.alive = true; });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const r = me.room;

    switch (m.t) {
      case 'create': {
        if (r) return;
        me.name = cleanName(m.name);
        const nr = {
          code: genCode(), host: me.id, players: new Map(), mode: 'race', laps: 3, phase: 'lobby',
          finOrder: [], outOrder: [], deadline: 0, nextElim: ELIM_FIRST, t0: 0,
        };
        rooms.set(nr.code, nr);
        addPlayer(nr, me);
        break;
      }
      case 'join': {
        if (r) return;
        me.name = cleanName(m.name);
        const jr = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!jr) return send(ws, { t: 'err', msg: 'Комната не найдена' });
        if (jr.phase !== 'lobby') return send(ws, { t: 'err', msg: 'Гонка уже идёт — дождись конца заезда' });
        if (jr.players.size >= MAX_PLAYERS) return send(ws, { t: 'err', msg: 'Комната заполнена (максимум 8)' });
        addPlayer(jr, me);
        break;
      }
      case 'cfg': {
        if (!r || r.host !== me.id || r.phase !== 'lobby') return;
        if (MODE_KEYS.includes(m.mode)) r.mode = m.mode;
        if (LAP_OPTS.includes(m.laps)) r.laps = m.laps;
        bc(r, roomInfo(r));
        break;
      }
      case 'start': {
        if (!r || r.host !== me.id || r.phase !== 'lobby') return;
        if ((r.mode === 'elim' || r.mode === 'sumo') && r.players.size < 2) {
          return send(ws, { t: 'err', msg: 'Для этого режима нужно минимум 2 игрока' });
        }
        startRace(r);
        break;
      }
      case 'st': {
        if (!r || (r.phase !== 'race' && r.phase !== 'count') || me.out) return;
        me.st = {
          x: num(m.x), y: num(m.y), a: num(m.a), v: num(m.v), p: num(m.p),
          b: typeof m.b === 'number' && isFinite(m.b) && m.b > 0 ? m.b : null,
        };
        break;
      }
      case 'fin': {
        if (!r || r.phase !== 'race' || r.mode !== 'race' || me.fin !== null) return;
        me.fin = (Date.now() - r.t0) / 1000;
        r.finOrder.push(me.id);
        if (!r.deadline) r.deadline = Date.now() + FIN_GRACE;
        checkEnd(r);
        break;
      }
      case 'out': {
        if (!r || r.phase !== 'race' || r.mode !== 'sumo' || me.out) return;
        markOut(r, me);
        checkEnd(r);
        break;
      }
      case 'again': {
        if (!r || r.host !== me.id || r.phase !== 'done') return;
        r.phase = 'lobby';
        bc(r, roomInfo(r));
        break;
      }
    }
  });

  ws.on('close', () => leave(me));
  ws.on('error', () => {});
});

// пинг, чтобы хостинги не обрывали соединения
setInterval(() => {
  for (const ws of wss.clients) ws.ping();
}, 25000);

server.listen(PORT, () => console.log('Turbo Crew запущен: http://localhost:' + PORT));
