// Playback under tempo changes: clips after a change are heard at the new tempo with their
// pitch held, the ramp itself is key-locked too, and nothing drops out while the audio for
// a change is still being made.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_RATE as SR } from "../../src/shared/planner";
import { TempoMap, blocksToPoints } from "../../src/shared/tempo";
import { frequency, onsets, writeClickTrack, writeTone } from "../signals";
import { importTrack, launch, shot, state, waitReady, waitTempoReady, type Harness } from "./harness";

let h: Harness;
let cache: string;

// The set: clicks at 120 BPM on lane 0 from the start, clicks at 140 BPM on lane 1 from beat
// 64, and a steady 440 Hz tone on lane 2 throughout. The tempo goes from 128 to 140 between
// beats 16 and 32.
const BLOCK = { startBeat: 16, lengthBeat: 16, bpm: 140 };
const map = new TempoMap(blocksToPoints([BLOCK], 128), 128);

beforeAll(async () => {
	h = await launch();
	cache = path.join(h.dataDir, "planner-cache");
	const a = path.join(h.workDir, "clicks-120.wav");
	const b = path.join(h.workDir, "clicks-140.wav");
	const t = path.join(h.workDir, "tone.wav");
	writeClickTrack(a, 120, 90);
	writeClickTrack(b, 140, 40, { clickHz: 2500 });
	writeTone(t, 440, 90);
	await importTrack(h.page, a, 120, 0, 0);
	await importTrack(h.page, b, 140, 1, 64);
	await importTrack(h.page, t, 100, 2, 0);
	await waitReady(h.page);
	await h.page.keyboard.press("Meta+0");
	await h.page.evaluate(() => {
		const w = window as any;
		w.rec = [];
		w.recMetro = [];
		w.planner.engine.tap = (ctx: AudioContext, node: AudioNode, metro: AudioNode) => {
			const sp = ctx.createScriptProcessor(4096, 2, 2);
			sp.onaudioprocess = (e: AudioProcessingEvent) => {
				w.rec.push(new Float32Array(e.inputBuffer.getChannelData(0)));
				w.recMetro.push(new Float32Array(e.inputBuffer.getChannelData(1)));
			};
			// music on the left input, the metronome on the right
			const merge = ctx.createChannelMerger(2);
			const mono = (n: AudioNode): AudioNode => {
				const g = ctx.createGain();
				g.channelCount = 1;
				g.channelCountMode = "explicit";
				n.connect(g);
				return g;
			};
			mono(node).connect(merge, 0, 0);
			mono(metro).connect(merge, 0, 1);
			merge.connect(sp);
			sp.connect(ctx.destination);
		};
	});
});
afterAll(async () => {
	await h?.close();
});

async function recorded(which: "rec" | "recMetro" = "rec"): Promise<Float32Array> {
	const rec: number[] = await h.page.evaluate((k) => {
		const w = window as any;
		const out: number[] = [];
		for (const c of w[k]) for (const v of c) out.push(v);
		w.rec = [];
		w.recMetro = [];
		return out;
	}, which);
	return Float32Array.from(rec);
}

const setTempos = (blocks: object[]): Promise<number> => state(h.page, `s => { window.planner.store.commit({ ...s.doc, tempos: ${JSON.stringify(blocks)} }); return 0; }`);
const mute = (lanes: number[]): Promise<void> =>
	h.page.evaluate((ls) => {
		const p = (window as any).planner;
		p.store.set({ laneMuted: [0, 1, 2, 3].map((i) => ls.includes(i)) });
		p.engine.applyMutes();
	}, lanes);
const seek = (beat: number): Promise<void> => h.page.evaluate((b) => (window as any).planner.engine.seek(b), beat);
const playing = (): Promise<boolean> => state(h.page, "s => s.playing");
const playhead = async (): Promise<number> => Number(await h.page.getByTestId("playhead").getAttribute("data-beat"));

