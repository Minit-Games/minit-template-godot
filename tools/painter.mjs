// A tiny signed-distance-field painter, and a PNG encoder to get the result out.
//
// Every sprite in this game is generated from code rather than drawn by hand:
// there is no binary art to license, the whole look retunes by editing a palette,
// and shapes stay crisp because coverage is computed analytically from a distance
// field instead of being supersampled.
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- distance fields
// Each shape is f(x, y) -> signed distance in pixels, negative inside.
export const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;

export const ellipse = (cx, cy, rx, ry) => (x, y) => {
  // Exact ellipse SDF is iterative; this normalised approximation is smooth and
  // accurate enough at the edge, which is all the coverage term looks at.
  const dx = (x - cx) / rx, dy = (y - cy) / ry;
  const k = Math.hypot(dx, dy);
  return k === 0 ? -Math.min(rx, ry) : (k - 1) * Math.min(rx, ry) / Math.max(k, 1e-6) * k;
};

export const roundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - (hw - r), qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

export const capsule = (x1, y1, x2, y2, r) => (x, y) => {
  const px = x - x1, py = y - y1, bx = x2 - x1, by = y2 - y1;
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by || 1e-6)));
  return Math.hypot(px - bx * t, py - by * t) - r;
};

// Regular n-pointed star, alternating outer/inner radius.
export const star = (cx, cy, n, outer, inner, rot = 0) => (x, y) => {
  const px = x - cx, py = y - cy;
  const a = Math.atan2(py, px) - rot;
  const seg = Math.PI / n;
  const local = ((a % (2 * seg)) + 2 * seg) % (2 * seg) - seg;
  const r = Math.hypot(px, py);
  // Distance to the chord between an outer and an inner point.
  const ox = outer, oy = 0;
  const ix = inner * Math.cos(seg), iy = inner * Math.sin(seg);
  const ex = ix - ox, ey = iy - oy;
  const qx = r * Math.cos(local) - ox, qy = Math.abs(r * Math.sin(local)) - oy;
  const t = Math.max(0, Math.min(1, (qx * ex + qy * ey) / (ex * ex + ey * ey)));
  const dx = qx - ex * t, dy = qy - ey * t;
  const sign = (qx * ey - qy * ex) > 0 ? 1 : -1;
  return sign * Math.hypot(dx, dy);
};

export const polygon = (pts) => (x, y) => {
  let d = Infinity, inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    const ex = xj - xi, ey = yj - yi, px = x - xi, py = y - yi;
    const t = Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey || 1e-6)));
    d = Math.min(d, Math.hypot(px - ex * t, py - ey * t));
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? -d : d;
};

// ------------------------------------------------------------------- combinators
export const union = (...fs) => (x, y) => Math.min(...fs.map(f => f(x, y)));
export const subtract = (a, b) => (x, y) => Math.max(a(x, y), -b(x, y));
export const intersect = (a, b) => (x, y) => Math.max(a(x, y), b(x, y));
export const grow = (f, k) => (x, y) => f(x, y) - k;
export const rotate = (f, cx, cy, ang) => (x, y) => {
  const c = Math.cos(-ang), s = Math.sin(-ang), dx = x - cx, dy = y - cy;
  return f(cx + dx * c - dy * s, cy + dx * s + dy * c);
};
// Half planes, for cutting a shape off flat -- a sprite at its base, a circle
// down to a dome. NOTE the canvas y axis points DOWN, so "above" is smaller y.
// Inside is negative, as for every other shape here.
export const keepAbove = (yLine) => (x, y) => y - yLine;   // keeps y < yLine
export const keepBelow = (yLine) => (x, y) => yLine - y;   // keeps y > yLine

// ------------------------------------------------------------------------ colour
export const rgb = (hex, a = 1) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, a];
};

/** Vertical gradient between two colours across [y0, y1]. */
export const vgrad = (c0, c1, y0, y1) => (x, y) => {
  const t = Math.max(0, Math.min(1, (y - y0) / (y1 - y0 || 1)));
  return [0, 1, 2, 3].map(i => c0[i] + (c1[i] - c0[i]) * t);
};

/** Radial gradient out from a centre; `pow` shapes the falloff. */
export const rgrad = (c0, c1, cx, cy, r, pow = 1) => (x, y) => {
  const t = Math.min(1, Math.hypot(x - cx, y - cy) / r) ** pow;
  return [0, 1, 2, 3].map(i => c0[i] + (c1[i] - c0[i]) * t);
};

// ------------------------------------------------------------------------ canvas
export class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.data = new Float32Array(w * h * 4); // straight (non-premultiplied) RGBA
  }

  /**
   * Paint a shape. `color` is an [r,g,b,a] or a function of (x, y).
   * `softness` widens the antialiased edge band, in pixels.
   */
  paint(sdf, color, { softness = 1, alpha = 1 } = {}) {
    const fn = typeof color === 'function' ? color : () => color;
    for (let py = 0; py < this.h; py++) {
      for (let px = 0; px < this.w; px++) {
        const x = px + 0.5, y = py + 0.5;
        const d = sdf(x, y);
        if (d > softness) continue;
        const cov = Math.max(0, Math.min(1, 0.5 - d / softness));
        if (cov <= 0) continue;
        const c = fn(x, y);
        this.blend(px, py, c[0], c[1], c[2], c[3] * cov * alpha);
      }
    }
    return this;
  }

  /** Shape plus a dark outline drawn behind it, the cartoon look in one call. */
  paintOutlined(sdf, color, ink, weight, opts = {}) {
    this.paint(grow(sdf, weight), ink, opts);
    this.paint(sdf, color, opts);
    return this;
  }

  blend(px, py, r, g, b, a) {
    if (a <= 0) return;
    const i = (py * this.w + px) * 4;
    const d = this.data;
    const da = d[i + 3];
    const out = a + da * (1 - a);
    if (out <= 0) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; return; }
    d[i] = (r * a + d[i] * da * (1 - a)) / out;
    d[i + 1] = (g * a + d[i + 1] * da * (1 - a)) / out;
    d[i + 2] = (b * a + d[i + 2] * da * (1 - a)) / out;
    d[i + 3] = out;
  }

  /** Multiply every pixel's alpha by a mask function returning 0..1. */
  mask(fn) {
    for (let py = 0; py < this.h; py++) {
      for (let px = 0; px < this.w; px++) {
        const i = (py * this.w + px) * 4;
        this.data[i + 3] *= Math.max(0, Math.min(1, fn(px + 0.5, py + 0.5)));
      }
    }
    return this;
  }

  toPNG() {
    const { w, h, data } = this;
    // One filter byte (0 = None) per scanline, then straight RGBA8.
    const raw = Buffer.alloc(h * (1 + w * 4));
    let o = 0;
    for (let y = 0; y < h; y++) {
      raw[o++] = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let k = 0; k < 4; k++) {
          raw[o++] = Math.max(0, Math.min(255, Math.round(data[i + k] * 255)));
        }
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
  return Buffer.concat([len, td, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
