// The track editor in the bottom part of the window: one track, cut into sections that can
// be removed, copied and put in another order, then exported as a file. With a second track
// opened next to it there are three lanes: each track laid out whole, to cut pieces from, and
// under them the edit those pieces are put together in.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { PEAK_BUCKET, SAMPLE_RATE } from "@shared/planner";
import { barPhase, insertSections, leadBeat, place, slideSections, srcOf, type EditSection, type Placed } from "@shared/trackEdit";
import { editPositionBeat, toggleEditPreview } from "./editPlayer";
import { openFileInEditor } from "./actions";
import { mediaFor } from "./media";
import { fmtLength } from "./Panels";
import { store, useStore, type EditLane, type TrackEditUi } from "./store";
import { cueMarks, LaneGrid, trackHue, type CueMark } from "./Timeline";
import { closeTrackEdit, editAddSelected, editCanCut, editCut, editCutAt, editDelete, editDuplicate, editFit, editInsert, editMove, editPieces, editPx, editRedo, editRemoveTrack, editResize, editScroll, editSectionsOf, editSelect, editSetCursor, editSlide, editStep, editTotal, editUndo, editZoom, exportTrackEdit, laneOffset, laneTrack } from "./trackEdit";
import { drawBand, peakMax, sizeCanvas } from "./wave";

const FROM_EDITOR = "application/x-dj-from-editor";

type View = { pxPerBeat: number; scrollX: number; width: number };

