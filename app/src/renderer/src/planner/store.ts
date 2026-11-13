// Planner state: one store, immutable updates, undo history over the document, with the
// changes made to Rekordbox's cues in between.

import { useSyncExternalStore } from "react";
import { emptyDoc, LANES, type Cue, type CueRow, type ExportResult, type PlannerDoc, type PlannerTrack, type ProbeResult, type SetInfo, type Settings } from "@shared/planner";
import type { EditSection } from "@shared/trackEdit";
import { normalizeDoc } from "@shared/renderings";

// A dropped file on its way to the timeline: either waiting for its BPM to be typed
// (`probe`), or with everything known already (`track`) and only waiting its turn behind one
// that is. `beat` null means right after the file dropped before it.
// `edit`: the file was dropped on the track editor, to be opened there rather than placed.
export type ImportItem = { lane: number; beat: number | null; edit?: boolean } & ({ probe: ProbeResult } | { track: PlannerTrack });

export type ExportUi = { phase: "options" } | { phase: "running"; stage: string; pct: number } | { phase: "done"; result: ExportResult } | { phase: "error"; message: string };

// A place on a track that was right-clicked: the file, the beat line nearest to it (in
// seconds into the file), and the cues under the pointer. `edit`: it was in the track editor.
export type CueSpot = { path: string; sec: number; hits: Cue[]; edit: boolean };

// The right-click menu: for a clip, for a place on a track, or on the timeline both.
export type MenuUi = { x: number; y: number; clipId?: string; cue?: CueSpot } | null;

// A change to a track's cues in Rekordbox, as a step of undo history: the rows that were
// added and the rows that were taken out. It sits in the history between the document's
// states, and going over it puts the cues back in Rekordbox (or takes them out again).
export type CueStep = { cue: true; path: string; added: CueRow[]; removed: CueRow[] };
export const isCueStep = (step: object): step is CueStep => "cue" in step;

// A lane of the track editor: the result ("out"), or with two tracks open the lane a track
// is laid out whole in, to take pieces from (0 the first track, 1 the second).
export type EditLane = "out" | 0 | 1;

// What undo steps through in the track editor. `track` is the track as it was when it was
// opened, and `second` the one opened next to it, if any; `sections` play one after the other
// (see @shared/trackEdit), and `cuts` are the cut marks on each track's own lane, in its beats.
export type EditSnap = { track: PlannerTrack; second: PlannerTrack | null; sections: EditSection[]; cuts: [number[], number[]] };

// The editor at the bottom of the window. The result plays at the first track's tempo.
export type TrackEditUi = EditSnap & {
	past: (EditSnap | CueStep)[];
	future: (EditSnap | CueStep)[];
	lane: EditLane; // the lane clicked last: the cursor, the selection, cuts and play are its
	selection: string[]; // ids of sections of the result, or of pieces of a track's lane
	cursorBeat: number; // where a cut goes and where the preview starts, in beats along the ruler
	pxPerBeat: number; // 0: zoomed so that the whole edit fits the panel
	scrollX: number;
	width: number; // of the panel, as measured
	playing: boolean;
	exporting: boolean;
	exported: string | null; // the file the edit as it stands was last exported to
	error: string | null;
};

export type State = {
	doc: PlannerDoc;
	past: (PlannerDoc | CueStep)[];
	future: (PlannerDoc | CueStep)[];
	rev: number; // bumps on every committed document change
	cues: Record<string, Cue[]>; // Rekordbox cue points by source file; looked up, never saved
	cueEdit: Record<string, boolean>; // whether the file's cues can be changed (it is in Rekordbox)
	cueWait: CueSpot | null; // "Add hot cue" was chosen here: waiting for its letter to be pressed
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
	showCues: boolean; // cue points drawn on the timeline's clips; for this session only
	screen: "home" | "editor" | "settings"; // the list of sets, one set open, or the settings
	settings: Settings | null; // null until first read
	trackEdit: TrackEditUi | null;
	editFocus: boolean; // the track editor was clicked last, so the keys act on it
	sets: SetInfo[] | null; // what the list of sets shows; null until first read
	setId: string | null; // the set that is open
	setName: string | null; // null until the set is first stored, which names it
	askName: boolean; // a set just made from the UI: the top bar asks for its name
	pendingDelete: SetInfo | null;
	pendingDuplicate: SetInfo | null;
	setGen: number; // bumps whenever a different set is loaded
	importQueue: ImportItem[];
	lastPlacedEnd: number;
	trackBpmEdit: string | null;
	pendingProjectBpm: number | null;
	exportUi: ExportUi | null;
	menu: MenuUi;
	toast: string | null;
	libraryOpen: boolean;
	libraryPlaylist: string | null; // the Rekordbox playlist the library shows; null for all tracks
	librarySort: LibrarySort;
	trackKeys: Record<string, string>; // Rekordbox's key for each file in its library, by path
	loaded: boolean;
};

