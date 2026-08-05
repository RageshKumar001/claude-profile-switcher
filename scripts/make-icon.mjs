#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Generate the project and extension icons.
 *
 * Written as code rather than checked in as an opaque binary: the icon has a
 * source, regenerates identically, and can be tweaked without a design tool.
 * Everything is drawn by supersampled coverage testing and encoded to PNG with
 * Node's own zlib -- no dependencies.
 *
 * The mark is a swap glyph: two arrows exchanging places, one per account.
 */

const SS = 4; // supersample factor, box-downsampled for antialiasing

// ------------------------------------------------------------------ geometry

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function roundRect(x, y, size, radius) {
  return (px, py) => {
    const dx = Math.max(x - px, 0, px - (x + size));
    const dy = Math.max(y - py, 0, py - (y + size));
    if (dx === 0 && dy === 0) {
      const inx = Math.min(px - x, x + size - px);
      const iny = Math.min(py - y, y + size - py);
      if (inx >= radius || iny >= radius) return true;
      const cx = px < x + radius ? x + radius : x + size - radius;
      const cy = py < y + radius ? y + radius : y + size - radius;
      return Math.hypot(px - cx, py - cy) <= radius;
    }
    return false;
  };
}

/** Horizontal bar with round caps. */
function capsule(x1, x2, y, thickness) {
  const r = thickness / 2;
  const [lo, hi] = x1 < x2 ? [x1, x2] : [x2, x1];
  return (px, py) => {
    if (px >= lo && px <= hi) return Math.abs(py - y) <= r;
    const cx = px < lo ? lo : hi;
    return Math.hypot(px - cx, py - y) <= r;
  };
}

/** Triangle arrowhead pointing left or right. */
function arrowHead(tipX, y, height, direction) {
  const half = height / 2;
  const baseX = tipX - direction * height * 0.9;
  return (px, py) => {
    const t = direction > 0 ? (tipX - px) / (tipX - baseX) : (px - tipX) / (baseX - tipX);
    if (t < 0 || t > 1) return false;
    return Math.abs(py - y) <= half * t;
  };
}

// ---------------------------------------------------------------- rendering

function render(size) {
  const dim = size * SS;
  const hi = new Float32Array(dim * dim * 4);

  const bg = roundRect(0, 0, dim, dim * 0.22);

  // Claude-adjacent coral, shaded top-to-bottom for a little depth.
  const top = [0xe0, 0x81, 0x5f];
  const bottom = [0xbc, 0x56, 0x39];

  const thickness = dim * 0.085;
  const headSize = dim * 0.2;
  const upperY = dim * 0.375;
  const lowerY = dim * 0.625;
  const leftX = dim * 0.22;
  const rightX = dim * 0.78;

  // Top arrow points right, bottom arrow points left: two accounts trading places.
  const upperShaft = capsule(leftX, rightX - headSize * 0.55, upperY, thickness);
  const upperHead = arrowHead(rightX, upperY, headSize, 1);
  const lowerShaft = capsule(leftX + headSize * 0.55, rightX, lowerY, thickness);
  const lowerHead = arrowHead(leftX, lowerY, headSize, -1);

  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const i = (y * dim + x) * 4;

      if (!bg(px, py)) continue;

      const t = py / dim;
      hi[i] = top[0] + (bottom[0] - top[0]) * t;
      hi[i + 1] = top[1] + (bottom[1] - top[1]) * t;
      hi[i + 2] = top[2] + (bottom[2] - top[2]) * t;
      hi[i + 3] = 255;

      const glyph =
        upperShaft(px, py) || upperHead(px, py) || lowerShaft(px, py) || lowerHead(px, py);
      if (glyph) {
        hi[i] = 255;
        hi[i + 1] = 252;
        hi[i + 2] = 249;
      }
    }
  }

  // Box downsample to the target size -- this is where the antialiasing happens.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * dim + (x * SS + sx)) * 4;
          const alpha = hi[i + 3] / 255;
          r += hi[i] * alpha;
          g += hi[i + 1] * alpha;
          b += hi[i + 2] * alpha;
          a += alpha;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      // Un-premultiply so edge pixels keep their colour instead of darkening.
      out[o] = a > 0 ? Math.round(clamp01(r / a / 255) * 255) : 0;
      out[o + 1] = a > 0 ? Math.round(clamp01(g / a / 255) * 255) : 0;
      out[o + 2] = a > 0 ? Math.round(clamp01(b / a / 255) * 255) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

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

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
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

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- outputs

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const targets = [
  { file: path.join(root, 'vscode-extension', 'icon.png'), size: 128 },
  { file: path.join(root, 'assets', 'icon.png'), size: 256 },
];

for (const { file, size } of targets) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(render(size), size));
  console.log(`wrote ${path.relative(root, file)} (${size}x${size}, ${fs.statSync(file).size} bytes)`);
}
