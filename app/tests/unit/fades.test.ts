import { describe, expect, it } from "vitest";
import { fadeGain, fitFades } from "../../src/shared/fades";
import type { Clip } from "../../src/shared/planner";

const clip = (lengthBeat: number, fadeInBeat?: number, fadeOutBeat?: number): Clip => ({ id: "c", trackId: "t", lane: 0, startBeat: 8, offsetBeat: 0, lengthBeat, fadeInBeat, fadeOutBeat });

describe("fade volume", () => {
	it("curves up from silence and goes back down to it in a straight line", () => {
		const g = (pos: number): number => fadeGain(pos, 100, 20, 40);
		expect(g(0)).toBe(0);
		expect(g(5)).toBeCloseTo(0.0625, 9);
		expect(g(10)).toBeCloseTo(0.25, 9);
		expect(g(20)).toBe(1);
		expect(g(60)).toBe(1);
		expect(g(80)).toBeCloseTo(0.5, 9);
		expect(g(100)).toBe(0);
	});

	it("is full volume everywhere without fades, and silent outside a faded clip", () => {
		expect(fadeGain(0, 100, 0, 0)).toBe(1);
		expect(fadeGain(100, 100, 0, 0)).toBe(1);
		expect(fadeGain(-1, 100, 20, 0)).toBe(0);
		expect(fadeGain(101, 100, 0, 20)).toBe(0);
	});
});

describe("fitting fades to a clip", () => {
	it("leaves fades that fit alone", () => {
		expect(fitFades(clip(32, 8, 4))).toEqual(clip(32, 8, 4));
	});

	it("shrinks both by the same factor when the clip is too short for them", () => {
		const c = fitFades(clip(6, 8, 4));
		expect(c.fadeInBeat).toBeCloseTo(4, 9);
		expect(c.fadeOutBeat).toBeCloseTo(2, 9);
	});

	it("drops the field when there is no fade, so an unfaded clip is stored as before", () => {
		const c = fitFades(clip(32, 0, -3));
		expect("fadeInBeat" in c).toBe(false);
		expect("fadeOutBeat" in c).toBe(false);
		expect(Object.keys(fitFades({ id: "c", trackId: "t", lane: 0, startBeat: 0, offsetBeat: 0, lengthBeat: 4 }))).toEqual(["id", "trackId", "lane", "startBeat", "offsetBeat", "lengthBeat"]);
	});
});
