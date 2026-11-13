import { describe, expect, it } from "vitest";
import type { PlannerTrack } from "../../src/shared/planner";
import { addCut, barPhase, cutAt, duplicateSections, editSlices, gapOf, initialSections, insertSections, leadBeat, moveSections, piecesOf, place, removeSections, secondOffset, sectionsFromClips, slideSections, snapBeat, totalBeats, type EditSection } from "../../src/shared/trackEdit";

// 120 BPM, so a beat is half a second. The first bar line is 0.6 s in: beat 1.2.
const track: PlannerTrack = { id: "t", sourcePath: "/x.wav", name: "x", bpm: 120, durationSec: 60.2, downbeatSec: 0.6 };
const plain: PlannerTrack = { id: "p", sourcePath: "/p.wav", name: "p", bpm: 120, durationSec: 60 };

let n = 0;
const id = (): string => `n${++n}`;
const starts = (lead: number, s: EditSection[]): number[] => place(lead, s).map((p) => Math.round(p.outBeat * 1e6) / 1e6);
const ids = (s: EditSection[]): string => s.map((x) => x.id).join(" ");

// Sections butt end to end: each starts where the one before stops.
function gapless(lead: number, s: EditSection[]): void {
	let at = lead;
	for (const p of place(lead, s)) {
		expect(p.outBeat).toBeCloseTo(at, 9);
		at += p.lengthBeat;
	}
	expect(totalBeats(lead, s)).toBeCloseTo(at, 9);
}

