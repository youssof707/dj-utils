// Everything the user can do to a set, as plain functions over the store.

import { emptyDoc, firstBarBeat, LANES, SAMPLE_RATE, trackBeats, type Clip, type ExportClip, type PlannerDoc, type PlannerTrack, type SetView, type TempoBlock } from "@shared/planner";
import { fitFades } from "@shared/fades";
import { parseSnippet, pasteSnippet, snippetOf } from "@shared/clipboard";
import { blocksToPoints } from "@shared/tempo";
import { stopEditPreview } from "./editPlayer";
import { openTrackEditWith } from "./trackEdit";
import { engine } from "./engine";
import { forgetMedia, mediaFor, workingCount } from "./media";
import { errorText, newId, store, toast, type ImportItem, type State } from "./store";

export const MIN_CLIP_BEATS = 0.05;
export const MIN_PX_PER_BEAT = 0.05;
export const MAX_PX_PER_BEAT = 400;

export function validBpm(v: number): boolean {
	return Number.isFinite(v) && v >= 20 && v <= 400;
}

export function parseBpm(text: string): number | null {
	const v = Number(text.trim().replace(",", "."));
	return validBpm(v) ? Math.round(v * 1000) / 1000 : null;
}

// Project and tempo-point BPMs are whole numbers.
export function parseWholeBpm(text: string): number | null {
	const v = Number(text.trim().replace(",", "."));
	return validBpm(v) ? Math.round(v) : null;
}

export function contentBeats(doc: PlannerDoc): number {
	let end = 0;
	for (const c of doc.clips) end = Math.max(end, c.startBeat + c.lengthBeat);
	for (const t of doc.tempos) end = Math.max(end, t.startBeat + t.lengthBeat);
	return end;
}

// ---- import -------------------------------------------------------------------------

// Tracks Rekordbox has analysed come with their BPM and bar line and go straight onto the
// timeline; anything else asks for its BPM first.
export async function importPaths(paths: string[], lane: number, beat: number | null): Promise<void> {
	let first = true;
	for (const p of paths) {
		try {
			const at = first ? beat : null;
			if (store.get().doc.tracks.some((t) => t.sourcePath === p)) {
				// Already in the set. Rekordbox still has the last word on the grid, so a grid
				// corrected there since is picked up; clips already placed are left alone.
				const grid = await window.api.rekordbox(p);
				const known = store.get().doc.tracks.filter((t) => t.sourcePath === p);
				if (known.length === 0) continue; // the set was replaced while we looked
				const sameBpm = grid ? known.find((t) => Math.abs(t.bpm - grid.bpm) < 1e-6) : undefined;
				let track: PlannerTrack;
				if (!grid) track = known.find((t) => t.downbeatSec !== undefined) ?? known[0];
				else if (sameBpm) track = sameBpm.downbeatSec === grid.downbeatSec ? sameBpm : { ...sameBpm, downbeatSec: grid.downbeatSec };
				else track = { ...known[0], id: newId("t"), bpm: grid.bpm, downbeatSec: grid.downbeatSec };
				enqueue({ track, lane, beat: at });
			} else {
				const probe = await window.api.probe(p);
				const grid = probe.rekordbox;
				if (grid) enqueue({ track: { id: newId("t"), sourcePath: probe.path, name: probe.name, bpm: grid.bpm, durationSec: probe.durationSec, downbeatSec: grid.downbeatSec }, lane, beat: at });
				else enqueue({ probe, lane, beat: at });
			}
			first = false;
		} catch (e) {
			toast(`${p.split("/").pop()}: ${errorText(e)}`);
		}
	}
}

