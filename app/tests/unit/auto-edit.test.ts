import { describe, expect, it } from "vitest";
import { clipsEdit, swapInEdit } from "../../src/shared/cdj";
import type { Clip, PlannerDoc, PlannerTrack } from "../../src/shared/planner";
import { place } from "../../src/shared/trackEdit";

const track: PlannerTrack = { id: "t", sourcePath: "/a.wav", name: "a", bpm: 120, durationSec: 120, downbeatSec: 0 };
const clips: Clip[] = [
	{ id: "a", trackId: "t", lane: 0, startBeat: 0, offsetBeat: 16, lengthBeat: 8, muted: true, lowCut: true },
	{ id: "b", trackId: "t", lane: 0, startBeat: 8, offsetBeat: 0, lengthBeat: 8 },
];

describe("clipsEdit", () => {
	it("puts muted clips in the edit like the rest; the joined clip is not muted, and keeps its bass cut on the timeline", () => {
		let n = 0;
		const { sections, links } = clipsEdit(track, clips, () => `e${n++}`);
		expect(links.map((l) => l.clipId).sort()).toEqual(["a", "b"]);
		const doc = { tracks: [track], clips } as unknown as PlannerDoc;
		const edit: PlannerTrack = { ...track, id: "edit", sourcePath: "/edit.wav" };
		const out = swapInEdit(doc, edit, links, place(sections)).doc.clips;
		expect(out).toHaveLength(1);
		expect(out[0].muted).toBeUndefined();
		expect(out[0].lowCut).toBe(true);
		expect(out[0].lengthBeat).toBe(16);
	});
});
