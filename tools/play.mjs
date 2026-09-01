// Drive the bundled game in a real browser: load it, tap it, watch for errors,
// and take screenshots. This is the only way to check a wasm build behaves --
// nothing about layout, input mapping or the render pipeline is observable
// from a headless Lua test.
//
//   node tools/play.mjs <dir> [--w 390] [--h 844] [--dpr 3] [--out prefix]
import { launch } from './cdp.mjs';
import { spawn } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(3).join(' ')
  .split('--').filter(Boolean).map(s => s.trim().split(/\s+/)).map(([k, v]) => [k, v ?? true]));

const dir = process.argv[2] || 'dist/Mole Mayhem';
const W = +(args.w || 390), H = +(args.h || 844), DPR = +(args.dpr || 3);
const PORT = 8140 + Math.floor(Math.random() * 400);
const prefix = args.out || '/tmp/mole';
const ROUNDS = +(args.rounds || 12);

const server = spawn('node', ['tools/serve.mjs', dir, String(PORT)], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 600));

const b = await launch({ width: W, height: H, dpr: DPR });
const shots = [];
try {
  await b.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__log = [];
    ['log','warn','error'].forEach(k => {
      const o = console[k].bind(console);
      console[k] = (...a) => { window.__log.push(k + ': ' + a.map(String).join(' ')); o(...a); };
    });
    window.onerror = (m) => { window.__log.push('onerror: ' + m); };
    // Frame timing, sampled from the page itself. A wasm game that renders
    // correctly in a screenshot can still be running at 20fps.
    window.__frames = [];
    (function tick(prev) {
      requestAnimationFrame((now) => {
        if (prev) window.__frames.push(now - prev);
        if (window.__frames.length > 6000) window.__frames.shift();
        tick(now);
      });
    })(0);
    window.__fps = (lastN) => {
      const f = window.__frames.slice(-(lastN || 600));
      if (!f.length) return null;
      const sorted = [...f].sort((a, b) => a - b);
      const mean = f.reduce((a, b) => a + b, 0) / f.length;
      return { frames: f.length, meanMs: +mean.toFixed(2), fps: +(1000 / mean).toFixed(1),
               p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
               worstMs: +sorted[sorted.length - 1].toFixed(2) };
    };
  ` });
  await b.goto(`http://localhost:${PORT}/${args.q ? '?' + args.q : ''}`);
  await new Promise(r => setTimeout(r, 6000));

  const shot = async (name) => {
    const p = `${prefix}-${name}.png`;
    await b.screenshot(p);
    shots.push(p);
    return p;
  };

  await shot('start');

  // The ball sits on the grass line, a little above the middle of the screen;
  // the end-game button is in the soil below it.
  const BALL = { x: W / 2, y: H * 0.50 };
  const BUTTON = { x: W / 2, y: H * 0.80 };

  for (let round = 0; round < ROUNDS; round++) {
    await b.tap([BALL], 50);
    await new Promise(res => setTimeout(res, 260));
    if (round === 3) await shot('bouncing');
  }
  await shot('scored');

  // End the run. This is what fires report_result.
  await b.tap([BUTTON], 60);
  await new Promise(res => setTimeout(res, 1600));
  await shot('result');

  const perf = await b.eval('window.__fps ? JSON.stringify(window.__fps(900)) : "null"');
  console.log('===== frame timing (last ~900 frames) =====');
  console.log(perf);
  const logs = await b.eval('window.__log ? window.__log.join("\\n") : ""');
  console.log('===== console =====');
  console.log(logs || '(silent)');
  console.log('===== shots =====');
  console.log(shots.join('\n'));
} finally {
  await b.close();
  server.kill();
}