describe("track editor sections", () => {
	it("starts as the whole track after the lead-in before its first beat", () => {
		expect(leadBeat(track)).toBeCloseTo(0.2, 9);
		expect(barPhase(track)).toBeCloseTo(1.2, 9);
		const s = initialSections(track, "a");
		expect(s).toHaveLength(1);
		expect(s[0].startBeat).toBeCloseTo(0.2, 9);
		expect(s[0].lengthBeat).toBeCloseTo(120.4 - 0.2, 9);
		// No grid: the track starts on its first beat.
		expect(leadBeat(plain)).toBe(0);
		expect(barPhase(plain)).toBe(0);
		expect(initialSections(plain, "a")).toEqual([{ id: "a", startBeat: 0, lengthBeat: 120 }]);
	});

	it("snaps to beat lines, or bar lines when zoomed out, never before the first beat", () => {
		expect(snapBeat(10.6, 0.2, 1.2, 1, 120)).toBeCloseTo(10.2, 9);
		expect(snapBeat(10.8, 0.2, 1.2, 1, 120)).toBeCloseTo(11.2, 9);
		expect(snapBeat(10.6, 0.2, 1.2, 4, 120)).toBeCloseTo(9.2, 9);
		expect(snapBeat(0, 0.2, 1.2, 4, 120)).toBeCloseTo(1.2, 9);
		expect(snapBeat(-3, 0.2, 1.2, 1, 120)).toBeCloseTo(0.2, 9);
		expect(snapBeat(500, 0.2, 1.2, 1, 120)).toBe(120);
	});

	it("cuts a section in two without moving anything", () => {
		const lead = leadBeat(plain);
		const a = initialSections(plain, "a");
		const b = cutAt(lead, a, 32, id);
		expect(b).toHaveLength(2);
		expect(b[0]).toEqual({ id: "a", startBeat: 0, lengthBeat: 32 });
		expect(b[1]).toMatchObject({ startBeat: 32, lengthBeat: 88 });
		gapless(lead, b);
		// On an existing cut, at the ends, or outside: nothing changes.
		expect(cutAt(lead, b, 32, id)).toBe(b);
		expect(cutAt(lead, b, 0, id)).toBe(b);
		expect(cutAt(lead, b, 120, id)).toBe(b);
		expect(cutAt(lead, b, 300, id)).toBe(b);
	});

	it("cuts by where a section sits in the edit, not where it came from", () => {
		// The second half first: beat 10 of the edit is beat 70 of the track.
		const s: EditSection[] = [
			{ id: "b", startBeat: 60, lengthBeat: 60 },
			{ id: "a", startBeat: 0, lengthBeat: 60 },
		];
		const c = cutAt(0, s, 10, id);
		expect(c.map((x) => [x.startBeat, x.lengthBeat])).toEqual([
			[60, 10],
			[70, 50],
			[0, 60],
		]);
	});

	it("closes the gap when sections are deleted", () => {
		let s = initialSections(plain, "a");
		s = cutAt(0, s, 16, () => "b");
		s = cutAt(0, s, 48, () => "c");
		const d = removeSections(s, ["b"]);
		expect(ids(d)).toBe("a c");
		expect(starts(0, d)).toEqual([0, 16]);
		expect(totalBeats(0, d)).toBe(88);
		gapless(0, d);
		expect(removeSections(s, ["nope"])).toBe(s);
		expect(totalBeats(0, removeSections(s, ["a", "b", "c"]))).toBe(0);
	});

	it("puts copies right after the sections they were made from", () => {
		let s = initialSections(plain, "a");
		s = cutAt(0, s, 16, () => "b");
		s = cutAt(0, s, 48, () => "c");
		const r = duplicateSections(s, ["b"], () => "b2");
		expect(ids(r.sections)).toBe("a b b2 c");
		expect(r.copies).toEqual(["b2"]);
		expect(starts(0, r.sections)).toEqual([0, 16, 48, 80]);
		expect(totalBeats(0, r.sections)).toBe(152);
		gapless(0, r.sections);
		// Two at once keep their order.
		let k = 0;
		const two = duplicateSections(s, ["a", "b"], () => `k${++k}`);
		expect(ids(two.sections)).toBe("a b k1 k2 c");
		expect(duplicateSections(s, [], id).sections).toBe(s);
	});

	it("moves sections to a new place, the others closing up around them", () => {
		let s = initialSections(plain, "a");
		s = cutAt(0, s, 16, () => "b");
		s = cutAt(0, s, 48, () => "c");
		expect(ids(moveSections(s, ["c"], 0))).toBe("c a b");
		expect(ids(moveSections(s, ["a"], 3))).toBe("b c a");
		expect(ids(moveSections(s, ["a"], 2))).toBe("b a c");
		expect(ids(moveSections(s, ["a", "c"], 1))).toBe("a c b");
		// Dropped where it already is: nothing changes.
		expect(moveSections(s, ["b"], 1)).toBe(s);
		expect(moveSections(s, ["b"], 2)).toBe(s);
		const m = moveSections(s, ["c"], 0);
		expect(starts(0, m)).toEqual([0, 72, 88]);
		expect(totalBeats(0, m)).toBe(120);
		gapless(0, m);
	});

	it("keeps what follows on the grid when the end of the track is moved forward", () => {
		// After the lead-in the track is 120.2 beats long; its last section carries the odd 0.2.
		const lead = leadBeat(track);
		let s = initialSections(track, "a");
		s = cutAt(lead, s, lead + 100, () => "end");
		expect(totalBeats(lead, s)).toBeCloseTo(120.4, 9);
		const m = moveSections(s, ["end"], 0);
		const placed = place(lead, m);
		// Moved to the front it is 20 whole beats, so the next section starts on a beat line.
		expect(placed[0].lengthBeat).toBe(20);
		expect(placed[1].outBeat).toBeCloseTo(lead + 20, 9);
	});

	// a 0-16, b 16-48, c 48-120 of the plain track, butted end to end.
	const abc = (): EditSection[] => {
		let s = initialSections(plain, "a");
		s = cutAt(0, s, 16, () => "b");
		return cutAt(0, s, 48, () => "c");
	};
	const gaps = (s: EditSection[]): number[] => s.map(gapOf);

	it("moves a section later in time and leaves silence before it, pushing what follows", () => {
		const s = abc();
		const m = slideSections(s, ["b"], 4);
		expect(ids(m)).toBe("a b c");
		expect(gaps(m)).toEqual([0, 4, 0]);
		expect(starts(0, m)).toEqual([0, 20, 52]);
		expect(totalBeats(0, m)).toBe(124);
		// Back again: the silence closes, and c stays where it was (there is room before it).
		const back = slideSections(m, ["b"], -4);
		expect(gaps(back)).toEqual([0, 0, 4]);
		expect(starts(0, back)).toEqual([0, 16, 52]);
		// Later again: it uses up the silence before c first, then pushes.
		expect(starts(0, slideSections(back, ["b"], 2))).toEqual([0, 18, 52]);
		expect(starts(0, slideSections(back, ["b"], 6))).toEqual([0, 22, 54]);
	});

	it("never moves a section earlier than the one before it ends", () => {
		const s = abc();
		expect(slideSections(s, ["b"], -4)).toBe(s);
		const m = slideSections(s, ["b"], 3);
		const back = slideSections(m, ["b"], -10);
		expect(starts(0, back)).toEqual([0, 16, 51]);
		// The first section moves in after the lead-in, and the start of the file stays put.
		const lead = leadBeat(track);
		const t = slideSections(initialSections(track, "a"), ["a"], 8);
		expect(place(lead, t)[0].outBeat).toBeCloseTo(lead + 8, 9);
		expect(slideSections(t, ["a"], -20).map(gapOf)).toEqual([0]);
		// Whole beats only.
		expect(gaps(slideSections(s, ["c"], 2.4))).toEqual([0, 0, 2]);
	});

	it("moves several sections together and keeps the space between them", () => {
		const s = slideSections(abc(), ["c"], 4);
		const m = slideSections(s, ["b", "c"], 8);
		expect(gaps(m)).toEqual([0, 8, 4]);
		expect(starts(0, m)).toEqual([0, 24, 60]);
		// As far back as the silence before b allows.
		expect(starts(0, slideSections(m, ["b", "c"], -100))).toEqual([0, 16, 52]);
	});

	it("leaves silence where it was when sections around it are deleted, moved or copied", () => {
		const s = slideSections(slideSections(abc(), ["b"], 4), ["c"], 8);
		expect(starts(0, s)).toEqual([0, 20, 60]);
		// b goes: c closes up to where b started, after the silence that was before b.
		const d = removeSections(s, ["b"]);
		expect(gaps(d)).toEqual([0, 12]);
		expect(starts(0, d)).toEqual([0, 28]);
		// c to the front: it lands at the start, and the silences stay between a and b, b and c.
		const m = moveSections(s, ["c"], 0);
		expect(ids(m)).toBe("c a b");
		expect(gaps(m)).toEqual([0, 0, 4]);
		// b to the end: both silences were between a and c, and stay there; b follows c.
		const m2 = moveSections(s, ["b"], 3);
		expect(ids(m2)).toBe("a c b");
		expect(gaps(m2)).toEqual([0, 12, 0]);
		expect(starts(0, m2)).toEqual([0, 28, 100]);
		// Dropped where it is: nothing changes, silence included.
		expect(moveSections(s, ["b"], 1)).toBe(s);
		expect(moveSections(s, ["b"], 2)).toBe(s);
		// A copy goes straight after its original; the silence after stays before c.
		const c = duplicateSections(s, ["b"], () => "b2");
		expect(ids(c.sections)).toBe("a b b2 c");
		expect(gaps(c.sections)).toEqual([0, 4, 0, 8]);
		// A cut inside b: the silence stays before b's first half.
		expect(gaps(cutAt(0, s, 24, () => "b3"))).toEqual([0, 4, 0, 8]);
		// A cut in the silence does nothing.
		expect(cutAt(0, s, 18, id)).toBe(s);
	});

	it("exports silence as silence, with every section on its beat", () => {
		const bpm = 120;
		const sr = 48000;
		const frames = sr * 60; // 120 beats
		const s = slideSections(slideSections(abc(), ["b"], 4), ["c"], 1);
		const fb = (b: number): number => Math.round(((b * 60) / bpm) * sr);
		expect(editSlices(0, s, bpm, sr, frames)).toEqual([
			{ start: 0, frames: fb(16) },
			{ start: 0, frames: fb(4), silent: true },
			{ start: fb(16), frames: fb(32) },
			{ start: 0, frames: fb(1), silent: true },
			{ start: fb(48), frames: frames - fb(48) },
		]);
	});

	it("makes sections of a track's clips on the timeline, in order, with the space between them", () => {
		// Out of order, one overlapping the one before, one before the lead-in, one to the file's end.
		const clips = [
			{ startBeat: 40, offsetBeat: 17.2, lengthBeat: 8 },
			{ startBeat: 10, offsetBeat: 0, lengthBeat: 9.2 },
			{ startBeat: 19.2, offsetBeat: 33.2, lengthBeat: 4 },
			{ startBeat: 21.2, offsetBeat: 5.2, lengthBeat: 4 },
			{ startBeat: 64, offsetBeat: 112.2, lengthBeat: 8.2 },
		];
		const s = sectionsFromClips(track, clips, id);
		expect(s.map((x) => [x.startBeat, x.lengthBeat, gapOf(x)].map((v) => Math.round(v * 1e6) / 1e6))).toEqual([
			[0.2, 9, 0],
			[33.2, 4, 0],
			[5.2, 4, 0],
			[17.2, 8, 15],
			[112.2, 8.2, 16],
		]);
		expect(starts(0.2, s)).toEqual([0.2, 9.2, 13.2, 32.2, 56.2]);
		expect(sectionsFromClips(track, [], id)).toEqual([]);
	});
});

