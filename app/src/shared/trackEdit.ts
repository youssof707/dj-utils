// The track editor's model: one lane, like a lane of the set, with stretches of any number of
// tracks on it (sections), each at a place of its own. Sections may overlap; where they do,
// both are heard. Positions in a section's own track are in that track's beats; places on the
// lane (`atBeat`) are beats of the result, counted from the start of the file. The result has
// the first track's tempo and beat grid, and the other tracks are played at that tempo.

import { firstBarBeat, trackBeats, type PlannerTrack } from "./planner";

// A stretch of a track: where it starts in the track and how long it is, and where on the lane
// it starts. `src` says which of the editor's tracks it is a stretch of: the first when left out.
export type Span = { startBeat: number; lengthBeat: number; atBeat: number; src?: number };
export type EditSection = Span & { id: string };
// A section on the lane: `outBeat` is where it starts there.
export type Placed<T extends Span> = { section: T; outBeat: number; lengthBeat: number };
// A stretch of a source file (`src`) that goes into the result at frame `at`: `start` and
// `frames` are frames of that file.
export type Layer = { src: number; start: number; frames: number; at: number };

export const srcOf = (s: { src?: number }): number => s.src ?? 0;

const EPS = 1e-6;

// Where the track's first beat line falls, in beats from the start of the file. 0 for a track
// without a grid.
export function leadBeat(t: PlannerTrack): number {
	const bar = firstBarBeat(t);
	if (bar === null) return 0;
	const lead = bar - Math.floor(bar);
	return lead < EPS || lead > 1 - EPS ? 0 : lead;
}

// Where the first bar line at or after the start of the file falls, in beats.
export function barPhase(t: PlannerTrack): number {
	const bar = firstBarBeat(t);
	if (bar === null) return 0;
	const phase = bar - Math.floor(bar / 4) * 4;
	return phase > 4 - EPS ? 0 : phase;
}

const mod4 = (v: number): number => {
	const m = ((v % 4) + 4) % 4;
	return m > 4 - EPS ? 0 : m;
};

// The whole track as one section, lead-in and all, at `atBeat` on the lane.
export function wholeTrack(t: PlannerTrack, id: string, atBeat = 0, src = 0): EditSection[] {
	const length = trackBeats(t);
	if (length <= EPS) return [];
	const s: EditSection = { id, startBeat: 0, lengthBeat: length, atBeat };
	if (src > 0) s.src = src;
	return [s];
}

// Where a track added after everything on the lane goes: the first place at or after the end
// where its bar lines fall on the result's (`first` is the editor's first track).
export function appendAt(first: PlannerTrack, sections: Span[], t: PlannerTrack): number {
	const end = totalBeats(sections);
	if (end <= EPS) return mod4(barPhase(first) - barPhase(t));
	const base = barPhase(first) - barPhase(t);
	return base + Math.ceil((end - base) / 4 - EPS) * 4;
}

// The sections that make the same arrangement as clips on the timeline: each clip is a section,
// where it plays relative to the others. `tracks[src(c)]` is the track a clip is of. Clips' ends
// are moved to their track's beat lines (a clip that starts in a track's lead-in keeps it), and
// the first one goes as early on the lane as keeps its bar lines on the result's.
export function clipSections<C extends { startBeat: number; offsetBeat: number; lengthBeat: number }>(t: PlannerTrack | PlannerTrack[], clips: C[], newId: () => string, src: (c: C) => number = () => 0): { sections: EditSection[]; links: { clip: C; sectionId: string }[] } {
	const tracks = Array.isArray(t) ? t : [t];
	const links: { clip: C; sectionId: string }[] = [];
	const out: EditSection[] = [];
	let anchor: { at: number; time: number } | null = null; // where the first section's beat line went, and where it plays on the timeline
	for (const c of [...clips].sort((a, b) => a.startBeat - b.startBeat)) {
		const i = src(c);
		const track = tracks[i];
		if (!track) continue;
		const lead = leadBeat(track);
		const total = trackBeats(track);
		const grid = (beat: number): number => lead + Math.round(beat - lead);
		const stop = c.offsetBeat + c.lengthBeat;
		const from = c.offsetBeat <= lead + EPS ? 0 : grid(c.offsetBeat);
		const to = stop >= total - EPS ? total : Math.min(total, grid(stop));
		if (to - from <= EPS) continue;
		// Places are worked out from a beat line of the track: the section's start, or its first
		// beat line when the section starts with the lead-in.
		const ref = from <= EPS ? lead : from;
		const time = c.startBeat + (ref - c.offsetBeat); // where that beat line plays on the timeline
		if (!anchor) {
			let a = mod4(barPhase(tracks[0]) + ref - barPhase(track));
			if (a - (ref - from) < -EPS) a += 4;
			anchor = { at: a, time };
		}
		const id = newId();
		const section: EditSection = { id, startBeat: from, lengthBeat: to - from, atBeat: Math.max(0, anchor.at + Math.round(time - anchor.time) - (ref - from)) };
		if (i > 0) section.src = i;
		out.push(section);
		links.push({ clip: c, sectionId: id });
	}
	return { sections: out, links };
}

export function sectionsFromClips(t: PlannerTrack, clips: { startBeat: number; offsetBeat: number; lengthBeat: number }[], newId: () => string): EditSection[] {
	return clipSections(t, clips, newId).sections;
}

// The sections in the order they start on the lane.
export function place<T extends Span>(sections: T[]): Placed<T>[] {
	return sections
		.filter((s) => s.lengthBeat > EPS)
		.map((section) => ({ section, outBeat: section.atBeat, lengthBeat: section.lengthBeat }))
		.sort((a, b) => a.outBeat - b.outBeat);
}

