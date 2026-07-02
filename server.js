// Fruit Slash — HTTPS static server + WebSocket signaling for WebRTC.
// HTTPS is required because phones only expose motion sensors on secure origins.
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8443;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');

function loadOrCreateCert() {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const selfsigned = require('selfsigned');
  const lanIPs = getLanIPs();
  const pems = selfsigned.generate([{ name: 'commonName', value: 'fruit-slash.local' }], {
    days: 365,
    keySize: 2048,
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        ...lanIPs.map(ip => ({ type: 7, ip })),
      ],
    }],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

function getLanIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// On cloud hosts (Render/Railway/Fly), the platform terminates TLS at its
// proxy, so we serve plain HTTP there. Locally we self-sign HTTPS because
// phone motion sensors require a secure origin.
const USE_TLS = process.env.TLS !== 'false' &&
  !process.env.RENDER && !process.env.RAILWAY_ENVIRONMENT && !process.env.FLY_APP_NAME;

function requestHandler(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/screen.html';
  if (urlPath === '/play') urlPath = '/controller.html';
  if (urlPath === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ lanIPs: getLanIPs(), port: PORT }));
  }
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = USE_TLS
  ? https.createServer(loadOrCreateCert(), requestHandler)
  : require('http').createServer(requestHandler);

// ---- Signaling ----
// rooms: code -> { screen: ws|null, controllers: Map<id, ws> }
const rooms = new Map();

function roomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(4)).map(b => chars[b % chars.length]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.meta = { role: null, room: null, id: null };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create-room') {
      const code = roomCode();
      rooms.set(code, { screen: ws, controllers: new Map() });
      ws.meta = { role: 'screen', room: code, id: 'screen' };
      send(ws, { type: 'room-created', room: code });

    } else if (msg.type === 'join-room') {
      const room = rooms.get((msg.room || '').toUpperCase());
      if (!room || !room.screen) return send(ws, { type: 'error', error: 'Room not found' });
      const id = crypto.randomUUID().slice(0, 8);
      ws.meta = { role: 'controller', room: (msg.room || '').toUpperCase(), id };
      room.controllers.set(id, ws);
      send(ws, { type: 'joined', id });
      send(room.screen, { type: 'peer-joined', id, name: String(msg.name || 'Player').slice(0, 16) });

    } else if (msg.type === 'signal') {
      // Relay SDP/ICE between screen and controller.
      const room = rooms.get(ws.meta.room);
      if (!room) return;
      const target = ws.meta.role === 'screen' ? room.controllers.get(msg.to) : room.screen;
      send(target, { type: 'signal', from: ws.meta.id, data: msg.data });
    }
  });

  ws.on('close', () => {
    const { role, room: code, id } = ws.meta;
    const room = rooms.get(code);
    if (!room) return;
    if (role === 'screen') {
      for (const c of room.controllers.values()) send(c, { type: 'room-closed' });
      rooms.delete(code);
    } else if (role === 'controller') {
      room.controllers.delete(id);
      send(room.screen, { type: 'peer-left', id });
    }
  });
});

server.listen(PORT, () => {
  console.log('\n🍉 Fruit Slash running!');
  if (USE_TLS) {
    const ips = getLanIPs();
    console.log(`\n  Screen (open on laptop/TV):`);
    console.log(`    https://localhost:${PORT}/`);
    for (const ip of ips) console.log(`    https://${ip}:${PORT}/`);
    console.log(`\n  Phones join via the QR code / room code shown on the screen.`);
    console.log(`\n  Note: the certificate is self-signed — accept the browser warning`);
    console.log(`  on BOTH the laptop and each phone.\n`);
  } else {
    console.log(`  Plain-HTTP mode on port ${PORT} (TLS handled by the hosting platform).\n`);
  }
});