describe("two tracks in the editor", () => {
	// The edit: 8 beats, 4 beats of silence, 8 beats. A piece of the second track comes in.
	const edit: EditSection[] = [
		{ id: "a", startBeat: 0.2, lengthBeat: 8 },
		{ id: "b", startBeat: 16.2, lengthBeat: 8, gapBeat: 4 },
	];
	const piece = (lengthBeat: number): EditSection[] => [{ id: "x", startBeat: 32.2, lengthBeat, src: 1 }];

	it("puts a dropped piece at the nearer end of the section it is dropped on", () => {
		const before = insertSections(0.2, edit, piece(4), 2, 0.2);
		expect(ids(before)).toBe("x a b");
		expect(starts(0.2, before)).toEqual([0.2, 4.2, 16.2]);
		const after = insertSections(0.2, edit, piece(4), 6, 4.2);
		expect(ids(after)).toBe("a x b");
		expect(starts(0.2, after)).toEqual([0.2, 8.2, 16.2]);
		expect(after[1].src).toBe(1);
	});

	it("puts a piece dropped on empty space where it is dropped, and only moves what it needs the room of", () => {
		// It fits the silence: what follows stays.
		const fits = insertSections(0.2, edit, piece(2), 10, 9.2);
		expect(ids(fits)).toBe("a x b");
		expect(starts(0.2, fits)).toEqual([0.2, 9.2, 12.2]);
		// Too long for it: what follows moves along.
		expect(starts(0.2, insertSections(0.2, edit, piece(4), 10, 9.2))).toEqual([0.2, 9.2, 13.2]);
		// It cannot start before the section ahead of it ends.
		expect(starts(0.2, insertSections(0.2, edit, piece(2), 10, 6.2))).toEqual([0.2, 8.2, 12.2]);
		// Past the end, with silence before it.
		const end = insertSections(0.2, edit, piece(4), 30, 24.2);
		expect(ids(end)).toBe("a b x");
		expect(starts(0.2, end)).toEqual([0.2, 12.2, 24.2]);
		// Into an empty edit.
		expect(starts(0.2, insertSections(0.2, [], piece(4), 3, 2.2))).toEqual([2.2]);
		expect(insertSections(0.2, edit, [], 3, 2.2)).toBe(edit);
	});

	it("cuts a track's own lane into pieces on its beat lines without losing any of it", () => {
		const cuts = addCut(track, addCut(track, [], 48.4), 16.3);
		expect(cuts.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([16.2, 48.2]);
		expect(addCut(track, cuts, 16.2)).toBe(cuts);
		expect(addCut(track, cuts, 0.2)).toBe(cuts);
		expect(addCut(track, cuts, 500)).toBe(cuts);
		const pieces = piecesOf(track, cuts);
		expect(pieces.map((p) => [p.startBeat, p.lengthBeat].map((v) => Math.round(v * 1e6) / 1e6))).toEqual([
			[0.2, 16],
			[16.2, 32],
			[48.2, 72.2],
		]);
		expect(piecesOf(plain, [])).toEqual([{ startBeat: 0, lengthBeat: 120 }]);
	});

	it("lines the second track's bar lines up with the first one's", () => {
		expect(secondOffset(track, plain)).toBeCloseTo(1.2, 9);
		expect(secondOffset(plain, track)).toBeCloseTo(2.8, 9);
		expect(secondOffset(track, track)).toBe(0);
	});

	it("takes each section's frames from its own track, on the first track's clock", () => {
		const sr = 48000;
		const f = (beats: number): number => Math.round(beats * 24000); // 120 BPM
		const sections = [
			{ startBeat: 0, lengthBeat: 8 },
			{ startBeat: 4, lengthBeat: 4, src: 1 },
			{ startBeat: 8, lengthBeat: 4, src: 1 },
			{ startBeat: 8, lengthBeat: 8 },
		];
		expect(editSlices(0, sections, 120, sr, [f(16), f(12)])).toEqual([
			{ start: 0, frames: f(8) },
			{ start: f(4), frames: f(8), src: 1 },
			{ start: f(8), frames: f(8) },
		]);
		// The same place in the two tracks is not the same audio: no joining across them.
		expect(
			editSlices(
				0,
				[
					{ startBeat: 0, lengthBeat: 8 },
					{ startBeat: 8, lengthBeat: 4, src: 1 },
				],
				120,
				sr,
				[f(16), f(12)],
			),
		).toEqual([
			{ start: 0, frames: f(8) },
			{ start: f(8), frames: f(4), src: 1 },
		]);
		// An edit that opens with the second track has silence where the first one's lead-in was.
		expect(editSlices(0.5, [{ startBeat: 4.5, lengthBeat: 4, src: 1 }], 120, sr, [f(16), f(12)])).toEqual([
			{ start: 0, frames: f(0.5), silent: true },
			{ start: f(4.5), frames: f(4), src: 1 },
		]);
	});
});
