// The track editor in the bottom part of the window: one lane, like a lane of the set, that
// stretches of tracks are put on, cut up, moved and overlapped, then exported as one file.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cueMarks, type CueMark } from "@shared/cues";
import { PEAK_BUCKET, SAMPLE_RATE, trackBeats, type PlannerTrack } from "@shared/planner";
import { barPhase, moveSections, overlapRows, place, srcOf, type EditSection } from "@shared/trackEdit";
import { cueSpot, placeCue } from "./cues";
import { editPositionBeat, toggleEditPreview } from "./editPlayer";
import { openFileInEditor, parseBpm } from "./actions";
import { useLibraryDrop } from "./libraryDrag";
import { mediaFor } from "./media";
import { fmtLength } from "./Panels";
import { store, useStore, type TrackEditUi } from "./store";
import { hueVars, LaneGrid, NO_KEY, trackHue } from "./Timeline";
import { closeTrackEdit, editCanCut, editCut, editCutAt, editDelete, editDuplicate, editFit, editMain, editMove, editPx, editRedo, editResize, editSetBpm, editScroll, editSelect, editSetCursor, editStep, editTotal, editUndo, editZoom, exportTrackEdit } from "./trackEdit";
import { drawBand, peakMax, sizeCanvas } from "./wave";

const FROM_EDITOR = "application/x-dj-from-editor";

type View = { pxPerBeat: number; scrollX: number; width: number };

// One stretch of a track, drawn where it lands along the ruler, in the track's colour.
function Block({ outBeat, lengthBeat, startBeat, view, peaks, maxes, marks, hue, projectBpm, className, label, testId, id, style }: { outBeat: number; lengthBeat: number; startBeat: number; view: View; peaks: Uint8Array | null; maxes: [number, number]; marks: CueMark[]; hue: number; projectBpm: number; className: string; label?: string; testId: string; id?: string; style?: CSSProperties }) {
	const ref = useRef<HTMLCanvasElement>(null);
	const { pxPerBeat, scrollX, width } = view;
	const left = outBeat * pxPerBeat - scrollX;
	const w = Math.max(1, lengthBeat * pxPerBeat);
	const visL = Math.max(0, left);
	const visR = Math.min(width, left + w);
	const visible = visR > visL;

	useLayoutEffect(() => {
		const cv = ref.current;
		if (!cv || !visible) return;
		sizeCanvas(cv, Math.max(1, Math.ceil(visR - visL)), cv.clientHeight || 60);
		if (!peaks) return;
		// The waveform comes from the track as the editor plays it, stretched to the editor's tempo.
		const framesPerBeat = (60 / projectBpm) * SAMPLE_RATE;
		const at = { startBucket: ((startBeat + (visL - left) / pxPerBeat) * framesPerBeat) / PEAK_BUCKET, bucketsPerPx: framesPerBeat / pxPerBeat / PEAK_BUCKET };
		// The whole signal faintly, so breaks and drops can be told apart, with the kicks over it.
		drawBand(cv, peaks, { ...at, band: 0, max: maxes[0], fill: "rgba(255, 255, 255, 0.16)" });
		drawBand(cv, peaks, { ...at, band: 1, max: maxes[1], fill: "rgba(255, 255, 255, 0.85)" });
	}, [visible, visL, visR, left, pxPerBeat, peaks, maxes, startBeat, projectBpm, style?.height]);

	if (!visible) return null;
	return (
		<div className={className} style={{ left, width: w, ...hueVars(hue), ...style } as CSSProperties} data-testid={testId} data-section-id={id}>
			<canvas ref={ref} className="edit-wave" style={{ left: visL - left, width: Math.ceil(visR - visL) }} />
			{label && w >= 64 && (
				<div className="edit-section-label" style={{ paddingLeft: Math.max(0, -left) + 6 }}>
					{label}
				</div>
			)}
			{marks.map((m) => {
				// The track's cue points that fall in this stretch of it, and on screen.
				const cx = (m.beat - startBeat) * pxPerBeat;
				if (m.beat < startBeat - 1e-6 || m.beat >= startBeat + lengthBeat - 1e-6 || left + cx < -12 || left + cx > width + 12) return null;
				return (
					<div key={m.beat} className={`cue${m.memory ? " memory" : ""}${m.letters.length ? " hot" : ""}`} style={{ left: Math.round(left + cx) - left }} data-testid="edit-cue" data-cue={`${m.memory ? "M" : ""}${m.letters.join("")}`}>
						{m.letters.map((l) => (
							<span key={l}>{l}</span>
						))}
					</div>
				);
			})}
		</div>
	);
}

