// Everything the user can do in the track editor, as plain functions over the store.

import { appendAt, barPhase, cutAt, duplicateSections, leadBeat, moveSections, place, removeSections, snapBeat, srcOf, totalBeats, wholeTrack, type EditSection } from "@shared/trackEdit";
import type { PlannerTrack } from "@shared/planner";
import { autoEdit, clipsEdit, cuesForEdit, swapInEdit, type AutoLink } from "@shared/cdj";
import { BEAT_GRID_MIN_PX, MAX_PX_PER_BEAT, MIN_PX_PER_BEAT } from "./actions";
import { playEditPreview, stopEditPreview } from "./editPlayer";
import { reconcileMedia } from "./media";
import { errorText, isCueStep, newId, runCueStep, store, toast, type CueStep, type EditReplace, type EditSnap, type TrackEditUi } from "./store";

const HISTORY = 200;
const PAD = 12; // px left free at the right edge when the whole edit is fitted to the panel

const ed = (): TrackEditUi | null => store.get().trackEdit;

function patch(p: Partial<TrackEditUi>): void {
	const e = ed();
	if (e) store.set({ trackEdit: { ...e, ...p } });
}

// The first track: the result has its tempo, grid and name.
export const editMain = (e: EditSnap): PlannerTrack => e.tracks[0];

// Length of the result in beats.
export function editTotal(e: EditSnap): number {
	return totalBeats(e.sections);
}

// The zoom in use: the one set, or the one at which everything fits the panel.
export function editPx(e: TrackEditUi): number {
	if (e.pxPerBeat > 0) return e.pxPerBeat;
	return Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, (e.width - PAD) / Math.max(1, editTotal(e))));
}

// The grid step moves and the cursor go by: a beat, or a bar when zoomed out too far to tell
// the beats apart.
export function editStep(e: TrackEditUi): number {
	return editPx(e) >= BEAT_GRID_MIN_PX ? 1 : 4;
}

// Cuts and the cursor land on the result's beat lines, or on bar lines when zoomed out too far
// to tell the beats apart.
export function editSnap(e: TrackEditUi, beat: number): number {
	const t = editMain(e);
	return snapBeat(beat, leadBeat(t), barPhase(t), editStep(e), editTotal(e));
}

function clampScroll(e: TrackEditUi, scrollX: number, px: number): number {
	return Math.min(Math.max(0, scrollX), Math.max(0, editTotal(e) * px + PAD - e.width));
}

const snapOf = (e: EditSnap): EditSnap => ({ tracks: e.tracks, sections: e.sections });

// Whatever the sections are now, the rest is brought in line with them: the selection is of
// sections that exist, and the cursor and view are in range.
function settled(e: TrackEditUi): TrackEditUi {
	const ids = new Set(e.sections.map((s) => s.id));
	const next: TrackEditUi = { ...e, selection: e.selection.filter((id) => ids.has(id)) };
	next.cursorBeat = Math.min(editTotal(next), Math.max(0, next.cursorBeat));
	next.scrollX = clampScroll(next, next.scrollX, editPx(next));
	return next;
}

function show(next: TrackEditUi, before: TrackEditUi): void {
	store.set({ trackEdit: settled(next) });
	// Other tracks in the editor: their audio and waveforms are fetched, the old ones' let go.
	if (next.tracks !== before.tracks) reconcileMedia(store.get().doc);
}

// A finished change: one undo step. The preview stops, and what was exported before no longer
// matches.
function commit(change: Partial<EditSnap>, more: Partial<TrackEditUi> = {}): void {
	const e = ed();
	if (!e) return;
	const snap: EditSnap = { ...snapOf(e), ...change };
	if (snap.tracks === e.tracks && snap.sections === e.sections) return;
	stopEditPreview();
	show({ ...e, ...snap, past: [...e.past, snapOf(e)].slice(-HISTORY), future: [], exported: snap.sections === e.sections ? e.exported : null, error: null, playing: false, ...more }, e);
}

const sameTrack = (a: PlannerTrack, b: PlannerTrack): boolean => a.sourcePath === b.sourcePath && a.bpm === b.bpm && a.downbeatSec === b.downbeatSec;

function openWith(tracks: PlannerTrack[], sections: EditSection[], more: Partial<TrackEditUi> = {}): void {
	stopEditPreview();
	store.set({
		editFocus: true,
		trackEdit: { tracks, sections, past: [], future: [], selection: [], cursorBeat: leadBeat(tracks[0]), bpm: tracks[0].bpm, pxPerBeat: 0, scrollX: 0, width: store.get().trackEdit?.width ?? 800, playing: false, exporting: false, exported: null, error: null, ...more },
	});
	// A track that is not in the set gets its audio (waveform and preview) all the same.
	reconcileMedia(store.get().doc);
}