// One stretch of a track, drawn where it lands along the ruler, in the track's colour.
function Block({ outBeat, lengthBeat, startBeat, view, peaks, maxes, marks, hue, projectBpm, className, label, testId, id }: { outBeat: number; lengthBeat: number; startBeat: number; view: View; peaks: Uint8Array | null; maxes: [number, number]; marks: CueMark[]; hue: number; projectBpm: number; className: string; label?: string; testId: string; id?: string }) {
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
		<div className={className} style={{ left, width: w, ["--hue" as string]: hue } as CSSProperties} data-testid={testId} data-section-id={id}>
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

// The colours of the two tracks: each track's own, unless they are too close to tell apart.
function laneHues(e: TrackEditUi): [number, number] {
	const a = trackHue(e.track.id);
	if (!e.second) return [a, a];
	const b = trackHue(e.second.id);
	return [a, Math.abs(((b - a + 540) % 360) - 180) < 50 ? (a + 150) % 360 : b];
}

const bpmText = (bpm: number): string => String(Number(bpm.toFixed(2)));

function Editor({ e }: { e: TrackEditUi }) {
	const doc = useStore((s) => s.doc);
	const focus = useStore((s) => s.editFocus);
	useStore((s) => s.mediaRev);
	const cues0 = useStore((s) => s.cues[e.track.sourcePath]);
	const cues1 = useStore((s) => (e.second ? s.cues[e.second.sourcePath] : undefined));
	const marks0 = useMemo(() => cueMarks(cues0, e.track), [cues0, e.track]);
	const marks1 = useMemo(() => (e.second ? cueMarks(cues1, e.second) : []), [cues1, e.second]);
	const lanesRef = useRef<HTMLDivElement>(null);
	const outRef = useRef<HTMLDivElement>(null);
	const [drop, setDrop] = useState<number | null>(null); // where a dragged section would land
	const [lifted, setLifted] = useState(false); // the selected sections are being dragged
	const [sliding, setSliding] = useState<EditSection[] | null>(null); // the sections as an ⌥-drag would leave them
	// Pieces of a track on their way to the edit: the edit as it would be with them dropped
	// here, or, while they are not over it, where the pointer is carrying them.
	const [incoming, setIncoming] = useState<{ sections: EditSection[]; ids: string[] } | null>(null);
	const [carry, setCarry] = useState<{ x: number; y: number; width: number; hue: number; label: string } | null>(null);
	const fileDrop = useFileDrop();

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

	const track = e.track;
	const multi = e.second !== null;
	const lead = leadBeat(track);
	const phase = barPhase(track);
	const placed = useMemo(() => place(lead, e.sections), [lead, e.sections]);
	const shown = useMemo(() => (incoming ? place(lead, incoming.sections) : sliding ? place(lead, sliding) : placed), [lead, incoming, sliding, placed]);
	const total = editTotal(e);
	const view: View = { pxPerBeat: editPx(e), scrollX: e.scrollX, width: e.width };
	const media = mediaFor(track, doc.bpm);
	const media1 = e.second ? mediaFor(e.second, doc.bpm) : null;
	const peaks0 = media?.state === "ready" ? media.peaks : null;
	const peaks1 = media1?.state === "ready" ? media1.peaks : null;
	const maxes0 = useMemo((): [number, number] => [peakMax(peaks0, 0), peakMax(peaks0, 1)], [peaks0]);
	const maxes1 = useMemo((): [number, number] => [peakMax(peaks1, 0), peakMax(peaks1, 1)], [peaks1]);
	const hues = laneHues(e);
	// The tracks, each with what it takes to draw a stretch of it.
	const sources = ([0, 1] as const).flatMap((i) => {
		const t = laneTrack(e, i);
		return t ? [{ i, track: t, off: laneOffset(e, i), lead: leadBeat(t), pieces: editPieces(e, i), peaks: i === 0 ? peaks0 : peaks1, maxes: i === 0 ? maxes0 : maxes1, marks: i === 0 ? marks0 : marks1, hue: hues[i] }] : [];
	});
	type Source = (typeof sources)[number];
	const x = (beat: number): number => beat * view.pxPerBeat - view.scrollX;
	// The place along the ruler under the pointer, in beats. Every lane starts at the same edge.
	const beatAt = (clientX: number): number => (clientX - lanesRef.current!.getBoundingClientRect().left + (store.get().trackEdit?.scrollX ?? 0)) / view.pxPerBeat;

	// Where a section dropped before the section at `index` lands, in beats of the edit.
	const boundary = (index: number): number => {
		const p = placed.find((q) => e.sections.indexOf(q.section) >= index);
		return p ? p.outBeat : total;
	};

	// A press on the edit: a click moves the cursor and selects, a drag moves sections.
	const onDown = (ev: ReactPointerEvent): void => {
		if (ev.button !== 0) return;
		const row = ev.currentTarget as HTMLElement;
		const at = beatAt(ev.clientX);
		// S is held (set in App.tsx): a click cuts there, as on the timeline.
		if (document.body.classList.contains("split-tool")) {
			editCutAt(at, "out");
			return;
		}
		const hit: Placed<EditSection> | undefined = placed.find((p) => at >= p.outBeat && at < p.outBeat + p.lengthBeat);
		const selection = e.lane === "out" ? e.selection : [];
		const ids = hit ? (selection.includes(hit.section.id) ? selection : [hit.section.id]) : [];
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
				editSelect(ids, "out");
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
			editSetCursor(at, "out");
			if (!hit) editSelect([], "out");
			else if (ev.shiftKey || ev.metaKey) editSelect(selection.includes(hit.section.id) ? selection.filter((id) => id !== hit.section.id) : [...selection, hit.section.id], "out");
			else editSelect([hit.section.id], "out");
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

	// A press on a track's own lane: a click moves the cursor there and selects the piece under
	// it; a drag carries the selected pieces down to the edit, which shows where they would
	// land. The track's lane keeps them: a piece can be used as often as wanted.
	const onSourceDown = (so: Source) => (ev: ReactPointerEvent): void => {
		if (ev.button !== 0) return;
		const row = ev.currentTarget as HTMLElement;
		const at = beatAt(ev.clientX);
		if (document.body.classList.contains("split-tool")) {
			editCutAt(at, so.i);
			return;
		}
		const hit = so.pieces.find((p) => at - so.off >= p.startBeat && at - so.off < p.startBeat + p.lengthBeat);
		const selection = e.lane === so.i ? e.selection : [];
		const ids = hit ? (selection.includes(hit.id) ? selection : [hit.id]) : [];
		const carried = so.pieces.filter((p) => ids.includes(p.id));
		const grab = carried.length > 0 ? at - (so.off + carried[0].startBeat) : 0; // from the first piece's start to the pointer
		const width = carried.reduce((n, p) => n + p.lengthBeat, 0) * view.pxPerBeat;
		const step = editStep(e);
		const downX = ev.clientX;
		const downY = ev.clientY;
		let dragging = false;
		let added: EditSection[] = [];
		let target: { pointer: number; start: number } | null = null; // where a drop would put them
		row.setPointerCapture(ev.pointerId);
		const move = (m: PointerEvent): void => {
			if (!dragging && hit && Math.hypot(m.clientX - downX, m.clientY - downY) > 4) {
				dragging = true;
				document.body.classList.add("dragging-move");
				editSelect(ids, so.i);
				added = editSectionsOf(e, so.i, ids);
			}
			if (!dragging) return;
			// Anywhere from the edit's lane down counts as over it.
			if (m.clientY >= outRef.current!.getBoundingClientRect().top) {
				const pointer = Math.max(lead, beatAt(m.clientX));
				target = { pointer, start: lead + Math.round((pointer - grab - lead) / step) * step };
				setCarry(null);
				setIncoming({ sections: insertSections(lead, e.sections, added, target.pointer, target.start), ids: added.map((s) => s.id) });
			} else {
				target = null;
				setIncoming(null);
				setCarry({ x: m.clientX - grab * view.pxPerBeat, y: m.clientY, width, hue: so.hue, label: lengthText(carried.reduce((n, p) => n + p.lengthBeat, 0)) });
			}
		};
		const end = (cancelled: boolean): void => {
			row.removeEventListener("pointermove", move);
			row.removeEventListener("pointerup", up);
			row.removeEventListener("pointercancel", cancel);
			window.removeEventListener("keydown", key, true);
			document.body.classList.remove("dragging-move");
			setIncoming(null);
			setCarry(null);
			if (dragging) {
				if (!cancelled && target) editInsert(added, target.pointer, target.start);
				return;
			}
			if (cancelled) return;
			// A click: the cursor goes there, and the piece under it is selected.
			editSetCursor(at, so.i);
			if (!hit) editSelect([], so.i);
			else if (ev.shiftKey || ev.metaKey) editSelect(selection.includes(hit.id) ? selection.filter((id) => id !== hit.id) : [...selection, hit.id], so.i);
			else editSelect([hit.id], so.i);
		};
		const up = (): void => end(false);
		const cancel = (): void => end(true);
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

	// The cursor and the preview's line, on the lane the keys act on.
	const marksOn = (lane: EditLane) =>
		e.lane === lane && (
			<>
				<div className="edit-cursor" data-testid="edit-cursor" data-beat={e.cursorBeat.toFixed(4)} style={{ transform: `translateX(${x(e.cursorBeat)}px)`, visibility: e.playing ? "hidden" : "visible" }} />
				<EditPlayhead />
			</>
		);

	// The zoom buttons keep the cursor where it is when it is in view (the middle otherwise).
	const cursorX = x(e.cursorBeat);
	const zoomAnchor = cursorX >= 0 && cursorX <= view.width ? cursorX : undefined;
	const some = e.selection.length > 0;
	const onEdit = e.lane === "out";
	const grid = <LaneGrid width={view.width} pxPerBeat={view.pxPerBeat} scrollX={view.scrollX - phase * view.pxPerBeat} />;
	// The edit opens with the first track's lead-in, unless its first section is the other track's.
	const ownLead = lead > 0 && (shown.length === 0 || srcOf(shown[0].section) === 0);
	const style = { ["--hue" as string]: hues[0] } as CSSProperties;
	return (
		<div className={`bottom-area track-editor${multi ? " multi" : ""}${focus ? " focused" : ""}${fileDrop.dropping ? " file-over" : ""}`} data-testid="track-editor" style={style} {...fileDrop.handlers}>
			<div className="edit-head">
				<button className="play" data-testid="edit-play" onClick={toggleEditPreview} disabled={media?.state !== "ready"}>
					{e.playing ? "■" : "▶"}
				</button>
				<div className="edit-title">
					<span className="edit-name" data-testid="edit-name">
						{track.name}
					</span>
					<span className="muted">
						{bpmText(track.bpm)} BPM · {fmtLength((total * 60) / track.bpm)}
					</span>
				</div>
				<button className="ghost" data-testid="edit-cut" disabled={!editCanCut(e)} onClick={editCut}>
					Cut
				</button>
				{multi && (
					<button className="ghost" data-testid="edit-add" disabled={onEdit || !some} onClick={editAddSelected}>
						Add to edit
					</button>
				)}
				<button className="ghost" data-testid="edit-duplicate" disabled={!onEdit || !some} onClick={editDuplicate}>
					Duplicate
				</button>
				<button className="ghost" data-testid="edit-delete" disabled={!onEdit || !some} onClick={editDelete}>
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
			<div className="edit-body">
				{multi && (
					// What each lane is: the two tracks, then the edit made of their pieces.
					<div className="edit-gutter">
						{sources.map((so) => (
							<div key={so.i} className={`edit-lane-head${e.lane === so.i ? " active" : ""}`} data-testid={`edit-lane-${so.i}`} style={{ ["--hue" as string]: so.hue } as CSSProperties} onPointerDown={() => editSelect([], so.i)}>
								<span className="edit-lane-key">{"AB"[so.i]}</span>
								<div className="edit-lane-text">
									<span className="edit-lane-name">{so.track.name}</span>
									<span className="muted">{Math.abs(so.track.bpm - track.bpm) < 1e-9 ? `${bpmText(so.track.bpm)} BPM` : `${bpmText(so.track.bpm)} → ${bpmText(track.bpm)} BPM`}</span>
								</div>
								<button className="ghost icon" data-testid={`edit-remove-${so.i}`} onPointerDown={(ev) => ev.stopPropagation()} onClick={() => editRemoveTrack(so.i)}>
									✕
								</button>
							</div>
						))}
						<div className={`edit-lane-head out${onEdit ? " active" : ""}`} data-testid="edit-lane-out" onPointerDown={() => editSelect([], "out")}>
							<span className="edit-lane-key">▸</span>
							<div className="edit-lane-text">
								<span className="edit-lane-name">Edit</span>
								<span className="muted">
									{bpmText(track.bpm)} BPM · {fmtLength((total * 60) / track.bpm)}
								</span>
							</div>
						</div>
					</div>
				)}
				<div className="edit-lanes" ref={lanesRef}>
					{multi &&
						sources.map((so) => (
							<div key={so.i} className={`edit-row source${e.lane === so.i ? " active" : ""}`} data-testid={`edit-source-${so.i}`} onPointerDown={onSourceDown(so)} onDoubleClick={editAddSelected}>
								{grid}
								{so.lead > 0 && <Block className="edit-section lead" testId="edit-piece-lead" outBeat={so.off} lengthBeat={so.lead} startBeat={0} view={view} peaks={so.peaks} maxes={so.maxes} marks={so.marks} hue={so.hue} projectBpm={doc.bpm} />}
								{so.pieces.map((p) => (
									<Block
										key={p.id}
										id={p.id}
										className={`edit-section piece${e.lane === so.i && e.selection.includes(p.id) ? " selected" : ""}`}
										testId="edit-piece"
										label={lengthText(p.lengthBeat)}
										outBeat={so.off + p.startBeat}
										lengthBeat={p.lengthBeat}
										startBeat={p.startBeat}
										view={view}
										peaks={so.peaks}
										maxes={so.maxes}
										marks={so.marks}
										hue={so.hue}
										projectBpm={doc.bpm}
									/>
								))}
								{/* A line under every stretch of the track that is in the edit already. */}
								{placed
									.filter((p) => srcOf(p.section) === so.i)
									.map((p) => (
										<div key={p.section.id} className="edit-used" style={{ left: x(so.off + p.section.startBeat), width: p.lengthBeat * view.pxPerBeat, ["--hue" as string]: so.hue } as CSSProperties} />
									))}
								{marksOn(so.i)}
							</div>
						))}
					<div className={`edit-row out${onEdit ? " active" : ""}`} data-testid="edit-row" ref={outRef} onPointerDown={onDown}>
						{grid}
						{ownLead && <Block className="edit-section lead" testId="edit-lead" outBeat={0} lengthBeat={lead} startBeat={0} view={view} peaks={peaks0} maxes={maxes0} marks={marks0} hue={hues[0]} projectBpm={doc.bpm} />}
						{shown.map((p, i) => {
							const so = sources[srcOf(p.section)] ?? sources[0];
							const selected = onEdit && e.selection.includes(p.section.id);
							return (
								<Block
									key={p.section.id}
									id={p.section.id}
									className={`edit-section${selected ? ` selected${lifted ? " lifted" : ""}` : ""}${incoming?.ids.includes(p.section.id) ? " incoming" : ""}`}
									testId="edit-section"
									label={`${i + 1} · ${lengthText(p.lengthBeat)}`}
									outBeat={p.outBeat}
									lengthBeat={p.lengthBeat}
									startBeat={p.section.startBeat}
									view={view}
									peaks={so.peaks}
									maxes={so.maxes}
									marks={so.marks}
									hue={so.hue}
									projectBpm={doc.bpm}
								/>
							);
						})}
						{shown.length === 0 && <div className="edit-hint">{multi ? "Drag pieces of the tracks above down here." : "Everything is deleted. Undo to bring sections back."}</div>}
						{drop !== null && <div className="edit-drop" style={{ transform: `translateX(${x(boundary(drop))}px)` }} />}
						{marksOn("out")}
					</div>
				</div>
				{carry && (
					<div className="edit-carry" style={{ left: carry.x, top: carry.y - 18, width: Math.max(24, carry.width), ["--hue" as string]: carry.hue } as CSSProperties}>
						{carry.label}
					</div>
				)}
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
