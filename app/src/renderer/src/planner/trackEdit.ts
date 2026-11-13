// Everything the user can do in the track editor, as plain functions over the store.

import { barPhase, cutAt, duplicateSections, initialSections, leadBeat, moveSections, place, removeSections, sectionsFromClips, slideSections, snapBeat, totalBeats, type EditSection } from "@shared/trackEdit";
import { BEAT_GRID_MIN_PX, MAX_PX_PER_BEAT, MIN_PX_PER_BEAT } from "./actions";
import { playEditPreview, stopEditPreview } from "./editPlayer";
import { reconcileMedia } from "./media";
import type { PlannerTrack } from "@shared/planner";
import { errorText, newId, store, type TrackEditUi } from "./store";

const HISTORY = 200;
const PAD = 12; // px left free at the right edge when the whole edit is fitted to the panel

const ed = (): TrackEditUi | null => store.get().trackEdit;

function patch(p: Partial<TrackEditUi>): void {
	const e = ed();
	if (e) store.set({ trackEdit: { ...e, ...p } });
}

export function editTotal(e: TrackEditUi): number {
	return totalBeats(leadBeat(e.track), e.sections);
}

// The zoom in use: the one set, or the one at which the whole edit fits the panel.
export function editPx(e: TrackEditUi): number {
	if (e.pxPerBeat > 0) return e.pxPerBeat;
	return Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, (e.width - PAD) / Math.max(1, editTotal(e))));
}

// Cuts and the cursor land on beat lines, or on bar lines when zoomed out too far to tell
// the beats apart.
export function editSnap(e: TrackEditUi, beat: number): number {
	return snapBeat(beat, leadBeat(e.track), barPhase(e.track), editPx(e) >= BEAT_GRID_MIN_PX ? 1 : 4, editTotal(e));
}

function clampScroll(e: TrackEditUi, scrollX: number, px: number): number {
	return Math.min(Math.max(0, scrollX), Math.max(0, editTotal(e) * px + PAD - e.width));
}

// A finished change to the sections: one undo step. The preview stops, and what was
// exported before no longer matches.
function commit(sections: EditSection[], more: Partial<TrackEditUi> = {}): void {
	const e = ed();
	if (!e || sections === e.sections) return;
	stopEditPreview();
	const ids = new Set(sections.map((s) => s.id));
	const next: TrackEditUi = { ...e, sections, past: [...e.past, e.sections].slice(-HISTORY), future: [], selection: e.selection.filter((id) => ids.has(id)), exported: null, error: null, playing: false, ...more };
	next.cursorBeat = Math.min(next.cursorBeat, editTotal(next));
	next.scrollX = clampScroll(next, next.scrollX, editPx(next));
	store.set({ trackEdit: next });
}

// Opens a track of the set in the editor.
export function openTrackEdit(trackId: string): void {
	const track = store.get().doc.tracks.find((t) => t.id === trackId);
	if (track) openTrackEditWith(track);
}

const sameTrack = (a: PlannerTrack, b: PlannerTrack): boolean => a.sourcePath === b.sourcePath && a.bpm === b.bpm && a.downbeatSec === b.downbeatSec;

