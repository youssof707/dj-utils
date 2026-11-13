// The track editor's model: one track, or two, cut into sections that play one after the
// other. Positions are in the beats of the track a section comes from. Each section may have
// silence before it, a whole number of beats; where a section lands in the result is the sum
// of the lengths and the silences before it, so sections can never overlap and the grid
// always lines up. With two tracks the result plays at the first one's tempo.

import { firstBarBeat, trackBeats, type PlannerTrack } from "./planner";

// A stretch of the source track: where it starts in the track and how long it is, and how
// many beats of silence come before it in the result. `src` says which of the editor's tracks
// it is a stretch of: the first when left out, 1 for the second.
export type Span = { startBeat: number; lengthBeat: number; gapBeat?: number; src?: number };
export type EditSection = Span & { id: string };
// A section in the result: `outBeat` is where it starts there, counted from the file start.
export type Placed<T extends Span> = { section: T; outBeat: number; lengthBeat: number };
// Frames of a source file (the first when `src` is left out), for the export, or `frames` of
// silence.
export type Slice = { start: number; frames: number; silent?: boolean; src?: number };

export const srcOf = (s: { src?: number }): number => s.src ?? 0;

const EPS = 1e-6;

// Where the track's first beat line falls, in beats from the start of the file. The audio
// before it (the lead-in) always stays at the start of an edit, so the first beat of the
// edit is at the same time as the first beat of the track. 0 for a track without a grid.
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

// With two tracks side by side: how many beats later than the first the second one is drawn
// (and heard, on its own lane), so that its bar lines fall on the first one's. Under a bar.
export function secondOffset(first: PlannerTrack, second: PlannerTrack): number {
	const d = (((barPhase(first) - barPhase(second)) % 4) + 4) % 4;
	return d > 4 - EPS ? 0 : d;
}

// The whole track after its lead-in, as one section.
export function initialSections(t: PlannerTrack, id: string): EditSection[] {
	const lead = leadBeat(t);
	const length = trackBeats(t) - lead;
	return length > EPS ? [{ id, startBeat: lead, lengthBeat: length }] : [];
}

// The sections that make the same arrangement as clips of this track on the timeline: each
// clip is a section, in the order they play, with the empty space between them as silence.
// Clips' ends are moved to the track's beat lines; a clip that starts before the one before
// it has ended follows straight on, since sections cannot overlap.
export function sectionsFromClips(t: PlannerTrack, clips: { startBeat: number; offsetBeat: number; lengthBeat: number }[], newId: () => string): EditSection[] {
	const lead = leadBeat(t);
	const total = trackBeats(t);
	const grid = (beat: number): number => lead + Math.round(beat - lead);
	const out: EditSection[] = [];
	let end = 0; // on the timeline: where the clips so far stop
	for (const c of [...clips].sort((a, b) => a.startBeat - b.startBeat)) {
		const stop = c.offsetBeat + c.lengthBeat;
		const from = Math.max(lead, grid(c.offsetBeat));
		const to = stop >= total - EPS ? total : Math.min(total, grid(stop));
		if (to - from <= EPS) continue;
		const gap = out.length === 0 ? 0 : Math.max(0, Math.round(c.startBeat - end));
		end = Math.max(out.length === 0 ? -Infinity : end, c.startBeat + c.lengthBeat);
		out.push(gap > 0 ? { id: newId(), startBeat: from, lengthBeat: to - from, gapBeat: gap } : { id: newId(), startBeat: from, lengthBeat: to - from });
	}
	return out;
}

// Cuts are on beat lines, so every section is a whole number of beats long except the one
// that runs to the end of the file. That one keeps its odd end only when it is last; placed
// before another section it gives up the part beat, so what follows stays on the grid.
function wholeBeats(length: number): number {
	const r = Math.round(length);
	return Math.abs(length - r) < EPS ? r : Math.floor(length);
}

// The silence before a section, in whole beats.
export function gapOf(s: Span): number {
	return s.gapBeat ? Math.max(0, Math.round(s.gapBeat)) : 0;
}

