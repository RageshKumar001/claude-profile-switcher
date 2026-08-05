#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Generate the 1280x640 social preview card (GitHub "Open Graph image").
 *
 * Same rules as make-icon.mjs: drawn in code, no dependencies, regenerates
 * identically. Which means the lettering is drawn too -- there is no font to
 * load, so each glyph is a handful of strokes rendered by signed-distance
 * testing. Only the characters these two strings need are defined.
 */

const W = 1280;
const H = 640;
const SS = 2; // supersample factor, box-downsampled for antialiasing

const TITLE = 'Claude Profile Switcher';
const SUBTITLE = 'Per-project Claude Code accounts for Windows';

// ------------------------------------------------------------------- palette

const BG_TOP = [0x1c, 0x17, 0x13];
const BG_BOTTOM = [0x0e, 0x0c, 0x0a];
const CORAL_TOP = [0xe0, 0x81, 0x5f];
const CORAL_BOTTOM = [0xbc, 0x56, 0x39];
const INK = [0xfa, 0xf7, 0xf4];
const MUTED = [0x9a, 0x8d, 0x84];

// -------------------------------------------------------------------- canvas

const dim = { w: W * SS, h: H * SS };
const buf = new Float32Array(dim.w * dim.h * 3);

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function blend(x, y, colour, alpha) {
  if (alpha <= 0) return;
  if (x < 0 || y < 0 || x >= dim.w || y >= dim.h) return;
  const i = (y * dim.w + x) * 3;
  const a = alpha > 1 ? 1 : alpha;
  buf[i] = lerp(buf[i], colour[0], a);
  buf[i + 1] = lerp(buf[i + 1], colour[1], a);
  buf[i + 2] = lerp(buf[i + 2], colour[2], a);
}

// --------------------------------------------------------------- distance fn

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp01(((px - x1) * dx + (py - y1) * dy) / len2);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const norm360 = (deg) => ((deg % 360) + 360) % 360;

/**
 * Distance to a circular arc swept from `a0` by `sweep` degrees (y-axis points
 * down, so positive angles run clockwise on screen). Outside the sweep, falls
 * back to whichever endpoint is nearer -- which is what gives round caps.
 */
function distToArc(px, py, cx, cy, r, a0, sweep) {
  const angle = (Math.atan2(py - cy, px - cx) * 180) / Math.PI;
  const delta = sweep >= 0 ? norm360(angle - a0) : norm360(a0 - angle);
  if (delta <= Math.abs(sweep)) return Math.abs(Math.hypot(px - cx, py - cy) - r);

  const rad = (deg) => (deg * Math.PI) / 180;
  const ex1 = [cx + r * Math.cos(rad(a0)), cy + r * Math.sin(rad(a0))];
  const a1 = a0 + sweep;
  const ex2 = [cx + r * Math.cos(rad(a1)), cy + r * Math.sin(rad(a1))];
  return Math.min(Math.hypot(px - ex1[0], py - ex1[1]), Math.hypot(px - ex2[0], py - ex2[1]));
}

/** Draw a set of strokes with round caps, antialiased over one pixel. */
function stroke(strokes, thickness, colour, bbox) {
  const half = thickness / 2;
  const x0 = Math.max(0, Math.floor(bbox[0] - half - 2));
  const y0 = Math.max(0, Math.floor(bbox[1] - half - 2));
  const x1 = Math.min(dim.w - 1, Math.ceil(bbox[2] + half + 2));
  const y1 = Math.min(dim.h - 1, Math.ceil(bbox[3] + half + 2));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let d = Infinity;
      for (const s of strokes) {
        const sd =
          s.type === 'arc'
            ? distToArc(px, py, s.cx, s.cy, s.r, s.a0, s.sweep)
            : distToSegment(px, py, s.x1, s.y1, s.x2, s.y2);
        if (sd < d) d = sd;
        if (d <= 0) break;
      }
      blend(x, y, colour, clamp01(half + 0.5 - d));
    }
  }
}

// ---------------------------------------------------------------------- font
//
// Em box: cap height spans y 0..1, x-height starts at 0.36, descenders reach
// 1.28. Coordinates are multiplied by the font size at draw time.

const seg = (x1, y1, x2, y2) => ({ type: 'seg', x1, y1, x2, y2 });
const arc = (cx, cy, r, a0, sweep) => ({ type: 'arc', cx, cy, r, a0, sweep });
const dot = (x, y) => seg(x, y, x, y);
const circle = (cx, cy, r) => arc(cx, cy, r, 0, 360);

