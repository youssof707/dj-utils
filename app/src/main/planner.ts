// Main-process side of the set planner: import, stretch cache, export, and the stored sets.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, type MenuItemConstructorOptions } from "electron";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { PEAKS_EXT, rampKey, SAMPLE_RATE, stretchKey, type RampRequest, type EditExportRequest, type EditExportResult, type ExportRequest, type ExportResult, type Cue, type CueChange, type CueInfo, type CueRow, HOT_CUES, type PlannerDoc, type ProbeResult, type RekordboxGrid, type RekordboxLibrary, type SetFile, type SetInfo, type SetView, type StretchRequest, type StretchResult } from "../shared/planner";
import { normalizeDoc, renderingsFor, tempoMapOf } from "../shared/renderings";
import { afconvertToWav } from "./audio/dsp";
import { readGridTag, type SpliceResult } from "./audio/splice";
import { parseWavHeader } from "./audio/wav";
import type { Task } from "./audio/worker";
import { dataRoot } from "./paths";
import { exportDir } from "./settings";
import { cuesAfter, databaseStamp, datKey, findAnalysisRoot, findDatabase, nameKey, newCueRow, parseAnlz, type CueChangeJob, type CueChangeResult, type CueLibrary, type LibraryEntry, type RekordboxMatch } from "./rekordbox";

const AUDIO_EXT = ["mp3", "wav", "aif", "aiff", "flac", "m4a", "aac", "ogg", "caf", "mp4", "alac"];

let cacheDir = "";
let decodedDir = "";
let setsDir = "";

// A new set is named after the moment it was made.
function datedName(): string {
	const d = new Date();
	const p2 = (n: number): string => String(n).padStart(2, "0");
	return `Set ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}`;
}

function send(channel: string, payload: unknown): void {
	for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function runWorker<T>(task: Task, onProgress: (p: { pct: number; stage?: string }) => void, onStart?: (w: Worker) => void): Promise<T> {
	return new Promise((resolve, reject) => {
		const w = new Worker(path.join(__dirname, "worker.js"), { workerData: task });
		onStart?.(w);
		let done = false;
		w.on("message", (m: { progress?: { pct: number; stage?: string }; result?: T; error?: string }) => {
			if (m.progress) onProgress(m.progress);
			else if (m.error !== undefined) {
				done = true;
				reject(new Error(m.error));
			} else {
				done = true;
				resolve(m.result as T);
			}
		});
		w.on("error", (e) => {
			done = true;
			reject(e);
		});
		w.on("exit", (code) => {
			if (!done) reject(new Error(cancelled.has(w) ? "cancelled" : `Audio worker stopped unexpectedly (${code})`));
		});
	});
}

// The last hash seen for each source file, so that the cache files of a track whose source
// is out of reach for now (a drive that is unplugged) are still known to be its own.
let knownHashes: Record<string, string> = {};
let hashesChanged = false;

function sourceHash(sourcePath: string): string {
	const st = fs.statSync(sourcePath);
	const hash = createHash("sha1").update(`${sourcePath}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 16);
	if (knownHashes[sourcePath] !== hash) {
		knownHashes[sourcePath] = hash;
		hashesChanged = true;
	}
	return hash;
}

const decoding = new Map<string, Promise<string>>();

// Decodes any supported file to a 44.1 kHz stereo float WAV. MP3 and WAV are read
// directly by the system decoder; so is everything else it understands.
function decodedPathOf(sourcePath: string): string {
	return path.join(decodedDir, `${sourceHash(sourcePath)}.wav`);
}

function decode(sourcePath: string): Promise<string> {
	let out: string;
	try {
		out = decodedPathOf(sourcePath);
	} catch {
		return Promise.reject(new Error("The source file is missing"));
	}
	if (fs.existsSync(out)) return Promise.resolve(out);
	let p = decoding.get(out);
	if (!p) {
		const tmp = `${out}.${Date.now()}.part.wav`;
		p = afconvertToWav(sourcePath, tmp)
			.then(() => fs.promises.rename(tmp, out))
			.then(() => out)
			.finally(() => {
				decoding.delete(out);
				void fs.promises.rm(tmp, { force: true });
			});
		decoding.set(out, p);
	}
	return p;
}

function wavFrames(file: string): number {
	const fd = fs.openSync(file, "r");
	try {
		return parseWavHeader(fd).frames;
	} finally {
		fs.closeSync(fd);
	}
}

// Minimal ID3v2 reader for the BPM tag (TBPM, or TBP in v2.2).
function readTagBpm(file: string): number | null {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const head = Buffer.alloc(10);
			fs.readSync(fd, head, 0, 10, 0);
			if (head.toString("latin1", 0, 3) !== "ID3") return null;
			const ver = head[3];
			const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
			const tag = Buffer.alloc(Math.min(size, 1 << 20));
			fs.readSync(fd, tag, 0, tag.length, 10);
			let pos = 0;
			const idLen = ver === 2 ? 3 : 4;
			const headLen = ver === 2 ? 6 : 10;
			while (pos + headLen <= tag.length) {
				const id = tag.toString("latin1", pos, pos + idLen);
				if (!/^[A-Z0-9]+$/.test(id)) break;
				let len: number;
				if (ver === 2) len = tag.readUIntBE(pos + 3, 3);
				else if (ver === 4) len = ((tag[pos + 4] & 0x7f) << 21) | ((tag[pos + 5] & 0x7f) << 14) | ((tag[pos + 6] & 0x7f) << 7) | (tag[pos + 7] & 0x7f);
				else len = tag.readUInt32BE(pos + 4);
				if (id === "TBPM" || id === "TBP") {
					const body = tag.subarray(pos + headLen, pos + headLen + len);
					const enc = body[0];
					const text = (enc === 1 || enc === 2 ? body.subarray(1).toString("utf16le") : body.subarray(1).toString("utf8")).replace(/[﻿\0]/g, "").trim();
					const v = parseFloat(text.replace(",", "."));
					return Number.isFinite(v) && v >= 20 && v <= 400 ? v : null;
				}
				pos += headLen + len;
			}
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// unreadable tag: just no suggestion
	}
	return null;
}

// ---- Rekordbox library ---------------------------------------------------------------

let rekordboxRoot: string | null = null; // the folder of analysis files, when there is one
let rekordboxCache = "";
let rekordboxIndex = new Map<string, LibraryEntry[]>(); // by file name
let rekordboxScan: Promise<void> | null = null;
let rekordboxScannedAt = 0;

// Where to look for Rekordbox's analysis files. Test runs never look at the real library.
function findRekordboxRoot(): string | null {
	const forced = process.env["DJ_REKORDBOX_DIR"];
	if (forced) return forced;
	return process.env["DJ_PLANNER_DATA"] ? null : findAnalysisRoot(os.homedir());
}

// Reads the analysis folder into the index (only new and changed files are parsed). One
// scan at a time; a failed scan keeps whatever index there was.
function scanRekordbox(): Promise<void> {
	if (!rekordboxRoot) return Promise.resolve();
	rekordboxScan ??= runWorker<LibraryEntry[]>({ type: "rekordbox-scan", job: { root: rekordboxRoot, cachePath: rekordboxCache } }, () => {})
		.then((entries) => {
			const index = new Map<string, LibraryEntry[]>();
			for (const e of entries) {
				const key = nameKey(e.name);
				const list = index.get(key);
				if (list) list.push(e);
				else index.set(key, [e]);
			}
			rekordboxIndex = index;
			rekordboxScannedAt = Date.now();
		})
		.catch((e) => console.error("Rekordbox scan failed:", e))
		.finally(() => {
			rekordboxScan = null;
		});
	return rekordboxScan;
}

// Matches already worked out, by file and by the analyses it was compared with. The ones
// that found the track are kept between runs, so a set's tracks need no second look.
const rekordboxMatches = new Map<string, Promise<RekordboxMatch | null>>();
let matchesFile = "";
let savedMatches: Record<string, RekordboxMatch> = {};
const MAX_SAVED_MATCHES = 20000;

function loadSavedMatches(): void {
	try {
		const doc = JSON.parse(fs.readFileSync(matchesFile, "utf8")) as { version?: number; matches?: Record<string, RekordboxMatch> };
		if (doc.version === 1 && doc.matches && typeof doc.matches === "object") savedMatches = doc.matches;
	} catch {
		// none saved yet
	}
}

function saveMatch(key: string, match: RekordboxMatch): void {
	if (Object.keys(savedMatches).length >= MAX_SAVED_MATCHES) savedMatches = {};
	savedMatches[key] = match;
	try {
		const tmp = `${matchesFile}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ version: 1, matches: savedMatches }));
		fs.renameSync(tmp, matchesFile);
	} catch {
		// only saves time on a later run
	}
}

