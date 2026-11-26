// Planner state: one store, immutable updates, undo history over the document, with the
// changes made to Rekordbox's cues in between.

import { useSyncExternalStore } from "react";
import { emptyDoc, LANES, type Cue, type CueRow, type ExportResult, type PlannerDoc, type PlannerTrack, type ProbeResult, type SetInfo, type Settings } from "@shared/planner";
import type { AutoLink } from "@shared/cdj";
import type { EditSection } from "@shared/trackEdit";
import { normalizeDoc } from "@shared/renderings";

// Playlist mode stays on or off across launches.
export const PLAYLIST_KEY = "planner.playlistMode";

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
// `sectionId`: a section of the track editor was right-clicked.
export type MenuUi = { x: number; y: number; clipId?: string; cue?: CueSpot; sectionId?: string } | null;

// A change to a track's cues in Rekordbox, as a step of undo history: the rows that were
// added and the rows that were taken out. It sits in the history between the document's
// states, and going over it puts the cues back in Rekordbox (or takes them out again).
export type CueStep = { cue: true; path: string; added: CueRow[]; removed: CueRow[] };
export const isCueStep = (step: object): step is CueStep => "cue" in step;

// What undo steps through in the track editor. `tracks` are the tracks the edit takes from,
// as they were when added (a section's `src` is an index into them); the first sets the
// result's tempo and grid. `sections` sit on the editor's one lane (see @shared/trackEdit).
export type EditSnap = { tracks: PlannerTrack[]; sections: EditSection[] };

// The editor at the bottom of the window. The result plays at the first track's tempo.
export type TrackEditUi = EditSnap & {
	past: (EditSnap | CueStep)[];
	future: (EditSnap | CueStep)[];
	selection: string[]; // ids of sections
	cursorBeat: number; // where a cut goes and where the preview starts, in beats of the result
	bpm: number; // the tempo the editor plays at: the first track's own, until it is changed by hand
	pxPerBeat: number; // 0: zoomed so that the whole edit fits the panel
	scrollX: number;
	width: number; // of the panel, as measured
	playing: boolean;
	exporting: boolean;
	exported: string | null; // the file the edit as it stands was last exported to
	error: string | null;
	// Made by "Edit automatically" or Cmd+E: exporting swaps the file in for these clips (see
	// swapInEdit in @shared/cdj).
	auto?: { links: AutoLink[] };
	name?: string; // a name the user gave the edit; left out, it is named after its tracks (see editName)
};

// An automatic edit waiting for the user to agree that it replaces the one in the editor.
export type EditReplace = { tracks: PlannerTrack[]; sections: EditSection[]; links: AutoLink[] };

export type State = {
	doc: PlannerDoc;
	past: (PlannerDoc | CueStep)[];
	future: (PlannerDoc | CueStep)[];
	rev: number; // bumps on every committed document change
	cues: Record<string, Cue[]>; // Rekordbox cue points by source file; looked up, never saved
	cueEdit: Record<string, boolean>; // whether the file's cues can be changed (it is in Rekordbox)
	cueWait: CueSpot | null; // "Add hot cue" was chosen here: waiting for its letter to be pressed
	cueTool: number | null; // a cue button is on: a click on a track puts this cue there (0 memory, 1 to 8 A to H)
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
	showCues: boolean; // cue points drawn on the timeline's clips; for this session only
	playlistMode: boolean; // the toolbar under the top bar, with the set's Rekordbox playlist and its Sync button, shows
	screen: "home" | "editor" | "settings"; // the list of sets, one set open, or the settings
	settings: Settings | null; // null until first read
	trackEdit: TrackEditUi | null;
	editFocus: boolean; // the track editor was clicked last, so the keys act on it
	editReplace: EditReplace | null;
	lastEdit: string | null; // the file the editor last exported to: shown while the editor is empty, until a new edit starts
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
	libraryFilter: LibraryFilter;
	tagMode: boolean; // tag editor mode: the quick tags show on every library row, one click to add
	quickTags: string[]; // the tags picked for tag editor mode, by id
	starred: string[]; // the library tracks starred for the open set, by file; saved with it
	trackKeys: Record<string, string>; // Rekordbox's key for each file in its library, by path
	loaded: boolean;
};

// What the library is ordered by; `down` is largest first.
export type LibrarySort = { by: "number" | "key" | "bpm"; down: boolean };
// Which library tracks are shown: a BPM range (either end may be open) and Camelot keys (none: any).
export type LibraryFilter = { bpmMin: number | null; bpmMax: number | null; keys: string[]; tags: string[] };
export const NO_FILTER: LibraryFilter = { bpmMin: null, bpmMax: null, keys: [], tags: [] };

const HISTORY = 300;

let state: State = {
	doc: emptyDoc(),
	past: [],
	future: [],
	rev: 0,
	cues: {},
	cueEdit: {},
	cueWait: null,
	cueTool: null,
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
	showCues: true,
	playlistMode: localStorage.getItem(PLAYLIST_KEY) === "1",
	screen: "home",
	settings: null,
	trackEdit: null,
	editFocus: false,
	editReplace: null,
	lastEdit: null,
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
	libraryOpen: true,
	libraryPlaylist: null,
	librarySort: { by: "number", down: false },
	libraryFilter: NO_FILTER,
	tagMode: false,
	quickTags: [],
	starred: [],
	trackKeys: {},
	loaded: false,
};

const listeners = new Set<() => void>();
let dragBase: PlannerDoc | null = null;

// Makes a cue step happen in Rekordbox, or with `back` undoes it (set by ./cues).
// What a document change did outside the document (an automatic edit's file), undone and
// done again along with it. Keyed by the document as it was after the change.
type SideEffect = { undo: () => void; redo: () => void };
const sideEffects = new WeakMap<PlannerDoc, SideEffect>();

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
	// A finished edit that also changed something outside the document.
	commitWith(doc: PlannerDoc, effect: SideEffect): void {
		store.commit(doc);
		if (state.doc === doc) sideEffects.set(doc, effect);
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
		const effect = sideEffects.get(state.doc);
		store.set(prune({ ...state, doc, past: state.past.slice(0, -1), future: [state.doc, ...state.future], rev: state.rev + 1 }));
		effect?.undo();
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
		sideEffects.get(doc)?.redo();
	},
	// Replace everything (a new set, or one being opened). Clears history.
	load(loaded: PlannerDoc, setId: string | null, setName: string | null): void {
		dragBase = null;
		store.set({ doc: normalizeDoc(loaded), past: [], future: [], rev: state.rev + 1, selection: [], setId, setName, setGen: state.setGen + 1, askName: false, playheadBeat: 0, cueBeat: 0, scrollX: 0, importQueue: [], lastPlacedEnd: 0, menu: null, cueWait: null, cueTool: null, trackEdit: null, editFocus: false, editReplace: null, lastEdit: null, starred: [] });
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
