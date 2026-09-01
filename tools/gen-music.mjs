// Prepares the background music loop for the bundle.
//
//   node tools/gen-music.mjs
//
// Source: "Title Screen" from "5 Chiptunes (Action)" by Juhani Junkala
// (SubspaceAudio), released CC0 / public domain -- the author's own INFO.txt in
// the pack says "You can do anything you want with these tunes." The shortest
// track in the pack, which keeps a template's download small.
//
// Defold takes WAV or Ogg Vorbis and there is no Vorbis encoder here, so the
// size has to come out of the PCM itself:
//
//   * Mono. The channels are near-identical, so almost nothing is lost.
//   * 16 kHz. Music energy above 8 kHz is a fraction of a percent, and Defold
//     honours a WAV's declared sample rate rather than assuming 44100 (measured:
//     a 2.000s tone at 16 kHz reports 1.989s to its completion callback), so a
//     low-rate file plays at the right speed rather than fast.
// 2.0 MB of source becomes ~0.35 MB.
//
// The loop point is left exactly as the author wrote it. It is tempting to
// crossfade the tail into the head "to be safe", but measuring first says not
// to: the step from the last sample to the first is 0.039, against a 95th
// percentile adjacent-sample step of 0.15 in the same track -- i.e. the join is
// indistinguishable from any other sample boundary. A crossfade would discard
// real music and smear a downbeat to fix nothing. The check is printed below so
// you can re-run it against your own track.
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache');
const PACK_URL = 'https://opengameart.org/sites/default/files/5%20Action%20Chiptunes%20By%20Juhani%20Junkala.zip';
const PACK_ZIP = join(CACHE, 'junkala-action-chiptunes.zip');
const TRACK = 'Juhani Junkala [Retro Game Music Pack] Title Screen.wav';

const OUT_RATE = 16000;
const PEAK = 0.72;   // leaves headroom for the effects mixed over the top

function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file');
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}`);
  // Walk the chunks rather than assuming a 44-byte header.
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const data = buf.subarray(off + 8, off + 8 + Math.min(len, buf.length - off - 8));
      const frames = Math.floor(data.length / 2 / channels);
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += data.readInt16LE((i * channels + c) * 2);
        mono[i] = s / channels / 32768;
      }
      return { rate, channels, samples: mono };
    }
    off += 8 + len + (len & 1);
  }
  throw new Error('no data chunk');
}

/** Two one-pole passes: gentle, but enough to keep decimation from aliasing. */
function lowpass(x, rate, cut) {
  const k = 1 - Math.exp(-2 * Math.PI * cut / rate);
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += k * (x[i] - y); out[i] = y; }
  y = 0;
  for (let i = out.length - 1; i >= 0; i--) { y += k * (out[i] - y); out[i] = y; }
  return out;
}

/** Linear resample. The loop point is preserved by wrapping the interpolation. */
function resample(x, from, to) {
  const n = Math.round(x.length * to / from);
  const out = new Float32Array(n);
  const step = x.length / n;
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const i0 = Math.floor(p);
    const frac = p - i0;
    // Wrap rather than clamp, so the last sample interpolates back into the
    // first and the seamless loop stays seamless.
    out[i] = x[i0] * (1 - frac) + x[(i0 + 1) % x.length] * frac;
  }
  return out;
}

function toWav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

await mkdir(CACHE, { recursive: true });
const cached = await stat(PACK_ZIP).catch(() => null);
if (!cached) {
  console.log('  fetching the CC0 pack (~47 MB, cached in .cache/ for next time)');
  execFileSync('curl', ['-sfL', '-A', 'Mozilla/5.0', '-o', PACK_ZIP, PACK_URL], { stdio: 'inherit' });
}

// unzip globs its file arguments, and the track name contains [brackets].
const escaped = TRACK.replace(/([[\]*?\\])/g, '\\$1');
const raw = execFileSync('unzip', ['-p', PACK_ZIP, escaped], { maxBuffer: 64 * 1024 * 1024 });
const src = readWav(raw);
console.log(`  source: ${src.channels}ch ${src.rate} Hz, ${(src.samples.length / src.rate).toFixed(1)}s`);

const filtered = lowpass(src.samples, src.rate, OUT_RATE * 0.45);
const down = resample(filtered, src.rate, OUT_RATE);

let peak = 0;
for (const v of down) peak = Math.max(peak, Math.abs(v));
const gain = peak > 0 ? PEAK / peak : 1;
for (let i = 0; i < down.length; i++) down[i] *= gain;

// Is the loop actually seamless? Compare the wrap-around step against how much
// neighbouring samples normally differ in this track. A seam inside that range
// is inaudible; one far outside it would tick on every repeat.
const steps = [];
for (let i = 1; i < down.length; i++) steps.push(Math.abs(down[i] - down[i - 1]));
steps.sort((a, b) => a - b);
const p95 = steps[Math.floor(steps.length * 0.95)];
const seam = Math.abs(down[down.length - 1] - down[0]);
console.log(`  loop seam ${seam.toFixed(4)} vs p95 adjacent step ${p95.toFixed(4)} -> ` +
            (seam <= p95 ? 'continuous' : 'AUDIBLE SEAM, consider a crossfade'));

const wav = toWav(down, OUT_RATE);
await writeFile(join(ROOT, 'assets/sound/music.wav'), wav);

console.log(`  wrote assets/sound/music.wav - mono ${OUT_RATE} Hz, ` +
            `${(down.length / OUT_RATE).toFixed(1)}s, ${(wav.length / 1048576).toFixed(2)} MB`);