// Length of the result in beats: to the end of the section that ends last.
export function totalBeats(sections: Span[]): number {
	return sections.reduce((n, s) => Math.max(n, s.atBeat + s.lengthBeat), 0);
}

// The nearest grid line to `beat` in the result: beat lines (`step` 1) or bar lines (4).
export function snapBeat(beat: number, lead: number, phase: number, step: number, total: number): number {
	const origin = step >= 4 ? phase : lead;
	const snapped = origin + Math.round((beat - origin) / step) * step;
	return Math.min(total, Math.max(0, snapped));
}

// For each section, which row it is drawn on so overlapping sections never share one, and how
// many rows the whole lane has. Every row is the same height, all along the lane.
export function overlapRows<T extends Span & { id: string }>(sections: T[]): Map<string, { row: number; rows: number }> {
	const sorted = [...sections].sort((a, b) => a.atBeat - b.atBeat);
	const ends: number[] = []; // per row: where its last section ends
	const rowOf = new Map<string, number>();
	for (const s of sorted) {
		let row = ends.findIndex((e) => e <= s.atBeat + EPS);
		if (row < 0) row = ends.push(0) - 1;
		ends[row] = s.atBeat + s.lengthBeat;
		rowOf.set(s.id, row);
	}
	const rows = Math.max(1, ends.length);
	return new Map([...rowOf].map(([id, row]) => [id, { row, rows }]));
}

// Cuts sections in two at `outBeat` (a place on the lane): the ones in `ids` that are under
// it, or every section under it when none of those is. Unchanged when nothing is under it.
export function cutAt(sections: EditSection[], outBeat: number, newId: () => string, ids: string[] = []): EditSection[] {
	const under = sections.filter((s) => outBeat > s.atBeat + EPS && outBeat < s.atBeat + s.lengthBeat - EPS);
	const chosen = under.some((s) => ids.includes(s.id)) ? under.filter((s) => ids.includes(s.id)) : under;
	if (chosen.length === 0) return sections;
	return sections.flatMap((s) => {
		if (!chosen.includes(s)) return [s];
		const first = outBeat - s.atBeat;
		const b: EditSection = { ...s, id: newId(), startBeat: s.startBeat + first, lengthBeat: s.lengthBeat - first, atBeat: outBeat };
		return [{ ...s, lengthBeat: first }, b];
	});
}

// Takes the chosen sections off the lane. The rest stay where they are.
export function removeSections(sections: EditSection[], ids: string[]): EditSection[] {
	const gone = new Set(ids);
	if (!sections.some((s) => gone.has(s.id))) return sections;
	return sections.filter((s) => !gone.has(s.id));
}

// Copies of the chosen sections, laid out as they are, right after the last of them ends.
export function duplicateSections(sections: EditSection[], ids: string[], newId: () => string): { sections: EditSection[]; copies: string[] } {
	const chosen = new Set(ids);
	const picked = sections.filter((s) => chosen.has(s.id));
	if (picked.length === 0) return { sections, copies: [] };
	const from = Math.min(...picked.map((s) => s.atBeat));
	const by = totalBeats(picked) - from;
	const copies = picked.map((s) => ({ ...s, id: newId(), atBeat: s.atBeat + by }));
	return { sections: [...sections, ...copies], copies: copies.map((c) => c.id) };
}

// Moves the chosen sections along the lane by `by` beats (later when > 0), as far as the start
// of the lane allows.
export function moveSections(sections: EditSection[], ids: string[], by: number): EditSection[] {
	const chosen = new Set(ids);
	const picked = sections.filter((s) => chosen.has(s.id));
	if (picked.length === 0) return sections;
	const delta = Math.max(by, -Math.min(...picked.map((s) => s.atBeat)));
	if (Math.abs(delta) < EPS) return sections;
	return sections.map((s) => (chosen.has(s.id) ? { ...s, atBeat: s.atBeat + delta } : s));
}

// The stretches of source files that make up the result, each at its place in it. Every edge
// lands on the frame nearest its beat, so rounding never adds up along the file. Sections that
// follow each other in their track as well as on the lane become one layer: a cut that was
// never moved leaves the audio exactly as it was. `sourceFrames[src]` is each file's length.
export function editLayers(sections: Span[], bpm: number, sampleRate: number, sourceFrames: number[]): Layer[] {
	const frameAt = (beat: number): number => Math.round(((beat * 60) / bpm) * sampleRate);
	// The track's length in beats comes from a decode at another sample rate, so its end can
	// miss the file's last frame by a hair. A section that ends there takes the file to its end.
	const slack = Math.ceil(sampleRate * 0.005);
	const runs: { src: number; startBeat: number; lengthBeat: number; atBeat: number }[] = [];
	for (const p of place(sections)) {
		const src = srcOf(p.section);
		const prev = runs.find((r) => r.src === src && Math.abs(r.startBeat + r.lengthBeat - p.section.startBeat) < EPS && Math.abs(r.atBeat + r.lengthBeat - p.outBeat) < EPS);
		if (prev) prev.lengthBeat += p.lengthBeat;
		else runs.push({ src, startBeat: p.section.startBeat, lengthBeat: p.lengthBeat, atBeat: p.outBeat });
	}
	const out: Layer[] = [];
	for (const r of runs) {
		const have = sourceFrames[r.src] ?? 0;
		const at = frameAt(r.atBeat);
		const start = Math.min(have, frameAt(r.startBeat));
		let frames = Math.min(frameAt(r.atBeat + r.lengthBeat) - at, have - start);
		if (have - (start + frames) <= slack) frames = have - start;
		if (frames > 0) out.push({ src: r.src, start, frames, at });
	}
	return out;
}