const analysesStamp = (list: LibraryEntry[] | undefined): string => (list ?? []).map((e) => `${e.dat}|${e.mtimeMs}`).join("\n");

// Lines the file's audio up against each analysis that carries its name.
function matchRekordbox(sourcePath: string, candidates: LibraryEntry[]): Promise<RekordboxMatch | null> {
	const key = `${sourceHash(sourcePath)}-${createHash("sha1").update(analysesStamp(candidates)).digest("hex").slice(0, 16)}`;
	let p = rekordboxMatches.get(key);
	if (!p) {
		const saved = savedMatches[key];
		p = saved
			? Promise.resolve(saved)
			: runMatch(sourcePath, candidates).then((m) => {
					if (m) saveMatch(key, m);
					return m;
				});
		rekordboxMatches.set(key, p);
		p.catch(() => rekordboxMatches.delete(key)); // a failure is worth another try
	}
	return p;
}

async function runMatch(sourcePath: string, candidates: LibraryEntry[]): Promise<RekordboxMatch | null> {
	for (let attempt = 0; ; attempt++) {
		const decodedPath = await decode(sourcePath);
		// Keep the decoded copy from being cleaned up by a stretch that finishes meanwhile.
		decodedUsers.set(decodedPath, (decodedUsers.get(decodedPath) ?? 0) + 1);
		try {
			return await runWorker<RekordboxMatch | null>({ type: "rekordbox-match", job: { decodedPath, candidates } }, () => {});
		} catch (e) {
			// The copy was cleaned up just before we claimed it: decode again, once.
			if (attempt > 0 || fs.existsSync(decodedPath)) throw e;
		} finally {
			const left = (decodedUsers.get(decodedPath) ?? 1) - 1;
			if (left <= 0) decodedUsers.delete(decodedPath);
			else decodedUsers.set(decodedPath, left);
		}
	}
}

// The file's Rekordbox analysis, or null when Rekordbox has not analysed this recording.
// Answers come from the index built at startup. Only a file the index has no match for
// makes it look at the analysis folder again (when `rescan` allows), in case the track was
// analysed since.
async function rekordboxMatch(sourcePath: string, rescan: boolean): Promise<RekordboxMatch | null> {
	if (!rekordboxRoot) return null;
	try {
		const key = nameKey(path.basename(sourcePath));
		if (rekordboxScan) await rekordboxScan;
		const first = rekordboxIndex.get(key);
		const grid = first ? await matchRekordbox(sourcePath, first) : null;
		if (grid || !rescan || Date.now() - rekordboxScannedAt < 2000) return grid;
		await scanRekordbox();
		const second = rekordboxIndex.get(key);
		return second && analysesStamp(second) !== analysesStamp(first) ? await matchRekordbox(sourcePath, second) : null;
	} catch (e) {
		console.error("Rekordbox lookup failed:", e);
		return null;
	}
}

async function rekordboxGrid(sourcePath: string): Promise<RekordboxGrid | null> {
	const m = await rekordboxMatch(sourcePath, true);
	return m && { bpm: m.bpm, downbeatSec: m.downbeatSec };
}

// Cue points come from Rekordbox's database, read again whenever Rekordbox has written to
// it, so cues set a moment ago are there.
let rekordboxDb: string | null = null;
let cueLibrary: CueLibrary = { cues: {}, contents: {} };
let cueStamp = "";
let cueLoad: Promise<void> | null = null;
// Reading the cues and changing them take turns, so a read never brings back the cues as
// they were before a change that has since been made.
let cueTurn: Promise<unknown> = Promise.resolve();

function inCueTurn<T>(fn: () => Promise<T>): Promise<T> {
	const p = cueTurn.then(fn, fn);
	cueTurn = p.catch(() => {});
	return p;
}

function findRekordboxDb(): string | null {
	const forced = process.env["DJ_REKORDBOX_DB"];
	if (forced) return forced;
	return process.env["DJ_PLANNER_DATA"] || process.env["DJ_REKORDBOX_DIR"] ? null : findDatabase(os.homedir());
}

function loadCues(): Promise<void> {
	if (!rekordboxDb) return Promise.resolve();
	const dbPath = rekordboxDb;
	cueLoad ??= inCueTurn(async () => {
		const stamp = databaseStamp(dbPath);
		if (stamp === cueStamp) return;
		try {
			cueLibrary = await runWorker<CueLibrary>({ type: "rekordbox-cues", job: { dbPath } }, () => {});
		} catch (e) {
			console.error("Rekordbox cues could not be read:", e); // keeps the cues we had
		}
		cueStamp = stamp;
	}).finally(() => {
		cueLoad = null;
	});
	return cueLoad;
}

