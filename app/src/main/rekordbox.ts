// Reads Rekordbox's analysis files. Rekordbox keeps one folder per analysed track with an
// ANLZ0000.DAT (the track's file name and beat grid) and an ANLZ0000.EXT (the detailed
// waveform Rekordbox drew from its own decode of the file).
//
// Cue points are not in those files: they are read from Rekordbox's database (a copy of it,
// never the file Rekordbox has open). Nothing here talks to Rekordbox itself. A scan turns the .DAT files into a small
// index, kept as JSON between runs. A dropped file is matched by name, then confirmed by
// lining its audio up against Rekordbox's waveform. The same step measures how far
// Rekordbox's clock is ahead of ours for that file: Rekordbox keeps the silence that MP3 and
// AAC encoders add at the start, our decoder removes it.
//
// Used from the worker thread and from tests; no Electron imports.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SAMPLE_RATE, type RekordboxGrid } from "../shared/planner";
import { WavReader } from "./audio/wav";

export type AnlzBeat = { no: number; tempo: number; ms: number }; // bar position 1-4, BPM x 100, time
// A match also says which analysis it was and how far Rekordbox's clock is ahead of ours,
// which is what its cue points need.
export type RekordboxMatch = RekordboxGrid & { dat: string; shiftSec: number };
export type LibraryEntry = { name: string; bpm: number; downbeatMs: number; dat: string; mtimeMs: number };

type CachedFile = { mtimeMs: number; size: number; entry: LibraryEntry | null };
type CacheDoc = { version: number; root: string; files: Record<string, CachedFile> };
const CACHE_VERSION = 1;

// ---- file format --------------------------------------------------------------------

type Section = { tag: string; pos: number; body: number; end: number };

// An analysis file is a "PMAI" header followed by tagged sections, all big-endian.
function sections(buf: Buffer): Section[] {
	const out: Section[] = [];
	if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "PMAI") return out;
	let pos = buf.readUInt32BE(4);
	while (pos >= 12 && pos + 12 <= buf.length) {
		const head = buf.readUInt32BE(pos + 4);
		const len = buf.readUInt32BE(pos + 8);
		if (head < 12 || len < head || pos + len > buf.length) break;
		out.push({ tag: buf.toString("latin1", pos, pos + 4), pos, body: pos + head, end: pos + len });
		pos += len;
	}
	return out;
}

// The track's file name and beat grid from a .DAT file.
export function parseAnlz(buf: Buffer): { name: string; beats: AnlzBeat[] } | null {
	let name = "";
	let beats: AnlzBeat[] | null = null;
	for (const s of sections(buf)) {
		if (s.tag === "PPTH" && s.pos + 16 <= s.end) {
			// UTF-16BE, usually "?/<file name>"; older entries carry the whole path.
			const len = Math.min(buf.readUInt32BE(s.pos + 12), s.end - s.pos - 16) & ~1;
			const text = Buffer.from(buf.subarray(s.pos + 16, s.pos + 16 + len)).swap16().toString("utf16le").replace(/\0+$/, "");
			name = text.slice(text.lastIndexOf("/") + 1);
		} else if (s.tag === "PQTZ" && s.pos + 24 <= s.end) {
			const count = Math.min(buf.readUInt32BE(s.pos + 20), Math.floor((s.end - s.body) / 8));
			beats = [];
			for (let i = 0; i < count; i++) {
				const o = s.body + i * 8;
				beats.push({ no: buf.readUInt16BE(o), tempo: buf.readUInt16BE(o + 2), ms: buf.readUInt32BE(o + 4) });
			}
		}
	}
	return name && beats ? { name, beats } : null;
}

export const WAVE_RATE = 150; // waveform columns per second

