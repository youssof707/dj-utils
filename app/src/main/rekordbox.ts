// Reads Rekordbox's analysis files. Rekordbox keeps one folder per analysed track with an
// ANLZ0000.DAT (the track's file name and beat grid) and an ANLZ0000.EXT (the detailed
// waveform Rekordbox drew from its own decode of the file).
//
// Cue points are not in those files: they are read from Rekordbox's database (a copy of it,
// never the file Rekordbox has open). Adding and deleting cues is the one thing that writes
// to Rekordbox: straight into its database, see `changeCues`. Nothing here talks to
// Rekordbox itself. A scan turns the .DAT files into a small
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
import { HOT_CUES, SAMPLE_RATE, type CueRow, type RekordboxGrid, type RekordboxLibrary, type RekordboxPlaylist, APP_TAG_GROUP, type RekordboxTag, type RekordboxTrack, type TagChange, type TagChangeResult } from "../shared/planner";
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
// are the hot cues A, B, C... `id` is its row in the database; a loop also has an end.
export type LibraryCue = { id: string; ms: number; kind: number; loop: boolean };
// Every track's cues, and the track's own row, by analysis file (see `datKey`).
// `cues` and `contents` by analysis; `unanalysed` the cues of tracks Rekordbox has not
// analysed yet (edits added from here), by where the file is.
export type CueLibrary = { cues: Record<string, LibraryCue[]>; contents: Record<string, { id: string; uuid: string }>; unanalysed: Record<string, LibraryCue[]> };

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

// The database as it is now, changes still waiting beside it included. Still encrypted.
function readEncrypted(dbPath: string): Buffer {
	// Rekordbox may be writing while we read: take the two files again if either changed.
	for (let attempt = 0; ; attempt++) {
		const before = databaseStamp(dbPath);
		const db = fs.readFileSync(dbPath);
		let wal: Buffer | null = null;
		try {
			wal = fs.readFileSync(`${dbPath}-wal`);
		} catch {
			// Rekordbox is closed: everything is in the main file
		}
		if (databaseStamp(dbPath) === before || attempt >= 2) return withPendingChanges(db, wal);
	}
}