// Plays from a whole beat for a while and returns what came out, starting at the first click.
async function playFrom(beat: number, ms: number, which: "rec" | "recMetro" = "rec"): Promise<Float32Array> {
	if (await playing()) await h.page.keyboard.press("Space");
	await seek(beat);
	await h.page.waitForTimeout(400);
	await recorded();
	await h.page.keyboard.press("Space");
	await h.page.waitForTimeout(ms);
	expect(await playing()).toBe(true);
	await h.page.keyboard.press("Space");
	return recorded(which);
}

// Clicks sit on whole beats of the set. With playback started on beat `from`, the first click
// heard is that beat; every later one must fall where the tempo curve puts a whole beat.
function clickErrors(x: Float32Array, from: number, m: TempoMap = map, threshold = 0.12): { n: number; worstMs: number; lastBeat: number } {
	const on = onsets(x, threshold, 0.05);
	if (on.length < 2) return { n: on.length, worstMs: Infinity, lastBeat: from };
	const t0 = m.secondsAtBeat(from) - on[0] / SR;
	let worst = 0;
	let lastBeat = from;
	for (const o of on) {
		const sec = t0 + o / SR;
		lastBeat = Math.round(m.beatAtSeconds(sec));
		worst = Math.max(worst, Math.abs(m.secondsAtBeat(lastBeat) - sec));
	}
	return { n: on.length, worstMs: worst * 1000, lastBeat };
}

// Loudness in 50 ms windows across a stretch of the recording; a dropout shows as a dip. (A
// crossfade between two renderings of a pure tone can cancel for a few milliseconds, which
// music does not do; windows this long look past that and still catch a real gap.)
function steadiness(x: Float32Array, fromSec: number, toSec: number): { min: number; max: number } {
	const win = Math.round(0.05 * SR);
	let min = Infinity;
	let max = 0;
	for (let i = Math.round(fromSec * SR); i + win < Math.round(toSec * SR); i += win) {
		let s = 0;
		for (let k = i; k < i + win; k++) s += x[k] * x[k];
		const rms = Math.sqrt(s / win);
		min = Math.min(min, rms);
		max = Math.max(max, rms);
	}
	return { min, max };
}

const cacheFiles = (): string[] => fs.readdirSync(cache).filter((f) => f.endsWith(".wav"));

