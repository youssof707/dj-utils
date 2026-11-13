import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_RATE as SR } from "../../src/shared/planner";
import { TempoMap, blocksToPoints } from "../../src/shared/tempo";
import { frequency, onsets, readAll, writeClickTrack, writeTone } from "../signals";
import { exportTo, importTrack, launch, setFile, shot, state, stored, waitReady, type Harness } from "./harness";

let h: Harness;
let a: string;
let b: string;

beforeAll(async () => {
	h = await launch();
	a = path.join(h.workDir, "click-120.wav");
	b = path.join(h.workDir, "click-140.wav");
	writeClickTrack(a, 120, 40);
	writeClickTrack(b, 140, 40, { clickHz: 2500 });
});
afterAll(async () => {
	await h?.close();
});

const clips = (): Promise<any[]> => state(h.page, "s => s.doc.clips");
const BEAT = (60 / 128) * SR;

describe("planner", () => {
	it("starts empty", async () => {
		expect(await state(h.page, "s => s.doc.clips.length")).toBe(0);
		expect(await h.page.getByTestId("project-bpm").inputValue()).toBe("128");
		await shot(h.page, "01-empty");
	});

	it("imports tracks, asks for BPM and stretches them", async () => {
		await importTrack(h.page, a, 120, 0, 0);
		await importTrack(h.page, b, "140", 1, 8);
		await waitReady(h.page);
		const cs = await clips();
		expect(cs.length).toBe(2);
		expect(cs[0].lengthBeat).toBeCloseTo(80, 3); // 40 s at 120 BPM
		expect(cs[1].lengthBeat).toBeCloseTo((40 * 140) / 60, 3);
		expect(cs[1].startBeat).toBe(8);
		await h.page.keyboard.press("Meta+0");
		await shot(h.page, "02-imported");
	});

	it("rejects a bad BPM and lets the import be skipped", async () => {
		await h.page.evaluate((f) => (window as any).planner.importPaths([f], 2, 0), path.join(h.workDir, "click-120.wav").replace("120", "x"));
		await h.page.getByTestId("toast").waitFor();
		const c = path.join(h.workDir, "third.wav");
		writeClickTrack(c, 100, 5);
		await h.page.evaluate((f) => (window as any).planner.importPaths([f], 2, 0), c);
		await h.page.getByTestId("import-modal").waitFor();
		await h.page.getByTestId("bpm-input").fill("abc");
		await h.page.getByTestId("bpm-confirm").click();
		expect(await h.page.getByTestId("import-modal").isVisible()).toBe(true);
		await h.page.getByTestId("bpm-cancel").click();
		await h.page.getByTestId("import-modal").waitFor({ state: "detached" });
		expect((await clips()).length).toBe(2);
	});

	it("plays both tracks in sync on the shared clock", async () => {
		// Record what actually reaches the output.
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
		await h.page.getByTestId("ruler").click({ position: { x: 2, y: 10 } });
		await h.page.keyboard.press("Space");
		await h.page.waitForTimeout(8000);
		expect(await state(h.page, "s => s.playing")).toBe(true);
		const beat = Number(await h.page.getByTestId("playhead").getAttribute("data-beat"));
		expect(beat).toBeGreaterThan(14);
		expect(beat).toBeLessThan(19);
		await shot(h.page, "03-playing");
		await h.page.keyboard.press("Space");
		expect(await state(h.page, "s => s.playing")).toBe(false);
		const rec: number[] = await h.page.evaluate(() => {
			const w = window as any;
			const out: number[] = [];
			for (const c of w.rec) for (const v of c) out.push(v);
			return out;
		});
		const x = Float32Array.from(rec);
		const on = onsets(x, 0.12, 0.05);
		expect(on.length).toBeGreaterThan(12);
		// Every click from either track sits on one beat grid.
		const origin = on[0];
		const errs = on.map((o) => {
			const rel = (o - origin) / BEAT;
			return Math.abs(rel - Math.round(rel)) * BEAT;
		});
		console.log("live playback: clicks", on.length, "worst grid error (ms)", ((Math.max(...errs) / SR) * 1000).toFixed(3));
		expect(Math.max(...errs) / SR).toBeLessThan(0.003);
	});

	it("drags a clip to another lane and time", async () => {
		const el = h.page.locator('[data-testid="clip"]').nth(1);
		const box = (await el.boundingBox())!;
		const lane3 = (await h.page.getByTestId("lane-3").boundingBox())!;
		const ppb: number = await state(h.page, "s => s.pxPerBeat");
		await h.page.mouse.move(box.x + 60, box.y + box.height / 2);
		await h.page.mouse.down();
		await h.page.mouse.move(box.x + 60 + 40, box.y + box.height / 2 + 20, { steps: 4 });
		await h.page.mouse.move(box.x + 60 + 16 * ppb, lane3.y + lane3.height / 2, { steps: 8 });
		await h.page.mouse.up();
		const cs = await clips();
		expect(cs[1].lane).toBe(3);
		expect(cs[1].startBeat).toBeCloseTo(24, 1);
		await shot(h.page, "04-dragged");
	});

	it("trims both edges", async () => {
		const ppb: number = await state(h.page, "s => s.pxPerBeat");
		const el = h.page.locator('[data-testid="clip"]').first();
		let box = (await el.boundingBox())!;
		const y = box.y + box.height / 2;
		// right edge in by 20 beats
		await h.page.mouse.move(box.x + box.width - 2, y);
		await h.page.mouse.down();
		await h.page.mouse.move(box.x + box.width - 2 - 20 * ppb, y, { steps: 6 });
		await h.page.mouse.up();
		// left edge in by 8 beats
		box = (await el.boundingBox())!;
		await h.page.mouse.move(box.x + 2, y);
		await h.page.mouse.down();
		await h.page.mouse.move(box.x + 2 + 8 * ppb, y, { steps: 6 });
		await h.page.mouse.up();
		const c = (await clips())[0];
		expect(c.lengthBeat).toBeCloseTo(52, 0);
		expect(c.offsetBeat).toBeCloseTo(8, 0);
		expect(c.startBeat).toBeCloseTo(8, 0);
		expect(c.startBeat).toBeCloseTo(c.offsetBeat, 6);
		// cannot be dragged out past the start of the audio
		box = (await el.boundingBox())!;
		await h.page.mouse.move(box.x + 2, y);
		await h.page.mouse.down();
		await h.page.mouse.move(box.x - 400, y, { steps: 6 });
		await h.page.mouse.up();
		const c2 = (await clips())[0];
		expect(c2.offsetBeat).toBeCloseTo(0, 6);
		expect(c2.startBeat).toBeCloseTo(0, 6);
		await h.page.keyboard.press("Meta+z");
		expect((await clips())[0].offsetBeat).toBeCloseTo(c.offsetBeat, 6);
		await shot(h.page, "05-trimmed");
	});

	it("splits, duplicates, deletes and undoes", async () => {
		const ppb: number = await state(h.page, "s => s.pxPerBeat");
		const sx: number = await state(h.page, "s => s.scrollX");
		const ruler = (await h.page.getByTestId("ruler").boundingBox())!;
		await h.page.mouse.click(ruler.x + 30 * ppb - sx, ruler.y + 10);
		expect(await state(h.page, "s => s.playheadBeat")).toBeCloseTo(30, 0);
		await h.page.locator('[data-testid="clip"]').first().click({ position: { x: 30, y: 30 } });
		await h.page.keyboard.press("Meta+s");
		let cs = await clips();
		expect(cs.length).toBe(3);
		const parts = cs.filter((c) => c.lane === 0).sort((p, q) => p.startBeat - q.startBeat);
		expect(parts[0].startBeat + parts[0].lengthBeat).toBeCloseTo(parts[1].startBeat, 6);
		expect(parts[1].offsetBeat - parts[0].offsetBeat).toBeCloseTo(parts[0].lengthBeat, 6);
		await h.page.keyboard.press("Meta+d");
		cs = await clips();
		expect(cs.length).toBe(5);
		await h.page.keyboard.press("Backspace");
		expect((await clips()).length).toBe(3);
		await h.page.keyboard.press("Meta+z");
		expect((await clips()).length).toBe(5);
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		expect((await clips()).length).toBe(2);
		await h.page.keyboard.press("Meta+Shift+z");
		expect((await clips()).length).toBe(3);
		await h.page.keyboard.press("Meta+z");
		expect((await clips()).length).toBe(2);
	});

	it("exports a mix whose clicks all land on the grid", async () => {
		const out = path.join(h.workDir, "flat.wav");
		await exportTo(h.page, out, true);
		await h.page.getByTestId("export-done").waitFor({ timeout: 120000 });
		await shot(h.page, "06-exported");
		await h.page.getByTestId("export-close").click();
		const cs = await clips();
		const end = Math.max(...cs.map((c) => c.startBeat + c.lengthBeat));
		const { left, frames } = readAll(out);
		expect(Math.abs(frames - end * BEAT)).toBeLessThan(3);
		const on = onsets(left, 0.15, 0.05);
		expect(on.length).toBeGreaterThan(60);
		const errs = on.map((o) => Math.abs(o / BEAT - Math.round(o / BEAT)) * BEAT);
		console.log("export: clicks", on.length, "worst grid error (ms)", ((Math.max(...errs) / SR) * 1000).toFixed(3));
		expect(Math.max(...errs) / SR).toBeLessThan(0.003);
	});

	it("adds tempo changes, and exports them", async () => {
		const lane = (await h.page.getByTestId("tempo-lane").boundingBox())!;
		const ppb: number = await state(h.page, "s => s.pxPerBeat");
		const tempos = (): Promise<any[]> => state(h.page, "s => s.doc.tempos.map(t => ({ startBeat: t.startBeat, lengthBeat: t.lengthBeat, bpm: t.bpm }))");
		// a new change starts at the tempo already playing there, with its BPM box ready to type in
		await h.page.mouse.dblclick(lane.x + 16 * ppb, lane.y + 44);
		expect(await tempos()).toEqual([{ startBeat: 16, lengthBeat: 4, bpm: 128 }]);
		await expect.poll(() => h.page.evaluate(() => document.activeElement === document.querySelector('[data-testid="tempo-bpm"]'))).toBe(true);
		await h.page.getByTestId("tempo-bpm").fill("150");
		await h.page.getByTestId("tempo-bpm").press("Enter");
		expect(await tempos()).toEqual([{ startBeat: 16, lengthBeat: 4, bpm: 150 }]);
		// stretch the ramp out to 32 beats by its right edge
		const block = h.page.getByTestId("tempo-block").first();
		let bb = (await block.boundingBox())!;
		await h.page.mouse.move(bb.x + bb.width - 2, bb.y + bb.height / 2);
		await h.page.mouse.down();
		await h.page.mouse.move(bb.x + bb.width - 2 + 28 * ppb, bb.y + bb.height / 2, { steps: 6 });
		await h.page.mouse.up();
		expect(await tempos()).toEqual([{ startBeat: 16, lengthBeat: 32, bpm: 150 }]);
		await shot(h.page, "07-tempo");
		// drag the whole change along and undo
		bb = (await block.boundingBox())!;
		await h.page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
		await h.page.mouse.down();
		await h.page.mouse.move(bb.x + bb.width / 2 + 8 * ppb, bb.y + bb.height / 2 + 30, { steps: 5 });
		await h.page.mouse.up();
		expect(await tempos()).toEqual([{ startBeat: 24, lengthBeat: 32, bpm: 150 }]);
		await h.page.keyboard.press("Meta+z");
		expect(await tempos()).toEqual([{ startBeat: 16, lengthBeat: 32, bpm: 150 }]);
		// the project BPM is where the set starts; the changes take it from there
		expect(await state(h.page, "s => s.doc.bpm")).toBe(128);
		const pts = blocksToPoints(await state<any[]>(h.page, "s => s.doc.tempos"), 128);
		expect(pts.map((q) => ({ beat: q.beat, bpm: q.bpm }))).toEqual([
			{ beat: 16, bpm: 128 },
			{ beat: 48, bpm: 150 },
		]);

		const cs = await clips();
		const end = Math.max(...cs.map((c) => c.startBeat + c.lengthBeat));
		const map = new TempoMap(pts, 128);
		for (const keyLock of [false, true]) {
			const out = path.join(h.workDir, keyLock ? "key.wav" : "vari.wav");
			await exportTo(h.page, out, keyLock);
			await h.page.getByTestId("export-done").waitFor({ timeout: 180000 });
			await h.page.getByTestId("export-close").click();
			const { left, frames } = readAll(out);
			expect(Math.abs(frames / SR - map.secondsAtBeat(end))).toBeLessThan(0.02);
			const on = onsets(left, 0.15, 0.05);
			// each click sits at the exported time of a whole beat
			let worst = 0;
			for (const o of on) {
				const beat = map.beatAtSeconds(o / SR);
				worst = Math.max(worst, Math.abs(map.secondsAtBeat(Math.round(beat)) - o / SR));
			}
			console.log(keyLock ? "key lock" : "varispeed", "export: clicks", on.length, "worst error (ms)", (worst * 1000).toFixed(3));
			expect(on.length).toBeGreaterThan(60);
			expect(worst).toBeLessThan(keyLock ? 0.015 : 0.003);
		}
	});

	it("keeps the set by itself: through a restart, and back from another set", async () => {
		const id = await stored(h.page);
		const file = setFile(h, id);
		const before = JSON.parse(fs.readFileSync(file, "utf8")).doc;
		const now = await state<any>(h.page, "s => s.doc");
		expect(before.clips).toEqual(now.clips);
		expect(before.tempos).toEqual(now.tempos);
		expect(before.clips.length).toBeGreaterThan(0);
		h = await h.relaunch();
		expect(await state(h.page, "s => s.doc")).toEqual(before);
		await waitReady(h.page);
		await h.page.evaluate(() => (window as any).planner.newSet());
		expect((await clips()).length).toBe(0);
		await h.page.evaluate((i) => (window as any).planner.openSet(i), id);
		expect(await state(h.page, "s => s.doc")).toEqual(before);
		await waitReady(h.page);
		await shot(h.page, "08-reopened");
		// an edit is written by itself, with nothing to press; the window is titled after the set
		const onDisk = (): any => JSON.parse(fs.readFileSync(file, "utf8"));
		expect(await h.page.title()).toBe(onDisk().name);
		await h.page.locator('[data-testid="clip"]').first().click({ position: { x: 40, y: 30 } });
		await h.page.keyboard.press("Meta+d");
		await expect.poll(() => onDisk().doc.clips.length, { timeout: 5000 }).toBe(before.clips.length + 1);
		await h.page.keyboard.press("Meta+z");
		await expect.poll(() => onDisk().doc.clips.length, { timeout: 5000 }).toBe(before.clips.length);
		expect(onDisk().doc).toEqual(before);
	});

	it("opens and closes the library", async () => {
		await h.page.getByTestId("library-toggle").click();
		await h.page.getByTestId("library").waitFor();
		// tests never look at the Rekordbox library on this machine
		await h.page.getByTestId("library-missing").waitFor();
		await shot(h.page, "08b-library");
		await h.page.getByTestId("library-toggle").click();
		await h.page.getByTestId("library").waitFor({ state: "detached" });
	});

	it("changes project BPM: clips stay on their bars and are restretched", async () => {
		const before = await clips();
		await h.page.getByTestId("project-bpm").fill("100");
		await h.page.getByTestId("project-bpm").press("Enter");
		await h.page.getByTestId("project-bpm-modal").waitFor();
		expect(await state(h.page, "s => s.doc.bpm")).toBe(128);
		await shot(h.page, "09-bpm-confirm");
		await h.page.getByTestId("project-bpm-confirm").click();
		await waitReady(h.page);
		expect(await state(h.page, "s => s.doc.bpm")).toBe(100);
		expect(await clips()).toEqual(before);
		await state(h.page, "s => { window.planner.store.commit({ ...s.doc, tempos: [] }); return 0; }");
		const out = path.join(h.workDir, "bpm100.wav");
		await exportTo(h.page, out, true);
		await h.page.getByTestId("export-done").waitFor({ timeout: 120000 });
		await h.page.getByTestId("export-close").click();
		const beat = (60 / 100) * SR;
		const on = onsets(readAll(out).left, 0.15, 0.05);
		const errs = on.map((o) => Math.abs(o / beat - Math.round(o / beat)) * beat);
		console.log("100 BPM export: clicks", on.length, "worst grid error (ms)", ((Math.max(...errs) / SR) * 1000).toFixed(3));
		expect(Math.max(...errs) / SR).toBeLessThan(0.004);
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		expect(await state(h.page, "s => s.doc.bpm")).toBe(128);
		await waitReady(h.page);
	});

	it("corrects a track BPM: clip keeps its place and audio", async () => {
		const tone = path.join(h.workDir, "tone.wav");
		writeTone(tone, 440, 20);
		await h.page.evaluate(() => (window as any).planner.newSet());
		await importTrack(h.page, tone, 128, 0, 4);
		await waitReady(h.page);
		await h.page.locator('[data-testid="clip"]').first().click({ button: "right", modifiers: ["Alt"], position: { x: 40, y: 30 } });
		await h.page.getByTestId("menu-bpm").click();
		await h.page.getByTestId("bpm-input").fill("64");
		await h.page.getByTestId("bpm-confirm").click();
		await waitReady(h.page);
		const c = (await clips())[0];
		expect(c.startBeat).toBe(4);
		expect(c.lengthBeat).toBeCloseTo((20 * 64) / 60, 4);
		// half the BPM means the stretched audio is half as long, pitch unchanged
		const out = path.join(h.workDir, "tone-out.wav");
		await exportTo(h.page, out, true);
		await h.page.getByTestId("export-done").waitFor({ timeout: 120000 });
		await h.page.getByTestId("export-close").click();
		const { left, frames } = readAll(out);
		expect(frames / SR).toBeCloseTo((4 * 60) / 128 + 10, 1);
		expect(Math.abs(frequency(left, 4, 1) - 440)).toBeLessThan(3);
	});
});
