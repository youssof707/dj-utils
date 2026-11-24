import { describe, expect, it } from "vitest";
import { cuesForEdit } from "../../src/shared/cdj";
import { MEMORY_CUES } from "../../src/shared/planner";
import { place, type EditSection } from "../../src/shared/trackEdit";

const sec = (beat: number, bpm: number): number => (beat * 60) / bpm;

describe("cuesForEdit", () => {
	it("moves each track's cues to where its sections play them; the first hot cue of a letter wins", () => {
		// track 0 at 120 BPM: beats 0–16 at 0; track 1 at 150 BPM: its beats 32–48 at 16
		const sections: EditSection[] = [
			{ id: "a", startBeat: 0, lengthBeat: 16, atBeat: 0 },
			{ id: "b", startBeat: 32, lengthBeat: 16, atBeat: 16, src: 1 },
		];
		const tracks = [
			{ bpm: 120, cues: [{ id: "1", sec: sec(4, 120), kind: 1 }, { id: "2", sec: sec(8, 120), kind: 0 }, { id: "3", sec: sec(20, 120), kind: 0 }] },
			{ bpm: 150, cues: [{ id: "4", sec: sec(36, 150), kind: 1 }, { id: "5", sec: sec(40, 150), kind: 2, loop: true }] },
		];
		expect(cuesForEdit(place(sections), tracks, 120)).toEqual([
			{ sec: sec(4, 120), kind: 1 },
			{ sec: sec(8, 120), kind: 0 },
			{ sec: sec(24, 120), kind: 2 },
		]);
	});

	it("keeps memory cues up to Rekordbox's limit, the first ones", () => {
		const cues = Array.from({ length: MEMORY_CUES + 3 }, (_, i) => ({ id: String(i), sec: sec(i * 4, 120), kind: 0 }));
		const out = cuesForEdit(place([{ id: "a", startBeat: 0, lengthBeat: 64, atBeat: 0 }]), [{ bpm: 120, cues }], 120);
		expect(out).toHaveLength(MEMORY_CUES);
		expect(out.map((c) => c.sec)).toEqual(cues.slice(0, MEMORY_CUES).map((c) => c.sec));
	});
});
