// Downloads a URL into the store and proves the result is audio.

import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR, MIN_AUDIO_BYTES } from '../config.mjs';
import { fail, CODES } from './fail.mjs';

export function sanitize(name) {
  return name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function dispositionName(cd) {
  if (!cd) return null;
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch {} }
  const plain = cd.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  return plain ? (plain[1] || plain[2]).trim() : null;
}

export function sniff(buf) {
  const h = buf.subarray(0, 12);
  const s = h.toString('latin1');
  if (s.startsWith('ID3')) return 'mp3';
  if (h[0] === 0xff && (h[1] & 0xe0) === 0xe0) return 'mp3';
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WAVE') return 'wav';
  if (s.startsWith('fLaC')) return 'flac';
  if (s.slice(4, 8) === 'ftyp') return 'm4a';
  if (s.startsWith('FORM') && /AIF[FC]/.test(s.slice(8, 12))) return 'aiff';
  if (s.startsWith('OggS')) return 'ogg';
  if (s.startsWith('PK')) return 'zip';
  return null;
}

// Validates an audio file already on disk; returns its detected type.
export function verifyAudio(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r'); const head = Buffer.alloc(12); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd);
  const kind = sniff(head);
  if (!kind) fail(CODES.BAD_FILE, `${path.basename(file)} is not a recognised audio file (head: ${head.toString('hex')})`, { file });
  if (kind !== 'zip' && size < MIN_AUDIO_BYTES) fail(CODES.BAD_FILE, `${path.basename(file)} is only ${size} bytes`, { file });
  return { kind, size };
}

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) { p = path.join(dir, `${base} (${i})${ext}`); if (!fs.existsSync(p)) return p; }
}

// fallbackName is used when the server gives no filename (no extension needed).
export async function fetchToStore(url, { fallbackName, headers = {} } = {}) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  let res;
  try { res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(180000) }); }
  catch (e) { fail(CODES.DOWNLOAD, `fetch failed: ${e.message}`, { url }); }
  if (!res.ok) fail(CODES.DOWNLOAD, `download returned HTTP ${res.status}`, { url, body: (await res.text()).slice(0, 500) });
  const buf = Buffer.from(await res.arrayBuffer());

  let name = dispositionName(res.headers.get('content-disposition'));
  if (!name) { try { name = dispositionName(new URL(url).searchParams.get('response-content-disposition')); } catch {} }
  const kind = sniff(buf);
  if (!kind) fail(CODES.BAD_FILE, `downloaded content is not audio (content-type ${res.headers.get('content-type')}, head ${buf.subarray(0, 12).toString('hex')})`, { url, text: buf.subarray(0, 300).toString('utf8') });
  if (!name) name = `${fallbackName || 'track'}.${kind === 'm4a' ? 'm4a' : kind}`;
  name = sanitize(name);
  if (!path.extname(name)) name += `.${kind}`;

  // Same name + same size already in the store: treat as already downloaded.
  const existing = path.join(STORE_DIR, name);
  if (fs.existsSync(existing) && fs.statSync(existing).size === buf.length) return { file: existing, kind, size: buf.length, existed: true };

  const file = uniquePath(STORE_DIR, name);
  fs.writeFileSync(file, buf);
  const v = verifyAudio(file);
  return { file, ...v, existed: false };
}

// A gate that hands out a .zip: unpack it into a fresh temp dir (untrusted archive), move every
// audio file into the store (verified, collision-safe), drop the rest (README, artwork) and the zip.
// Returns { file: <first audio>, files: [...], kind, size, fromZip }.
export async function unpackZip(zipFile) {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-dl-unzip-'));
  try {
    try { execFileSync('/usr/bin/unzip', ['-qq', '-o', zipFile, '-d', tmp], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { fail(CODES.BAD_FILE, `could not unzip ${path.basename(zipFile)}: ${e.stderr?.toString().slice(0, 300) || e.message}`, { zipFile }); }
    const all = [];
    const walk = d => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.name === '__MACOSX') continue; if (n.isDirectory()) walk(p); else if (n.isFile()) all.push(p); } };
    walk(tmp);
    const audio = all.filter(p => { try { const fd = fs.openSync(p, 'r'); const h = Buffer.alloc(12); fs.readSync(fd, h, 0, 12, 0); fs.closeSync(fd); const k = sniff(h); return k && k !== 'zip'; } catch { return false; } });
    if (!audio.length) fail(CODES.BAD_FILE, `${path.basename(zipFile)} has no audio files`, { contents: all.map(p => path.relative(tmp, p)) });
    const files = [];
    for (const p of audio) {
      const v = verifyAudio(p);
      const name = sanitize(path.basename(p));
      const existing = path.join(STORE_DIR, name);
      if (fs.existsSync(existing) && fs.statSync(existing).size === v.size) { files.push({ file: existing, ...v, existed: true }); continue; }
      const dest = uniquePath(STORE_DIR, name);
      fs.copyFileSync(p, dest);
      files.push({ file: dest, ...v, existed: false });
    }
    fs.rmSync(zipFile);
    return { ...files[0], files: files.map(f => f.file), fromZip: path.basename(zipFile) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