// The program that writes to Rekordbox's database. Packaged: copied to Resources by
// extraResources. Dev: app/resources/sqlcipher (scripts/build-sqlcipher.sh makes it).
const sqlcipherPath = (): string => (app.isPackaged ? path.join(process.resourcesPath, "sqlcipher") : path.join(app.getAppPath(), "resources/sqlcipher"));

const cuesOf = (m: RekordboxMatch): Cue[] => (cueLibrary.cues[datKey(m.dat)] ?? []).map((c) => ({ id: c.id, sec: c.ms / 1000 - m.shiftSec, kind: c.kind, ...(c.loop ? { loop: true } : {}) }));

// The file's memory cues and hot cues, on our own decode of it.
async function rekordboxCues(sourcePath: string): Promise<CueInfo> {
	if (!rekordboxDb) return { cues: [], canEdit: false };
	const m = await rekordboxMatch(sourcePath, false);
	if (!m) return { cues: [], canEdit: false };
	await loadCues();
	return { cues: cuesOf(m), canEdit: datKey(m.dat) in cueLibrary.contents && fs.existsSync(sqlcipherPath()) };
}

const BEAT_PULL_MS = 30;

// The time Rekordbox would give a cue set here: exactly on its own beat line when there is
// one this close, which is where a cue from here is meant to be.
function onRekordboxBeat(dat: string, ms: number): number {
	try {
		const beats = parseAnlz(fs.readFileSync(dat))?.beats ?? [];
		let best = ms;
		let far = BEAT_PULL_MS;
		for (const b of beats) {
			const d = Math.abs(b.ms - ms);
			if (d <= far) {
				far = d;
				best = b.ms;
			}
		}
		return best;
	} catch {
		return ms;
	}
}

// Makes one change to the file's cues in Rekordbox's database, and says what it did.
// `plan` is given the track's row in Rekordbox and how to turn our seconds into its time.
async function changeCues(sourcePath: string, plan: (content: { id: string; uuid: string }, toMs: (sec: number) => number) => Omit<CueChangeJob, "contentId">): Promise<CueChange> {
	const dbPath = rekordboxDb;
	const m = dbPath ? await rekordboxMatch(sourcePath, false) : null;
	if (!dbPath || !m) throw new Error("This track is not in Rekordbox");
	await loadCues();
	return inCueTurn(async () => {
		const key = datKey(m.dat);
		const content = cueLibrary.contents[key];
		if (!content) throw new Error("This track is not in Rekordbox");
		const bin = sqlcipherPath();
		if (!fs.existsSync(bin)) throw new Error("Cues cannot be changed in this build of the app");
		const change = { contentId: content.id, ...plan(content, (sec) => onRekordboxBeat(m.dat, Math.max(0, Math.round((sec + m.shiftSec) * 1000)))) };
		const done = await runWorker<CueChangeResult>({ type: "rekordbox-cue-change", job: { bin, dbPath, change } }, () => {});
		cueLibrary.cues[key] = cuesAfter(cueLibrary.cues[key] ?? [], done.removed, done.added);
		return { cues: cuesOf(m), added: done.added, removed: done.removed };
	});
}

async function addCue(sourcePath: string, sec: number, kind: number): Promise<CueChange> {
	if (!Number.isFinite(sec) || !Number.isInteger(kind) || kind < 0 || kind > HOT_CUES) throw new Error("That is not a cue");
	const done = await changeCues(sourcePath, (content, toMs) => ({ remove: [], clear: kind > 0 ? [kind] : [], insert: [newCueRow(content, toMs(sec), kind)] }));
	if (done.added.length === 0) throw new Error("The cue was not added. Try again");
	return done;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function deleteCues(sourcePath: string, remove: string[]): Promise<CueChange> {
	return changeCues(sourcePath, () => ({ remove: ids(remove), clear: [], insert: [] }));
}

function applyCues(sourcePath: string, remove: string[], insert: CueRow[]): Promise<CueChange> {
	return changeCues(sourcePath, () => ({ remove: ids(remove), clear: [], insert: Array.isArray(insert) ? insert : [] }));
}

// Rekordbox's tracks and playlists, read again when Rekordbox has written to its database.
// Null when there is no Rekordbox library here. If a later read fails, the last one stands.
let library: RekordboxLibrary | null = null;
let libraryStamp = "";
let libraryLoad: Promise<void> | null = null;

async function rekordboxLibrary(): Promise<RekordboxLibrary | null> {
	if (!rekordboxDb) return null;
	const dbPath = rekordboxDb;
	const stamp = databaseStamp(dbPath);
	if (stamp !== libraryStamp || !library) {
		libraryLoad ??= runWorker<RekordboxLibrary>({ type: "rekordbox-library", job: { dbPath } }, () => {})
			.then((read) => {
				library = read;
				libraryStamp = stamp;
			})
			.finally(() => {
				libraryLoad = null;
			});
		try {
			await libraryLoad;
		} catch (e) {
			console.error("Rekordbox library could not be read:", e);
			if (!library) throw e;
		}
	}
	return library;
}

// The file's beat grid: Rekordbox's when it has analysed the file, otherwise the one an
// edit exported from here carries with it (its parent track's).
async function trackGrid(sourcePath: string): Promise<RekordboxGrid | null> {
	const grid = await rekordboxGrid(sourcePath);
	if (grid) return grid;
	const tag = readGridTag(sourcePath);
	return tag && tag.downbeatSec !== undefined ? { bpm: tag.bpm, downbeatSec: tag.downbeatSec } : null;
}

// Where an edit of the track called `name` goes: "<name> (edit).wav" in the export folder,
// numbered when that is taken.
function editPath(dir: string, name: string): string {
	const base =
		name
			.replace(/[/\\:\0]/g, "-")
			.replace(/ \(edit( \d+)?\)$/, "")
			.trim() || "Track";
	for (let n = 1; ; n++) {
		const file = path.join(dir, `${base} (edit${n === 1 ? "" : ` ${n}`}).wav`);
		if (!fs.existsSync(file)) return file;
	}
}

let editExporting = false;

async function exportEdit(req: EditExportRequest): Promise<EditExportResult> {
	if (editExporting) throw new Error("An export is already running");
	if (!AUDIO_EXT.includes(path.extname(req.sourcePath).slice(1).toLowerCase()) || !fs.existsSync(req.sourcePath)) throw new Error("The source file is missing");
	if (req.second && (!AUDIO_EXT.includes(path.extname(req.second.sourcePath).slice(1).toLowerCase()) || !fs.existsSync(req.second.sourcePath))) throw new Error("The second track's file is missing");
	editExporting = true;
	try {
		const dir = exportDir();
		fs.mkdirSync(dir, { recursive: true });
		const outPath = editPath(dir, req.name);
		const job = { sourcePath: req.sourcePath, outPath, tmpDir: app.getPath("temp"), bpm: req.bpm, downbeatSec: req.downbeatSec, leadBeat: req.leadBeat, sections: req.sections, second: req.second };
		const r = await runWorker<SpliceResult & { seconds: number }>({ type: "edit-export", job }, () => {});
		return { path: outPath, seconds: r.seconds, sampleRate: r.sampleRate, bits: r.bits, channels: r.channels };
	} finally {
		editExporting = false;
	}
}

async function probe(sourcePath: string): Promise<ProbeResult> {
	const decoded = await decode(sourcePath);
	const durationSec = wavFrames(decoded) / SAMPLE_RATE;
	const rekordbox = await trackGrid(sourcePath);
	// Same file name in Rekordbox but not this audio: offer the newest analysis' BPM.
	const sameName = rekordbox ? undefined : rekordboxIndex.get(nameKey(path.basename(sourcePath)));
	const rekordboxBpm = sameName ? sameName.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)).bpm : null;
	return { path: sourcePath, name: path.basename(sourcePath).replace(/\.[^.]+$/, ""), durationSec, tagBpm: readGridTag(sourcePath)?.bpm ?? readTagBpm(sourcePath), rekordbox, rekordboxBpm };
}

