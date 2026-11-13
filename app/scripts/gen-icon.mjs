// scripts/gen-icon.mjs — generates icon.png (1024), icon.icns, icon.ico. Zero dependencies.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] || 'build';
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const ACC = hex('#2fb7ff'), GREY = hex('#3a4250'), WHITE = hex('#f2f4f7');
const TOP = hex('#1b1c20'), BOT = hex('#09090b');
const HEIGHTS = [90, 170, 120, 260, 340, 220, 290, 150, 200, 110, 70];
const BW = 34, GAP = 22, PLAYED = 5;
const X0 = 512 - (HEIGHTS.length * BW + (HEIGHTS.length - 1) * GAP) / 2;
const PH_X = X0 + PLAYED * (BW + GAP) - GAP / 2;

function sdBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - hx + r, qy = Math.abs(py - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function erfc(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

function render(size) {
  const k = size / 1024, px = new Uint8Array(size * size * 4);
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = (i + 0.5) / k, y = (j + 0.5) / k, aa = 0.5 / k;
    const cov = d => Math.min(1, Math.max(0, 0.5 - d / (2 * aa)));
    let r = 0, g = 0, b = 0, a = 0;
    const over = (c, al) => { r = c[0] * al + r * (1 - al); g = c[1] * al + g * (1 - al); b = c[2] * al + b * (1 - al); a = al + a * (1 - al); };
    const sdS = sdBox(x, y - 10, 512, 512, 412, 412, 185);
    over([0, 0, 0], 0.35 * 0.5 * erfc(sdS / (14 * Math.SQRT2)));
    const sd = sdBox(x, y, 512, 512, 412, 412, 185), m = cov(sd);
    if (m > 0) {
      const t = Math.min(1, Math.max(0, (y - 100) / 824));
      const d = (rnd() - 0.5) * 1.5 / 255;
      over([TOP[0] + (BOT[0] - TOP[0]) * t + d, TOP[1] + (BOT[1] - TOP[1]) * t + d, TOP[2] + (BOT[2] - TOP[2]) * t + d], m);
      const rim = cov(Math.abs(sd + 1.5) - 1.5) * 0.10 * Math.max(0, 1 - t / 0.5);
      if (rim > 0) over([1, 1, 1], rim * m);
      HEIGHTS.forEach((h, n) => {
        const bx = X0 + n * (BW + GAP) + BW / 2;
        const c = cov(sdBox(x, y, bx, 512, BW / 2, h / 2, BW / 2));
        if (c > 0) over(n < PLAYED ? ACC : GREY, c);
      });
      const p = cov(sdBox(x, y, PH_X, 512, 6, 212, 6));
      if (p > 0) over(WHITE, p);
    }
    const o = (j * size + i) * 4, u = a > 0 ? 1 / a : 0;
    px[o] = Math.round(Math.min(1, Math.max(0, r * u)) * 255);
    px[o + 1] = Math.round(Math.min(1, Math.max(0, g * u)) * 255);
    px[o + 2] = Math.round(Math.min(1, Math.max(0, b * u)) * 255);
    px[o + 3] = Math.round(a * 255);
  }
  return png(size, px);
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = ~0; for (const v of buf) c = CRC[(c ^ v) & 255] ^ (c >>> 8); return ~c >>> 0; };
function chunk(type, data) {
  const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4);
  len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}
function png(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
const P = {}; for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) P[s] = render(s);
writeFileSync(`${OUT}/icon.png`, P[1024]);

const icns = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]
  .map(([t, s]) => { const h = Buffer.alloc(8); h.write(t); h.writeUInt32BE(P[s].length + 8, 4); return Buffer.concat([h, P[s]]); });
const ib = Buffer.concat(icns), ih = Buffer.alloc(8); ih.write('icns'); ih.writeUInt32BE(ib.length + 8, 4);
writeFileSync(`${OUT}/icon.icns`, Buffer.concat([ih, ib]));

const sizes = [16, 24, 32, 48, 64, 128, 256], hdr = Buffer.alloc(6); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(sizes.length, 4);
let off = 6 + 16 * sizes.length; const dir = [], data = [];
for (const s of sizes) { const e = Buffer.alloc(16); e[0] = s & 255; e[1] = s & 255; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(P[s].length, 8); e.writeUInt32LE(off, 12); off += P[s].length; dir.push(e); data.push(P[s]); }
writeFileSync(`${OUT}/icon.ico`, Buffer.concat([hdr, ...dir, ...data]));
console.log(`wrote ${OUT}/icon.png, icon.icns, icon.ico`);