// Opens an audio file in the track editor without adding it to the set. Its grid comes from
// the set if it is in it already, then from Rekordbox or an exported edit's own tag; only a
// file with none of those asks for its BPM.
export async function openFileInEditor(p: string): Promise<void> {
	try {
		const known = store.get().doc.tracks.filter((t) => t.sourcePath === p);
		if (known.length > 0) {
			openTrackEditWith(known.find((t) => t.downbeatSec !== undefined) ?? known[0]);
			return;
		}
		const probe = await window.api.probe(p);
		const grid = probe.rekordbox;
		if (grid) openTrackEditWith({ id: newId("t"), sourcePath: probe.path, name: probe.name, bpm: grid.bpm, durationSec: probe.durationSec, downbeatSec: grid.downbeatSec });
		else enqueue({ probe, lane: 0, beat: null, edit: true });
	} catch (e) {
		toast(`${p.split("/").pop()}: ${errorText(e)}`);
	}
}

// Files land in the order they were dropped: one that is waiting for its BPM holds back
// the ones behind it, which then follow on from where it ends up.
function enqueue(item: ImportItem): void {
	store.set({ importQueue: [...store.get().importQueue, item] });
	placeReady();
}

function placeReady(): void {
	for (;;) {
		const [head, ...rest] = store.get().importQueue;
		if (!head || !("track" in head)) return;
		store.set({ importQueue: rest });
		if (head.edit) openTrackEditWith(head.track);
		else placeTrack(head.track, head.lane, head.beat);
	}
}

function placeTrack(track: PlannerTrack, lane: number, beat: number | null): void {
	const s = store.get();
	const total = trackBeats(track);
	let startBeat = Math.max(0, beat ?? s.lastPlacedEnd);
	let offsetBeat = 0;
	const bar = firstBarBeat(track);
	if (bar !== null) {
		// The track's first bar line goes on the drop point, so the clip starts there and the
		// lead-in before it stays hidden behind the clip's left edge. Queued up behind another
		// clip, the drop point is the next bar line.
		if (beat === null) startBeat = Math.ceil(startBeat / 4 - 1e-6) * 4;
		if (bar < 0) startBeat -= bar; // the bar line is a hair before the first sample
		else if (bar < total - MIN_CLIP_BEATS) offsetBeat = bar;
	}
	const clip: Clip = { id: newId("c"), trackId: track.id, lane: Math.min(LANES - 1, Math.max(0, lane)), startBeat, offsetBeat, lengthBeat: total - offsetBeat };
	const tracks = s.doc.tracks.some((t) => t.id === track.id) ? s.doc.tracks.map((t) => (t.id === track.id ? track : t)) : [...s.doc.tracks, track];
	store.commit({ ...s.doc, tracks, clips: [...s.doc.clips, clip] });
	store.set({ lastPlacedEnd: startBeat + clip.lengthBeat, selection: [clip.id] });
}

export function confirmImport(bpm: number): void {
	const [item, ...rest] = store.get().importQueue;
	if (!item || !("probe" in item)) return;
	store.set({ importQueue: rest });
	const track: PlannerTrack = { id: newId("t"), sourcePath: item.probe.path, name: item.probe.name, bpm, durationSec: item.probe.durationSec };
	if (item.edit) openTrackEditWith(track);
	else placeTrack(track, item.lane, item.beat);
	placeReady();
}

export function skipImport(): void {
	const [item, next, ...rest] = store.get().importQueue;
	if (!item) return;
	// The file after a skipped one takes over its place.
	store.set({ importQueue: next ? [next.beat === null ? { ...next, beat: item.beat } : next, ...rest] : [] });
	placeReady();
}

// ---- Rekordbox cue points -------------------------------------------------------------

const cuesAsked = new Set<string>();
let cueWork: Promise<void> = Promise.resolve();

// The files whose cue points are shown: the set's tracks and the one open in the track editor.
function cuePaths(): Set<string> {
	const s = store.get();
	const paths = new Set(s.doc.tracks.map((t) => t.sourcePath));
	if (s.trackEdit) paths.add(s.trackEdit.track.sourcePath);
	if (s.trackEdit?.second) paths.add(s.trackEdit.second.sourcePath);
	return paths;
}

