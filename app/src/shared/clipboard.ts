// Copy and paste of clips and tempo changes, as JSON text on the system clipboard. The text
// carries everything needed to put the pieces back, files included, so it can be pasted
// into another set or another build of the app.

import { LANES, type Clip, type PlannerDoc, type PlannerTrack, type TempoBlock } from "./planner";

// Marks clipboard text as ours.
export const SNIPPET_FORMAT = "dj-set-planner/clips";

// `startBeat` of clips and tempos counts from the start of the earliest copied item.
// `bpm` is the project BPM of the set it was copied from, for reference.
export type Snippet = {
	format: typeof SNIPPET_FORMAT;
	version: 1;
	bpm: number;
	tracks: PlannerTrack[];
	clips: Omit<Clip, "id">[];
	tempos: Omit<TempoBlock, "id">[];
};

// What is copied for a selection of clip and tempo-block ids; null when it holds neither.
export function snippetOf(doc: PlannerDoc, selection: string[]): Snippet | null {
	const sel = new Set(selection);
	const clips = doc.clips.filter((c) => sel.has(c.id));
	const tempos = doc.tempos.filter((t) => sel.has(t.id));
	if (clips.length + tempos.length === 0) return null;
	const origin = Math.min(...clips.map((c) => c.startBeat), ...tempos.map((t) => t.startBeat));
	const used = new Set(clips.map((c) => c.trackId));
	return {
		format: SNIPPET_FORMAT,
		version: 1,
		bpm: doc.bpm,
		tracks: doc.tracks.filter((t) => used.has(t.id)),
		clips: clips.map(({ id: _id, ...c }) => ({ ...c, startBeat: c.startBeat - origin })),
		tempos: tempos.map(({ id: _id, ...t }) => ({ ...t, startBeat: t.startBeat - origin })),
	};
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Reads clipboard text; null unless it is a whole, valid snippet of ours.
export function parseSnippet(text: string): Snippet | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!obj(raw) || raw.format !== SNIPPET_FORMAT || raw.version !== 1) return null;
	if (!Array.isArray(raw.tracks) || !Array.isArray(raw.clips) || !Array.isArray(raw.tempos)) return null;
	const tracks: PlannerTrack[] = [];
	for (const t of raw.tracks as unknown[]) {
		if (!obj(t) || typeof t.id !== "string" || typeof t.sourcePath !== "string" || !t.sourcePath || typeof t.name !== "string") return null;
		if (!num(t.bpm) || t.bpm <= 0 || !num(t.durationSec) || t.durationSec <= 0) return null;
		const track: PlannerTrack = { id: t.id, sourcePath: t.sourcePath, name: t.name, bpm: t.bpm, durationSec: t.durationSec };
		if (num(t.downbeatSec)) track.downbeatSec = t.downbeatSec;
		tracks.push(track);
	}
	const ids = new Set(tracks.map((t) => t.id));
	const clips: Omit<Clip, "id">[] = [];
	for (const c of raw.clips as unknown[]) {
		if (!obj(c) || typeof c.trackId !== "string" || !ids.has(c.trackId)) return null;
		if (!num(c.startBeat) || c.startBeat < 0 || !num(c.offsetBeat) || !num(c.lengthBeat) || c.lengthBeat <= 0) return null;
		const clip: Omit<Clip, "id"> = { trackId: c.trackId, lane: num(c.lane) ? Math.min(LANES - 1, Math.max(0, Math.round(c.lane))) : 0, startBeat: c.startBeat, offsetBeat: c.offsetBeat, lengthBeat: c.lengthBeat };
		if (num(c.gain)) clip.gain = c.gain;
		if (num(c.fadeInBeat) && c.fadeInBeat > 0) clip.fadeInBeat = c.fadeInBeat;
		if (num(c.fadeOutBeat) && c.fadeOutBeat > 0) clip.fadeOutBeat = c.fadeOutBeat;
		if (c.muted === true) clip.muted = true;
		if (c.lowCut === true) clip.lowCut = true;
		clips.push(clip);
	}
	const tempos: Omit<TempoBlock, "id">[] = [];
	for (const t of raw.tempos as unknown[]) {
		if (!obj(t) || !num(t.startBeat) || t.startBeat < 0 || !num(t.lengthBeat) || t.lengthBeat <= 0 || !num(t.bpm) || t.bpm < 20 || t.bpm > 400) return null;
		const block: Omit<TempoBlock, "id"> = { startBeat: t.startBeat, lengthBeat: t.lengthBeat, bpm: Math.round(t.bpm) };
		if (t.off === true) block.off = true;
		tempos.push(block);
	}
	if (clips.length + tempos.length === 0) return null;
	const used = new Set(clips.map((c) => c.trackId));
	return { format: SNIPPET_FORMAT, version: 1, bpm: num(raw.bpm) ? raw.bpm : 0, tracks: tracks.filter((t) => used.has(t.id)), clips, tempos };
}

// Puts a snippet into a set with its earliest item at `atBeat`, spaced as it was copied.
// Clips keep their lanes and go on top of whatever is there. The pasted tempo changes win:
// tempo changes of the set that start anywhere from the first pasted one's start to the
// last pasted one's end are taken out. `ids` are the new clips and tempo changes.
export function pasteSnippet(doc: PlannerDoc, snip: Snippet, atBeat: number, newId: (prefix: string) => string): { doc: PlannerDoc; ids: string[] } {
	const at = Math.max(0, atBeat);
	const tracks = [...doc.tracks];
	const trackIds = new Map<string, string>();
	for (const t of snip.tracks) {
		// The same file with the same grid is the same track.
		const have = tracks.find((k) => k.sourcePath === t.sourcePath && k.bpm === t.bpm && k.downbeatSec === t.downbeatSec);
		const id = have?.id ?? newId("t");
		if (!have) tracks.push({ ...t, id });
		trackIds.set(t.id, id);
	}
	const clips: Clip[] = snip.clips.map((c) => ({ ...c, id: newId("c"), trackId: trackIds.get(c.trackId) ?? c.trackId, startBeat: at + c.startBeat }));
	const tempos: TempoBlock[] = snip.tempos.map((t) => ({ ...t, id: newId("b"), startBeat: at + t.startBeat }));
	let kept = doc.tempos;
	if (tempos.length > 0) {
		const from = Math.min(...tempos.map((t) => t.startBeat)) - 1e-9;
		const to = Math.max(...tempos.map((t) => t.startBeat + t.lengthBeat)) - 1e-9;
		kept = doc.tempos.filter((t) => t.startBeat < from || t.startBeat >= to);
	}
	return { doc: { ...doc, tracks, clips: [...doc.clips, ...clips], tempos: [...kept, ...tempos] }, ids: [...clips, ...tempos].map((x) => x.id) };
}