// What the library is ordered by; `down` is largest first.
export type LibrarySort = { by: "number" | "key" | "bpm"; down: boolean };

const HISTORY = 300;

let state: State = {
	doc: emptyDoc(),
	past: [],
	future: [],
	rev: 0,
	cues: {},
	cueEdit: {},
	cueWait: null,
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
	showCues: true,
	screen: "home",
	settings: null,
	trackEdit: null,
	editFocus: false,
	sets: null,
	setId: null,
	setName: null,
	askName: false,
	pendingDelete: null,
	pendingDuplicate: null,
	setGen: 0,
	importQueue: [],
	lastPlacedEnd: 0,
	trackBpmEdit: null,
	pendingProjectBpm: null,
	exportUi: null,
	menu: null,
	toast: null,
	libraryOpen: false,
	libraryPlaylist: null,
	librarySort: { by: "number", down: false },
	trackKeys: {},
	loaded: false,
};

const listeners = new Set<() => void>();
let dragBase: PlannerDoc | null = null;

// Makes a cue step happen in Rekordbox, or with `back` undoes it (set by ./cues).
let cueRunner: (step: CueStep, back: boolean) => void = () => {};
export function setCueRunner(run: (step: CueStep, back: boolean) => void): void {
	cueRunner = run;
}
export const runCueStep = (step: CueStep, back: boolean): void => cueRunner(step, back);

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
		store.set(prune({ ...state, doc, past: [...state.past, state.doc].slice(-HISTORY), future: [], rev: state.rev + 1 }));
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
		store.set(prune({ ...state, past: [...state.past, base].slice(-HISTORY), future: [], rev: state.rev + 1 }));
	},
	cancelDrag(): void {
		if (dragBase) store.set({ doc: dragBase });
		dragBase = null;
	},
	// A change to a track's cues that has been made in Rekordbox: one undo step.
	pushCueStep(step: CueStep): void {
		store.set({ past: [...state.past, step].slice(-HISTORY), future: [] });
	},
	undo(): void {
		if (dragBase || state.past.length === 0) return;
		const doc = state.past[state.past.length - 1];
		if (isCueStep(doc)) {
			// The document is as it was; only Rekordbox's cues go back.
			store.set({ past: state.past.slice(0, -1), future: [doc, ...state.future] });
			runCueStep(doc, true);
			return;
		}
		store.set(prune({ ...state, doc, past: state.past.slice(0, -1), future: [state.doc, ...state.future], rev: state.rev + 1 }));
	},
	redo(): void {
		if (dragBase || state.future.length === 0) return;
		const doc = state.future[0];
		if (isCueStep(doc)) {
			store.set({ past: [...state.past, doc], future: state.future.slice(1) });
			runCueStep(doc, false);
			return;
		}
		store.set(prune({ ...state, doc, past: [...state.past, state.doc], future: state.future.slice(1), rev: state.rev + 1 }));
	},
	// Replace everything (a new set, or one being opened). Clears history.
	load(loaded: PlannerDoc, setId: string | null, setName: string | null): void {
		dragBase = null;
		store.set({ doc: normalizeDoc(loaded), past: [], future: [], rev: state.rev + 1, selection: [], setId, setName, setGen: state.setGen + 1, askName: false, playheadBeat: 0, cueBeat: 0, scrollX: 0, importQueue: [], lastPlacedEnd: 0, menu: null, cueWait: null, trackEdit: null, editFocus: false });
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
