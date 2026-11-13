import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { autoSave, deleteSelection, duplicateSelection, exportClips, flagTargets, importPaths, importViaDialog, flushAutoSave, goHome, newSet, nudgeSelection, openExport, openSet, refreshSets, runExport, saveBeforeClose, selectAll, splitAtPlayhead, toggleClipsFlag, watchCues, zoomAround, zoomToFit } from "./planner/actions";
import { stopEditPreview, toggleEditPreview } from "./planner/editPlayer";
import { engine } from "./planner/engine";
import { initMedia, reconcileMedia, tempoProgress } from "./planner/media";
import { Home } from "./planner/Home";
import { ClipMenu, Library, Modals, TopBar, Toast } from "./planner/Panels";
import { closeSettings, Settings } from "./planner/Settings";
import { store, useStore, type TrackEditUi } from "./planner/store";
import { Timeline } from "./planner/Timeline";
import { editCut, editDelete, editDuplicate, editNudge, editRedo, editSelect, editSelectAll, editSetCursor, editPx, editSelectedClips, editStepCursor, editUndo, exportTrackEdit, openTrackEdit } from "./planner/trackEdit";
import { leadBeat, place } from "@shared/trackEdit";
import { TrackEditor } from "./planner/TrackEditor";
import { Updater, updateModalOpen } from "./Updater";
import { VersionChip } from "./VersionChip";