// Column heights (0-31) of the detailed waveform in an .EXT file.
export function parseWaveform(buf: Buffer): Uint8Array | null {
	const all = sections(buf);
	for (const tag of ["PWV3", "PWV5"]) {
		const s = all.find((x) => x.tag === tag);
		if (!s || s.pos + 24 > s.end) continue;
		const size = buf.readUInt32BE(s.pos + 12);
		const count = Math.min(buf.readUInt32BE(s.pos + 16), Math.floor((s.end - s.body) / Math.max(1, size)));
		if (buf.readUInt16BE(s.pos + 20) !== WAVE_RATE || count <= 0) continue;
		const out = new Uint8Array(count);
		if (tag === "PWV3" && size === 1) for (let i = 0; i < count; i++) out[i] = buf[s.body + i] & 0x1f;
		else if (tag === "PWV5" && size === 2) for (let i = 0; i < count; i++) out[i] = (buf.readUInt16BE(s.body + i * 2) >> 2) & 0x1f;
		else continue;
		return out;
	}
	return null;
}

// ---- beat grid ----------------------------------------------------------------------

const MIN_GRID_BEATS = 8;
const STEP_SLACK_MS = 1.5; // beat times are whole milliseconds

// One tempo and one bar line for the track, from its longest stretch of evenly spaced beats.
// Null when there is no such stretch covering at least half the grid (tempo that keeps
// changing), which leaves the track to the normal BPM prompt.
export function gridFromBeats(beats: AnlzBeat[]): { bpm: number; downbeatMs: number } | null {
	let from = 0;
	let to = 0; // best run is [from, to)
	let start = 0;
	for (let i = 1; i <= beats.length; i++) {
		const a = beats[i - 1];
		const b = beats[i];
		const even = b !== undefined && b.tempo === a.tempo && a.tempo > 0 && b.no === (a.no % 4) + 1 && Math.abs(b.ms - a.ms - 6000000 / a.tempo) <= STEP_SLACK_MS;
		if (even) continue;
		if (i - start > to - from) {
			from = start;
			to = i;
		}
		start = i;
	}
	const n = to - from;
	if (n < MIN_GRID_BEATS || n * 2 < beats.length) return null;
	// Least-squares line through the beat times: finer than the stored BPM (two decimals)
	// and than any single beat time (whole milliseconds).
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	for (let i = 0; i < n; i++) {
		const y = beats[from + i].ms;
		sx += i;
		sy += y;
		sxx += i * i;
		sxy += i * y;
	}
	const beatMs = (n * sxy - sx * sy) / (n * sxx - sx * sx);
	const firstMs = (sy - beatMs * sx) / n;
	if (!(beatMs > 0)) return null;
	const fitted = 60000 / beatMs;
	const shown = beats[from].tempo / 100;
	// Rekordbox's own two-decimal BPM when it stays within a millisecond of the grid over
	// the whole track (so a 150.00 track is exactly 150), otherwise the fitted value.
	const driftMs = (Math.abs(fitted - shown) / shown) * (n - 1) * beatMs;
	const bpm = driftMs <= 1 ? shown : Math.round(fitted * 1000) / 1000;
	if (!(bpm >= 20 && bpm <= 400)) return null;
	// The first bar line at or after the start of the file, on the fitted line.
	const toBar = (5 - beats[from].no) % 4;
	const barMs = 4 * beatMs;
	const downbeat = firstMs + toBar * beatMs;
	return { bpm, downbeatMs: downbeat - Math.floor(downbeat / barMs) * barMs };
}

// ---- library scan -------------------------------------------------------------------

// Rekordbox's analysis folder for the user whose home folder this is, or null when there is
// none. It normally lives in ~/Library/Pioneer/rekordbox/share; someone who moved their
// library (to another drive, say) has the new place recorded in Rekordbox's settings.
export function findAnalysisRoot(home: string): string | null {
	const shares = [path.join(home, "Library/Pioneer/rekordbox/share")];
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(home, "Library/Application Support/Pioneer/rekordboxAgent/storage/options.json"), "utf8")) as { options?: unknown };
		const options = Array.isArray(settings.options) ? settings.options : [];
		const moved = options.find((o): o is [string, string] => Array.isArray(o) && o[0] === "analysis-data-root-path" && typeof o[1] === "string" && o[1] !== "");
		if (moved) shares.unshift(moved[1]);
	} catch {
		// not installed, or a settings file we don't understand: try the standard place
	}
	for (const share of shares) {
		const dir = path.join(share, "PIONEER", "USBANLZ");
		if (fs.existsSync(dir)) return dir;
	}
	return null;
}