// Looks up the cue points of the set's tracks, one file at a time: files not asked about
// yet, or every file when `again` (Rekordbox may have been used since).
export function refreshCues(again: boolean): void {
	const paths = [...cuePaths()].filter((p) => again || !cuesAsked.has(p));
	for (const p of paths) {
		cuesAsked.add(p);
		cueWork = cueWork.then(async () => {
			if (!cuePaths().has(p)) {
				cuesAsked.delete(p); // no longer in the set
				return;
			}
			try {
				const { cues, canEdit } = await window.api.cues(p);
				const s = store.get();
				if (JSON.stringify(s.cues[p] ?? []) !== JSON.stringify(cues) || (s.cueEdit[p] ?? false) !== canEdit) store.set({ cues: { ...s.cues, [p]: cues }, cueEdit: { ...s.cueEdit, [p]: canEdit } });
			} catch {
				cuesAsked.delete(p); // asked again next time round
			}
		});
	}
}

// Keeps cue points current: new tracks are looked up as they arrive, and all of them again
// whenever the window comes back to the front.
export function watchCues(): void {
	let tracks = store.get().doc.tracks;
	let edited = store.get().trackEdit?.track;
	let second = store.get().trackEdit?.second;
	store.subscribe(() => {
		const now = store.get().doc.tracks;
		const open = store.get().trackEdit?.track;
		const other = store.get().trackEdit?.second;
		if (now === tracks && open === edited && other === second) return;
		tracks = now;
		edited = open;
		second = other;
		refreshCues(false);
	});
	window.addEventListener("focus", () => refreshCues(true));
	refreshCues(false);
}

export async function importViaDialog(): Promise<void> {
	const paths = await window.api.chooseAudio();
	if (paths.length === 0) return;
	const s = store.get();
	const lane = s.selection.length ? (s.doc.clips.find((c) => c.id === s.selection[0])?.lane ?? 0) : 0;
	await importPaths(paths, lane, s.playheadBeat);
}

// ---- clip edits ---------------------------------------------------------------------

export function deleteSelection(): void {
	const s = store.get();
	if (s.selection.length === 0) return;
	const sel = new Set(s.selection);
	store.commit({ ...s.doc, clips: s.doc.clips.filter((c) => !sel.has(c.id)), tempos: s.doc.tempos.filter((t) => !sel.has(t.id)) });
}

// Tracks stay in the document after their last clip is deleted so undo can bring the
// clip back; they are left out of saved files when nothing uses them.

export function compactDoc(doc: PlannerDoc): PlannerDoc {
	const used = new Set(doc.clips.map((c) => c.trackId));
	return { ...doc, tracks: doc.tracks.filter((t) => used.has(t.id)) };
}

// The point in a track that "Align to grid" puts on a bar line, in the track's own beats:
// its first Rekordbox bar line, or without a grid its first cue or memory cue.
export function alignPoint(track: PlannerTrack): number | null {
	const bar = firstBarBeat(track);
	if (bar !== null) return bar;
	const cues = store.get().cues[track.sourcePath];
	if (!cues?.length) return null;
	return (Math.min(...cues.map((c) => c.sec)) * track.bpm) / 60;
}

// Moves each selected clip so its alignment point (see alignPoint) sits on the nearest bar
// line of the set's grid.
export function alignSelectionToGrid(): void {
	const s = store.get();
	const sel = new Set(s.selection);
	let changed = false;
	const clips = s.doc.clips.map((c) => {
		if (!sel.has(c.id)) return c;
		const track = s.doc.tracks.find((t) => t.id === c.trackId);
		const bar = track ? alignPoint(track) : null;
		if (bar === null) return c;
		const anchor = c.startBeat - c.offsetBeat + bar;
		let target = Math.round(anchor / 4) * 4;
		const shift = (t: number): number => t - anchor;
		if (c.startBeat + shift(target) < -1e-9) target = Math.ceil((anchor - c.startBeat) / 4 - 1e-9) * 4;
		const d = shift(target);
		if (Math.abs(d) < 1e-9) return c;
		changed = true;
		return { ...c, startBeat: c.startBeat + d };
	});
	if (changed) store.commit({ ...s.doc, clips });
}

// Below this zoom the beat lines are hidden, so moves go by whole bars.
export const BEAT_GRID_MIN_PX = 9;