function isTyping(): boolean {
	const el = document.activeElement;
	return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function modalOpen(): boolean {
	const s = store.get();
	return updateModalOpen() || s.importQueue.length > 0 || s.trackBpmEdit !== null || s.pendingProjectBpm !== null || s.pendingDelete !== null || s.pendingDuplicate !== null || s.exportUi !== null;
}

function menuAction(action: string): void {
	const typing = isTyping();
	// Text fields keep their own undo and select-all.
	if (typing && (action === "undo" || action === "redo")) {
		document.execCommand(action);
		return;
	}
	if (typing && action === "select-all") {
		(document.activeElement as HTMLInputElement).select();
		return;
	}
	if (modalOpen()) return;
	// The list of sets has no timeline to act on.
	if (store.get().screen !== "editor" && action !== "new") return;
	if (action === lastKeyAction && performance.now() - lastKeyAt < 250) return;
	runAction(action);
}

// The track editor was clicked last: editing keys and menu items act on its sections.
function editorHasKeys(): boolean {
	const s = store.get();
	return s.screen === "editor" && s.editFocus && s.trackEdit !== null;
}

// Whether the track editor took the action.
function editorAction(action: string): boolean {
	switch (action) {
		case "undo":
			editUndo();
			return true;
		case "redo":
			editRedo();
			return true;
		case "select-all":
			editSelectAll();
			return true;
		case "split":
			editCut();
			return true;
		case "duplicate":
			editDuplicate();
			return true;
		case "delete":
			editDelete();
			return true;
		case "mute":
		case "bass":
			return true; // nothing to mute in the editor, and the timeline's selection is not meant
	}
	return false;
}

function runAction(action: string): void {
	if (editorHasKeys() && editorAction(action)) return;
	switch (action) {
		case "new":
			void newSet({ askName: true });
			break;
		case "sets":
			void goHome();
			break;
		case "import":
			void importViaDialog();
			break;
		case "export":
			// With clips selected on the timeline, ⌘E sends them to the track editor instead.
			if (editorHasKeys() || !editSelectedClips()) openExport();
			break;
		case "undo":
			store.undo();
			break;
		case "redo":
			store.redo();
			break;
		case "select-all":
			selectAll();
			break;
		case "split":
			splitAtPlayhead();
			break;
		case "duplicate":
			duplicateSelection();
			break;
		case "mute":
			toggleClipsFlag(flagTargets(), "muted");
			break;
		case "bass":
			toggleClipsFlag(flagTargets(), "lowCut");
			break;
		case "delete":
			deleteSelection();
			break;
		case "zoom-in":
			zoomAround(1.5);
			break;
		case "zoom-out":
			zoomAround(1 / 1.5);
			break;
		case "zoom-fit":
			zoomToFit();
			break;
	}
}

// Shortcuts are handled here so they behave the same whether or not the menu sees the
// key. A shortcut handled here is consumed, and the guard below drops the menu's echo of
// it if one arrives anyway.
let lastKeyAction = "";
let lastKeyAt = 0;

function shortcut(e: KeyboardEvent): string | null {
	const mod = e.metaKey || e.ctrlKey;
	const k = e.key.toLowerCase();
	if (mod && !e.altKey) {
		if (k === "z") return e.shiftKey ? "redo" : "undo";
		if (k === "a") return "select-all";
		if (k === "d") return "duplicate";
		if (k === "m" && !e.shiftKey) return "mute";
		if (k === "b" && !e.shiftKey) return "bass";
		if (k === "s" && !e.shiftKey) return "split";
		if (k === "o") return "sets";
		if (k === "n") return "new";
		if (k === "i") return "import";
		if (k === "e") return "export";
		if (k === "=" || k === "+") return "zoom-in";
		if (k === "-") return "zoom-out";
		if (k === "0") return "zoom-fit";
		return null;
	}
	if (mod) return null;
	if (e.altKey) {
		if (k === "arrowleft") return "slide-left";
		if (k === "arrowright") return "slide-right";
		return null;
	}
	if (e.code === "Space") return "toggle";
	if (k === "backspace" || k === "delete") return "delete";
	if (k === "c") return "cue";
	if (k === "home") return "home";
	if (k === "arrowleft") return "nudge-left";
	if (k === "arrowright") return "nudge-right";
	if (k === "escape") return "escape";
	return null;
}

// While S is held, a click on a clip cuts it there; while M or B is held, a click mutes or
// unmutes the clip or its bass (the timeline reads these classes).
const HOLD_TOOLS: Record<string, string> = { s: "split-tool", m: "mute-tool", b: "bass-tool" };
const dropSplitTool = (): void => document.body.classList.remove(...Object.values(HOLD_TOOLS));

function onKey(e: KeyboardEvent): void {
	// A shortcut with Command never leaves the cut tool on: its key-up may not arrive.
	if (e.metaKey || e.ctrlKey) dropSplitTool();
	if (modalOpen()) return;
	// A set name being typed takes every key, Space included.
	if (document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains("name-edit")) return;
	// Space is otherwise the transport key outside dialogs. The other fields outside dialogs
	// are BPM boxes, where a space means nothing, so let go of whatever holds focus (a BPM box
	// commits on blur) and play.
	if (e.code === "Space" && !e.metaKey && !e.ctrlKey && !e.altKey) {
		const el = document.activeElement;
		if (el instanceof HTMLElement && el !== document.body) el.blur();
		if (modalOpen()) {
			e.preventDefault();
			return;
		}
	}
	if (isTyping()) return;
	const inEditor = editorHasKeys();
	const tool = HOLD_TOOLS[e.key.toLowerCase()];
	if (tool && !e.metaKey && !e.ctrlKey && !e.altKey) {
		if (store.get().screen !== "editor") return;
		e.preventDefault();
		document.body.classList.add(tool);
		return;
	}
	const action = shortcut(e);
	if (!action) return;
	if (store.get().screen === "settings" && action === "escape") {
		e.preventDefault();
		closeSettings();
		return;
	}
	if (store.get().screen !== "editor" && action !== "new") return;
	e.preventDefault();
	if (e.repeat && action !== "undo" && action !== "redo" && action !== "zoom-in" && action !== "zoom-out" && action !== "nudge-left" && action !== "nudge-right" && action !== "slide-left" && action !== "slide-right") return;
	// ⌥← ⌥→ move the editor's selected sections in time; the timeline has no use for them.
	if (action === "slide-left" || action === "slide-right") {
		if (inEditor) editNudge(action === "slide-left" ? -1 : 1);
		return;
	}
	if (inEditor && (action === "toggle" || action === "cue" || action === "nudge-left" || action === "nudge-right" || action === "home" || action === "escape")) {
		if (action === "toggle") toggleEditPreview();
		else if (action === "cue") {
			stopEditPreview();
			toggleEditPreview();
		} else if (action === "nudge-left") editStepCursor(-1);
		else if (action === "nudge-right") editStepCursor(1);
		else if (action === "home") editSetCursor(0);
		else if (store.get().menu) store.set({ menu: null });
		else editSelect([]);
		return;
	}
	if (action === "toggle") engine.toggle();
	else if (action === "cue") engine.cue();
	else if (action === "nudge-left") nudgeSelection(-1);
	else if (action === "nudge-right") nudgeSelection(1);
	else if (action === "home") {
		engine.seek(0);
		store.set({ scrollX: 0 });
	} else if (action === "escape") {
		// Escape during a drag only cancels the drag (handled by the timeline).
		const dragging = document.body.classList.contains("dragging-move") || document.body.classList.contains("dragging-trim");
		// Otherwise it closes an open menu, or deletes the selected clips like Delete.
		if (dragging) return;
		if (store.get().menu) store.set({ menu: null });
		else runAction("delete");
	}
	else {
		lastKeyAction = action;
		lastKeyAt = performance.now();
		runAction(action);
	}
}

let started = false;

// Wires the store to the rest of the app once: media, playback, autosave, menus.
function start(): void {
	if (started) return;
	started = true;
	initMedia();
	let lastRev = store.get().rev;
	let lastMediaRev = store.get().mediaRev;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	store.subscribe(() => {
		const s = store.get();
		if (!s.loaded) return;
		if (s.rev !== lastRev || s.mediaRev !== lastMediaRev) {
			const mediaOnly = s.rev === lastRev;
			lastRev = s.rev;
			lastMediaRev = s.mediaRev;
			if (mediaOnly) {
				// Newly ready audio: playback takes it up without a break.
				engine.refreshMedia();
			} else {
				// A committed edit: get whatever audio it calls for, and rebuild playback from
				// the playhead.
				reconcileMedia(s.doc);
				engine.refresh();
			}
		}
		// The set is written a moment after anything about it changes.
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => void autoSave(), 400);
	});
	// Closing the window never loses the last change.
	window.addEventListener("beforeunload", saveBeforeClose);
	window.api.onMenu(menuAction);
	window.api.onExportProgress((p) => {
		if (store.get().exportUi?.phase === "running") store.set({ exportUi: { phase: "running", stage: p.stage, pct: p.pct } });
	});
	// Capture phase, so no element that stops key events can swallow the shortcuts.
	window.addEventListener("keydown", onKey, true);
	// Space is the transport key; a button that kept focus after a click must not also fire.
	window.addEventListener("keyup", (e) => {
		if (e.code === "Space" && document.activeElement instanceof HTMLButtonElement && !modalOpen()) e.preventDefault();
	});
	window.addEventListener("keyup", (e) => {
		const tool = HOLD_TOOLS[e.key.toLowerCase()];
		if (tool) document.body.classList.remove(tool);
	});
	window.addEventListener("blur", dropSplitTool);
	// The keys go to the track editor once it is clicked, and back to the timeline on a click
	// anywhere else.
	window.addEventListener(
		"pointerdown",
		(e) => {
			const inEditor = e.target instanceof Element && e.target.closest(".track-editor") !== null;
			if (store.get().editFocus !== inEditor) store.set({ editFocus: inEditor });
		},
		true,
	);
	window.addEventListener("click", () => {
		if (document.activeElement instanceof HTMLButtonElement && !modalOpen()) document.activeElement.blur();
	});
	// Dropping a file anywhere outside the lanes must not navigate the window to it.
	window.addEventListener("dragover", (e) => e.preventDefault());
	window.addEventListener("drop", (e) => e.preventDefault());
	watchCues();
	// The app opens on the list of sets.
	void refreshSets().then(() => {
		store.set({ loaded: true });
		engine.warm();
	});
	// Handles for the end-to-end tests.
	(window as unknown as { planner: unknown }).planner = {
		store,
		engine,
		importPaths,
		exportClips,
		// The tests are written around sets at 128 BPM.
		newSet: (opts?: { askName?: boolean; bpm?: number }) => newSet({ bpm: 128, ...opts }),
		openSet,
		openSetFile: async (path: string) => openSet(await window.api.importSetFile(path)),
		goHome,
		refreshSets,
		flush: flushAutoSave,
		runExport,
		tempoProgress,
		openTrackEdit,
		editSelectedClips,
		exportTrackEdit,
		editPx,
		placeEdit: (e: TrackEditUi) => place(leadBeat(e.track), e.sections),
	};
}

