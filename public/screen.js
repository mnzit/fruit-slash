// Screen: hosts the room, answers WebRTC offers from phones, runs the game.
'use strict';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0;
let bgGrad = null, vignette = null;
function resize() {
  W = canvas.width = window.innerWidth * devicePixelRatio;
  H = canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';

  // night-sky gradient with a warm glow low on the horizon
  bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, '#0b1026');
  bgGrad.addColorStop(0.55, '#1a2144');
  bgGrad.addColorStop(0.85, '#33234a');
  bgGrad.addColorStop(1, '#4a2b3f');

  vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
}
window.addEventListener('resize', resize);
resize();

// slow-drifting ambient dust that gives the scene depth
const dust = Array.from({ length: 50 }, () => ({
  x: Math.random(), y: Math.random(),
  r: 0.8 + Math.random() * 2.2,
  speed: 0.004 + Math.random() * 0.012,
  phase: Math.random() * Math.PI * 2,
  twinkle: 0.5 + Math.random() * 1.5,
}));

function drawBackground(now) {
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  for (const d of dust) {
    d.y -= d.speed * 0.016; // gentle upward drift
    if (d.y < -0.02) { d.y = 1.02; d.x = Math.random(); }
    const a = 0.10 + 0.12 * (0.5 + 0.5 * Math.sin(now * 0.001 * d.twinkle + d.phase));
    ctx.globalAlpha = a;
    ctx.fillStyle = '#aebdff';
    ctx.beginPath();
    ctx.arc(d.x * W, d.y * H, d.r * devicePixelRatio, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

const PLAYER_COLORS = ['#ff4d6d', '#4ade80', '#38bdf8', '#ffd23f', '#c084fc', '#fb923c', '#f472b6', '#2dd4bf'];
// Each player also gets a distinct blade-trail pattern, so trails are
// tellable apart even for colorblind players or similar colors.
const TRAIL_PATTERNS = ['solid', 'glow', 'dashed', 'dots', 'core'];

// ---- State ----
const players = new Map(); // id -> {name,color,score,cursor:{x,y},prev:{x,y},trail:[{x,y,t}],pc,dc}
const fruits = [];
const particles = [];
const popups = []; // floating "+1" score texts
let gameRunning = false;
let ws = null;
let roomCode = null;

// round / effect state
const ROUND_MS = 60000;
let roundEnd = 0;    // timestamp when the current round finishes
let slowUntil = 0;   // ❄️ slow-motion active until this timestamp
let frenzyUntil = 0; // fruit storm active until this timestamp
let nextFrenzy = 0;  // when the next frenzy kicks off

// ---- Signaling ----
function connectSignaling() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'create-room' }));
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'room-created') {
      roomCode = msg.room;
      showLobbyInfo();
    } else if (msg.type === 'peer-joined') {
      addPlayer(msg.id, msg.name);
    } else if (msg.type === 'peer-left') {
      removePlayer(msg.id);
    } else if (msg.type === 'signal') {
      await handleSignal(msg.from, msg.data);
    } else if (msg.type === 'input') {
      // Relay fallback: game input arriving via the server instead of WebRTC.
      const p = players.get(msg.from);
      if (p) handleInput(p, msg.data);
    }
  };
  ws.onclose = () => setTimeout(connectSignaling, 2000);
}

async function showLobbyInfo() {
  // Prefer the LAN IP so the QR works on phones even when the screen page
  // itself was opened via localhost.
  let host = location.host;
  if (/^(localhost|127\.0\.0\.1)/.test(location.hostname)) {
    try {
      const cfg = await fetch('/config').then(r => r.json());
      if (cfg.lanIPs?.length) host = `${cfg.lanIPs[0]}:${cfg.port}`;
    } catch {}
  }
  const joinUrl = `https://${host}/play?room=${roomCode}`;
  document.getElementById('room-code').textContent = roomCode;
  document.getElementById('join-url').textContent = joinUrl;
  drawQR(document.getElementById('qr'), joinUrl, 220);
}

