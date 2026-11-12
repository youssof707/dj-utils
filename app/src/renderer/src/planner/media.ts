// Stretched audio for each track: asks the main process to stretch (or reuse its cache),
// tracks progress, and keeps waveform peaks.

import { stretchKey, type PlannerDoc, type PlannerTrack, type StretchRequest } from "@shared/planner";
import { errorText, store } from "./store";

export type Media = { state: "working"; pct: number } | { state: "ready"; cachePath: string; frames: number; peaks: Uint8Array | null } | { state: "error"; message: string };

const media = new Map<string, Media>();

export function requestFor(track: PlannerTrack, projectBpm: number): StretchRequest {
	return { sourcePath: track.sourcePath, bpm: track.bpm, projectBpm };
}

export function mediaFor(track: PlannerTrack | undefined, projectBpm: number): Media | undefined {
	return track ? media.get(stretchKey(requestFor(track, projectBpm))) : undefined;
}

function bump(): void {
	store.set({ mediaRev: store.get().mediaRev + 1 });
}

let progressTimer: ReturnType<typeof setTimeout> | undefined;

function start(req: StretchRequest): void {
	const key = stretchKey(req);
	media.set(key, { state: "working", pct: 0 });
	window.api
		.stretch(req)
		.then(async (r) => {
			let peaks: Uint8Array | null = null;
			try {
				peaks = await window.api.readPeaks(r.cachePath);
			} catch {
				// waveform is cosmetic; the clip still plays
			}
			media.set(key, { state: "ready", cachePath: r.cachePath, frames: r.frames, peaks });
		})
		.catch((e) => {
			media.set(key, { state: "error", message: errorText(e) });
		})
		.finally(bump);
}

// Makes sure every track in the document has (or is getting) audio at the project tempo.
export function reconcileMedia(doc: PlannerDoc): void {
	let started = false;
	for (const t of doc.tracks) {
		const req = requestFor(t, doc.bpm);
		if (!media.has(stretchKey(req))) {
			start(req);
			started = true;
		}
	}
	if (started) bump();
}

export function retryMedia(track: PlannerTrack, projectBpm: number): void {
	start(requestFor(track, projectBpm));
	bump();
}

export function workingCount(doc: PlannerDoc): number {
	let n = 0;
	for (const t of doc.tracks) if (mediaFor(t, doc.bpm)?.state === "working") n++;
	return n;
}

export function initMedia(): void {
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
