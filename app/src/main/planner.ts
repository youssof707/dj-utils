// Main-process side of the set planner: import, stretch cache, export, project files.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { PEAKS_EXT, SAMPLE_RATE, stretchKey, type ExportRequest, type ExportResult, type PlannerDoc, type ProbeResult, type Session, type StretchRequest, type StretchResult } from "../shared/planner";
import { afconvertToWav } from "./audio/dsp";
import { parseWavHeader } from "./audio/wav";
import type { Task } from "./audio/worker";

const AUDIO_EXT = ["mp3", "wav", "aif", "aiff", "flac", "m4a", "aac", "ogg", "caf", "mp4", "alac"];

let cacheDir = "";
let decodedDir = "";
let sessionFile = "";

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

async function probe(sourcePath: string): Promise<ProbeResult> {
	const decoded = await decode(sourcePath);
	return {
		path: sourcePath,
		name: path.basename(sourcePath).replace(/\.[^.]+$/, ""),
		durationSec: wavFrames(decoded) / SAMPLE_RATE,
		tagBpm: readTagBpm(sourcePath),
	};
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
	fs.mkdirSync(decodedDir, { recursive: true });
	// Decoded intermediates are only needed while stretching; clear leftovers from earlier runs.
	for (const f of fs.readdirSync(decodedDir)) fs.rmSync(path.join(decodedDir, f), { force: true });
	pruneCache();

	ipcMain.handle("planner:probe", (_e, p: string) => probe(p));
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