function drawQR(cnv, text, size) {
  const qr = qrcode(0, 'M'); // type 0 = auto-size
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const scale = Math.floor(size / (n + 4));
  const px = scale * (n + 4);
  cnv.width = cnv.height = px;
  const c = cnv.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, px, px);
  c.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(r, col)) c.fillRect((col + 2) * scale, (r + 2) * scale, scale, scale);
    }
  }
}

// ---- WebRTC (screen answers offers from controllers) ----
async function handleSignal(fromId, data) {
  let p = players.get(fromId);
  if (!p) return;
  if (data.sdp) {
    if (!p.pc) createPeer(p, fromId);
    await p.pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'signal', to: fromId, data: { sdp: p.pc.localDescription } }));
    }
  } else if (data.candidate) {
    if (!p.pc) createPeer(p, fromId);
    try { await p.pc.addIceCandidate(data.candidate); } catch {}
  }
}

function createPeer(p, id) {
  // LAN-only: host candidates are enough, no STUN needed.
  p.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  p.pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'signal', to: id, data: { candidate: e.candidate } }));
  };
  p.pc.ondatachannel = (e) => {
    p.dc = e.channel;
    p.dc.onmessage = (ev) => handleInput(p, JSON.parse(ev.data));
  };
}

function handleInput(p, msg) {
  if (msg.t === 'move') {
    // Normalized coords 0..1 from the phone's pointing model.
    p.prev = p.cursor;
    p.cursor = { x: msg.x * W, y: msg.y * H };
    p.trail.push({ ...p.cursor, t: performance.now() });
    if (p.trail.length > 24) p.trail.shift();
    if (gameRunning) checkSlices(p, p.prev, p.cursor);
  } else if (msg.t === 'tap') {
    // On the game-over screen, a phone tap "clicks" whatever the cursor hovers.
    if (document.getElementById('gameover').classList.contains('active') &&
        cursorOverButton(p, document.getElementById('again'))) {
      document.getElementById('again').click();
    }
  } else if (msg.t === 'ready') {
    p.ready = true;
    updateLobby();
  }
}

function cursorOverButton(p, btn) {
  const r = btn.getBoundingClientRect();
  const x = p.cursor.x / devicePixelRatio, y = p.cursor.y / devicePixelRatio;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// ---- Players ----
function addPlayer(id, name) {
  const color = PLAYER_COLORS[players.size % PLAYER_COLORS.length];
  const pattern = TRAIL_PATTERNS[players.size % TRAIL_PATTERNS.length];
  players.set(id, {
    id, name, color, pattern, score: 0, ready: false,
    cursor: { x: W / 2, y: H / 2 }, prev: { x: W / 2, y: H / 2 },
    trail: [], pc: null, dc: null,
  });
  updateLobby();
}

function removePlayer(id) {
  const p = players.get(id);
  if (p?.pc) p.pc.close();
  if (p?.dotEl) p.dotEl.remove();
  players.delete(id);
  updateLobby();
}

function updateLobby() {
  const box = document.getElementById('players-lobby');
  box.innerHTML = '';
  for (const p of players.values()) {
    const tag = document.createElement('div');
    tag.className = 'ptag';
    tag.style.background = p.color;
    tag.textContent = (p.ready ? '✔ ' : '… ') + p.name;
    box.appendChild(tag);
  }
  const btn = document.getElementById('start');
  btn.disabled = players.size === 0;
  btn.textContent = players.size === 0 ? 'Waiting for players…' : `Start game (${players.size} player${players.size > 1 ? 's' : ''})`;
}

function beginRound() {
  const nowMs = performance.now();
  roundEnd = nowMs + ROUND_MS;
  nextFrenzy = nowMs + 15000 + Math.random() * 8000;
  frenzyUntil = 0;
  slowUntil = 0;
  for (const p of players.values()) { p.combo = 0; p.comboT = 0; p.doubleUntil = 0; }
  SFX.init();       // audio must start from a user gesture
  SFX.music(true);
  gameRunning = true;
  for (const p of players.values()) send(p, { t: 'start' });
}

document.getElementById('start').addEventListener('click', () => {
  document.getElementById('lobby').style.display = 'none';
  beginRound();
});

function send(p, msg) {
  if (p.dc && p.dc.readyState === 'open') {
    p.dc.send(JSON.stringify(msg));
  } else if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'feedback', to: p.id, data: msg }));
  }
}