function findDats(dir: string, depth: number, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.isDirectory()) {
			if (depth > 0) findDats(path.join(dir, e.name), depth - 1, out);
		} else if (/\.DAT$/i.test(e.name) && !e.name.startsWith(".")) out.push(path.join(dir, e.name));
	}
}

function readCache(cachePath: string, root: string): Record<string, CachedFile> {
	try {
		const doc = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CacheDoc;
		if (doc.version === CACHE_VERSION && doc.root === root && doc.files && typeof doc.files === "object") return doc.files;
	} catch {
		// no cache yet, or unreadable: build it again
	}
	return {};
}

// Brings the cached index up to date with the analysis folder and returns every usable
// track. Only files that are new or changed since the last scan are read.
export function scanLibrary(root: string, cachePath: string): LibraryEntry[] {
	const old = readCache(cachePath, root);
	const files: Record<string, CachedFile> = {};
	const dats: string[] = [];
	findDats(root, 3, dats);
	let changed = Object.keys(old).length !== dats.length;
	for (const dat of dats) {
		let st: fs.Stats;
		try {
			st = fs.statSync(dat);
		} catch {
			changed = true;
			continue;
		}
		const had = old[dat];
		if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) {
			files[dat] = had;
			continue;
		}
		changed = true;
		let entry: LibraryEntry | null = null;
		try {
			const parsed = parseAnlz(fs.readFileSync(dat));
			const grid = parsed && gridFromBeats(parsed.beats);
			if (parsed && grid) entry = { name: parsed.name, bpm: grid.bpm, downbeatMs: grid.downbeatMs, dat, mtimeMs: st.mtimeMs };
		} catch {
			// unreadable right now (Rekordbox may be writing it): picked up by a later scan
		}
		files[dat] = { mtimeMs: st.mtimeMs, size: st.size, entry };
	}
	if (changed) {
		try {
			const doc: CacheDoc = { version: CACHE_VERSION, root, files };
			const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(doc));
			fs.renameSync(tmp, cachePath);
		} catch {
			// the cache only saves time on the next start
		}
	}
	const out: LibraryEntry[] = [];
	for (const f of Object.values(files)) if (f.entry) out.push(f.entry);
	return out;
}

// File names compare the same way however the file system spells accents and case.
export function nameKey(fileName: string): string {
	return fileName.normalize("NFC").toLowerCase();
}

// ---- matching a file to its analysis ------------------------------------------------

const COLUMN = SAMPLE_RATE / WAVE_RATE; // frames per waveform column
const STEP = 21; // search resolution in frames, under half a millisecond
const PER = COLUMN / STEP;
const MAX_COLUMNS = WAVE_RATE * 300; // the first five minutes are plenty
const BACK_SEC = 0.03; // how far Rekordbox's clock may be behind ours
const AHEAD_SEC = 0.2; // and ahead of it (encoder and decoder delay)
const LOCAL = WAVE_RATE; // columns in the moving average taken out before comparing: one second
// Agreement below this is a different recording. The right file scores 0.8 to 0.95 (a
// re-rendered one about 0.4); unrelated music stays under 0.1.
export const MIN_MATCH = 0.25;

// Takes each value's local average away, leaving the beat-to-beat detail. Two different
// songs share their broad shape (quiet intro, loud drop); only the same recording shares this.
function detail(src: Float32Array, n: number, out: Float32Array, sums: Float64Array): void {
	sums[0] = 0;
	for (let i = 0; i < n; i++) sums[i + 1] = sums[i] + src[i];
	const half = LOCAL >> 1;
	for (let i = 0; i < n; i++) {
		const lo = Math.max(0, i - half);
		const hi = Math.min(n, i + half + 1);
		out[i] = src[i] - (sums[hi] - sums[lo]) / (hi - lo);
	}
}

