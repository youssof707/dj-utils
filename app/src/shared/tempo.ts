// Tempo-curve maths. The curve is a list of points joined by straight lines (BPM against
// timeline beat). Before the first point and after the last one the BPM holds flat. With
// no points the curve is the project BPM throughout.

export type Pt = { beat: number; bpm: number };

export function sortPoints<T extends Pt>(points: T[]): T[] {
	return [...points].sort((a, b) => a.beat - b.beat);
}

export function isFlat(points: Pt[], projectBpm: number): boolean {
	return points.every((p) => Math.abs(p.bpm - projectBpm) < 1e-9);
}

export function bpmAt(points: Pt[], projectBpm: number, beat: number): number {
	const p = sortPoints(points);
	if (p.length === 0) return projectBpm;
	if (beat <= p[0].beat) return p[0].bpm;
	for (let i = 1; i < p.length; i++) {
		if (beat <= p[i].beat) {
			const a = p[i - 1];
			const b = p[i];
			if (b.beat === a.beat) return b.bpm;
			return a.bpm + ((b.bpm - a.bpm) * (beat - a.beat)) / (b.beat - a.beat);
		}
	}
	return p[p.length - 1].bpm;
}

// Seconds taken to play `len` beats while the BPM moves linearly from v0 to v1 over `span` beats.
function segSeconds(v0: number, v1: number, span: number, len: number): number {
	if (len <= 0) return 0;
	const k = span > 0 ? (v1 - v0) / span : 0;
	if (Math.abs(k) < 1e-12) return (60 * len) / v0;
	return (60 / k) * Math.log((v0 + k * len) / v0);
}

// Inverse of segSeconds: beats covered in `sec` seconds.
function segBeats(v0: number, v1: number, span: number, sec: number): number {
	if (sec <= 0) return 0;
	const k = span > 0 ? (v1 - v0) / span : 0;
	if (Math.abs(k) < 1e-12) return (sec * v0) / 60;
	return (v0 / k) * Math.expm1((k * sec) / 60);
}

type Seg = { b0: number; b1: number; v0: number; v1: number; t0: number; t1: number };

// Precomputed curve for fast lookups in both directions.
export class TempoMap {
	readonly segs: Seg[] = [];

	constructor(points: Pt[], projectBpm: number) {
		const p = sortPoints(points);
		const raw: { b0: number; b1: number; v0: number; v1: number }[] = [];
		if (p.length === 0) {
			raw.push({ b0: 0, b1: Infinity, v0: projectBpm, v1: projectBpm });
		} else {
			if (p[0].beat > 0) raw.push({ b0: 0, b1: p[0].beat, v0: p[0].bpm, v1: p[0].bpm });
			for (let i = 1; i < p.length; i++) {
				const a = p[i - 1];
				const b = p[i];
				const b0 = Math.max(0, a.beat);
				if (b.beat <= b0) continue;
				// Segment may start before beat 0 if a point sits at a negative beat; clamp it.
				const v0 = a.beat === b0 ? a.bpm : a.bpm + ((b.bpm - a.bpm) * (b0 - a.beat)) / (b.beat - a.beat);
				raw.push({ b0, b1: b.beat, v0, v1: b.bpm });
			}
			const last = p[p.length - 1];
			raw.push({ b0: Math.max(0, last.beat), b1: Infinity, v0: last.bpm, v1: last.bpm });
		}
		let t = 0;
		for (const s of raw) {
			const dur = s.b1 === Infinity ? Infinity : segSeconds(s.v0, s.v1, s.b1 - s.b0, s.b1 - s.b0);
			this.segs.push({ ...s, t0: t, t1: t + dur });
			t += dur;
		}
	}

	bpmAtBeat(beat: number): number {
		for (const s of this.segs) {
			if (beat < s.b1) {
				if (s.b1 === Infinity) return s.v0;
				return s.v0 + ((s.v1 - s.v0) * (Math.max(beat, s.b0) - s.b0)) / (s.b1 - s.b0);
			}
		}
		return this.segs[this.segs.length - 1].v1;
	}

	// Exported time (seconds) at which a timeline beat is heard.
	secondsAtBeat(beat: number): number {
		if (beat <= 0) return 0;
		for (const s of this.segs) {
			if (beat < s.b1) return s.t0 + segSeconds(s.v0, s.v1, s.b1 - s.b0, beat - s.b0);
		}
		return 0;
	}

	// Timeline beat heard at an exported time (seconds).
	beatAtSeconds(sec: number): number {
		if (sec <= 0) return 0;
		for (const s of this.segs) {
			if (sec < s.t1) return s.b0 + segBeats(s.v0, s.v1, s.b1 - s.b0, sec - s.t0);
		}
		return 0;
	}
}

export function beatsToSeconds(beats: number, bpm: number): number {
	return (beats * 60) / bpm;
}

export function secondsToBeats(sec: number, bpm: number): number {
	return (sec * bpm) / 60;
}

type Block = { startBeat: number; lengthBeat: number; bpm: number; off?: boolean };

// The tempo curve made by a set of tempo blocks. Before the first block the tempo is the
// project BPM. Where a block starts inside the previous one, the earlier ramp is cut there.
// Blocks that are switched off are left out, as if they were not there.
export function blocksToPoints(blocks: Block[], projectBpm: number): Pt[] {
	const sorted = blocks.filter((b) => !b.off).sort((a, b) => a.startBeat - b.startBeat);
	const pts: Pt[] = [];
	let cur = projectBpm;
	for (const b of sorted) {
		const start = Math.max(0, b.startBeat);
		const prevEnd = pts.length ? pts[pts.length - 1] : null;
		if (prevEnd && start < prevEnd.beat) {
			const prevStart = pts[pts.length - 2];
			const span = prevEnd.beat - prevStart.beat;
			cur = span > 0 ? prevStart.bpm + ((prevEnd.bpm - prevStart.bpm) * (start - prevStart.beat)) / span : prevEnd.bpm;
			pts[pts.length - 1] = { beat: start, bpm: cur };
		}
		pts.push({ beat: start, bpm: cur }, { beat: start + Math.max(0, b.lengthBeat), bpm: b.bpm });
		cur = b.bpm;
	}
	return pts;
}

// Turns an old point curve into blocks that play back the same way.
export function pointsToBlocks(points: Pt[], projectBpm: number, minLength: number): Block[] {
	const p = sortPoints(points);
	const out: Block[] = [];
	if (p.length && p[0].bpm !== projectBpm) out.push({ startBeat: 0, lengthBeat: minLength, bpm: p[0].bpm });
	for (let i = 1; i < p.length; i++) {
		if (p[i].bpm === p[i - 1].bpm) continue;
		const start = Math.max(0, p[i - 1].beat);
		out.push({ startBeat: start, lengthBeat: Math.max(minLength, p[i].beat - start), bpm: p[i].bpm });
	}
	return out;
}
