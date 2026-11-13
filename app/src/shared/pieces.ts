// How a clip is cut up for playback when the set's tempo changes under it. Each piece plays
// one rendering of the track: where the tempo holds, the track stretched to that tempo;
// where it is moving, a rendering made for exactly that stretch of the ramp.

import { trackBeats, type Clip, type PlannerTrack } from "./planner";
import type { TempoMap } from "./tempo";

export type Piece = {
	fromBeat: number; // on the timeline
	toBeat: number;
	trackBeat: number; // where in the track the piece starts, in the track's own beats
	bpmA: number; // tempo at its start
	bpmB: number; // tempo at its end; the same as bpmA where the tempo holds
};

export function isRamp(p: Piece): boolean {
	return p.bpmA !== p.bpmB;
}

export function clipPieces(clip: Clip, track: PlannerTrack, map: TempoMap): Piece[] {
	const start = clip.startBeat;
	const end = start + Math.min(clip.lengthBeat, trackBeats(track) - clip.offsetBeat);
	const out: Piece[] = [];
	for (const s of map.segs) {
		const a = Math.max(start, s.b0);
		const b = Math.min(end, s.b1);
		if (b - a < 1e-9) continue;
		const at = (beat: number): number => (s.b1 === Infinity ? s.v0 : s.v0 + ((s.v1 - s.v0) * (beat - s.b0)) / (s.b1 - s.b0));
		const bpmA = at(a);
		let bpmB = at(b);
		if (Math.abs(bpmA - bpmB) < 1e-9) bpmB = bpmA;
		const last = out[out.length - 1];
		// Two stretches at one steady tempo, side by side, are one piece.
		if (last && !isRamp(last) && bpmA === bpmB && Math.abs(last.bpmA - bpmA) < 1e-9 && Math.abs(last.toBeat - a) < 1e-9) last.toBeat = b;
		else out.push({ fromBeat: a, toBeat: b, trackBeat: clip.offsetBeat + (a - start), bpmA, bpmB });
	}
	return out;
}