// ---- Fruits ----
// Each fruit has its own slice pitch (tone, Hz) — big fruit low, small fruit high.
const FRUIT_TYPES = [
  { emoji: '🍉', r: 46, pts: 1, tone: 196 }, { emoji: '🍊', r: 38, pts: 1, tone: 330 },
  { emoji: '🍎', r: 38, pts: 1, tone: 392 }, { emoji: '🍌', r: 42, pts: 1, tone: 262 },
  { emoji: '🍓', r: 34, pts: 2, tone: 587 }, { emoji: '🥝', r: 34, pts: 2, tone: 494 },
  { emoji: '🍍', r: 48, pts: 3, tone: 147 },
];
const BOMB = { emoji: '💣', r: 40, bomb: true };
const GEM = { emoji: '💎', r: 36, pts: 10, tone: 988 };
const FREEZE = { emoji: '❄️', r: 36, pts: 2, tone: 740, power: 'slow' };
const STAR = { emoji: '⭐', r: 36, pts: 2, tone: 830, power: 'double' };

function pickType() {
  const r = Math.random();
  // No bombs or specials during a frenzy — pure fruit celebration.
  if (performance.now() >= frenzyUntil) {
    if (r < 0.025) return GEM;
    if (r < 0.05) return FREEZE;
    if (r < 0.075) return STAR;
    if (r < 0.16) return BOMB;
  }
  return FRUIT_TYPES[Math.floor(Math.random() * FRUIT_TYPES.length)];
}

let spawnTimer = 0;
function spawnFruit() {
  const t = pickType();
  const x = W * (0.15 + Math.random() * 0.7);
  fruits.push({
    ...t,
    r: t.r * devicePixelRatio,
    x, y: H + 60,
    vx: (W / 2 - x) * 0.0009 + (Math.random() - 0.5) * 0.25 * devicePixelRatio,
    vy: -(1.15 + Math.random() * 0.5) * H * 0.0011,
    rot: Math.random() * Math.PI * 2,
    vrot: (Math.random() - 0.5) * 0.006,
    sliced: false,
  });
}

const GRAVITY = 0.0016;

function updateFruits(dt) {
  const nowMs = performance.now();
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnFruit();
    if (Math.random() < 0.35) spawnFruit();
    if (nowMs < frenzyUntil) {
      spawnTimer = 130; // fruit storm!
    } else {
      // ramp up: spawns get faster as the round runs down
      const prog = Math.min(1, Math.max(0, 1 - (roundEnd - nowMs) / ROUND_MS));
      spawnTimer = (1250 - 800 * prog) * (0.7 + Math.random() * 0.6);
    }
  }
  for (let i = fruits.length - 1; i >= 0; i--) {
    const f = fruits[i];
    f.vy += GRAVITY * dt * devicePixelRatio;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    f.rot += f.vrot * dt;
    if (f.y > H + 120 && f.vy > 0) fruits.splice(i, 1);
  }
}

