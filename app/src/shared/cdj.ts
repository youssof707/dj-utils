// Which of a set's tracks can not simply be played from a CDJ: loaded once, started, and left
// to run, they would not be where the set has them. Those need an edit made first.

import { MEMORY_CUES, type Clip, type Cue, type PlannerDoc, type PlannerTrack } from "./planner";
import { clipSections, srcOf, type EditSection, type Placed } from "./trackEdit";

// How far, in the track's own time, a clip may start from where the track would be by then.
export const CDJ_SLACK_SEC = 1;

// A track is fine when each of its clips starts where the track would be had it kept playing
// from the clip before: the gap between two clips on the timeline is a gap in the track too.
// Clips are in project beats, and the track is stretched to the set's tempo, so a beat of the
// set is a beat of the track whatever the tempo does. Muted clips are not heard, so they do
// not count. The ids of the tracks that need an edit.
export function tracksToEdit(doc: PlannerDoc): Set<string> {
	const out = new Set<string>();
	for (const t of doc.tracks) {
		const clips = doc.clips.filter((c) => c.trackId === t.id && !c.muted).sort((a, b) => a.startBeat - b.startBeat || a.lane - b.lane);
		const slack = (CDJ_SLACK_SEC * t.bpm) / 60;
		for (let i = 1; i < clips.length; i++) {
			const a = clips[i - 1];
			const b = clips[i];
			if (Math.abs(b.offsetBeat - (a.offsetBeat + b.startBeat - a.startBeat)) > slack) {
				out.add(t.id);
				break;
			}
		}
	}
	return out;
}

// ---- automatic edits ------------------------------------------------------------------
// "Edit automatically": the track's clips become an edit that plays them in the set's order,
// with the set's gaps as silence, so the file can be played straight through from a CDJ.
// `links` say which section of the edit each clip became.
export type AutoLink = { clipId: string; sectionId: string };

export function autoEdit(doc: PlannerDoc, track: PlannerTrack, newId: () => string): { sections: EditSection[]; links: AutoLink[] } {
	return clipsEdit(track, doc.clips.filter((c) => c.trackId === track.id), newId);
}

// The same for any clips of one or two tracks (Cmd+E on a selection): `tracks[i]` is the
// editor's track i, and `src` which of them a clip is of. The file is only ever the tracks'
// own audio: muted clips are in it like the rest, and no clip's bass cut or volume fades are.
export function clipsEdit(tracks: PlannerTrack | PlannerTrack[], clips: Clip[], newId: () => string, src?: (c: Clip) => number): { sections: EditSection[]; links: AutoLink[] } {
	const { sections, links } = clipSections(tracks, clips, newId, src);
	return { sections, links: links.map((l) => ({ clipId: l.clip.id, sectionId: l.sectionId })) };
}

// The set once the edit is exported as `edit`: each linked clip plays the same audio from the
// new file, where its section went in the edit (`placed`, as exported), and they are then
// joined into one clip (joinSwapped). Clips whose section is no longer in the edit stay where
// they were, and a track they came from goes once no clip uses it.
export function swapInEdit(doc: PlannerDoc, edit: PlannerTrack, links: AutoLink[], placed: Placed<EditSection>[]): { doc: PlannerDoc; moved: { from: Clip; to: Clip }[] } {
	const at = new Map(placed.map((p) => [p.section.id, p]));
	const sectionOf = new Map(links.map((l) => [l.clipId, l.sectionId]));
	const moved: { from: Clip; to: Clip }[] = [];
	const clips = doc.clips.map((c) => {
		const p = at.get(sectionOf.get(c.id) ?? "");
		if (!p) return c;
		const to = { ...c, trackId: edit.id, offsetBeat: Math.max(0, p.outBeat + (c.offsetBeat - p.section.startBeat)) };
		moved.push({ from: c, to });
		return to;
	});
	if (moved.length === 0) return { doc, moved };
	const from = new Set(moved.map((m) => m.from.trackId));
	const tracks = [...doc.tracks.filter((t) => !from.has(t.id) || clips.some((c) => c.trackId === t.id)), edit];
	return { doc: { ...doc, tracks, clips: joinSwapped(clips, moved.map((m) => m.to), Math.max(...placed.map((p) => p.outBeat + p.lengthBeat))) }, moved };
}

// The swapped-in clips become one clip that plays the edit straight through, uncut: it sits
// where the clip heard first in the edit sits, on its lane, and runs to the edit's end (`end`,
// in the edit's beats). It keeps that clip's fade in and bass cut, and the last one's fade out,
// on the timeline (the file has none of them); it is muted only if every clip was.
function joinSwapped(clips: Clip[], swapped: Clip[], end: number): Clip[] {
	const ids = new Set(swapped.map((c) => c.id));
	const byEdit = [...swapped].sort((a, b) => a.offsetBeat - b.offsetBeat || a.startBeat - b.startBeat);
	const first = byEdit[0];
	const last = byEdit.reduce((l, c) => (c.offsetBeat + c.lengthBeat > l.offsetBeat + l.lengthBeat ? c : l));
	const one: Clip = { ...first, lengthBeat: Math.max(first.lengthBeat, end - first.offsetBeat) };
	delete one.fadeOutBeat;
	if (last.fadeOutBeat) one.fadeOutBeat = last.fadeOutBeat;
	delete one.muted;
	if (swapped.every((c) => c.muted)) one.muted = true;
	return clips.flatMap((c) => (!ids.has(c.id) ? [c] : c.id === first.id ? [one] : []));
}

// The cues of the editor's tracks, at the same places in the exported edit: each cue inside
// the part of a track a section plays lands where that section plays it. When a hot cue
// letter comes up more than once, the first in the edit keeps it; memory cues are kept up to
// Rekordbox's limit, the first ones first. Loops become plain cues. `bpm` is the edit's.
export function cuesForEdit(placed: Placed<EditSection>[], tracks: { bpm: number; cues: Cue[] }[], bpm: number): { sec: number; kind: number }[] {
	const all: { sec: number; kind: number }[] = [];
	for (const p of placed) {
		const t = tracks[srcOf(p.section)];
		if (!t) continue;
		for (const c of t.cues) {
			const beat = (c.sec * t.bpm) / 60;
			if (beat < p.section.startBeat - 1e-6 || beat >= p.section.startBeat + p.lengthBeat) continue;
			all.push({ sec: ((p.outBeat + beat - p.section.startBeat) * 60) / bpm, kind: c.kind });
		}
	}
	const out: { sec: number; kind: number }[] = [];
	let memory = 0;
	for (const c of all.sort((a, b) => a.sec - b.sec || a.kind - b.kind)) {
		if (c.kind > 0 ? out.some((o) => o.kind === c.kind) : memory >= MEMORY_CUES || out.some((o) => o.kind === 0 && Math.abs(o.sec - c.sec) < 0.003)) continue;
		if (c.kind === 0) memory++;
		out.push(c);
	}
	return out;
}