// The step that moves snap to at the current zoom: a beat, or a bar when zoomed out.
export function gridStepBeats(): number {
	return store.get().pxPerBeat < BEAT_GRID_MIN_PX ? 4 : 1;
}

// Arrow keys: moves the selected clips and tempo changes one step left or right. A move that
// would push anything before the start of the set does nothing.
export function nudgeSelection(dir: -1 | 1): void {
	const s = store.get();
	const sel = new Set(s.selection);
	const clips = s.doc.clips.filter((c) => sel.has(c.id));
	const tempos = s.doc.tempos.filter((t) => sel.has(t.id));
	if (clips.length + tempos.length === 0) return;
	const d = dir * gridStepBeats();
	const minStart = Math.min(...clips.map((c) => c.startBeat), ...tempos.map((t) => t.startBeat));
	if (minStart + d < -1e-9) return;
	store.commit({
		...s.doc,
		clips: s.doc.clips.map((c) => (sel.has(c.id) ? { ...c, startBeat: c.startBeat + d } : c)),
		tempos: s.doc.tempos.map((t) => (sel.has(t.id) ? { ...t, startBeat: t.startBeat + d } : t)),
	});
}

export function duplicateSelection(): void {
	const s = store.get();
	const sel = s.doc.clips.filter((c) => s.selection.includes(c.id));
	const selT = s.doc.tempos.filter((t) => s.selection.includes(t.id));
	const all = [...sel, ...selT];
	if (all.length === 0) return;
	// Copies land right after the selection, keeping its internal spacing.
	const start = Math.min(...all.map((c) => c.startBeat));
	const end = Math.max(...all.map((c) => c.startBeat + c.lengthBeat));
	const copies = sel.map((c) => ({ ...c, id: newId("c"), startBeat: c.startBeat + (end - start) }));
	const copiesT = selT.map((t) => ({ ...t, id: newId("b"), startBeat: t.startBeat + (end - start) }));
	store.commit({ ...s.doc, clips: [...s.doc.clips, ...copies], tempos: [...s.doc.tempos, ...copiesT] });
	store.set({ selection: [...copies, ...copiesT].map((c) => c.id) });
}

// The selected clips and tempo changes as clipboard text; null with nothing selected.
export function copySelection(): string | null {
	const s = store.get();
	const snip = snippetOf(s.doc, s.selection);
	return snip ? JSON.stringify(snip) : null;
}

// Pastes clipboard text at the playhead when it is a copy made by this app (see
// @shared/clipboard), and selects what was pasted. False for any other text.
export function pasteText(text: string): boolean {
	const snip = parseSnippet(text);
	if (!snip) return false;
	const at = engine.positionBeat();
	const r = pasteSnippet(store.get().doc, snip, at, newId);
	store.commit(r.doc);
	store.set({ selection: r.ids });
	// The paste is brought into view when the playhead is off screen.
	const s = store.get();
	const x = at * s.pxPerBeat - s.scrollX;
	if (x < 0 || x > s.viewportW - 80) store.set({ scrollX: clampScroll(at * s.pxPerBeat - s.viewportW / 4, s.pxPerBeat) });
	return true;
}

export function splitAt(beat: number, onlyIds?: string[]): void {
	const s = store.get();
	const pool = onlyIds && onlyIds.length ? new Set(onlyIds) : null;
	const out: Clip[] = [];
	const selection = [...s.selection];
	let changed = false;
	for (const c of s.doc.clips) {
		const cut = beat - c.startBeat;
		if ((pool && !pool.has(c.id)) || cut < MIN_CLIP_BEATS || c.lengthBeat - cut < MIN_CLIP_BEATS) {
			out.push(c);
			continue;
		}
		changed = true;
		// The fade-in stays on the left half and the fade-out on the right half.
		const right = fitFades({ ...c, id: newId("c"), startBeat: beat, offsetBeat: c.offsetBeat + cut, lengthBeat: c.lengthBeat - cut, fadeInBeat: 0 });
		out.push(fitFades({ ...c, lengthBeat: cut, fadeOutBeat: 0 }), right);
		if (selection.includes(c.id)) selection.push(right.id);
	}
	if (!changed) return;
	store.commit({ ...s.doc, clips: out });
	store.set({ selection });
}