function withGap<T extends Span>(s: T, gap: number): T {
	if (gapOf(s) === gap) return s;
	const next = { ...s };
	if (gap > 0) next.gapBeat = gap;
	else delete next.gapBeat;
	return next;
}

export function place<T extends Span>(lead: number, sections: T[]): Placed<T>[] {
	const out: Placed<T>[] = [];
	let at = lead;
	sections.forEach((section, i) => {
		at += gapOf(section);
		const lengthBeat = i === sections.length - 1 ? section.lengthBeat : wholeBeats(section.lengthBeat);
		if (lengthBeat <= EPS) return;
		out.push({ section, outBeat: at, lengthBeat });
		at += lengthBeat;
	});
	return out;
}

// Length of the result in beats, lead-in included.
export function totalBeats(lead: number, sections: Span[]): number {
	const placed = place(lead, sections);
	const last = placed[placed.length - 1];
	return last ? last.outBeat + last.lengthBeat : lead;
}

// The nearest grid line to `beat` in the result: beat lines (`step` 1) or bar lines (4).
export function snapBeat(beat: number, lead: number, phase: number, step: number, total: number): number {
	const origin = step >= 4 ? phase : lead;
	const snapped = origin + Math.round((beat - origin) / step) * step;
	return Math.min(total, Math.max(lead, snapped));
}

// Cuts the section under `outBeat` (a place in the result) in two. Unchanged when the place
// is on an existing cut or outside every section.
export function cutAt(lead: number, sections: EditSection[], outBeat: number, newId: () => string): EditSection[] {
	for (const p of place(lead, sections)) {
		if (outBeat <= p.outBeat + EPS || outBeat >= p.outBeat + p.lengthBeat - EPS) continue;
		const first = outBeat - p.outBeat;
		const i = sections.indexOf(p.section);
		const a: EditSection = { ...p.section, lengthBeat: first };
		const b: EditSection = { id: newId(), startBeat: p.section.startBeat + first, lengthBeat: p.section.lengthBeat - first };
		delete (b as Span).gapBeat;
		return [...sections.slice(0, i), a, b, ...sections.slice(i + 1)];
	}
	return sections;
}

// Takes the chosen sections out, and gives the silence before each to the section that
// followed it, so silence elsewhere stays where it was. With `keepRuns`, silence inside a run
// of chosen sections stays with the run instead.
function takeOut(sections: EditSection[], chosen: Set<string>, keepRuns: boolean): { rest: EditSection[]; picked: EditSection[] } {
	const rest: EditSection[] = [];
	const picked: EditSection[] = [];
	let carry = 0;
	sections.forEach((s, i) => {
		if (chosen.has(s.id)) {
			const inRun = keepRuns && i > 0 && chosen.has(sections[i - 1].id);
			if (!inRun) carry += gapOf(s);
			picked.push(inRun ? s : withGap(s, 0));
			return;
		}
		rest.push(carry > 0 ? withGap(s, gapOf(s) + carry) : s);
		carry = 0;
	});
	return { rest, picked };
}

// Removes the chosen sections; what follows closes up, but silence stays where it was.
export function removeSections(sections: EditSection[], ids: string[]): EditSection[] {
	const gone = new Set(ids);
	if (!sections.some((s) => gone.has(s.id))) return sections;
	return takeOut(sections, gone, false).rest;
}

// Copies of the chosen sections, in order, right after the last of them.
export function duplicateSections(sections: EditSection[], ids: string[], newId: () => string): { sections: EditSection[]; copies: string[] } {
	const chosen = new Set(ids);
	const picked = sections.filter((s) => chosen.has(s.id));
	if (picked.length === 0) return { sections, copies: [] };
	const after = sections.indexOf(picked[picked.length - 1]) + 1;
	const copies = picked.map((s, i) => withGap({ ...s, id: newId() }, i === 0 ? 0 : gapOf(s)));
	return { sections: [...sections.slice(0, after), ...copies, ...sections.slice(after)], copies: copies.map((c) => c.id) };
}

