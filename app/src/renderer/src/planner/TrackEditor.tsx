// The track editor in the bottom part of the window: one track of the set, cut into
// sections that can be removed, copied and put in another order, then exported as a file.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { PEAK_BUCKET, SAMPLE_RATE } from "@shared/planner";
import { barPhase, leadBeat, place, slideSections, type EditSection, type Placed } from "@shared/trackEdit";
import { editPositionBeat, toggleEditPreview } from "./editPlayer";
import { openFileInEditor } from "./actions";
import { mediaFor } from "./media";
import { fmtLength } from "./Panels";
import { store, useStore, type TrackEditUi } from "./store";
import { cueMarks, fmtTime, gridStep, LaneGrid, trackHue, type CueMark } from "./Timeline";
import { closeTrackEdit, editCut, editCutAt, editDelete, editDuplicate, editFit, editMove, editPx, editRedo, editResize, editScroll, editSelect, editSetCursor, editSlide, editStep, editTotal, editUndo, editZoom, exportTrackEdit } from "./trackEdit";
import { drawBand, peakMax, sizeCanvas } from "./wave";

const RULER_H = 22;
const FROM_EDITOR = "application/x-dj-from-editor";

type View = { pxPerBeat: number; scrollX: number; width: number };

// Bar numbers and times along the top. Times are the edit's own, at the track's tempo.
function EditRuler({ view, lead, phase, bpm }: { view: View; lead: number; phase: number; bpm: number }) {
	const ref = useRef<HTMLCanvasElement>(null);
	const { pxPerBeat, scrollX, width } = view;
	useLayoutEffect(() => {
		const cv = ref.current;
		if (!cv) return;
		const g = sizeCanvas(cv, Math.max(1, width), RULER_H);
		const dpr = window.devicePixelRatio || 1;
		g.scale(dpr, dpr);
		const tick = gridStep(pxPerBeat, 9);
		const label = Math.max(4, gridStep(pxPerBeat, 90));
		g.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
		g.textBaseline = "top";
		for (let k = Math.ceil((scrollX / pxPerBeat - phase) / tick); ; k++) {
			const beat = phase + k * tick;
			const x = Math.round(beat * pxPerBeat - scrollX) + 0.5;
			if (x > width) break;
			if (beat < lead - 1e-6) continue;
			const major = (((k * tick) % label) + label) % label === 0;
			g.strokeStyle = major ? "#5a6072" : "#343846";
			g.beginPath();
			g.moveTo(x, major ? 0 : 15);
			g.lineTo(x, RULER_H);
			g.stroke();
			if (major) {
				g.fillStyle = "#c9cedb";
				const bar = String(Math.round((k * tick) / 4) + 1);
				g.fillText(bar, x + 4, 5);
				g.fillStyle = "#7d8496";
				g.fillText(fmtTime((beat * 60) / bpm), x + 8 + g.measureText(bar).width, 5);
			}
		}
	}, [pxPerBeat, scrollX, width, lead, phase, bpm]);
	return <canvas ref={ref} className="edit-ruler" style={{ width, height: RULER_H }} />;
}

