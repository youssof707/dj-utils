// The real thing: the Rekordbox library on this machine and the music files it points at,
// through the app, with the exported audio checked against Rekordbox's own waveform.
// Read-only towards Rekordbox and the music. Only runs when asked:
//   DJ_REAL_LIBRARY=<folder holding the music files> npx vitest run -c vitest.e2e.config.ts tests/e2e/rekordbox-library.e2e.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WavReader, WavWriter } from "../../src/main/audio/wav";
import { measureShift, nameKey, parseWaveform, type LibraryEntry } from "../../src/main/rekordbox";
import { SAMPLE_RATE as SR } from "../../src/shared/planner";
import { knownShifts } from "../anlz";
import { exportTo, launch, shot, state, waitReady, type Harness } from "./harness";

const MUSIC = process.env["DJ_REAL_LIBRARY"] ?? "";
const ROOT = process.env["DJ_REKORDBOX_DIR"] ?? path.join(os.homedir(), "Library/Pioneer/rekordbox/share/PIONEER/USBANLZ");

let h: Harness;
let started = 0;

function indexMusic(dir: string, out: Map<string, string[]>): void {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) indexMusic(p, out);
		else if (/\.(mp3|wav|aiff?|m4a)$/i.test(e.name)) out.set(nameKey(e.name), [...(out.get(nameKey(e.name)) ?? []), p]);
	}
}

