// Which of a set's tracks can not simply be played from a CDJ: loaded once, started, and left
// to run, they would not be where the set has them. Those need an edit made first.

import type { Clip, Cue, PlannerDoc, PlannerTrack } from "./planner";
import { clipSections, type EditSection, type Placed } from "./trackEdit";

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
// editor's track i, and `src` which of them a clip is of. Muted clips are left out.
export function clipsEdit(tracks: PlannerTrack | PlannerTrack[], clips: Clip[], newId: () => string, src?: (c: Clip) => number): { sections: EditSection[]; links: AutoLink[] } {
	const { sections, links } = clipSections(tracks, clips.filter((c) => !c.muted), newId, src);
	return { sections, links: links.map((l) => ({ clipId: l.clip.id, sectionId: l.sectionId })) };
}

// The set once the edit is exported as `edit`: each linked clip plays the same audio from the
// new file, where its section went in the edit (`placed`, as exported). Clips whose section is
// no longer in the edit stay where they were, and a track they came from goes once no clip
// uses it.
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
	return { doc: { ...doc, tracks, clips: joinSwapped(clips, moved.map((m) => m.to)) }, moved };
}

// The swapped-in clips now play the edit straight through, so those that follow on in it
// become one clip, on the lane of the first: from the first one's start to the last one's end,
// the gaps between them being silence in the file. Clips stay apart where the edit no longer
// lines up with the set (its spacing was changed in the editor), where one cuts the bass and
// the next does not, or where a fade sits at the join.
function joinSwapped(clips: Clip[], swapped: Clip[]): Clip[] {
	const EPS = 1e-6;
	const ids = new Set(swapped.map((c) => c.id));
	const runs: Clip[] = [];
	for (const c of [...swapped].sort((a, b) => a.startBeat - b.startBeat)) {
		const last = runs[runs.length - 1];
		const lines = last && Math.abs(c.startBeat - c.offsetBeat - (last.startBeat - last.offsetBeat)) < EPS;
		if (lines && !!c.lowCut === !!last.lowCut && !last.fadeOutBeat && !c.fadeInBeat) {
			const end = Math.max(last.startBeat + last.lengthBeat, c.startBeat + c.lengthBeat);
			const next: Clip = { ...last, lengthBeat: end - last.startBeat };
			if (c.fadeOutBeat) next.fadeOutBeat = c.fadeOutBeat;
			runs[runs.length - 1] = next;
		} else runs.push(c);
	}
	const byFirst = new Map(runs.map((r) => [r.id, r]));
	return clips.flatMap((c) => (!ids.has(c.id) ? [c] : byFirst.has(c.id) ? [byFirst.get(c.id)!] : []));
}

// The old track's cues, at the same places in the edit: each cue inside the part of the track
// a moved clip plays lands where that clip now plays it. A hot cue letter is used once, the
// first time it comes up in the set (`letters`, shared when there are several old tracks);
// loops become plain cues.
export function cuesForEdit(cues: Cue[], oldTrack: PlannerTrack, edit: PlannerTrack, moved: { from: Clip; to: Clip }[], letters = new Set<number>()): { sec: number; kind: number }[] {
	const out: { sec: number; kind: number }[] = [];
	for (const { from, to } of [...moved].sort((a, b) => a.from.startBeat - b.from.startBeat)) {
		for (const c of [...cues].sort((a, b) => a.sec - b.sec)) {
			const beat = (c.sec * oldTrack.bpm) / 60;
			if (beat < from.offsetBeat - 1e-6 || beat >= from.offsetBeat + from.lengthBeat) continue;
			if (c.kind > 0 && letters.has(c.kind)) continue;
			const sec = ((to.offsetBeat + beat - from.offsetBeat) * 60) / edit.bpm;
			if (out.some((o) => o.kind === c.kind && Math.abs(o.sec - sec) < 0.003)) continue;
			if (c.kind > 0) letters.add(c.kind);
			out.push({ sec, kind: c.kind });
		}
	}
	return out;
}