// Slides our decode of the file along Rekordbox's waveform of it. `shiftSec` is how much
// later a moment is on Rekordbox's clock than on ours; `score` (up to 1) says how well the
// two agree at that shift. The decoded file is 44.1 kHz, as everything in the cache is.
export function measureShift(heights: Uint8Array, wavPath: string): { shiftSec: number; score: number } | null {
	const back = Math.ceil((BACK_SEC * SAMPLE_RATE) / STEP);
	const ahead = Math.ceil((AHEAD_SEC * SAMPLE_RATE) / STEP);
	const columns = Math.min(heights.length, MAX_COLUMNS);
	const r = new WavReader(wavPath);
	let level: Float32Array;
	try {
		if (r.info.sampleRate !== SAMPLE_RATE) return null;
		// Peak level of every STEP frames, for as much audio as the columns can reach.
		const steps = Math.min(Math.floor(r.frames / STEP), columns * PER + back + PER);
		const peak = new Float32Array(Math.max(0, steps));
		const chunkSteps = 4096;
		const buf = new Float32Array(chunkSteps * STEP * 2);
		for (let s0 = 0; s0 < steps; s0 += chunkSteps) {
			const want = Math.min(chunkSteps, steps - s0);
			const got = r.read(s0 * STEP, want * STEP, buf);
			for (let s = 0; s < want && (s + 1) * STEP <= got; s++) {
				let m = 0;
				for (let f = s * STEP; f < (s + 1) * STEP; f++) {
					const v = Math.abs(buf[f * 2] + buf[f * 2 + 1]);
					if (v > m) m = v;
				}
				peak[s0 + s] = m * 0.5;
			}
		}
		// Level of the column that would start at each step.
		level = new Float32Array(Math.max(0, steps - PER + 1));
		for (let i = 0; i < level.length; i++) {
			let m = 0;
			for (let j = 0; j < PER; j++) if (peak[i + j] > m) m = peak[i + j];
			level[i] = Math.sqrt(m);
		}
	} finally {
		r.close();
	}
	const sums = new Float64Array(columns + 1);
	const theirs = new Float32Array(columns);
	detail(Float32Array.from(heights.subarray(0, columns)), columns, theirs, sums);
	const raw = new Float32Array(columns);
	const ours = new Float32Array(columns);
	const scores = new Float64Array(back + ahead + 1).fill(-1);
	let best = 0;
	for (let s = -back; s <= ahead; s++) {
		// Column k covers Rekordbox time k/150 s onward, which is `s` steps earlier for us.
		const k0 = Math.max(0, Math.ceil(s / PER));
		let n = 0;
		for (let k = k0; k < columns; k++) {
			const at = k * PER - s;
			if (at >= level.length) break;
			raw[n++] = level[at];
		}
		if (n < WAVE_RATE * 5) continue; // too little audio to say anything
		detail(raw, n, ours, sums);
		let sxx = 0;
		let syy = 0;
		let sxy = 0;
		for (let i = 0; i < n; i++) {
			const x = theirs[k0 + i];
			const y = ours[i];
			sxx += x * x;
			syy += y * y;
			sxy += x * y;
		}
		if (sxx > 0 && syy > 0) scores[s + back] = sxy / Math.sqrt(sxx * syy);
		if (scores[s + back] > scores[best]) best = s + back;
	}
	const score = scores[best];
	if (!(score > 0)) return null;
	// The peak between two steps, from the scores either side of the best one.
	let fine = 0;
	if (best > 0 && best < scores.length - 1) {
		const a = scores[best - 1];
		const c = scores[best + 1];
		const curve = a - 2 * score + c;
		if (a > -1 && c > -1 && curve < 0) fine = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curve));
	}
	return { shiftSec: ((best - back + fine) * STEP) / SAMPLE_RATE, score };
}