// ---- Slicing ----
function checkSlices(p, a, b) {
  const speed = Math.hypot(b.x - a.x, b.y - a.y);
  if (speed < 6 * devicePixelRatio) return; // must actually swing
  for (const f of fruits) {
    if (f.sliced) continue;
    if (segCircleDist(a, b, f) <= f.r) {
      f.sliced = true;
      if (f.bomb) {
        SFX.bomb();
        send(p, { t: 'bomb' });
        explode(f, p.color);
        gameOver('💥 GAME OVER', `${p.name} hit a bomb! 💣`);
        return;
      }
      const nowMs = performance.now();
      if (f.power === 'slow') {
        slowUntil = nowMs + 6000;
        SFX.power();
        popups.push({ x: f.x, y: f.y, text: '❄️ SLOW-MO!', color: '#7dd3fc', life: 1400, maxLife: 1400 });
      } else if (f.power === 'double') {
        p.doubleUntil = nowMs + 10000;
        SFX.power();
        popups.push({ x: f.x, y: f.y, text: '⭐ 2x POINTS!', color: '#ffd23f', life: 1400, maxLife: 1400 });
      }
      const mult = nowMs < (p.doubleUntil || 0) ? 2 : 1;
      const gained = f.pts * mult;
      p.score += gained;
      p.combo = (p.combo || 0) + 1;
      p.comboT = 350; // slices within this window chain into a combo
      p.comboAt = { x: f.x, y: f.y };
      SFX.slice(f.tone);
      send(p, { t: 'slice' });
      explode(f, p.color);
      popups.push({ x: f.x, y: f.y, text: `+${gained}`, color: f.emoji === '💎' || mult > 1 ? '#ffd23f' : p.color, life: 900, maxLife: 900 });
      const idx = fruits.indexOf(f);
      if (idx !== -1) fruits.splice(idx, 1);
    }
  }
}

function segCircleDist(a, b, c) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + t * dx - c.x, a.y + t * dy - c.y);
}

function explode(f, color) {
  const n = f.bomb ? 26 : 14;
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = (0.1 + Math.random() * 0.45) * devicePixelRatio;
    particles.push({
      x: f.x, y: f.y,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.2,
      life: 500 + Math.random() * 400,
      color: f.bomb ? (Math.random() < 0.5 ? '#ff4d4d' : '#ffb020') : color,
      size: (2 + Math.random() * 4) * devicePixelRatio,
      emoji: !f.bomb && i < 2 ? f.emoji : null,
      rot: Math.random() * Math.PI * 2,
    });
  }
}

// ---- Game over / restart ----
function gameOver(title, subtitle) {
  gameRunning = false;
  SFX.music(false);
  fruits.length = 0;
  document.getElementById('go-title').textContent = title;
  document.getElementById('culprit').textContent = subtitle;
  const list = document.getElementById('final-scores');
  list.innerHTML = '';
  const ranked = [...players.values()].sort((a, b) => b.score - a.score);
  ranked.forEach((p, i) => {
    const row = document.createElement('div');
    row.style.color = p.color;
    row.textContent = `${i === 0 ? '🏆 ' : ''}${p.name}: ${p.score}`;
    if (i === 0) row.className = 'winner';
    list.appendChild(row);
  });
  document.getElementById('gameover').classList.add('active');
  for (const p of players.values()) send(p, { t: 'over' });
}

// While the game-over overlay is up, mirror each player's cursor as a DOM dot
// above it so they can aim at the Play Again button.
function updateOverlayCursors() {
  const over = document.getElementById('gameover');
  const btn = document.getElementById('again');
  if (!over.classList.contains('active')) return;
  let anyHover = false;
  for (const p of players.values()) {
    if (!p.dotEl) {
      p.dotEl = document.createElement('div');
      p.dotEl.className = 'cursor-dot';
      p.dotEl.style.background = p.color;
      over.appendChild(p.dotEl);
    }
    p.dotEl.style.left = p.cursor.x / devicePixelRatio + 'px';
    p.dotEl.style.top = p.cursor.y / devicePixelRatio + 'px';
    if (cursorOverButton(p, btn)) anyHover = true;
  }
  btn.classList.toggle('hover', anyHover);
}

