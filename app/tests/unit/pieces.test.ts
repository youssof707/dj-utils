import { describe, expect, it } from "vitest";
import { clipPieces, isRamp } from "../../src/shared/pieces";
import { rampKey, rampRequest, type Clip, type PlannerTrack } from "../../src/shared/planner";
import { TempoMap, blocksToPoints } from "../../src/shared/tempo";

const track: PlannerTrack = { id: "t", sourcePath: "/x.wav", name: "x", bpm: 120, durationSec: 100 }; // 200 beats
const clip = (startBeat: number, offsetBeat: number, lengthBeat: number): Clip => ({ id: "c", trackId: "t", lane: 0, startBeat, offsetBeat, lengthBeat });
const mapOf = (blocks: { startBeat: number; lengthBeat: number; bpm: number }[], bpm = 128): TempoMap => new TempoMap(blocksToPoints(blocks, bpm), bpm);

describe("clip pieces", () => {
	it("is one piece at the project tempo when there are no tempo changes", () => {
		expect(clipPieces(clip(8, 4, 100), track, mapOf([]))).toEqual([{ fromBeat: 8, toBeat: 108, trackBeat: 4, bpmA: 128, bpmB: 128 }]);
	});

	it("cuts a clip at the start and end of a tempo change", () => {
		const ps = clipPieces(clip(0, 10, 100), track, mapOf([{ startBeat: 32, lengthBeat: 16, bpm: 140 }]));
		expect(ps).toEqual([
			{ fromBeat: 0, toBeat: 32, trackBeat: 10, bpmA: 128, bpmB: 128 },
			{ fromBeat: 32, toBeat: 48, trackBeat: 42, bpmA: 128, bpmB: 140 },
			{ fromBeat: 48, toBeat: 100, trackBeat: 58, bpmA: 140, bpmB: 140 },
		]);
		expect(ps.map(isRamp)).toEqual([false, true, false]);
	});

	it("gives a clip that starts part-way through a change the tempo it meets there", () => {
		const ps = clipPieces(clip(40, 0, 20), track, mapOf([{ startBeat: 32, lengthBeat: 16, bpm: 140 }]));
		expect(ps).toEqual([
			{ fromBeat: 40, toBeat: 48, trackBeat: 0, bpmA: 134, bpmB: 140 },
			{ fromBeat: 48, toBeat: 60, trackBeat: 8, bpmA: 140, bpmB: 140 },
		]);
	});

	it("is one piece for a clip that lies wholly after the last change", () => {
		expect(clipPieces(clip(64, 0, 50), track, mapOf([{ startBeat: 32, lengthBeat: 16, bpm: 140 }]))).toEqual([{ fromBeat: 64, toBeat: 114, trackBeat: 0, bpmA: 140, bpmB: 140 }]);
	});

	it("does not cut where a change leaves the tempo as it was", () => {
		expect(clipPieces(clip(0, 0, 100), track, mapOf([{ startBeat: 32, lengthBeat: 16, bpm: 128 }]))).toHaveLength(1);
	});

	it("follows two changes that run into each other without a steady stretch between", () => {
		const ps = clipPieces(
			clip(0, 0, 100),
			track,
			mapOf([
				{ startBeat: 16, lengthBeat: 16, bpm: 140 },
				{ startBeat: 24, lengthBeat: 8, bpm: 120 },
			]),
		);
		expect(ps.map((p) => [p.fromBeat, p.toBeat, p.bpmA, p.bpmB])).toEqual([
			[0, 16, 128, 128],
			[16, 24, 128, 134],
			[24, 32, 134, 120],
			[32, 100, 120, 120],
		]);
	});

	it("stops where the track's audio ends, however long the clip is", () => {
		const ps = clipPieces(clip(0, 150, 500), track, mapOf([{ startBeat: 32, lengthBeat: 16, bpm: 140 }]));
		expect(ps[ps.length - 1].toBeat).toBe(50);
		expect(clipPieces(clip(0, 200, 10), track, mapOf([]))).toEqual([]);
	});

	it("pieces join end to end and cover the clip", () => {
		const ps = clipPieces(
			clip(3.5, 2.25, 120),
			track,
			mapOf([
				{ startBeat: 10, lengthBeat: 7, bpm: 133 },
				{ startBeat: 40, lengthBeat: 0.05, bpm: 150 },
				{ startBeat: 60, lengthBeat: 30, bpm: 100 },
			]),
		);
		expect(ps[0].fromBeat).toBe(3.5);
		expect(ps[ps.length - 1].toBeat).toBe(123.5);
		for (let i = 1; i < ps.length; i++) {
			expect(ps[i].fromBeat).toBe(ps[i - 1].toBeat);
			expect(ps[i].bpmA).toBeCloseTo(ps[i - 1].bpmB, 9);
			expect(ps[i].trackBeat - ps[i - 1].trackBeat).toBeCloseTo(ps[i].fromBeat - ps[i - 1].fromBeat, 9);
		}
	});
});

describe("ramp requests", () => {
	it("have the same key however the numbers were arrived at", () => {
		const a = rampRequest(track, 0.1 + 0.2, 16, 128, 140);
		const b = rampRequest(track, 0.3, 16.0000000001, 128, 140);
		expect(rampKey(a)).toBe(rampKey(b));
		expect(rampKey(a)).not.toBe(rampKey(rampRequest(track, 0.3, 16, 128, 141)));
	});
});