// "Add to editor" on a track of the set.
export function openTrackEdit(trackId: string): void {
	const track = store.get().doc.tracks.find((t) => t.id === trackId);
	if (track) openTrackEditWith(track);
}

// Adds a track, from the set or not (a file dropped on the editor), to the editor: the whole
// of it, after everything on the lane, its bar lines on the result's. With nothing open it
// becomes the edit. One undo step, and it is selected and brought into view.
export function openTrackEditWith(track: PlannerTrack): void {
	const e = ed();
	if (!e) {
		openWith([track], wholeTrack(track, newId("e")));
		return;
	}
	store.set({ editFocus: true });
	let src = e.tracks.findIndex((t) => sameTrack(t, track));
	const tracks = src >= 0 ? e.tracks : [...e.tracks, track];
	if (src < 0) src = tracks.length - 1;
	const at = appendAt(editMain(e), e.sections, track);
	const added = wholeTrack(track, newId("e"), at, src);
	if (added.length === 0) return;
	const px = editPx(e);
	const x = at * px - e.scrollX;
	commit({ tracks, sections: [...e.sections, ...added] }, { selection: added.map((s) => s.id), cursorBeat: at, scrollX: e.pxPerBeat > 0 && (x < 0 || x > e.width - 60) ? at * px - e.width / 3 : e.scrollX });
}

// Sends the clips selected on the timeline to the editor, cut up and spaced as they are
// there, as an automatic edit: exporting it swaps the new file in for them. It takes the place
// of what the editor had open, once the user agrees. False when no clip is selected. Muted
// clips count as empty space.
export function editSelectedClips(): boolean {
	const s = store.get();
	const chosen = new Set(s.selection);
	const clips = s.doc.clips.filter((c) => chosen.has(c.id)).sort((a, b) => a.startBeat - b.startBeat);
	if (clips.length === 0) return false;
	const tracks: PlannerTrack[] = [];
	const src = new Map<string, number>();
	for (const c of clips) {
		const t = s.doc.tracks.find((x) => x.id === c.trackId);
		if (!t) return true;
		let i = tracks.findIndex((x) => sameTrack(x, t));
		if (i < 0) i = tracks.push(t) - 1;
		src.set(c.id, i);
	}
	askAuto(tracks, clipsEdit(tracks, clips, () => newId("e"), (c) => src.get(c.id) ?? 0));
	return true;
}

// "Edit automatically" (playlist mode): the track's clips, in the set's order and spacing,
// become the edit. Exporting it then swaps the new file in for them.
export function openAutoEdit(trackId: string): void {
	const s = store.get();
	const track = s.doc.tracks.find((t) => t.id === trackId);
	if (track) askAuto([track], autoEdit(s.doc, track, () => newId("e")));
}

// An automatic edit replaces what the editor has open: with something open, the user is asked
// first (see confirmEditReplace).
function askAuto(tracks: PlannerTrack[], { sections, links }: { sections: EditSection[]; links: AutoLink[] }): void {
	if (sections.length === 0) return;
	const job: EditReplace = { tracks, sections, links };
	if (store.get().trackEdit) store.set({ editReplace: job });
	else openAuto(job);
}

export function confirmEditReplace(): void {
	const job = store.get().editReplace;
	store.set({ editReplace: null });
	if (job) openAuto(job);
}

export function cancelEditReplace(): void {
	store.set({ editReplace: null });
}

function openAuto({ tracks, sections, links }: EditReplace): void {
	// The panel stays on screen, so it is not measured again: keep the width it has.
	const width = store.get().trackEdit?.width;
	if (width) closeTrackEdit();
	openWith(tracks, sections, { auto: { links }, ...(width ? { width } : {}) });
}

// After an automatic edit is exported to `file`: its clips play the new file instead. One undo step on the
// timeline, which also takes the file away again. The editor closes: its work is done.
async function swapAutoEdit(e: TrackEditUi, file: string): Promise<void> {
	const auto = e.auto;
	if (!auto) return;
	const probe = await window.api.probe(file);
	const grid = probe.rekordbox;
	const edit: PlannerTrack = { id: newId("t"), sourcePath: file, name: probe.name, bpm: grid?.bpm ?? editMain(e).bpm, durationSec: probe.durationSec, ...(grid ? { downbeatSec: grid.downbeatSec } : {}) };
	const s = store.get();
	const { doc, moved } = swapInEdit(s.doc, edit, auto.links, place(e.sections));
	if (moved.length === 0) return;
	const failed = (err: unknown): void => toast(errorText(err));
	store.commitWith(doc, { undo: () => void window.api.withdrawEdit(file).catch(failed), redo: () => void window.api.restoreEdit(file).catch(failed) });
	closeTrackEdit();
}

export function closeTrackEdit(): void {
	stopEditPreview();
	store.set({ trackEdit: null, editFocus: false });
	reconcileMedia(store.get().doc);
}