document.getElementById('again').addEventListener('click', () => {
  for (const p of players.values()) p.score = 0;
  fruits.length = 0;
  particles.length = 0;
  popups.length = 0;
  spawnTimer = 800;
  document.getElementById('gameover').classList.remove('active');
  document.getElementById('again').classList.remove('hover');
  for (const p of players.values()) {
    if (p.dotEl) { p.dotEl.remove(); p.dotEl = null; }
  }
  beginRound();
});

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    pt.vy += GRAVITY * dt * devicePixelRatio * 0.6;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.life -= dt;
    if (pt.life <= 0) particles.splice(i, 1);
  }
}

// ---- Trails: one visual pattern per player ----
function drawTrail(p, pts, nowT) {
  const dpr = devicePixelRatio;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const segment = (i, width) => {
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  };

  for (let i = 1; i < pts.length; i++) {
    const age = (nowT - pts[i].t) / 250; // 0 fresh → 1 gone
    const fade = 1 - age;

    switch (p.pattern) {
      case 'glow':
        ctx.save();
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 18 * dpr * fade;
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = fade;
        segment(i, (8 - 6 * age) * dpr);
        ctx.restore();
        break;

      case 'dashed':
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = fade;
        ctx.setLineDash([10 * dpr, 8 * dpr]);
        segment(i, (9 - 7 * age) * dpr);
        ctx.setLineDash([]);
        break;

      case 'dots':
        ctx.fillStyle = p.color;
        ctx.globalAlpha = fade;
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, (6 - 4 * age) * dpr, 0, Math.PI * 2);
        ctx.fill();
        break;

      case 'core': // colored blade with a bright white center line
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = fade;
        segment(i, (12 - 9 * age) * dpr);
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = fade * 0.9;
        segment(i, (4 - 3 * age) * dpr);
        break;

      default: // solid
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = fade;
        segment(i, (10 - 8 * age) * dpr);
    }
  }
  ctx.globalAlpha = 1;
}