// A length as a DJ counts it: whole bars, then the beats left over.
function lengthText(beats: number): string {
	const whole = Math.floor(beats / 4 + 1e-6);
	const rest = Math.max(0, Math.round((beats - whole * 4) * 100) / 100);
	const bars = `${whole} bar${whole === 1 ? "" : "s"}`;
	const left = `${rest} beat${rest === 1 ? "" : "s"}`;
	return rest === 0 ? bars : whole === 0 ? left : `${bars} ${left}`;
}

// Dropping an audio file (from Finder, the library, or an exported edit) on the editor opens
// it there. Returns the handlers and whether a file is being held over it.
function useFileDrop(): { dropping: boolean; handlers: { onDragEnter: (e: ReactDragEvent) => void; onDragOver: (e: ReactDragEvent) => void; onDragLeave: (e: ReactDragEvent) => void; onDrop: (e: ReactDragEvent) => void } } {
	const [dropping, setDropping] = useState(false);
	const depth = useRef(0);
	// The exported file picked up from the editor itself is on its way to a lane, not here.
	const carriesFile = (e: ReactDragEvent): boolean => !e.dataTransfer.types.includes(FROM_EDITOR) && (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("application/x-dj-path"));
	return {
		dropping,
		handlers: {
			onDragEnter: (e) => {
				if (!carriesFile(e)) return;
				depth.current++;
				setDropping(true);
			},
			onDragOver: (e) => {
				if (!carriesFile(e)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "copy";
			},
			onDragLeave: (e) => {
				if (!carriesFile(e)) return;
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) setDropping(false);
			},
			onDrop: (e) => {
				e.preventDefault();
				if (!carriesFile(e)) return;
				depth.current = 0;
				setDropping(false);
				const custom = e.dataTransfer.getData("application/x-dj-path");
				const file = Array.from(e.dataTransfer.files)[0];
				const p = custom || (file ? window.api.pathForFile(file) : "");
				if (p) void openFileInEditor(p);
			},
		},
	};
}

// The line that follows the preview while it plays.
function EditPlayhead() {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let raf = 0;
		const frame = (): void => {
			raf = requestAnimationFrame(frame);
			const el = ref.current;
			const e = store.get().trackEdit;
			if (!el || !e) return;
			const beat = editPositionBeat();
			let x = beat * editPx(e) - e.scrollX;
			// Zoomed in, the view pages along once the preview runs off its right edge.
			if (e.playing && (x > e.width || x < 0)) {
				editScroll(x - 40);
				x = beat * editPx(e) - (store.get().trackEdit?.scrollX ?? e.scrollX);
			}
			el.style.visibility = e.playing && x >= -1 && x <= e.width + 1 ? "visible" : "hidden";
			el.style.transform = `translateX(${x}px)`;
			el.dataset.beat = beat.toFixed(4);
		};
		raf = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(raf);
	}, []);
	return <div className="edit-playhead" ref={ref} data-testid="edit-playhead" />;
}

// The colours of the editor's tracks: each track's own (from its key), unless it is the same as
// or too close to one before it, which would make them hard to tell apart.
function trackHues(tracks: PlannerTrack[], keys: Record<string, string>): number[] {
	const out: number[] = [];
	const near = (a: number, b: number): boolean => (a === NO_KEY || b === NO_KEY ? a === b : Math.abs(((b - a + 540) % 360) - 180) < 50);
	tracks.forEach((t, i) => {
		let h = trackHue(t, keys);
		for (let k = 0; out.some((o) => near(o, h)) && k < 12; k++) h = Math.round(210 + 137.5 * (i + k)) % 360;
		out.push(h);
	});
	return out;
}

const maxCache = new WeakMap<Uint8Array, [number, number]>();
function maxesOf(peaks: Uint8Array | null): [number, number] {
	if (!peaks) return [255, 255];
	let m = maxCache.get(peaks);
	if (!m) maxCache.set(peaks, (m = [peakMax(peaks, 0), peakMax(peaks, 1)]));
	return m;
}

const bpmText = (bpm: number): string => String(Number(bpm.toFixed(2)));