// Picks the analysis that really belongs to this audio (several tracks can share a file
// name) and returns its grid on our clock. Null when none of them is this recording.
export function matchTrack(decodedPath: string, candidates: LibraryEntry[]): RekordboxMatch | null {
	let frames = 0;
	const r = new WavReader(decodedPath);
	frames = r.frames;
	r.close();
	const seconds = frames / SAMPLE_RATE;
	let top: { entry: LibraryEntry; shiftSec: number; score: number } | null = null;
	// Newest first: of two analyses of the same audio, the later one has the grid in use.
	for (const entry of [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
		let heights: Uint8Array | null = null;
		try {
			heights = parseWaveform(fs.readFileSync(entry.dat.replace(/\.DAT$/i, ".EXT")));
		} catch {
			// analysis removed since the scan
		}
		// Rekordbox's decode is at most a fraction of a second longer than ours.
		if (!heights || Math.abs(heights.length / WAVE_RATE - seconds) > 2) continue;
		const m = measureShift(heights, decodedPath);
		if (m && m.score >= MIN_MATCH && (!top || m.score > top.score + 0.02)) top = { entry, ...m };
	}
	if (!top) return null;
	// Real shifts are 11 ms and up; anything under a quarter millisecond is a file both
	// decode alike (WAV, AIFF), where the exact answer is zero.
	const shiftSec = Math.abs(top.shiftSec) < 0.00025 ? 0 : top.shiftSec;
	return { bpm: top.entry.bpm, downbeatSec: top.entry.downbeatMs / 1000 - shiftSec, dat: top.entry.dat, shiftSec };
}

// ---- cue points ---------------------------------------------------------------------

// A cue as Rekordbox stores it: time on Rekordbox's clock; kind 0 is a memory cue, 1 and up
// are the hot cues A, B, C...
export type LibraryCue = { ms: number; kind: number };

// Rekordbox's database is SQLite encrypted with SQLCipher 4, with the same key on every
// installation.
const DB_KEY = "402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497";
const PAGE = 4096;
const RESERVE = 80; // at the end of each page: 16 bytes of IV, then the page's signature
const SQLITE = "/usr/bin/sqlite3"; // ships with macOS

// Where Rekordbox keeps its database for the user whose home folder this is, or null.
export function findDatabase(home: string): string | null {
	const places = [path.join(home, "Library/Pioneer/rekordbox/master.db")];
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(home, "Library/Application Support/Pioneer/rekordboxAgent/storage/options.json"), "utf8")) as { options?: unknown };
		const options = Array.isArray(settings.options) ? settings.options : [];
		const set = options.find((o): o is [string, string] => Array.isArray(o) && o[0] === "db-path" && typeof o[1] === "string" && o[1] !== "");
		if (set) places.unshift(set[1]);
	} catch {
		// not installed, or a settings file we don't understand: try the standard place
	}
	return places.find((p) => fs.existsSync(p)) ?? null;
}

// Changes whenever Rekordbox has written to its database.
export function databaseStamp(dbPath: string): string {
	const one = (p: string): string => {
		try {
			const st = fs.statSync(p);
			return `${st.mtimeMs}|${st.size}`;
		} catch {
			return "-";
		}
	};
	return `${one(dbPath)}|${one(`${dbPath}-wal`)}`;
}

// The database file with the changes Rekordbox has not folded into it yet (they wait in a
// "-wal" file next to it while Rekordbox is open). Still encrypted.
function withPendingChanges(db: Buffer, wal: Buffer | null): Buffer {
	if (!wal || wal.length < 32) return db;
	const magic = wal.readUInt32BE(0);
	if ((magic !== 0x377f0682 && magic !== 0x377f0683) || wal.readUInt32BE(8) !== PAGE) return db;
	const big = magic === 0x377f0683;
	const word = (o: number): number => (big ? wal.readUInt32BE(o) : wal.readUInt32LE(o));
	let s0 = 0;
	let s1 = 0;
	const sum = (from: number, to: number): void => {
		for (let o = from; o < to; o += 8) {
			s0 = (s0 + word(o) + s1) >>> 0;
			s1 = (s1 + word(o + 4) + s0) >>> 0;
		}
	};
	sum(0, 24);
	if (s0 !== wal.readUInt32BE(24) || s1 !== wal.readUInt32BE(28)) return db;
	const salt = wal.subarray(16, 24);
	const latest = new Map<number, number>(); // page number -> where its newest committed copy is
	let waiting: [number, number][] = [];
	let pages = 0;
	// Frames count up to the last one that ends a transaction; anything after a bad frame is
	// left over from before the file was last restarted.
	for (let at = 32; at + 24 + PAGE <= wal.length; at += 24 + PAGE) {
		if (!wal.subarray(at + 8, at + 16).equals(salt)) break;
		sum(at, at + 8);
		sum(at + 24, at + 24 + PAGE);
		if (s0 !== wal.readUInt32BE(at + 16) || s1 !== wal.readUInt32BE(at + 20)) break;
		waiting.push([wal.readUInt32BE(at), at + 24]);
		const size = wal.readUInt32BE(at + 4);
		if (size === 0) continue;
		for (const [no, where] of waiting) latest.set(no, where);
		waiting = [];
		pages = size;
	}
	if (pages === 0) return db;
	const out = Buffer.alloc(pages * PAGE);
	db.copy(out, 0, 0, Math.min(db.length, out.length));
	for (const [no, where] of latest) if (no >= 1 && no <= pages) wal.copy(out, (no - 1) * PAGE, where, where + PAGE);
	return out;
}