// The rows each query gives, read from a plain copy of the database that is deleted again
// straight away. Never touches the files Rekordbox has open.
// A query given as `{ optional }` gives no rows instead of failing, for tables that not
// every database has.
function queryDatabase(dbPath: string, sqls: (string | { optional: string })[]): Record<string, unknown>[][] {
	const plain = decryptDatabase(readEncrypted(dbPath));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dj-rb-"));
	try {
		const file = path.join(dir, "library.db");
		fs.writeFileSync(file, plain, { mode: 0o600 });
		return sqls.map((q) => {
			const sql = typeof q === "string" ? q : q.optional;
			const r = spawnSync(SQLITE, ["-readonly", "-json", file, sql], { encoding: "utf8", maxBuffer: 1 << 28 });
			if (r.status !== 0 && typeof q !== "string") return [];
			if (r.status !== 0) throw new Error(`Rekordbox database could not be read: ${(r.stderr || String(r.error ?? "")).trim()}`);
			return r.stdout.trim() ? (JSON.parse(r.stdout) as Record<string, unknown>[]) : [];
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// In the database hot cue kinds skip 4: A, B, C are 1 to 3 and D onward start at 5.
export const rawKind = (kind: number): number => (kind >= 4 ? kind + 1 : kind);
const appKind = (raw: number): number => (raw > 4 ? raw - 1 : raw);

// The cue a database row holds, or null for a row that is not a cue we show.
export function cueOfRow(row: Record<string, unknown>): LibraryCue | null {
	const ms = row["InMsec"];
	const kind = row["Kind"];
	const id = row["ID"];
	if ((typeof id !== "string" && typeof id !== "number") || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
	if (typeof kind !== "number" || !Number.isInteger(kind) || kind < 0 || kind === 4) return null;
	const out = row["OutMsec"];
	return { id: String(id), ms, kind: appKind(kind), loop: typeof out === "number" && out >= 0 };
}

const cueOrder = (a: LibraryCue, b: LibraryCue): number => a.ms - b.ms || a.kind - b.kind;

// A track's cues after a change to them, in time order.
export function cuesAfter(cues: LibraryCue[], removed: CueRow[], added: CueRow[]): LibraryCue[] {
	const gone = new Set([...removed, ...added].map((r) => String(r["ID"])));
	const more = added.map(cueOfRow).filter((c): c is LibraryCue => c !== null);
	return [...cues.filter((c) => !gone.has(c.id)), ...more].sort(cueOrder);
}

// Every track's cue points in time order, and which row each analysed track is.
export function readCues(dbPath: string): CueLibrary {
	const analysed = "coalesce(c.AnalysisDataPath, '') <> ''";
	const [cueRows, contentRows, newRows] = queryDatabase(dbPath, [
		'select c.AnalysisDataPath as dat, q.ID as "ID", q.InMsec as "InMsec", q.OutMsec as "OutMsec", q.Kind as "Kind" from djmdCue q join djmdContent c on c.ID = q.ContentID ' +
			`where coalesce(q.rb_local_deleted, 0) = 0 and coalesce(c.rb_local_deleted, 0) = 0 and q.InMsec >= 0 and q.Kind >= 0 and ${analysed} order by q.InMsec, q.Kind`,
		`select c.AnalysisDataPath as dat, c.ID as id, c.UUID as uuid from djmdContent c where coalesce(c.rb_local_deleted, 0) = 0 and ${analysed}`,
		{
			optional:
				'select c.FolderPath as path, q.ID as "ID", q.InMsec as "InMsec", q.OutMsec as "OutMsec", q.Kind as "Kind" from djmdCue q join djmdContent c on c.ID = q.ContentID ' +
				`where coalesce(q.rb_local_deleted, 0) = 0 and coalesce(c.rb_local_deleted, 0) = 0 and q.InMsec >= 0 and q.Kind >= 0 and not ${analysed} and c.FolderPath is not null order by q.InMsec, q.Kind`,
		},
	]);
	const out: CueLibrary = { cues: {}, contents: {}, unanalysed: {} };
	for (const row of cueRows) {
		const cue = cueOfRow(row);
		if (typeof row["dat"] === "string" && cue) (out.cues[datKey(row["dat"])] ??= []).push(cue);
	}
	for (const row of contentRows) {
		const id = text(row["id"]);
		if (typeof row["dat"] === "string" && id) out.contents[datKey(row["dat"])] = { id, uuid: text(row["uuid"]) };
	}
	for (const row of newRows) {
		const cue = cueOfRow(row);
		if (typeof row["path"] === "string" && cue) (out.unanalysed[path.resolve(row["path"]).normalize("NFC")] ??= []).push(cue);
	}
	return out;
}

// ---- changing cue points ------------------------------------------------------------

// The columns of a cue's row. Rekordbox's cue table has to have exactly these, or nothing
// is written: a table that has changed is one we no longer know how to fill in.
export const CUE_COLUMNS = [
	"ID", "ContentID", "InMsec", "InFrame", "InMpegFrame", "InMpegAbs", "OutMsec", "OutFrame", "OutMpegFrame", "OutMpegAbs", "Kind", "Color", "ColorTableIndex", "ActiveLoop", "Comment",
	"BeatLoopSize", "CueMicrosec", "InPointSeekInfo", "OutPointSeekInfo", "ContentUUID", "UUID", "rb_data_status", "rb_local_data_status", "rb_local_deleted", "rb_local_synced", "usn",
	"rb_local_usn", "created_at", "updated_at",
]; // prettier-ignore

// What to do to one track's cues, in this order: take out the rows with these ids and
// whatever sits in these hot cue slots, then put these rows in. A row whose id is already
// there, or whose hot cue slot is taken, is left out.
export type CueChangeJob = { contentId: string; remove: string[]; clear: number[]; insert: CueRow[] };
// The whole rows that went and came, so either can be put back exactly.
export type CueChangeResult = { removed: CueRow[]; added: CueRow[] };

const stampNow = (): string => new Date().toISOString().replace("T", " ").replace("Z", " +00:00");

// The row Rekordbox itself writes for a new cue at this time (on its clock).
export function newCueRow(content: { id: string; uuid: string }, ms: number, kind: number): CueRow {
	const at = stampNow();
	const row: CueRow = Object.fromEntries(CUE_COLUMNS.map((c) => [c, null]));
	return {
		...row,
		ID: String(crypto.randomInt(1, 0xffffffff)),
		ContentID: content.id,
		InMsec: ms,
		InFrame: Math.round(ms * 0.15), // 150 frames a second
		InMpegFrame: 0,
		InMpegAbs: 0,
		OutMsec: -1,
		OutFrame: 0,
		OutMpegFrame: 0,
		OutMpegAbs: 0,
		Kind: rawKind(kind),
		Color: -1,
		ContentUUID: content.uuid || null,
		UUID: crypto.randomUUID(),
		rb_data_status: 0,
		rb_local_data_status: 0,
		rb_local_deleted: 0,
		rb_local_synced: 0,
		created_at: at,
		updated_at: at,
	};
}

function sqlValue(v: unknown): string {
	if (v === null || v === undefined) return "NULL";
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
	throw new Error("A cue could not be written: unexpected value");
}

// A copy of the database as it was before this app first wrote to it, kept beside it.
// Returns where it is. Throws when it cannot be made, and then nothing may be written.
export function backupDatabase(dbPath: string): string {
	const to = path.join(path.dirname(dbPath), "master.before-dj-utilities.db");
	if (fs.existsSync(to)) return to;
	const part = `${to}.${process.pid}.part`;
	try {
		fs.writeFileSync(part, readEncrypted(dbPath), { mode: 0o600 });
		fs.renameSync(part, to);
	} finally {
		fs.rmSync(part, { force: true });
	}
	return to;
}

// Changes cue rows in Rekordbox's database itself, in one step that either happens whole
// or not at all. `bin` is the sqlcipher program, which takes its turn with Rekordbox the
// way any two programs sharing an SQLite file do.
export function changeCues(bin: string, dbPath: string, job: CueChangeJob): CueChangeResult {
	for (const row of job.insert) if (row["ContentID"] !== job.contentId) throw new Error("A cue could not be written: it belongs to another track");
	const content = sqlValue(job.contentId);
	const cols = CUE_COLUMNS.map((c) => `"${c}"`).join(", ");
	const whole = `json_group_array(json_object(${CUE_COLUMNS.map((c) => `'${c}', "${c}"`).join(", ")}))`;
	const live = "coalesce(rb_local_deleted, 0) = 0";
	const going = [
		job.remove.length ? `ID in (${job.remove.map(sqlValue).join(", ")})` : "",
		job.clear.length ? `(Kind in (${job.clear.map((k) => sqlValue(rawKind(k))).join(", ")}) and ${live})` : "",
	].filter(Boolean);
	const lines = [
		`PRAGMA key = '${DB_KEY}';`,
		"PRAGMA cipher_compatibility = 4;",
		"PRAGMA busy_timeout = 3000;",
		"PRAGMA wal_autocheckpoint = 0;", // folding changes into the main file is left to Rekordbox
		// Stops here, before anything is changed, when the table is not the one we know.
		"create temp table dj_check (ok integer, constraint cue_table_changed check (ok));",
		`insert into dj_check select (select group_concat(name, ',') from (select name from pragma_table_info('djmdCue') order by cid)) = ${sqlValue(CUE_COLUMNS.join(","))};`,
		"BEGIN IMMEDIATE;",
	];
	if (going.length) {
		const where = `ContentID = ${content} and (${going.join(" or ")})`;
		lines.push(`select 'DJ:removed:' || ${whole} from djmdCue where ${where};`, `delete from djmdCue where ${where};`);
	}
	for (const row of job.insert) {
		const kind = row["Kind"];
		const free = typeof kind === "number" && kind > 0 ? ` and not exists (select 1 from djmdCue where ContentID = ${content} and Kind = ${sqlValue(kind)} and ${live})` : "";
		lines.push(`insert into djmdCue (${cols}) select ${CUE_COLUMNS.map((c) => sqlValue(row[c])).join(", ")} where not exists (select 1 from djmdCue where ID = ${sqlValue(row["ID"])})${free};`);
	}
	if (job.insert.length) lines.push(`select 'DJ:added:' || ${whole} from djmdCue where ContentID = ${content} and ID in (${job.insert.map((r) => sqlValue(r["ID"])).join(", ")});`);
	lines.push("COMMIT;");

	const r = spawnSync(bin, ["-batch", "-bail", dbPath], { input: lines.join("\n"), encoding: "utf8", maxBuffer: 1 << 26 });
	if (r.status !== 0) {
		const said = (r.stderr || String(r.error ?? "")).trim();
		if (/cue_table_changed/.test(said)) throw new Error("This version of Rekordbox is not supported for changing cues yet");
		if (/locked|busy/i.test(said)) throw new Error("Rekordbox is busy with its library. Try again in a moment");
		throw new Error(`Rekordbox's database could not be changed: ${said.split("\n").pop()}`);
	}
	const rows = (tag: string): CueRow[] => {
		const line = r.stdout.split("\n").find((l) => l.startsWith(`DJ:${tag}:`));
		return line ? (JSON.parse(line.slice(tag.length + 4)) as CueRow[]) : [];
	};
	return { removed: rows("removed"), added: rows("added") };
}

// ---- changing My Tags ---------------------------------------------------------------

// The columns of Rekordbox's tag tables; as with cues, a table that has changed is not written.
export const TAG_COLUMNS = ["ID", "Seq", "Name", "Attribute", "ParentID", "UUID", "rb_data_status", "rb_local_data_status", "rb_local_deleted", "rb_local_synced", "usn", "rb_local_usn", "created_at", "updated_at"];
export const SONG_TAG_COLUMNS = ["ID", "MyTagID", "ContentID", "TrackNo", "UUID", "rb_data_status", "rb_local_data_status", "rb_local_deleted", "rb_local_synced", "usn", "rb_local_usn", "created_at", "updated_at"];

const newRowId = (): string => String(crypto.randomInt(1, 0xffffffff));

// Gives a track exactly the app tags `job` asks for, in one step that happens whole or not
// at all: app tags it should no longer have are taken off, new tags are made in the
// APP_TAG_GROUP category (made first if missing; a tag of the same name there is used
// instead), and the rest are put on. The track's other My Tags are not touched. Doing it
// twice changes nothing.
export function changeTags(bin: string, dbPath: string, job: TagChange): TagChangeResult {
	const c = sqlValue(job.contentId);
	const at = sqlValue(stampNow());
	const live = (t: string): string => `coalesce(${t}.rb_local_deleted, 0) = 0`;
	const columns = (table: string, cols: string[]): string =>
		`insert into dj_check select (select group_concat(name, ',') from (select name from pragma_table_info('${table}') order by cid)) = ${sqlValue(cols.join(","))};`;
	const keep = [...new Set(job.keep.filter((id) => typeof id === "string" && id))];
	const create = [...new Set(job.create.map((t) => String(t?.name ?? "").trim().slice(0, 255)).filter(Boolean))];
	// the app's category, as SQL
	const g = "(select id from dj_group limit 1)";
	const ours = `(select t.ID from djmdMyTag t where t.ParentID = ${g} and t.Attribute = 0)`;
	const made: string[] = [];
	const lines = [
		`PRAGMA key = '${DB_KEY}';`,
		"PRAGMA cipher_compatibility = 4;",
		"PRAGMA busy_timeout = 3000;",
		"PRAGMA wal_autocheckpoint = 0;",
		"create temp table dj_check (ok integer, constraint tag_table_changed check (ok));",
		columns("djmdMyTag", TAG_COLUMNS),
		columns("djmdSongMyTag", SONG_TAG_COLUMNS),
		"create temp table dj_track (ok integer, constraint track_missing check (ok));",
		`insert into dj_track select exists (select 1 from djmdContent c where c.ID = ${c} and ${live("c")});`,
		"create temp table dj_want (n integer, id text);",
		"create temp table dj_group (id text);",
		"BEGIN IMMEDIATE;",
		`insert into dj_group select t.ID from djmdMyTag t where t.ParentID = 'root' and t.Attribute = 1 and ${live("t")} and trim(t.Name) = ${sqlValue(APP_TAG_GROUP)} order by t.Seq, t.ID limit 1;`,
	];
	if (create.length) {
		const id = sqlValue(newRowId());
		lines.push(
			`insert into djmdMyTag (${TAG_COLUMNS.map((x) => `"${x}"`).join(", ")}) select ${id}, coalesce((select max(t.Seq) from djmdMyTag t where t.ParentID = 'root' and ${live("t")}), 0) + 1, ${sqlValue(APP_TAG_GROUP)}, 1, 'root', ${sqlValue(crypto.randomUUID())}, 0, 0, 0, 0, NULL, NULL, ${at}, ${at} ` +
				`where not exists (select 1 from dj_group) and not exists (select 1 from djmdMyTag where ID = ${id});`,
			`insert into dj_group select ID from djmdMyTag where ID = ${id} and not exists (select 1 from dj_group);`,
		);
	}
	let n = 0;
	for (const id of keep) lines.push(`insert into dj_want select ${n++}, t.ID from djmdMyTag t where t.ID = ${sqlValue(id)} and t.ParentID = ${g} and t.Attribute = 0 and ${live("t")};`);
	for (const name of create) {
		const id = newRowId();
		made.push(id);
		const same = `t.ParentID = ${g} and t.Attribute = 0 and ${live("t")} and lower(trim(t.Name)) = lower(${sqlValue(name)})`;
		lines.push(
			`insert into djmdMyTag (${TAG_COLUMNS.map((x) => `"${x}"`).join(", ")}) select ${sqlValue(id)}, coalesce((select max(t.Seq) from djmdMyTag t where t.ParentID = ${g} and ${live("t")}), 0) + 1, ${sqlValue(name)}, 0, ${g}, ${sqlValue(crypto.randomUUID())}, 0, 0, 0, 0, NULL, NULL, ${at}, ${at} ` +
				`where exists (select 1 from dj_group) and not exists (select 1 from djmdMyTag t where ${same}) and not exists (select 1 from djmdMyTag where ID = ${sqlValue(id)});`,
			`insert into dj_want select ${n++}, t.ID from djmdMyTag t where ${same} order by t.Seq, t.ID limit 1;`,
		);
	}
	lines.push(`delete from djmdSongMyTag where ContentID = ${c} and MyTagID in ${ours} and MyTagID not in (select id from dj_want);`);
	for (let i = 0; i < n; i++) {
		const id = sqlValue(newRowId());
		lines.push(
			`insert into djmdSongMyTag (${SONG_TAG_COLUMNS.map((x) => `"${x}"`).join(", ")}) select ${id}, w.id, ${c}, coalesce((select max(s.TrackNo) from djmdSongMyTag s where s.MyTagID = w.id and ${live("s")}), 0) + 1, ${sqlValue(crypto.randomUUID())}, 0, 0, 0, 0, NULL, NULL, ${at}, ${at} ` +
				`from dj_want w where w.n = ${i} and not exists (select 1 from djmdSongMyTag s where s.ContentID = ${c} and s.MyTagID = w.id and ${live("s")}) and not exists (select 1 from djmdSongMyTag where ID = ${id});`,
		);
	}
	lines.push(`select 'DJ:tags:' || json_group_array(MyTagID) from (select s.MyTagID from djmdSongMyTag s where s.ContentID = ${c} and s.MyTagID in ${ours} and ${live("s")} order by s.ID);`);
	if (made.length) lines.push(`select 'DJ:created:' || json_group_array(json_object('id', ID, 'name', Name)) from djmdMyTag where ID in (${made.map(sqlValue).join(", ")});`);
	lines.push("COMMIT;");

	const r = spawnSync(bin, ["-batch", "-bail", dbPath], { input: lines.join("\n"), encoding: "utf8", maxBuffer: 1 << 26 });
	if (r.status !== 0) {
		const said = (r.stderr || String(r.error ?? "")).trim();
		if (/tag_table_changed|no such table/.test(said)) throw new Error("This version of Rekordbox is not supported for changing tags yet");
		if (/track_missing/.test(said)) throw new Error("This track is no longer in Rekordbox");
		if (/locked|busy/i.test(said)) throw new Error("Rekordbox is busy with its library. Try again in a moment");
		throw new Error(`Rekordbox's database could not be changed: ${said.split("\n").pop()}`);
	}
	const out = <T>(tag: string): T[] => {
		const line = r.stdout.split("\n").find((l) => l.startsWith(`DJ:${tag}:`));
		return line ? (JSON.parse(line.slice(tag.length + 4)) as T[]) : [];
	};
	return {
		tags: out<unknown>("tags").map(String),
		created: out<{ id: unknown; name: unknown }>("created").map((t) => ({ id: String(t.id), name: String(t.name) })),
	};
}

// ---- writing playlists --------------------------------------------------------------

// The columns of Rekordbox's playlist tables; as with cues, a table that has changed is not written.
export const PLAYLIST_COLUMNS = ["ID", "Seq", "Name", "ImagePath", "Attribute", "ParentID", "SmartList", "UUID", "rb_data_status", "rb_local_data_status", "rb_local_deleted", "rb_local_synced", "usn", "rb_local_usn", "created_at", "updated_at"];
export const SONG_PLAYLIST_COLUMNS = ["ID", "PlaylistID", "ContentID", "TrackNo", "UUID", "rb_data_status", "rb_local_data_status", "rb_local_deleted", "rb_local_synced", "usn", "rb_local_usn", "created_at", "updated_at"];

// Runs one change to the playlist tables, whole or not at all, and gives back what it printed.
function writePlaylists(bin: string, dbPath: string, checks: string[], steps: string[]): string {
	const columns = (table: string, cols: string[]): string =>
		`insert into dj_check select (select group_concat(name, ',') from (select name from pragma_table_info('${table}') order by cid)) = ${sqlValue(cols.join(","))};`;
	const lines = [
		`PRAGMA key = '${DB_KEY}';`,
		"PRAGMA cipher_compatibility = 4;",
		"PRAGMA busy_timeout = 3000;",
		"PRAGMA wal_autocheckpoint = 0;",
		"create temp table dj_check (ok integer, constraint playlist_table_changed check (ok));",
		columns("djmdPlaylist", PLAYLIST_COLUMNS),
		columns("djmdSongPlaylist", SONG_PLAYLIST_COLUMNS),
		...checks,
		"BEGIN IMMEDIATE;",
		...steps,
		"COMMIT;",
	];
	const r = spawnSync(bin, ["-batch", "-bail", dbPath], { input: lines.join("\n"), encoding: "utf8", maxBuffer: 1 << 26 });
	if (r.status !== 0) {
		const said = (r.stderr || String(r.error ?? "")).trim();
		if (/playlist_table_changed|no such table/.test(said)) throw new Error("This version of Rekordbox is not supported for writing playlists yet");
		if (/playlist_missing/.test(said)) throw new Error("This playlist is no longer in Rekordbox");
		if (/locked|busy/i.test(said)) throw new Error("Rekordbox is busy with its library. Try again in a moment");
		throw new Error(`Rekordbox's database could not be changed: ${said.split("\n").pop()}`);
	}
	return r.stdout;
}

const printed = <T>(out: string, tag: string): T | null => {
	const line = out.split("\n").find((l) => l.startsWith(`DJ:${tag}:`));
	return line ? (JSON.parse(line.slice(tag.length + 4)) as T) : null;
};

// Rekordbox also lists its playlists in masterPlaylists6.xml beside the database, by id in
// hex, each with the time it last changed. A playlist made here is added to it and one
// filled here gets a new time, the way Rekordbox does it itself. Left alone when the file
// is not there or not one we know.
export function notePlaylist(dbPath: string, id: string, isNew: boolean): void {
	const file = path.join(path.dirname(dbPath), "masterPlaylists6.xml");
	const no = Number(id);
	if (!/^\d+$/.test(id) || !Number.isSafeInteger(no)) return;
	const hex = no.toString(16).toUpperCase();
	try {
		const xml = fs.readFileSync(file, "utf8");
		const node = new RegExp(`(<NODE Id="${hex}"[^>]*?Timestamp=")\\d+(")`, "i");
		let next: string;
		if (node.test(xml)) next = xml.replace(node, `$1${Date.now()}$2`);
		else if (isNew && xml.includes("</PLAYLISTS>")) next = xml.replace("</PLAYLISTS>", `  <NODE Id="${hex}" ParentId="0" Attribute="0" Timestamp="${Date.now()}" Lib_Type="0" CheckType="0"/>\n  </PLAYLISTS>`);
		else return;
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, next);
		fs.renameSync(tmp, file);
	} catch {
		// no such file: the database alone holds the playlist
	}
}

// Makes an empty playlist at the top level of Rekordbox's playlists, after the others.
export function createPlaylist(bin: string, dbPath: string, name: string): RekordboxPlaylist {
	const want = name.trim().slice(0, 255);
	if (!want) throw new Error("A playlist needs a name");
	const id = sqlValue(newRowId());
	const at = sqlValue(stampNow());
	const out = writePlaylists(
		bin,
		dbPath,
		[],
		[
			`insert into djmdPlaylist (${PLAYLIST_COLUMNS.map((x) => `"${x}"`).join(", ")}) select ${id}, coalesce((select max(p.Seq) from djmdPlaylist p where p.ParentID = 'root' and coalesce(p.rb_local_deleted, 0) = 0), 0) + 1, ${sqlValue(want)}, NULL, 0, 'root', NULL, ${sqlValue(crypto.randomUUID())}, 0, 0, 0, 0, NULL, NULL, ${at}, ${at} ` +
				`where not exists (select 1 from djmdPlaylist where ID = ${id});`,
			`select 'DJ:playlist:' || json_object('id', ID, 'name', Name) from djmdPlaylist where ID = ${id};`,
		],
	);
	const made = printed<{ id: unknown; name: unknown }>(out, "playlist");
	if (!made) throw new Error("The playlist was not made. Try again");
	notePlaylist(dbPath, String(made.id), true);
	return { id: String(made.id), name: String(made.name), tracks: [] };
}

// Makes the playlist hold exactly these tracks, in this order: whatever it held before is
// taken out. Tracks no longer in Rekordbox are left out. Gives back what it holds now.
export function fillPlaylist(bin: string, dbPath: string, playlistId: string, tracks: string[]): string[] {
	const p = sqlValue(playlistId);
	const at = sqlValue(stampNow());
	const live = (t: string): string => `coalesce(${t}.rb_local_deleted, 0) = 0`;
	const steps = [`delete from djmdSongPlaylist where PlaylistID = ${p};`];
	for (const c of [...new Set(tracks.filter((t) => typeof t === "string" && t))]) {
		const id = sqlValue(crypto.randomUUID());
		steps.push(
			`insert into djmdSongPlaylist (${SONG_PLAYLIST_COLUMNS.map((x) => `"${x}"`).join(", ")}) select ${id}, ${p}, c.ID, (select count(*) from djmdSongPlaylist s where s.PlaylistID = ${p}) + 1, ${sqlValue(crypto.randomUUID())}, 0, 0, 0, 0, NULL, NULL, ${at}, ${at} ` +
				`from djmdContent c where c.ID = ${sqlValue(c)} and ${live("c")} and not exists (select 1 from djmdSongPlaylist where ID = ${id});`,
		);
	}
	steps.push(`update djmdPlaylist set updated_at = ${at} where ID = ${p};`, `select 'DJ:tracks:' || json_group_array(ContentID) from (select s.ContentID from djmdSongPlaylist s where s.PlaylistID = ${p} order by s.TrackNo);`);
	const out = writePlaylists(
		bin,
		dbPath,
		[
			"create temp table dj_list (ok integer, constraint playlist_missing check (ok));",
			`insert into dj_list select exists (select 1 from djmdPlaylist l where l.ID = ${p} and l.Attribute = 0 and ${live("l")} and coalesce(l.SmartList, '') = '');`,
		],
		steps,
	);
	notePlaylist(dbPath, playlistId, false);
	return (printed<unknown[]>(out, "tracks") ?? []).map(String);
}

// ---- adding tracks to the collection --------------------------------------------------

// A file to put in Rekordbox's collection, with what is known of it without decoding it.
export type NewTrack = { path: string; size: number; seconds: number; bpm: number; sampleRate: number; bits: number; channels: number; cues?: { sec: number; kind: number }[] };

// Rekordbox's number for each kind of file.
const FILE_TYPES: Record<string, number> = { mp3: 1, m4a: 4, aac: 4, flac: 5, wav: 11, aif: 12, aiff: 12 };

// The columns of djmdContent a new track fills in; the rest keep their defaults.
const NEW_CONTENT_COLUMNS = ["ID", "FolderPath", "FileNameL", "FileNameS", "Title", "BPM", "Length", "TrackNo", "BitRate", "BitDepth", "Commnt", "FileType", "Rating", "ReleaseYear", "StockDate", "ColorID", "DJPlayCount", "ImagePath", "MasterDBID", "MasterSongID", "AnalysisDataPath", "SearchStr", "FileSize", "DiscNo", "SampleRate", "Analysed", "DateCreated", "ContentLink", "HotCueAutoLoad", "DeliveryControl", "AnalysisUpdated", "TrackInfoUpdated", "SamplerTrackInfo", "SamplerPlayOffset", "SamplerGain", "VideoAssociate", "LyricStatus", "ServiceID", "rb_file_id", "DeviceID", "UUID", "rb_data_status", "rb_local_data_status", "rb_local_deleted", "rb_local_synced", "rb_local_usn", "created_at", "updated_at"];

// Puts these files in Rekordbox's collection the way Rekordbox does when a file is dragged
// in, before it has analysed it: Rekordbox analyses them when they are first loaded. Each
// gets its `cues` (on the file's own clock, which is Rekordbox's for a WAV). A file it
// already has (by where it is) is not added again, nor given cues. Gives back each file's
// track id.
export function addTracks(bin: string, dbPath: string, tracks: NewTrack[]): Record<string, string> {
	const at = sqlValue(stampNow());
	const day = sqlValue(new Date().toISOString().slice(0, 10));
	const live = "coalesce(rb_local_deleted, 0) = 0";
	const lines = [
		`PRAGMA key = '${DB_KEY}';`,
		"PRAGMA cipher_compatibility = 4;",
		"PRAGMA busy_timeout = 3000;",
		"PRAGMA wal_autocheckpoint = 0;",
		"create temp table dj_check (ok integer, constraint content_table_changed check (ok));",
		`insert into dj_check select (select count(*) from pragma_table_info('djmdContent') where name in (${NEW_CONTENT_COLUMNS.map(sqlValue).join(", ")})) = ${NEW_CONTENT_COLUMNS.length};`,
		"insert into dj_check select exists (select 1 from agentRegistry where registry_id = 'localUpdateCount');",
		`insert into dj_check select (select group_concat(name, ',') from (select name from pragma_table_info('djmdCue') order by cid)) = ${sqlValue(CUE_COLUMNS.join(","))};`,
		"BEGIN IMMEDIATE;",
	];
	const paths: string[] = [];
	for (const t of tracks) {
		if (paths.includes(t.path)) continue;
		paths.push(t.path);
		const ext = path.extname(t.path).slice(1).toLowerCase();
		const name = path.basename(t.path);
		const id = newRowId();
		const uuid = crypto.randomUUID();
		const where = `FolderPath = ${sqlValue(t.path)} and ${live}`;
		const usn = "(select cast(int_1 as integer) + 1 from agentRegistry where registry_id = 'localUpdateCount')";
		const values: Record<string, string> = {
			ID: sqlValue(id),
			FolderPath: sqlValue(t.path),
			FileNameL: sqlValue(name),
			FileNameS: "''",
			Title: sqlValue(name.replace(/\.[^.]+$/, "")),
			BPM: String(Math.round(t.bpm > 0 ? t.bpm * 100 : 0)),
			Length: String(Math.round(t.seconds)),
			TrackNo: "0",
			BitRate: String(Math.round((t.sampleRate * t.bits * t.channels) / 1000)),
			BitDepth: String(t.bits),
			Commnt: "''",
			FileType: String(FILE_TYPES[ext] ?? 0),
			Rating: "0",
			ReleaseYear: "0",
			StockDate: day,
			ColorID: "0",
			DJPlayCount: "0",
			ImagePath: "''",
			MasterDBID: "(select DBID from djmdProperty limit 1)",
			MasterSongID: sqlValue(id),
			AnalysisDataPath: "''",
			SearchStr: "''",
			FileSize: String(t.size),
			DiscNo: "0",
			SampleRate: String(t.sampleRate),
			Analysed: "0",
			DateCreated: day,
			ContentLink: `(select ContentLink from djmdContent where ${live} order by created_at desc limit 1)`,
			HotCueAutoLoad: "'on'",
			DeliveryControl: "'on'",
			AnalysisUpdated: "0",
			TrackInfoUpdated: "0",
			SamplerTrackInfo: "0",
			SamplerPlayOffset: "0",
			SamplerGain: "0.0",
			VideoAssociate: "0",
			LyricStatus: "0",
			ServiceID: "0",
			rb_file_id: sqlValue(newRowId()),
			DeviceID: `(select DeviceID from djmdContent where ${live} and DeviceID is not null order by created_at desc limit 1)`,
			UUID: sqlValue(uuid),
			rb_data_status: "0",
			rb_local_data_status: "0",
			rb_local_deleted: "0",
			rb_local_synced: "0",
			rb_local_usn: usn,
			created_at: at,
			updated_at: at,
		};
		lines.push(
			`insert into djmdContent (${NEW_CONTENT_COLUMNS.map((c) => `"${c}"`).join(", ")}) select ${NEW_CONTENT_COLUMNS.map((c) => values[c]).join(", ")} ` +
				`where not exists (select 1 from djmdContent where ${where}) and not exists (select 1 from djmdContent where ID = ${sqlValue(id)});`,
			`update agentRegistry set int_1 = cast(int_1 as integer) + 1, updated_at = ${at} where registry_id = 'localUpdateCount' and changes() > 0;`,
		);
		// only onto the row made just now: its id is new
		const made = `exists (select 1 from djmdContent where ID = ${sqlValue(id)} and UUID = ${sqlValue(uuid)})`;
		for (const c of t.cues ?? []) {
			if (!Number.isFinite(c.sec) || c.sec < 0 || !Number.isInteger(c.kind) || c.kind < 0 || c.kind > HOT_CUES) continue;
			const row = newCueRow({ id, uuid }, Math.round(c.sec * 1000), c.kind);
			lines.push(`insert into djmdCue (${CUE_COLUMNS.map((x) => `"${x}"`).join(", ")}) select ${CUE_COLUMNS.map((x) => sqlValue(row[x])).join(", ")} where ${made} and not exists (select 1 from djmdCue where ID = ${sqlValue(row["ID"])});`);
		}
	}
	lines.push(`select 'DJ:ids:' || json_group_object(FolderPath, ID) from djmdContent where ${live} and FolderPath in (${paths.length ? paths.map(sqlValue).join(", ") : "NULL"});`, "COMMIT;");

	const r = spawnSync(bin, ["-batch", "-bail", dbPath], { input: lines.join("\n"), encoding: "utf8", maxBuffer: 1 << 26 });
	if (r.status !== 0) {
		const said = (r.stderr || String(r.error ?? "")).trim();
		if (/content_table_changed|no such table/.test(said)) throw new Error("This version of Rekordbox is not supported for adding tracks yet");
		if (/locked|busy/i.test(said)) throw new Error("Rekordbox is busy with its library. Try again in a moment");
		throw new Error(`Rekordbox's database could not be changed: ${said.split("\n").pop()}`);
	}
	const ids = printed<Record<string, unknown>>(r.stdout, "ids") ?? {};
	return Object.fromEntries(Object.entries(ids).map(([p, id]) => [p, String(id)]));
}

// ---- tracks and playlists -----------------------------------------------------------

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// A key the way DJs sort it: "8A" stays, "Am" becomes "8A", "C" becomes "8B". Null for
// anything that is not a key we know.
export function camelot(name: string): { key: string; order: number } | null {
	const written = name.trim();
	let no: number;
	let minor: boolean;
	const wheel = /^(\d{1,2})([AB])$/i.exec(written);
	if (wheel) {
		no = Number(wheel[1]);
		minor = wheel[2].toUpperCase() === "A";
		if (no < 1 || no > 12) return null;
	} else {
		const note = /^([A-G])([#♯b♭]?)\s*(m|min|minor|maj|major)?$/i.exec(written);
		if (!note) return null;
		minor = /^m(in|inor)?$/i.test(note[3] ?? "");
		const pitch = PITCH[note[1].toUpperCase()] + (note[2] === "" ? 0 : note[2] === "#" || note[2] === "♯" ? 1 : -1);
		// a minor key sits with the major key three semitones up; fifths go round the wheel from C at 8
		no = ((((pitch + (minor ? 3 : 0) + 12) % 12) * 7 + 7) % 12) + 1;
	}
	return { key: `${no}${minor ? "A" : "B"}`, order: (no - 1) * 2 + (minor ? 0 : 1) };
}

const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Every track and playlist in Rekordbox. Smart playlists are left out: Rekordbox stores
// their rules, not their tracks.
export function readLibrary(dbPath: string): RekordboxLibrary {
	const live = (t: string): string => `coalesce(${t}.rb_local_deleted, 0) = 0`;
	const [trackRows, listRows, memberRows, tagRows, songTagRows] = queryDatabase(dbPath, [
		"select c.ID as id, c.Title as title, a.Name as artist, c.BPM as bpm, k.ScaleName as key, c.Length as length, c.FolderPath as path " +
			`from djmdContent c left join djmdArtist a on a.ID = c.ArtistID left join djmdKey k on k.ID = c.KeyID where ${live("c")} order by c.created_at, c.ID`,
		`select p.ID as id, p.Name as name, p.ParentID as parent, p.Attribute as kind from djmdPlaylist p where ${live("p")} order by p.Seq, p.ID`,
		`select s.PlaylistID as list, s.ContentID as track from djmdSongPlaylist s where ${live("s")} order by s.TrackNo, s.ID`,
		// My Tags: not in every database
		{ optional: `select t.ID as id, t.Name as name, t.ParentID as parent, t.Attribute as kind from djmdMyTag t where ${live("t")} order by t.Seq, t.ID` },
		{ optional: `select s.MyTagID as tag, s.ContentID as track from djmdSongMyTag s where ${live("s")} order by s.ID` },
	]);
	const { tags, tagsOf } = readTags(tagRows, songTagRows);

	const tracks: RekordboxTrack[] = [];
	const known = new Set<string>();
	for (const row of trackRows) {
		const id = text(row["id"]);
		const file = text(row["path"]);
		if (!id || known.has(id)) continue;
		known.add(id);
		const key = camelot(text(row["key"]));
		tracks.push({
			id,
			title: text(row["title"]).trim() || path.basename(file).replace(/\.[^.]+$/, "") || "Untitled",
			artist: text(row["artist"]).trim(),
			bpm: num(row["bpm"]) / 100,
			key: key ? key.key : text(row["key"]).trim(),
			keyOrder: key ? key.order : null,
			lengthSec: num(row["length"]),
			path: file,
			// streaming tracks have an address of the service's own instead of a file
			available: path.isAbsolute(file) && fs.existsSync(file),
			added: tracks.length,
			tags: tagsOf.get(id) ?? [],
		});
	}

	const members = new Map<string, string[]>();
	for (const row of memberRows) {
		const list = text(row["list"]);
		const track = text(row["track"]);
		if (!known.has(track)) continue;
		const into = members.get(list) ?? [];
		if (into.length === 0) members.set(list, into);
		into.push(track);
	}

	// Rekordbox's own order: each folder's playlists under it, top to bottom.
	const children = new Map<string, { id: string; name: string; kind: number }[]>();
	for (const row of listRows) {
		const parent = text(row["parent"]);
		const into = children.get(parent) ?? [];
		if (into.length === 0) children.set(parent, into);
		into.push({ id: text(row["id"]), name: text(row["name"]).trim() || "Untitled", kind: num(row["kind"]) });
	}
	const playlists: RekordboxPlaylist[] = [];
	const seen = new Set<string>();
	const walk = (parent: string, prefix: string): void => {
		for (const p of children.get(parent) ?? []) {
			if (!p.id || seen.has(p.id)) continue;
			seen.add(p.id);
			if (p.kind === 0) playlists.push({ id: p.id, name: prefix + p.name, tracks: members.get(p.id) ?? [] });
			else if (p.kind === 1) walk(p.id, `${prefix}${p.name} / `);
		}
	};
	walk("root", "");
	return { tracks, playlists, tags };
}

// The app's tags (the My Tags in the APP_TAG_GROUP category), and each track's app tags,
// in Rekordbox's order. Rekordbox's other My Tags are left out.
function readTags(tagRows: Record<string, unknown>[], songTagRows: Record<string, unknown>[]): { tags: RekordboxTag[]; tagsOf: Map<string, string[]> } {
	const group = tagRows.find((row) => text(row["id"]) && num(row["kind"]) === 1 && text(row["parent"]) === "root" && text(row["name"]).trim() === APP_TAG_GROUP);
	const groupId = group ? text(group["id"]) : null;
	const tags: RekordboxTag[] = [];
	const known = new Set<string>();
	for (const row of tagRows) {
		const id = text(row["id"]);
		if (!id || !groupId || text(row["parent"]) !== groupId || num(row["kind"]) !== 0 || known.has(id)) continue;
		known.add(id);
		tags.push({ id, name: text(row["name"]).trim() || "Untitled" });
	}
	const tagsOf = new Map<string, string[]>();
	for (const row of songTagRows) {
		const tag = text(row["tag"]);
		const track = text(row["track"]);
		if (!known.has(tag) || !track) continue;
		const into = tagsOf.get(track) ?? [];
		if (into.length === 0) tagsOf.set(track, into);
		if (!into.includes(tag)) into.push(tag);
	}
	return { tags, tagsOf };
}
