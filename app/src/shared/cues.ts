// Rekordbox cue points on a track: which ones are under the pointer, where a new one goes,
// and what they are called.

import { HOT_CUES, trackBeats, type Cue, type PlannerTrack } from "./planner";
import { leadBeat } from "./trackEdit";

// Cue points that share a moment share one line, `beat` beats into the track.
export type CueMark = { beat: number; memory: boolean; letters: string[]; cues: Cue[] };
const SAME_CUE_SEC = 0.003;
const NEAR_PX = 5; // how close to a cue's line a right-click counts as on it

export const cueLetter = (kind: number): string => String.fromCharCode(64 + kind);

export function cueMarks(cues: Cue[] | undefined, track: PlannerTrack | undefined): CueMark[] {
	if (!cues || !track) return [];
	const out: CueMark[] = [];
	let lastSec = -Infinity;
	for (const c of [...cues].sort((a, b) => a.sec - b.sec || a.kind - b.kind)) {
		if (c.sec - lastSec > SAME_CUE_SEC) {
			out.push({ beat: (c.sec * track.bpm) / 60, memory: false, letters: [], cues: [] });
			lastSec = c.sec;
		}
		const m = out[out.length - 1];
		m.cues.push(c);
		if (c.kind === 0) m.memory = true;
		else if (c.kind <= 26) m.letters.push(cueLetter(c.kind));
	}
	return out;
}

// The cues on the line nearest to `beat`, when that line is within a few pixels of it and,
// with `within`, inside that stretch of the track (the part a clip or section shows).
export function cuesAt(marks: CueMark[], beat: number, pxPerBeat: number, within?: { from: number; to: number }): Cue[] {
	let best: CueMark | null = null;
	for (const m of marks) {
		if (within && (m.beat < within.from - 1e-6 || m.beat >= within.to)) continue;
		if (Math.abs(m.beat - beat) * pxPerBeat > NEAR_PX) continue;
		if (!best || Math.abs(m.beat - beat) < Math.abs(best.beat - beat)) best = m;
	}
	return best ? best.cues : [];
}

// The track's beat line nearest to `beat`, in beats into the track.
export function cueSnapBeat(track: PlannerTrack, beat: number): number {
	const lead = leadBeat(track);
	const last = lead + Math.max(0, Math.floor(trackBeats(track) - lead - 1e-6));
	return Math.min(last, Math.max(lead, lead + Math.round(beat - lead)));
}

// "memory cue", "hot cue C", and "loop" in place of "cue" for one that is a loop.
export function cueName(c: Cue): string {
	const what = c.loop ? "loop" : "cue";
	return c.kind === 0 ? `memory ${what}` : `hot ${what} ${cueLetter(c.kind)}`;
}

// The hot cue a key stands for: 1 to 8 for A to H in either case, 0 for any other key.
export function hotCueKind(key: string): number {
	if (key.length !== 1) return 0;
	const kind = key.toUpperCase().charCodeAt(0) - 64;
	return kind >= 1 && kind <= HOT_CUES ? kind : 0;
}

export const sameMoment = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_CUE_SEC;