// "Mute clip" (`muted`) and "Mute bass" (`lowCut`) for a group of clips: when every one of
// them already has it, it comes off all of them; otherwise all of them get it.
export type ClipFlag = "muted" | "lowCut";

export function flagAllOn(ids: string[], key: ClipFlag): boolean {
	const set = new Set(ids);
	const group = store.get().doc.clips.filter((c) => set.has(c.id));
	return group.length > 0 && group.every((c) => c[key]);
}

export function toggleClipsFlag(clipIds: string[], key: ClipFlag): void {
	const s = store.get();
	const ids = new Set(clipIds);
	if (!s.doc.clips.some((c) => ids.has(c.id))) return;
	const on = !flagAllOn(clipIds, key);
	store.commit({
		...s.doc,
		clips: s.doc.clips.map((c) => {
			if (!ids.has(c.id)) return c;
			const next: Clip = { ...c };
			if (on) next[key] = true;
			else delete next[key];
			return next;
		}),
	});
}

// The clips a menu or shortcut acts on: the selection when `clipId` is part of it (or when no
// clip is given), else that one clip.
export function flagTargets(clipId?: string): string[] {
	const s = store.get();
	if (clipId && !s.selection.includes(clipId)) return [clipId];
	const ids = new Set(s.doc.clips.map((c) => c.id));
	return s.selection.filter((id) => ids.has(id));
}

export function splitAtPlayhead(): void {
	const s = store.get();
	const beat = engine.positionBeat();
	const under = (c: Clip): boolean => beat > c.startBeat && beat < c.startBeat + c.lengthBeat;
	const selected = s.doc.clips.filter((c) => s.selection.includes(c.id) && under(c));
	splitAt(beat, selected.length ? selected.map((c) => c.id) : undefined);
}

export function selectAll(): void {
	const doc = store.get().doc;
	store.set({ selection: [...doc.clips.map((c) => c.id), ...doc.tempos.map((t) => t.id)] });
}

// Correcting a track's BPM keeps each clip on the same stretch of audio and at the same
// place on the timeline; only its length in beats changes.
export function setTrackBpm(trackId: string, bpm: number): void {
	const s = store.get();
	const track = s.doc.tracks.find((t) => t.id === trackId);
	if (!track || track.bpm === bpm) return;
	const k = bpm / track.bpm;
	store.commit({
		...s.doc,
		tracks: s.doc.tracks.map((t) => (t.id === trackId ? { ...t, bpm } : t)),
		clips: s.doc.clips.map((c) => (c.trackId === trackId ? fitFades({ ...c, offsetBeat: c.offsetBeat * k, lengthBeat: c.lengthBeat * k, fadeInBeat: (c.fadeInBeat ?? 0) * k, fadeOutBeat: (c.fadeOutBeat ?? 0) * k }) : c)),
	});
}

export function setProjectBpm(raw: number): void {
	const bpm = Math.round(raw);
	const s = store.get();
	if (bpm === s.doc.bpm) return;
	// The playhead is kept in beats, so it stays on the same spot of the arrangement.
	store.commit({ ...s.doc, bpm });
}

export function requestProjectBpm(raw: number): void {
	const bpm = Math.round(raw);
	const s = store.get();
	if (bpm === s.doc.bpm) return;
	if (s.doc.clips.length === 0) setProjectBpm(bpm);
	else store.set({ pendingProjectBpm: bpm });
}

export async function relocateTrack(trackId: string): Promise<void> {
	const paths = await window.api.chooseAudio();
	if (!paths[0]) return;
	const s = store.get();
	try {
		const probe = await window.api.probe(paths[0]);
		store.commit({ ...s.doc, tracks: s.doc.tracks.map((t) => (t.id === trackId ? { ...t, sourcePath: probe.path, durationSec: probe.durationSec } : t)) });
	} catch (e) {
		toast(errorText(e));
	}
}

// ---- tempo changes ------------------------------------------------------------------