// ---- Render ----
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(40, now - lastT);
  lastT = now;

  drawBackground(now);

  if (gameRunning) {
    // round timer
    if (now >= roundEnd) {
      const winner = [...players.values()].sort((a, b) => b.score - a.score)[0];
      gameOver("⏱ TIME'S UP!", winner ? `${winner.name} wins! 🏆` : '');
    }
    // frenzy scheduling
    if (now >= nextFrenzy) {
      frenzyUntil = now + 3500;
      nextFrenzy = now + 18000 + Math.random() * 9000;
      SFX.power();
    }
    // resolve combos: chain broken when the window expires
    for (const p of players.values()) {
      if (p.comboT > 0) {
        p.comboT -= dt;
        if (p.comboT <= 0) {
          if (p.combo >= 3) {
            p.score += p.combo;
            popups.push({
              x: p.comboAt.x, y: p.comboAt.y - 40 * devicePixelRatio,
              text: `COMBO x${p.combo}! +${p.combo}`, color: p.color, life: 1400, maxLife: 1400,
            });
            SFX.combo(p.combo);
          }
          p.combo = 0;
        }
      }
    }
    // ❄️ slow-motion scales the physics clock, not the render clock
    updateFruits(now < slowUntil ? dt * 0.45 : dt);
  }
  updateParticles(dt); // keep the bomb explosion animating on the game-over screen

  // fruits
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const f of fruits) {
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.rot);
    ctx.font = `${f.r * 2}px system-ui`;
    ctx.fillText(f.emoji, 0, 0);
    ctx.restore();
  }

  // particles
  for (const pt of particles) {
    ctx.globalAlpha = Math.min(1, pt.life / 400);
    if (pt.emoji) {
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(pt.rot);
      ctx.font = `${18 * devicePixelRatio}px system-ui`;
      ctx.fillText(pt.emoji, 0, 0);
      ctx.restore();
    } else {
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // floating score popups — drift up and fade out
  for (let i = popups.length - 1; i >= 0; i--) {
    const pop = popups[i];
    pop.life -= dt;
    if (pop.life <= 0) { popups.splice(i, 1); continue; }
    const k = 1 - pop.life / pop.maxLife; // 0 → 1 over lifetime
    pop.y -= dt * 0.06 * devicePixelRatio;
    ctx.globalAlpha = Math.min(1, pop.life / 400);
    ctx.font = `800 ${(26 + 10 * k) * devicePixelRatio}px system-ui`;
    ctx.fillStyle = pop.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 4 * devicePixelRatio;
    ctx.strokeText(pop.text, pop.x, pop.y);
    ctx.fillText(pop.text, pop.x, pop.y);
  }
  ctx.globalAlpha = 1;

  // center crosshair — players aim here and tap their phone to re-center
  const cx = W / 2, cy = H / 2, cr = 22 * devicePixelRatio;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.beginPath();
  ctx.arc(cx, cy, cr, 0, Math.PI * 2);
  ctx.moveTo(cx - cr * 1.6, cy); ctx.lineTo(cx - cr * 0.5, cy);
  ctx.moveTo(cx + cr * 0.5, cy); ctx.lineTo(cx + cr * 1.6, cy);
  ctx.moveTo(cx, cy - cr * 1.6); ctx.lineTo(cx, cy - cr * 0.5);
  ctx.moveTo(cx, cy + cr * 0.5); ctx.lineTo(cx, cy + cr * 1.6);
  ctx.stroke();

  // blade trails + cursors
  const nowT = performance.now();
  for (const p of players.values()) {
    const pts = p.trail.filter(q => nowT - q.t < 250);
    if (pts.length > 1) drawTrail(p, pts, nowT);
    // cursor dot
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.cursor.x, p.cursor.y, 7 * devicePixelRatio, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.stroke();
  }

  // vignette darkens the edges so the action pops
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  updateOverlayCursors();

  // HUD: countdown, frenzy banner, slow-mo tint
  if (gameRunning) {
    const secsLeft = Math.max(0, Math.ceil((roundEnd - now) / 1000));
    ctx.textAlign = 'center';
    ctx.font = `800 ${34 * devicePixelRatio}px system-ui`;
    ctx.fillStyle = secsLeft <= 10 ? '#ff4d4d' : 'rgba(255,255,255,0.85)';
    ctx.fillText(`⏱ ${secsLeft}`, W / 2, 40 * devicePixelRatio);

    if (now < frenzyUntil) {
      const pulse = 1 + 0.12 * Math.sin(now * 0.02);
      ctx.font = `900 ${Math.round(52 * pulse) * devicePixelRatio}px system-ui`;
      ctx.fillStyle = '#ffd23f';
      ctx.fillText('🍉 FRENZY! 🍉', W / 2, H * 0.2);
    }
    if (now < slowUntil) {
      ctx.fillStyle = 'rgba(96, 165, 250, 0.10)';
      ctx.fillRect(0, 0, W, H);
      ctx.font = `800 ${24 * devicePixelRatio}px system-ui`;
      ctx.fillStyle = '#7dd3fc';
      ctx.fillText('❄️ SLOW-MO', W / 2, H - 30 * devicePixelRatio);
    }
  }

  // scoreboard
  if (gameRunning) {
    let y = 20 * devicePixelRatio;
    ctx.textAlign = 'left';
    ctx.font = `700 ${20 * devicePixelRatio}px system-ui`;
    for (const p of [...players.values()].sort((a, b) => b.score - a.score)) {
      ctx.fillStyle = p.color;
      const boost = now < (p.doubleUntil || 0) ? ' ⭐2x' : '';
      ctx.fillText(`${p.name}: ${p.score}${boost}`, 20 * devicePixelRatio, y + 10 * devicePixelRatio);
      y += 30 * devicePixelRatio;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  requestAnimationFrame(frame);
}

connectSignaling();
requestAnimationFrame(frame);
