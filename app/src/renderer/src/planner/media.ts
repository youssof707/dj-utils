// Audio for each track: asks the main process to render it (or reuse its cache), tracks
// progress, and keeps waveform peaks. Every track has one rendering at the project tempo.
// Where tempo changes move the set away from that tempo, the clips that play there get more:
// the track stretched to each tempo the set settles on, and one rendering for each stretch
// of a clip that plays while the tempo is moving.

import { JOIN_FADE_SEC, stretchKey, type Clip, type PlannerDoc, type PlannerTrack, type StretchRequest, type StretchResult } from "@shared/planner";
import { clipPieces, isRamp, type Piece } from "@shared/pieces";
import { pieceKey, renderingsFor, stretchRequestFor, tempoMapOf } from "@shared/renderings";
import type { TempoMap } from "@shared/tempo";
import { errorText, store } from "./store";

export type Media = { state: "working"; pct: number } | { state: "ready"; cachePath: string; frames: number; peaks: Uint8Array | null } | { state: "error"; message: string };

const media = new Map<string, Media>();
// The tempos each track has been stretched to (or is being stretched to), by track audio.
const versions = new Map<string, Map<number, string>>();

const audioKey = (t: { sourcePath: string; bpm: number }): string => `${t.sourcePath}|${t.bpm}`;

export const requestFor = stretchRequestFor;

export function mediaFor(track: PlannerTrack | undefined, bpm: number): Media | undefined {
	return track ? media.get(stretchKey(requestFor(track, bpm))) : undefined;
}

function bump(): void {
	store.set({ mediaRev: store.get().mediaRev + 1 });
}

let progressTimer: ReturnType<typeof setTimeout> | undefined;
let current: PlannerDoc | null = null; // the set as of the last pass
let again: ReturnType<typeof setTimeout> | undefined;
let settle: ReturnType<typeof setTimeout> | undefined;
const SETTLE_MS = 300;

function run(key: string, job: Promise<StretchResult>, withPeaks: boolean): void {
	media.set(key, { state: "working", pct: 0 });
	job.then(async (r) => {
		let peaks: Uint8Array | null = null;
		if (withPeaks) {
			try {
				peaks = await window.api.readPeaks(r.cachePath);
			} catch {
				// waveform is cosmetic; the clip still plays
			}
		}
		media.set(key, { state: "ready", cachePath: r.cachePath, frames: r.frames, peaks });
	})
		.catch((e) => {
			if (errorText(e) !== "cancelled") {
				media.set(key, { state: "error", message: errorText(e) });
				return;
			}
			// Dropped because the set had moved on. If it has since come back to needing this
			// (an undo, say), the next pass asks for it again.
			media.delete(key);
			clearTimeout(again);
			again = setTimeout(() => current && reconcileMedia(current), 0);
		})
		.finally(bump);
}

function start(req: StretchRequest): void {
	const key = stretchKey(req);
	let v = versions.get(audioKey(req));
	if (!v) versions.set(audioKey(req), (v = new Map()));
	v.set(req.projectBpm, key);
	run(key, window.api.stretch(req), true);
}

// ---- what each clip needs ---------------------------------------------------------------

let mapDoc: PlannerDoc | null = null;
let map: TempoMap | null = null;

export function tempoMap(doc: PlannerDoc): TempoMap {
	if (doc !== mapDoc || !map) {
		mapDoc = doc;
		map = tempoMapOf(doc);
	}
	return map;
}

// What plays a piece: its own rendering once that is ready (`exact`: the file is already at
// the right tempo, and the piece starts `offsetSec` into it), and until then any rendering
// of the track at a steady tempo, played faster or slower to fit. That keeps the timing
// right at once; only the pitch is off until the proper rendering arrives.
export type PieceSource = { exact: true; cachePath: string; frames: number; offsetSec: number; leadSec: number } | { exact: false; cachePath: string; frames: number; fileBpm: number };

export function pieceSource(track: PlannerTrack, p: Piece): PieceSource | null {
	const own = media.get(pieceKey(track, p));
	if (own?.state === "ready") {
		if (!isRamp(p)) {
			const offsetSec = (p.trackBeat * 60) / p.bpmA;
			return { exact: true, cachePath: own.cachePath, frames: own.frames, offsetSec, leadSec: offsetSec };
		}
		return { exact: true, cachePath: own.cachePath, frames: own.frames, offsetSec: JOIN_FADE_SEC, leadSec: JOIN_FADE_SEC };
	}
	// The steady rendering whose tempo is nearest, so the pitch is off by as little as possible.
	const want = (p.bpmA + p.bpmB) / 2;
	let best: PieceSource | null = null;
	for (const [bpm, key] of versions.get(audioKey(track)) ?? []) {
		const m = media.get(key);
		if (m?.state !== "ready") continue;
		if (!best || best.exact || Math.abs(bpm - want) < Math.abs(best.fileBpm - want)) best = { exact: false, cachePath: m.cachePath, frames: m.frames, fileBpm: bpm };
	}
	return best;
}

