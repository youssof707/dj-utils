// Which renderings a set plays: every track stretched to the project tempo, and under tempo
// changes the track stretched to each tempo the set settles on, plus one rendering for each
// stretch of a clip that plays while the tempo is moving. The window uses this to ask for
// them, and the main process to know which cached files are still needed.

import { rampKey, rampRequest, stretchKey, type PlannerDoc, type PlannerTrack, type RampRequest, type StretchRequest, type TempoPoint } from "./planner";
import { clipPieces, isRamp, type Piece } from "./pieces";
import { blocksToPoints, pointsToBlocks, TempoMap } from "./tempo";

// `beat` is where on the timeline the rendering is first heard.
export type Rendering = { key: string; beat: number; base: boolean } & ({ ramp: false; req: StretchRequest } | { ramp: true; req: RampRequest });

export function stretchRequestFor(track: PlannerTrack, bpm: number): StretchRequest {
	return { sourcePath: track.sourcePath, bpm: track.bpm, projectBpm: bpm };
}

export function rampRequestFor(track: PlannerTrack, p: Piece): RampRequest {
	return rampRequest(track, p.trackBeat, p.toBeat - p.fromBeat, p.bpmA, p.bpmB);
}

// The rendering made for one piece of a clip.
export function pieceKey(track: PlannerTrack, p: Piece): string {
	return isRamp(p) ? rampKey(rampRequestFor(track, p)) : stretchKey(stretchRequestFor(track, p.bpmA));
}

export function tempoMapOf(doc: PlannerDoc): TempoMap {
	return new TempoMap(blocksToPoints(doc.tempos, doc.bpm), doc.bpm);
}

export function renderingsFor(doc: PlannerDoc, map: TempoMap = tempoMapOf(doc)): Rendering[] {
	const out = new Map<string, Rendering>();
	for (const t of doc.tracks) {
		const req = stretchRequestFor(t, doc.bpm);
		out.set(stretchKey(req), { key: stretchKey(req), beat: 0, base: true, ramp: false, req });
	}
	if (doc.tempos.length === 0) return [...out.values()];
	const tracks = new Map(doc.tracks.map((t) => [t.id, t]));
	for (const c of doc.clips) {
		const track = tracks.get(c.trackId);
		if (!track) continue;
		for (const p of clipPieces(c, track, map)) {
			const key = pieceKey(track, p);
			const had = out.get(key);
			if (had) {
				if (!had.base) had.beat = Math.min(had.beat, p.fromBeat);
				continue;
			}
			if (isRamp(p)) out.set(key, { key, beat: p.fromBeat, base: false, ramp: true, req: rampRequestFor(track, p) });
			else out.set(key, { key, beat: p.fromBeat, base: false, ramp: false, req: stretchRequestFor(track, p.bpmA) });
		}
	}
	return [...out.values()];
}

// Project and tempo BPMs are whole numbers. Older sets kept the tempo as curve points.
export function normalizeDoc(loaded: PlannerDoc): PlannerDoc {
	const { points, ...rest } = loaded as PlannerDoc & { points?: TempoPoint[] };
	const bpm = Math.round(rest.bpm);
	const tempos = rest.tempos ?? pointsToBlocks((points ?? []).map((p) => ({ ...p, bpm: Math.round(p.bpm) })), bpm, 0.05).map((b, i) => ({ ...b, id: `b${Date.now().toString(36)}${i}` }));
	return { ...rest, bpm, tempos: tempos.map((t) => ({ ...t, bpm: Math.round(t.bpm) })) };
}