// Stretch queue: a few at a time, one job per rendering (see stretchKey and rampKey). The
// window says which renderings the set still needs; work on anything else is dropped, so
// trying a few tempos in a row does not leave a queue of stretches nobody will hear.
const stretching = new Map<string, Promise<StretchResult>>();
const waiting: { key: string; go: () => void; drop: () => void }[] = [];
const workers = new Map<string, Worker>();
let wanted: Set<string> | null = null;
let active = 0;
const MAX_ACTIVE = 3;
const decodedUsers = new Map<string, number>();
const decodedExpiry = new Map<string, ReturnType<typeof setTimeout>>();
const DECODED_LINGER_MS = 30000;

function dropped(key: string): boolean {
	return wanted !== null && !wanted.has(key);
}

function slot(key: string): Promise<void> {
	if (active < MAX_ACTIVE) {
		active++;
		return Promise.resolve();
	}
	return new Promise((res, rej) => waiting.push({ key, go: res, drop: () => rej(new Error("cancelled")) }));
}
function release(): void {
	const next = waiting.shift();
	if (next) next.go();
	else active--;
}

function stopWorker(w: Worker): void {
	cancelled.add(w);
	w.postMessage("cancel");
	// The worker exits by itself once it has stopped its helper process.
	const t = setTimeout(() => void w.terminate(), 2000);
	w.once("exit", () => clearTimeout(t));
}

function keepOnly(keys: string[]): void {
	noteDropped(wanted, keys);
	wanted = new Set(keys);
	for (let i = waiting.length - 1; i >= 0; i--) {
		if (!dropped(waiting[i].key)) continue;
		waiting[i].drop();
		waiting.splice(i, 1);
	}
	for (const [key, w] of workers) if (dropped(key)) stopWorker(w);
}

// Runs one queued job in a worker, on the decoded copy of its source. The copy is claimed
// before it is made, so a job that finishes meanwhile cannot clear it away from under this one.
async function queued<T>(key: string, sourcePath: string, task: (decodedPath: string) => Task): Promise<T> {
	await slot(key);
	let claimed = "";
	try {
		try {
			claimed = decodedPathOf(sourcePath);
		} catch {
			throw new Error("The source file is missing");
		}
		decodedUsers.set(claimed, (decodedUsers.get(claimed) ?? 0) + 1);
		const decodedPath = await decode(sourcePath);
		if (dropped(key)) throw new Error("cancelled");
		return await runWorker<T>(
			task(decodedPath),
			(pr) => send("planner:stretch-progress", { key, pct: pr.pct }),
			(w) => {
				workers.set(key, w);
				w.once("exit", () => {
					if (workers.get(key) === w) workers.delete(key);
				});
			},
		);
	} finally {
		release();
		if (claimed) {
			// The decoded copy is only needed while stretching. It is dropped a little after
			// its last use, not at once: one edit to a tempo change is often followed by another,
			// which would only decode the same files again.
			const file = claimed;
			const left = (decodedUsers.get(file) ?? 1) - 1;
			if (left > 0) decodedUsers.set(file, left);
			else {
				decodedUsers.delete(file);
				clearTimeout(decodedExpiry.get(file));
				decodedExpiry.set(
					file,
					setTimeout(() => {
						decodedExpiry.delete(file);
						if (!decodedUsers.has(file)) fs.rmSync(file, { force: true });
					}, DECODED_LINGER_MS),
				);
			}
		}
	}
}

// What a stopped job left half-written next to its target.
function removeParts(cachePath: string): void {
	const stem = `${path.basename(cachePath)}.`;
	try {
		for (const f of fs.readdirSync(cacheDir)) if (f.startsWith(stem) && f.includes(".part.")) fs.rmSync(path.join(cacheDir, f), { force: true });
	} catch {
		// clean-up is best effort
	}
}

// Cache files are named by the audio they hold, never by the set that asked for them: the
// same track at the same tempo is one file however many sets use it.
function stretchFile(hash: string, req: StretchRequest): string {
	return `${hash}-${req.bpm}-${req.projectBpm}.wav`;
}

function rampFile(hash: string, req: RampRequest): string {
	const id = createHash("sha1").update(`${req.bpm}|${req.fromBeat}|${req.lengthBeat}|${req.bpmA}|${req.bpmB}`).digest("hex").slice(0, 16);
	return `ramp-${hash}-${id}.wav`;
}

function cachePathFor(req: StretchRequest): string {
	return path.join(cacheDir, stretchFile(sourceHash(req.sourcePath), req));
}

function cached(cachePath: string): StretchResult | null {
	if (!fs.existsSync(cachePath)) return null;
	try {
		const frames = wavFrames(cachePath);
		const now = new Date();
		fs.utimesSync(cachePath, now, now); // mark as recently used for cache clean-up
		return { cachePath, frames };
	} catch {
		return null; // damaged cache file: rebuild it
	}
}

// Where each rendering asked for since launch is cached.
const keyPaths = new Map<string, string>();

