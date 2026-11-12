// Planner state: one store, immutable updates, undo history over the document only.

import { useSyncExternalStore } from "react";
import { emptyDoc, LANES, type Cue, type ExportResult, type PlannerDoc, type PlannerTrack, type ProbeResult, type TempoPoint } from "@shared/planner";
import { pointsToBlocks } from "@shared/tempo";

// A dropped file on its way to the timeline: either waiting for its BPM to be typed
// (`probe`), or with everything known already (`track`) and only waiting its turn behind one
// that is. `beat` null means right after the file dropped before it.
export type ImportItem = { lane: number; beat: number | null } & ({ probe: ProbeResult } | { track: PlannerTrack });

export type ExportUi = { phase: "options" } | { phase: "running"; stage: string; pct: number } | { phase: "done"; result: ExportResult } | { phase: "error"; message: string };

export type MenuUi = { x: number; y: number; clipId: string } | null;

export type State = {
	doc: PlannerDoc;
	past: PlannerDoc[];
	future: PlannerDoc[];
	rev: number; // bumps on every committed document change
	cues: Record<string, Cue[]>; // Rekordbox cue points by source file; looked up, never saved
	mediaRev: number; // bumps when a stretched file becomes ready or fails
	progressRev: number; // bumps while stretch progress changes (repaint only)
	selection: string[]; // clip and tempo-block ids
	pxPerBeat: number;
	scrollX: number;
	viewportW: number;
	viewportH: number;
	playheadBeat: number;
	cueBeat: number; // where playback last started from; C jumps back here
	playing: boolean;
	laneMuted: boolean[]; // playback only; never saved with the set
	soloLane: number | null;
	preSolo: boolean[] | null; // mutes to restore when the solo is lifted
	metronome: boolean; // playback only; never saved with the set
	filePath: string | null;
	dirty: boolean;
	setGen: number; // bumps whenever a different set is loaded
	importQueue: ImportItem[];
	lastPlacedEnd: number;
	trackBpmEdit: string | null;
	pendingProjectBpm: number | null;
	pendingDiscard: "new" | "open" | null;
	exportUi: ExportUi | null;
	menu: MenuUi;
	toast: string | null;
	libraryOpen: boolean;
	loaded: boolean;
};

const HISTORY = 300;

let state: State = {
	doc: emptyDoc(),
	past: [],
	future: [],
	rev: 0,
	cues: {},
	mediaRev: 0,
	progressRev: 0,
	selection: [],
	pxPerBeat: 12,
	scrollX: 0,
	viewportW: 1000,
	viewportH: 600,
	playheadBeat: 0,
	cueBeat: 0,
	playing: false,
	laneMuted: Array.from({ length: LANES }, () => false),
	soloLane: null,
	preSolo: null,
	metronome: false,
	filePath: null,
	dirty: false,
	setGen: 0,
	importQueue: [],
	lastPlacedEnd: 0,
	trackBpmEdit: null,
	pendingProjectBpm: null,
	pendingDiscard: null,
	exportUi: null,
	menu: null,
	toast: null,
	libraryOpen: false,
	loaded: false,
};

const listeners = new Set<() => void>();
let dragBase: PlannerDoc | null = null;

function prune(s: State): State {
	const ids = new Set([...s.doc.clips.map((c) => c.id), ...s.doc.tempos.map((t) => t.id)]);
	const selection = s.selection.filter((id) => ids.has(id));
	if (selection.length === s.selection.length) return s;
	return { ...s, selection };
}

export const store = {
	get: (): State => state,
	set(patch: Partial<State>): void {
		state = { ...state, ...patch };
		for (const l of listeners) l();
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	// A finished edit: goes on the undo stack.
	commit(doc: PlannerDoc): void {
		if (doc === state.doc) return;
		store.set(prune({ ...state, doc, past: [...state.past, state.doc].slice(-HISTORY), future: [], rev: state.rev + 1, dirty: true }));
	},
	// Drags change the document many times; only the end result is one undo step.
	beginDrag(): void {
		dragBase = state.doc;
	},
	transient(doc: PlannerDoc): void {
		store.set({ doc });
	},
	endDrag(): void {
		const base = dragBase;
		dragBase = null;
		if (!base || base === state.doc) return;
		store.set(prune({ ...state, past: [...state.past, base].slice(-HISTORY), future: [], rev: state.rev + 1, dirty: true }));
	},
	cancelDrag(): void {
		if (dragBase) store.set({ doc: dragBase });
		dragBase = null;
	},
	undo(): void {
		if (dragBase || state.past.length === 0) return;
		const doc = state.past[state.past.length - 1];
		store.set(prune({ ...state, doc, past: state.past.slice(0, -1), future: [state.doc, ...state.future], rev: state.rev + 1, dirty: true }));
	},
	redo(): void {
		if (dragBase || state.future.length === 0) return;
		const doc = state.future[0];
		store.set(prune({ ...state, doc, past: [...state.past, state.doc], future: state.future.slice(1), rev: state.rev + 1, dirty: true }));
	},
	// Replace everything (new, open, session restore). Clears history.
	load(loaded: PlannerDoc, filePath: string | null, dirty: boolean): void {
		dragBase = null;
		// Project and tempo BPMs are whole numbers. Older files kept the tempo as curve points.
		const { points, ...rest } = loaded as PlannerDoc & { points?: TempoPoint[] };
		const bpm = Math.round(rest.bpm);
		const tempos = rest.tempos ?? pointsToBlocks((points ?? []).map((p) => ({ ...p, bpm: Math.round(p.bpm) })), bpm, 0.05).map((b, i) => ({ ...b, id: `b${Date.now().toString(36)}${i}` }));
		const doc: PlannerDoc = { ...rest, bpm, tempos: tempos.map((t) => ({ ...t, bpm: Math.round(t.bpm) })) };
		store.set({ doc, past: [], future: [], rev: state.rev + 1, selection: [], filePath, dirty, setGen: state.setGen + 1, playheadBeat: 0, cueBeat: 0, scrollX: 0, importQueue: [], lastPlacedEnd: 0 });
	},
};

export function useStore<T>(selector: (s: State) => T): T {
	return useSyncExternalStore(store.subscribe, () => selector(state));
}

let idCounter = 0;
export function newId(prefix: string): string {
	idCounter++;
	return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string): void {
	clearTimeout(toastTimer);
	store.set({ toast: message });
	toastTimer = setTimeout(() => store.set({ toast: null }), 6000);
}

export function errorText(e: unknown): string {
	const m = e instanceof Error ? e.message : String(e);
	return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
