// Controller: the phone is the knife. Reads orientation sensors, maps them to a
// pointer on the big screen, and streams positions over a WebRTC data channel.
'use strict';

const $ = (id) => document.getElementById(id);
const show = (id) => {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
};

// Pre-fill room code from the QR link (?room=XXXX).
const params = new URLSearchParams(location.search);
if (params.get('room')) $('room').value = params.get('room').toUpperCase();

let ws = null, pc = null, dc = null;
let touchMode = false;
let relayMode = false; // ship input via the server when WebRTC can't connect

// ---- Keep the phone screen awake while playing ----
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {} // e.g. low battery mode — nothing we can do
}
// The lock is released automatically when the tab is backgrounded; re-acquire
// when the player comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock) keepAwake();
});

// ---- Join ----
$('join').addEventListener('click', () => {
  keepAwake(); // must be requested from a user gesture
  const name = $('name').value.trim() || 'Player';
  const room = $('room').value.trim().toUpperCase();
  if (room.length !== 4) return ($('status').textContent = 'Enter the 4-letter room code from the screen.');
  $('status').textContent = 'Connecting…';

  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join-room', room, name }));
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'error') {
      $('status').textContent = msg.error;
    } else if (msg.type === 'joined') {
      await startWebRTC();
    } else if (msg.type === 'signal') {
      if (msg.data.sdp) await pc.setRemoteDescription(msg.data.sdp);
      else if (msg.data.candidate) { try { await pc.addIceCandidate(msg.data.candidate); } catch {} }
    } else if (msg.type === 'feedback') {
      handleFeedback(msg.data);
    } else if (msg.type === 'room-closed') {
      $('status').textContent = 'Screen closed the room.';
      show('join-screen');
    }
  };
  ws.onerror = () => ($('status').textContent = 'Connection failed — accept the certificate warning and retry.');
});

// ---- WebRTC (controller makes the offer) ----
async function startWebRTC() {
  $('status').textContent = 'Joined — linking with screen…';
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  // Surface the live connection state so a stall is diagnosable, not silent.
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      $('status').textContent = 'Direct link failed — is the phone on the SAME Wi-Fi as the screen (not mobile data)?';
    } else if (pc.connectionState !== 'connected') {
      $('status').textContent = `Linking with screen… (${pc.connectionState})`;
    }
  };
  // Low-latency: unordered, no retransmits — a lost cursor sample doesn't matter.
  dc = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
  dc.onopen = () => {
    $('status').textContent = '';
    show('calibrate-screen');
  };
  dc.onmessage = (ev) => handleFeedback(JSON.parse(ev.data));
  pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'signal', data: { candidate: e.candidate } }));
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));

  // If the direct link hasn't opened in 5s (e.g. router blocks device-to-device
  // traffic), fall back to relaying input through the server. A few ms slower
  // on a LAN — imperceptible.
  setTimeout(() => {
    if (dc && dc.readyState === 'open') return;
    relayMode = true;
    $('status').textContent = '';
    show('calibrate-screen');
  }, 5000);
}

function handleFeedback(msg) {
  if (msg.t === 'slice' && navigator.vibrate) navigator.vibrate(30);
  if (msg.t === 'bomb') {
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    document.body.classList.remove('flash-red');
    void document.body.offsetWidth;
    document.body.classList.add('flash-red');
  }
  if (msg.t === 'start') $('hint').textContent = 'Swing your phone to slice! 🍉';
}

// Send a game message to the screen: direct data channel when available,
// otherwise via the server relay.
function sendGame(msg) {
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(msg));
  } else if (relayMode && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: msg }));
  }
}

// ---- Motion pointing model: KNIFE GRIP (direct, no filtering) ----
// Hold the phone like a knife: flat in your fist, top edge pointing at the
// screen. The cursor follows wherever the TOP EDGE of the phone points, so a
// wrist slash sweeps the blade across the screen. We rotate the device's +Y
// axis (through the top edge) into world space using the full orientation —
// this works in any grip (flat, tilted, sideways), unlike raw tilt angles.
const RANGE_YAW = 50;   // degrees of swing to cross the full screen width
const RANGE_PITCH = 40;
let cal = null;         // { yaw, pitch } captured while pointing at screen center
let lastOri = null;     // latest { yaw, pitch }
let lastSend = 0;

const D2R = Math.PI / 180;
function wrapDeg(d) { return ((d + 540) % 360) - 180; }

