// Everything the user can do in the track editor, as plain functions over the store.

import { addCut, barPhase, cutAt, duplicateSections, initialSections, insertSections, leadBeat, moveSections, piecesOf, place, removeSections, secondOffset, sectionsFromClips, slideSections, snapBeat, srcOf, totalBeats, type EditSection } from "@shared/trackEdit";
import { trackBeats, type PlannerTrack } from "@shared/planner";
import { BEAT_GRID_MIN_PX, MAX_PX_PER_BEAT, MIN_PX_PER_BEAT } from "./actions";
import { playEditPreview, stopEditPreview } from "./editPlayer";
import { reconcileMedia } from "./media";
import { errorText, isCueStep, newId, runCueStep, store, type CueStep, type EditLane, type EditSnap, type TrackEditUi } from "./store";

const HISTORY = 200;
const PAD = 12; // px left free at the right edge when the whole edit is fitted to the panel

const ed = (): TrackEditUi | null => store.get().trackEdit;

function patch(p: Partial<TrackEditUi>): void {
	const e = ed();
	if (e) store.set({ trackEdit: { ...e, ...p } });
}

// Length of the result in beats.
export function editTotal(e: EditSnap): number {
	return totalBeats(leadBeat(e.track), e.sections);
}

// The track a lane lays out whole.
export function laneTrack(e: EditSnap, lane: 0 | 1): PlannerTrack | null {
	return lane === 0 ? e.track : e.second;
}

// How far along the ruler a lane's track starts. The first track and the result start at 0;
// the second track is moved right by up to a bar, so its bar lines fall on the same lines.
export function laneOffset(e: EditSnap, lane: EditLane): number {
	return lane === 1 && e.second ? secondOffset(e.track, e.second) : 0;
}

// The stretch of the ruler a lane has something on: from its first beat line to its end.
export function laneSpan(e: EditSnap, lane: EditLane): { from: number; to: number } {
	const t = lane === "out" ? null : laneTrack(e, lane);
	if (!t) return { from: leadBeat(e.track), to: editTotal(e) };
	const off = laneOffset(e, lane);
	return { from: off + leadBeat(t), to: off + trackBeats(t) };
}

// How far the ruler runs: to the end of the longest lane.
export function editExtent(e: EditSnap): number {
	if (!e.second) return editTotal(e);
	return Math.max(editTotal(e), laneSpan(e, 0).to, laneSpan(e, 1).to);
}

// The pieces a track's lane is cut into, each with an id that says where it starts.
export function editPieces(e: EditSnap, lane: 0 | 1): { id: string; startBeat: number; lengthBeat: number }[] {
	const t = laneTrack(e, lane);
	if (!t) return [];
	return piecesOf(t, e.cuts[lane]).map((p) => ({ ...p, id: `src${lane}:${Math.round(p.startBeat * 1000)}` }));
}

// The zoom in use: the one set, or the one at which everything fits the panel.
export function editPx(e: TrackEditUi): number {
	if (e.pxPerBeat > 0) return e.pxPerBeat;
	return Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, (e.width - PAD) / Math.max(1, editExtent(e))));
}

// The grid step moves and the cursor go by: a beat, or a bar when zoomed out too far to tell
// the beats apart.
export function editStep(e: TrackEditUi): number {
	return editPx(e) >= BEAT_GRID_MIN_PX ? 1 : 4;
}

// Cuts and the cursor land on beat lines, or on bar lines when zoomed out too far to tell
// the beats apart, and stay on the lane's own stretch of the ruler.
export function editSnap(e: TrackEditUi, beat: number, lane: EditLane = e.lane): number {
	const span = laneSpan(e, lane);
	return Math.max(span.from, snapBeat(beat, leadBeat(e.track), barPhase(e.track), editStep(e), span.to));
}

function clampScroll(e: TrackEditUi, scrollX: number, px: number): number {
	return Math.min(Math.max(0, scrollX), Math.max(0, editExtent(e) * px + PAD - e.width));
}

const snapOf = (e: EditSnap): EditSnap => ({ track: e.track, second: e.second, sections: e.sections, cuts: e.cuts });

