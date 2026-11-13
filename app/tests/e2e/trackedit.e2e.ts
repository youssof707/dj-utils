// The track editor in the bottom part of the window: a track of the set is cut into
// sections, rearranged, and exported to the folder from the settings as the source's own
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
const sections = (): Promise<{ id: string; startBeat: number; lengthBeat: number; gapBeat?: number; src?: number }[]> => state(h.page, "s => s.trackEdit.sections");
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
	source = path.join(h.workDir, "parent.wav");
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
	it("opens a track from its clip's menu, as one section after the lead-in", async () => {
		await h.page.getByTestId("track-editor-empty").waitFor();
		await h.page.locator('[data-testid="clip"]').first().click({ button: "right", position: { x: 50, y: 40 } });
		await h.page.getByTestId("menu-edit").click();
		await h.page.getByTestId("track-editor").waitFor();
		expect(await h.page.getByTestId("edit-name").textContent()).toBe("parent");
		const s = await sections();
		expect(s).toHaveLength(1);
		expect(s[0].startBeat).toBeCloseTo(LEAD, 6);
		expect(await h.page.getByTestId("edit-section").count()).toBe(1);
		await shot(h.page, "trackedit-01-open");
	});

	it("cuts at the cursor, and its keys leave the timeline alone", async () => {
		await setCursor(LEAD + 32);
		await h.page.getByTestId("edit-cut").click();
		await setCursor(LEAD + 64);
		await h.page.getByTestId("edit-cut").click();
		expect((await sections()).map((s) => Math.round(s.startBeat - LEAD))).toEqual([0, 32, 64]);
		// Copy the middle section and take the copy away again, by keyboard.
		await h.page.getByTestId("edit-section").nth(1).click();
		await h.page.keyboard.press("Meta+d");
		expect((await sections()).map((s) => Math.round(s.startBeat - LEAD))).toEqual([0, 32, 32, 64]);
		await h.page.keyboard.press("Backspace");
		expect((await sections()).map((s) => Math.round(s.startBeat - LEAD))).toEqual([0, 32, 64]);
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

	it("moves a section by dragging it; the others close up around it", async () => {
		const last = (await h.page.getByTestId("edit-section").nth(2).boundingBox())!;
		const row = (await h.page.getByTestId("edit-row").boundingBox())!;
		const y = last.y + last.height / 2;
		await h.page.mouse.move(last.x + last.width / 2, y);
		await h.page.mouse.down();
		await h.page.mouse.move(last.x + last.width / 2 - 30, y, { steps: 3 });
		await h.page.mouse.move(row.x + 3, y, { steps: 6 });
		await h.page.mouse.up();
		const s = await sections();
		expect(s.map((x) => Math.round(x.startBeat - LEAD))).toEqual([64, 0, 32]);
		await shot(h.page, "trackedit-02-rearranged");
	});

	it("moves a section later in time with Option held, leaving silence, and never overlaps", async () => {
		const before = await sections();
		const out = (): Promise<number[]> => state(h.page, "s => window.planner.placeEdit(s.trackEdit).map((p) => p.outBeat)");
		const at = await out();
		const mid = (await h.page.getByTestId("edit-section").nth(1).boundingBox())!;
		const px: number = await state(h.page, "s => window.planner.editPx(s.trackEdit)");
		const y = mid.y + mid.height / 2;
		await h.page.mouse.move(mid.x + mid.width / 2, y);
		await h.page.mouse.down();
		await h.page.keyboard.down("Alt");
		await h.page.mouse.move(mid.x + mid.width / 2 + 2 * px, y, { steps: 3 });
		await h.page.mouse.move(mid.x + mid.width / 2 + 8 * px, y, { steps: 6 });
		await h.page.mouse.up();
		await h.page.keyboard.up("Alt");
		let s = await sections();
		// Same order, the second section 8 beats later with silence before it, and the third
		// pushed along so the two do not overlap.
		expect(s.map((x) => x.id)).toEqual(before.map((x) => x.id));
		expect(s.map((x) => x.gapBeat ?? 0)).toEqual([0, 8, 0]);
		let now = await out();
		expect(now[1] - at[1]).toBeCloseTo(8, 6);
		expect(now[2] - at[2]).toBeCloseTo(8, 6);
		// Option+Left moves it back a beat; the silence before the third section stays put.
		await h.page.keyboard.press("Alt+ArrowLeft");
		s = await sections();
		expect(s.map((x) => x.gapBeat ?? 0)).toEqual([0, 7, 1]);
		now = await out();
		expect(now[2] - at[2]).toBeCloseTo(8, 6);
		await shot(h.page, "trackedit-02b-silence");
		// Never earlier than the section before it ends.
		for (let i = 0; i < 12; i++) await h.page.keyboard.press("Alt+ArrowLeft");
		expect((await out())[1]).toBeCloseTo(at[1], 6);
		// One undo step for the drag and one for each Option+Left that moved it (8).
		for (let i = 0; i < 9; i++) await h.page.keyboard.press("Meta+z");
		expect(await sections()).toEqual(before);
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
		const lead = frameAt(LEAD);
		// The lead-in is still at the start, so the first beat is where the parent's is...
		expect(b.data.subarray(0, (lead - n) * fb).equals(a.data.subarray(0, (lead - n) * fb))).toBe(true);
		// ...and from that beat on it is the section that was dragged to the front, sample for
		// sample: the last one, which gave up its part beat (63 beats), then the first.
		const from = frameAt(LEAD + 64);
		const len = frameAt(LEAD + 63) - lead - n;
		expect(b.data.subarray(lead * fb, (lead + len) * fb).equals(a.data.subarray(from * fb, (from + len) * fb))).toBe(true);
		const second = frameAt(LEAD + 63);
		expect(b.data.subarray(second * fb, (second + 20000) * fb).equals(a.data.subarray(lead * fb, (lead + 20000) * fb))).toBe(true);
		// Nothing overlaps: the length is the sum of the sections.
		expect(b.frames).toBe(frameAt(LEAD + 63 + 64));
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
		const t = await state<{ sourcePath: string; bpm: number; downbeatSec: number }>(h.page, "s => s.trackEdit.track");
		expect(t.sourcePath).toBe(file);
		expect(t.bpm).toBe(BPM);
		expect(t.downbeatSec).toBeCloseTo(DOWNBEAT, 9);
		expect(await state<number>(h.page, "s => s.doc.tracks.length")).toBe(tracks);
		// Its waveform is made even though no clip uses it.
		await expect.poll(() => h.page.evaluate(() => document.querySelectorAll(".edit-section .edit-wave").length), { timeout: 60000 }).toBeGreaterThan(0);
		await expect.poll(() => h.page.getByTestId("edit-play").isEnabled(), { timeout: 60000 }).toBe(true);
	});

	it("puts a second track on a lane of its own, and its pieces go into the edit", async () => {
		// The exported edit is open; the parent comes in next to it.
		const id = await state<string>(h.page, "s => s.doc.tracks.find((t) => t.name === 'parent').id");
		await h.page.evaluate((t) => (window as any).planner.openTrackEdit(t), id);
		await h.page.getByTestId("edit-source-1").waitFor();
		expect(await h.page.getByTestId("edit-name").textContent()).toBe("parent (edit)");
		expect(await state<string>(h.page, "s => s.trackEdit.second.name")).toBe("parent");
		expect(await state(h.page, "s => s.trackEdit.lane")).toBe(1);
		const before = await sections();
		// Cuts on the parent's lane, 16 and 32 beats in: three pieces, and the edit as it was.
		for (const beat of [16, 32]) {
			await state(h.page, `s => { window.planner.store.set({ trackEdit: { ...s.trackEdit, lane: 1, cursorBeat: ${LEAD + beat} } }); return 0; }`);
			await h.page.getByTestId("edit-cut").click();
		}
		const pieces = h.page.locator('[data-testid="edit-source-1"] [data-testid="edit-piece"]');
		expect(await pieces.count()).toBe(3);
		expect(await sections()).toEqual(before);
		const added = async (): Promise<void> => {
			const now = await sections();
			expect(now).toHaveLength(before.length + 1);
			expect(now[now.length - 1].src).toBe(1);
			expect(now[now.length - 1].lengthBeat).toBeCloseTo(16, 6);
			expect(now[now.length - 1].startBeat).toBeCloseTo(LEAD + 16, 6);
			// The parent's lane shows which stretch of it is in the edit.
			expect(await h.page.locator('[data-testid="edit-source-1"] .edit-used').count()).toBe(1);
		};
		// The middle piece goes on the end of the edit with the button.
		await pieces.nth(1).click();
		await h.page.getByTestId("edit-add").click();
		await added();
		await h.page.keyboard.press("Meta+z");
		expect(await sections()).toEqual(before);
		// And by dragging it down to the end of the edit's lane, which shows where it would land.
		const from = (await pieces.nth(1).boundingBox())!;
		const row = (await h.page.getByTestId("edit-row").boundingBox())!;
		await h.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
		await h.page.mouse.down();
		await h.page.mouse.move(row.x + row.width - 6, row.y + row.height / 2, { steps: 8 });
		expect(await h.page.locator(".edit-section.incoming").count()).toBe(1);
		await h.page.mouse.up();
		await added();
		await shot(h.page, "trackedit-07-two-tracks");
		const out: string = await h.page.evaluate(() => (window as any).planner.exportTrackEdit());
		expect(fs.existsSync(out)).toBe(true);
		// Taking the parent out of the editor takes its piece out of the edit.
		await h.page.getByTestId("edit-remove-1").click();
		expect(await state(h.page, "s => s.trackEdit.second")).toBeNull();
		expect(await sections()).toEqual(before);
		expect(await h.page.getByTestId("edit-source-0").count()).toBe(0);
		// The parent on its own again, for the tests that follow.
		await h.page.getByTestId("edit-close").click();
		await h.page.evaluate((t) => (window as any).planner.openTrackEdit(t), id);
		await h.page.getByTestId("edit-section").first().waitFor();
	});

	it("sends the selected clips of one file to the editor with Cmd+E, cut up and spaced as on the timeline", async () => {
		// Two pieces of the parent, the later part first, four beats apart; and a clip of another file.
		const ids = await h.page.evaluate((lead) => {
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
		// Clips of two files: nothing happens, and no export dialog either.
		const before = await sections();
		await h.page.keyboard.press("Meta+e");
		expect(await sections()).toEqual(before);
		expect(await state(h.page, "s => s.exportUi")).toBeFalsy();
		expect(ids.other).toBeTruthy();
		// Clips of one file open it, arranged the same way.
		await h.page.evaluate(() => (window as any).planner.store.set({ selection: ["ce-a", "ce-b"], editFocus: false }));
		await h.page.keyboard.press("Meta+e");
		await expect.poll(() => h.page.getByTestId("edit-name").textContent()).toBe("parent");
		const got = await sections();
		expect(got.map((x) => [x.startBeat - LEAD, x.lengthBeat, x.gapBeat ?? 0].map((v) => Math.round(v * 1e6) / 1e6))).toEqual([
			[8, 8, 0],
			[0, 4, 4],
		]);
		expect(await state(h.page, "s => s.editFocus")).toBe(true);
		// Put the set back as it was.
		await h.page.evaluate(() => {
			const { store } = (window as any).planner;
			store.set({ editFocus: false });
			store.undo();
		});
		expect(await state<number>(h.page, "s => s.doc.clips.filter((c) => c.id.startsWith('ce-')).length")).toBe(0);
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
