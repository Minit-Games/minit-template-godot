// Generates every sprite into assets/atlas/img/, and the atlas beside them.
//
//   node tools/gen-art.mjs
//
// Everything is drawn from signed distance fields rather than shipped as
// bitmaps, so there is no binary art in the repo, nothing to license, and the
// whole look retunes by editing the palette below. Swap this file out entirely
// when you bring your own art -- only the file names matter to the game.
//
// Godot imports these on its next editor run (or `godot --headless --import`),
// writing a .import file beside each one.
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  Canvas, circle, ellipse, roundRect, capsule, polygon,
  union, subtract, intersect, keepAbove, rgb, vgrad, rgrad,
} from './painter.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

const C = {
  ink:      rgb('#20303a'),
  white:    rgb('#ffffff'),
  ball:     rgb('#e84a4a'),
  ballLit:  rgb('#ff8a7a'),
  ballDark: rgb('#b32b32'),
  grass:    rgb('#5fce56'),
  grassDk:  rgb('#2f8f3e'),
  soil:     rgb('#7a4a2a'),
  soilDk:   rgb('#3f2314'),
  button:   rgb('#ffc23d'),
};

const INK = 6;

const SPRITES = {
  // The ball. A band and a highlight so its spin and squash read at a glance.
  ball: () => {
    const c = new Canvas(176, 176);
    c.paintOutlined(circle(88, 88, 78), vgrad(C.ballLit, C.ballDark, 14, 168), C.ink, INK);
    c.paint(intersect(ellipse(88, 88, 78, 26), circle(88, 88, 78)), rgb('#ffffff', 0.85));
    c.paint(ellipse(62, 52, 22, 15), rgb('#ffffff', 0.55));
    return c;
  },

  // Sky, stretched across the whole screen at runtime.
  sky: () => new Canvas(8, 256)
    .paint(roundRect(4, 128, 4, 128, 0), vgrad(rgb('#8fd3f4'), rgb('#cdeafd'), 0, 256)),

  // The ground: a bright turf lip at the top falling away into soil. Stretched
  // vertically, so the gradient sets how deep the turf reads.
  ground: () => new Canvas(8, 256)
    .paint(roundRect(4, 128, 4, 128, 0), (x, y) => {
      if (y < 26) return C.grass;
      const t = Math.min(1, (y - 26) / 150);
      const a = C.grassDk, b = C.soilDk;
      return [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t).concat([1]);
    }),

  // Blades along the ground's top edge. Tiled horizontally.
  turf: () => {
    const c = new Canvas(128, 40);
    c.paint(roundRect(64, 34, 64, 12, 0), C.grass);
    for (let i = 0; i < 9; i++) {
      const x = i * 14 + 8;
      const h = 12 + ((i * 37) % 11);
      const lean = ((i * 13) % 7 - 3) * 0.7;
      c.paint(capsule(x, 30, x + lean, 30 - h, 4), i % 2 ? C.grass : C.grassDk);
    }
    return c;
  },

  shadow: () => new Canvas(192, 72).paint(ellipse(96, 36, 88, 30),
    rgrad(rgb('#000000', 0.42), rgb('#000000', 0), 96, 36, 88, 1.4), { softness: 4 }),

  // Dust kicked up where the ball lands.
  puff: () => new Canvas(96, 96).paint(
    union(circle(40, 54, 28), circle(62, 46, 22), circle(50, 34, 19)),
    rgrad(rgb('#ffffff', 0.95), rgb('#ffffff', 0.08), 50, 46, 46, 1.3), { softness: 8 }),

  // 9-sliced, so the button stretches to its label without distorting corners.
  button: () => new Canvas(64, 64)
    .paintOutlined(roundRect(32, 32, 29, 29, 16), C.button, C.ink, 5),

  // Plain white: bars, wipes and full-screen flashes, all tinted at runtime.
  square: () => new Canvas(8, 8).paint(roundRect(4, 4, 4, 4, 0), C.white),
};

await mkdir(OUT, { recursive: true });
for (const file of await readdir(OUT)) {
  if (file.endsWith('.png') && !(file.slice(0, -4) in SPRITES)) {
    await unlink(join(OUT, file));
    console.log(`  removed stale ${file}`);
  }
}

let total = 0;
for (const [name, make] of Object.entries(SPRITES)) {
  const png = make().toPNG();
  await writeFile(join(OUT, `${name}.png`), png);
  total += png.length;
  console.log(`  ${name}.png`.padEnd(22), `${(png.length / 1024).toFixed(1)} KB`);
}


console.log(`\n${Object.keys(SPRITES).length} sprites, ${(total / 1024).toFixed(0)} KB`);
