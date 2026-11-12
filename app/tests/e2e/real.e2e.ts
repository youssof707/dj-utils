// Real music from ../store, dropped onto the timeline the way Finder does it.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SAMPLE_RATE as SR } from "../../src/shared/planner";
import { WavReader } from "../../src/main/audio/wav";
import { APP_DIR, exportTo, launch, shot, state, waitReady, type Harness } from "./harness";

const STORE = path.resolve(APP_DIR, "../store");
let h: Harness;

beforeAll(async () => {
	h = await launch();
});
afterAll(async () => {
	await h?.close();
});

async function dropFiles(files: string[], x: number, y: number): Promise<void> {
	const cdp = await h.page.context().newCDPSession(h.page);
	const data = { items: [], files, dragOperationsMask: 1 };
	await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x, y, data });
	await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x, y, data });
	await cdp.send("Input.dispatchDragEvent", { type: "drop", x, y, data });
}

it("drops real files, plays, trims and exports them", async () => {
	const all = fs.readdirSync(STORE).filter((f) => /\.(mp3|wav)$/i.test(f));
	const mp3 = all.find((f) => f.endsWith(".mp3"))!;
	const wav = all.find((f) => f.endsWith(".wav"))!;
	const lane1 = (await h.page.getByTestId("lane-1").boundingBox())!;
	const lane2 = (await h.page.getByTestId("lane-2").boundingBox())!;
	const ppb: number = await state(h.page, "s => s.pxPerBeat");

	// two files in one drop: both get a prompt, second lands after the first
	await dropFiles([path.join(STORE, mp3), path.join(STORE, wav)], lane1.x + 8 * ppb, lane1.y + 40);
	await h.page.getByTestId("import-modal").waitFor();
	await shot(h.page, "real-01-prompt");
	await h.page.waitForFunction(() => (window as any).planner.store.get().importQueue.length === 2, undefined, { polling: 100 });
	await h.page.getByTestId("bpm-input").fill("126");
	await h.page.getByTestId("bpm-input").press("Enter");
	await h.page.waitForFunction(() => (window as any).planner.store.get().doc.clips.length === 1, undefined, { polling: 100 });
	await h.page.getByTestId("import-modal").waitFor();
	// the Enter that confirmed the first file must not have touched the second prompt
	expect(await h.page.locator(".modal .error").count()).toBe(0);
	expect(await h.page.getByTestId("bpm-input").inputValue()).toBe("");
	expect(await h.page.evaluate(() => document.activeElement === document.querySelector('[data-testid="bpm-input"]'))).toBe(true);
	await h.page.getByTestId("bpm-input").fill("140.5");
	await h.page.getByTestId("bpm-input").press("Enter");
	await h.page.getByTestId("import-modal").waitFor({ state: "detached" });
	let cs: any[] = await state(h.page, "s => s.doc.clips");
	expect(cs.length).toBe(2);
	expect(cs[0].lane).toBe(1);
	expect(cs[0].startBeat).toBeCloseTo(8, 0);
	expect(cs[1].startBeat).toBeCloseTo(cs[0].startBeat + cs[0].lengthBeat, 6);
	await shot(h.page, "real-02-stretching");
	await waitReady(h.page);

	// dropping a file that is already in the set does not ask again
	await dropFiles([path.join(STORE, mp3)], lane2.x + 40 * ppb, lane2.y + 40);
	await h.page.waitForFunction(() => (window as any).planner.store.get().doc.clips.length === 3, undefined, { polling: 100 });
	expect(await h.page.getByTestId("import-modal").count()).toBe(0);
	expect(await state(h.page, "s => s.doc.tracks.length")).toBe(2);
	await waitReady(h.page);
	await h.page.keyboard.press("Meta+0");
	await shot(h.page, "real-03-fit");

	// a non-audio file is refused with a message, nothing is added
	await dropFiles([path.join(APP_DIR, "package.json")], lane2.x + 10, lane2.y + 40);
	await h.page.getByTestId("toast").waitFor();
	await shot(h.page, "real-04-refused");
	expect(await state(h.page, "s => s.doc.clips.length")).toBe(3);

	// zoomed in on a transition
	await state(h.page, "s => { window.planner.store.set({ pxPerBeat: 40, scrollX: 0 }); return 0; }");
	await shot(h.page, "real-05-zoomed");
	await h.page.keyboard.press("Space");
	await h.page.waitForTimeout(3000);
	expect(await state(h.page, "s => s.playing")).toBe(true);
	await shot(h.page, "real-06-playing");
	await h.page.keyboard.press("Space");

	const out = path.join(h.workDir, "real.wav");
	await exportTo(h.page, out, true);
	await h.page.getByTestId("export-done").waitFor({ timeout: 300000 });
	await shot(h.page, "real-07-exported");
	cs = await state(h.page, "s => s.doc.clips");
	const end = Math.max(...cs.map((c) => c.startBeat + c.lengthBeat));
	const r = new WavReader(out);
	expect(r.info.bits).toBe(16);
	expect(r.info.channels).toBe(2);
	expect(r.info.sampleRate).toBe(44100);
	expect(Math.abs(r.frames / SR - (end * 60) / 128)).toBeLessThan(0.01);
	r.close();
});