export const NEW_TEMPO_BEATS = 4;

export function tempoPoints(doc: PlannerDoc): { beat: number; bpm: number }[] {
	return blocksToPoints(doc.tempos, doc.bpm);
}

export function addTempo(startBeat: number, lengthBeat: number, bpm: number): string {
	const s = store.get();
	const block: TempoBlock = { id: newId("b"), startBeat: Math.max(0, startBeat), lengthBeat: Math.max(MIN_CLIP_BEATS, lengthBeat), bpm: Math.round(bpm) };
	store.commit({ ...s.doc, tempos: [...s.doc.tempos, block] });
	store.set({ selection: [block.id] });
	return block.id;
}

// Switches a tempo change off (it stays on the lane but changes nothing) or back on.
export function toggleTempo(id: string): void {
	const s = store.get();
	store.commit({ ...s.doc, tempos: s.doc.tempos.map((t) => (t.id !== id ? t : t.off ? { id: t.id, startBeat: t.startBeat, lengthBeat: t.lengthBeat, bpm: t.bpm } : { ...t, off: true })) });
}

export function setTempoBpm(id: string, raw: number): void {
	const s = store.get();
	const bpm = Math.round(raw);
	const cur = s.doc.tempos.find((t) => t.id === id);
	if (!cur || cur.bpm === bpm) return;
	store.commit({ ...s.doc, tempos: s.doc.tempos.map((t) => (t.id === id ? { ...t, bpm } : t)) });
}

// ---- view ---------------------------------------------------------------------------

export function clampScroll(scrollX: number, pxPerBeat: number): number {
	const s = store.get();
	const max = Math.max(0, (contentBeats(s.doc) + 64) * pxPerBeat - s.viewportW * 0.5);
	return Math.min(Math.max(0, scrollX), max);
}

export function zoomAround(factor: number, anchorPx?: number): void {
	const s = store.get();
	const anchor = anchorPx ?? s.viewportW / 2;
	const next = Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, s.pxPerBeat * factor));
	const beat = (s.scrollX + anchor) / s.pxPerBeat;
	store.set({ pxPerBeat: next, scrollX: clampScroll(beat * next - anchor, next) });
}

// A plain click toggles one lane's mute and ends any solo. ⌘-click solos the lane;
// ⌘-click on the soloed lane again brings back the mutes from before the solo.
export function toggleMute(lane: number): void {
	const s = store.get();
	const laneMuted = s.laneMuted.map((m, i) => (i === lane ? !m : m));
	store.set({ laneMuted, soloLane: null, preSolo: null });
	engine.applyMutes();
}

export function toggleSolo(lane: number): void {
	const s = store.get();
	if (s.soloLane === lane) {
		store.set({ laneMuted: s.preSolo ?? s.laneMuted.map(() => false), soloLane: null, preSolo: null });
	} else {
		store.set({ laneMuted: s.laneMuted.map((_, i) => i !== lane), soloLane: lane, preSolo: s.preSolo ?? s.laneMuted });
	}
	engine.applyMutes();
}

export function toggleMetronome(): void {
	store.set({ metronome: !store.get().metronome });
	engine.applyMetronome();
}

export function zoomToFit(): void {
	const s = store.get();
	const beats = Math.max(32, contentBeats(s.doc));
	const next = Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, (s.viewportW - 40) / beats));
	store.set({ pxPerBeat: next, scrollX: 0 });
}

// ---- sets ---------------------------------------------------------------------------
// The app keeps every set itself. A set is written shortly after every change, and there
// is nothing to save, name a file for, or pick a folder for.

function viewOf(s: State): SetView {
	return { pxPerBeat: s.pxPerBeat, scrollX: s.scrollX, playheadBeat: s.playing ? engine.positionBeat() : s.playheadBeat };
}

// What is stored for the open set, to tell when there is something new to write.
let stored = { gen: -1, text: "" };