// Whatever the tracks and sections are now, the rest is brought in line with them: the lane
// is one that exists, the selection is of things on it, and the cursor and view are in range.
function settled(e: TrackEditUi): TrackEditUi {
	const lane: EditLane = e.lane !== "out" && !e.second ? "out" : e.lane;
	const ids = new Set(lane === "out" ? e.sections.map((s) => s.id) : editPieces(e, lane).map((p) => p.id));
	const next: TrackEditUi = { ...e, lane, selection: e.selection.filter((id) => ids.has(id)) };
	const span = laneSpan(next, lane);
	next.cursorBeat = Math.min(span.to, Math.max(lane === "out" ? 0 : span.from, next.cursorBeat));
	next.scrollX = clampScroll(next, next.scrollX, editPx(next));
	return next;
}

function show(next: TrackEditUi, before: TrackEditUi): void {
	store.set({ trackEdit: settled(next) });
	// Another track in the editor: its audio and waveform are fetched, the old one's let go.
	if (next.track !== before.track || next.second !== before.second) reconcileMedia(store.get().doc);
}

// A finished change: one undo step. The preview stops, and when the result changed, what was
// exported before no longer matches.
function commit(change: Partial<EditSnap>, more: Partial<TrackEditUi> = {}): void {
	const e = ed();
	if (!e) return;
	const snap: EditSnap = { ...snapOf(e), ...change };
	if (snap.track === e.track && snap.second === e.second && snap.sections === e.sections && snap.cuts === e.cuts) return;
	stopEditPreview();
	const same = snap.track === e.track && snap.sections === e.sections;
	show({ ...e, ...snap, past: [...e.past, snapOf(e)].slice(-HISTORY), future: [], exported: same ? e.exported : null, error: null, playing: false, ...more }, e);
}

// Opens a track of the set in the editor.
export function openTrackEdit(trackId: string): void {
	const track = store.get().doc.tracks.find((t) => t.id === trackId);
	if (track) openTrackEditWith(track);
}

const sameTrack = (a: PlannerTrack, b: PlannerTrack): boolean => a.sourcePath === b.sourcePath && a.bpm === b.bpm && a.downbeatSec === b.downbeatSec;

// The cut marks that divide a track's lane into these sections.
const cutsOf = (sections: EditSection[] | undefined): number[] => [...new Set((sections ?? []).flatMap((s) => [s.startBeat, s.startBeat + s.lengthBeat]))].sort((a, b) => a - b);

// Opens a track in the editor, from the set or not (a file dropped on the editor). With
// nothing open it becomes the edit, cut up as `sections` when given. Next to a track that is
// open already it goes on a lane of its own, to take pieces from, cut at the ends of
// `sections`. Opening a track that is open keeps the work done; with `sections` on the first
// track, they become the edit (one more change, which can be undone).
export function openTrackEditWith(track: PlannerTrack, sections?: EditSection[]): void {
	const s = store.get();
	const cur = s.trackEdit;
	if (!cur) {
		stopEditPreview();
		store.set({
			editFocus: true,
			trackEdit: { track, second: null, sections: sections ?? initialSections(track, newId("e")), cuts: [[], []], past: [], future: [], lane: "out", selection: [], cursorBeat: leadBeat(track), pxPerBeat: 0, scrollX: 0, width: 800, playing: false, exporting: false, exported: null, error: null },
		});
		// A track that is not in the set gets its audio (waveform and preview) all the same.
		reconcileMedia(store.get().doc);
		return;
	}
	store.set({ editFocus: true });
	if (sameTrack(cur.track, track)) {
		if (sections) commit({ sections }, { lane: "out", selection: [], cursorBeat: leadBeat(track), scrollX: 0 });
		return;
	}
	if (cur.second && sameTrack(cur.second, track)) {
		if (sections) commit({ cuts: [cur.cuts[0], cutsOf(sections)] }, { lane: 1, selection: [] });
		else editSelect([], 1);
		return;
	}
	// A third track takes the second one's lane, unless pieces of both are in the edit.
	if (cur.second && cur.sections.some((x) => srcOf(x) === 1)) {
		patch({ error: "Both tracks are used in the edit. Remove one to bring in another." });
		return;
	}
	const next: EditSnap = { ...snapOf(cur), second: track, cuts: [cur.cuts[0], cutsOf(sections)] };
	commit(next, { lane: 1, selection: [], cursorBeat: laneSpan(next, 1).from });
}