// One stretch of the track, drawn where it lands in the edit.
function Block({ outBeat, lengthBeat, startBeat, view, peaks, maxes, marks, projectBpm, className, label, testId, id }: { outBeat: number; lengthBeat: number; startBeat: number; view: View; peaks: Uint8Array | null; maxes: [number, number]; marks: CueMark[]; projectBpm: number; className: string; label?: string; testId: string; id?: string }) {
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
		// The waveform comes from the track as the set plays it, stretched to the set's tempo.
		const framesPerBeat = (60 / projectBpm) * SAMPLE_RATE;
		const at = { startBucket: ((startBeat + (visL - left) / pxPerBeat) * framesPerBeat) / PEAK_BUCKET, bucketsPerPx: framesPerBeat / pxPerBeat / PEAK_BUCKET };
		// The whole signal faintly, so breaks and drops can be told apart, with the kicks over it.
		drawBand(cv, peaks, { ...at, band: 0, max: maxes[0], fill: "rgba(255, 255, 255, 0.16)" });
		drawBand(cv, peaks, { ...at, band: 1, max: maxes[1], fill: "rgba(255, 255, 255, 0.85)" });
	}, [visible, visL, visR, left, pxPerBeat, peaks, maxes, startBeat, projectBpm]);

	if (!visible) return null;
	return (
		<div className={className} style={{ left, width: w }} data-testid={testId} data-section-id={id}>
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

function lengthText(beats: number): string {
	const bars = beats / 4;
	if (Math.abs(bars - Math.round(bars)) < 1e-6) return `${Math.round(bars)} bar${Math.round(bars) === 1 ? "" : "s"}`;
	const b = Math.round(beats * 100) / 100;
	return `${b} beat${b === 1 ? "" : "s"}`;
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

function Editor({ e }: { e: TrackEditUi }) {
	const doc = useStore((s) => s.doc);
	const focus = useStore((s) => s.editFocus);
	useStore((s) => s.mediaRev);
	const cues = useStore((s) => s.cues[e.track.sourcePath]);
	const marks = useMemo(() => cueMarks(cues, e.track), [cues, e.track]);
	const bodyRef = useRef<HTMLDivElement>(null);
	const [drop, setDrop] = useState<number | null>(null); // where a dragged section would land
	const [lifted, setLifted] = useState(false); // the selected sections are being dragged
	const [sliding, setSliding] = useState<EditSection[] | null>(null); // the sections as an ⌥-drag would leave them
	const fileDrop = useFileDrop();

	useLayoutEffect(() => {
		const el = bodyRef.current!;
		const measure = (): void => editResize(el.clientWidth);
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		measure();
		return () => ro.disconnect();
	}, []);

	useEffect(() => {
		const el = bodyRef.current!;
		const wheel = (ev: WheelEvent): void => {
			ev.preventDefault();
			if (ev.ctrlKey || ev.metaKey) editZoom(Math.exp(-ev.deltaY * 0.01), ev.clientX - el.getBoundingClientRect().left);
			else editScroll(Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY);
		};
		el.addEventListener("wheel", wheel, { passive: false });
		return () => el.removeEventListener("wheel", wheel);
	}, []);

	const track = e.track;
	const lead = leadBeat(track);
	const phase = barPhase(track);
	const placed = useMemo(() => place(lead, e.sections), [lead, e.sections]);
	const shown = useMemo(() => (sliding ? place(lead, sliding) : placed), [lead, sliding, placed]);
	const total = editTotal(e);
	const view: View = { pxPerBeat: editPx(e), scrollX: e.scrollX, width: e.width };
	const media = mediaFor(track, doc.bpm);
	const peaks = media?.state === "ready" ? media.peaks : null;
	const maxes = useMemo((): [number, number] => [peakMax(peaks, 0), peakMax(peaks, 1)], [peaks]);
	const x = (beat: number): number => beat * view.pxPerBeat - view.scrollX;

	// Where a section dropped before the section at `index` lands, in beats of the edit.
	const boundary = (index: number): number => {
		const p = placed.find((q) => e.sections.indexOf(q.section) >= index);
		return p ? p.outBeat : total;
	};

	const onDown = (ev: ReactPointerEvent): void => {
		if (ev.button !== 0) return;
		const row = ev.currentTarget as HTMLElement;
		const rect = row.getBoundingClientRect();
		const beatAt = (clientX: number): number => (clientX - rect.left + (store.get().trackEdit?.scrollX ?? 0)) / view.pxPerBeat;
		const at = beatAt(ev.clientX);
		// S is held (set in App.tsx): a click cuts there, as on the timeline.
		if (document.body.classList.contains("split-tool")) {
			editCutAt(at);
			return;
		}
		const hit: Placed<EditSection> | undefined = placed.find((p) => at >= p.outBeat && at < p.outBeat + p.lengthBeat);
		const ids = hit ? (e.selection.includes(hit.section.id) ? e.selection : [hit.section.id]) : [];
		const downX = ev.clientX;
		let dragging = false;
		let to: number | null = null;
		let slideBy = 0; // with ⌥ held: beats the sections move in time instead
		let slide = false;
		const step = editStep(e);
		// The cut nearest the pointer is where the dragged sections go.
		const indexAt = (clientX: number): number => {
			const b = beatAt(clientX);
			let best = e.sections.length;
			let dist = Math.abs(b - total);
			for (const p of placed) {
				const d = Math.abs(b - p.outBeat);
				if (d < dist) {
					dist = d;
					best = e.sections.indexOf(p.section);
				}
			}
			return best;
		};
		row.setPointerCapture(ev.pointerId);
		const move = (m: PointerEvent): void => {
			if (!dragging && hit && Math.abs(m.clientX - downX) > 4) {
				dragging = true;
				document.body.classList.add("dragging-move");
				editSelect(ids);
				setLifted(true);
			}
			if (!dragging) return;
			// ⌥ held: the sections move in time and leave silence behind; otherwise they go
			// to the cut nearest the pointer.
			slide = m.altKey;
			if (slide) {
				slideBy = Math.round((beatAt(m.clientX) - at) / step) * step;
				setDrop(null);
				setSliding(slideSections(e.sections, ids, slideBy));
			} else {
				to = indexAt(m.clientX);
				setSliding(null);
				setDrop(to);
			}
		};
		const end = (cancelled: boolean): void => {
			row.removeEventListener("pointermove", move);
			row.removeEventListener("pointerup", up);
			row.removeEventListener("pointercancel", cancel);
			window.removeEventListener("keydown", key, true);
			document.body.classList.remove("dragging-move");
			setDrop(null);
			setLifted(false);
			setSliding(null);
			if (dragging) {
				if (cancelled) return;
				if (slide) editSlide(ids, slideBy);
				else if (to !== null) editMove(ids, to);
				return;
			}
			if (cancelled) return;
			// A click: the cursor goes there, and the section under it is selected.
			editSetCursor(at);
			if (!hit) editSelect([]);
			else if (ev.shiftKey || ev.metaKey) editSelect(e.selection.includes(hit.section.id) ? e.selection.filter((id) => id !== hit.section.id) : [...e.selection, hit.section.id]);
			else editSelect([hit.section.id]);
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

	// A click or drag along the ruler moves the cursor.
	const onRulerDown = (ev: ReactPointerEvent): void => {
		if (ev.button !== 0) return;
		const el = ev.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		const to = (clientX: number): void => editSetCursor((clientX - rect.left + (store.get().trackEdit?.scrollX ?? 0)) / view.pxPerBeat);
		to(ev.clientX);
		el.setPointerCapture(ev.pointerId);
		const move = (m: PointerEvent): void => to(m.clientX);
		const up = (): void => {
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
			el.removeEventListener("pointercancel", up);
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
		el.addEventListener("pointercancel", up);
	};

	// The zoom buttons keep the cursor where it is when it is in view (the middle otherwise).
	const cursorX = x(e.cursorBeat);
	const zoomAnchor = cursorX >= 0 && cursorX <= view.width ? cursorX : undefined;
	const some = e.selection.length > 0;
	const canCut = placed.some((p) => e.cursorBeat > p.outBeat + 1e-6 && e.cursorBeat < p.outBeat + p.lengthBeat - 1e-6);
	const style = { ["--hue" as string]: trackHue(track.id) } as CSSProperties;
	return (
		<div className={`bottom-area track-editor${focus ? " focused" : ""}${fileDrop.dropping ? " file-over" : ""}`} data-testid="track-editor" style={style} {...fileDrop.handlers}>
			<div className="edit-head">
				<button className="play" data-testid="edit-play" onClick={toggleEditPreview} disabled={media?.state !== "ready"}>
					{e.playing ? "■" : "▶"}
				</button>
				<div className="edit-title">
					<span className="edit-name" data-testid="edit-name">
						{track.name}
					</span>
					<span className="muted">
						{Number(track.bpm.toFixed(2))} BPM · {fmtLength((total * 60) / track.bpm)}
					</span>
				</div>
				<button className="ghost" data-testid="edit-cut" disabled={!canCut} onClick={editCut}>
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
					<button className="ghost icon" data-testid="edit-zoom-out" onClick={() => editZoom(1 / 1.5, zoomAnchor)}>
						−
					</button>
					<button className="ghost icon" data-testid="edit-zoom-in" onClick={() => editZoom(1.5, zoomAnchor)}>
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
				<button className="primary" data-testid="edit-export" disabled={e.exporting || placed.length === 0} onClick={() => void exportTrackEdit()}>
					{e.exporting ? "Exporting…" : "Export edit"}
				</button>
				<button className="ghost icon" data-testid="edit-close" onClick={closeTrackEdit}>
					✕
				</button>
			</div>
			<div className="edit-body" ref={bodyRef}>
				<div className="edit-ruler-row" data-testid="edit-ruler" onPointerDown={onRulerDown}>
					<EditRuler view={view} lead={lead} phase={phase} bpm={track.bpm} />
				</div>
				<div className="edit-row" data-testid="edit-row" onPointerDown={onDown}>
					<LaneGrid width={view.width} pxPerBeat={view.pxPerBeat} scrollX={view.scrollX - phase * view.pxPerBeat} />
					{lead > 0 && <Block className="edit-section lead" testId="edit-lead" outBeat={0} lengthBeat={lead} startBeat={0} view={view} peaks={peaks} maxes={maxes} marks={marks} projectBpm={doc.bpm} />}
					{shown.map((p, i) => (
						<Block
							key={p.section.id}
							id={p.section.id}
							className={`edit-section${e.selection.includes(p.section.id) ? ` selected${lifted ? " lifted" : ""}` : ""}`}
							testId="edit-section"
							label={`${i + 1} · ${lengthText(p.lengthBeat)}`}
							outBeat={p.outBeat}
							lengthBeat={p.lengthBeat}
							startBeat={p.section.startBeat}
							view={view}
							peaks={peaks}
							maxes={maxes}
							marks={marks}
							projectBpm={doc.bpm}
						/>
					))}
					{shown.length === 0 && <div className="edit-hint">Everything is deleted. Undo to bring sections back.</div>}
					{drop !== null && <div className="edit-drop" style={{ transform: `translateX(${x(boundary(drop))}px)` }} />}
					<div className="edit-cursor" data-testid="edit-cursor" data-beat={e.cursorBeat.toFixed(4)} style={{ transform: `translateX(${x(e.cursorBeat)}px)`, visibility: e.playing ? "hidden" : "visible" }} />
					<EditPlayhead />
				</div>
			</div>
		</div>
	);
}

function Empty() {
	const drop = useFileDrop();
	return (
		<div className={`bottom-area edit-empty${drop.dropping ? " file-over" : ""}`} data-testid="track-editor-empty" {...drop.handlers}>
			Right-click a clip and choose Edit, or drop an audio file here, to cut a track up.
		</div>
	);
}

export function TrackEditor() {
	const e = useStore((s) => s.trackEdit);
	if (!e) return <Empty />;
	return <Editor e={e} />;
}
