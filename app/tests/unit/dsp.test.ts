import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { computePeaks, finalize, keylock, mixClips, stretchFile, varispeed } from "../../src/main/audio/dsp";
import { SAMPLE_RATE as SR } from "../../src/shared/planner";
import { TempoMap } from "../../src/shared/tempo";
import { frequency, onsets, readAll, writeClickTrack, writeTone } from "../signals";

let dir: string;
beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-"));
});

describe("stretch on import", () => {
	it("lands beats of different tempos on the same grid", async () => {
		const a = path.join(dir, "a120.wav");
		const b = path.join(dir, "b140.wav");
		writeClickTrack(a, 120, 20, { kind: "float32" });
		writeClickTrack(b, 140, 20, { kind: "float32" });
		const as = path.join(dir, "a-s.wav");
		const bs = path.join(dir, "b-s.wav");
		await stretchFile(a, as, 120, 128);
		await stretchFile(b, bs, 140, 128);
		const beat = (60 / 128) * SR;
		for (const f of [as, bs]) {
			const on = onsets(readAll(f).left, 0.25);
			expect(on.length).toBeGreaterThan(30);
			const errs = on.map((o) => Math.abs(o - Math.round(o / beat) * beat));
			console.log(path.basename(f), "max beat error (ms)", (Math.max(...errs) / SR) * 1000);
			expect(Math.max(...errs) / SR).toBeLessThan(0.005);
		}
	});
});

describe("mix", () => {
	it("places clips at exact frames with trims", () => {
		const a = path.join(dir, "m.wav");
		writeClickTrack(a, 120, 10, { kind: "float32" });
		const out = path.join(dir, "mix.wav");
		// second clip starts 1 beat into the file and is placed at 3.0 s
		const { frames } = mixClips(
			[
				{ cachePath: a, startFrame: 0, offsetFrame: 0, frames: SR },
				{ cachePath: a, startFrame: 3 * SR, offsetFrame: SR / 2, frames: SR },
			],
			out,
		);
		expect(frames).toBe(4 * SR);
		const on = onsets(readAll(out).left, 0.5);
		expect(on).toEqual([0, SR / 2, 3 * SR, 3.5 * SR]);
	});
});

const points = [
	{ beat: 16, bpm: 120 },
	{ beat: 48, bpm: 150 },
];

describe("tempo stage", () => {
	const src = path.join(os.tmpdir(), "dsp-tempo-src.wav");
	beforeAll(() => {
		writeClickTrack(src, 120, 60, { kind: "float32", toneHz: 440 });
	});

	function checkTiming(file: string, tolSec: number): void {
		const map = new TempoMap(points, 120);
		const { left, frames } = readAll(file);
		expect(Math.abs(frames / SR - map.secondsAtBeat(120))).toBeLessThan(0.02);
		const on = onsets(left, 0.45);
		expect(on.length).toBeGreaterThan(110);
		let worst = 0;
		on.forEach((o, i) => {
			worst = Math.max(worst, Math.abs(o / SR - map.secondsAtBeat(i)));
		});
		console.log(path.basename(file), "clicks", on.length, "worst timing error (ms)", worst * 1000);
		expect(worst).toBeLessThan(tolSec);
	}

	it("varispeed follows the curve exactly and pitch moves with it", () => {
		const out = path.join(dir, "vari.wav");
		varispeed(src, out, points, 120);
		checkTiming(out, 0.0005);
		const { left } = readAll(out);
		const map = new TempoMap(points, 120);
		expect(frequency(left, 2.05, 0.3)).toBeCloseTo(440, 0);
		const late = map.secondsAtBeat(80) + 0.05;
		expect(frequency(left, late, 0.3)).toBeCloseTo(550, 0);
	});

	it("key lock follows the curve and holds pitch", async () => {
		const out = path.join(dir, "key.wav");
		await keylock(src, out, points, 120, dir);
		checkTiming(out, 0.012);
	});

	it("key lock holds a pure tone's pitch through a ramp", async () => {
		const tone = path.join(dir, "tone.wav");
		writeTone(tone, 440, 60);
		const out = path.join(dir, "tone-key.wav");
		await keylock(tone, out, points, 120, dir);
		const { left } = readAll(out);
		const map = new TempoMap(points, 120);
		for (const beat of [4, 24, 40, 60, 100]) {
			const f = frequency(left, map.secondsAtBeat(beat), 0.25);
			console.log("beat", beat, "freq", f.toFixed(2));
			expect(Math.abs(f - 440)).toBeLessThan(4);
		}
	});
});

describe("finalize and peaks", () => {
	it("turns the level down only when the mix would clip", () => {
		const a = path.join(dir, "loud.wav");
		writeTone(a, 100, 2, 0.9);
		const mix = path.join(dir, "loudmix.wav");
		mixClips(
			[
				{ cachePath: a, startFrame: 0, offsetFrame: 0, frames: 2 * SR },
				{ cachePath: a, startFrame: 0, offsetFrame: 0, frames: 2 * SR },
			],
			mix,
		);
		const out = path.join(dir, "final.wav");
		const { gain } = finalize(mix, out);
		expect(gain).toBeCloseTo(0.989 / 1.8, 2);
		const { left } = readAll(out);
		expect(Math.max(...left.subarray(0, SR))).toBeLessThanOrEqual(0.99);
		expect(Math.max(...left.subarray(0, SR))).toBeGreaterThan(0.97);
		const peaks = computePeaks(out);
		expect(peaks.length).toBe(Math.ceil((2 * SR) / 64) * 2);
		// a 100 Hz tone is all kick band: both layers near full scale
		expect(peaks[400]).toBeGreaterThan(240);
		expect(peaks[401]).toBeGreaterThan(225);
	});
});
