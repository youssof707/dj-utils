import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { testDir } from "../testdata";
import { renderRamp, stretchFile } from "../../src/main/audio/dsp";
import { JOIN_FADE_SEC, SAMPLE_RATE as SR } from "../../src/shared/planner";
import { TempoMap } from "../../src/shared/tempo";
import { onsets, readAll, writeClickTrack } from "../signals";

let dir: string;
beforeAll(() => {
	dir = testDir("dsp-");
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

describe("ramp rendering", () => {
	// A stretch of a 120 BPM track that plays while the set goes from 128 to 140.
	const job = { bpm: 120, fromBeat: 20, lengthBeat: 32, bpmA: 128, bpmB: 140 };
	const map = new TempoMap(
		[
			{ beat: 0, bpm: 128 },
			{ beat: 32, bpm: 140 },
		],
		128,
	);

	it("puts every beat where the tempo curve says, starting a moment early", async () => {
		const src = path.join(dir, "ramp-src.wav");
		writeClickTrack(src, 120, 60, { kind: "float32" });
		const out = path.join(dir, "ramp.wav");
		const frames = await renderRamp({ ...job, decodedPath: src, outPath: out, tmpDir: dir });
		const lead = JOIN_FADE_SEC;
		expect(Math.abs(frames / SR - (lead + map.secondsAtBeat(32)))).toBeLessThan(0.001);
		// the 33rd beat falls right on the end of the file, and may just show
		const on = onsets(readAll(out).left, 0.4).slice(0, 32);
		expect(on.length).toBe(32);
		let worst = 0;
		on.forEach((o, i) => {
			worst = Math.max(worst, Math.abs(o / SR - lead - map.secondsAtBeat(i)));
		});
		console.log("ramp: clicks", on.length, "worst timing error (ms)", worst * 1000);
		expect(worst).toBeLessThan(0.002);
		expect(fs.readdirSync(dir).filter((f) => f.startsWith("rampjob-"))).toEqual([]);
	});
});