function once(key: string, job: () => Promise<StretchResult>): Promise<StretchResult> {
	wanted?.add(key);
	let p = stretching.get(key);
	if (!p) {
		p = job().finally(() => stretching.delete(key));
		stretching.set(key, p);
	}
	return p;
}

function ensureStretch(req: StretchRequest): Promise<StretchResult> {
	const key = stretchKey(req);
	return once(key, async () => {
		let cachePath: string;
		try {
			cachePath = cachePathFor(req);
		} catch {
			throw new Error("The source file is missing");
		}
		keyPaths.set(key, cachePath);
		const peaksPath = `${cachePath}${PEAKS_EXT}`;
		const have = cached(cachePath);
		if (have) {
			try {
				// Stretched audio from before the current waveform format: only redo the waveform.
				if (!fs.existsSync(peaksPath)) await runWorker({ type: "peaks", job: { wavPath: cachePath, peaksPath } }, () => {});
				return have;
			} catch {
				// damaged cache file: rebuild it
			}
		}
		try {
			const { frames } = await queued<{ frames: number }>(key, req.sourcePath, (decodedPath) => ({ type: "prepare", job: { decodedPath, outPath: cachePath, peaksPath, fromBpm: req.bpm, toBpm: req.projectBpm } }));
			return { cachePath, frames };
		} catch (e) {
			removeParts(cachePath);
			throw e;
		}
	});
}