// The tempo the editor plays at. It starts at the first track's own; typing another plays the
// tracks at that tempo, and ↺ brings back the first track's.
function EditBpmField({ bpm, original }: { bpm: number; original: number }) {
	const [text, setText] = useState(bpmText(bpm));
	const [bad, setBad] = useState(false);
	useEffect(() => {
		setText(bpmText(bpm));
		setBad(false);
	}, [bpm]);
	const commit = (): void => {
		const v = parseBpm(text);
		if (v === null) {
			setBad(true);
			return;
		}
		setBad(false);
		editSetBpm(v);
		setText(bpmText(v));
	};
	const changed = Math.abs(bpm - original) > 1e-9;
	return (
		<label className={`bpm-field edit-bpm${bad ? " bad" : ""}`}>
			<input
				data-testid="edit-bpm"
				aria-label="Editor BPM"
				value={text}
				inputMode="decimal"
				onChange={(ev) => setText(ev.target.value)}
				onKeyDown={(ev) => {
					ev.stopPropagation();
					if (ev.key === "Enter") {
						commit();
						if (parseBpm(text) !== null) ev.currentTarget.blur();
					} else if (ev.key === "Escape") {
						setText(bpmText(bpm));
						setBad(false);
						ev.currentTarget.blur();
					}
				}}
				onBlur={() => {
					if (parseBpm(text) === null) {
						setText(bpmText(bpm));
						setBad(false);
					} else commit();
				}}
			/>
			<span>BPM</span>
			{changed && (
				<button className="ghost icon" data-testid="edit-bpm-reset" aria-label="Back to the track's own BPM" onClick={() => editSetBpm(original)}>
					↺
				</button>
			)}
		</label>
	);
}

