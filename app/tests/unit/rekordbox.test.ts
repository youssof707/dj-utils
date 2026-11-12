import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findAnalysisRoot, gridFromBeats, matchTrack, measureShift, MIN_MATCH, nameKey, parseAnlz, parseWaveform, scanLibrary, type AnlzBeat } from "../../src/main/rekordbox";
import { firstBarBeat, SAMPLE_RATE as SR, type PlannerTrack } from "../../src/shared/planner";
import { datFile, extFile, gridBeats, waveformOf, writeAnalysis } from "../anlz";
import { writeBarTrack } from "../signals";

let dir: string;
beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "rekordbox-"));
});

describe("analysis files", () => {
	it("reads the file name and beat grid", () => {
		const beats = gridBeats(150, 0.006, 1, 40);
		const a = parseAnlz(datFile("?/Some Track (Original Mix).wav", beats))!;
		expect(a.name).toBe("Some Track (Original Mix).wav");
		expect(a.beats).toEqual(beats);
		// older libraries store the whole path; accents survive
		expect(parseAnlz(datFile("/Users/me/Music/Løve – Café.mp3", beats))!.name).toBe("Løve – Café.mp3");
	});

	it("reads the detailed waveform from either section", () => {
		const heights = Uint8Array.from({ length: 900 }, (_, i) => (i * 7) % 32);
		expect(Array.from(parseWaveform(extFile("?/a.wav", heights))!)).toEqual(Array.from(heights));
		expect(Array.from(parseWaveform(extFile("?/a.wav", heights, "PWV5"))!)).toEqual(Array.from(heights));
	});

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
	it("keeps Rekordbox's BPM when it matches the grid", () => {
		const g = gridFromBeats(gridBeats(150, 0.0064, 1, 600))!;
		expect(g.bpm).toBe(150);
		expect(g.downbeatMs).toBeCloseTo(6.4, 0);
	});

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

	it("finds the first bar line whatever beat the track starts on", () => {
		const beatMs = 60000 / 128;
		for (const [firstNo, bars] of [
			[1, 0],
			[2, 3],
			[3, 2],
			[4, 1],
		] as const) {
			const g = gridFromBeats(gridBeats(128, 0.1, firstNo, 64))!;
			expect(g.downbeatMs).toBeCloseTo(100 + bars * beatMs, 0);
		}
	});

	it("is exact to a fraction of a millisecond although times are whole milliseconds", () => {
		const g = gridFromBeats(gridBeats(127, 0.0337, 3, 500))!;
		expect(g.bpm).toBe(127);
		expect(g.downbeatMs).toBeCloseTo(33.7 + 2 * (60000 / 127), 1);
	});

	it("takes the main section of a grid that was shifted part-way", () => {
		// 24 beats, then the grid jumps 130 ms and carries on for 200 beats with its own bar count
		const head = gridBeats(140, 0.05, 1, 24);
		const tail = gridBeats(140, 0.05 + (24 * 60) / 140 + 0.13, 3, 200);
		const g = gridFromBeats([...head, ...tail])!;
		expect(g.bpm).toBe(140);
		const beatMs = 60000 / 140;
		const barLine = tail[2].ms; // the tail's first bar line
		const fromGrid = (barLine - g.downbeatMs) / (4 * beatMs);
		expect(Math.abs(fromGrid - Math.round(fromGrid)) * 4 * beatMs).toBeLessThan(0.6);
		expect(g.downbeatMs).toBeGreaterThanOrEqual(0);
		expect(g.downbeatMs).toBeLessThan(4 * beatMs);
	});

	it("gives no grid for a tempo that keeps changing, or too few beats", () => {
		const wobble: AnlzBeat[] = [];
		let ms = 0;
		for (let i = 0; i < 300; i++) {
			const tempo = 12000 + ((i * 37) % 900);
			wobble.push({ no: (i % 4) + 1, tempo, ms: Math.round(ms) });
			ms += 6000000 / tempo;
		}
		expect(gridFromBeats(wobble)).toBeNull();
		expect(gridFromBeats(gridBeats(128, 0, 1, 7))).toBeNull();
		expect(gridFromBeats([])).toBeNull();
	});
});

describe("first bar line of a track", () => {
	const track = (bpm: number, downbeatSec?: number): PlannerTrack => ({ id: "t", sourcePath: "/x.wav", name: "x", bpm, durationSec: 200, downbeatSec });
	it("is null without a Rekordbox grid", () => {
		expect(firstBarBeat(track(128))).toBeNull();
	});
	it("is the bar line's distance into the file, in beats", () => {
		expect(firstBarBeat(track(120, 0.25))).toBeCloseTo(0.5, 9);
		expect(firstBarBeat(track(120, 0))).toBe(0);
		// any bar line names the same grid
		expect(firstBarBeat(track(120, 0.25 + 2 * 7))).toBeCloseTo(0.5, 9);
		expect(firstBarBeat(track(120, 0.25 - 2 * 3))).toBeCloseTo(0.5, 9);
	});
	it("is slightly negative when the bar line falls just before the first sample", () => {
		expect(firstBarBeat(track(120, -0.005))).toBeCloseTo(-0.01, 9);
		expect(firstBarBeat(track(120, 2 - 0.02))).toBeCloseTo(-0.04, 9);
		// as far back as the padding Rekordbox keeps on MP3 and AAC files can put it
		expect(firstBarBeat(track(150, -0.0512))).toBeCloseTo(-0.128, 9);
		expect(firstBarBeat(track(120, -0.2))).toBeCloseTo(-0.4, 9);
		// further back than that it is the next bar line that counts
		expect(firstBarBeat(track(120, -0.3))).toBeCloseTo(3.4, 9);
	});
});