// deviceorientation (Z-X'-Y'' intrinsic) -> world-space direction of the
// phone's top edge, expressed as yaw/pitch in degrees.
function tipDirection(e) {
  const _x = (e.beta || 0) * D2R / 2, _y = (e.gamma || 0) * D2R / 2, _z = (e.alpha || 0) * D2R / 2;
  const cX = Math.cos(_x), cY = Math.cos(_y), cZ = Math.cos(_z);
  const sX = Math.sin(_x), sY = Math.sin(_y), sZ = Math.sin(_z);
  const w = cX * cY * cZ - sX * sY * sZ;
  const x = sX * cY * cZ - cX * sY * sZ;
  const y = cX * sY * cZ + sX * cY * sZ;
  const z = cX * cY * sZ + sX * sY * cZ;
  // Device +Y axis (top edge) in world coords = 2nd column of rotation matrix.
  const vx = 2 * (x * y - w * z);
  const vy = 1 - 2 * (x * x + z * z);
  const vz = 2 * (y * z + w * x);
  return {
    yaw: Math.atan2(vx, vy) / D2R,
    pitch: Math.asin(Math.max(-1, Math.min(1, vz))) / D2R,
  };
}

function onOrientation(e) {
  if (e.alpha == null) return;
  lastOri = tipDirection(e);
  if (!cal || touchMode) return;

  const now = performance.now();
  if (now - lastSend < 25) return; // ~40 Hz is plenty
  lastSend = now;

  const dYaw = wrapDeg(lastOri.yaw - cal.yaw);     // + = tip swung right
  const dPitch = lastOri.pitch - cal.pitch;        // + = tip swung up
  const x = clamp01(0.5 + dYaw / RANGE_YAW);
  const y = clamp01(0.5 - dPitch / RANGE_PITCH);
  sendMove(x, y);

  // tilt the knife emoji for fun
  $('knife').style.transform = `rotate(${dYaw}deg)`;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function sendMove(x, y) {
  sendGame({ t: 'move', x: +x.toFixed(4), y: +y.toFixed(4) });
}

async function requestMotionPermission() {
  // iOS 13+ requires an explicit permission prompt from a user gesture.
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res !== 'granted') throw new Error('Motion permission denied');
  }
  window.addEventListener('deviceorientation', onOrientation);
}

$('calibrate').addEventListener('click', async () => {
  try {
    await requestMotionPermission();
  } catch {
    $('status2').textContent = 'Motion access denied — use touch pad mode instead.';
    return;
  }
  // Give the sensor a moment to produce a reading, then calibrate on it.
  setTimeout(() => {
    if (!lastOri) {
      $('status2').textContent = 'No motion data — your browser may not support it. Try touch pad mode.';
      return;
    }
    cal = { ...lastOri };
    sendGame({ t: 'ready' });
    show('play-screen');
  }, 300);
});

function recenter() {
  if (touchMode || !lastOri) return;
  cal = { ...lastOri };
  if (navigator.vibrate) navigator.vibrate(20);
  $('hint').textContent = '✛ Aim re-centered!';
  clearTimeout(recenter._t);
  recenter._t = setTimeout(() => ($('hint').textContent = 'Swing to slice! 🍉'), 1000);
}

$('recenter').addEventListener('click', recenter);

// Tap anywhere on the play screen while aiming at the on-screen ✛ to re-center.
document.addEventListener('pointerdown', (e) => {
  if (touchMode) return;
  if (!$('play-screen').classList.contains('active')) return;
  if (e.target.tagName === 'BUTTON') return;
  recenter();
});

// ---- Touch fallback: drag anywhere on the play screen ----
$('touch-mode').addEventListener('click', () => {
  touchMode = true;
  $('hint').textContent = 'Drag on your phone to slice! 🍉';
  $('recenter').style.display = 'none';
  $('subhint').style.display = 'none';
  sendGame({ t: 'ready' });
  show('play-screen');
});

// Pointer events cover finger, stylus (e.g. Samsung S Pen), and mouse alike.
function onPointer(e) {
  if (!touchMode) return;
  // Only track while actually pressed/touching — ignore pen hover.
  if (e.type === 'pointermove' && e.buttons === 0) return;
  sendMove(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
  e.preventDefault();
}
document.addEventListener('pointerdown', onPointer);
document.addEventListener('pointermove', onPointer);
