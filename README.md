# 🍉 Fruit Slash

Multiplayer Fruit Ninja where **your phone is the knife**. The game board runs on a
laptop/TV browser; each player joins from their phone, points it at the screen, and
swings to slice fruit. Input travels over a **WebRTC data channel** (unordered,
no-retransmit) for minimal latency; a small Node server does static hosting + signaling.

## Run

```bash
npm install
npm start
```

1. Open the printed `https://<your-lan-ip>:8443/` on the laptop/TV — accept the
   self-signed certificate warning. A room code + QR appear.
2. On each phone (same Wi-Fi), scan the QR (or open `/play` and type the room code) —
   accept the certificate warning there too.
3. Tap **Point & calibrate** while aiming the phone at the screen center
   (grants motion-sensor permission on iOS).
4. Press **Start game** on the screen. Swing to slice; avoid 💣 (-5 points).

## Notes

- HTTPS is mandatory: browsers only expose motion sensors on secure origins.
  Certificates are auto-generated into `certs/` on first run (delete to regenerate,
  e.g. after your LAN IP changes).
- Phones without motion sensors (or denied permission) can use **touch pad mode**.
- "Re-center aim" recalibrates if your cursor drifts (gyro drift is normal).
- Everything is LAN-only; the WebRTC connection is phone ↔ screen directly.

## Architecture

```
phone (controller.js) --WebRTC DataChannel--> screen (screen.js: physics, slicing, score)
        \--WebSocket signaling (server.js: rooms, SDP/ICE relay)--/
```