// Takes a track out of the two-track editor, and its pieces out of the edit. The track that
// is left is the one being edited from then on.
export function editRemoveTrack(lane: 0 | 1): void {
	const e = ed();
	if (!e || !e.second) return;
	const rest = removeSections(
		e.sections,
		e.sections.filter((s) => srcOf(s) === lane).map((s) => s.id),
	);
	if (lane === 1) {
		commit({ second: null, sections: rest, cuts: [e.cuts[0], []] }, { lane: "out", selection: [] });
		return;
	}
	const own = rest.map((s) => {
		const n = { ...s };
		delete n.src;
		return n;
	});
	commit({ track: e.second, second: null, sections: own, cuts: [e.cuts[1], []] }, { lane: "out", selection: [] });
}

// Sends the clips selected on the timeline to the editor, cut up and spaced as they are
// there. False when no clip is selected. Clips of more than one file are left alone, and
// muted clips count as empty space.
export function editSelectedClips(): boolean {
	const s = store.get();
	const chosen = new Set(s.selection);
	const clips = s.doc.clips.filter((c) => chosen.has(c.id));
	if (clips.length === 0) return false;
	const track = s.doc.tracks.find((t) => t.id === clips[0].trackId);
	if (!track) return true;
	for (const c of clips) {
		const t = c.trackId === track.id ? track : s.doc.tracks.find((x) => x.id === c.trackId);
		if (!t || !sameTrack(t, track)) return true;
	}
	const sections = sectionsFromClips(track, clips.filter((c) => !c.muted), () => newId("e"));
	if (sections.length > 0) openTrackEditWith(track, sections);
	return true;
}

export function closeTrackEdit(): void {
	stopEditPreview();
	store.set({ trackEdit: null, editFocus: false });
	reconcileMedia(store.get().doc);
}

// Moves the cursor, on the lane it is on or to another lane. A preview that is playing
// carries on from there.
export function editSetCursor(beat: number, lane?: EditLane): void {
	const e = ed();
	if (!e) return;
	const to = lane ?? e.lane;
	const at = editSnap(e, beat, to);
	if (at === e.cursorBeat && to === e.lane) return;
	const playing = e.playing;
	if (playing) stopEditPreview();
	const now = ed()!;
	store.set({ trackEdit: settled({ ...now, cursorBeat: at, lane: to, selection: to === e.lane ? now.selection : [] }) });
	if (playing) void playEditPreview();
}

// Moves the cursor one grid step left or right.
export function editStepCursor(dir: -1 | 1): void {
	const e = ed();
	if (e) editSetCursor(e.cursorBeat + dir * editStep(e));
}

// Selects sections of the result, or pieces of a track's lane; the keys act on that lane.
export function editSelect(ids: string[], lane?: EditLane): void {
	const e = ed();
	if (!e) return;
	if (e.playing && lane !== undefined && lane !== e.lane) stopEditPreview();
	const now = ed()!;
	store.set({ trackEdit: settled({ ...now, selection: ids, lane: lane ?? now.lane }) });
}

export function editSelectAll(): void {
	const e = ed();
	if (e) patch({ selection: e.lane === "out" ? e.sections.map((s) => s.id) : editPieces(e, e.lane).map((p) => p.id) });
}

