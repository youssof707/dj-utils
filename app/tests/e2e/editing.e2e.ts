import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_RATE as SR } from "../../src/shared/planner";
import { onsets, writeClickTrack } from "../signals";
import { importTrack, launch, shot, state, waitReady, type Harness } from "./harness";

let h: Harness;
const BEAT = (60 / 128) * SR;
const clips = (): Promise<any[]> => state(h.page, "s => s.doc.clips");
const playhead = async (): Promise<number> => Number(await h.page.getByTestId("playhead").getAttribute("data-beat"));

beforeAll(async () => {
	h = await launch();
	const a = path.join(h.workDir, "a.wav");
	const b = path.join(h.workDir, "b.wav");
	const c = path.join(h.workDir, "c.wav");
	writeClickTrack(a, 128, 60);
	writeClickTrack(b, 100, 60, { clickHz: 2500 });
	writeClickTrack(c, 174, 30, { clickHz: 4000 });
	await importTrack(h.page, a, 128, 0, 0);
	await importTrack(h.page, b, 100, 1, 0);
	await importTrack(h.page, c, 174, 2, 32);
	await waitReady(h.page);
	await h.page.keyboard.press("Meta+0");
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
});
afterAll(async () => {
	await h?.close();
});

async function recorded(): Promise<Float32Array> {
	const rec: number[] = await h.page.evaluate(() => {
		const w = window as any;
		const out: number[] = [];
		for (const c of w.rec) for (const v of c) out.push(v);
		w.rec = [];
		return out;
	});
	return Float32Array.from(rec);
}

function gridError(x: Float32Array): { n: number; worstMs: number } {
	const on = onsets(x, 0.1, 0.05);
	if (on.length < 2) return { n: on.length, worstMs: Infinity };
	const origin = on[0];
	let worst = 0;
	for (const o of on) {
		const rel = (o - origin) / BEAT;
		worst = Math.max(worst, Math.abs(rel - Math.round(rel)) * BEAT);
	}
	return { n: on.length, worstMs: (worst / SR) * 1000 };
}