describe.skipIf(!MUSIC || !fs.existsSync(ROOT))("the real Rekordbox library, through the app", () => {
	beforeAll(async () => {
		started = Date.now();
		h = await launch(undefined, undefined, { DJ_REKORDBOX_DIR: ROOT });
	});
	afterAll(async () => {
		await h?.close();
	});

	const drop = async (file: string, lane: number, beat: number): Promise<"placed" | "asked"> => {
		await h.page.evaluate(([p, l, b]) => (window as any).planner.importPaths([p], l, b), [file, lane, beat] as const);
		return (await state<number>(h.page, "s => s.importQueue.length")) > 0 ? "asked" : "placed";
	};

	it("places one real track of every kind with Rekordbox's bar line exactly on a bar", async () => {
		const cachePath = path.join(h.dataDir, "rekordbox-cache.json");
		await expect.poll(() => fs.existsSync(cachePath), { timeout: 30000 }).toBe(true);
		const scanned = Date.now() - started;
		const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { files: Record<string, { entry: LibraryEntry | null }> };
		const entries = Object.values(cache.files).flatMap((x) => (x.entry ? [x.entry] : []));
		console.log(`app start to library ready: ${scanned} ms for ${entries.length} tracks (first run, nothing cached)`);
		expect(entries.length).toBeGreaterThan(100);

		// one file of each kind Rekordbox decodes differently, at a whole BPM so it is not stretched
		const music = new Map<string, string[]>();
		indexMusic(MUSIC, music);
		const byName = new Map<string, LibraryEntry[]>();
		for (const e of entries) byName.set(nameKey(e.name), [...(byName.get(nameKey(e.name)) ?? []), e]);
		const picks = new Map<string, { file: string; entry: LibraryEntry; shifts: number[] }>();
		for (const [key, list] of [...byName].sort((a, b) => a[0].localeCompare(b[0]))) {
			const files = music.get(key);
			if (list.length !== 1 || files?.length !== 1 || !Number.isInteger(list[0].bpm)) continue;
			if (fs.statSync(files[0]).mtimeMs > list[0].mtimeMs) continue; // file changed after Rekordbox analysed it
			const known = knownShifts(files[0]);
			const kind = known.kind === ".m4a" ? `.m4a ${picks.has(".m4a 0") ? 1 : 0}` : known.kind;
			if (!picks.has(kind)) picks.set(kind, { file: files[0], entry: list[0], ...known });
		}
		console.log("kinds found:", [...picks.keys()].join(" | "));
		expect(picks.size).toBeGreaterThanOrEqual(4);

		let n = 0;
		for (const [kind, pick] of picks) {
			n++;
			await h.page.evaluate((bpm) => {
				const p = (window as any).planner;
				p.newSet();
				p.store.load({ version: 1, bpm, tracks: [], clips: [], tempos: [] }, null, false);
			}, pick.entry.bpm);
			const t0 = Date.now();
			expect(await drop(pick.file, 0, 8), `${kind}: ${path.basename(pick.file)}`).toBe("placed");
			const importMs = Date.now() - t0;
			const [t] = await state<any[]>(h.page, "s => s.doc.tracks");
			const [c] = await state<any[]>(h.page, "s => s.doc.clips");
			expect(t.bpm).toBe(pick.entry.bpm);
			// the shift the app found is the one this kind of file is known to have
			const shift = pick.entry.downbeatMs / 1000 - t.downbeatSec;
			const nearest = pick.shifts.reduce((a, b) => (Math.abs(b - shift) < Math.abs(a - shift) ? b : a));
			expect(Math.abs(shift - nearest) * 1000, `${kind}: shift ${shift}`).toBeLessThan(0.25);
			// the clip sits on the bar it was dropped on (or a hair after, if the bar line is before the audio)
			expect(c.startBeat - 8).toBeGreaterThanOrEqual(0);
			expect(c.startBeat - 8).toBeLessThan(1);
			const barBeat = c.startBeat - c.offsetBeat + (t.downbeatSec * t.bpm) / 60;
			expect(Math.abs(barBeat / 4 - Math.round(barBeat / 4)) * 4).toBeLessThan(1e-6);

			// Export, then hold the exported audio against Rekordbox's waveform: put Rekordbox's
			// time zero where the app says it is on the timeline, and the two must agree with
			// no shift left over.
			await waitReady(h.page);
			// and it can be played: its audio loads into the player
			await expect.poll(() => h.page.evaluate(() => (window as any).planner.engine.debug().buffers), { timeout: 20000, message: `${kind}: audio did not load` }).toBeGreaterThan(0);
			const out = path.join(h.workDir, `real-${n}.wav`);
			await exportTo(h.page, out, true);
			await h.page.getByTestId("export-done").waitFor({ timeout: 300000 });
			await h.page.getByTestId("export-close").click();
			const framesPerBeat = (60 / pick.entry.bpm) * SR;
			const barFrame = Math.round(barBeat / 4) * 4 * framesPerBeat; // a timeline bar line...
			const zero = Math.round(barFrame - (pick.entry.downbeatMs / 1000) * SR); // ...is this bar line of Rekordbox's
			const r = new WavReader(out);
			const len = Math.min(r.frames - Math.max(0, zero), 200 * SR);
			const buf = new Float32Array((len + Math.max(0, -zero)) * 2);
			r.read(zero, len + Math.max(0, -zero), buf);
			r.close();
			const cut = path.join(h.workDir, `real-${n}-cut.wav`);
			const w = new WavWriter(cut, SR, "float32");
			w.write(buf, buf.length / 2);
			w.close();
			const m = measureShift(parseWaveform(fs.readFileSync(pick.entry.dat.replace(/\.DAT$/, ".EXT")))!, cut)!;
			console.log(`${kind.padEnd(40)} BPM ${String(t.bpm).padEnd(4)} Rekordbox ahead by ${(shift * SR).toFixed(1).padStart(7)} frames; import ${String(importMs).padStart(5)} ms; in the export Rekordbox's bar line is ${(m.shiftSec * 1000).toFixed(3)} ms from ours (agreement ${m.score.toFixed(2)})  ${path.basename(pick.file).slice(0, 44)}`);
			expect(m.score).toBeGreaterThan(0.5);
			expect(Math.abs(m.shiftSec) * 1000).toBeLessThan(0.3);
			if (n === 1) await shot(h.page, "rb-03-real");
			fs.rmSync(out, { force: true });
			fs.rmSync(cut, { force: true });
		}
	}, 3600000);
});