// Cuts a lane at a place along the ruler (the nearest grid line), and leaves the cursor
// there. On a track's own lane a cut only marks where a piece ends; the track stays whole.
export function editCutAt(beat: number, lane?: EditLane): void {
	const e = ed();
	if (!e) return;
	const to = lane ?? e.lane;
	const at = editSnap(e, beat, to);
	const track = to === "out" ? null : laneTrack(e, to);
	if (to === "out" || !track) {
		const next = cutAt(leadBeat(e.track), e.sections, at, () => newId("e"));
		if (next === e.sections) editSetCursor(at, "out");
		else commit({ sections: next }, { selection: [], cursorBeat: at, lane: "out" });
		return;
	}
	const marks = addCut(track, e.cuts[to], at - laneOffset(e, to));
	if (marks === e.cuts[to]) editSetCursor(at, to);
	else commit({ cuts: to === 0 ? [marks, e.cuts[1]] : [e.cuts[0], marks] }, { selection: [], cursorBeat: at, lane: to });
}

// Cuts at the cursor.
export function editCut(): void {
	const e = ed();
	if (e) editCutAt(e.cursorBeat);
}

// Whether a cut at the cursor would change anything.
export function editCanCut(e: TrackEditUi): boolean {
	const track = e.lane === "out" ? null : laneTrack(e, e.lane);
	if (e.lane === "out" || !track) return place(leadBeat(e.track), e.sections).some((p) => e.cursorBeat > p.outBeat + 1e-6 && e.cursorBeat < p.outBeat + p.lengthBeat - 1e-6);
	return addCut(track, e.cuts[e.lane], e.cursorBeat - laneOffset(e, e.lane)) !== e.cuts[e.lane];
}

export function editDelete(): void {
	const e = ed();
	if (!e || e.lane !== "out" || e.selection.length === 0) return;
	commit({ sections: removeSections(e.sections, e.selection) });
}

export function editDuplicate(): void {
	const e = ed();
	if (!e || e.lane !== "out" || e.selection.length === 0) return;
	const r = duplicateSections(e.sections, e.selection, () => newId("e"));
	commit({ sections: r.sections }, { selection: r.copies });
}

// Moves sections to sit before the section now at `toIndex`.
export function editMove(ids: string[], toIndex: number): void {
	const e = ed();
	if (!e) return;
	commit({ sections: moveSections(e.sections, ids, toIndex) }, { selection: ids, lane: "out" });
}

// Moves sections later or earlier in time by whole beats, leaving silence behind them.
export function editSlide(ids: string[], byBeats: number): void {
	const e = ed();
	if (!e) return;
	commit({ sections: slideSections(e.sections, ids, byBeats) }, { selection: ids, lane: "out" });
}

// Moves the selected sections one grid step later or earlier.
export function editNudge(dir: -1 | 1): void {
	const e = ed();
	if (e && e.lane === "out" && e.selection.length > 0) editSlide(e.selection, dir * editStep(e));
}

// New sections for the edit, one for each of these pieces of a track's lane, in the order
// they come in the track.
export function editSectionsOf(e: EditSnap, lane: 0 | 1, ids: string[]): EditSection[] {
	return editPieces(e, lane)
		.filter((p) => ids.includes(p.id))
		.map((p) => (lane === 1 ? { id: newId("e"), startBeat: p.startBeat, lengthBeat: p.lengthBeat, src: 1 } : { id: newId("e"), startBeat: p.startBeat, lengthBeat: p.lengthBeat }));
}

// Puts pieces taken from a track's lane into the edit where they were dropped (see
// insertSections), and selects them there.
export function editInsert(added: EditSection[], pointerBeat: number, startBeat: number): void {
	const e = ed();
	if (!e || added.length === 0) return;
	commit({ sections: insertSections(leadBeat(e.track), e.sections, added, pointerBeat, startBeat) }, { selection: added.map((s) => s.id), lane: "out" });
}

// Puts the pieces selected on a track's lane at the end of the edit, and brings them into view.
export function editAddSelected(): void {
	const e = ed();
	if (!e || e.lane === "out" || e.selection.length === 0) return;
	const added = editSectionsOf(e, e.lane, e.selection);
	if (added.length === 0) return;
	const at = editTotal(e);
	const px = editPx(e);
	const x = at * px - e.scrollX;
	commit({ sections: [...e.sections, ...added] }, { selection: added.map((s) => s.id), lane: "out", cursorBeat: at, scrollX: x < 0 || x > e.width - 60 ? at * px - e.width / 3 : e.scrollX });
}

