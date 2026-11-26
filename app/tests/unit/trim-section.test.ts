import { describe, expect, it } from "vitest";
import { copySections, cutAt, fixRows, moveSections, removeSections, setFade, trimSection, type EditSection } from "../../src/shared/trackEdit";

// A section of beats 16–48 of a 64-beat track, at beat 8 of the lane, next to another one.
const base: EditSection[] = [
	{ id: "a", startBeat: 16, lengthBeat: 32, atBeat: 8 },
	{ id: "b", startBeat: 0, lengthBeat: 8, atBeat: 40 },
];

describe("trimSection", () => {
	it("moves the right edge: shorter or longer, as far as the track goes", () => {
		expect(trimSection(base, "a", "right", -8, 64)[0]).toEqual({ id: "a", startBeat: 16, lengthBeat: 24, atBeat: 8 });
		expect(trimSection(base, "a", "right", 100, 64)[0]).toEqual({ id: "a", startBeat: 16, lengthBeat: 48, atBeat: 8 });
		expect(trimSection(base, "a", "right", -100, 64, 4)[0].lengthBeat).toBe(4);
	});

	it("moves the left edge with the audio staying where it is on the lane", () => {
		expect(trimSection(base, "a", "left", 8, 64)[0]).toEqual({ id: "a", startBeat: 24, lengthBeat: 24, atBeat: 16 });
		// Growing back stops at the start of the lane (atBeat 0) before the start of the track.
		expect(trimSection(base, "a", "left", -100, 64)[0]).toEqual({ id: "a", startBeat: 8, lengthBeat: 40, atBeat: 0 });
		expect(trimSection(base, "a", "left", 100, 64, 2)[0]).toMatchObject({ lengthBeat: 2, atBeat: 38, startBeat: 46 });
	});

	it("leaves the others alone, and the same array when nothing changes", () => {
		const next = trimSection(base, "a", "right", -8, 64);
		expect(next[1]).toBe(base[1]);
		expect(trimSection(base, "a", "right", 0, 64)).toBe(base);
		expect(trimSection(base, "missing", "left", 4, 64)).toBe(base);
	});
});

describe("fades on the editor's sections", () => {
	const one: EditSection[] = [{ id: "a", startBeat: 0, lengthBeat: 16, atBeat: 0 }];

	it("sets a fade, as long as the other one leaves room for, and takes it away at 0", () => {
		let s = setFade(one, "a", "in", 4);
		expect(s[0].fadeInBeat).toBe(4);
		s = setFade(s, "a", "out", 100);
		expect(s[0].fadeOutBeat).toBe(12);
		s = setFade(s, "a", "in", 0);
		expect(s[0]).not.toHaveProperty("fadeInBeat");
		expect(setFade(s, "a", "out", 12)).toBe(s);
	});

	it("keeps the fade-in on the first part of a cut and the fade-out on the second", () => {
		const faded = setFade(setFade(one, "a", "in", 2), "a", "out", 3);
		let n = 0;
		const [x, y] = cutAt(faded, 8, () => `n${++n}`);
		expect(x).toMatchObject({ lengthBeat: 8, fadeInBeat: 2 });
		expect(x).not.toHaveProperty("fadeOutBeat");
		expect(y).toMatchObject({ lengthBeat: 8, fadeOutBeat: 3 });
		expect(y).not.toHaveProperty("fadeInBeat");
	});

	it("shrinks both fades together when a trim leaves too little room for them", () => {
		const faded = setFade(setFade(one, "a", "in", 8), "a", "out", 8);
		const [t] = trimSection(faded, "a", "right", -8, 16);
		expect(t.fadeInBeat).toBeCloseTo(4, 6);
		expect(t.fadeOutBeat).toBeCloseTo(4, 6);
	});
});

describe("copySections", () => {
	it("copies the chosen sections along the lane and leaves the originals where they were", () => {
		const r = copySections(base, ["a"], 16, (id) => `${id}-copy`);
		expect(r.copies).toEqual(["a-copy"]);
		expect(r.sections.slice(0, 2)).toEqual(base);
		expect(r.sections[2]).toEqual({ id: "a-copy", startBeat: 16, lengthBeat: 32, atBeat: 24 });
	});

	it("stops the copies at the start of the lane", () => {
		const r = copySections(base, ["a", "b"], -100, (id) => `${id}2`);
		expect(r.sections.slice(2).map((s) => s.atBeat)).toEqual([0, 32]);
	});
});

describe("fixRows", () => {
	const rowsOf = (s: EditSection[]): Record<string, number | undefined> => Object.fromEntries(s.map((x) => [x.id, x.row]));

	it("keeps a section on its row when the one it overlapped is cut and partly deleted", () => {
		// Track A on the top row, track B under it, overlapping from beat 64.
		const two = fixRows([
			{ id: "a", startBeat: 0, lengthBeat: 128, atBeat: 0 },
			{ id: "b", startBeat: 0, lengthBeat: 128, atBeat: 64 },
		]);
		expect(rowsOf(two)).toEqual({ a: 0, b: 1 });
		const cut = fixRows(cutAt(two, 64, () => "a2", ["a"]), two);
		const left = fixRows(removeSections(cut, ["a2"]), cut);
		expect(rowsOf(left)).toEqual({ a: 0, b: 1 });
	});

	it("moves only the section that was dragged onto another on its row", () => {
		const two = fixRows([
			{ id: "a", startBeat: 0, lengthBeat: 16, atBeat: 0 },
			{ id: "b", startBeat: 0, lengthBeat: 16, atBeat: 32 },
		]);
		expect(rowsOf(two)).toEqual({ a: 0, b: 0 });
		expect(rowsOf(fixRows(moveSections(two, ["b"], -24), two))).toEqual({ a: 0, b: 1 });
	});
});