const FONT = {
  ' ': { w: 0.3, s: [] },
  '-': { w: 0.46, s: [seg(0.06, 0.68, 0.4, 0.68)] },

  C: { w: 0.76, s: [arc(0.36, 0.5, 0.36, 55, 250)] },
  P: {
    w: 0.66,
    s: [seg(0.06, 0, 0.06, 1), seg(0.06, 0, 0.32, 0), seg(0.06, 0.52, 0.32, 0.52),
        arc(0.32, 0.26, 0.26, -90, 180)],
  },
  S: { w: 0.66, s: [arc(0.33, 0.28, 0.26, -25, -245), arc(0.33, 0.72, 0.26, -90, 245)] },
  W: {
    w: 0.86,
    s: [seg(0.02, 0, 0.21, 1), seg(0.21, 1, 0.4, 0.3), seg(0.4, 0.3, 0.59, 1),
        seg(0.59, 1, 0.78, 0)],
  },

  a: { w: 0.72, s: [circle(0.32, 0.68, 0.32), seg(0.64, 0.36, 0.64, 1)] },
  c: { w: 0.68, s: [arc(0.32, 0.68, 0.32, 55, 250)] },
  d: { w: 0.72, s: [circle(0.32, 0.68, 0.32), seg(0.64, 0, 0.64, 1)] },
  e: { w: 0.72, s: [seg(0.0, 0.68, 0.64, 0.68), arc(0.32, 0.68, 0.32, 70, 290)] },
  f: { w: 0.5, s: [seg(0.34, 0.16, 0.34, 1), arc(0.52, 0.16, 0.18, 180, 155), seg(0.1, 0.44, 0.6, 0.44)] },
  h: { w: 0.7, s: [seg(0.04, 0, 0.04, 1), arc(0.34, 0.66, 0.3, 180, 180), seg(0.64, 0.66, 0.64, 1)] },
  i: { w: 0.24, s: [seg(0.06, 0.36, 0.06, 1), dot(0.06, 0.13)] },
  j: { w: 0.38, s: [seg(0.24, 0.36, 0.24, 1.06), arc(0.02, 1.06, 0.22, 0, 90), dot(0.24, 0.13)] },
  l: { w: 0.24, s: [seg(0.06, 0, 0.06, 1)] },
  n: { w: 0.7, s: [seg(0.04, 0.36, 0.04, 1), arc(0.34, 0.66, 0.3, 180, 180), seg(0.64, 0.66, 0.64, 1)] },
  o: { w: 0.7, s: [circle(0.33, 0.68, 0.32)] },
  p: { w: 0.72, s: [seg(0.04, 0.36, 0.04, 1.28), circle(0.36, 0.68, 0.32)] },
  r: { w: 0.46, s: [seg(0.04, 0.36, 0.04, 1), arc(0.32, 0.68, 0.28, 180, 105)] },
  s: { w: 0.56, s: [arc(0.28, 0.52, 0.18, -25, -245), arc(0.28, 0.84, 0.18, -90, 245)] },
  t: { w: 0.54, s: [seg(0.26, 0.1, 0.26, 0.82), arc(0.44, 0.82, 0.18, 180, -90), seg(0.04, 0.36, 0.5, 0.36)] },
  u: { w: 0.7, s: [seg(0.04, 0.36, 0.04, 0.7), arc(0.34, 0.7, 0.3, 180, -180), seg(0.64, 0.36, 0.64, 1)] },
  w: {
    w: 0.72,
    s: [seg(0.02, 0.36, 0.17, 1), seg(0.17, 1, 0.32, 0.58), seg(0.32, 0.58, 0.47, 1),
        seg(0.47, 1, 0.62, 0.36)],
  },
};

const TRACKING = 0.06; // extra advance per glyph, in em

function textWidth(text, size) {
  let w = 0;
  for (const ch of text) {
    const g = FONT[ch];
    if (!g) throw new Error(`no glyph for ${JSON.stringify(ch)} -- add it to FONT`);
    w += (g.w + TRACKING) * size;
  }
  return w - TRACKING * size;
}

/** Draw `text` with its baseline at (x, y). Coordinates are in final pixels. */
function drawText(text, x, y, size, colour, weight = 0.09) {
  const px = x * SS;
  const py = y * SS;
  const em = size * SS;
  let pen = px;

  for (const ch of text) {
    const g = FONT[ch];
    if (g.s.length) {
      const strokes = g.s.map((s) =>
        s.type === 'arc'
          ? { ...s, cx: pen + s.cx * em, cy: py + (s.cy - 1) * em, r: s.r * em }
          : {
              ...s,
              x1: pen + s.x1 * em,
              y1: py + (s.y1 - 1) * em,
              x2: pen + s.x2 * em,
              y2: py + (s.y2 - 1) * em,
            },
      );
      stroke(strokes, weight * em, colour, [pen - em * 0.1, py - em * 1.15, pen + (g.w + 0.1) * em, py + em * 0.35]);
    }
    pen += (g.w + TRACKING) * em;
  }
}