// A change to the cues of one of the editor's tracks, made in Rekordbox: one undo step here.
export function editPushCueStep(step: CueStep): void {
	const e = ed();
	if (e) patch({ past: [...e.past, step].slice(-HISTORY), future: [] });
}

function restore(snap: EditSnap, past: (EditSnap | CueStep)[], future: (EditSnap | CueStep)[]): void {
	const e = ed();
	if (!e) return;
	stopEditPreview();
	show({ ...e, ...snap, past, future, exported: null, error: null, playing: false }, e);
}

export function editUndo(): void {
	const e = ed();
	if (!e || e.past.length === 0) return;
	const step = e.past[e.past.length - 1];
	if (isCueStep(step)) {
		// The edit is as it was; only Rekordbox's cues go back.
		patch({ past: e.past.slice(0, -1), future: [step, ...e.future] });
		runCueStep(step, true);
		return;
	}
	restore(step, e.past.slice(0, -1), [snapOf(e), ...e.future]);
}

export function editRedo(): void {
	const e = ed();
	if (!e || e.future.length === 0) return;
	const step = e.future[0];
	if (isCueStep(step)) {
		patch({ past: [...e.past, step], future: e.future.slice(1) });
		runCueStep(step, false);
		return;
	}
	restore(step, [...e.past, snapOf(e)], e.future.slice(1));
}

export function editZoom(factor: number, anchorPx?: number): void {
	const e = ed();
	if (!e) return;
	const px = editPx(e);
	const anchor = anchorPx ?? e.width / 2;
	const next = Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, px * factor));
	const beat = (e.scrollX + anchor) / px;
	patch({ pxPerBeat: next, scrollX: clampScroll(e, beat * next - anchor, next) });
}

export function editFit(): void {
	patch({ pxPerBeat: 0, scrollX: 0 });
}

export function editScroll(dx: number): void {
	const e = ed();
	if (e) patch({ scrollX: clampScroll(e, e.scrollX + dx, editPx(e)) });
}

export function editResize(width: number): void {
	const e = ed();
	if (!e || e.width === width) return;
	const next = { ...e, width };
	store.set({ trackEdit: { ...next, scrollX: clampScroll(next, next.scrollX, editPx(next)) } });
}

// Writes the edit to the export folder: the source files' own audio, rearranged. With pieces
// of both tracks in it, the file is at the first track's tempo and in its format.
export async function exportTrackEdit(): Promise<string | null> {
	const e = ed();
	if (!e || e.exporting) return null;
	const lead = leadBeat(e.track);
	// Each section with the silence between it and the one before.
	let end = lead;
	const sections = place(lead, e.sections).map((p) => {
		const gapBeat = Math.round(p.outBeat - end);
		end = p.outBeat + p.lengthBeat;
		return { startBeat: p.section.startBeat, lengthBeat: p.lengthBeat, ...(gapBeat > 0 ? { gapBeat } : {}), ...(srcOf(p.section) === 1 ? { src: 1 } : {}) };
	});
	if (sections.length === 0) {
		patch({ error: "There is nothing to export" });
		return null;
	}
	const second = e.second && sections.some((s) => s.src === 1) ? { sourcePath: e.second.sourcePath, bpm: e.second.bpm } : undefined;
	patch({ exporting: true, error: null });
	const same = (): boolean => ed()?.track === e.track;
	try {
		const r = await window.api.exportEdit({ sourcePath: e.track.sourcePath, name: e.track.name, bpm: e.track.bpm, downbeatSec: e.track.downbeatSec, leadBeat: lead, sections, ...(second ? { second } : {}) });
		// Only the edit as it was exported counts as exported.
		if (same()) patch({ exporting: false, exported: ed()!.sections === e.sections ? r.path : null });
		return r.path;
	} catch (err) {
		if (same()) patch({ exporting: false, error: `Could not export: ${errorText(err)}` });
		return null;
	}
}
