import { describe, expect, it } from "vitest";
import type { PlannerDoc } from "../../src/shared/planner";
import { normalizeDoc, renderingsFor } from "../../src/shared/renderings";

const track = (id: string, bpm: number) => ({ id, sourcePath: `/music/${id}.wav`, name: id, bpm, durationSec: 120 });
const clip = (id: string, trackId: string, startBeat: number, lengthBeat: number) => ({ id, trackId, lane: 0, startBeat, offsetBeat: 0, lengthBeat });

describe("the renderings a set plays", () => {
	it("is one per track at the project tempo when the tempo never changes", () => {
		const doc: PlannerDoc = { version: 1, bpm: 128, tracks: [track("a", 120), track("b", 130)], clips: [clip("c1", "a", 0, 64), clip("c2", "a", 64, 64), clip("c3", "b", 128, 64)], tempos: [] };
		const r = renderingsFor(doc);
		expect(r.map((x) => x.key)).toEqual(["/music/a.wav|120|128", "/music/b.wav|130|128"]);
		expect(r.every((x) => x.base && !x.ramp)).toBe(true);
	});

	it("adds the ramp and the new tempo for clips under a tempo change, once each", () => {
		const doc: PlannerDoc = {
			version: 1,
			bpm: 128,
			tracks: [track("a", 120), track("b", 130)],
			// a plays across the change; b starts after it, twice
			clips: [clip("c1", "a", 0, 64), clip("c2", "b", 64, 32), clip("c3", "b", 96, 32)],
			tempos: [{ id: "t", startBeat: 16, lengthBeat: 16, bpm: 140 }],
		};
		const r = renderingsFor(doc);
		const extra = r.filter((x) => !x.base);
		expect(r.filter((x) => x.base).length).toBe(2);
		expect(extra.filter((x) => x.ramp).length).toBe(1);
		expect(extra.filter((x) => !x.ramp).map((x) => x.key).sort()).toEqual(["/music/a.wav|120|140", "/music/b.wav|130|140"]);
		expect(extra.find((x) => x.ramp)!.beat).toBe(16);
		expect(extra.find((x) => x.key === "/music/b.wav|130|140")!.beat).toBe(64);
		// the same set gives the same keys every time: this is what the cache is shared by
		expect(renderingsFor(doc).map((x) => x.key)).toEqual(r.map((x) => x.key));
	});

	it("reads sets from before tempo blocks and whole-number tempos", () => {
		const old = { version: 1, bpm: 127.6, tracks: [], clips: [], points: [{ id: "p1", beat: 0, bpm: 127.6 }, { id: "p2", beat: 32, bpm: 139.7 }] } as unknown as PlannerDoc;
		const doc = normalizeDoc(old);
		expect(doc.bpm).toBe(128);
		expect(doc.tempos.length).toBeGreaterThan(0);
		expect(doc.tempos.every((t) => Number.isInteger(t.bpm))).toBe(true);
		expect("points" in doc).toBe(false);
	});
});