// ----------------------------------------------------------------- the mark
//
// The same swap glyph as the icon: two arrows exchanging places.

function drawMark(x, y, size) {
  const px = x * SS;
  const py = y * SS;
  const s = size * SS;
  const radius = s * 0.22;

  const inside = (dx, dy) => {
    const inx = Math.min(dx, s - dx);
    const iny = Math.min(dy, s - dy);
    if (inx < 0 || iny < 0) return false;
    if (inx >= radius || iny >= radius) return true;
    const cx = dx < radius ? radius : s - radius;
    const cy = dy < radius ? radius : s - radius;
    return Math.hypot(dx - cx, dy - cy) <= radius;
  };

  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      if (!inside(dx + 0.5, dy + 0.5)) continue;
      const t = dy / s;
      blend(px + dx, py + dy, [
        lerp(CORAL_TOP[0], CORAL_BOTTOM[0], t),
        lerp(CORAL_TOP[1], CORAL_BOTTOM[1], t),
        lerp(CORAL_TOP[2], CORAL_BOTTOM[2], t),
      ], 1);
    }
  }

  // Arrows, drawn as strokes so they share the antialiasing path.
  const thickness = s * 0.085;
  const head = s * 0.2;
  const upperY = py + s * 0.375;
  const lowerY = py + s * 0.625;
  const leftX = px + s * 0.22;
  const rightX = px + s * 0.78;
  const box = [px, py, px + s, py + s];

  stroke([seg(leftX, upperY, rightX - head * 0.5, upperY)], thickness, INK, box);
  stroke([seg(leftX + head * 0.5, lowerY, rightX, lowerY)], thickness, INK, box);

  // Solid triangular heads: coverage test rather than strokes.
  const head1 = (qx, qy) => {
    const t = (rightX - qx) / (head * 0.9);
    return t >= 0 && t <= 1 && Math.abs(qy - upperY) <= (head / 2) * t;
  };
  const head2 = (qx, qy) => {
    const t = (qx - leftX) / (head * 0.9);
    return t >= 0 && t <= 1 && Math.abs(qy - lowerY) <= (head / 2) * t;
  };
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      const qx = px + dx + 0.5;
      const qy = py + dy + 0.5;
      if (head1(qx, qy) || head2(qx, qy)) blend(px + dx, py + dy, INK, 1);
    }
  }
}

// ------------------------------------------------------------------- compose

for (let y = 0; y < dim.h; y++) {
  const t = y / dim.h;
  const r = lerp(BG_TOP[0], BG_BOTTOM[0], t);
  const g = lerp(BG_TOP[1], BG_BOTTOM[1], t);
  const b = lerp(BG_TOP[2], BG_BOTTOM[2], t);
  for (let x = 0; x < dim.w; x++) {
    const i = (y * dim.w + x) * 3;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
  }
}

const MARK = 210;
const MARK_X = 108;
const TEXT_X = MARK_X + MARK + 66;

drawMark(MARK_X, (H - MARK) / 2, MARK);

// Sized so the right margin matches the left one -- the card should not look
// like the text ran out of room.
const TITLE_SIZE = 56;
const RULE_Y = 414;
const RULE_W = textWidth(TITLE, TITLE_SIZE);

drawText(TITLE, TEXT_X, 306, TITLE_SIZE, INK, 0.095);
drawText(SUBTITLE, TEXT_X, 376, 26, MUTED, 0.105);

// A coral rule, as wide as the title, to tie the two halves together.
stroke(
  [seg(TEXT_X * SS, RULE_Y * SS, (TEXT_X + RULE_W) * SS, RULE_Y * SS)],
  5 * SS,
  CORAL_TOP,
  [TEXT_X * SS - 10, (RULE_Y - 6) * SS, (TEXT_X + RULE_W) * SS + 10, (RULE_Y + 6) * SS],
);

// -------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// Box downsample to the target size -- this is where the antialiasing lands.
const rgb = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * dim.w + (x * SS + sx)) * 3;
        r += buf[i];
        g += buf[i + 1];
        b += buf[i + 2];
      }
    }
    const n = SS * SS;
    const o = (y * W + x) * 3;
    rgb[o] = Math.round(r / n);
    rgb[o + 1] = Math.round(g / n);
    rgb[o + 2] = Math.round(b / n);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0; // filter: none
  rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'assets', 'social-preview.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote assets/social-preview.png (${W}x${H}, ${fs.statSync(out).size} bytes)`);