// Opens a track in the editor, from the set or not (a file dropped on the editor). Opening
// the one that is open already keeps the work done on it. With `sections` the track opens cut
// up that way; on the track that is open already that is one more change, which can be undone.
export function openTrackEditWith(track: PlannerTrack, sections?: EditSection[]): void {
	const s = store.get();
	const cur = s.trackEdit;
	if (cur && sameTrack(cur.track, track)) {
		store.set({ editFocus: true });
		if (sections) commit(sections, { selection: [], cursorBeat: leadBeat(track), scrollX: 0 });
		return;
	}
	stopEditPreview();
	store.set({
		editFocus: true,
		trackEdit: { track, sections: sections ?? initialSections(track, newId("e")), past: [], future: [], selection: [], cursorBeat: leadBeat(track), pxPerBeat: 0, scrollX: 0, width: cur?.width ?? 800, playing: false, exporting: false, exported: null, error: null },
	});
	// A track that is not in the set gets its audio (waveform and preview) all the same.
	reconcileMedia(store.get().doc);
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

export function editSetCursor(beat: number): void {
	const e = ed();
	if (!e) return;
	const at = editSnap(e, beat);
	if (at === e.cursorBeat) return;
	const playing = e.playing;
	if (playing) stopEditPreview();
	patch({ cursorBeat: at });
	if (playing) void playEditPreview();
}

// Moves the cursor one grid step left or right.
export function editStepCursor(dir: -1 | 1): void {
	const e = ed();
	if (e) editSetCursor(e.cursorBeat + dir * (editPx(e) >= BEAT_GRID_MIN_PX ? 1 : 4));
}

export function editSelect(ids: string[]): void {
	patch({ selection: ids });
}

export function editSelectAll(): void {
	const e = ed();
	if (e) patch({ selection: e.sections.map((s) => s.id) });
}

// Cuts at a place in the edit (the nearest grid line), and leaves the cursor there.
export function editCutAt(beat: number): void {
	const e = ed();
	if (!e) return;
	const at = editSnap(e, beat);
	const next = cutAt(leadBeat(e.track), e.sections, at, () => newId("e"));
	if (next === e.sections) patch({ cursorBeat: at });
	else commit(next, { selection: [], cursorBeat: at });
}

// Cuts at the cursor.
export function editCut(): void {
	const e = ed();
	if (!e) return;
	commit(cutAt(leadBeat(e.track), e.sections, e.cursorBeat, () => newId("e")), { selection: [] });
}

export function editDelete(): void {
	const e = ed();
	if (!e || e.selection.length === 0) return;
	commit(removeSections(e.sections, e.selection));
}

export function editDuplicate(): void {
	const e = ed();
	if (!e || e.selection.length === 0) return;
	const r = duplicateSections(e.sections, e.selection, () => newId("e"));
	commit(r.sections, { selection: r.copies });
}

// Moves sections to sit before the section now at `toIndex`.
export function editMove(ids: string[], toIndex: number): void {
	const e = ed();
	if (!e) return;
	commit(moveSections(e.sections, ids, toIndex), { selection: ids });
}

// The grid step moves and the cursor go by: a beat, or a bar when zoomed out too far to tell
// the beats apart.
export function editStep(e: TrackEditUi): number {
	return editPx(e) >= BEAT_GRID_MIN_PX ? 1 : 4;
}

// Moves sections later or earlier in time by whole beats, leaving silence behind them.
export function editSlide(ids: string[], byBeats: number): void {
	const e = ed();
	if (!e) return;
	commit(slideSections(e.sections, ids, byBeats), { selection: ids });
}

// Moves the selected sections one grid step later or earlier.
export function editNudge(dir: -1 | 1): void {
	const e = ed();
	if (e && e.selection.length > 0) editSlide(e.selection, dir * editStep(e));
}

function restore(sections: EditSection[], past: EditSection[][], future: EditSection[][]): void {
	const e = ed();
	if (!e) return;
	stopEditPreview();
	const ids = new Set(sections.map((s) => s.id));
	const next: TrackEditUi = { ...e, sections, past, future, selection: e.selection.filter((id) => ids.has(id)), exported: null, error: null, playing: false };
	next.cursorBeat = Math.min(next.cursorBeat, editTotal(next));
	next.scrollX = clampScroll(next, next.scrollX, editPx(next));
	store.set({ trackEdit: next });
}

export function editUndo(): void {
	const e = ed();
	if (!e || e.past.length === 0) return;
	restore(e.past[e.past.length - 1], e.past.slice(0, -1), [e.sections, ...e.future]);
}

export function editRedo(): void {
	const e = ed();
	if (!e || e.future.length === 0) return;
	restore(e.future[0], [...e.past, e.sections], e.future.slice(1));
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

// Writes the edit to the export folder: the source file's own audio, rearranged.
export async function exportTrackEdit(): Promise<string | null> {
	const e = ed();
	if (!e || e.exporting) return null;
	const lead = leadBeat(e.track);
	// Each section with the silence between it and the one before.
	let end = lead;
	const sections = place(lead, e.sections).map((p) => {
		const gapBeat = Math.round(p.outBeat - end);
		end = p.outBeat + p.lengthBeat;
		return gapBeat > 0 ? { startBeat: p.section.startBeat, lengthBeat: p.lengthBeat, gapBeat } : { startBeat: p.section.startBeat, lengthBeat: p.lengthBeat };
	});
	if (sections.length === 0) {
		patch({ error: "There is nothing to export" });
		return null;
	}
	patch({ exporting: true, error: null });
	const same = (): boolean => ed()?.track === e.track;
	try {
		const r = await window.api.exportEdit({ sourcePath: e.track.sourcePath, name: e.track.name, bpm: e.track.bpm, downbeatSec: e.track.downbeatSec, leadBeat: lead, sections });
		// Only the edit as it was exported counts as exported.
		if (same()) patch({ exporting: false, exported: ed()!.sections === e.sections ? r.path : null });
		return r.path;
	} catch (err) {
		if (same()) patch({ exporting: false, error: `Could not export: ${errorText(err)}` });
		return null;
	}
}
