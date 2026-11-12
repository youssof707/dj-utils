// Rekordbox integration end to end: a library of analysis files on disk, a real app, real
// drops, and the exported audio measured against the grid.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_RATE as SR } from "../../src/shared/planner";
import type { AnlzBeat } from "../../src/main/rekordbox";
import { datFile, gridBeats, waveformOf, writeAnalysis } from "../anlz";
import { onsets, readAll, writeBarTrack, writeClickTrack } from "../signals";
import { exportTo, importTrack, launch, shot, state, waitReady, type Harness } from "./harness";

const LAME = ["/opt/homebrew/bin/lame", "/usr/local/bin/lame"].find((p) => fs.existsSync(p));
const BEAT = (60 / 128) * SR; // frames per beat at the project tempo
const BEAT_SEC = 60 / 128;
// Rekordbox stores beat times as whole milliseconds. At 128 BPM (468.75 ms a beat) that
// leaves up to an eighth of a millisecond in any bar line worked out from them.
const GRID_MS = 0.2;

let h: Harness;
let work: string;
let root: string; // the Rekordbox analysis folder
const f: Record<string, string> = {};
const dats: Record<string, string> = {};

function beatCount(seconds: number, bpm: number, firstSec: number): number {
	return Math.floor(((seconds - firstSec) * bpm) / 60);
}

beforeAll(async () => {
	work = fs.mkdtempSync(path.join(os.tmpdir(), "planner-work-"));
	root = path.join(work, "rekordbox", "share", "PIONEER", "USBANLZ");
	fs.mkdirSync(root, { recursive: true });
	const file = (name: string): string => path.join(work, name);

	// A: starts on beat 3 of a bar, a quarter second in. First bar line 2 beats later.
	f.a = file("Bar Track A.wav");
	writeBarTrack(f.a, 128, 40, { firstSec: 0.25, firstNo: 3, seed: 1 });
	dats.a = writeAnalysis(root, "?/Bar Track A.wav", gridBeats(128, 0.25, 3, beatCount(40, 128, 0.25)), waveformOf(f.a));

	// B: Rekordbox shows 140.00 but the beats run at 139.996.
	f.b = file("Offbeat 140.wav");
	writeBarTrack(f.b, 139.996, 40, { firstSec: 0.012, firstNo: 1, seed: 2 });
	writeAnalysis(root, "?/Offbeat 140.wav", gridBeats(139.996, 0.012, 1, beatCount(40, 139.996, 0.012)).map((b) => ({ ...b, tempo: 14000 })), waveformOf(f.b));

	// Not in Rekordbox at all.
	f.plain = file("plain.wav");
	writeClickTrack(f.plain, 128, 30, { clickHz: 5000, clickAmp: 0.3 });

	// A different recording that happens to have A's file name.
	fs.mkdirSync(file("elsewhere"));
	f.twin = file("elsewhere/Bar Track A.wav");
	writeBarTrack(f.twin, 111, 40, { firstSec: 0.4, firstNo: 1, seed: 3 });

	// An MP3 from LAME: Rekordbox's clock runs 2257 frames ahead of ours on these.
	if (LAME) {
		const src = file("mp3-source.wav");
		writeBarTrack(src, 128, 30, { firstSec: 0.1, firstNo: 1, seed: 4 });
		f.mp3 = file("Lame Track.mp3");
		execFileSync(LAME, ["--quiet", "-b", "192", src, f.mp3]);
		writeAnalysis(root, "?/Lame Track.mp3", gridBeats(128, 0.1 + 2257 / SR, 1, beatCount(30, 128, 0.1)), waveformOf(src, 2257));
	}

	// An AAC file: Rekordbox keeps the 2112 frames of priming that our decoder drops.
	{
		const src = file("aac-source.wav");
		writeBarTrack(src, 128, 30, { firstSec: 0.06, firstNo: 1, seed: 10 });
		f.m4a = file("Aac Track.m4a");
		execFileSync("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", "-b", "256000", src, f.m4a]);
		writeAnalysis(root, "?/Aac Track.m4a", gridBeats(128, 0.06 + 2112 / SR, 1, beatCount(30, 128, 0.06)), waveformOf(src, 2112));
	}

	// E: on Rekordbox's clock the first bar line is at 21 ms; on ours it is 4 ms before the
	// file starts, so the first thing heard is beat 2.
	f.early = file("Early Bar.wav");
	writeBarTrack(f.early, 128, 30, { firstSec: BEAT_SEC - 0.004, firstNo: 2, seed: 5 });
	writeAnalysis(root, "?/Early Bar.wav", gridBeats(128, 1105 / SR - 0.004, 1, beatCount(30, 128, 0)), waveformOf(f.early, 1105));

	// Tempo that never settles: no single BPM to take.
	f.wobble = file("Wobble.wav");
	writeBarTrack(f.wobble, 128, 20, { seed: 6 });
	const wobble: AnlzBeat[] = [];
	for (let i = 0, ms = 0; ms < 19500; i++) {
		const tempo = 12000 + ((i * 37) % 900);
		wobble.push({ no: (i % 4) + 1, tempo, ms: Math.round(ms) });
		ms += 6000000 / tempo;
	}
	writeAnalysis(root, "?/Wobble.wav", wobble, waveformOf(f.wobble));

	// Stored the old way, with the full path of wherever the file used to live.
	f.full = file("Full Path.wav");
	writeBarTrack(f.full, 128, 20, { firstSec: 0.05, firstNo: 1, seed: 7 });
	writeAnalysis(root, "/Volumes/Old Drive/Music/Full Path.wav", gridBeats(128, 0.05, 1, beatCount(20, 128, 0.05)), waveformOf(f.full));

	// Accents: Rekordbox stores them composed, the file system here has them decomposed.
	f.accent = file("Café Løve.wav".normalize("NFD"));
	writeBarTrack(f.accent, 128, 20, { firstSec: 0.05, firstNo: 2, seed: 8 });
	writeAnalysis(root, "?/" + "Café Løve.wav".normalize("NFC"), gridBeats(128, 0.05, 2, beatCount(20, 128, 0.05)), waveformOf(f.accent));

	// Analysed only after the app is running (written in its test).
	f.late = file("Late.wav");
	writeBarTrack(f.late, 128, 20, { firstSec: 0.3, firstNo: 4, seed: 9 });

	h = await launch(undefined, work, { DJ_REKORDBOX_DIR: root });
});
afterAll(async () => {
	await h?.close();
});