type Need = { key: string; beat: number; start: () => void };

// The renderings the tempo changes call for, beyond the one at the project tempo.
function needs(doc: PlannerDoc): Need[] {
	if (doc.tempos.length === 0) return [];
	const out: Need[] = [];
	for (const r of renderingsFor(doc, tempoMap(doc))) {
		if (r.base) continue;
		out.push({ key: r.key, beat: r.beat, start: r.ramp ? (): void => run(r.key, window.api.ramp(r.req), false) : (): void => start(r.req) });
	}
	return out;
}

// Makes sure every track has (or is getting) its audio at the project tempo, and every clip
// under a tempo change the renderings it plays there. Work for anything the set no longer
// needs is stopped. What lies just ahead of the playhead is rendered first.
export function reconcileMedia(doc: PlannerDoc): void {
	current = doc;
	const extra = needs(doc);
	// Only tracks with a clip in the set: a track whose last clip was deleted stays in the
	// document for undo, but its audio is let go (and cleaned up a little later).
	const used = new Set(doc.clips.map((c) => c.trackId));
	const base = doc.tracks.filter((t) => used.has(t.id)).map((t) => requestFor(t, doc.bpm));
	void window.api.keepRenderings([...base.map(stretchKey), ...extra.map((n) => n.key)]);
	let started = false;
	for (const req of base) {
		if (media.has(stretchKey(req))) continue;
		start(req);
		started = true;
	}
	if (started) bump();
	// The rest waits a moment, so a run of edits (a tempo change nudged along with the arrow
	// keys, say) starts work once, for where things end up. Clips play meanwhile all the same.
	clearTimeout(settle);
	if (extra.some((n) => !media.has(n.key))) {
		settle = setTimeout(() => {
			const at = store.get().playheadBeat;
			const order = (n: Need): number => (n.beat >= at - 64 ? n.beat : n.beat + 1e9);
			let any = false;
			for (const n of extra.sort((a, b) => order(a) - order(b))) {
				if (media.has(n.key)) continue;
				n.start();
				any = true;
			}
			if (any) bump();
		}, SETTLE_MS);
	}
}

export function retryMedia(track: PlannerTrack, projectBpm: number): void {
	start(requestFor(track, projectBpm));
	bump();
}

// Tracks whose audio at the project tempo is still being made.
export function workingCount(doc: PlannerDoc): number {
	let n = 0;
	for (const t of doc.tracks) if (mediaFor(t, doc.bpm)?.state === "working") n++;
	return n;
}

// How far along the renderings for the tempo changes are: how many are still being made,
// and their progress overall.
export function tempoProgress(doc: PlannerDoc): { left: number; pct: number } {
	let left = 0;
	let total = 0;
	let done = 0;
	for (const n of needs(doc)) {
		const m = media.get(n.key);
		if (m?.state === "error") continue;
		total++;
		if (m?.state === "ready") done++;
		else {
			left++;
			done += m?.pct ?? 0;
		}
	}
	return { left, pct: total ? done / total : 1 };
}

// Whether a clip is waiting on a rendering for a tempo change (it plays meanwhile, at the
// right speed but with its pitch off), and how far along that is.
export function clipTempoProgress(doc: PlannerDoc, clip: Clip, track: PlannerTrack | undefined): number | null {
	if (doc.tempos.length === 0 || !track) return null;
	let total = 0;
	let done = 0;
	let waiting = false;
	for (const p of clipPieces(clip, track, tempoMap(doc))) {
		if (!isRamp(p) && p.bpmA === doc.bpm) continue;
		const m = media.get(pieceKey(track, p));
		if (m?.state === "error") continue;
		total++;
		if (m?.state === "ready") done++;
		else {
			waiting = true;
			done += m?.pct ?? 0;
		}
	}
	return waiting ? done / total : null;
}

// Cached files that are gone (cleaned away, or found missing when playback went to read
// one): forget them, so whatever the set still needs of them is made again.
export function lostMedia(paths: string[]): void {
	const gone = new Set(paths);
	let any = false;
	for (const [key, m] of media) {
		if (m.state !== "ready" || !gone.has(m.cachePath)) continue;
		media.delete(key);
		any = true;
	}
	if (!any) return;
	if (current) reconcileMedia(current);
	bump();
}

// Lets go of everything known about the set that was open (its waveforms above all).
export function forgetMedia(): void {
	media.clear();
	versions.clear();
	clearTimeout(settle);
}

export function initMedia(): void {
	window.api.onCacheRemoved(lostMedia);
	window.api.onStretchProgress(({ key, pct }) => {
		const m = media.get(key);
		if (m?.state !== "working") return;
		m.pct = pct;
		// Progress arrives in bursts; repaint at most a few times a second.
		if (!progressTimer) {
			progressTimer = setTimeout(() => {
				progressTimer = undefined;
				store.set({ progressRev: store.get().progressRev + 1 });
			}, 200);
		}
	});
}
