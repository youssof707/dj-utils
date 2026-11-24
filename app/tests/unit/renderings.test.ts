import { describe, expect, it } from "vitest";
import type { PlannerDoc } from "../../src/shared/planner";
import { normalizeDoc } from "../../src/shared/renderings";

describe("the renderings a set plays", () => {
	it("reads sets from before tempo blocks and whole-number tempos", () => {
		const old = { version: 1, bpm: 127.6, tracks: [], clips: [], points: [{ id: "p1", beat: 0, bpm: 127.6 }, { id: "p2", beat: 32, bpm: 139.7 }] } as unknown as PlannerDoc;
		const doc = normalizeDoc(old);
		expect(doc.bpm).toBe(128);
		expect(doc.tempos.length).toBeGreaterThan(0);
		expect(doc.tempos.every((t) => Number.isInteger(t.bpm))).toBe(true);
		expect("points" in doc).toBe(false);
	});
});
