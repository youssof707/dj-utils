import { describe, expect, it } from "vitest";
import { TempoMap, bpmAt, isFlat } from "../../src/shared/tempo";

describe("tempo curve", () => {
	it("is the project BPM with no points", () => {
		const m = new TempoMap([], 120);
		expect(m.secondsAtBeat(120)).toBeCloseTo(60, 9);
		expect(m.beatAtSeconds(30)).toBeCloseTo(60, 9);
		expect(bpmAt([], 120, 50)).toBe(120);
		expect(isFlat([], 120)).toBe(true);
	});

	it("holds flat before the first and after the last point", () => {
		const pts = [
			{ beat: 100, bpm: 140 },
			{ beat: 200, bpm: 100 },
		];
		expect(bpmAt(pts, 120, 0)).toBe(140);
		expect(bpmAt(pts, 120, 150)).toBe(120);
		expect(bpmAt(pts, 120, 500)).toBe(100);
		const m = new TempoMap(pts, 120);
		expect(m.secondsAtBeat(100)).toBeCloseTo((100 * 60) / 140, 9);
		expect(m.bpmAtBeat(150)).toBeCloseTo(120, 9);
		const tEnd = m.secondsAtBeat(200);
		expect(m.secondsAtBeat(260) - tEnd).toBeCloseTo((60 * 60) / 100, 9);
	});

	it("integrates a ramp exactly (checked against fine numeric integration)", () => {
		const pts = [
			{ beat: 16, bpm: 120 },
			{ beat: 48, bpm: 150 },
		];
		const m = new TempoMap(pts, 128);
		let t = 0;
		const n = 400000;
		const end = 64;
		for (let i = 0; i < n; i++) t += (60 / bpmAt(pts, 128, ((i + 0.5) * end) / n)) * (end / n);
		expect(m.secondsAtBeat(end)).toBeCloseTo(t, 6);
	});

	it("round-trips beats and seconds", () => {
		const m = new TempoMap(
			[
				{ beat: 8, bpm: 90 },
				{ beat: 40, bpm: 174 },
				{ beat: 40, bpm: 120 },
				{ beat: 90, bpm: 128.5 },
			],
			128,
		);
		for (const b of [0, 3, 8, 20.5, 40, 41, 77.7, 90, 300]) expect(m.beatAtSeconds(m.secondsAtBeat(b))).toBeCloseTo(b, 7);
	});

	it("accepts points in any order", () => {
		const a = new TempoMap(
			[
				{ beat: 48, bpm: 150 },
				{ beat: 16, bpm: 120 },
			],
			120,
		);
		const b = new TempoMap(
			[
				{ beat: 16, bpm: 120 },
				{ beat: 48, bpm: 150 },
			],
			120,
		);
		expect(a.secondsAtBeat(100)).toBe(b.secondsAtBeat(100));
	});
});
