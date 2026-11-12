// An hour-long, 65-track set built from real music: load time, memory, playback start
// time, and export time.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SAMPLE_RATE as SR } from "../../src/shared/planner";
import { TempoMap } from "../../src/shared/tempo";
import { WavReader } from "../../src/main/audio/wav";
import { APP_DIR, exportTo, launch, shot, state, waitReady, type Harness } from "./harness";

const STORE = path.resolve(APP_DIR, "../store");
const TRACKS = 65;
let h: Harness;

beforeAll(async () => {
	h = await launch();
});
afterAll(async () => {
	await h?.close();
});

async function memoryMb(): Promise<{ renderer: number; total: number }> {
	const metrics = await h.app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, kb: m.memory.workingSetSize })));
	const renderer = Math.max(...metrics.filter((m) => m.type === "Tab").map((m) => m.kb));
	return { renderer: Math.round(renderer / 1024), total: Math.round(metrics.reduce((s, m) => s + m.kb, 0) / 1024) };
}

it("handles a 65-track, one-hour set", async () => {
	const sources = fs.readdirSync(STORE).filter((f) => /\.(mp3|wav)$/i.test(f));
	expect(sources.length).toBeGreaterThan(0);
	const files: string[] = [];
	for (let i = 0; i < TRACKS; i++) {
		const src = sources[i % sources.length];
		const dst = path.join(h.workDir, `track-${String(i + 1).padStart(2, "0")}${path.extname(src)}`);
		fs.copyFileSync(path.join(STORE, src), dst);
		files.push(dst);
	}

	// Build the set the way a user would: every file goes through import and the BPM prompt.
	const t0 = Date.now();
	const spacing = 118;
	for (let i = 0; i < TRACKS; i++) {
		await h.page.evaluate(([f, lane, beat]) => (window as any).planner.importPaths([f], lane, beat), [files[i], i % 4, i * spacing] as const);
		await h.page.getByTestId("bpm-input").fill(String(120 + (i % 9) * 2.5));
		await h.page.getByTestId("bpm-confirm").click();
		await h.page.getByTestId("import-modal").waitFor({ state: "detached" });
	}
	// Trim every clip to 150 beats starting 16 beats in, like a real set.
	await state(h.page, "s => { window.planner.store.commit({ ...s.doc, clips: s.doc.clips.map(c => ({ ...c, offsetBeat: 16, lengthBeat: Math.min(150, c.lengthBeat - 16) })) }); return 0; }");
	await h.page.keyboard.press("Meta+0");
	await shot(h.page, "stress-01-stretching");
	await waitReady(h.page, 1500000);
	console.log("import + stretch of", TRACKS, "tracks (s):", ((Date.now() - t0) / 1000).toFixed(1));
	await shot(h.page, "stress-02-ready");
	const errors: number = await h.page.locator('[data-testid="clip"][data-status="error"]').count();
	expect(errors).toBe(0);
	const endBeat: number = await state(h.page, "s => Math.max(...s.doc.clips.map(c => c.startBeat + c.lengthBeat))");
	console.log("set length (min):", ((endBeat * 60) / 128 / 60).toFixed(1));
	expect((endBeat * 60) / 128).toBeGreaterThan(3500);
	console.log("memory idle (MB):", JSON.stringify(await memoryMb()));

	// Jump around the set and play; measure how long each start takes and that it keeps running.
	for (const frac of [0, 0.25, 0.5, 0.75, 0.97, 0.1]) {
		const beat = Math.floor(endBeat * frac);
		const started = await h.page.evaluate(async (b) => {
			const p = (window as any).planner;
			p.engine.stop();
			p.engine.seek(b);
			const t = performance.now();
			void p.engine.play();
			while (p.engine.debug().sources === 0) await new Promise((r) => setTimeout(r, 5));
			return performance.now() - t;
		}, beat);
		await h.page.waitForTimeout(2500);
		const pos = Number(await h.page.getByTestId("playhead").getAttribute("data-beat"));
		const dbg = await h.page.evaluate(() => (window as any).planner.engine.debug());
		console.log(`play from beat ${beat}: start ${started.toFixed(0)} ms, advanced ${(pos - beat).toFixed(2)} beats, buffers ${dbg.buffers}, sources ${dbg.sources}, memory`, JSON.stringify(await memoryMb()));
		expect(pos - beat).toBeGreaterThan(3.5);
		expect(pos - beat).toBeLessThan(7);
	}
	// Play straight through a few transitions quickly by seeking just before each one.
	await h.page.evaluate(() => (window as any).planner.engine.stop());
	await shot(h.page, "stress-03-after-play");

	// Zoom and scroll performance: time a burst of scroll and zoom changes.
	const frameMs = await h.page.evaluate(async () => {
		const p = (window as any).planner;
		const times: number[] = [];
		for (let i = 0; i < 60; i++) {
			const t = performance.now();
			p.store.set({ scrollX: i * 400, pxPerBeat: 2 + (i % 10) });
			await new Promise((r) => requestAnimationFrame(() => r(null)));
			times.push(performance.now() - t);
		}
		times.sort((a, b) => a - b);
		return { median: times[30], worst: times[59] };
	});
	console.log("scroll/zoom frame time (ms):", JSON.stringify(frameMs));
	expect(frameMs.median).toBeLessThan(34);
	await h.page.keyboard.press("Meta+0");

	// Tempo ramp over the middle of the set, then a full key-locked export.
	await state(h.page, "s => { window.planner.store.commit({ ...s.doc, tempos: [{ id: 'b1', startBeat: 2000, lengthBeat: 3000, bpm: 150 }] }); return 0; }");
	await shot(h.page, "stress-04-tempo");
	for (const keyLock of [false, true]) {
		const out = path.join(h.workDir, keyLock ? "set-key.wav" : "set-vari.wav");
		const t1 = Date.now();
		await exportTo(h.page, out, keyLock);
		await h.page.locator('[data-testid="export-done"], [data-testid="export-error"]').first().waitFor({ timeout: 1800000 });
		expect(await h.page.getByTestId("export-done").count()).toBe(1);
		console.log(`export ${keyLock ? "key lock" : "varispeed"} (s):`, ((Date.now() - t1) / 1000).toFixed(1), "file MB:", Math.round(fs.statSync(out).size / 1e6));
		await h.page.getByTestId("export-close").click();
		const map = new TempoMap(
			[
				{ beat: 2000, bpm: 128 },
				{ beat: 5000, bpm: 150 },
			],
			128,
		);
		const r = new WavReader(out);
		const seconds = r.frames / SR;
		// no silence holes or NaNs: check level in a few windows
		const buf = new Float32Array(SR * 2);
		for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
			r.read(Math.floor(r.frames * f), SR, buf);
			let sum = 0;
			let peak = 0;
			for (let i = 0; i < SR * 2; i++) {
				expect(Number.isFinite(buf[i])).toBe(true);
				sum += buf[i] * buf[i];
				peak = Math.max(peak, Math.abs(buf[i]));
			}
			const rms = Math.sqrt(sum / (SR * 2));
			expect(rms).toBeGreaterThan(0.005);
			expect(peak).toBeLessThanOrEqual(1);
		}
		r.close();
		console.log("exported length (min):", (seconds / 60).toFixed(2), "expected:", (map.secondsAtBeat(endBeat) / 60).toFixed(2));
		expect(Math.abs(seconds - map.secondsAtBeat(endBeat))).toBeLessThan(0.05);
	}
	console.log("memory after export (MB):", JSON.stringify(await memoryMb()));
});
