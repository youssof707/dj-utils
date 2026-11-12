// Main-process side of the set planner: import, stretch cache, export, project files.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { PEAKS_EXT, SAMPLE_RATE, stretchKey, type ExportRequest, type ExportResult, type Cue, type PlannerDoc, type ProbeResult, type RekordboxGrid, type Session, type StretchRequest, type StretchResult } from "../shared/planner";
import { afconvertToWav } from "./audio/dsp";
import { parseWavHeader } from "./audio/wav";
import type { Task } from "./audio/worker";
import { databaseStamp, datKey, findAnalysisRoot, findDatabase, nameKey, type LibraryCue, type LibraryEntry, type RekordboxMatch } from "./rekordbox";

const AUDIO_EXT = ["mp3", "wav", "aif", "aiff", "flac", "m4a", "aac", "ogg", "caf", "mp4", "alac"];

let cacheDir = "";
let decodedDir = "";
let sessionFile = "";
let setsDir = "";

// A new auto-saved set gets a dated name in the sets folder, never overwriting another file.
function newSetPath(): string {
	fs.mkdirSync(setsDir, { recursive: true });
	const d = new Date();
	const p2 = (n: number): string => String(n).padStart(2, "0");
	const stem = `Set ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}`;
	for (let i = 1; ; i++) {
		const file = path.join(setsDir, `${stem}${i === 1 ? "" : ` ${i}`}.djset`);
		if (!fs.existsSync(file)) return file;
	}
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

function sourceHash(sourcePath: string): string {
	const st = fs.statSync(sourcePath);
	return createHash("sha1").update(`${sourcePath}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 16);
}

const decoding = new Map<string, Promise<string>>();

// Decodes any supported file to a 44.1 kHz stereo float WAV. MP3 and WAV are read
// directly by the system decoder; so is everything else it understands.
function decode(sourcePath: string): Promise<string> {
	let hash: string;
	try {
		hash = sourceHash(sourcePath);
	} catch {
		return Promise.reject(new Error("The source file is missing"));
	}
	const out = path.join(decodedDir, `${hash}.wav`);
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
let cueIndex: Record<string, LibraryCue[]> = {};
let cueStamp = "";
let cueLoad: Promise<void> | null = null;

function findRekordboxDb(): string | null {
	const forced = process.env["DJ_REKORDBOX_DB"];
	if (forced) return forced;
	return process.env["DJ_PLANNER_DATA"] || process.env["DJ_REKORDBOX_DIR"] ? null : findDatabase(os.homedir());
}

function loadCues(): Promise<void> {
	if (!rekordboxDb) return Promise.resolve();
	if (cueLoad) return cueLoad;
	const dbPath = rekordboxDb;
	const stamp = databaseStamp(dbPath);
	if (stamp === cueStamp) return Promise.resolve();
	cueLoad = runWorker<Record<string, LibraryCue[]>>({ type: "rekordbox-cues", job: { dbPath } }, () => {})
		.then((cues) => {
			cueIndex = cues;
		})
		.catch((e) => console.error("Rekordbox cues could not be read:", e)) // keeps the cues we had
		.finally(() => {
			cueStamp = stamp;
			cueLoad = null;
		});
	return cueLoad;
}

// The file's memory cues and hot cues, on our own decode of it.
async function rekordboxCues(sourcePath: string): Promise<Cue[]> {
	if (!rekordboxDb) return [];
	const m = await rekordboxMatch(sourcePath, false);
	if (!m) return [];
	await loadCues();
	return (cueIndex[datKey(m.dat)] ?? []).map((c) => ({ sec: c.ms / 1000 - m.shiftSec, kind: c.kind }));
}

async function probe(sourcePath: string): Promise<ProbeResult> {
	const decoded = await decode(sourcePath);
	const durationSec = wavFrames(decoded) / SAMPLE_RATE;
	const rekordbox = await rekordboxGrid(sourcePath);
	// Same file name in Rekordbox but not this audio: offer the newest analysis' BPM.
	const sameName = rekordbox ? undefined : rekordboxIndex.get(nameKey(path.basename(sourcePath)));
	const rekordboxBpm = sameName ? sameName.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)).bpm : null;
	return { path: sourcePath, name: path.basename(sourcePath).replace(/\.[^.]+$/, ""), durationSec, tagBpm: readTagBpm(sourcePath), rekordbox, rekordboxBpm };
}

// Stretch queue: a few at a time, one job per (file, track BPM, project BPM).
const stretching = new Map<string, Promise<StretchResult>>();
const waiting: (() => void)[] = [];
let active = 0;
const MAX_ACTIVE = 3;
const decodedUsers = new Map<string, number>();

function slot(): Promise<void> {
	if (active < MAX_ACTIVE) {
		active++;
		return Promise.resolve();
	}
	return new Promise((res) => waiting.push(res));
}
function release(): void {
	const next = waiting.shift();
	if (next) next();
	else active--;
}

function cachePathFor(req: StretchRequest): string {
	return path.join(cacheDir, `${sourceHash(req.sourcePath)}-${req.bpm}-${req.projectBpm}.wav`);
}

function ensureStretch(req: StretchRequest): Promise<StretchResult> {
	const key = stretchKey(req);
	let p = stretching.get(key);
	if (p) return p;
	p = (async () => {
		let cachePath: string;
		try {
			cachePath = cachePathFor(req);
		} catch {
			throw new Error("The source file is missing");
		}
		const peaksPath = `${cachePath}${PEAKS_EXT}`;
		if (fs.existsSync(cachePath)) {
			try {
				const frames = wavFrames(cachePath);
				// Stretched audio from before the current waveform format: only redo the waveform.
				if (!fs.existsSync(peaksPath)) await runWorker({ type: "peaks", job: { wavPath: cachePath, peaksPath } }, () => {});
				const now = new Date();
				fs.utimesSync(cachePath, now, now); // mark as recently used for cache clean-up
				return { cachePath, frames };
			} catch {
				// damaged cache file: rebuild it
			}
		}
		await slot();
		let decodedPath = "";
		try {
			decodedPath = await decode(req.sourcePath);
			decodedUsers.set(decodedPath, (decodedUsers.get(decodedPath) ?? 0) + 1);
			const { frames } = await runWorker<{ frames: number }>({ type: "prepare", job: { decodedPath, outPath: cachePath, peaksPath, fromBpm: req.bpm, toBpm: req.projectBpm } }, (pr) => send("planner:stretch-progress", { key, pct: pr.pct }));
			return { cachePath, frames };
		} finally {
			release();
			if (decodedPath) {
				// The decoded copy is only needed while stretching; drop it once nobody uses it.
				const left = (decodedUsers.get(decodedPath) ?? 1) - 1;
				if (left <= 0) {
					decodedUsers.delete(decodedPath);
					void fs.promises.rm(decodedPath, { force: true });
				} else decodedUsers.set(decodedPath, left);
			}
		}
	})().finally(() => stretching.delete(key));
	stretching.set(key, p);
	return p;
}

function inCache(file: string): boolean {
	const rel = path.relative(cacheDir, path.resolve(file));
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function parseDoc(text: string): PlannerDoc {
	const d = JSON.parse(text) as PlannerDoc;
	if (!d || d.version !== 1 || !Array.isArray(d.tracks) || !Array.isArray(d.clips) || !(Array.isArray(d.tempos) || Array.isArray((d as { points?: unknown }).points)) || typeof d.bpm !== "number") {
		throw new Error("This is not a set file");
	}
	return d;
}

function writeAtomic(file: string, text: string): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
}

// Stretched files are large. Keep the ones used in the last 45 days, and never more than
// 60 GB in total; anything dropped is rebuilt from the original the next time it is needed.
function pruneCache(): void {
	try {
		const now = Date.now();
		const entries = fs
			.readdirSync(cacheDir)
			.filter((f) => f.endsWith(".wav"))
			.map((f) => {
				const full = path.join(cacheDir, f);
				const st = fs.statSync(full);
				return { full, size: st.size, used: st.mtimeMs };
			})
			.sort((a, b) => b.used - a.used);
		let total = 0;
		for (const e of entries) {
			total += e.size;
			if (now - e.used > 45 * 86400e3 || total > 60e9) {
				fs.rmSync(e.full, { force: true });
				fs.rmSync(`${e.full}${PEAKS_EXT}`, { force: true });
			}
		}
		for (const f of fs.readdirSync(cacheDir)) {
			if (f.startsWith("export-")) fs.rmSync(path.join(cacheDir, f), { recursive: true, force: true });
			else if (f.includes(".part.")) fs.rmSync(path.join(cacheDir, f), { force: true });
		}
	} catch {
		// clean-up is best effort
	}
}

let exporting = false;
let exportWorker: Worker | null = null;
const cancelled = new WeakSet<Worker>();

export function setupPlanner(): void {
	const base = process.env["DJ_PLANNER_DATA"] || app.getPath("userData");
	cacheDir = path.join(base, "planner-cache");
	decodedDir = path.join(cacheDir, "decoded");
	sessionFile = path.join(base, "planner-session.json");
	setsDir = process.env["DJ_PLANNER_DATA"] ? path.join(base, "sets") : path.join(app.getPath("documents"), "DJ Sets");
	fs.mkdirSync(decodedDir, { recursive: true });
	// Decoded intermediates are only needed while stretching; clear leftovers from earlier runs.
	for (const f of fs.readdirSync(decodedDir)) fs.rmSync(path.join(decodedDir, f), { force: true });
	pruneCache();
	rekordboxRoot = findRekordboxRoot();
	rekordboxCache = path.join(base, "rekordbox-cache.json");
	matchesFile = path.join(base, "rekordbox-matches.json");
	loadSavedMatches();
	rekordboxDb = findRekordboxDb();
	void scanRekordbox();
	void loadCues();

	ipcMain.handle("planner:probe", (_e, p: string) => probe(p));
	ipcMain.handle("planner:rekordbox", (_e, p: string) => rekordboxGrid(p));
	ipcMain.handle("planner:cues", (_e, p: string) => rekordboxCues(p));
	ipcMain.handle("planner:stretch", (_e, req: StretchRequest) => ensureStretch(req));
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

	ipcMain.handle("planner:open-project", async (e, file?: string) => {
		let target = file;
		if (!target) {
			const win = BrowserWindow.fromWebContents(e.sender)!;
			const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "DJ set", extensions: ["djset"] }] });
			if (r.canceled || !r.filePaths[0]) return null;
			target = r.filePaths[0];
		}
		return { path: target, doc: parseDoc(await fs.promises.readFile(target, "utf8")) };
	});
	ipcMain.handle("planner:save-project", async (e, file: string | null, doc: PlannerDoc) => {
		let target = file;
		if (!target) {
			const win = BrowserWindow.fromWebContents(e.sender)!;
			const r = await dialog.showSaveDialog(win, { defaultPath: "Untitled set.djset", filters: [{ name: "DJ set", extensions: ["djset"] }] });
			if (r.canceled || !r.filePath) return null;
			target = r.filePath;
		}
		writeAtomic(target, JSON.stringify(doc, null, "\t") + "\n");
		return target;
	});
	// Auto-save: never shows a dialog. A set without a file gets one in the sets folder.
	ipcMain.handle("planner:autosave-project", async (_e, file: string | null, doc: PlannerDoc) => {
		const target = file ?? newSetPath();
		writeAtomic(target, JSON.stringify(doc, null, "\t") + "\n");
		return target;
	});
	ipcMain.handle("planner:load-session", (): Session | null => {
		try {
			const s = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as Session;
			parseDoc(JSON.stringify(s.doc));
			return s;
		} catch {
			return null;
		}
	});
	ipcMain.handle("planner:save-session", (_e, s: Session) => {
		writeAtomic(sessionFile, JSON.stringify(s));
	});
	ipcMain.handle("planner:reveal", (_e, file: string) => shell.showItemInFolder(file));
	ipcMain.handle("planner:file-exists", (_e, file: string) => fs.existsSync(file));
}

export function buildMenu(): void {
	const act = (action: string) => (): void => send("planner:menu", action);
	const template: MenuItemConstructorOptions[] = [
		{ role: "appMenu" },
		{
			label: "File",
			submenu: [
				{ label: "New Set", accelerator: "CmdOrCtrl+N", click: act("new") },
				{ label: "Open…", accelerator: "CmdOrCtrl+O", click: act("open") },
				{ type: "separator" },
				{ label: "Save", accelerator: "CmdOrCtrl+S", click: act("save") },
				{ label: "Save As…", accelerator: "Shift+CmdOrCtrl+S", click: act("save-as") },
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
				{ label: "Split at Playhead", click: act("split") },
				{ label: "Duplicate", accelerator: "CmdOrCtrl+D", click: act("duplicate") },
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
		{ role: "windowMenu" },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
