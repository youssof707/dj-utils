import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { testDir } from "../testdata";
import { gridFromBeats, matchTrack, measureShift, parseAnlz, parseWaveform, scanLibrary } from "../../src/main/rekordbox";
import { SAMPLE_RATE as SR } from "../../src/shared/planner";
import { datFile, gridBeats, waveformOf, writeAnalysis } from "../anlz";
import { writeBarTrack } from "../signals";

let dir: string;
beforeAll(() => {
	dir = testDir("rekordbox-");
});

describe("analysis files", () => {
	it("gives nothing for damaged or foreign files", () => {
		const good = datFile("?/a.wav", gridBeats(128, 0, 1, 32));
		expect(parseAnlz(Buffer.alloc(0))).toBeNull();
		expect(parseAnlz(Buffer.from("not an analysis file at all"))).toBeNull();
		expect(parseWaveform(Buffer.from("RIFFxxxxWAVE"))).toBeNull();
		expect(parseWaveform(good)).toBeNull(); // a .DAT has no detailed waveform
		// cut off anywhere: never throws, never invents a grid
		for (let n = 0; n < good.length; n += 37) {
			const a = parseAnlz(good.subarray(0, n));
			if (a) expect(a.beats.length).toBeLessThanOrEqual(32);
		}
		const junk = Buffer.from(good);
		junk.writeUInt32BE(0xffffffff, 36); // a section claiming to be huge
		expect(parseAnlz(junk)).toBeNull();
	});
});

describe("beat grid", () => {
	it("uses the finer tempo of the beat times when the two-decimal BPM would drift", () => {
		// Rekordbox shows 150.00 for this grid, but its beats run at 149.9949.
		const beats = gridBeats(149.9949, 0.009, 1, 480).map((b) => ({ ...b, tempo: 15000 }));
		const g = gridFromBeats(beats)!;
		expect(g.bpm).toBeCloseTo(149.995, 3);
		expect(g.bpm).not.toBe(150);
		// over the whole track the chosen BPM stays within a millisecond of the grid
		const last = beats[beats.length - 1].ms;
		expect(Math.abs(g.downbeatMs + ((beats.length - 1) * 60000) / g.bpm - last)).toBeLessThan(1.5);
	});

	it("is exact to a fraction of a millisecond although times are whole milliseconds", () => {
		const g = gridFromBeats(gridBeats(127, 0.0337, 3, 500))!;
		expect(g.bpm).toBe(127);
		expect(g.downbeatMs).toBeCloseTo(33.7 + 2 * (60000 / 127), 1);
	});

});

describe("matching audio to its analysis", () => {
	let wav: string;
	let other: string;
	beforeAll(() => {
		wav = path.join(dir, "song.wav");
		other = path.join(dir, "other.wav");
		writeBarTrack(wav, 128, 60, { firstSec: 0.2, firstNo: 3, seed: 11 });
		writeBarTrack(other, 123, 60, { firstSec: 0.05, firstNo: 1, seed: 99 });
	});

	it("measures the padding Rekordbox keeps, to within a few samples", () => {
		// what Rekordbox keeps at the start of: an MP3 without a header, a typical MP3, an MP3
		// from LAME, an AAC file, and an AAC file with the longest padding in use
		for (const frames of [528, 1105, 2257, 2112, 5186]) {
			const m = measureShift(waveformOf(wav, frames), wav)!;
			console.log(`shift error at ${frames} (samples):`, (m.shiftSec * SR - frames).toFixed(2));
			expect(Math.abs(m.shiftSec * SR - frames)).toBeLessThan(11);
			expect(m.score).toBeGreaterThan(0.9);
		}
	});

	it("picks the analysis that belongs to the audio and puts its grid on our clock", () => {
		const root = path.join(dir, "lib2");
		const shift = 2257;
		const beats = gridBeats(128, 0.2 + shift / SR, 3, 120);
		const cache = path.join(dir, "lib2-cache.json");
		// same file name three times: another song (newest), the right one, and one with no waveform
		writeAnalysis(root, "?/song.wav", gridBeats(123, 0.05, 1, 120), waveformOf(other), { mtime: new Date(Date.now() + 60000) });
		writeAnalysis(root, "?/song.wav", beats, waveformOf(wav, shift), { mtime: new Date(Date.now() - 60000) });
		writeAnalysis(root, "?/song.wav", gridBeats(90, 0, 1, 120), null);
		const entries = scanLibrary(root, cache);
		expect(entries.length).toBe(3);
		const g = matchTrack(wav, entries)!;
		expect(g.bpm).toBe(128);
		// first bar line: 0.2 s plus two beats, on our clock
		expect(Math.abs(g.downbeatSec - (0.2 + (2 * 60) / 128)) * 1000).toBeLessThan(0.3);
		// nothing fits another recording
		expect(matchTrack(other, entries.filter((e) => e.bpm !== 123))).toBeNull();
		expect(matchTrack(other, entries)!.bpm).toBe(123);
	});

});
