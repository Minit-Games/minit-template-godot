// Generates the sound effects into assets/sound/ as 16-bit mono PCM WAV.
//
//   node tools/gen-audio.mjs
//
// Synthesised rather than sampled: the whole bank is a few kilobytes, there is
// nothing to license or attribute, and the clips stay clean under the pitch
// shifting the game applies (the tap rises with the score). Replace this file
// wholesale when you bring real effects -- only the clip names matter to the
// game.
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sound');
const RATE = 44100;

// ------------------------------------------------------------------ helpers
const TAU = Math.PI * 2;

class Buf {
  constructor(seconds) {
    this.n = Math.ceil(seconds * RATE);
    this.d = new Float32Array(this.n);
  }
  get seconds() { return this.n / RATE; }

  /** Add a tone. `freq` and `amp` may be numbers or functions of t (seconds). */
  tone(freq, amp, { wave = 'sine', from = 0, to = this.seconds } = {}) {
    const f = typeof freq === 'function' ? freq : () => freq;
    const a = typeof amp === 'function' ? amp : () => amp;
    let phase = 0;
    const i0 = Math.max(0, Math.floor(from * RATE));
    const i1 = Math.min(this.n, Math.floor(to * RATE));
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / RATE;
      phase += (TAU * f(t)) / RATE;
      let v;
      if (wave === 'sine') v = Math.sin(phase);
      else if (wave === 'saw') v = 1 - 2 * ((phase / TAU) % 1);
      else if (wave === 'square') v = Math.sin(phase) >= 0 ? 1 : -1;
      else if (wave === 'tri') v = 2 * Math.abs(2 * ((phase / TAU) % 1) - 1) - 1;
      this.d[i] += v * a(t);
    }
    return this;
  }

  noise(amp, { from = 0, to = this.seconds, seed = 1 } = {}) {
    const a = typeof amp === 'function' ? amp : () => amp;
    let s = seed;
    const i0 = Math.max(0, Math.floor(from * RATE));
    const i1 = Math.min(this.n, Math.floor(to * RATE));
    for (let i = i0; i < i1; i++) {
      s = (s * 1664525 + 1013904223) % 4294967296;
      this.d[i] += ((s / 2147483648) - 1) * a((i - i0) / RATE);
    }
    return this;
  }

  /** One-pole low pass; `cut` in Hz, may vary over time. */
  lowpass(cut) {
    const c = typeof cut === 'function' ? cut : () => cut;
    let y = 0;
    for (let i = 0; i < this.n; i++) {
      const k = 1 - Math.exp(-TAU * Math.max(20, c(i / RATE)) / RATE);
      y += k * (this.d[i] - y);
      this.d[i] = y;
    }
    return this;
  }

  highpass(cut) {
    let prev = 0, y = 0;
    const k = Math.exp(-TAU * cut / RATE);
    for (let i = 0; i < this.n; i++) {
      y = k * (y + this.d[i] - prev);
      prev = this.d[i];
      this.d[i] = y;
    }
    return this;
  }

  /** Normalise, then apply a short fade at both ends so nothing clicks. */
  finish(peak = 0.85) {
    let max = 0;
    for (let i = 0; i < this.n; i++) max = Math.max(max, Math.abs(this.d[i]));
    const g = max > 0 ? peak / max : 0;
    const fade = Math.min(220, Math.floor(this.n / 8));
    for (let i = 0; i < this.n; i++) {
      let v = this.d[i] * g;
      if (i < fade) v *= i / fade;
      const tail = this.n - 1 - i;
      if (tail < fade) v *= tail / fade;
      // Soft clip: keeps the punchy ones from squaring off harshly.
      this.d[i] = Math.tanh(v * 1.25) / Math.tanh(1.25);
    }
    return this;
  }

  toWav() {
    const data = Buffer.alloc(this.n * 2);
    for (let i = 0; i < this.n; i++) {
      data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(this.d[i] * 32767))), i * 2);
    }
    const head = Buffer.alloc(44);
    head.write('RIFF', 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVE', 8);
    head.write('fmt ', 12);
    head.writeUInt32LE(16, 16);     // PCM chunk size
    head.writeUInt16LE(1, 20);      // format: PCM
    head.writeUInt16LE(1, 22);      // channels: mono
    head.writeUInt32LE(RATE, 24);
    head.writeUInt32LE(RATE * 2, 28);
    head.writeUInt16LE(2, 32);      // block align
    head.writeUInt16LE(16, 34);     // bits
    head.write('data', 36);
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
  }
}

const decay = (peak, tau) => (t) => peak * Math.exp(-t / tau);

// -------------------------------------------------------------------- bank
const BANK = {
  // Tapping the ball: a bright rising pluck. Deliberately short and tonally
  // plain, because the game plays it back faster as the score climbs.
  tap: () => new Buf(0.16)
    .tone(t => 420 + 680 * Math.min(1, t / 0.05), decay(0.8, 0.045), { wave: 'tri' })
    .tone(t => 840 + 900 * Math.min(1, t / 0.05), decay(0.25, 0.025))
    .noise(decay(0.2, 0.008))
    .lowpass(6000).finish(0.7),

  // The ball landing: a soft low thud with a little grit, no tone.
  bounce: () => new Buf(0.22)
    .tone(t => 190 * Math.exp(-t / 0.06) + 58, decay(1.0, 0.085))
    .noise(decay(0.5, 0.02), { seed: 7 })
    .lowpass(t => 2400 * Math.exp(-t / 0.04) + 260)
    .finish(0.75),

  // Ending the run: a short two-note confirmation.
  finish: () => {
    const b = new Buf(0.6);
    [[523, 0], [784, 0.11]].forEach(([f, at]) => {
      b.tone(f, decay(0.6, 0.22), { from: at, to: at + 0.45, wave: 'tri' });
      b.tone(f * 2, decay(0.16, 0.1), { from: at, to: at + 0.3 });
    });
    return b.finish(0.75);
  },
};

await mkdir(OUT, { recursive: true });

// Prune clips this generator no longer emits, so a renamed sound cannot linger
// in the repo and the bundle. music.wav comes from gen-music.mjs.
const keep = new Set([...Object.keys(BANK), 'music']);
for (const file of await readdir(OUT)) {
  const base = file.replace(/\.wav$/, '');
  if (base !== file && !keep.has(base)) {
    await unlink(join(OUT, file));
    console.log(`  removed stale ${file}`);
  }
}

let total = 0;
const names = [];
for (const [name, make] of Object.entries(BANK)) {
  const wav = make().toWav();
  await writeFile(join(OUT, `${name}.wav`), wav);
  total += wav.length;
  names.push(name);
  console.log(`  ${name}.wav`.padEnd(20), `${(wav.length / 1024).toFixed(1)} KB`);
}
console.log(`\n${names.length} sounds, ${(total / 1024).toFixed(0)} KB of WAV`);
console.log(names.join(' '));