// What to write for the open set now, or null when what is stored is already up to date. A
// new set is first stored once there is something in it.
function unsaved(s: State): { id: string; name: string | null; view: SetView; doc: PlannerDoc; text: string } | null {
	if (!s.loaded || s.screen !== "editor" || !s.setId) return null;
	const doc = compactDoc(s.doc);
	if (stored.gen !== s.setGen && s.setName === null && doc.clips.length === 0 && doc.tempos.length === 0) return null;
	const view = viewOf(s);
	const text = JSON.stringify([s.setName, view, doc]);
	if (stored.gen === s.setGen && stored.text === text) return null;
	return { id: s.setId, name: s.setName, view, doc, text };
}

// Saves never overlap; a change made during a save is picked up by another pass.
let autoSaving: Promise<void> | null = null;
let autoSaveAgain = false;
let autoSaveFailed = false;

export function autoSave(): Promise<void> {
	if (autoSaving) {
		autoSaveAgain = true;
		return autoSaving;
	}
	autoSaving = (async () => {
		do {
			autoSaveAgain = false;
			const s = store.get();
			const u = unsaved(s);
			if (!u) continue;
			try {
				const name = await window.api.saveSet(u.id, u.name, u.view, u.doc);
				autoSaveFailed = false;
				const cur = store.get();
				if (cur.setGen !== s.setGen) continue; // a different set was opened meanwhile
				stored = { gen: s.setGen, text: JSON.stringify([name, u.view, u.doc]) };
				// The name as stored: a new set is named then, and a name already taken is told apart.
				if (cur.setName === s.setName && name !== cur.setName) store.set({ setName: name });
			} catch (e) {
				if (!autoSaveFailed) toast(`Could not save the set: ${errorText(e)}`);
				autoSaveFailed = true;
			}
		} while (autoSaveAgain);
	})().finally(() => {
		autoSaving = null;
	});
	return autoSaving;
}

export async function flushAutoSave(): Promise<void> {
	await autoSave();
	if (unsaved(store.get())) await autoSave();
}

// As the window closes: whatever has not been written yet is, before it goes.
export function saveBeforeClose(): void {
	const u = unsaved(store.get());
	if (!u) return;
	try {
		window.api.saveSetNow(u.id, u.name, u.view, u.doc);
	} catch {
		// nothing more can be done as the window goes
	}
}

export async function refreshSets(): Promise<void> {
	try {
		store.set({ sets: await window.api.listSets() });
	} catch (e) {
		toast(`Could not read your sets: ${errorText(e)}`);
	}
}

// Lets go of the set that is open: its sound, its audio in memory, its waveforms.
function closeSet(): void {
	stopEditPreview();
	engine.stop(0);
	engine.forget();
	forgetMedia();
}

// `askName`: the top bar opens on the name, ready to type (the New set button and Cmd+N).
// `bpm`: the tempo to start at instead of the default.
export async function newSet(opts?: { askName?: boolean; bpm?: number }): Promise<void> {
	await flushAutoSave();
	closeSet();
	store.load(emptyDoc(opts?.bpm), newId("s"), null);
	store.set({ screen: "editor", pxPerBeat: 12, askName: !!opts?.askName });
}

export async function openSet(id: string): Promise<void> {
	try {
		await flushAutoSave();
		const f = await window.api.openSet(id);
		closeSet();
		store.load(f.doc, f.id, f.name);
		stored = { gen: store.get().setGen, text: "" };
		store.set({ screen: "editor", pxPerBeat: f.view.pxPerBeat, scrollX: f.view.scrollX, playheadBeat: f.view.playheadBeat, cueBeat: f.view.playheadBeat });
	} catch (e) {
		toast(`Could not open the set: ${errorText(e)}`);
		void refreshSets();
	}
}

// Back to the list of sets.
export async function goHome(): Promise<void> {
	if (store.get().screen !== "editor") {
		store.set({ screen: "home" });
		return;
	}
	engine.stop();
	await flushAutoSave();
	closeSet();
	store.load(emptyDoc(), null, null);
	store.set({ screen: "home", libraryOpen: false });
	await refreshSets();
}

