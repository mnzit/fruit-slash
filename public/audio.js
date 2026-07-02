// All game audio, synthesized with the Web Audio API — no sound files needed.
// SFX.init() must be called from a user gesture (autoplay policy).
'use strict';

const SFX = (() => {
  let ctx = null;
  let noiseBuf = null;
  let musicTimer = null;

  function init() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  }

  function noise() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    return src;
  }

  // Juicy slice: a whoosh of filtered noise + a "squish" tone. Each fruit
  // passes its own base frequency so every fruit sounds distinct.
  function slice(freq = 440) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const dur = 0.18;

    const n = noise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(freq * 2, t);
    bp.frequency.exponentialRampToValueAtTime(freq * 5, t + dur);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.45, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(bp).connect(ng).connect(ctx.destination);
    n.start(t); n.stop(t + dur);

    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.55, t + 0.14);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.3, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(og).connect(ctx.destination);
    o.start(t); o.stop(t + 0.16);
  }

  // Explosion: big noise burst swept through a closing low-pass + a deep thump.
  function bomb() {
    if (!ctx) return;
    const t = ctx.currentTime;

    const n = noise();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3200, t);
    lp.frequency.exponentialRampToValueAtTime(80, t + 0.7);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.9, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    n.connect(lp).connect(ng).connect(ctx.destination);
    n.start(t); n.stop(t + 0.7);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.5);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.8, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    o.connect(og).connect(ctx.destination);
    o.start(t); o.stop(t + 0.55);
  }

  // Combo: rising arpeggio, one note per fruit in the chain (capped).
  function combo(n) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const notes = [523, 659, 784, 988, 1175, 1319];
    for (let i = 0; i < Math.min(n, notes.length); i++) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = notes[i];
      const g = ctx.createGain();
      const at = t + i * 0.07;
      g.gain.setValueAtTime(0.12, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(at); o.stop(at + 0.18);
    }
  }

  // Power-up: quick two-tone sparkle.
  function power() {
    if (!ctx) return;
    const t = ctx.currentTime;
    [880, 1760].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      const at = t + i * 0.09;
      g.gain.setValueAtTime(0.2, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(at); o.stop(at + 0.3);
    });
  }

  // ---- Background music: a light pentatonic pluck loop over a soft bass. ----
  const STEP = 60 / 112 / 2; // 112 bpm, 8th notes
  // Two 8-step bars: C-pentatonic melody (0 = rest)
  const MELODY = [523, 0, 659, 784, 0, 659, 880, 0, 784, 0, 659, 523, 587, 0, 659, 0];
  const BASS = [131, 131, 98, 98, 110, 110, 147, 131]; // one note per half-bar

  function pluck(freq, t, vol, type = 'triangle') {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + STEP * 1.8);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + STEP * 2);
  }

  let nextNoteTime = 0;
  let stepIdx = 0;

  function scheduler() {
    // Schedule a beat ahead so timing stays tight even if the tab hiccups.
    while (nextNoteTime < ctx.currentTime + 0.3) {
      const m = MELODY[stepIdx % MELODY.length];
      if (m) pluck(m, nextNoteTime, 0.055);
      if (stepIdx % 2 === 0) {
        pluck(BASS[(stepIdx / 2) % BASS.length], nextNoteTime, 0.07, 'sine');
      }
      nextNoteTime += STEP;
      stepIdx++;
    }
  }

  function music(on) {
    if (!ctx) return;
    if (on && !musicTimer) {
      nextNoteTime = ctx.currentTime + 0.1;
      stepIdx = 0;
      musicTimer = setInterval(scheduler, 100);
    } else if (!on && musicTimer) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
  }

  return { init, slice, bomb, combo, power, music };
})();