describe("tempo changes in playback", () => {
	it("with no tempo change, plays as before", async () => {
		await mute([2]);
		const g = clickErrors(await playFrom(0, 4000), 0, new TempoMap([], 128));
		console.log("no tempo change: clicks", g.n, "worst error (ms)", g.worstMs.toFixed(3));
		expect(g.n).toBeGreaterThan(6);
		expect(g.worstMs).toBeLessThan(3);
		expect(cacheFiles().filter((f) => f.startsWith("ramp-"))).toEqual([]);
	});

	it("makes the audio each clip needs under a tempo change, and says so meanwhile", async () => {
		const before = cacheFiles().length;
		await setTempos([{ id: "b1", ...BLOCK }]);
		// the clips that play under the change say they are being worked on; the others do not
		await h.page.getByTestId("tempo-working").waitFor();
		expect(await h.page.getByTestId("clip-tempo").count()).toBeGreaterThan(0);
		await shot(h.page, "tempo-01-preparing");
		await waitTempoReady(h.page);
		await expect.poll(() => h.page.getByTestId("tempo-working").count()).toBe(0);
		expect(await h.page.getByTestId("clip-tempo").count()).toBe(0);
		// lanes 0 and 2 cross the ramp: each gets a ramp and a version at 140. Lane 1 lies
		// after it: a version at 140 only.
		const files = cacheFiles();
		expect(files.filter((f) => f.startsWith("ramp-")).length).toBe(2);
		expect(files.filter((f) => f.endsWith("-140.wav")).length).toBe(3);
		expect(files.length).toBe(before + 5);
		expect(fs.readdirSync(cache).filter((f) => f.includes(".part.") || f.endsWith(".work"))).toEqual([]);
		// every clip still shows its waveform and is ready
		expect(await h.page.locator('[data-testid="clip"][data-status="ready"]').count()).toBe(3);
		await shot(h.page, "tempo-02-ready");
	});

	it("plays through the change on the tempo curve: before, during and after", async () => {
		await mute([2]);
		const x = await playFrom(8, 16000);
		const g = clickErrors(x, 8);
		console.log("through the ramp: clicks", g.n, "last beat", g.lastBeat, "worst error (ms)", g.worstMs.toFixed(3));
		// 16 s from beat 8 reaches about beat 44 on the curve; at a steady 128 it would be 42
		expect(g.lastBeat).toBeGreaterThanOrEqual(43);
		expect(g.n).toBeGreaterThanOrEqual(g.lastBeat - 8);
		expect(g.worstMs).toBeLessThan(3);
	});

	it("starts in the middle of the ramp, and where two clips overlap after it, in time", async () => {
		await mute([2]);
		let g = clickErrors(await playFrom(22, 5000), 22);
		console.log("from inside the ramp: clicks", g.n, "worst error (ms)", g.worstMs.toFixed(3));
		expect(g.n).toBeGreaterThan(8);
		expect(g.worstMs).toBeLessThan(3);
		// both click tracks sound from beat 64 on: every click of either is on the 140 grid
		g = clickErrors(await playFrom(60, 6000), 60);
		console.log("two clips at 140: clicks", g.n, "worst error (ms)", g.worstMs.toFixed(3));
		expect(g.n).toBeGreaterThan(11);
		expect(g.worstMs).toBeLessThan(3);
	});

	it("holds the pitch before, through and after the change, with no dropout at the joins", async () => {
		await mute([0, 1]);
		const x = await playFrom(8, 14000);
		const on = onsets(x, 0.05, 1);
		const t = (beat: number): number => on[0] / SR + map.secondsAtBeat(beat) - map.secondsAtBeat(8);
		for (const beat of [10, 14, 17, 22, 27, 31, 33, 36]) {
			const f = frequency(x, t(beat), 0.25);
			console.log("tone at beat", beat, "freq", f.toFixed(2));
			expect(Math.abs(f - 440)).toBeLessThan(3);
		}
		// across both joins (beats 16 and 32) the level stays put
		for (const join of [16, 32]) {
			const s = steadiness(x, t(join) - 0.3, t(join) + 0.3);
			console.log("level across the join at beat", join, "min", s.min.toFixed(4), "max", s.max.toFixed(4));
			expect(s.min / s.max).toBeGreaterThan(0.7);
		}
	});

	it("moves the playhead and the metronome along the tempo curve", async () => {
		await mute([0, 1, 2]);
		await h.page.getByTestId("metronome").click();
		const x = await playFrom(12, 12000, "recMetro");
		await h.page.getByTestId("metronome").click();
		const g = clickErrors(x, 12, map, 0.3);
		console.log("metronome: clicks", g.n, "last beat", g.lastBeat, "worst error (ms)", g.worstMs.toFixed(3));
		expect(g.lastBeat).toBeGreaterThanOrEqual(37);
		expect(g.n).toBeGreaterThanOrEqual(g.lastBeat - 12);
		expect(g.worstMs).toBeLessThan(1);
		// in the steady 140 stretch, three seconds is seven beats (6.4 at 128)
		await seek(40);
		await h.page.keyboard.press("Space");
		await h.page.waitForTimeout(500);
		const b0 = await playhead();
		const t0 = Date.now();
		await h.page.waitForTimeout(3000);
		const b1 = await playhead();
		const rate = ((b1 - b0) / (Date.now() - t0)) * 60000;
		await h.page.keyboard.press("Space");
		console.log("playhead speed after the change (BPM):", rate.toFixed(1));
		expect(Math.abs(rate - 140)).toBeLessThan(3);
		await mute([]);
	});

	it("stops by itself at the end, on the tempo curve", async () => {
		const end: number = await state(h.page, "s => Math.max(...s.doc.clips.map(c => c.startBeat + c.lengthBeat))");
		await seek(end - 4);
		await h.page.keyboard.press("Space");
		await h.page.waitForTimeout(3200);
		expect(await playing()).toBe(false);
		expect(await state<number>(h.page, "s => s.playheadBeat")).toBeCloseTo(end, 1);
	});

	it("undo goes back to the project tempo at once, and redo needs no new work", async () => {
		const files = cacheFiles().length;
		await h.page.keyboard.press("Meta+z");
		expect(await state(h.page, "s => s.doc.tempos.length")).toBe(0);
		await mute([2]);
		let g = clickErrors(await playFrom(8, 5000), 8, new TempoMap([], 128));
		expect(g.worstMs).toBeLessThan(3);
		await h.page.keyboard.press("Meta+Shift+z");
		expect(await state(h.page, "s => s.doc.tempos.length")).toBe(1);
		await waitTempoReady(h.page, 3000);
		expect(cacheFiles().length).toBe(files);
		g = clickErrors(await playFrom(28, 5000), 28);
		expect(g.worstMs).toBeLessThan(3);
		await mute([]);
	});

	it("moving a clip that crosses the ramp renders its new stretch of it", async () => {
		const ramps = cacheFiles().filter((f) => f.startsWith("ramp-")).length;
		await state(h.page, "s => { window.planner.store.commit({ ...s.doc, clips: s.doc.clips.map(c => c.lane === 0 ? { ...c, startBeat: 4 } : c) }); return 0; }");
		await waitTempoReady(h.page);
		expect(cacheFiles().filter((f) => f.startsWith("ramp-")).length).toBe(ramps + 1);
		await mute([2]);
		const g = clickErrors(await playFrom(12, 12000), 12);
		console.log("moved clip through the ramp: clicks", g.n, "worst error (ms)", g.worstMs.toFixed(3));
		expect(g.n).toBeGreaterThan(20);
		expect(g.worstMs).toBeLessThan(3);
		await h.page.keyboard.press("Meta+z");
		await waitTempoReady(h.page, 3000);
		await mute([]);
	});
});