const clips = (): Promise<any[]> => state(h.page, "s => s.doc.clips");
const tracks = (): Promise<any[]> => state(h.page, "s => s.doc.tracks");
const newSet = (): Promise<void> => h.page.evaluate(() => (window as any).planner.newSet());

// Brings files in the way a drop does and says what happened: straight onto the timeline,
// or the BPM question.
async function drop(files: string | string[], lane: number, beat: number | null): Promise<"placed" | "asked"> {
	await h.page.evaluate(([p, l, b]) => (window as any).planner.importPaths(p, l, b), [Array.isArray(files) ? files : [files], lane, beat] as const);
	return (await state<number>(h.page, "s => s.importQueue.length")) > 0 ? "asked" : "placed";
}

// A real drag from outside the window, as Finder and Rekordbox do it.
async function dragIn(files: string[], x: number, y: number, modifiers = 0): Promise<void> {
	const cdp = await h.page.context().newCDPSession(h.page);
	const data = { items: [], files, dragOperationsMask: 1 };
	await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x, y, data, modifiers });
	await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x, y, data, modifiers });
	await cdp.send("Input.dispatchDragEvent", { type: "drop", x, y, data, modifiers });
	await cdp.detach();
}

async function exported(name: string): Promise<Float32Array> {
	const out = path.join(work, name);
	await waitReady(h.page);
	await exportTo(h.page, out, true);
	await h.page.getByTestId("export-done").waitFor({ timeout: 120000 });
	await h.page.getByTestId("export-close").click();
	return readAll(out).left;
}

// How far each bar click (loud) and each click of any kind is from the project's bar and
// beat lines, in milliseconds.
function gridErrors(x: Float32Array, loud = 0.55, any = 0.15): { bars: number[]; barErr: number[]; beatErr: number[] } {
	const ms = (frames: number): number => (frames / SR) * 1000;
	const bars = onsets(x, loud, 0.1);
	const all = onsets(x, any, 0.1);
	return {
		bars: bars.map((o) => o / BEAT),
		barErr: bars.map((o) => ms(Math.abs(o - Math.round(o / (4 * BEAT)) * 4 * BEAT))),
		beatErr: all.map((o) => ms(Math.abs(o - Math.round(o / BEAT) * BEAT))),
	};
}

// Where the clip's audio has its bar lines on the timeline (any one of them).
function barLine(clip: any, track: any): number {
	const beat = (track.downbeatSec * track.bpm) / 60;
	return clip.startBeat - clip.offsetBeat + beat;
}
const offGrid = (beat: number, step: number): number => Math.abs(beat / step - Math.round(beat / step)) * step;

