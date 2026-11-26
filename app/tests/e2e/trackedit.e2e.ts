// The track editor in the bottom part of the window: tracks of the set are put on its one lane,
// cut into sections, moved about (over each other too), and exported to the folder from the settings as the source's own
// samples. The export comes back into a set with its parent's beat grid.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOIN_SEC, readGridTag } from "../../src/main/audio/splice";
import { parseWavHeader } from "../../src/main/audio/wav";
import { writeBarTrack } from "../signals";
import { importTrack, launch, shot, state, waitReady, type Harness } from "./harness";

let h: Harness;
let source = "";
let exportDir = "";
let exported = "";

// A real track from <repo>/store, when there is one.
const STORE = path.resolve(__dirname, "../../../store");
const realMp3 = fs.existsSync(STORE)
	? fs
			.readdirSync(STORE)
			.filter((f) => /\.mp3$/i.test(f))
			.sort()
			.map((f) => path.join(STORE, f))[0]
	: undefined;

const BPM = 128;
const SR = 44100;
const DOWNBEAT = 0.1; // seconds: the track's first beat
const LEAD = (DOWNBEAT * BPM) / 60; // the same in beats
const frameAt = (beat: number): number => Math.round(((beat * 60) / BPM) * SR);
const sections = (): Promise<{ id: string; startBeat: number; lengthBeat: number; atBeat: number; src?: number }[]> => state(h.page, "s => s.trackEdit.sections");
const setCursor = (beat: number): Promise<unknown> => state(h.page, `s => { window.planner.store.set({ trackEdit: { ...s.trackEdit, cursorBeat: ${beat} } }); return 0; }`);

function audioOf(file: string): { sampleRate: number; bits: number; channels: number; frames: number; data: Buffer } {
	const fd = fs.openSync(file, "r");
	try {
		const info = parseWavHeader(fd);
		const data = Buffer.alloc(info.frames * info.channels * (info.bits / 8));
		fs.readSync(fd, data, 0, data.length, info.dataOffset);
		return { sampleRate: info.sampleRate, bits: info.bits, channels: info.channels, frames: info.frames, data };
	} finally {
		fs.closeSync(fd);
	}
}

beforeAll(async () => {
	h = await launch();
	// The drags here are worked out on the whole width of the window: no library panel.
	await h.page.evaluate(() => (window as any).planner.store.set({ libraryOpen: false }));
	source =path.join(h.workDir, "parent.wav");
	exportDir = path.join(h.workDir, "edits");
	writeBarTrack(source, BPM, 60, { firstSec: DOWNBEAT });
	await importTrack(h.page, source, BPM, 0, 0);
	// The grid a Rekordbox track would have come with.
	await state(h.page, `s => { window.planner.store.commit({ ...s.doc, tracks: s.doc.tracks.map((t) => ({ ...t, downbeatSec: ${DOWNBEAT} })) }); return 0; }`);
	await waitReady(h.page);
	await h.page.evaluate((dir) => (window as any).api.setSettings({ exportDir: dir }), exportDir);
});
afterAll(async () => {
	await h?.close();
});