describe("while the audio for a tempo change is still being made", () => {
	let long: string;

	const left = (): Promise<number> => h.page.evaluate(() => (window as any).planner.tempoProgress((window as any).planner.store.get().doc).left);

	it("plays in time at once, through a ramp too", async () => {
		// Long files take a while to stretch, which leaves time to listen meanwhile: a tone on
		// lane 0 and clicks on lane 1.
		long = path.join(h.workDir, "long-tone.wav");
		const clicks = path.join(h.workDir, "long-clicks.wav");
		writeTone(long, 440, 500);
		writeClickTrack(clicks, 128, 500);
		await h.page.evaluate(() => (window as any).planner.newSet());
		await importTrack(h.page, long, 128, 0, 0);
		await importTrack(h.page, clicks, 128, 1, 0);
		await waitReady(h.page);
		await mute([0]);
		// a ramp so long that its audio cannot be ready yet
		const block = { startBeat: 8, lengthBeat: 1000, bpm: 160 };
		await setTempos([{ id: "b1", ...block }]);
		const m = new TempoMap(blocksToPoints([block], 128), 128);
		const g = clickErrors(await playFrom(4, 6000), 4, m);
		expect(await left()).toBe(4); // nothing was ready: all of that was the stand-in
		console.log("stand-in audio through a ramp: clicks", g.n, "worst error (ms)", g.worstMs.toFixed(3));
		expect(g.n).toBeGreaterThan(10);
		expect(g.worstMs).toBeLessThan(3);
		await mute([1]);
	});

	it("plays at once at the right speed, then takes up the proper audio without a break", async () => {
		await setTempos([{ id: "b1", startBeat: 8, lengthBeat: 8, bpm: 160 }]);
		await seek(32);
		await h.page.waitForTimeout(300);
		await recorded();
		await h.page.keyboard.press("Space");
		await h.page.waitForTimeout(2500);
		// still being made: what plays is the 128 version run faster, so the pitch is up
		expect(await h.page.getByTestId("tempo-working").count()).toBe(1);
		expect(await h.page.getByTestId("clip-tempo").count()).toBe(2);
		const early = await recorded();
		const start = onsets(early, 0.05, 1)[0] / SR;
		const f0 = frequency(early, start + 0.5, 1);
		console.log("before the proper audio is ready: tone at", f0.toFixed(1), "Hz (pitch follows speed)");
		expect(Math.abs(f0 - (440 * 160) / 128)).toBeLessThan(4);
		// keep listening while it gets ready
		await waitTempoReady(h.page);
		await h.page.waitForTimeout(1500);
		expect(await playing()).toBe(true);
		const x = await recorded();
		await h.page.keyboard.press("Space");
		const len = x.length / SR;
		const f1 = frequency(x, len - 1, 0.5);
		console.log("after: tone at", f1.toFixed(1), "Hz");
		expect(Math.abs(f1 - 440)).toBeLessThan(3);
		// no gap anywhere while it changed over
		const s = steadiness(x, 0.2, len - 0.2);
		console.log("level through the change-over: min", s.min.toFixed(4), "max", s.max.toFixed(4));
		expect(s.min / s.max).toBeGreaterThan(0.6);
		expect(await h.page.getByTestId("clip-tempo").count()).toBe(0);
	});

	it("drops the work for a tempo that was changed again before it was done", async () => {
		const running = (): string => execSync(`pgrep -fl "rubberband-r3.*${path.basename(h.dataDir)}" || true`).toString().trim();
		await setTempos([{ id: "b1", startBeat: 8, lengthBeat: 8, bpm: 150 }]);
		await expect.poll(running, { timeout: 15000 }).toContain("rubberband");
		// change it again straight away, twice
		await setTempos([{ id: "b1", startBeat: 8, lengthBeat: 8, bpm: 151 }]);
		await setTempos([{ id: "b1", startBeat: 8, lengthBeat: 8, bpm: 152 }]);
		await waitTempoReady(h.page);
		const files = cacheFiles();
		expect(files.filter((f) => f.endsWith("-152.wav")).length).toBe(2);
		expect(files.filter((f) => f.endsWith("-150.wav") || f.endsWith("-151.wav"))).toEqual([]);
		expect(running()).toBe("");
		expect(fs.readdirSync(cache).filter((f) => f.includes(".part.") || f.endsWith(".work"))).toEqual([]);
		expect(await h.page.locator('[data-testid="clip"][data-status="error"]').count()).toBe(0);
		// going back to a tempo that was dropped part-way makes it again
		await setTempos([{ id: "b1", startBeat: 8, lengthBeat: 8, bpm: 150 }]);
		await waitTempoReady(h.page);
		expect(cacheFiles().filter((f) => f.endsWith("-150.wav")).length).toBe(2);
	});

	it("deleting the tempo change stops the work for it", async () => {
		await setTempos([{ id: "b1", startBeat: 8, lengthBeat: 8, bpm: 145 }]);
		await h.page.getByTestId("tempo-working").waitFor();
		await setTempos([]);
		await expect.poll(() => h.page.getByTestId("tempo-working").count()).toBe(0);
		await h.page.waitForTimeout(2500);
		expect(execSync(`pgrep -fl "rubberband-r3.*${path.basename(h.dataDir)}" || true`).toString().trim()).toBe("");
		expect(cacheFiles().filter((f) => f.endsWith("-145.wav"))).toEqual([]);
		expect(fs.readdirSync(cache).filter((f) => f.includes(".part.") || f.endsWith(".work"))).toEqual([]);
	});
});