// Moves the cursor. A preview that is playing carries on from there.
export function editSetCursor(beat: number): void {
	const e = ed();
	if (!e) return;
	const at = editSnap(e, beat);
	if (at === e.cursorBeat) return;
	const playing = e.playing;
	if (playing) stopEditPreview();
	store.set({ trackEdit: settled({ ...ed()!, cursorBeat: at }) });
	if (playing) void playEditPreview();
}

// Moves the cursor one grid step left or right.
export function editStepCursor(dir: -1 | 1): void {
	const e = ed();
	if (e) editSetCursor(e.cursorBeat + dir * editStep(e));
}

export function editSelect(ids: string[]): void {
	const e = ed();
	if (e) store.set({ trackEdit: settled({ ...e, selection: ids }) });
}

export function editSelectAll(): void {
	const e = ed();
	if (e) patch({ selection: e.sections.map((s) => s.id) });
}

// Cuts at a place on the lane (the nearest grid line), and leaves the cursor there: the
// selected sections under it, or all of them when none of those is.
export function editCutAt(beat: number): void {
	const e = ed();
	if (!e) return;
	const at = editSnap(e, beat);
	const next = cutAt(e.sections, at, () => newId("e"), e.selection);
	if (next === e.sections) editSetCursor(at);
	else commit({ sections: next }, { selection: [], cursorBeat: at });
}

// Cuts at the cursor.
export function editCut(): void {
	const e = ed();
	if (e) editCutAt(e.cursorBeat);
}

// Whether a cut at the cursor would change anything.
export function editCanCut(e: TrackEditUi): boolean {
	return e.sections.some((s) => e.cursorBeat > s.atBeat + 1e-6 && e.cursorBeat < s.atBeat + s.lengthBeat - 1e-6);
}

export function editDelete(): void {
	const e = ed();
	if (!e || e.selection.length === 0) return;
	commit({ sections: removeSections(e.sections, e.selection) });
}

export function editDuplicate(): void {
	const e = ed();
	if (!e || e.selection.length === 0) return;
	const r = duplicateSections(e.sections, e.selection, () => newId("e"));
	commit({ sections: r.sections }, { selection: r.copies });
}

// Moves sections along the lane by whole grid steps.
export function editMove(ids: string[], byBeats: number): void {
	const e = ed();
	if (!e) return;
	commit({ sections: moveSections(e.sections, ids, byBeats) }, { selection: ids });
}

// Moves the selected sections one grid step later or earlier.
export function editNudge(dir: -1 | 1): void {
	const e = ed();
	if (e && e.selection.length > 0) editMove(e.selection, dir * editStep(e));
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

// Sets the tempo the editor plays at. The tracks' audio is made again at that tempo; the
// preview stops until it is ready. The export is not affected.
export function editSetBpm(bpm: number): void {
	const e = ed();
	if (!e || Math.abs(e.bpm - bpm) < 1e-9) return;
	stopEditPreview();
	patch({ bpm });
	reconcileMedia(store.get().doc);
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

// Writes the edit to the export folder: the source files' own audio, rearranged, at the first
// track's tempo and in its format.
export async function exportTrackEdit(): Promise<string | null> {
	const e = ed();
	if (!e || e.exporting) return null;
	const sections = place(e.sections).map((p) => ({ startBeat: p.section.startBeat, lengthBeat: p.lengthBeat, atBeat: p.outBeat, ...(srcOf(p.section) > 0 ? { src: srcOf(p.section) } : {}) }));
	if (sections.length === 0) {
		patch({ error: "There is nothing to export" });
		return null;
	}
	const main = editMain(e);
	const others = e.tracks.slice(1).map((t) => ({ sourcePath: t.sourcePath, bpm: t.bpm }));
	patch({ exporting: true, error: null });
	const same = (): boolean => ed()?.tracks[0] === main;
	try {
		const r = await window.api.exportEdit({ sourcePath: main.sourcePath, name: main.name, bpm: main.bpm, downbeatSec: main.downbeatSec, sections, ...(others.length ? { others } : {}) });
		// the tracks' cues go onto the new file once Rekordbox has it
		const cues = store.get().cues;
		await window.api.editCues(r.path, cuesForEdit(place(e.sections), e.tracks.map((t) => ({ bpm: t.bpm, cues: cues[t.sourcePath] ?? [] })), main.bpm)).catch((err) => toast(`The cues could not be kept: ${errorText(err)}`));
		if (e.auto && same()) {
			try {
				await swapAutoEdit(e, r.path);
			} catch (err) {
				toast(`The edit was exported but not swapped in: ${errorText(err)}`);
			}
			if (!ed()) return r.path;
		}
		// Only the edit as it was exported counts as exported.
		if (same()) patch({ exporting: false, exported: ed()!.sections === e.sections ? r.path : null });
		return r.path;
	} catch (err) {
		if (same()) patch({ exporting: false, error: `Could not export: ${errorText(err)}` });
		return null;
	}
}