describe("track editor", () => {
	it("adds a track to the editor from its clip's menu, as one section, the whole track", async () => {
		await h.page.getByTestId("track-editor-empty").waitFor();
		await h.page.locator('[data-testid="clip"]').first().click({ button: "right", position: { x: 50, y: 40 } });
		expect(await h.page.getByTestId("menu-edit").textContent()).toBe("Add to editor");
		await h.page.getByTestId("menu-edit").click();
		await h.page.getByTestId("track-editor").waitFor();
		expect(await h.page.getByTestId("edit-name").textContent()).toBe("parent (edit)");
		const s = await sections();
		expect(s).toHaveLength(1);
		expect(s[0]).toMatchObject({ startBeat: 0, atBeat: 0 });
		expect(await h.page.getByTestId("edit-section").count()).toBe(1);
		await shot(h.page, "trackedit-01-open");
	});

	it("keeps a name typed for the edit when a track is added, and goes back to the tracks' names when it is cleared", async () => {
		const name = h.page.getByTestId("edit-name");
		await name.click();
		await h.page.getByTestId("edit-name-input").fill("My Edit");
		await h.page.keyboard.press("Enter");
		expect(await name.textContent()).toBe("My Edit");
		const id = await state<string>(h.page, "s => s.doc.tracks.find((t) => t.name === 'parent').id");
		await h.page.evaluate((t) => (window as any).planner.openTrackEdit(t), id);
		await expect.poll(() => h.page.getByTestId("edit-section").count()).toBe(2);
		expect(await name.textContent()).toBe("My Edit");
		await h.page.keyboard.press("Meta+z");
		await expect.poll(() => h.page.getByTestId("edit-section").count()).toBe(1);
		await name.click();
		await h.page.getByTestId("edit-name-input").fill("");
		await h.page.keyboard.press("Enter");
		expect(await name.textContent()).toBe("parent (edit)");
	});

	it("cuts at the cursor, and its keys leave the timeline alone", async () => {
		await setCursor(LEAD + 32);
		await h.page.getByTestId("edit-cut").click();
		await setCursor(LEAD + 64);
		await h.page.getByTestId("edit-cut").click();
		expect((await sections()).map((s) => Math.round(s.startBeat))).toEqual([0, 32, 64]);
		// Copy the middle section and take the copy away again, by keyboard.
		await h.page.getByTestId("edit-section").nth(1).click();
		await h.page.keyboard.press("Meta+d");
		const copied = await sections();
		expect(copied.map((s) => Math.round(s.startBeat))).toEqual([0, 32, 64, 32]);
		// The copy goes right after it, over the section that was there: both show, on rows of their own.
		expect(copied[3].atBeat).toBeCloseTo(LEAD + 64, 6);
		const tops = await h.page.getByTestId("edit-section").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
		expect(new Set(tops).size).toBe(2);
		await shot(h.page, "trackedit-01b-overlap");
		await h.page.keyboard.press("Backspace");
		expect((await sections()).map((s) => Math.round(s.startBeat))).toEqual([0, 32, 64]);
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		expect(await sections()).toHaveLength(3);
		// The set itself was not touched by any of that.
		expect(await state(h.page, "s => s.doc.clips.length")).toBe(1);
	});

	it("cuts where S is held and clicked, and at the cursor with Cmd+S, always on a beat", async () => {
		const onBeat = (beat: number): number => Math.abs(beat - LEAD - Math.round(beat - LEAD));
		await h.page.keyboard.down("s");
		await h.page.getByTestId("edit-section").first().click({ position: { x: 100, y: 40 } });
		await h.page.keyboard.up("s");
		let s = await sections();
		expect(s).toHaveLength(4);
		expect(s[1].startBeat).toBeGreaterThan(LEAD + 1);
		expect(s[1].startBeat).toBeLessThan(LEAD + 31);
		expect(onBeat(s[1].startBeat)).toBeLessThan(1e-6);
		await h.page.keyboard.press("Meta+z");
		expect(await sections()).toHaveLength(3);
		// A click on the edit moves the cursor; Cmd+S cuts there.
		await h.page.getByTestId("edit-row").click({ position: { x: 200, y: 40 } });
		const cursor = Number(await h.page.getByTestId("edit-cursor").getAttribute("data-beat"));
		expect(cursor).toBeGreaterThan(LEAD + 1);
		expect(onBeat(cursor)).toBeLessThan(1e-3);
		await h.page.keyboard.press("Meta+s");
		s = await sections();
		expect(s).toHaveLength(4);
		expect(s[1].startBeat).toBeCloseTo(cursor, 3);
		await h.page.keyboard.press("Meta+z");
		expect(await sections()).toHaveLength(3);
		expect(await state(h.page, "s => s.doc.clips.length")).toBe(1);
	});

	it("mutes the bass of the chosen sections only, from its button, Cmd+B, or a click with B held", async () => {
		const cut = async (): Promise<boolean[]> => (await sections()).map((x) => !!(x as { lowCut?: boolean }).lowCut);
		// Every section starts with its bass.
		expect(await cut()).toEqual([false, false, false]);
		const bass = h.page.getByTestId("edit-bass");
		expect(await bass.isDisabled()).toBe(true);
		await h.page.getByTestId("edit-section").nth(1).click();
		expect(await bass.textContent()).toBe("Mute bass");
		await bass.click();
		expect(await cut()).toEqual([false, true, false]);
		expect(await h.page.getByTestId("edit-section").nth(1).getAttribute("data-lowcut")).toBe("true");
		expect(await h.page.locator('[data-testid="edit-section"][data-lowcut]').count()).toBe(1);
		expect(await bass.textContent()).toBe("Unmute bass");
		await shot(h.page, "trackedit-01c-nobass");
		// Cmd+B brings it back; B held and a click cuts the first one's.
		await h.page.keyboard.press("Meta+b");
		expect(await cut()).toEqual([false, false, false]);
		await h.page.keyboard.down("b");
		await h.page.getByTestId("edit-section").first().click({ position: { x: 100, y: 40 } });
		await h.page.keyboard.up("b");
		expect(await cut()).toEqual([true, false, false]);
		// Each change is one undo step.
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		expect(await cut()).toEqual([false, false, false]);
		// The timeline's clip was never touched.
		expect(await state(h.page, "s => s.doc.clips.some((c) => c.lowCut)")).toBe(false);
	});

	it("moves a section anywhere along the lane by dragging it, over the others or past them", async () => {
		const px: number = await state(h.page, "s => window.planner.editPx(s.trackEdit)");
		const drag = async (beats: number): Promise<void> => {
			const last = (await h.page.getByTestId("edit-section").nth(2).boundingBox())!;
			const y = last.y + last.height / 2;
			await h.page.mouse.move(last.x + last.width / 2, y);
			await h.page.mouse.down();
			await h.page.mouse.move(last.x + last.width / 2 + Math.sign(beats) * 10, y, { steps: 3 });
			await h.page.mouse.move(last.x + last.width / 2 + beats * px, y, { steps: 6 });
			await h.page.mouse.up();
		};
		// Back over the middle one: they overlap, and the others stay where they are.
		await drag(-16);
		let s = await sections();
		expect(s.map((x) => Math.round(x.atBeat))).toEqual([0, 32, 48]);
		await shot(h.page, "trackedit-02-overlapping");
		await h.page.keyboard.press("Meta+z");
		// Later, leaving silence before it.
		await drag(8);
		s = await sections();
		expect(s[2].atBeat).toBeCloseTo(LEAD + 72, 6);
		expect(s[1].atBeat).toBeCloseTo(LEAD + 32, 6);
		await shot(h.page, "trackedit-02b-silence");
	});

	it("selects sections with a box dragged from empty lane space, Shift adds to it", async () => {
		const els = h.page.getByTestId("edit-section");
		const ids = await els.evaluateAll((list) => list.map((el) => (el as HTMLElement).dataset.sectionId!));
		const box = async (from: number, to: number, shift = false): Promise<void> => {
			const a = (await els.nth(from).boundingBox())!;
			const b = (await els.nth(to).boundingBox())!;
			if (shift) await h.page.keyboard.down("Shift");
			// From the strip under the sections up into them.
			await h.page.mouse.move(a.x + a.width / 2, a.y + a.height + 10);
			await h.page.mouse.down();
			await h.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
			await h.page.mouse.up();
			if (shift) await h.page.keyboard.up("Shift");
		};
		const selection = (): Promise<string[]> => state(h.page, "s => s.trackEdit.selection");
		await box(0, 1);
		expect((await selection()).sort()).toEqual([ids[0], ids[1]].sort());
		await shot(h.page, "trackedit-02c-box");
		await box(2, 2, true);
		expect((await selection()).sort()).toEqual([...ids].sort());
		// A click on empty space clears it.
		const first = (await els.first().boundingBox())!;
		await h.page.mouse.click(first.x + first.width / 2, first.y + first.height + 10);
		expect(await selection()).toEqual([]);
	});

	it("makes a section shorter or longer by dragging its ends, on the beat lines", async () => {
		const px: number = await state(h.page, "s => window.planner.editPx(s.trackEdit)");
		const before = await sections();
		const dragEnd = async (side: "left" | "right", beats: number): Promise<void> => {
			const b = (await h.page.getByTestId("edit-section").first().boundingBox())!;
			const x = side === "right" ? b.x + b.width - 3 : b.x + 3;
			const y = b.y + b.height / 2;
			await h.page.mouse.move(x, y);
			await h.page.mouse.down();
			await h.page.mouse.move(x + Math.sign(beats) * 10, y, { steps: 3 });
			await h.page.mouse.move(x + beats * px, y, { steps: 6 });
			await h.page.mouse.up();
		};
		await dragEnd("right", -8);
		let s = await sections();
		expect(s[0].lengthBeat).toBeCloseTo(before[0].lengthBeat - 8, 6);
		expect(s[0].atBeat).toBeCloseTo(before[0].atBeat, 6);
		await shot(h.page, "trackedit-02d-trimmed");
		// The left end lands on a beat line; the audio stays put, only less of it is heard.
		await dragEnd("left", 4);
		s = await sections();
		const by = s[0].atBeat - before[0].atBeat;
		expect(by).toBeGreaterThan(3);
		expect(by).toBeLessThan(5);
		expect(Math.abs(s[0].atBeat - LEAD - Math.round(s[0].atBeat - LEAD))).toBeLessThan(1e-6);
		expect(s[0].startBeat - s[0].atBeat).toBeCloseTo(before[0].startBeat - before[0].atBeat, 6);
		expect(s[0].atBeat + s[0].lengthBeat).toBeCloseTo(before[0].atBeat + before[0].lengthBeat - 8, 6);
		// Both are one undo step each.
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		expect(await sections()).toEqual(before);
	});

	it("puts a section's bar lines back on the edit's with Align to grid from its right-click menu", async () => {
		const before = await sections();
		// The last section, off the grid by a beat and a bit.
		await state(h.page, `s => { const e = s.trackEdit; window.planner.store.set({ trackEdit: { ...e, sections: e.sections.map((x, i) => i === 2 ? { ...x, atBeat: x.atBeat + 1.3 } : x) } }); return 0; }`);
		const off = (await sections())[2];
		await h.page.getByTestId("edit-section").nth(2).click({ button: "right", position: { x: 60, y: 40 } });
		await h.page.getByTestId("menu-edit-align").click();
		const s = (await sections())[2];
		// Its track's first bar line is the edit's first one, so it lands a whole number of bars off.
		const bars = (s.atBeat - s.startBeat) / 4;
		expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-6);
		expect(Math.abs(s.atBeat - off.atBeat)).toBeLessThanOrEqual(2);
		expect(await state(h.page, "s => s.trackEdit.selection")).toEqual([s.id]);
		await h.page.keyboard.press("Meta+z");
		expect((await sections())[2].atBeat).toBeCloseTo(off.atBeat, 6);
		// Back as the other tests left it.
		await state(h.page, `s => { window.planner.store.set({ trackEdit: { ...s.trackEdit, sections: ${JSON.stringify(before)} } }); return 0; }`);
	});

	it("copies a section with Shift held while it is dragged, and leaves the original", async () => {
		const px: number = await state(h.page, "s => window.planner.editPx(s.trackEdit)");
		const before = await sections();
		const last = (await h.page.getByTestId("edit-section").nth(2).boundingBox())!;
		const x = last.x + last.width / 2;
		const y = last.y + last.height / 2;
		await h.page.keyboard.down("Shift");
		await h.page.mouse.move(x, y);
		await h.page.mouse.down();
		await h.page.mouse.move(x + 10, y, { steps: 3 });
		await h.page.mouse.move(x + 16 * px, y, { steps: 6 });
		await h.page.mouse.up();
		await h.page.keyboard.up("Shift");
		const after = await sections();
		expect(after).toHaveLength(before.length + 1);
		expect(after.slice(0, before.length)).toEqual(before);
		const copy = after[before.length];
		const from = before.find((s) => Math.abs(s.atBeat - copy.atBeat + 16) < 1e-6)!;
		expect(from).toBeDefined();
		expect(copy.startBeat).toBeCloseTo(from.startBeat, 6);
		expect(copy.lengthBeat).toBeCloseTo(from.lengthBeat, 6);
		expect(await state(h.page, "s => s.trackEdit.selection")).toEqual([copy.id]);
		await shot(h.page, "trackedit-02f-copy");
		await h.page.keyboard.press("Meta+z");
		expect(await sections()).toEqual(before);
	});

	it("fades a section in and out with the dots at its corners, as on the timeline", async () => {
		const px: number = await state(h.page, "s => window.planner.editPx(s.trackEdit)");
		const drag = async (testId: string, beats: number): Promise<void> => {
			const d = (await h.page.getByTestId(testId).first().boundingBox())!;
			const x = d.x + d.width / 2;
			const y = d.y + d.height / 2;
			await h.page.mouse.move(x, y);
			await h.page.mouse.down();
			await h.page.mouse.move(x + Math.sign(beats) * 10, y, { steps: 3 });
			await h.page.mouse.move(x + beats * px, y, { steps: 6 });
			await h.page.mouse.up();
		};
		const first = async (): Promise<{ atBeat: number; lengthBeat: number; fadeInBeat?: number; fadeOutBeat?: number }> => (await sections())[0];
		const before = await first();
		await drag("edit-fade-in", 4);
		let s = await first();
		// The fade ends on a beat line, and the section itself did not move.
		expect(s.fadeInBeat).toBeGreaterThan(3);
		expect(s.fadeInBeat).toBeLessThan(5);
		expect(Math.abs(s.atBeat + s.fadeInBeat! - LEAD - Math.round(s.atBeat + s.fadeInBeat! - LEAD))).toBeLessThan(1e-6);
		expect(s.atBeat).toBeCloseTo(before.atBeat, 6);
		await drag("edit-fade-out", -8);
		s = await first();
		expect(s.fadeOutBeat).toBeCloseTo(8, 6);
		await shot(h.page, "trackedit-02e-fades");
		// One undo step each.
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		expect(await first()).toEqual(before);
	});

	it("previews the edit with Space, on its own, and stops when the set plays", async () => {
		const beat = async (): Promise<number> => Number(await h.page.getByTestId("edit-playhead").getAttribute("data-beat"));
		const playing = (): Promise<boolean> => state(h.page, "s => s.trackEdit.playing");
		await h.page.getByTestId("edit-row").click({ position: { x: 300, y: 40 } });
		await h.page.keyboard.press("Space");
		await expect.poll(playing).toBe(true);
		expect(await state(h.page, "s => s.playing")).toBe(false);
		await h.page.waitForTimeout(500);
		const a = await beat();
		await h.page.waitForTimeout(1000);
		const b = await beat();
		// 128 BPM: a second is a little over two beats.
		expect(b - a).toBeGreaterThan(1.6);
		expect(b - a).toBeLessThan(2.7);
		await h.page.keyboard.press("Space");
		expect(await playing()).toBe(false);
		// The set starting to play takes over from the preview.
		await h.page.keyboard.press("Space");
		await expect.poll(playing).toBe(true);
		await h.page.evaluate(() => (window as any).planner.engine.toggle());
		await expect.poll(playing).toBe(false);
		expect(await state(h.page, "s => s.playing")).toBe(true);
		await h.page.evaluate(() => (window as any).planner.engine.stop());
	});

	it("exports the source's own samples, rearranged, to the folder from the settings", async () => {
		await h.page.getByTestId("edit-export").click();
		await h.page.getByTestId("edit-exported").waitFor({ timeout: 60000 });
		exported = path.join(exportDir, "parent (edit).wav");
		expect(fs.existsSync(exported)).toBe(true);
		const a = audioOf(source);
		const b = audioOf(exported);
		expect({ sampleRate: b.sampleRate, bits: b.bits, channels: b.channels }).toEqual({ sampleRate: a.sampleRate, bits: a.bits, channels: a.channels });
		const fb = (a.bits / 8) * a.channels;
		const n = Math.round(JOIN_SEC * SR);
		// The first two sections were never moved: the parent as it was, lead-in and all...
		const gap = frameAt(LEAD + 64);
		expect(b.data.subarray(0, (gap - n) * fb).equals(a.data.subarray(0, (gap - n) * fb))).toBe(true);
		// ...then the 8 beats of silence the last section was dragged away by...
		const back = frameAt(LEAD + 72);
		expect(b.data.subarray(gap * fb, (back - n) * fb).every((x) => x === 0)).toBe(true);
		// ...and the last section, sample for sample, to the end of the parent.
		expect(b.data.subarray(back * fb).equals(a.data.subarray(gap * fb))).toBe(true);
		expect(b.frames).toBe(back + a.frames - gap);
		expect(readGridTag(exported)).toEqual({ bpm: BPM, downbeatSec: DOWNBEAT });
		// A second export does not overwrite the first.
		await h.page.evaluate(() => (window as any).planner.exportTrackEdit());
		expect(fs.existsSync(path.join(exportDir, "parent (edit 2).wav"))).toBe(true);
	});

	it("drags the export from the editor onto a lane, with its parent's grid, without asking for a BPM", async () => {
		// The editor shows the latest export, (edit 2); drag it onto the second lane.
		const chip = h.page.getByTestId("edit-exported");
		await expect.poll(() => chip.textContent()).toContain("parent (edit 2).wav");
		await chip.dragTo(h.page.getByTestId("lane-1"), { targetPosition: { x: 40, y: 20 } });
		await h.page.waitForFunction(() => (window as any).planner.store.get().doc.tracks.length === 2, undefined, { timeout: 60000 });
		expect(await h.page.getByTestId("import-modal").count()).toBe(0);
		const t = await state<{ bpm: number; downbeatSec: number; name: string; sourcePath: string }>(h.page, "s => s.doc.tracks[1]");
		expect(t.sourcePath).toBe(path.join(exportDir, "parent (edit 2).wav"));
		expect(await state(h.page, "s => s.doc.clips[s.doc.clips.length - 1].lane")).toBe(1);
		expect(t.name).toBe("parent (edit 2)");
		expect(t.bpm).toBe(BPM);
		expect(t.downbeatSec).toBeCloseTo(DOWNBEAT, 9);
		await waitReady(h.page);
		await shot(h.page, "trackedit-03-back-in-the-set");
	});

	it("opens an audio file dropped on the empty editor, with its grid, without adding it to the set", async () => {
		const file = path.join(exportDir, "parent (edit).wav");
		const tracks = await state<number>(h.page, "s => s.doc.tracks.length");
		await h.page.getByTestId("edit-close").click();
		await h.page.getByTestId("track-editor-empty").waitFor();
		await h.page.evaluate((p) => {
			const dt = new DataTransfer();
			dt.setData("application/x-dj-path", p);
			const el = document.querySelector('[data-testid="track-editor-empty"]')!;
			for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
		}, file);
		await expect.poll(() => h.page.getByTestId("edit-name").textContent()).toBe("parent (edit)");
		expect(await h.page.getByTestId("import-modal").count()).toBe(0);
		const t = await state<{ sourcePath: string; bpm: number; downbeatSec: number }>(h.page, "s => s.trackEdit.tracks[0]");
		expect(t.sourcePath).toBe(file);
		expect(t.bpm).toBe(BPM);
		expect(t.downbeatSec).toBeCloseTo(DOWNBEAT, 9);
		expect(await state<number>(h.page, "s => s.doc.tracks.length")).toBe(tracks);
		// Its waveform is made even though no clip uses it.
		await expect.poll(() => h.page.evaluate(() => document.querySelectorAll(".edit-section .edit-wave").length), { timeout: 60000 }).toBeGreaterThan(0);
		await expect.poll(() => h.page.getByTestId("edit-play").isEnabled(), { timeout: 60000 }).toBe(true);
	});

	it("adds another track at the end of the same lane, on its bar lines, and exports both as one file", async () => {
		// The exported edit is open; the parent goes after it.
		const id = await state<string>(h.page, "s => s.doc.tracks.find((t) => t.name === 'parent').id");
		const before = await sections();
		const end = before[0].atBeat + before[0].lengthBeat;
		await h.page.evaluate((t) => (window as any).planner.openTrackEdit(t), id);
		await expect.poll(() => h.page.getByTestId("edit-name").textContent()).toBe("parent (edit)");
		expect(await h.page.getByTestId("edit-section").count()).toBe(2);
		const s = await sections();
		const added = s[1];
		expect(added).toMatchObject({ src: 1, startBeat: 0 });
		// After the end, on the next bar line: both tracks have the same grid.
		expect(added.atBeat).toBeGreaterThanOrEqual(end - 1e-6);
		expect(added.atBeat - end).toBeLessThan(4);
		expect(Math.abs(added.atBeat / 4 - Math.round(added.atBeat / 4))).toBeLessThan(1e-6);
		expect(await state(h.page, "s => s.trackEdit.selection")).toEqual([added.id]);
		await shot(h.page, "trackedit-07-two-tracks");
		// Laid over the end of the first one, both are in the file, which is as long as the lane.
		// Four grid steps back: at least four beats, more than the room it was put after.
		for (let i = 0; i < 4; i++) await h.page.keyboard.press("Alt+ArrowLeft");
		const moved = (await sections())[1];
		expect(moved.atBeat).toBeLessThan(end);
		const out: string = await h.page.evaluate(() => (window as any).planner.exportTrackEdit());
		expect(fs.existsSync(out)).toBe(true);
		expect(audioOf(out).frames).toBe(frameAt(moved.atBeat) + audioOf(source).frames);
		// Undo takes the parent back out of the editor.
		for (let i = 0; i < 5; i++) await h.page.keyboard.press("Meta+z");
		expect(await sections()).toEqual(before);
		expect(await state<number>(h.page, "s => s.trackEdit.tracks.length")).toBe(1);
		// The parent on its own again, for the tests that follow.
		await h.page.getByTestId("edit-close").click();
		await h.page.evaluate((t) => (window as any).planner.openTrackEdit(t), id);
		await h.page.getByTestId("edit-section").first().waitFor();
	});

	it("adds the selected clips to the open editor with Cmd+E, and opens them as an edit of their own when it is closed", async () => {
		// Two pieces of the parent, the later part first, four beats apart; and a clip of another file.
		await h.page.evaluate((lead) => {
			const { store } = (window as any).planner;
			const doc = store.get().doc;
			const parent = doc.tracks.find((t: any) => t.name === "parent");
			const other = doc.clips.find((c: any) => doc.tracks.find((t: any) => t.id === c.trackId).sourcePath !== parent.sourcePath);
			const a = { id: "ce-a", trackId: parent.id, lane: 3, startBeat: 400, offsetBeat: lead + 8, lengthBeat: 8 };
			const b = { id: "ce-b", trackId: parent.id, lane: 3, startBeat: 412, offsetBeat: lead, lengthBeat: 4 };
			store.commit({ ...doc, clips: [...doc.clips, a, b] });
			store.set({ selection: [a.id, b.id, other.id], editFocus: false });
			return { other: other.id };
		}, LEAD);
		const opened = await sections();
		const openEnd = Math.max(...opened.map((x) => x.atBeat + x.lengthBeat));
		// The editor has something open: Cmd+E adds the clips (of two files) after it, without
		// asking, on the edit's bar lines, selected; what was there stays as it was.
		await h.page.keyboard.press("Meta+e");
		expect(await h.page.getByTestId("edit-replace-modal").count()).toBe(0);
		await expect.poll(() => state(h.page, "s => s.trackEdit.sections.length")).toBe(opened.length + 3);
		const all = await sections();
		expect(all.slice(0, opened.length)).toEqual(opened);
		const added = all.slice(opened.length);
		expect(await state(h.page, "s => s.trackEdit.tracks.length")).toBe(2);
		expect([...new Set(added.map((x) => x.src ?? 0))].sort()).toEqual([0, 1]);
		const first = Math.min(...added.map((x) => x.atBeat));
		expect(first).toBeGreaterThanOrEqual(openEnd - 1e-6);
		expect(first - openEnd).toBeLessThan(4 + 1e-6);
		expect((await state<string[]>(h.page, "s => s.trackEdit.selection")).sort()).toEqual(added.map((x) => x.id).sort());
		expect(await state(h.page, "s => !!s.trackEdit.auto")).toBe(false);
		expect(await state(h.page, "s => s.exportUi")).toBeFalsy();
		await shot(h.page, "trackedit-03-added");
		// One undo step takes them away again.
		await h.page.keyboard.press("Meta+z");
		expect(await sections()).toEqual(opened);
		// With the editor closed, clips of one file open as their own edit, arranged the same way.
		await h.page.getByTestId("edit-close").click();
		await h.page.evaluate(() => (window as any).planner.store.set({ selection: ["ce-a", "ce-b"], editFocus: false }));
		await h.page.keyboard.press("Meta+e");
		await expect.poll(() => h.page.getByTestId("edit-name").textContent()).toBe("parent (edit)");
		const got = await sections();
		// The second starts with the parent's lead-in, so its first beat is on the edit's grid.
		expect(got.map((x) => [x.startBeat, x.lengthBeat, x.atBeat].map((v) => Math.round(v * 1e6) / 1e6))).toEqual([
			[LEAD + 8, 8, LEAD].map((v) => Math.round(v * 1e6) / 1e6),
			[0, LEAD + 4, 12].map((v) => Math.round(v * 1e6) / 1e6),
		]);
		expect(await state(h.page, "s => s.editFocus")).toBe(true);
		// Exported, the edit takes the two clips' place as one clip, playing straight through; the
		// editor closes, and one undo on the timeline puts the clips back and takes the file away.
		const parentId = await state<string>(h.page, "s => s.doc.tracks.find((t) => t.name === 'parent').id");
		const clipsBefore = await state<unknown[]>(h.page, "s => s.doc.clips");
		await h.page.getByTestId("edit-export").click();
		await h.page.waitForFunction(() => (window as any).planner.store.get().trackEdit === null, undefined, { timeout: 60000 });
		const swapped = await state<{ clips: any[]; tracks: any[] }>(h.page, "s => s.doc");
		const a = swapped.clips.find((c) => c.id === "ce-a");
		const edit = swapped.tracks.find((t) => t.id === a.trackId);
		expect(edit.sourcePath.startsWith(path.join(exportDir, "parent (edit"))).toBe(true);
		// One clip now, from where the first started to where the second ended.
		expect(swapped.clips.some((c) => c.id === "ce-b")).toBe(false);
		expect([a.lane, a.startBeat, a.lengthBeat]).toEqual([3, 400, 16]);
		expect(swapped.tracks.some((t) => t.id === parentId)).toBe(true); // its other clips still use it
		expect(swapped.clips.filter((c) => c.trackId === parentId).length).toBeGreaterThan(0);
		expect(fs.existsSync(edit.sourcePath)).toBe(true);
		await h.page.evaluate(() => (window as any).planner.store.set({ editFocus: false }));
		await h.page.keyboard.press("Meta+z");
		await expect.poll(() => fs.existsSync(edit.sourcePath)).toBe(false);
		expect(await state(h.page, "s => s.doc.clips")).toEqual(clipsBefore);
		// Put the set back as it was.
		await h.page.evaluate(() => (window as any).planner.store.undo());
		expect(await state<number>(h.page, "s => s.doc.clips.filter((c) => c.id.startsWith('ce-')).length")).toBe(0);
		// The parent open again, for the tests that follow.
		await h.page.evaluate((t) => (window as any).planner.openTrackEdit(t), parentId);
		await h.page.getByTestId("edit-section").first().waitFor();
	});

	it("Cmd+Shift+E makes two runs of clips into edits in the background, one clip each straight away", async () => {
		const parentId = await state<string>(h.page, "s => s.doc.tracks.find((t) => t.name === 'parent').id");
		const clipsBefore = await h.page.evaluate((lead) => {
			const { store } = (window as any).planner;
			const doc = store.get().doc;
			const parent = doc.tracks.find((t: any) => t.name === "parent");
			const mk = (id: string, startBeat: number, offsetBeat: number, lengthBeat: number): object => ({ id, trackId: parent.id, lane: 3, startBeat, offsetBeat, lengthBeat });
			store.commit({ ...doc, clips: [...doc.clips, mk("qe-a", 400, lead + 8, 8), mk("qe-b", 412, lead, 4), mk("qe-c", 500, lead, 8), mk("qe-d", 508, lead + 16, 8)] });
			store.set({ selection: ["qe-a", "qe-b"], editFocus: false });
			return store.get().doc.clips;
		}, LEAD);
		const editorBefore = await sections();
		await h.page.keyboard.press("Meta+Shift+e");
		// One clip of the new file at once, before its export is done; the editor is left alone.
		await expect.poll(() => state(h.page, "s => s.doc.clips.some((c) => c.id === 'qe-b')")).toBe(false);
		await h.page.evaluate(() => (window as any).planner.store.set({ selection: ["qe-c", "qe-d"] }));
		await h.page.keyboard.press("Meta+Shift+e");
		await expect.poll(() => state(h.page, "s => s.doc.clips.some((c) => c.id === 'qe-d')")).toBe(false);
		expect(await sections()).toEqual(editorBefore);
		const doc = await state<{ clips: any[]; tracks: any[] }>(h.page, "s => s.doc");
		const a = doc.clips.find((c) => c.id === "qe-a");
		const c = doc.clips.find((x) => x.id === "qe-c");
		expect([a.lane, a.startBeat, a.lengthBeat]).toEqual([3, 400, 16]);
		const files = [a, c].map((x) => doc.tracks.find((t) => t.id === x.trackId).sourcePath);
		expect(new Set(files).size).toBe(2); // each its own file
		for (const f of files) expect(f.startsWith(path.join(exportDir, "parent (edit"))).toBe(true);
		await expect.poll(() => files.every((f) => fs.existsSync(f)), { timeout: 60000 }).toBe(true);
		await shot(h.page, "trackedit-quick-edits");
		// Undone, the clips come back and the files go.
		await h.page.evaluate(() => (window as any).planner.store.set({ editFocus: false }));
		await h.page.keyboard.press("Meta+z");
		await h.page.keyboard.press("Meta+z");
		await expect.poll(() => files.some((f) => fs.existsSync(f))).toBe(false);
		expect(await state(h.page, "s => s.doc.clips")).toEqual(clipsBefore);
		await h.page.evaluate(() => (window as any).planner.store.undo());
		expect(await state<boolean>(h.page, `s => s.doc.tracks.some((t) => t.id === ${JSON.stringify(parentId)})`)).toBe(true);
	});

	it.skipIf(!realMp3)("exports a real MP3 as one clean decode of it: 24 bits, its own rate, every sample", async () => {
		const file = realMp3!;
		await importTrack(h.page, file, 140, 2, 0);
		await waitReady(h.page);
		const id = await state<string>(h.page, `s => s.doc.tracks.find((t) => t.sourcePath === ${JSON.stringify(file)}).id`);
		// On its own: opened next to the track that is open it would only get a lane to take pieces from.
		await h.page.getByTestId("edit-close").click();
		await h.page.evaluate((t) => (window as any).planner.openTrackEdit(t), id);
		await h.page.getByTestId("edit-section").first().waitFor();
		await shot(h.page, "trackedit-05-real-track");
		// Cut it up and take a look zoomed in, then put it back as it was.
		for (const beat of [64, 128, 192]) {
			await setCursor(beat);
			await h.page.getByTestId("edit-cut").click();
		}
		await h.page.getByTestId("edit-section").nth(1).click();
		for (let i = 0; i < 4; i++) await h.page.getByTestId("edit-zoom-in").click();
		await shot(h.page, "trackedit-06-zoomed-in");
		await h.page.getByTestId("edit-fit").click();
		for (let i = 0; i < 3; i++) await h.page.keyboard.press("Meta+z");
		expect(await sections()).toHaveLength(1);
		const out: string = await h.page.evaluate(() => (window as any).planner.exportTrackEdit());
		expect(out).toBe(path.join(exportDir, `${path.basename(file).replace(/\.[^.]+$/, "")} (edit).wav`));
		const ref = path.join(h.workDir, "ref.wav");
		execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI24", file, ref]);
		const a = audioOf(ref);
		const b = audioOf(out);
		expect({ sampleRate: b.sampleRate, bits: b.bits, channels: b.channels, frames: b.frames }).toEqual({ sampleRate: a.sampleRate, bits: 24, channels: a.channels, frames: a.frames });
		expect(b.data.equals(a.data)).toBe(true);
	});

	it("has a settings page next to New set that shows and keeps the export folder", async () => {
		await h.page.evaluate(() => (window as any).planner.goHome());
		await h.page.getByTestId("open-settings").click();
		await h.page.getByTestId("settings").waitFor();
		await expect.poll(() => h.page.getByTestId("export-dir").textContent()).toBe(exportDir);
		expect(JSON.parse(fs.readFileSync(path.join(h.dataDir, "settings.json"), "utf8")).exportDir).toBe(exportDir);
		await shot(h.page, "trackedit-04-settings");
		await h.page.getByTestId("settings-back").click();
		await h.page.getByTestId("home").waitFor();
	});
});
