// Adding and deleting Rekordbox cue points. Every change is written to Rekordbox's database
// at once, and is a step of undo history: the timeline's, or the track editor's when it was
// made there.

import { cueMarks, cuesAt, cueSnapBeat, hotCueKind, type CueMark } from "@shared/cues";
import type { CueChange, PlannerTrack } from "@shared/planner";
import { refreshCues } from "./actions";
import { errorText, setCueRunner, store, toast, type CueSpot, type CueStep } from "./store";
import { editPushCueStep } from "./trackEdit";

export { cueMarks, type CueMark };

// The place on a track that a right-click at `beat` (beats into the track) is about.
// `within` is the stretch of the track drawn there; cues outside it are not under the pointer.
export function cueSpot(track: PlannerTrack, marks: CueMark[], beat: number, pxPerBeat: number, edit: boolean, within?: { from: number; to: number }): CueSpot {
	return { path: track.sourcePath, sec: (cueSnapBeat(track, beat) * 60) / track.bpm, hits: cuesAt(marks, beat, pxPerBeat, within), edit };
}

// Changes go to Rekordbox one after the other, in the order they were made.
let work: Promise<void> = Promise.resolve();

function change(path: string, call: () => Promise<CueChange>, done?: (c: CueChange) => void): void {
	work = work.then(async () => {
		try {
			const c = await call();
			store.set({ cues: { ...store.get().cues, [path]: c.cues } });
			done?.(c);
		} catch (e) {
			toast(`Rekordbox was not changed: ${errorText(e)}`);
			refreshCues(true); // show what Rekordbox has
		}
	});
}

// A change that was made becomes an undo step where it was made, if that is still open.
function remember(spot: CueSpot, gen: number): (c: CueChange) => void {
	return (c) => {
		if (c.added.length === 0 && c.removed.length === 0) return;
		const step: CueStep = { cue: true, path: spot.path, added: c.added, removed: c.removed };
		const s = store.get();
		if (s.setGen !== gen) return;
		if (!spot.edit) store.pushCueStep(step);
		else if (s.trackEdit && (s.trackEdit.track.sourcePath === spot.path || s.trackEdit.second?.sourcePath === spot.path)) editPushCueStep(step);
	};
}

// Adds a memory cue (`kind` 0) or the hot cue A to H (1 to 8) at the spot. A hot cue takes
// the place of the one the track already has on that letter.
export function addCue(spot: CueSpot, kind: number): void {
	change(spot.path, () => window.api.cueAdd(spot.path, spot.sec, kind), remember(spot, store.get().setGen));
}

export function deleteCue(spot: CueSpot, id: string): void {
	change(spot.path, () => window.api.cueDelete(spot.path, [id]), remember(spot, store.get().setGen));
}

// "Add hot cue" was chosen: the next key picks its letter.
export function waitForHotCue(spot: CueSpot): void {
	store.set({ cueWait: spot });
}

// A key pressed while a hot cue waits for its letter. A to H adds the cue, Escape gives up,
// and any other key does nothing at all: the wait goes on.
export function cueWaitKey(e: KeyboardEvent): void {
	const spot = store.get().cueWait;
	if (!spot) return;
	e.preventDefault();
	e.stopPropagation();
	if (e.key === "Escape") {
		store.set({ cueWait: null });
		return;
	}
	const kind = e.metaKey || e.ctrlKey || e.altKey || e.repeat ? 0 : hotCueKind(e.key);
	if (!kind) return;
	store.set({ cueWait: null });
	addCue(spot, kind);
}

// Undo and redo of a cue step: the rows it added go and the rows it took out come back
// exactly as they were, or the other way round.
setCueRunner((step, back) => {
	const out = back ? step.added : step.removed;
	const put = back ? step.removed : step.added;
	change(step.path, () => window.api.cueApply(step.path, out.map((r) => String(r["ID"])), put));
});
