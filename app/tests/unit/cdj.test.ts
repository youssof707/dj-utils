import { describe, expect, it } from "vitest";
import { emptyDoc, type Clip, type PlannerDoc } from "../../src/shared/planner";
import { autoEdit, clipsEdit, cuesForEdit, swapInEdit, tracksToEdit } from "../../src/shared/cdj";
import { leadBeat, place } from "../../src/shared/trackEdit";

// 120 BPM tracks, so a second is two beats and the slack is two beats.
function doc(clips: Partial<Clip>[]): PlannerDoc {
	const d = emptyDoc(120);
	d.tracks = ["a", "b"].map((id) => ({ id, sourcePath: `/${id}.wav`, name: id, bpm: 120, durationSec: 600 }));
	d.clips = clips.map((c, i) => ({ id: `c${i}`, trackId: "a", lane: 0, startBeat: 0, offsetBeat: 0, lengthBeat: 32, ...c }));
	return d;
}

describe("tracksToEdit", () => {
	it("passes a track cut and carried on, with or without a gap", () => {
		expect(tracksToEdit(doc([{}, { startBeat: 32, offsetBeat: 32 }]))).toEqual(new Set());
		expect(tracksToEdit(doc([{}, { startBeat: 37, offsetBeat: 37, lane: 2 }]))).toEqual(new Set()); // five beats apart
		expect(tracksToEdit(doc([{}, { startBeat: 32, offsetBeat: 33.5 }]))).toEqual(new Set()); // within a second
		expect(tracksToEdit(doc([{}, { trackId: "b", startBeat: 32, offsetBeat: 200 }]))).toEqual(new Set()); // another track
	});

	it("flags a track that jumps in itself, or whose gap is not in the track", () => {
		expect(tracksToEdit(doc([{}, { startBeat: 32, offsetBeat: 96 }]))).toEqual(new Set(["a"])); // skips to the drop
		expect(tracksToEdit(doc([{}, { startBeat: 40, offsetBeat: 32 }]))).toEqual(new Set(["a"])); // a gap the track goes on through
		expect(tracksToEdit(doc([{}, { startBeat: 32, offsetBeat: 0 }]))).toEqual(new Set(["a"])); // played twice
	});

	it("leaves out muted clips", () => {
		expect(tracksToEdit(doc([{}, { startBeat: 32, offsetBeat: 96, muted: true }, { startBeat: 64, offsetBeat: 64 }]))).toEqual(new Set());
	});
});

describe("automatic edits", () => {
	// The drop (beats 32 to 96) cut out and the two ends put together, the second clip after a
	// four-beat gap on another lane.
	const set = doc([{ id: "x", lengthBeat: 32 }, { id: "y", startBeat: 36, offsetBeat: 96, lengthBeat: 32, lane: 1 }, { id: "z", startBeat: 80, offsetBeat: 0, muted: true }]);
	const track = set.tracks[0];
	let n = 0;
	const { sections, links } = autoEdit(set, track, () => `s${n++}`);
	const edit = { ...track, id: "e", sourcePath: "/a (edit).wav" };

	it("lays the clips out as the set plays them, gaps as silence, muted clips left out", () => {
		expect(sections).toEqual([{ id: "s0", startBeat: 0, lengthBeat: 32 }, { id: "s1", startBeat: 96, lengthBeat: 32, gapBeat: 4 }]);
		expect(links).toEqual([{ clipId: "x", sectionId: "s0" }, { clipId: "y", sectionId: "s1" }]);
	});

	it("swaps the edit in, so the track plays straight through", () => {
		const { doc: after, moved } = swapInEdit(set, edit, links, place(leadBeat(track), sections));
		expect(after.clips.map((c) => [c.id, c.trackId, c.offsetBeat, c.lengthBeat])).toEqual([["x", "e", 0, 68], ["z", "a", 0, 32]]); // one clip now
		expect(after.tracks.map((t) => t.id)).toEqual(["a", "b", "e"]); // the muted clip still uses the old track
		expect(tracksToEdit(after)).toEqual(new Set());
		expect(moved).toHaveLength(2);
		// A memory cue in each clip, a hot cue A in the cut-out drop (left out), and B in the second clip.
		const cues = [{ id: "1", sec: 4, kind: 0 }, { id: "2", sec: 30, kind: 1 }, { id: "3", sec: 50, kind: 0 }, { id: "4", sec: 51, kind: 2 }];
		expect(cuesForEdit(cues, track, edit, moved)).toEqual([{ sec: 4, kind: 0 }, { sec: 20, kind: 0 }, { sec: 21, kind: 2 }]);
	});

	it("swaps only the clips that were sent (Cmd+E), and keeps the track while others use it", () => {
		const two = { ...set, tracks: [...set.tracks, { ...track, id: "a2" }], clips: [...set.clips, { id: "w", trackId: "a2", lane: 2, startBeat: 36, offsetBeat: 32, lengthBeat: 32 }] };
		let k = 0;
		const sent = clipsEdit(track, two.clips.filter((c) => c.id === "x" || c.id === "w"), () => `t${k++}`);
		expect(sent.links.map((l) => l.clipId)).toEqual(["x", "w"]);
		const { doc: after } = swapInEdit(two, edit, sent.links, place(leadBeat(track), sent.sections));
		expect(after.clips.map((c) => [c.id, c.trackId])).toEqual([["x", "e"], ["y", "a"], ["z", "a"]]); // w joined onto x
		expect(after.tracks.map((t) => t.id)).toEqual(["a", "b", "e"]); // a2 has no clips left
	});

	it("takes clips of two tracks: the build of one, then the drop of the other", () => {
		const b = set.tracks[1];
		const mix = { ...set, clips: [{ id: "build", trackId: "a", lane: 0, startBeat: 0, offsetBeat: 0, lengthBeat: 32 }, { id: "drop", trackId: "b", lane: 1, startBeat: 32, offsetBeat: 64, lengthBeat: 32 }] };
		let k = 0;
		const sent = clipsEdit([track, b], mix.clips, () => `m${k++}`, (c) => (c.trackId === "b" ? 1 : 0));
		expect(sent.sections).toEqual([{ id: "m0", startBeat: 0, lengthBeat: 32 }, { id: "m1", startBeat: 64, lengthBeat: 32, src: 1 }]);
		const { doc: after } = swapInEdit(mix, edit, sent.links, place(leadBeat(track), sent.sections));
		expect(after.clips.map((c) => [c.id, c.trackId, c.offsetBeat, c.lengthBeat])).toEqual([["build", "e", 0, 64]]);
		expect(after.tracks.map((t) => t.id)).toEqual(["e"]);
		expect(tracksToEdit(after)).toEqual(new Set());
	});
});