function ensureRamp(req: RampRequest): Promise<StretchResult> {
	const key = rampKey(req);
	return once(key, async () => {
		let cachePath: string;
		try {
			cachePath = path.join(cacheDir, rampFile(sourceHash(req.sourcePath), req));
		} catch {
			throw new Error("The source file is missing");
		}
		keyPaths.set(key, cachePath);
		const have = cached(cachePath);
		if (have) return have;
		const tmpDir = `${cachePath}.work`;
		fs.mkdirSync(tmpDir, { recursive: true });
		try {
			const { frames } = await queued<{ frames: number }>(key, req.sourcePath, (decodedPath) => ({ type: "ramp", job: { decodedPath, outPath: cachePath, bpm: req.bpm, fromBeat: req.fromBeat, lengthBeat: req.lengthBeat, bpmA: req.bpmA, bpmB: req.bpmB, tmpDir } }));
			return { cachePath, frames };
		} finally {
			removeParts(cachePath);
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
}

function inCache(file: string): boolean {
	const rel = path.relative(cacheDir, path.resolve(file));
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function checkDoc(d: PlannerDoc): PlannerDoc {
	if (!d || d.version !== 1 || !Array.isArray(d.tracks) || !Array.isArray(d.clips) || !(Array.isArray(d.tempos) || Array.isArray((d as { points?: unknown }).points)) || typeof d.bpm !== "number") {
		throw new Error("This is not a set");
	}
	return d;
}

function writeAtomic(file: string, text: string): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
}

// ---- sets ---------------------------------------------------------------------------
// The app keeps every set itself, one file each in its own data folder. Nothing is ever
// saved to or opened from a place the user has to pick.

function setFilePath(id: string): string {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Not a set");
	return path.join(setsDir, `${id}.json`);
}

function readSet(id: string): SetFile {
	const s = JSON.parse(fs.readFileSync(setFilePath(id), "utf8")) as SetFile;
	checkDoc(s.doc);
	return s;
}

function allSets(): SetFile[] {
	const out: SetFile[] = [];
	for (const f of fs.readdirSync(setsDir)) {
		if (!f.endsWith(".json")) continue;
		try {
			out.push(readSet(f.slice(0, -5)));
		} catch {
			// not a set, or damaged: leave it alone
		}
	}
	return out;
}

// Set names are kept apart: a name already taken by another set gets a number after it.
function freeName(want: string, id: string | null): string {
	const taken = new Set(allSets().filter((s) => s.id !== id).map((s) => s.name));
	if (!taken.has(want)) return want;
	for (let i = 2; ; i++) if (!taken.has(`${want} ${i}`)) return `${want} ${i}`;
}

function newSetId(): string {
	return `s${randomBytes(8).toString("hex")}`;
}

// Stores a set and returns its name. A set stored for the first time without a name gets
// one. Only a change to the set itself counts as an edit; where the view was left does not.
function storeSet(id: string, name: string | null, view: SetView, doc: PlannerDoc): string {
	checkDoc(doc);
	let old: SetFile | null = null;
	try {
		old = readSet(id);
	} catch {
		// a new set
	}
	const now = Date.now();
	const asked = (name ?? "").trim();
	const finalName = asked && asked !== old?.name ? freeName(asked, id) : (old?.name ?? freeName(datedName(), id));
	const changed = !old || old.name !== finalName || JSON.stringify(old.doc) !== JSON.stringify(doc);
	const s: SetFile = { id, name: finalName, createdAt: old?.createdAt ?? now, updatedAt: changed ? now : old!.updatedAt, openedAt: now, view, doc };
	writeAtomic(setFilePath(id), JSON.stringify(s));
	return finalName;
}

function addSet(doc: PlannerDoc, name: string | null, at: number, view?: SetView): string {
	const id = newSetId();
	const s: SetFile = { id, name: freeName((name ?? "").trim() || datedName(), id), createdAt: at, updatedAt: at, openedAt: at, view: view ?? { pxPerBeat: 12, scrollX: 0, playheadBeat: 0 }, doc: checkDoc(doc) };
	writeAtomic(setFilePath(id), JSON.stringify(s));
	return id;
}

function setInfo(s: SetFile): SetInfo {
	let lengthSec = 0;
	try {
		const doc = normalizeDoc(s.doc);
		const beats = doc.clips.reduce((end, c) => Math.max(end, c.startBeat + c.lengthBeat), 0);
		lengthSec = beats > 0 ? tempoMapOf(doc).secondsAtBeat(beats) : 0;
	} catch {
		// the list still shows the set
	}
	return { id: s.id, name: s.name, updatedAt: s.updatedAt, tracks: new Set(s.doc.clips.map((c) => c.trackId)).size, lengthSec };
}

// Sets from before the app kept them itself: the one that was open last, and the ones that
// were auto-saved as files. They are copied in once; the old files are left where they are.
function bringInOldSets(base: string): void {
	const marker = path.join(setsDir, ".migrated");
	if (fs.existsSync(marker)) return;
	const sessionFile = path.join(base, "planner-session.json");
	const oldDir = process.env["DJ_PLANNER_DATA"] ? path.join(base, "sets") : path.join(app.getPath("documents"), "DJ Sets");
	try {
		for (const f of fs.readdirSync(oldDir)) {
			if (!f.endsWith(".djset")) continue;
			try {
				const file = path.join(oldDir, f);
				addSet(JSON.parse(fs.readFileSync(file, "utf8")) as PlannerDoc, f.slice(0, -6), fs.statSync(file).mtimeMs);
			} catch {
				// not a set
			}
		}
	} catch {
		// no such folder
	}
	try {
		const s = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as { doc: PlannerDoc; filePath: string | null; dirty: boolean; pxPerBeat: number; scrollX: number; playheadBeat: number };
		const alreadyIn = !!s.filePath && !s.dirty && path.dirname(s.filePath) === oldDir && fs.existsSync(s.filePath);
		if (!alreadyIn && s.doc.clips.length > 0) {
			const name = s.filePath ? path.basename(s.filePath).replace(/\.djset$/, "") : null;
			addSet(s.doc, name, Date.now(), { pxPerBeat: s.pxPerBeat, scrollX: s.scrollX, playheadBeat: s.playheadBeat });
		}
	} catch {
		// nothing was open
	}
	fs.rmSync(sessionFile, { force: true });
	fs.writeFileSync(marker, "");
}

// ---- cache clean-up -----------------------------------------------------------------
// Stretched files are large. A file stays while the open set needs it, or a set that was
// opened or edited in the last week does. Anything else (a tempo that was tried and dropped,
// a ramp from before a clip moved, the files of a deleted set) goes once it has sat unused
// for an hour. Whatever is dropped is made again from the original when a set next needs it.

const RECENT_SET_MS = 7 * 86400e3;
const UNUSED_MS = 3600e3;
const cacheCap = (): number => Number(process.env["DJ_PLANNER_CACHE_CAP"]) || 20e9;

function cacheFilesOf(doc: PlannerDoc, hashOf: (sourcePath: string) => string | undefined = syncHash): string[] {
	const out: string[] = [];
	for (const r of renderingsFor(doc)) {
		const hash = hashOf(r.req.sourcePath);
		if (hash) out.push(r.ramp ? rampFile(hash, r.req) : stretchFile(hash, r.req));
	}
	return out;
}

function syncHash(sourcePath: string): string | undefined {
	try {
		return sourceHash(sourcePath);
	} catch {
		return knownHashes[sourcePath];
	}
}

function pruneCache(atLaunch = false): void {
	const removed: string[] = [];
	try {
		const now = Date.now();
		// What the open set plays, and anything being made right now.
		const open = new Set<string>();
		for (const key of [...(wanted ?? []), ...stretching.keys()]) {
			const file = keyPaths.get(key);
			if (file) open.add(path.basename(file));
		}
		const keep = new Set(open);
		const sources = new Set<string>();
		for (const s of allSets()) {
			try {
				const doc = normalizeDoc(s.doc);
				for (const t of doc.tracks) sources.add(t.sourcePath);
				if (now - Math.max(s.openedAt, s.updatedAt) > RECENT_SET_MS) continue;
				for (const f of cacheFilesOf(doc)) keep.add(f);
			} catch {
				// a damaged set keeps nothing
			}
		}
		const names = fs.readdirSync(cacheDir);
		const remove = (full: string): void => {
			fs.rmSync(full, { force: true });
			fs.rmSync(`${full}${PEAKS_EXT}`, { force: true });
			removed.push(full);
		};
		let left: { name: string; full: string; size: number; used: number }[] = [];
		for (const name of names) {
			if (!name.endsWith(".wav") || name.includes(".part.")) continue;
			const full = path.join(cacheDir, name);
			const st = fs.statSync(full, { throwIfNoEntry: false });
			if (!st) continue;
			if (!keep.has(name) && now - st.mtimeMs > UNUSED_MS) remove(full);
			else left.push({ name, full, size: st.size, used: st.mtimeMs });
		}
		// A ceiling on top of that, least recently used first, sparing the open set.
		let total = left.reduce((n, e) => n + e.size, 0);
		left = left.sort((a, b) => a.used - b.used);
		for (const e of left) {
			if (total <= cacheCap()) break;
			if (open.has(e.name)) continue;
			remove(e.full);
			total -= e.size;
		}
		for (const name of names) {
			const full = path.join(cacheDir, name);
			if (name.endsWith(PEAKS_EXT)) {
				// A waveform whose audio is gone.
				const st = fs.statSync(full, { throwIfNoEntry: false });
				if (st && !fs.existsSync(full.slice(0, -PEAKS_EXT.length)) && (atLaunch || now - st.mtimeMs > UNUSED_MS)) fs.rmSync(full, { force: true });
			} else if (atLaunch) {
				// Left half-made by a run that was cut short.
				if (name.startsWith("export-") || name.endsWith(".work")) fs.rmSync(full, { recursive: true, force: true });
				else if (name.includes(".part.")) fs.rmSync(full, { force: true });
			}
		}
		for (const p of Object.keys(knownHashes)) {
			if (sources.has(p)) continue;
			delete knownHashes[p];
			hashesChanged = true;
		}
		if (hashesChanged) {
			hashesChanged = false;
			writeAtomic(path.join(cacheDir, "sources.json"), JSON.stringify(knownHashes));
		}
	} catch {
		// clean-up is best effort
	} finally {
		// Whatever still counts on a file that went has to hear of it, come what may.
		if (removed.length) {
			for (const [key, file] of keyPaths) if (removed.includes(file)) keyPaths.delete(key);
			send("planner:cache-removed", removed);
		}
	}
}

let pruneTimer: ReturnType<typeof setTimeout> | undefined;
function pruneSoon(): void {
	clearTimeout(pruneTimer);
	pruneTimer = setTimeout(() => pruneCache(), 2000);
}

// ---- dropped renderings -------------------------------------------------------------
// When the open set stops needing a rendering (a track restretched to another tempo, or
// taken out of the set), its files go soon after, unless a set opened or edited in the last
// week still uses them. A short wait first, so an undo plays at once instead of stretching
// again. This runs quietly in the background: async file access only, one file at a time,
// never while an export runs, and nothing the open set wants is ever touched.

const dropGrace = (): number => Number(process.env["DJ_PLANNER_DROP_GRACE_MS"]) || 120e3;
const dropCandidates = new Map<string, number>(); // cache file name -> when it stopped being wanted
let dropTimer: ReturnType<typeof setTimeout> | undefined;
let dropping = false;

function noteDropped(before: Set<string> | null, keys: string[]): void {
	if (!before) return;
	const now = new Set(keys);
	for (const key of keys) {
		const file = keyPaths.get(key);
		if (file) dropCandidates.delete(path.basename(file));
	}
	for (const key of before) {
		if (now.has(key)) continue;
		const file = keyPaths.get(key);
		if (file && !dropCandidates.has(path.basename(file))) dropCandidates.set(path.basename(file), Date.now());
	}
	if (dropCandidates.size) scheduleDropPrune(dropGrace());
}

function scheduleDropPrune(ms: number): void {
	if (dropTimer) return;
	dropTimer = setTimeout(() => {
		dropTimer = undefined;
		void pruneDropped();
	}, ms);
	dropTimer.unref();
}

// Cache file names the open set wants, or that are being made right now.
function inUseNames(): Set<string> {
	const out = new Set<string>();
	for (const key of [...(wanted ?? []), ...stretching.keys()]) {
		const file = keyPaths.get(key);
		if (file) out.add(path.basename(file));
	}
	return out;
}

const yieldNow = (): Promise<void> => new Promise((res) => setImmediate(res));

async function hashOfAsync(sourcePath: string): Promise<string | undefined> {
	try {
		const st = await fs.promises.stat(sourcePath);
		return createHash("sha1").update(`${sourcePath}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 16);
	} catch {
		return knownHashes[sourcePath];
	}
}

// Every cache file a set opened or edited in the last week calls for.
async function recentSetFiles(): Promise<Set<string>> {
	const keep = new Set<string>();
	const now = Date.now();
	for (const f of await fs.promises.readdir(setsDir)) {
		if (!f.endsWith(".json")) continue;
		await yieldNow();
		try {
			const s = JSON.parse(await fs.promises.readFile(path.join(setsDir, f), "utf8")) as SetFile;
			checkDoc(s.doc);
			if (now - Math.max(s.openedAt, s.updatedAt) > RECENT_SET_MS) continue;
			const doc = normalizeDoc(s.doc);
			const hashes = new Map<string, string | undefined>();
			for (const t of doc.tracks) hashes.set(t.sourcePath, await hashOfAsync(t.sourcePath));
			for (const name of cacheFilesOf(doc, (p) => hashes.get(p))) keep.add(name);
		} catch {
			// not a set, or damaged: it keeps nothing
		}
	}
	return keep;
}

async function pruneDropped(): Promise<void> {
	if (dropping || exporting) {
		scheduleDropPrune(30e3);
		return;
	}
	dropping = true;
	const removed: string[] = [];
	try {
		const now = Date.now();
		const due = [...dropCandidates].filter(([, at]) => now - at >= dropGrace()).map(([name]) => name);
		const later = [...dropCandidates.values()].filter((at) => now - at < dropGrace());
		if (later.length) scheduleDropPrune(Math.max(1000, dropGrace() - (now - Math.min(...later))));
		if (!due.length) return;
		const keep = await recentSetFiles();
		for (const name of due) {
			dropCandidates.delete(name);
			await yieldNow();
			// Checked again right before: the set may have taken it back meanwhile.
			if (keep.has(name) || inUseNames().has(name) || exporting) continue;
			const full = path.join(cacheDir, name);
			try {
				await fs.promises.rm(full, { force: true });
				await fs.promises.rm(`${full}${PEAKS_EXT}`, { force: true });
				removed.push(full);
			} catch {
				// a file that will not go now is left for the regular clean-up
			}
		}
	} catch {
		// clean-up is best effort
	} finally {
		dropping = false;
		if (removed.length) {
			for (const [key, file] of keyPaths) if (removed.includes(file)) keyPaths.delete(key);
			send("planner:cache-removed", removed);
		}
	}
}

let exporting = false;
let exportWorker: Worker | null = null;
const cancelled = new WeakSet<Worker>();

export function setupPlanner(): void {
	const base = dataRoot();
	cacheDir = path.join(base, "planner-cache");
	decodedDir = path.join(cacheDir, "decoded");
	setsDir = path.join(base, "sets");
	fs.mkdirSync(decodedDir, { recursive: true });
	fs.mkdirSync(setsDir, { recursive: true });
	try {
		knownHashes = JSON.parse(fs.readFileSync(path.join(cacheDir, "sources.json"), "utf8")) as Record<string, string>;
	} catch {
		knownHashes = {};
	}
	try {
		bringInOldSets(base);
	} catch {
		// the app still starts
	}
	// Decoded intermediates are only needed while stretching; clear leftovers from earlier runs.
	for (const f of fs.readdirSync(decodedDir)) fs.rmSync(path.join(decodedDir, f), { force: true });
	pruneCache(true);
	setInterval(() => pruneCache(), 30 * 60e3).unref();
	rekordboxRoot = findRekordboxRoot();
	rekordboxCache = path.join(base, "rekordbox-cache.json");
	matchesFile = path.join(base, "rekordbox-matches.json");
	loadSavedMatches();
	rekordboxDb = findRekordboxDb();
	void scanRekordbox();
	void loadCues();

	ipcMain.handle("planner:probe", (_e, p: string) => probe(p));
	ipcMain.handle("planner:rekordbox", (_e, p: string) => trackGrid(p));
	ipcMain.handle("planner:cues", (_e, p: string) => rekordboxCues(p));
	ipcMain.handle("planner:cue-add", (_e, p: string, sec: number, kind: number) => addCue(p, sec, kind));
	ipcMain.handle("planner:cue-delete", (_e, p: string, remove: string[]) => deleteCues(p, remove));
	ipcMain.handle("planner:cue-apply", (_e, p: string, remove: string[], insert: CueRow[]) => applyCues(p, remove, insert));
	ipcMain.handle("planner:rekordbox-library", () => rekordboxLibrary());
	// A rendering dropped because the set moved on is not an error: it comes back as null
	// (the preload turns that into a "cancelled" rejection), so Electron does not log it.
	const quietCancel = <T>(p: Promise<T>): Promise<T | null> => p.catch((e) => (e instanceof Error && e.message === "cancelled" ? null : Promise.reject(e)));
	ipcMain.handle("planner:stretch", (_e, req: StretchRequest) => quietCancel(ensureStretch(req)));
	ipcMain.handle("planner:ramp", (_e, req: RampRequest) => quietCancel(ensureRamp(req)));
	ipcMain.handle("planner:keep", (_e, keys: string[]) => keepOnly(keys));
	ipcMain.handle("planner:read-audio", async (_e, file: string) => {
		if (!inCache(file)) throw new Error("Not a cache file");
		return fs.promises.readFile(file);
	});
	ipcMain.handle("planner:read-peaks", async (_e, file: string) => {
		if (!inCache(file)) throw new Error("Not a cache file");
		return fs.promises.readFile(`${file}${PEAKS_EXT}`);
	});

	ipcMain.handle("planner:choose-audio", async (e) => {
		const win = BrowserWindow.fromWebContents(e.sender)!;
		const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"], filters: [{ name: "Audio", extensions: AUDIO_EXT }] });
		return r.canceled ? [] : r.filePaths;
	});
	ipcMain.handle("planner:choose-export", async (e, defaultName: string) => {
		const win = BrowserWindow.fromWebContents(e.sender)!;
		const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: "WAV audio", extensions: ["wav"] }] });
		return r.canceled || !r.filePath ? null : r.filePath;
	});
	ipcMain.handle("planner:export", async (_e, req: ExportRequest): Promise<ExportResult> => {
		if (exporting) throw new Error("An export is already running");
		exporting = true;
		try {
			for (const c of req.clips) if (!inCache(c.cachePath)) throw new Error("Not a cache file");
			const r = await runWorker<{ seconds: number; gainDb: number }>(
				{ type: "export", job: { ...req, tmpDir: cacheDir } },
				(pr) => send("planner:export-progress", pr),
				(w) => {
					exportWorker = w;
				},
			);
			return { path: req.outPath, ...r };
		} finally {
			exporting = false;
			exportWorker = null;
		}
	});
	ipcMain.handle("planner:export-edit", (_e, req: EditExportRequest) => exportEdit(req));
	ipcMain.handle("planner:export-cancel", async () => {
		const w = exportWorker;
		if (!w) return;
		cancelled.add(w);
		w.postMessage("cancel");
		// The worker exits by itself once it has stopped its helper process.
		await new Promise<void>((res) => {
			const t = setTimeout(() => void w.terminate().then(() => res()), 2000);
			w.once("exit", () => {
				clearTimeout(t);
				res();
			});
		});
		// Remove the half-written working files.
		for (const f of fs.readdirSync(cacheDir)) if (f.startsWith("export-")) fs.rmSync(path.join(cacheDir, f), { recursive: true, force: true });
	});

	ipcMain.handle("planner:sets-list", (): SetInfo[] => {
		pruneSoon();
		return allSets()
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map(setInfo);
	});
	ipcMain.handle("planner:set-open", (_e, id: string): SetFile => {
		const s = readSet(id);
		s.openedAt = Date.now();
		writeAtomic(setFilePath(id), JSON.stringify(s));
		pruneSoon();
		return s;
	});
	ipcMain.handle("planner:set-save", (_e, id: string, name: string | null, view: SetView, doc: PlannerDoc) => storeSet(id, name, view, doc));
	ipcMain.on("planner:set-save-sync", (e, id: string, name: string | null, view: SetView, doc: PlannerDoc) => {
		try {
			e.returnValue = storeSet(id, name, view, doc);
		} catch {
			e.returnValue = "";
		}
	});
	ipcMain.handle("planner:set-rename", (_e, id: string, name: string): string => {
		const s = readSet(id);
		const next = name.trim();
		if (!next || next === s.name) return s.name;
		s.name = freeName(next, id);
		s.updatedAt = Date.now();
		writeAtomic(setFilePath(id), JSON.stringify(s));
		return s.name;
	});
	ipcMain.handle("planner:set-duplicate", (_e, id: string): void => {
		const s = readSet(id);
		addSet(s.doc, `${s.name} copy`, Date.now(), s.view);
	});
	ipcMain.handle("planner:set-delete", (_e, id: string): void => {
		fs.rmSync(setFilePath(id), { force: true });
		pruneSoon();
	});
	ipcMain.handle("planner:set-import", (_e, file: string): string => addSet(JSON.parse(fs.readFileSync(file, "utf8")) as PlannerDoc, path.basename(file).replace(/\.[^.]+$/, ""), Date.now()));
	ipcMain.handle("planner:prune", (): void => pruneCache());
	ipcMain.handle("planner:reveal", (_e, file: string) => shell.showItemInFolder(file));
	// A track picked up in the library panel, dragged out as the file itself: Finder, Chrome
	// and the like get the file where it is. Outside the app the drag offers only a copy, so
	// Finder copies it and never moves it away from Rekordbox. Only the library's own files.
	ipcMain.on("planner:drag-file", (e, file: string, icon: { png: string; scale: number }) => {
		if (!library?.tracks.some((t) => t.available && t.path === file) || !fs.existsSync(file)) return;
		const image = nativeImage.createFromBuffer(Buffer.from(icon.png.replace(/^data:image\/png;base64,/, ""), "base64"), { scaleFactor: icon.scale });
		if (image.isEmpty()) return;
		e.sender.startDrag({ file, icon: image });
	});
}

export function buildMenu(): void {
	const act = (action: string) => (): void => send("planner:menu", action);
	const template: MenuItemConstructorOptions[] = [
		{
			role: "appMenu",
			submenu: [
				{ role: "about" },
				// The renderer runs the check and shows the result, same as the startup check.
				{ label: "Check for Updates…", click: () => send("updater:menu-triggered", {}) },
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "File",
			submenu: [
				{ label: "New Set", accelerator: "CmdOrCtrl+N", click: act("new") },
				{ label: "All Sets", accelerator: "CmdOrCtrl+O", click: act("sets") },
				{ type: "separator" },
				{ label: "Import Audio…", accelerator: "CmdOrCtrl+I", click: act("import") },
				{ label: "Export WAV…", accelerator: "CmdOrCtrl+E", click: act("export") },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ label: "Undo", accelerator: "CmdOrCtrl+Z", click: act("undo") },
				{ label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: act("redo") },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ label: "Select All", accelerator: "CmdOrCtrl+A", click: act("select-all") },
				{ type: "separator" },
				{ label: "Split at Playhead", accelerator: "CmdOrCtrl+S", click: act("split") },
				{ label: "Duplicate", accelerator: "CmdOrCtrl+D", click: act("duplicate") },
				{ label: "Mute or Unmute Clips", accelerator: "CmdOrCtrl+M", click: act("mute") },
				{ label: "Mute or Unmute Bass", accelerator: "CmdOrCtrl+B", click: act("bass") },
				{ label: "Delete", click: act("delete") },
			],
		},
		{
			label: "View",
			submenu: [
				{ label: "Zoom In", accelerator: "CmdOrCtrl+=", click: act("zoom-in") },
				{ label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: act("zoom-out") },
				{ label: "Zoom to Fit", accelerator: "CmdOrCtrl+0", click: act("zoom-fit") },
				{ type: "separator" },
				{ role: "togglefullscreen" },
				{ role: "toggleDevTools" },
			],
		},
		// The standard Window menu without Minimize's Command-M, which mutes clips here.
		{
			label: "Window",
			submenu: [{ label: "Minimize", click: (_item, win) => win?.minimize() }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