describe("editing and playback", () => {
	it("keeps playing, in sync, when a clip is moved during playback", async () => {
		await h.page.keyboard.press("Space");
		await h.page.waitForTimeout(2000);
		await recorded();
		const before = await playhead();
		// move clip b by exactly 4 beats while playing
		await state(h.page, "s => { window.planner.store.commit({ ...s.doc, clips: s.doc.clips.map((c, i) => i === 1 ? { ...c, startBeat: c.startBeat + 4 } : c) }); return 0; }");
		await h.page.waitForTimeout(600);
		await recorded(); // drop the restart moment
		await h.page.waitForTimeout(4000);
		expect(await state(h.page, "s => s.playing")).toBe(true);
		const after = await playhead();
		// 4.6 s of wall time is about 9.8 beats; the restart must not lose or repeat time
		expect(after - before).toBeGreaterThan(9.0);
		expect(after - before).toBeLessThan(11.2);
		const g = gridError(await recorded());
		console.log("after move during playback: clicks", g.n, "worst grid error (ms)", g.worstMs.toFixed(3));
		expect(g.n).toBeGreaterThan(6);
		expect(g.worstMs).toBeLessThan(3);
		await h.page.keyboard.press("Meta+z");
	});

	it("seeks during playback and a late clip joins in sync", async () => {
		const ruler = (await h.page.getByTestId("ruler").boundingBox())!;
		const ppb: number = await state(h.page, "s => s.pxPerBeat");
		await h.page.mouse.click(ruler.x + 24 * ppb, ruler.y + 10);
		await h.page.waitForTimeout(300);
		await recorded();
		expect(await state(h.page, "s => s.playing")).toBe(true);
		const p = await playhead();
		expect(p).toBeGreaterThan(24);
		expect(p).toBeLessThan(26);
		// clip c starts at beat 32; record across its entry
		await h.page.waitForTimeout(6000);
		const g = gridError(await recorded());
		console.log("across a clip entry: clicks", g.n, "worst grid error (ms)", g.worstMs.toFixed(3));
		expect(g.worstMs).toBeLessThan(3);
		const dbg = await h.page.evaluate(() => (window as any).planner.engine.debug());
		expect(dbg.sources).toBe(3);
	});

	it("space stops where it is, and stop is silent", async () => {
		await h.page.keyboard.press("Space");
		const at = await state<number>(h.page, "s => s.playheadBeat");
		expect(await state(h.page, "s => s.playing")).toBe(false);
		await h.page.waitForTimeout(400);
		await recorded();
		await h.page.waitForTimeout(800);
		const x = await recorded();
		expect(Math.max(...x.map(Math.abs), 0)).toBeLessThan(0.001);
		expect(await playhead()).toBeCloseTo(at, 3);
		expect(at).toBeGreaterThan(30);
	});

	it("clicking a button then pressing space only toggles playback once", async () => {
		await h.page.getByTestId("to-start").click();
		expect(await state(h.page, "s => s.playheadBeat")).toBe(0);
		await h.page.getByTestId("play").click();
		await h.page.waitForTimeout(500);
		expect(await state(h.page, "s => s.playing")).toBe(true);
		await h.page.keyboard.press("Space");
		await h.page.waitForTimeout(200);
		expect(await state(h.page, "s => s.playing")).toBe(false);
		await h.page.keyboard.press("Space");
		await h.page.waitForTimeout(300);
		expect(await state(h.page, "s => s.playing")).toBe(true);
		await h.page.keyboard.press("Space");
	});

	it("stops by itself at the end of the set", async () => {
		const end: number = await state(h.page, "s => Math.max(...s.doc.clips.map(c => c.startBeat + c.lengthBeat))");
		await h.page.evaluate((b) => (window as any).planner.engine.seek(b), end - 3);
		await h.page.keyboard.press("Space");
		await h.page.waitForTimeout(3000);
		expect(await state(h.page, "s => s.playing")).toBe(false);
		expect(await state<number>(h.page, "s => s.playheadBeat")).toBeCloseTo(end, 1);
	});

	it("selects with a box and moves the group together; escape cancels a drag", async () => {
		await h.page.getByTestId("to-start").click();
		const lanes = (await h.page.getByTestId("lanes").boundingBox())!;
		const ppb: number = await state(h.page, "s => s.pxPerBeat");
		const laneH = lanes.height / 4;
		// box over lanes 1-2 from below the clips' label up to lane 1
		await h.page.mouse.move(lanes.x + 126 * ppb, lanes.y + laneH * 1.9);
		await h.page.mouse.down();
		await h.page.mouse.move(lanes.x + 20 * ppb, lanes.y + laneH * 0.5, { steps: 6 });
		await shot(h.page, "10-marquee");
		await h.page.mouse.up();
		expect(await state<string[]>(h.page, "s => s.selection")).toHaveLength(2);
		const before = await clips();
		const first = (await h.page.locator('[data-testid="clip"]').first().boundingBox())!;
		await h.page.mouse.move(first.x + 80, first.y + 40);
		await h.page.mouse.down();
		await h.page.mouse.move(first.x + 80 + 10 * ppb, first.y + 40 + laneH, { steps: 6 });
		// mid-drag: both moved one lane down and 10 beats right
		let cur = await clips();
		expect(cur[0].lane).toBe(1);
		expect(cur[1].lane).toBe(2);
		expect(cur[0].startBeat).toBeCloseTo(10, 0);
		await h.page.keyboard.press("Escape");
		await h.page.mouse.up();
		expect(await clips()).toEqual(before);
		// again, this time dropped
		await h.page.mouse.move(first.x + 80, first.y + 40);
		await h.page.mouse.down();
		await h.page.mouse.move(first.x + 80 + 10 * ppb, first.y + 40 + laneH, { steps: 6 });
		await h.page.mouse.up();
		cur = await clips();
		expect(cur[0].lane).toBe(1);
		expect(cur[1].lane).toBe(2);
		expect(cur[1].startBeat - cur[0].startBeat).toBeCloseTo(before[1].startBeat - before[0].startBeat, 6);
		// one undo step restores both
		await h.page.keyboard.press("Meta+z");
		expect(await clips()).toEqual(before);
	});

	it("cannot drag a group past the start or outside the lanes", async () => {
		await h.page.keyboard.press("Meta+a");
		expect(await state<string[]>(h.page, "s => s.selection")).toHaveLength(3);
		const before = await clips();
		const first = (await h.page.locator('[data-testid="clip"]').first().boundingBox())!;
		await h.page.mouse.move(first.x + 200, first.y + 40);
		await h.page.mouse.down();
		await h.page.mouse.move(first.x - 300, first.y + 900, { steps: 6 });
		await h.page.mouse.up();
		const cur = await clips();
		expect(Math.min(...cur.map((c) => c.startBeat))).toBe(0);
		expect(cur.map((c) => c.lane)).toEqual([1, 2, 3]);
		expect(cur[2].startBeat - cur[0].startBeat).toBeCloseTo(before[2].startBeat - before[0].startBeat, 6);
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Escape");
	});

	it("split from the context menu, then trim the two halves apart", async () => {
		const ruler = (await h.page.getByTestId("ruler").boundingBox())!;
		const ppb: number = await state(h.page, "s => s.pxPerBeat");
		await h.page.mouse.click(ruler.x + 40 * ppb, ruler.y + 10);
		await h.page.locator('[data-testid="clip"]').first().click({ button: "right", modifiers: ["Alt"], position: { x: 50, y: 40 } });
		await shot(h.page, "11-menu");
		await h.page.getByTestId("menu-split").click();
		const cs = await clips();
		expect(cs.length).toBe(4);
		const halves = cs.filter((c) => c.lane === 0).sort((p, q) => p.startBeat - q.startBeat);
		expect(halves[0].lengthBeat).toBeCloseTo(40, 0);
		expect(halves[1].startBeat).toBeCloseTo(40, 0);
		expect(halves[1].offsetBeat).toBeCloseTo(40, 0);
		await h.page.keyboard.press("Meta+z");
		expect((await clips()).length).toBe(3);
	});

	it("right-click deletes a clip; right-drag deletes every clip it crosses as one undo step", async () => {
		const before = await clips();
		const lanes = (await h.page.getByTestId("lanes").boundingBox())!;
		const ppb: number = await state(h.page, "s => s.pxPerBeat");
		const laneH = lanes.height / 4;
		const third = before.find((c) => c.lane === 2)!;
		await h.page.mouse.click(lanes.x + (third.startBeat + 4) * ppb, lanes.y + laneH * 2.5, { button: "right" });
		expect(await h.page.getByTestId("clip-menu").count()).toBe(0);
		expect((await clips()).map((c) => c.id)).toEqual(before.filter((c) => c.id !== third.id).map((c) => c.id));
		await h.page.keyboard.press("Meta+z");
		expect(await clips()).toEqual(before);
		// swipe down through lanes 0, 1 and 2 with the right button held
		await h.page.mouse.move(lanes.x + 40 * ppb, lanes.y + laneH * 0.5);
		await h.page.mouse.down({ button: "right" });
		await h.page.mouse.move(lanes.x + 41 * ppb, lanes.y + laneH * 2.5, { steps: 3 });
		await h.page.mouse.up({ button: "right" });
		expect(await clips()).toEqual([]);
		await h.page.keyboard.press("Meta+z");
		expect(await clips()).toEqual(before);
		// a swipe over empty space deletes nothing and adds no undo step
		const past: number = await state(h.page, "s => s.past.length");
		await h.page.mouse.move(lanes.x + 200 * ppb, lanes.y + laneH * 3.5);
		await h.page.mouse.down({ button: "right" });
		await h.page.mouse.move(lanes.x + 210 * ppb, lanes.y + laneH * 3.5, { steps: 3 });
		await h.page.mouse.up({ button: "right" });
		expect(await clips()).toEqual(before);
		expect(await state(h.page, "s => s.past.length")).toBe(past);
	});

	it("C jumps back to where playback started and plays again", async () => {
		await h.page.evaluate(() => (window as any).planner.engine.seek(16));
		await h.page.keyboard.press("Space");
		await h.page.waitForTimeout(1500);
		expect(await playhead()).toBeGreaterThan(18);
		await h.page.keyboard.press("c");
		await h.page.waitForTimeout(150);
		expect(await state(h.page, "s => s.playing")).toBe(true);
		expect(await playhead()).toBeLessThan(17);
		await h.page.waitForTimeout(1500);
		await h.page.keyboard.press("c");
		await h.page.waitForTimeout(150);
		expect(await playhead()).toBeLessThan(17);
		// stopping in place keeps the cue; C from stopped plays from the cue
		await h.page.waitForTimeout(1500);
		await h.page.keyboard.press("Space");
		expect(await playhead()).toBeGreaterThan(18);
		await h.page.keyboard.press("c");
		await h.page.waitForTimeout(150);
		expect(await state(h.page, "s => s.playing")).toBe(true);
		const p = await playhead();
		expect(p).toBeGreaterThanOrEqual(16);
		expect(p).toBeLessThan(17);
		await h.page.keyboard.press("Space");
	});

	it("does not scroll the view to follow the playhead", async () => {
		await state(h.page, "s => { window.planner.store.set({ pxPerBeat: 40, scrollX: 0 }); return 0; }");
		const w: number = await state(h.page, "s => s.viewportW");
		await h.page.evaluate((b) => (window as any).planner.engine.seek(b), w / 40 - 2);
		await h.page.keyboard.press("Space");
		await h.page.waitForTimeout(2500);
		expect(await playhead()).toBeGreaterThan(w / 40 + 1);
		expect(await state(h.page, "s => s.scrollX")).toBe(0);
		expect(await h.page.getByTestId("playhead").evaluate((el) => (el as HTMLElement).style.visibility)).toBe("hidden");
		await h.page.keyboard.press("Space");
		await h.page.keyboard.press("Meta+0");
	});

	it("tempo points and the project BPM are whole numbers", async () => {
		const lane = (await h.page.getByTestId("tempo-lane").boundingBox())!;
		const ppb: number = await state(h.page, "s => s.pxPerBeat");
		// a new point takes the tempo the curve has there, wherever the click is vertically
		await h.page.mouse.dblclick(lane.x + 16 * ppb, lane.y + 12);
		let pts: any[] = await state(h.page, "s => s.doc.points");
		expect(pts.map((p) => p.bpm)).toEqual([128]);
		await h.page.getByTestId("point-bpm").fill("140.6");
		await h.page.getByTestId("point-bpm").press("Enter");
		await h.page.mouse.dblclick(lane.x + 80 * ppb, lane.y + 80);
		pts = await state(h.page, "s => s.doc.points.slice().sort((a, b) => a.beat - b.beat)");
		expect(pts.map((p) => p.bpm)).toEqual([141, 141]);
		await h.page.getByTestId("point-bpm").fill("100");
		await h.page.getByTestId("point-bpm").press("Enter");
		// halfway along a 141 -> 100 ramp the curve is 120.5, added as a whole number
		const mid: number = await state(h.page, "s => { const p = s.doc.points.slice().sort((a, b) => a.beat - b.beat); return (p[0].beat + p[1].beat) / 2; }");
		await h.page.mouse.dblclick(lane.x + mid * ppb - (await state<number>(h.page, "s => s.scrollX")), lane.y + 70);
		pts = await state(h.page, "s => s.doc.points.slice().sort((a, b) => a.beat - b.beat)");
		expect(pts).toHaveLength(3);
		expect(Number.isInteger(pts[1].bpm)).toBe(true);
		expect(Math.abs(pts[1].bpm - 120.5)).toBeLessThan(1);
		// dragging a point lands on whole BPMs
		const pt = h.page.getByTestId("tempo-point").nth(2);
		const pb = (await pt.boundingBox())!;
		await h.page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
		await h.page.mouse.down();
		await h.page.mouse.move(pb.x + pb.width / 2 + 3, pb.y + pb.height / 2 - 17, { steps: 7 });
		await h.page.mouse.up();
		pts = await state(h.page, "s => s.doc.points");
		for (const p of pts) expect(Number.isInteger(p.bpm)).toBe(true);
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		expect(await state(h.page, "s => s.doc.points")).toEqual([]);
		// project BPM rounds too
		const input = h.page.getByTestId("project-bpm");
		await input.fill("130.4");
		await input.press("Enter");
		await h.page.getByTestId("project-bpm-modal").waitFor();
		await h.page.getByTestId("project-bpm-confirm").click();
		expect(await state(h.page, "s => s.doc.bpm")).toBe(130);
		await expect.poll(() => input.inputValue()).toBe("130");
		await h.page.keyboard.press("Meta+z");
		expect(await state(h.page, "s => s.doc.bpm")).toBe(128);
		await waitReady(h.page);
	});

	it("timeline takes the top three quarters of the window", async () => {
		const vh: number = await h.page.evaluate(() => window.innerHeight);
		const tl = (await h.page.getByTestId("timeline").boundingBox())!;
		expect(Math.abs(tl.y + tl.height - vh * 0.75)).toBeLessThan(2);
		await shot(h.page, "12-layout");
	});

	it("typing in a field does not trigger shortcuts", async () => {
		await h.page.locator('[data-testid="clip"]').first().click({ position: { x: 50, y: 40 } });
		const input = h.page.getByTestId("project-bpm");
		await input.click();
		await input.press("Backspace");
		await input.type("s ");
		expect((await clips()).length).toBe(3);
		expect(await state(h.page, "s => s.playing")).toBe(false);
		await input.press("Escape");
		expect(await input.inputValue()).toBe("128");
	});

	it("asks before discarding unsaved work", async () => {
		await h.page.keyboard.press("Meta+n");
		await h.page.getByTestId("discard-modal").waitFor();
		await h.page.keyboard.press("Escape");
		expect((await clips()).length).toBe(3);
		await h.page.keyboard.press("Meta+n");
		await h.page.getByTestId("discard-confirm").click();
		expect((await clips()).length).toBe(0);
	});
});