// The divider between the timeline and the bottom area; its position is a share of the height and survives restarts.
const SPLIT_KEY = "planner.splitFrac";
const SPLIT_DEFAULT = 0.74;
const SPLIT_MIN_TOP = 200;

function savedSplit(): number {
	const v = Number(localStorage.getItem(SPLIT_KEY));
	return v > 0 && v <= 1 ? v : SPLIT_DEFAULT;
}

function Split({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	const [frac, setFrac] = useState(savedSplit);
	// A track opened in the editor brings the bottom area back if it was dragged shut.
	const editing = useStore((s) => s.trackEdit !== null);
	useEffect(() => {
		if (!editing) return;
		setFrac((f) => {
			if (f <= 0.9) return f;
			localStorage.setItem(SPLIT_KEY, String(SPLIT_DEFAULT));
			return SPLIT_DEFAULT;
		});
	}, [editing]);
	// Two tracks side by side need three lanes: the bottom area is given half the height.
	const lanes = useStore((s) => (s.trackEdit?.second ? 3 : 1));
	useEffect(() => {
		if (lanes === 3) setFrac((f) => Math.min(f, 0.5));
	}, [lanes]);

	const onDown = (e: ReactPointerEvent): void => {
		if (e.button !== 0) return;
		e.preventDefault();
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		const rect = ref.current!.getBoundingClientRect();
		const grab = e.clientY - (rect.top + frac * rect.height);
		let next = frac;
		const move = (ev: PointerEvent): void => {
			const y = ev.clientY - grab - rect.top;
			next = Math.min(1, Math.max(Math.min(1, SPLIT_MIN_TOP / rect.height), y / rect.height));
			setFrac(next);
		};
		const up = (): void => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", up);
			handle.removeEventListener("pointercancel", up);
			localStorage.setItem(SPLIT_KEY, String(next));
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up);
		handle.addEventListener("pointercancel", up);
	};

	return (
		<div className="split" ref={ref}>
			<div className="split-top" style={{ flexBasis: `${frac * 100}%` }}>
				{top}
			</div>
			<div className="split-handle" data-testid="split-handle" onPointerDown={onDown} />
			{bottom}
		</div>
	);
}

export default function App() {
	const libraryOpen = useStore((s) => s.libraryOpen);
	const screen = useStore((s) => s.screen);
	const loaded = useStore((s) => s.loaded);
	useEffect(start, []);
	// The updater sits outside both screens, so it stays mounted (and keeps its state) when
	// the screen changes, and its dialog shows on the Home screen too.
	return (
		<div className="app">
			{screen === "home" ? (
				<>
					{loaded && <Home />}
					<Modals />
					<Toast />
				</>
			) : screen === "settings" ? (
				<>
					<Settings />
					<Toast />
				</>
			) : (
				<>
					<TopBar />
					<Split top={<div className="body">{libraryOpen && <Library />}<Timeline /></div>} bottom={<TrackEditor />} />
					<Modals />
					<ClipMenu />
					<Toast />
				</>
			)}
			<Updater />
			<VersionChip />
		</div>
	);
}
