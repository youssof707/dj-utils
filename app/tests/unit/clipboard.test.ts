import { describe, expect, it } from "vitest";
import { parseSnippet, pasteSnippet, snippetOf, SNIPPET_FORMAT } from "../../src/shared/clipboard";
import type { PlannerDoc } from "../../src/shared/planner";

const doc: PlannerDoc = {
	version: 1,
	bpm: 128,
	tracks: [
		{ id: "t1", sourcePath: "/music/a.wav", name: "a", bpm: 128, durationSec: 60, downbeatSec: 0.1 },
		{ id: "t2", sourcePath: "/music/b.wav", name: "b", bpm: 100, durationSec: 60 },
	],
	clips: [
		{ id: "c1", trackId: "t1", lane: 0, startBeat: 16, offsetBeat: 0, lengthBeat: 32, fadeOutBeat: 4 },
		{ id: "c2", trackId: "t2", lane: 1, startBeat: 64, offsetBeat: 8, lengthBeat: 16, muted: true },
		{ id: "c3", trackId: "t2", lane: 2, startBeat: 200, offsetBeat: 0, lengthBeat: 16 },
	],
	tempos: [
		{ id: "b1", startBeat: 40, lengthBeat: 8, bpm: 140 },
		{ id: "b2", startBeat: 72, lengthBeat: 4, bpm: 120, off: true },
	],
};

let n = 0;
const newId = (p: string): string => `${p}new${++n}`;

describe("copy and paste of clips and tempo changes", () => {
	it("copies the selection with its files, counted from its earliest item", () => {
		const text = JSON.stringify(snippetOf(doc, ["c1", "c2", "b1", "b2"]));
		const snip = parseSnippet(text)!;
		expect(snip.format).toBe(SNIPPET_FORMAT);
		expect(snip.tracks.map((t) => t.sourcePath)).toEqual(["/music/a.wav", "/music/b.wav"]);
		expect(snip.clips.map((c) => c.startBeat)).toEqual([0, 48]);
		expect(snip.tempos.map((t) => t.startBeat)).toEqual([24, 56]);
		expect(snip.clips[0].fadeOutBeat).toBe(4);
		expect(snip.clips[1].muted).toBe(true);
		expect(snip.tempos[1].off).toBe(true);
		expect(snippetOf(doc, [])).toBeNull();
	});

	it("takes only text made by the app", () => {
		expect(parseSnippet("hello")).toBeNull();
		expect(parseSnippet('{"tracks":[],"clips":[],"tempos":[]}')).toBeNull();
		const snip = snippetOf(doc, ["c1"])!;
		expect(parseSnippet(JSON.stringify({ ...snip, version: 2 }))).toBeNull();
		expect(parseSnippet(JSON.stringify({ ...snip, tracks: [] }))).toBeNull();
		expect(parseSnippet(JSON.stringify({ ...snip, clips: [{ ...snip.clips[0], lengthBeat: "x" }] }))).toBeNull();
	});

	it("pastes into an empty set at the given beat, spaced as copied", () => {
		const snip = parseSnippet(JSON.stringify(snippetOf(doc, ["c1", "c2", "b1"])))!;
		const empty: PlannerDoc = { version: 1, bpm: 150, tracks: [], clips: [], tempos: [] };
		const r = pasteSnippet(empty, snip, 100, newId);
		expect(r.doc.tracks.map((t) => t.sourcePath)).toEqual(["/music/a.wav", "/music/b.wav"]);
		expect(r.doc.clips.map((c) => c.startBeat)).toEqual([100, 148]);
		expect(r.doc.clips.map((c) => r.doc.tracks.find((t) => t.id === c.trackId)?.name)).toEqual(["a", "b"]);
		expect(r.doc.tempos.map((t) => [t.startBeat, t.lengthBeat, t.bpm])).toEqual([[124, 8, 140]]);
		expect(r.ids).toHaveLength(3);
	});

	it("reuses tracks already in the set, and the pasted tempo changes win", () => {
		const snip = snippetOf(doc, ["c1", "b1", "b2"])!;
		// Pasted tempo changes cover beats 224 to 260.
		const target: PlannerDoc = {
			...doc,
			tempos: [
				{ id: "x1", startBeat: 210, lengthBeat: 20, bpm: 90 }, // starts before: stays
				{ id: "x2", startBeat: 230, lengthBeat: 4, bpm: 95 }, // starts inside: goes
				{ id: "x3", startBeat: 260, lengthBeat: 4, bpm: 99 }, // starts at the end: stays
			],
		};
		const r = pasteSnippet(target, snip, 200, newId);
		expect(r.doc.tracks).toHaveLength(2);
		expect(r.doc.clips).toHaveLength(4);
		expect(r.doc.clips[3].trackId).toBe("t1");
		expect(r.doc.tempos.map((t) => t.startBeat)).toEqual([210, 260, 224, 256]);
	});
});