export async function renameSet(id: string, name: string): Promise<void> {
	const next = name.trim();
	if (!next) return;
	if (id === store.get().setId) {
		store.set({ setName: next }); // stored with the next save
		return;
	}
	try {
		await window.api.renameSet(id, next);
	} catch (e) {
		toast(`Could not rename the set: ${errorText(e)}`);
	}
	await refreshSets();
}

export async function duplicateSet(id: string): Promise<void> {
	try {
		await window.api.duplicateSet(id);
	} catch (e) {
		toast(`Could not duplicate the set: ${errorText(e)}`);
	}
	await refreshSets();
}

export async function deleteSet(id: string): Promise<void> {
	try {
		await window.api.deleteSet(id);
	} catch (e) {
		toast(`Could not delete the set: ${errorText(e)}`);
	}
	await refreshSets();
}

// ---- export -------------------------------------------------------------------------

export function openExport(): void {
	const s = store.get();
	if (s.exportUi?.phase === "running") return;
	if (s.doc.clips.length === 0) {
		toast("There is nothing on the timeline to export");
		return;
	}
	store.set({ exportUi: { phase: "options" } });
}

export function exportClips(doc: PlannerDoc): { clips: ExportClip[]; notReady: number; failed: number } {
	const framesPerBeat = (60 / doc.bpm) * SAMPLE_RATE;
	const tracks = new Map(doc.tracks.map((t) => [t.id, t]));
	const clips: ExportClip[] = [];
	let notReady = 0;
	let failed = 0;
	for (const c of doc.clips) {
		if (c.muted) continue;
		const m = mediaFor(tracks.get(c.trackId), doc.bpm);
		if (!m || m.state === "working") {
			notReady++;
			continue;
		}
		if (m.state === "error") {
			failed++;
			continue;
		}
		const offsetFrame = Math.round(c.offsetBeat * framesPerBeat);
		const frames = Math.min(Math.round(c.lengthBeat * framesPerBeat), m.frames - offsetFrame);
		if (frames <= 0) continue;
		const fadeInFrames = Math.min(frames, Math.round((c.fadeInBeat ?? 0) * framesPerBeat));
		const fadeOutFrames = Math.min(frames - fadeInFrames, Math.round((c.fadeOutBeat ?? 0) * framesPerBeat));
		clips.push({ cachePath: m.cachePath, startFrame: Math.round(c.startBeat * framesPerBeat), offsetFrame, frames, ...(fadeInFrames > 0 && { fadeInFrames }), ...(fadeOutFrames > 0 && { fadeOutFrames }), ...(c.lowCut && { lowCut: true }) });
	}
	return { clips, notReady, failed };
}

export async function runExport(keyLock: boolean, outPath?: string): Promise<void> {
	const s = store.get();
	const doc = s.doc;
	if (workingCount(doc) > 0) {
		store.set({ exportUi: { phase: "error", message: "Some tracks are still being stretched. Export once they are done." } });
		return;
	}
	const { clips, failed } = exportClips(doc);
	if (failed > 0) {
		store.set({ exportUi: { phase: "error", message: `${failed} clip${failed === 1 ? "" : "s"} could not be loaded (shown in red). Fix or delete them, then export.` } });
		return;
	}
	if (clips.length === 0) {
		store.set({ exportUi: { phase: "error", message: "Every clip is muted, so there is nothing to export." } });
		return;
	}
	const base = (s.setName ?? "Untitled set").replace(/[/:]/g, "-");
	const target = outPath ?? (await window.api.chooseExport(`${base}.wav`));
	if (!target) return;
	store.set({ exportUi: { phase: "running", stage: "Mixing", pct: 0 } });
	try {
		const result = await window.api.exportSet({ outPath: target, projectBpm: doc.bpm, clips, points: tempoPoints(doc), keyLock });
		store.set({ exportUi: { phase: "done", result } });
	} catch (e) {
		// A cancelled export just closes; its unfinished file is never written to the target.
		if (errorText(e) === "cancelled") store.set({ exportUi: null });
		else store.set({ exportUi: { phase: "error", message: errorText(e) } });
	}
}

export function cancelExport(): void {
	void window.api.cancelExport();
}