describe("finding the library", () => {
	const standard = (home: string): string => path.join(home, "Library/Pioneer/rekordbox/share/PIONEER/USBANLZ");
	const settings = (home: string, text: string): void => {
		const dirPath = path.join(home, "Library/Application Support/Pioneer/rekordboxAgent/storage");
		fs.mkdirSync(dirPath, { recursive: true });
		fs.writeFileSync(path.join(dirPath, "options.json"), text);
	};
	it("is null when Rekordbox was never installed", () => {
		expect(findAnalysisRoot(fs.mkdtempSync(path.join(os.tmpdir(), "home-")))).toBeNull();
	});
	it("is the standard place by default", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		fs.mkdirSync(standard(home), { recursive: true });
		expect(findAnalysisRoot(home)).toBe(standard(home));
		// settings that say nothing about it, or are damaged, change nothing
		settings(home, JSON.stringify({ options: [["db-path", "/somewhere/master.db"], ["port", "30008"]] }));
		expect(findAnalysisRoot(home)).toBe(standard(home));
		settings(home, "{ damaged");
		expect(findAnalysisRoot(home)).toBe(standard(home));
		settings(home, JSON.stringify({ options: "nonsense" }));
		expect(findAnalysisRoot(home)).toBe(standard(home));
	});
	it("follows a library that was moved, and falls back if the new place is not there", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		const drive = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
		fs.mkdirSync(standard(home), { recursive: true });
		settings(home, JSON.stringify({ options: [["db-path", path.join(drive, "master.db")], ["analysis-data-root-path", path.join(drive, "share")]] }));
		expect(findAnalysisRoot(home)).toBe(standard(home)); // the drive is not plugged in
		fs.mkdirSync(path.join(drive, "share", "PIONEER", "USBANLZ"), { recursive: true });
		expect(findAnalysisRoot(home)).toBe(path.join(drive, "share", "PIONEER", "USBANLZ"));
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

	it("measures no shift for a file Rekordbox decodes the way we do", () => {
		const m = measureShift(waveformOf(wav), wav)!;
		console.log("shift error at 0 (samples):", (m.shiftSec * SR).toFixed(2));
		expect(Math.abs(m.shiftSec * SR)).toBeLessThan(11); // a quarter of a millisecond
		expect(m.score).toBeGreaterThan(0.9);
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

	it("scores a different recording far below the same one", () => {
		const m = measureShift(waveformOf(other), wav);
		expect(m === null || m.score < MIN_MATCH / 2).toBe(true);
	});

	it("scans a library, caches it and re-reads only what changed", () => {
		const root = path.join(dir, "lib", "PIONEER", "USBANLZ");
		const cache = path.join(dir, "lib-cache.json");
		const beats = gridBeats(128, 0.2, 3, 120);
		const dat = writeAnalysis(root, "?/song.wav", beats, waveformOf(wav), { mtime: new Date(1700000000000) });
		writeAnalysis(root, "?/no grid.wav", [], null);
		const first = scanLibrary(root, cache);
		expect(first.map((e) => e.name)).toEqual(["song.wav"]);
		expect(first[0].bpm).toBe(128);
		expect(first[0].dat).toBe(dat);
		const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
		expect(Object.keys(saved.files).length).toBe(2);

		// unchanged library: served from the cache without opening the analysis files
		const stamp = fs.statSync(dat);
		fs.writeFileSync(dat, Buffer.from("garbage"));
		fs.truncateSync(dat, stamp.size);
		fs.utimesSync(dat, new Date(1700000000000), new Date(1700000000000));
		expect(scanLibrary(root, cache)).toEqual(first);

		// a changed file is read again; a removed one disappears; a new one appears
		fs.writeFileSync(dat, datFile("?/song.wav", gridBeats(140, 0.1, 1, 120)));
		fs.utimesSync(dat, new Date(), new Date(Date.now() + 5000));
		const added = writeAnalysis(root, "?/new one.mp3", gridBeats(100, 0, 1, 50), null);
		const second = scanLibrary(root, cache);
		expect(second.find((e) => e.name === "song.wav")!.bpm).toBe(140);
		expect(second.some((e) => e.name === "new one.mp3")).toBe(true);
		fs.rmSync(path.dirname(added), { recursive: true });
		expect(scanLibrary(root, cache).some((e) => e.name === "new one.mp3")).toBe(false);

		// a damaged cache is rebuilt, a missing library is simply empty
		fs.writeFileSync(cache, "{ not json");
		expect(scanLibrary(root, cache).length).toBe(1);
		expect(scanLibrary(path.join(dir, "nowhere"), path.join(dir, "nowhere.json"))).toEqual([]);
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

	it("prefers the newer of two analyses of the same audio", () => {
		const root = path.join(dir, "lib3");
		writeAnalysis(root, "?/song.wav", gridBeats(128, 0.2, 3, 120), waveformOf(wav), { mtime: new Date(Date.now() - 60000) });
		writeAnalysis(root, "?/song.wav", gridBeats(128, 0.21, 2, 120), waveformOf(wav), { mtime: new Date(Date.now() + 60000) });
		const g = matchTrack(wav, scanLibrary(root, path.join(dir, "lib3-cache.json")))!;
		expect(g.downbeatSec).toBeCloseTo(0.21 + (3 * 60) / 128, 3);
	});

	it("compares file names without regard to case or how accents are stored", () => {
		expect(nameKey("Café Del Mar.MP3")).toBe(nameKey("Café del mar.mp3"));
	});
});
