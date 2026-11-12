// Everything the user can do to a set, as plain functions over the store.

import { emptyDoc, LANES, SAMPLE_RATE, trackBeats, type Clip, type ExportClip, type PlannerDoc, type PlannerTrack, type TempoBlock } from "@shared/planner";
import { blocksToPoints } from "@shared/tempo";
import { engine } from "./engine";
import { mediaFor, workingCount } from "./media";
import { errorText, newId, store, toast } from "./store";

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

export async function importPaths(paths: string[], lane: number, beat: number | null): Promise<void> {
	let first = true;
	for (const p of paths) {
		try {
			const existing = store.get().doc.tracks.find((t) => t.sourcePath === p);
			const at = first ? beat : null;
			if (existing) {
				// Already told us this file's BPM; place it straight away.
				placeTrack(existing, lane, at);
			} else {
				const probe = await window.api.probe(p);
				store.set({ importQueue: [...store.get().importQueue, { probe, lane, beat: at }] });
			}
			first = false;
		} catch (e) {
			toast(`${p.split("/").pop()}: ${errorText(e)}`);
		}
	}
}

function placeTrack(track: PlannerTrack, lane: number, beat: number | null): void {
	const s = store.get();
	const startBeat = Math.max(0, beat ?? s.lastPlacedEnd);
	const clip: Clip = { id: newId("c"), trackId: track.id, lane: Math.min(LANES - 1, Math.max(0, lane)), startBeat, offsetBeat: 0, lengthBeat: trackBeats(track) };
	const tracks = s.doc.tracks.some((t) => t.id === track.id) ? s.doc.tracks : [...s.doc.tracks, track];
	store.commit({ ...s.doc, tracks, clips: [...s.doc.clips, clip] });
	store.set({ lastPlacedEnd: startBeat + clip.lengthBeat, selection: [clip.id] });
}

export function confirmImport(bpm: number): void {
	const [item, ...rest] = store.get().importQueue;
	if (!item) return;
	store.set({ importQueue: rest });
	const track: PlannerTrack = { id: newId("t"), sourcePath: item.probe.path, name: item.probe.name, bpm, durationSec: item.probe.durationSec };
	placeTrack(track, item.lane, item.beat);
}

export function skipImport(): void {
	store.set({ importQueue: store.get().importQueue.slice(1) });
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
		const right: Clip = { ...c, id: newId("c"), startBeat: beat, offsetBeat: c.offsetBeat + cut, lengthBeat: c.lengthBeat - cut };
		out.push({ ...c, lengthBeat: cut }, right);
		if (selection.includes(c.id)) selection.push(right.id);
	}
	if (!changed) return;
	store.commit({ ...s.doc, clips: out });
	store.set({ selection });
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
		clips: s.doc.clips.map((c) => (c.trackId === trackId ? { ...c, offsetBeat: c.offsetBeat * k, lengthBeat: c.lengthBeat * k } : c)),
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

export function zoomToFit(): void {
	const s = store.get();
	const beats = Math.max(32, contentBeats(s.doc));
	const next = Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, (s.viewportW - 40) / beats));
	store.set({ pxPerBeat: next, scrollX: 0 });
}

// ---- files --------------------------------------------------------------------------

// New and Open replace the current set. With unsaved changes they ask first.
export function requestNew(): void {
	const s = store.get();
	if (s.dirty && s.doc.clips.length > 0) store.set({ pendingDiscard: "new" });
	else newSet();
}

export function requestOpen(): void {
	const s = store.get();
	if (s.dirty && s.doc.clips.length > 0) store.set({ pendingDiscard: "open" });
	else void openSet();
}

export function newSet(): void {
	engine.stop(0);
	store.load(emptyDoc(), null, false);
}

export async function openSet(path?: string): Promise<void> {
	try {
		const r = await window.api.openProject(path);
		if (!r) return;
		engine.stop(0);
		store.load(r.doc, r.path, false);
		requestAnimationFrame(zoomToFit);
	} catch (e) {
		toast(`Could not open the set: ${errorText(e)}`);
	}
}

export async function saveSet(saveAs = false): Promise<boolean> {
	const s = store.get();
	try {
		const path = await window.api.saveProject(saveAs ? null : s.filePath, compactDoc(s.doc));
		if (!path) return false;
		// Only clear the unsaved mark if nothing changed while the dialog was open.
		store.set({ filePath: path, dirty: store.get().doc !== s.doc });
		return true;
	} catch (e) {
		toast(`Could not save: ${errorText(e)}`);
		return false;
	}
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
		clips.push({ cachePath: m.cachePath, startFrame: Math.round(c.startBeat * framesPerBeat), offsetFrame, frames });
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
	const base = (s.filePath?.split("/").pop() ?? "Untitled set").replace(/\.djset$/, "");
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