// Moves the chosen sections, in order, to sit before the section now at `toIndex` (the
// number of sections means the very end). Silence stays where it was: the moved sections
// land where the section they go before started, and that one follows straight on.
export function moveSections(sections: EditSection[], ids: string[], toIndex: number): EditSection[] {
	const chosen = new Set(ids);
	if (!sections.some((s) => chosen.has(s.id))) return sections;
	const index = Math.min(sections.length, Math.max(0, toIndex));
	const order = [...sections.slice(0, index).filter((s) => !chosen.has(s.id)), ...sections.filter((s) => chosen.has(s.id)), ...sections.slice(index).filter((s) => !chosen.has(s.id))];
	if (order.every((s, i) => s === sections[i])) return sections;
	const target = sections.slice(index).find((s) => !chosen.has(s.id));
	const { rest, picked } = takeOut(sections, chosen, true);
	const at = target ? rest.findIndex((s) => s.id === target.id) : rest.length;
	if (target) {
		picked[0] = withGap(picked[0], gapOf(rest[at]));
		rest[at] = withGap(rest[at], 0);
	}
	return [...rest.slice(0, at), ...picked, ...rest.slice(at)];
}

// Moves the chosen sections later (`by` > 0) or earlier in time by whole beats, leaving
// silence behind. Moving later uses up the silence ahead first, then pushes what follows
// along; moving earlier stops where the silence before runs out, so nothing ever overlaps.
// What follows a section moved earlier stays where it is.
export function slideSections(sections: EditSection[], ids: string[], by: number): EditSection[] {
	const chosen = new Set(ids);
	let delta = Math.round(by);
	const firsts = sections.filter((s, i) => chosen.has(s.id) && (i === 0 || !chosen.has(sections[i - 1].id)));
	if (firsts.length === 0 || delta === 0) return sections;
	delta = Math.max(delta, -Math.min(...firsts.map(gapOf)));
	if (delta === 0) return sections;
	let after = false; // the section before was a chosen one
	const next = sections.map((s) => {
		const isChosen = chosen.has(s.id);
		const wasAfter = after;
		after = isChosen;
		if (isChosen && !wasAfter) return withGap(s, gapOf(s) + delta);
		if (!isChosen && wasAfter) return withGap(s, Math.max(0, gapOf(s) - delta));
		return s;
	});
	return next.every((s, i) => s === sections[i]) ? sections : next;
}

// Puts new sections into the result where they are dropped. `pointerBeat` is the place in the
// result the drop points at and `startBeat` where the first new section would start. Dropped
// on a section, they go to the nearer end of it and what follows moves along. Dropped on
// empty space (silence, or past the end) they start at `startBeat`, as close as the section
// before allows, and the section after stays where it is unless they need its room.
export function insertSections(lead: number, sections: EditSection[], added: EditSection[], pointerBeat: number, startBeat: number): EditSection[] {
	if (added.length === 0) return sections;
	const fresh = added.map((s, i) => (i === 0 ? withGap(s, 0) : s));
	const placed = place(lead, sections);
	const over = placed.find((p) => pointerBeat >= p.outBeat && pointerBeat < p.outBeat + p.lengthBeat);
	if (over) {
		const i = sections.indexOf(over.section);
		if (pointerBeat - over.outBeat >= over.lengthBeat / 2) return [...sections.slice(0, i + 1), ...fresh, ...sections.slice(i + 1)];
		// Before it: they land where it started, and it follows straight on.
		fresh[0] = withGap(fresh[0], gapOf(over.section));
		return [...sections.slice(0, i), ...fresh, withGap(over.section, 0), ...sections.slice(i + 1)];
	}
	const next = placed.find((p) => p.outBeat > pointerBeat);
	const before = next ? placed[placed.indexOf(next) - 1] : placed[placed.length - 1];
	const from = before ? before.outBeat + wholeBeats(before.lengthBeat) : lead;
	const gap = Math.max(0, Math.round(startBeat - from));
	fresh[0] = withGap(fresh[0], gap);
	if (!next) return [...sections, ...fresh];
	const end = from + gap + fresh.reduce((n, s, i) => n + (i === 0 ? 0 : gapOf(s)) + wholeBeats(s.lengthBeat), 0);
	const i = sections.indexOf(next.section);
	return [...sections.slice(0, i), ...fresh, withGap(next.section, Math.max(0, Math.round(next.outBeat - end))), ...sections.slice(i + 1)];
}