function Editor({ e }: { e: TrackEditUi }) {
	const focus = useStore((s) => s.editFocus);
	useStore((s) => s.mediaRev);
	const allCues = useStore((s) => s.cues);
	const keys = useStore((s) => s.trackKeys);
	const lanesRef = useRef<HTMLDivElement>(null);
	const [moving, setMoving] = useState<EditSection[] | null>(null); // the sections as a drag would leave them
	const fileDrop = useFileDrop();
	const editorRef = useRef<HTMLDivElement>(null);
	useLibraryDrop(editorRef, (d) => void openFileInEditor(d.path));

	useLayoutEffect(() => {
		const el = lanesRef.current!;
		const measure = (): void => editResize(el.clientWidth);
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		measure();
		return () => ro.disconnect();
	}, []);

	useEffect(() => {
		const el = lanesRef.current!;
		const wheel = (ev: WheelEvent): void => {
			ev.preventDefault();
			if (ev.ctrlKey || ev.metaKey) editZoom(Math.exp(-ev.deltaY * 0.01), ev.clientX - el.getBoundingClientRect().left);
			else editScroll(Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY);
		};
		el.addEventListener("wheel", wheel, { passive: false });
		return () => el.removeEventListener("wheel", wheel);
	}, []);

	const main = editMain(e);
	const phase = barPhase(main);
	const shownSections = moving ?? e.sections;
	const shown = useMemo(() => place(shownSections), [shownSections]);
	const rows = useMemo(() => overlapRows(shownSections), [shownSections]);
	const total = editTotal(e);
	const view: View = { pxPerBeat: editPx(e), scrollX: e.scrollX, width: e.width };
	const hues = trackHues(e.tracks, keys);
	// The tracks, each with what it takes to draw a stretch of it.
	const sources = e.tracks.map((track, i) => {
		const media = mediaFor(track, e.bpm);
		const peaks = media?.state === "ready" ? media.peaks : null;
		return { track, ready: media?.state === "ready", peaks, maxes: maxesOf(peaks), marks: cueMarks(allCues[track.sourcePath], track), hue: hues[i] };
	});
	const sourceOf = (sec: EditSection) => sources[srcOf(sec)] ?? sources[0];
	const multi = e.tracks.length > 1;
	const x = (beat: number): number => beat * view.pxPerBeat - view.scrollX;
	// The place along the ruler under the pointer, in beats.
	const beatAt = (clientX: number): number => (clientX - lanesRef.current!.getBoundingClientRect().left + (store.get().trackEdit?.scrollX ?? 0)) / view.pxPerBeat;
	// The section under the pointer: the one drawn there, on whichever row it is.
	const sectionAt = (target: EventTarget): EditSection | undefined => {
		const id = (target as HTMLElement).closest<HTMLElement>("[data-section-id]")?.dataset.sectionId;
		return id ? e.sections.find((s) => s.id === id) : undefined;
	};

	// A press on the lane: a click moves the cursor and selects, a drag moves sections along it.
	const onDown = (ev: ReactPointerEvent): void => {
		if (ev.button !== 0) return;
		const row = ev.currentTarget as HTMLElement;
		const at = beatAt(ev.clientX);
		const hit = sectionAt(ev.target);
		// A cue button is on: the cue goes on the track of the section under the pointer.
		if (store.get().cueTool !== null) {
			if (hit) placeCue(sourceOf(hit).track, hit.startBeat + (at - hit.atBeat), view.pxPerBeat, true);
			return;
		}
		// S is held (set in App.tsx): a click cuts there, as on the timeline.
		if (document.body.classList.contains("split-tool")) {
			editCutAt(at);
			return;
		}
		const selection = e.selection;
		const ids = hit ? (selection.includes(hit.id) ? selection : [hit.id]) : [];
		const downX = ev.clientX;
		let dragging = false;
		let by = 0;
		const step = editStep(e);
		row.setPointerCapture(ev.pointerId);
		const move = (m: PointerEvent): void => {
			if (!dragging && hit && Math.abs(m.clientX - downX) > 4) {
				dragging = true;
				document.body.classList.add("dragging-move");
				editSelect(ids);
			}
			if (!dragging) return;
			by = Math.round((beatAt(m.clientX) - at) / step) * step;
			setMoving(moveSections(e.sections, ids, by));
		};
		const end = (cancelled: boolean): void => {
			row.removeEventListener("pointermove", move);
			row.removeEventListener("pointerup", up);
			row.removeEventListener("pointercancel", cancel);
			window.removeEventListener("keydown", key, true);
			document.body.classList.remove("dragging-move");
			setMoving(null);
			if (dragging) {
				if (!cancelled) editMove(ids, by);
				return;
			}
			if (cancelled) return;
			// A click: the cursor goes there, and the section under it is selected.
			editSetCursor(at);
			if (!hit) editSelect([]);
			else if (ev.shiftKey || ev.metaKey) editSelect(selection.includes(hit.id) ? selection.filter((id) => id !== hit.id) : [...selection, hit.id]);
			else editSelect([hit.id]);
		};
		const up = (): void => end(false);
		const cancel = (): void => end(true);
		// Escape lets go of a drag and leaves everything where it was.
		const key = (k: KeyboardEvent): void => {
			if (k.key !== "Escape" || !dragging) return;
			k.preventDefault();
			k.stopPropagation();
			end(true);
		};
		row.addEventListener("pointermove", move);
		row.addEventListener("pointerup", up);
		row.addEventListener("pointercancel", cancel);
		window.addEventListener("keydown", key, true);
	};

	// A right-click on a section opens the menu for the cues there, and for adding one on the
	// nearest beat line of its track.
	const onMenu = (ev: ReactMouseEvent): void => {
		ev.preventDefault();
		const hit = sectionAt(ev.target);
		if (!hit) return;
		const so = sourceOf(hit);
		const beat = hit.startBeat + (beatAt(ev.clientX) - hit.atBeat);
		if (beat < 0 || beat > trackBeats(so.track)) return;
		store.set({ menu: { x: ev.clientX, y: ev.clientY, cue: cueSpot(so.track, so.marks, beat, view.pxPerBeat, true, { from: hit.startBeat, to: hit.startBeat + hit.lengthBeat }) } });
	};

	// The zoom buttons keep the cursor where it is when it is in view (the middle otherwise).
	const cursorX = x(e.cursorBeat);
	const zoomAnchor = cursorX >= 0 && cursorX <= view.width ? cursorX : undefined;
	const some = e.selection.length > 0;
	const style = hueVars(hues[0]);
	return (
		<div className={`bottom-area track-editor${focus ? " focused" : ""}${fileDrop.dropping ? " file-over" : ""}`} data-testid="track-editor" style={style} ref={editorRef} {...fileDrop.handlers}>
			<div className="edit-head">
				<button className="play" data-testid="edit-play" onClick={toggleEditPreview} disabled={!sources.every((so) => so.ready)}>
					{e.playing ? "■" : "▶"}
				</button>
				<div className="edit-title">
					<span className="edit-name" data-testid="edit-name">
						{e.tracks.map((t) => t.name).join(" + ")}
					</span>
					<span className="muted">{fmtLength((total * 60) / e.bpm)}</span>
				</div>
				<EditBpmField bpm={e.bpm} original={main.bpm} />
				<button className="ghost" data-testid="edit-cut" disabled={!editCanCut(e)} onClick={editCut}>
					Cut
				</button>
				<button className="ghost" data-testid="edit-duplicate" disabled={!some} onClick={editDuplicate}>
					Duplicate
				</button>
				<button className="ghost" data-testid="edit-delete" disabled={!some} onClick={editDelete}>
					Delete
				</button>
				<button className="ghost" data-testid="edit-undo" disabled={e.past.length === 0} onClick={editUndo}>
					Undo
				</button>
				<button className="ghost" data-testid="edit-redo" disabled={e.future.length === 0} onClick={editRedo}>
					Redo
				</button>
				<div className="zoom">
					<button className="ghost icon" data-testid="edit-zoom-out" aria-label="Zoom out" onClick={() => editZoom(1 / 1.5, zoomAnchor)}>
						−
					</button>
					<button className="ghost icon" data-testid="edit-zoom-in" aria-label="Zoom in" onClick={() => editZoom(1.5, zoomAnchor)}>
						+
					</button>
					<button className="ghost" data-testid="edit-fit" onClick={editFit}>
						Fit
					</button>
				</div>
				<div className="edit-status">
					{e.error && (
						<span className="error" data-testid="edit-error">
							{e.error}
						</span>
					)}
					{!e.error && e.exported && (
						<>
							{/* The exported file: drag it onto a lane to use it in the set. */}
							<div
								className="edit-file"
								data-testid="edit-exported"
								draggable
								onDragStart={(ev) => {
									ev.dataTransfer.setData("application/x-dj-path", e.exported!);
									ev.dataTransfer.setData(FROM_EDITOR, "1");
									ev.dataTransfer.effectAllowed = "copy";
								}}
							>
								<span className="edit-file-grip">⠿</span>
								<span className="edit-file-name">{e.exported.split("/").pop()}</span>
								<span className="edit-file-hint">drag to a lane</span>
							</div>
							<button className="ghost" data-testid="edit-reveal" onClick={() => void window.api.reveal(e.exported!)}>
								Show in Finder
							</button>
						</>
					)}
				</div>
				<button className="primary" data-testid="edit-export" disabled={e.exporting || shown.length === 0} onClick={() => void exportTrackEdit()}>
					{e.exporting ? "Exporting…" : "Export edit"}
				</button>
				<button className="ghost icon" data-testid="edit-close" aria-label="Close the editor" onClick={closeTrackEdit}>
					✕
				</button>
			</div>
			<div className="edit-body">
				<div className="edit-lanes" ref={lanesRef}>
					<div className="edit-row out active" data-testid="edit-row" onPointerDown={onDown} onContextMenu={onMenu}>
						<LaneGrid width={view.width} pxPerBeat={view.pxPerBeat} scrollX={view.scrollX - phase * view.pxPerBeat} />
						{shown.map((p, i) => {
							const so = sourceOf(p.section);
							const selected = e.selection.includes(p.section.id);
							const r = rows.get(p.section.id);
							// Where sections overlap, the lane splits into rows of the same height all along it.
							const rowStyle: CSSProperties | undefined = r && r.rows > 1 ? { top: `calc(8px + (100% - 30px) * ${r.row / r.rows})`, bottom: "auto", height: `calc((100% - 30px) / ${r.rows} - 2px)` } : undefined;
							return (
								<Block
									key={p.section.id}
									id={p.section.id}
									className={`edit-section${selected ? " selected" : ""}`}
									testId="edit-section"
									label={`${multi ? `${so.track.name} · ` : `${i + 1} · `}${lengthText(p.lengthBeat)}`}
									outBeat={p.outBeat}
									lengthBeat={p.lengthBeat}
									startBeat={p.section.startBeat}
									view={view}
									peaks={so.peaks}
									maxes={so.maxes}
									marks={so.marks}
									hue={so.hue}
									projectBpm={e.bpm}
									style={rowStyle}
								/>
							);
						})}
						{shown.length === 0 && <div className="edit-hint">Everything is deleted. Undo to bring sections back.</div>}
						<div className="edit-cursor" data-testid="edit-cursor" data-beat={e.cursorBeat.toFixed(4)} style={{ transform: `translateX(${x(e.cursorBeat)}px)`, visibility: e.playing || x(e.cursorBeat) < 1 ? "hidden" : "visible" }} />
						<EditPlayhead />
					</div>
				</div>
			</div>
		</div>
	);
}

function Empty() {
	const drop = useFileDrop();
	const ref = useRef<HTMLDivElement>(null);
	useLibraryDrop(ref, (d) => void openFileInEditor(d.path));
	return (
		<div className={`bottom-area edit-empty${drop.dropping ? " file-over" : ""}`} data-testid="track-editor-empty" ref={ref} {...drop.handlers}>
			Right-click a clip and choose Add to editor, or drop an audio file here, to cut a track up.
		</div>
	);
}

export function TrackEditor() {
	const e = useStore((s) => s.trackEdit);
	if (!e) return <Empty />;
	return <Editor e={e} />;
}