// A plain SQLite file from the encrypted one. Throws when it is not a Rekordbox database
// we can read.
function decryptDatabase(enc: Buffer): Buffer {
	if (enc.length < PAGE) throw new Error("Rekordbox database is too short");
	const key = crypto.pbkdf2Sync(DB_KEY, enc.subarray(0, 16), 256000, 32, "sha512");
	const out = Buffer.alloc(enc.length - (enc.length % PAGE));
	for (let o = 0; o < out.length; o += PAGE) {
		const skip = o === 0 ? 16 : 0; // the first page starts with the key's salt
		const d = crypto.createDecipheriv("aes-256-cbc", key, enc.subarray(o + PAGE - RESERVE, o + PAGE - RESERVE + 16));
		d.setAutoPadding(false);
		d.update(enc.subarray(o + skip, o + PAGE - RESERVE)).copy(out, o + skip);
		if (o === 0 && (out.readUInt16BE(16) !== PAGE || out[20] !== RESERVE || out[21] !== 64 || out[22] !== 32 || out[23] !== 32)) throw new Error("Rekordbox database could not be unlocked");
	}
	out.write("SQLite format 3\0", 0, "latin1");
	out[18] = 1; // a plain file with no "-wal" beside it
	out[19] = 1;
	return out;
}

// Analysis files are named the same way in the database and on disk from here on.
export function datKey(dat: string): string {
	return dat.split(/[\\/]/).slice(-3).join("/").toLowerCase();
}

// Every track's cue points, by analysis file (see `datKey`), in time order.
export function readCues(dbPath: string): Record<string, LibraryCue[]> {
	let plain: Buffer | null = null;
	// Rekordbox may be writing while we read: take the two files again if either changed.
	for (let attempt = 0; attempt < 3 && !plain; attempt++) {
		const before = databaseStamp(dbPath);
		const db = fs.readFileSync(dbPath);
		let wal: Buffer | null = null;
		try {
			wal = fs.readFileSync(`${dbPath}-wal`);
		} catch {
			// Rekordbox is closed: everything is in the main file
		}
		if (databaseStamp(dbPath) !== before && attempt < 2) continue;
		plain = decryptDatabase(withPendingChanges(db, wal));
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dj-rb-"));
	try {
		const file = path.join(dir, "library.db");
		fs.writeFileSync(file, plain!, { mode: 0o600 });
		const sql =
			"select c.AnalysisDataPath as dat, q.InMsec as ms, q.Kind as kind from djmdCue q join djmdContent c on c.ID = q.ContentID " +
			"where coalesce(q.rb_local_deleted, 0) = 0 and coalesce(c.rb_local_deleted, 0) = 0 and q.InMsec >= 0 and q.Kind >= 0 and c.AnalysisDataPath is not null order by q.InMsec, q.Kind";
		const r = spawnSync(SQLITE, ["-readonly", "-json", file, sql], { encoding: "utf8", maxBuffer: 1 << 28 });
		if (r.status !== 0) throw new Error(`Rekordbox database could not be read: ${(r.stderr || String(r.error ?? "")).trim()}`);
		const rows = r.stdout.trim() ? (JSON.parse(r.stdout) as { dat: string; ms: number; kind: number }[]) : [];
		const out: Record<string, LibraryCue[]> = {};
		for (const row of rows) {
			// Hot cue kinds skip 4: A, B, C are 1 to 3 and D onward start at 5.
			if (typeof row.dat !== "string" || !Number.isFinite(row.ms) || !Number.isInteger(row.kind) || row.kind === 4) continue;
			(out[datKey(row.dat)] ??= []).push({ ms: row.ms, kind: row.kind > 4 ? row.kind - 1 : row.kind });
		}
		return out;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