// A track laid out whole, as the editor shows it to take pieces from: the stretches between
// the cut marks, from its first beat to its end. `cuts` are in the track's own beats.
export function piecesOf(t: PlannerTrack, cuts: number[]): { startBeat: number; lengthBeat: number }[] {
	const lead = leadBeat(t);
	const total = trackBeats(t);
	const marks = [...new Set(cuts.filter((c) => c > lead + EPS && c < total - EPS))].sort((a, b) => a - b);
	const edges = [lead, ...marks, total];
	const out: { startBeat: number; lengthBeat: number }[] = [];
	for (let i = 0; i + 1 < edges.length; i++) if (edges[i + 1] - edges[i] > EPS) out.push({ startBeat: edges[i], lengthBeat: edges[i + 1] - edges[i] });
	return out;
}

// The cut marks with one more at `beat`, moved to the track's nearest beat line. Unchanged
// when there is one there already, or the place is not inside the track.
export function addCut(t: PlannerTrack, cuts: number[], beat: number): number[] {
	const lead = leadBeat(t);
	const at = lead + Math.round(beat - lead);
	if (at <= lead + EPS || at >= trackBeats(t) - EPS || cuts.some((c) => Math.abs(c - at) < EPS)) return cuts;
	return [...cuts, at].sort((a, b) => a - b);
}

// The frames of the source file that make up the result, in order: the lead-in, then each
// section. Every cut lands on the frame nearest its beat in the result, so rounding never
// adds up along the file. Sections that follow each other in the source as well are joined
// into one slice: a cut that was never moved leaves the audio exactly as it was.
export function editSlices(lead: number, sections: Span[], bpm: number, sampleRate: number, sourceFrames: number | number[]): Slice[] {
	const frameAt = (beat: number): number => Math.round(((beat * 60) / bpm) * sampleRate);
	const framesOf = (src: number): number => (Array.isArray(sourceFrames) ? (sourceFrames[src] ?? 0) : src === 0 ? sourceFrames : 0);
	const out: Slice[] = [];
	const placed = place(lead, sections);
	// The lead-in is the first track's. An edit that opens with the other track has silence there.
	const ownLead = placed.length === 0 || srcOf(placed[0].section) === 0;
	let outFrame = ownLead ? Math.min(frameAt(lead), framesOf(0)) : frameAt(lead);
	if (outFrame > 0) out.push(ownLead ? { start: 0, frames: outFrame } : { start: 0, frames: outFrame, silent: true });
	let sourceEnd = ownLead ? lead : NaN; // where in its track the audio so far ends
	let endSrc = 0;
	// The track's length in beats comes from a decode at another sample rate, so its end can
	// miss the file's last frame by a hair. A result that ends there takes the file to its end.
	const slack = Math.ceil(sampleRate * 0.005);
	for (const p of placed) {
		const src = srcOf(p.section);
		const have = framesOf(src);
		// Silence before the section.
		const silence = frameAt(p.outBeat) - outFrame;
		if (silence > 0 && gapOf(p.section) > 0) {
			out.push({ start: 0, frames: silence, silent: true });
			outFrame += silence;
			sourceEnd = NaN;
		}
		const last = out[out.length - 1];
		const follows = src === endSrc && Math.abs(p.section.startBeat - sourceEnd) < EPS;
		const start = Math.min(have, last && follows ? last.start + last.frames : follows && !last ? outFrame : frameAt(p.section.startBeat));
		let frames = Math.min(frameAt(p.outBeat + p.lengthBeat) - outFrame, have - start);
		if (p === placed[placed.length - 1] && have - (start + frames) <= slack) frames = have - start;
		if (frames <= 0) continue;
		if (last && follows) last.frames += frames;
		else out.push(src ? { start, frames, src } : { start, frames });
		outFrame += frames;
		sourceEnd = p.section.startBeat + p.lengthBeat;
		endSrc = src;
	}
	return out;
}