describe("export cancel", () => {
	it("cancels a running export cleanly and can export again", async () => {
		const fs = await import("node:fs");
		const { execSync } = await import("node:child_process");
		const a = path.join(h.workDir, "long.wav");
		writeClickTrack(a, 128, 400);
		await importTrack(h.page, a, 128, 0, 0);
		await waitReady(h.page);
		await state(h.page, "s => { window.planner.store.commit({ ...s.doc, points: [{ id: 'p1', beat: 0, bpm: 128 }, { id: 'p2', beat: 800, bpm: 140 }] }); return 0; }");
		const out = path.join(h.workDir, "cancelled.wav");
		void h.page.evaluate((o) => {
			const p = (window as any).planner;
			p.store.set({ exportUi: { phase: "options" } });
			void p.runExport(true, o);
		}, out);
		await h.page.getByTestId("export-stage").filter({ hasText: "tempo" }).waitFor({ timeout: 60000 });
		await h.page.waitForTimeout(1500);
		await shot(h.page, "12-exporting");
		await h.page.getByTestId("export-cancel").click();
		await h.page.getByTestId("export-modal").waitFor({ state: "detached" });
		expect(fs.existsSync(out)).toBe(false);
		expect(fs.existsSync(out + ".part")).toBe(false);
		await h.page.waitForTimeout(500);
		const cache = path.join(h.dataDir, "planner-cache");
		expect(fs.readdirSync(cache).filter((f) => f.startsWith("export-"))).toEqual([]);
		const left = execSync(`pgrep -fl "rubberband-r3.*${path.basename(h.dataDir)}" || true`).toString().trim();
		expect(left).toBe("");
		// and a normal export afterwards still works
		const out2 = path.join(h.workDir, "after-cancel.wav");
		await h.page.evaluate((o) => {
			const p = (window as any).planner;
			p.store.set({ exportUi: { phase: "options" } });
			return p.runExport(false, o);
		}, out2);
		await h.page.getByTestId("export-done").waitFor({ timeout: 120000 });
		expect(fs.existsSync(out2)).toBe(true);
	});
});