describe("rekordbox", () => {
	it("reads the library at startup and keeps it in a JSON file", async () => {
		const cache = path.join(h.dataDir, "rekordbox-cache.json");
		await expect.poll(() => fs.existsSync(cache), { timeout: 15000 }).toBe(true);
		const doc = JSON.parse(fs.readFileSync(cache, "utf8"));
		const entries = Object.values(doc.files as Record<string, { entry: { name: string; bpm: number } | null }>);
		const names = entries.filter((e) => e.entry).map((e) => e.entry!.name);
		expect(names).toContain("Bar Track A.wav");
		expect(names).toContain("Full Path.wav");
		expect(names).toContain("Café Løve.wav".normalize("NFC"));
		expect(names).not.toContain("Wobble.wav"); // scanned, but it has no usable grid
		expect(entries.length).toBe(fs.readdirSync(root).length);
		expect(doc.root).toBe(root);
	});

	it("places a Rekordbox track without asking, its first bar line on the drop point", async () => {
		expect(await drop(f.a, 0, 8)).toBe("placed");
		expect(await h.page.getByTestId("import-modal").count()).toBe(0);
		const [t] = await tracks();
		const [c] = await clips();
		expect(t.bpm).toBe(128);
		expect(t.name).toBe("Bar Track A");
		// first bar line: a quarter second in, plus two beats
		expect(Math.abs(t.downbeatSec - (0.25 + 2 * BEAT_SEC)) * 1000).toBeLessThan(GRID_MS);
		expect(c.startBeat).toBe(8);
		expect(c.lane).toBe(0);
		expect(c.offsetBeat).toBeCloseTo((0.25 + 2 * BEAT_SEC) / BEAT_SEC, 3);
		expect(c.offsetBeat + c.lengthBeat).toBeCloseTo(40 / BEAT_SEC, 6); // runs to the end of the file
		expect(await state(h.page, "s => s.selection")).toEqual([c.id]);
		expect(await h.page.locator('[data-testid="clip"] .clip-bpm').textContent()).toBe("128");

		const g = gridErrors(await exported("a.wav"));
		console.log("WAV at project tempo: bar clicks", g.bars.length, "first at beat", g.bars[0].toFixed(4), "worst bar error (ms)", Math.max(...g.barErr).toFixed(3), "worst beat error (ms)", Math.max(...g.beatErr).toFixed(3));
		expect(g.bars.length).toBeGreaterThanOrEqual(19);
		expect(g.bars[0]).toBeCloseTo(8, 2); // the track's first bar line is exactly where it was dropped
		expect(Math.max(...g.barErr)).toBeLessThan(GRID_MS);
		expect(g.beatErr.length).toBeGreaterThan(75);
		expect(Math.max(...g.beatErr)).toBeLessThan(GRID_MS);
		await shot(h.page, "rb-01-placed");

		// one undo step
		await h.page.keyboard.press("Meta+z");
		expect((await clips()).length).toBe(0);
		await h.page.keyboard.press("Meta+Shift+z");
		expect((await clips()).length).toBe(1);
	});

	it("still asks for the BPM of files Rekordbox doesn't know", async () => {
		expect(await drop(f.plain, 1, 0)).toBe("asked");
		await h.page.getByTestId("import-modal").waitFor();
		expect(await h.page.getByTestId("bpm-input").inputValue()).toBe("");
		expect(await h.page.getByTestId("import-modal").textContent()).not.toContain("Rekordbox");
		await h.page.getByTestId("bpm-cancel").click();
		await h.page.getByTestId("import-modal").waitFor({ state: "detached" });
		expect((await clips()).length).toBe(1);
	});

	it("is not fooled by a different recording with the same file name", async () => {
		expect(await drop(f.twin, 1, 0)).toBe("asked");
		// Rekordbox's BPM for that name is offered, with a word on why the track isn't lined up
		expect(await h.page.getByTestId("bpm-input").inputValue()).toBe("128");
		expect(await h.page.getByTestId("import-modal").textContent()).toContain("Rekordbox");
		await h.page.getByTestId("bpm-input").fill("111");
		await h.page.getByTestId("bpm-confirm").click();
		await h.page.getByTestId("import-modal").waitFor({ state: "detached" });
		const ts = await tracks();
		const twin = ts.find((t) => t.sourcePath === f.twin);
		expect(twin.bpm).toBe(111);
		expect(twin.downbeatSec).toBeUndefined();
		const c = (await clips()).find((x) => x.trackId === twin.id);
		expect(c.offsetBeat).toBe(0);
		expect(c.startBeat).toBe(0);
	});

	it("does not take a grid whose tempo never settles", async () => {
		expect(await drop(f.wobble, 2, 0)).toBe("asked");
		await h.page.getByTestId("bpm-cancel").click();
		await h.page.getByTestId("import-modal").waitFor({ state: "detached" });
	});

	it("uses the grid's own tempo when Rekordbox's two-decimal BPM would drift", async () => {
		await newSet();
		expect(await drop(f.b, 1, 0)).toBe("placed");
		const [t] = await tracks();
		expect(t.bpm).toBe(139.996);
		const [c] = await clips();
		expect(c.startBeat).toBe(0);
		expect(c.offsetBeat).toBeCloseTo((0.012 * 139.996) / 60, 3);
		const g = gridErrors(await exported("b.wav"), 0.4, 0.4);
		const last = g.barErr[g.barErr.length - 1];
		const mean = g.barErr.reduce((s, v) => s + v, 0) / g.barErr.length;
		console.log("stretched 139.996 → 128: bar clicks", g.bars.length, "mean error (ms)", mean.toFixed(3), "worst", Math.max(...g.barErr).toFixed(3), "last bar", last.toFixed(3));
		expect(g.bars.length).toBeGreaterThanOrEqual(21);
		expect(g.bars[0]).toBeCloseTo(0, 1);
		// the stretch itself moves a click by a couple of milliseconds at most; no drift on top of it
		expect(Math.max(...g.barErr)).toBeLessThan(5);
		expect(mean).toBeLessThan(2.5);
	});

	it.skipIf(!LAME)("lines up an MP3, where Rekordbox's clock is ahead of ours", async () => {
		await newSet();
		expect(await drop(f.mp3, 0, 4)).toBe("placed");
		const [t] = await tracks();
		const [c] = await clips();
		expect(t.bpm).toBe(128);
		console.log("MP3: bar line at", (t.downbeatSec * 1000).toFixed(3), "ms on our clock (true 100.000); Rekordbox's analysis said", (100 + (2257 / SR) * 1000).toFixed(3));
		expect(Math.abs(t.downbeatSec - 0.1) * 1000).toBeLessThan(0.4);
		expect(c.startBeat).toBe(4);
		expect(c.offsetBeat).toBeCloseTo(0.1 / BEAT_SEC, 2);
		const g = gridErrors(await exported("mp3.wav"), 0.45, 0.45);
		console.log("MP3: bar clicks", g.bars.length, "first at beat", g.bars[0].toFixed(4), "worst bar error (ms)", Math.max(...g.barErr).toFixed(3));
		expect(g.bars.length).toBeGreaterThanOrEqual(15);
		expect(g.bars[0]).toBeCloseTo(4, 1);
		expect(Math.max(...g.barErr)).toBeLessThan(0.6);
	});

	it("lines up an AAC file, and can play it although it is not stretched", async () => {
		await newSet();
		expect(await drop(f.m4a, 0, 4)).toBe("placed");
		const [t] = await tracks();
		const [c] = await clips();
		expect(t.bpm).toBe(128);
		console.log("AAC: bar line at", (t.downbeatSec * 1000).toFixed(3), "ms on our clock (true 60.000); Rekordbox's analysis said", (60 + (2112 / SR) * 1000).toFixed(3));
		expect(Math.abs(t.downbeatSec - 0.06) * 1000).toBeLessThan(0.4);
		expect(c.startBeat).toBe(4);
		const g = gridErrors(await exported("m4a.wav"), 0.45, 0.45);
		console.log("AAC: bar clicks", g.bars.length, "first at beat", g.bars[0].toFixed(4), "worst bar error (ms)", Math.max(...g.barErr).toFixed(3));
		expect(g.bars.length).toBeGreaterThanOrEqual(15);
		expect(g.bars[0]).toBeCloseTo(4, 1);
		expect(Math.max(...g.barErr)).toBeLessThan(0.6);
		// at the project tempo the decoded file is used as it is; the player must read it
		await expect.poll(() => h.page.evaluate(() => (window as any).planner.engine.debug().buffers), { timeout: 15000 }).toBeGreaterThan(0);
	});

	it("keeps the whole file when the first bar line falls a hair before it", async () => {
		await newSet();
		expect(await drop(f.early, 2, 12)).toBe("placed");
		const [t] = await tracks();
		const [c] = await clips();
		expect(Math.abs(t.downbeatSec - -0.004) * 1000).toBeLessThan(0.4);
		expect(c.offsetBeat).toBe(0);
		expect(c.startBeat).toBeCloseTo(12 + 0.004 / BEAT_SEC, 2);
		expect(c.lengthBeat).toBeCloseTo(30 / BEAT_SEC, 6);
		const g = gridErrors(await exported("early.wav"));
		console.log("early bar line: first bar click at beat", g.bars[0].toFixed(4), "worst bar error (ms)", Math.max(...g.barErr).toFixed(3));
		expect(g.bars[0]).toBeCloseTo(16, 1); // beat 2 of the dropped bar comes first; the next bar line is one bar on
		expect(Math.max(...g.barErr)).toBeLessThan(0.4);
		expect(Math.max(...g.beatErr)).toBeLessThan(0.4);
	});

	it("queues several dropped tracks bar to bar", async () => {
		await newSet();
		expect(await drop([f.a, f.early, f.full], 0, 4)).toBe("placed");
		const cs = await clips();
		const ts = await tracks();
		expect(cs.length).toBe(3);
		expect(cs[0].startBeat).toBe(4);
		// each next one starts on the first bar line after the one before
		const endA = cs[0].startBeat + cs[0].lengthBeat;
		expect(cs[1].startBeat).toBeCloseTo(Math.ceil(endA / 4) * 4 + 0.004 / BEAT_SEC, 2);
		const endE = cs[1].startBeat + cs[1].lengthBeat;
		expect(cs[2].startBeat).toBe(Math.ceil(endE / 4) * 4);
		for (const c of cs) expect(offGrid(barLine(c, ts.find((t) => t.id === c.trackId)), 4)).toBeLessThan(0.002);
		const g = gridErrors(await exported("queue.wav"));
		console.log("three tracks queued: bar clicks", g.bars.length, "worst bar error (ms)", Math.max(...g.barErr).toFixed(3));
		expect(g.bars.length).toBeGreaterThan(40);
		expect(Math.max(...g.barErr)).toBeLessThan(0.4);
	});

	it("a mixed drop lands in the order it was dropped", async () => {
		const lead = (0.25 + 2 * BEAT_SEC) / BEAT_SEC;
		// first a file that needs its BPM typed, then a Rekordbox track: the second waits its turn
		await newSet();
		expect(await drop([f.plain, f.a], 0, 8)).toBe("asked");
		expect((await clips()).length).toBe(0);
		expect(await h.page.getByTestId("import-modal").textContent()).not.toContain("more to go");
		await h.page.getByTestId("bpm-input").fill("128");
		await h.page.getByTestId("bpm-confirm").click();
		await h.page.getByTestId("import-modal").waitFor({ state: "detached" });
		let cs = await clips();
		expect(cs.length).toBe(2);
		expect(cs[0]).toMatchObject({ startBeat: 8, offsetBeat: 0 });
		expect(cs[0].lengthBeat).toBeCloseTo(64, 6); // 30 s at 128
		expect(cs[1].startBeat).toBe(72); // the bar line where the first one ends
		expect(cs[1].offsetBeat).toBeCloseTo(lead, 3);

		// skipping the first hands its place to the next
		await newSet();
		expect(await drop([f.plain, f.a], 1, 12)).toBe("asked");
		await h.page.getByTestId("bpm-cancel").click();
		await h.page.getByTestId("import-modal").waitFor({ state: "detached" });
		cs = await clips();
		expect(cs.length).toBe(1);
		expect(cs[0]).toMatchObject({ startBeat: 12, lane: 1 });
		expect(cs[0].offsetBeat).toBeCloseTo(lead, 3);

		// a Rekordbox track between two that ask
		await newSet();
		expect(await drop([f.a, f.plain, f.early, f.twin], 2, 0)).toBe("asked");
		expect((await clips()).length).toBe(1); // A went straight in; the rest wait behind the question
		expect(await h.page.getByTestId("import-modal").textContent()).toContain("1 more to go");
		await h.page.getByTestId("bpm-input").fill("128");
		await h.page.getByTestId("bpm-confirm").click();
		await h.page.waitForFunction(() => (window as any).planner.store.get().doc.clips.length === 3, undefined, { polling: 50 });
		expect(await h.page.getByTestId("import-modal").textContent()).toContain("Rekordbox"); // the twin's question
		await h.page.getByTestId("bpm-cancel").click();
		await h.page.getByTestId("import-modal").waitFor({ state: "detached" });
		cs = await clips();
		expect(cs.length).toBe(3);
		for (let i = 1; i < cs.length; i++) expect(cs[i].startBeat).toBeGreaterThanOrEqual(cs[i - 1].startBeat + cs[i - 1].lengthBeat - 1e-6);
		expect(cs[2].startBeat).toBeCloseTo(Math.ceil((cs[1].startBeat + cs[1].lengthBeat) / 4) * 4 + 0.004 / BEAT_SEC, 2);
	});

	it("matches names stored with a full path, and names with accents", async () => {
		await newSet();
		expect(await drop(f.full, 0, 0)).toBe("placed");
		expect(await drop(f.accent, 1, 0)).toBe("placed");
		const ts = await tracks();
		expect(Math.abs(ts[0].downbeatSec - 0.05) * 1000).toBeLessThan(GRID_MS);
		expect(Math.abs(ts[1].downbeatSec - (0.05 + 3 * BEAT_SEC)) * 1000).toBeLessThan(GRID_MS);
	});

	it("drops from outside snap to beats, to bars when zoomed out, and freely with Option", async () => {
		await newSet();
		await state(h.page, "s => { window.planner.store.set({ pxPerBeat: 12, scrollX: 0 }); return 0; }");
		const lane1 = (await h.page.getByTestId("lane-1").boundingBox())!;
		const lane2 = (await h.page.getByTestId("lane-2").boundingBox())!;
		const lane3 = (await h.page.getByTestId("lane-3").boundingBox())!;
		const count = (n: number): Promise<unknown> => h.page.waitForFunction((k) => (window as any).planner.store.get().doc.clips.length === k, n, { polling: 50 });

		// beat lines showing: lands on the nearest beat
		await dragIn([f.a], lane1.x + 17.3 * 12, lane1.y + 30);
		await count(1);
		let cs = await clips();
		expect(cs[0].startBeat).toBe(17);
		expect(cs[0].lane).toBe(1);
		expect(cs[0].offsetBeat).toBeCloseTo((0.25 + 2 * BEAT_SEC) / BEAT_SEC, 3);

		// zoomed out to bars: lands on the nearest bar; the same file again needs no second look
		await state(h.page, "s => { window.planner.store.set({ pxPerBeat: 4, scrollX: 0 }); return 0; }");
		await dragIn([f.a], lane2.x + 21.7 * 4, lane2.y + 30);
		await count(2);
		cs = await clips();
		expect(cs[1].startBeat).toBe(20);
		expect(cs[1].lane).toBe(2);
		expect((await tracks()).length).toBe(1);

		// Option held: exactly where it was let go, first bar line there
		await dragIn([f.a], lane3.x + 50.4 * 4, lane3.y + 30, 1);
		await count(3);
		cs = await clips();
		expect(cs[2].startBeat).toBeGreaterThan(50.1);
		expect(cs[2].startBeat).toBeLessThan(50.7);
		expect(cs[2].startBeat % 1).not.toBe(0);
		expect(cs[2].offsetBeat).toBeCloseTo(cs[0].offsetBeat, 9);
		expect(await h.page.getByTestId("import-modal").count()).toBe(0);
		await shot(h.page, "rb-02-drops");
	});

	it("keeps a track's beats on the grid when its clip is opened up and moved", async () => {
		await newSet();
		await state(h.page, "s => { window.planner.store.set({ pxPerBeat: 12, scrollX: 0 }); return 0; }");
		expect(await drop(f.a, 0, 8)).toBe("placed");
		const el = h.page.locator('[data-testid="clip"]').first();
		let box = (await el.boundingBox())!;
		const y = box.y + box.height / 2;
		const [t] = await tracks();
		const lead = (0.25 + 2 * BEAT_SEC) / BEAT_SEC; // beats of lead-in hidden behind the left edge

		// pull the left edge out as far as it goes: the lead-in is there, the audio has not moved
		await h.page.mouse.move(box.x + 2, y);
		await h.page.mouse.down();
		await h.page.mouse.move(box.x - 200, y, { steps: 6 });
		await h.page.mouse.up();
		let [c] = await clips();
		expect(c.offsetBeat).toBeCloseTo(0, 9);
		expect(c.startBeat).toBeCloseTo(8 - lead, 3);
		expect(barLine(c, t)).toBeCloseTo(8, 3);

		// move it: the bar line snaps, not the (now off-grid) left edge
		box = (await el.boundingBox())!;
		await h.page.mouse.move(box.x + 100, y);
		await h.page.mouse.down();
		await h.page.mouse.move(box.x + 100 + 5.3 * 12, y, { steps: 6 });
		await h.page.mouse.up();
		[c] = await clips();
		expect(barLine(c, t)).toBeCloseTo(13, 3);
		expect(c.startBeat).toBeCloseTo(13 - lead, 3);

		// zoomed out, moves go bar to bar
		await state(h.page, "s => { window.planner.store.set({ pxPerBeat: 4, scrollX: 0 }); return 0; }");
		box = (await el.boundingBox())!;
		await h.page.mouse.move(box.x + 100, y);
		await h.page.mouse.down();
		await h.page.mouse.move(box.x + 100 + 6 * 4, y, { steps: 6 });
		await h.page.mouse.up();
		[c] = await clips();
		expect(barLine(c, t)).toBeCloseTo(20, 3);

		// shoved against the start of the timeline it stops on the first bar that fits
		box = (await el.boundingBox())!;
		await h.page.mouse.move(box.x + 100, y);
		await h.page.mouse.down();
		await h.page.mouse.move(box.x - 600, y, { steps: 6 });
		await h.page.mouse.up();
		[c] = await clips();
		expect(c.startBeat).toBeGreaterThanOrEqual(0);
		expect(barLine(c, t)).toBeCloseTo(4, 3);

		// Option still moves freely
		box = (await el.boundingBox())!;
		await h.page.keyboard.down("Alt");
		await h.page.mouse.move(box.x + 100, y);
		await h.page.mouse.down();
		await h.page.mouse.move(box.x + 100 + 9, y, { steps: 4 });
		await h.page.mouse.up();
		await h.page.keyboard.up("Alt");
		[c] = await clips();
		expect(offGrid(barLine(c, t), 1)).toBeGreaterThan(0.05);

		// a split keeps both halves on the same grid, and the right half moves by its bar line too
		await h.page.keyboard.press("Meta+z");
		await h.page.evaluate(() => (window as any).planner.engine.seek(30.37));
		await el.click({ position: { x: 20, y: 30 } });
		await h.page.keyboard.press("s");
		let cs = await clips();
		expect(cs.length).toBe(2);
		const right = h.page.locator(`[data-clip-id="${cs[1].id}"]`);
		box = (await right.boundingBox())!;
		await h.page.mouse.move(box.x + 30, y);
		await h.page.mouse.down();
		await h.page.mouse.move(box.x + 30 + 9 * 4, y, { steps: 6 });
		await h.page.mouse.up();
		cs = await clips();
		expect(cs[1].startBeat % 1).not.toBe(0); // the cut is between beats, and stays there
		expect(barLine(cs[1], t)).toBeCloseTo(12, 3); // both halves went along, bar line to bar line
		expect(barLine(cs[0], t)).toBeCloseTo(12, 3);
	});

	it("plays a Rekordbox track with its bar lines on the project's bars", async () => {
		await newSet();
		await state(h.page, "s => { window.planner.store.set({ pxPerBeat: 12, scrollX: 0 }); return 0; }");
		// a quiet click on every beat from beat 0 marks the project grid
		await importTrack(h.page, f.plain, 128, 0, 0);
		expect(await drop(f.a, 1, 4)).toBe("placed");
		await waitReady(h.page);
		await h.page.evaluate(() => {
			const w = window as any;
			w.rec = [];
			w.planner.engine.tap = (ctx: AudioContext, node: AudioNode) => {
				const sp = ctx.createScriptProcessor(4096, 2, 2);
				sp.onaudioprocess = (e: AudioProcessingEvent) => w.rec.push(new Float32Array(e.inputBuffer.getChannelData(0)));
				node.connect(sp);
				sp.connect(ctx.destination);
			};
		});
		await h.page.getByTestId("ruler").click({ position: { x: 1, y: 10 } });
		expect(await state(h.page, "s => s.playheadBeat")).toBe(0);
		await h.page.keyboard.press("Space");
		await h.page.waitForTimeout(9000);
		await h.page.keyboard.press("Space");
		const rec: number[] = await h.page.evaluate(() => {
			const w = window as any;
			const out: number[] = [];
			for (const c of w.rec) for (const v of c) out.push(v);
			return out;
		});
		const x = Float32Array.from(rec);
		const all = onsets(x, 0.08, 0.1);
		const origin = all[0]; // the grid's click on beat 0
		const loud = onsets(x, 0.4, 0.1).map((o) => (o - origin) / BEAT);
		const beatErr = all.map((o) => Math.abs((o - origin) / BEAT - Math.round((o - origin) / BEAT)) * BEAT_SEC * 1000);
		console.log("live playback: clicks", all.length, "bar clicks at beats", loud.map((b) => b.toFixed(3)).join(" "), "worst beat error (ms)", Math.max(...beatErr).toFixed(3));
		expect(loud.length).toBeGreaterThanOrEqual(3);
		expect(loud[0]).toBeCloseTo(4, 1); // first bar line of the track, where it was dropped
		for (const b of loud) expect(offGrid(b, 4) * BEAT_SEC * 1000).toBeLessThan(1);
		expect(Math.max(...beatErr)).toBeLessThan(1);
	});

	it("gives a track that was in the set before a grid when the same file is dropped again", async () => {
		const legacy = (bpm: number): string => {
			const p = path.join(work, `legacy-${bpm}.djset`);
			const doc = { version: 1, bpm: 128, tracks: [{ id: "told", sourcePath: f.a, name: "Bar Track A", bpm, durationSec: 40 }], clips: [{ id: "cold", trackId: "told", lane: 0, startBeat: 0, offsetBeat: 0, lengthBeat: (40 * bpm) / 60 }], tempos: [] };
			fs.writeFileSync(p, JSON.stringify(doc));
			return p;
		};
		// same BPM as Rekordbox: the track gains the grid, old clips stay put
		await h.page.evaluate((p) => (window as any).planner.openSet(p), legacy(128));
		expect(await drop(f.a, 1, 16)).toBe("placed");
		let ts = await tracks();
		let cs = await clips();
		expect(ts.length).toBe(1);
		expect(ts[0].id).toBe("told");
		expect(ts[0].downbeatSec).toBeCloseTo(0.25 + 2 * BEAT_SEC, 3);
		expect(cs[0]).toMatchObject({ id: "cold", startBeat: 0, offsetBeat: 0 });
		expect(cs[1].startBeat).toBe(16);
		expect(cs[1].offsetBeat).toBeCloseTo((0.25 + 2 * BEAT_SEC) / BEAT_SEC, 3);

		// typed a different BPM back then: new clips follow Rekordbox, old ones keep their stretch
		await h.page.evaluate((p) => (window as any).planner.openSet(p), legacy(127));
		expect(await drop(f.a, 1, 16)).toBe("placed");
		ts = await tracks();
		cs = await clips();
		expect(ts.length).toBe(2);
		expect(ts[0]).toMatchObject({ id: "told", bpm: 127 });
		expect(ts[0].downbeatSec).toBeUndefined();
		expect(ts[1].bpm).toBe(128);
		expect(cs[1].trackId).toBe(ts[1].id);
		expect(cs[1].offsetBeat).toBeCloseTo((0.25 + 2 * BEAT_SEC) / BEAT_SEC, 3);
		// and a third drop reuses the Rekordbox one
		expect(await drop(f.a, 2, 32)).toBe("placed");
		expect((await tracks()).length).toBe(2);
		expect((await clips())[2].trackId).toBe(ts[1].id);
	});

	it("keeps the grid through save and reopen", async () => {
		await newSet();
		expect(await drop(f.a, 0, 8)).toBe("placed");
		const p = path.join(work, "saved.djset");
		await h.page.evaluate((file) => {
			const pl = (window as any).planner;
			pl.store.set({ filePath: file });
			return pl.saveSet();
		}, p);
		const saved = JSON.parse(fs.readFileSync(p, "utf8"));
		expect(saved.tracks[0].downbeatSec).toBeCloseTo(0.25 + 2 * BEAT_SEC, 3);
		await newSet();
		await h.page.evaluate((file) => (window as any).planner.openSet(file), p);
		const [t] = await tracks();
		const [c] = await clips();
		expect(t.downbeatSec).toBeCloseTo(0.25 + 2 * BEAT_SEC, 3);
		expect(barLine(c, t)).toBeCloseTo(8, 3);
	});

	it("finds a track that Rekordbox analysed after the app started", async () => {
		await newSet();
		await h.page.waitForTimeout(2200);
		writeAnalysis(root, "?/Late.wav", gridBeats(128, 0.3, 4, beatCount(20, 128, 0.3)), waveformOf(f.late));
		expect(await drop(f.late, 0, 0)).toBe("placed");
		const [t] = await tracks();
		expect(Math.abs(t.downbeatSec - (0.3 + BEAT_SEC)) * 1000).toBeLessThan(GRID_MS);
		const cache = JSON.parse(fs.readFileSync(path.join(h.dataDir, "rekordbox-cache.json"), "utf8"));
		expect(Object.values(cache.files as Record<string, { entry: { name: string } | null }>).some((e) => e.entry?.name === "Late.wav")).toBe(true);
	});

	it("starts from the cache next time, and picks up a grid changed in Rekordbox", async () => {
		const cache = path.join(h.dataDir, "rekordbox-cache.json");
		const before = fs.statSync(cache).mtimeMs;
		await newSet();
		expect(await drop(f.a, 0, 8)).toBe("placed");
		await h.page.waitForTimeout(700); // let the session be written
		h = await h.relaunch();
		// the restored set still has its track and grid
		expect((await tracks())[0].downbeatSec).toBeCloseTo(0.25 + 2 * BEAT_SEC, 3);
		expect(await drop(f.b, 1, 0)).toBe("placed");
		expect(fs.statSync(cache).mtimeMs).toBe(before); // nothing changed, nothing rewritten

		// the grid is moved in Rekordbox: bar lines one beat earlier
		fs.writeFileSync(dats.a, datFile("?/Bar Track A.wav", gridBeats(128, 0.25, 4, beatCount(40, 128, 0.25))));
		const later = new Date(Date.now() + 10000);
		fs.utimesSync(dats.a, later, later);
		h = await h.relaunch();
		expect(await drop(f.a, 2, 40)).toBe("placed");
		const ts = await tracks();
		const cs = await clips();
		const a = ts.find((t) => t.sourcePath === f.a);
		expect(ts.filter((t) => t.sourcePath === f.a).length).toBe(1);
		expect(a.downbeatSec).toBeCloseTo(0.25 + BEAT_SEC, 3);
		const added = cs[cs.length - 1];
		expect(added.startBeat).toBe(40);
		expect(added.offsetBeat).toBeCloseTo((0.25 + BEAT_SEC) / BEAT_SEC, 3);
		// the clip from before the change was not touched
		expect(cs[0]).toMatchObject({ startBeat: 8 });
		expect(cs[0].offsetBeat).toBeCloseTo((0.25 + 2 * BEAT_SEC) / BEAT_SEC, 3);
		expect(fs.statSync(cache).mtimeMs).toBeGreaterThan(before);
	});

	it("carries on without Rekordbox when its folder is gone or unreadable", async () => {
		await h.close();
		const empty = path.join(work, "no-such-library");
		h = await launch(undefined, work, { DJ_REKORDBOX_DIR: empty });
		expect(await drop(f.a, 0, 0)).toBe("asked");
		await h.page.getByTestId("bpm-input").fill("128");
		await h.page.getByTestId("bpm-confirm").click();
		await h.page.getByTestId("import-modal").waitFor({ state: "detached" });
		expect((await clips())[0].offsetBeat).toBe(0);
		await h.close();

		// a library full of junk, and a damaged cache file
		const junk = path.join(work, "junk", "PIONEER", "USBANLZ");
		fs.mkdirSync(path.join(junk, "abc", "def"), { recursive: true });
		fs.writeFileSync(path.join(junk, "abc", "def", "ANLZ0000.DAT"), Buffer.from("PMAI\0\0\0\x1c garbage that is not an analysis file"));
		fs.writeFileSync(path.join(junk, "abc", "def", "ANLZ0000.EXT"), Buffer.alloc(3));
		const data = fs.mkdtempSync(path.join(os.tmpdir(), "planner-data-"));
		fs.writeFileSync(path.join(data, "rekordbox-cache.json"), "{{{ not json");
		h = await launch(data, work, { DJ_REKORDBOX_DIR: junk });
		expect(await drop(f.a, 0, 0)).toBe("asked");
		await h.page.getByTestId("bpm-cancel").click();
		expect(JSON.parse(fs.readFileSync(path.join(data, "rekordbox-cache.json"), "utf8")).root).toBe(junk);
	});
});
