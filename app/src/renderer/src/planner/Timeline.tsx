import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { firstBarBeat, LANES, PEAK_BUCKET, SAMPLE_RATE, trackBeats, type Clip, type Cue, type PlannerDoc, type PlannerTrack, type TempoBlock } from "@shared/planner";
import { blocksToPoints, bpmAt, TempoMap } from "@shared/tempo";
import { addTempo, BEAT_GRID_MIN_PX, gridStepBeats, clampScroll, contentBeats, deleteSelection, importPaths, MIN_CLIP_BEATS, NEW_TEMPO_BEATS, parseWholeBpm, setTempoBpm, tempoPoints, toggleMute, toggleSolo, zoomAround } from "./actions";
import { engine } from "./engine";
import { mediaFor, type Media } from "./media";
import { store, useStore } from "./store";

export const GUTTER = 52;

// Below this zoom the beat lines are hidden, so snapping goes to whole bars.

// Everything the user moves lands on whole beats (whole bars when zoomed out); holding Option moves freely.
function snapStep(e: { altKey: boolean }): number {
	return e.altKey ? 0 : gridStepBeats();
}
function snap(beat: number, e: { altKey: boolean }): number {
	const step = snapStep(e);
	return step ? Math.round(beat / step) * step : beat;
}
const EDGE = 8;

function fmtTime(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

// Grid spacing in beats so lines never crowd: beats, then bars, then groups of bars.
function gridStep(pxPerBeat: number, minPx: number): number {
	for (const beats of [1, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]) if (beats * pxPerBeat >= minPx) return beats;
	return 8192;
}

function trackHue(id: string): number {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
	return h % 360;
}

// ---- ruler --------------------------------------------------------------------------

function Ruler({ width }: { width: number }) {
	const ref = useRef<HTMLCanvasElement>(null);
	const pxPerBeat = useStore((s) => s.pxPerBeat);
	const scrollX = useStore((s) => s.scrollX);
	const doc = useStore((s) => s.doc);
	// Times are where each bar is heard in the export, tempo changes included.
	const map = useMemo(() => new TempoMap(tempoPoints(doc), doc.bpm), [doc]);

	useLayoutEffect(() => {
		const cv = ref.current;
		if (!cv) return;
		const dpr = window.devicePixelRatio || 1;
		const h = 30;
		cv.width = Math.max(1, Math.round(width * dpr));
		cv.height = h * dpr;
		const g = cv.getContext("2d")!;
		g.scale(dpr, dpr);
		g.clearRect(0, 0, width, h);
		const label = gridStep(pxPerBeat, 70);
		const tick = gridStep(pxPerBeat, 9);
		g.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
		g.textBaseline = "top";
		const first = Math.floor(scrollX / pxPerBeat / tick) * tick;
		for (let b = first; b * pxPerBeat - scrollX < width; b += tick) {
			const x = Math.round(b * pxPerBeat - scrollX) + 0.5;
			if (x < -1) continue;
			const major = b % label === 0;
			g.strokeStyle = major ? "#5a6072" : "#343846";
			g.beginPath();
			g.moveTo(x, major ? 0 : 22);
			g.lineTo(x, h);
			g.stroke();
			if (major) {
				g.fillStyle = "#c9cedb";
				g.fillText(String(Math.floor(b / 4) + 1), x + 4, 3);
				g.fillStyle = "#7d8496";
				g.fillText(fmtTime(map.secondsAtBeat(b)), x + 4, 15);
			}
		}
	}, [width, pxPerBeat, scrollX, map]);

	const onDown = (e: ReactPointerEvent): void => {
		if (e.button !== 0) return;
		const el = e.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		const beatAt = (x: number): number => Math.max(0, (x - rect.left + store.get().scrollX) / store.get().pxPerBeat);
		engine.seek(snap(beatAt(e.clientX), e));
		el.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent): void => {
			if (!store.get().playing) engine.seek(snap(beatAt(ev.clientX), ev));
		};
		const up = (ev: PointerEvent): void => {
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
			if (store.get().playing) engine.seek(snap(beatAt(ev.clientX), ev));
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
	};

	return (
		<div className="ruler" data-testid="ruler" onPointerDown={onDown}>
			<canvas ref={ref} style={{ width, height: 30 }} />
		</div>
	);
}

// ---- lane grid ----------------------------------------------------------------------

// Grid lines drawn at exact beat positions (same maths as the ruler and clips), so they never
// drift from the beat. The canvas is one device pixel tall and stretched to the lane height.
function LaneGrid({ width, pxPerBeat, scrollX }: { width: number; pxPerBeat: number; scrollX: number }) {
	const ref = useRef<HTMLCanvasElement>(null);

	useLayoutEffect(() => {
		const cv = ref.current;
		if (!cv) return;
		const dpr = window.devicePixelRatio || 1;
		const w = Math.max(1, Math.round(width * dpr));
		cv.width = w;
		cv.height = 1;
		const g = cv.getContext("2d")!;
		g.clearRect(0, 0, w, 1);
		// Every bar line looks the same, and every beat line looks the same and fainter. Beat
		// lines show only when zoomed in far enough; bar lines thin out (evenly) only when
		// they'd be closer than 3 px.
		const showBeats = pxPerBeat >= BEAT_GRID_MIN_PX;
		let barStep = 4;
		while (barStep * pxPerBeat < 3) barStep *= 2;
		const step = showBeats ? 1 : barStep;
		const first = Math.floor(scrollX / pxPerBeat / step) * step;
		const lineW = Math.max(1, Math.round(dpr));
		for (let b = first; b * pxPerBeat - scrollX < width; b += step) {
			const x = Math.round((b * pxPerBeat - scrollX) * dpr);
			if (x < 0) continue;
			g.fillStyle = b % 4 === 0 ? "#252933" : "#17191f";
			g.fillRect(x, 0, lineW, 1);
		}
	}, [width, pxPerBeat, scrollX]);

	return <canvas ref={ref} className="lane-grid" style={{ width }} />;
}

// ---- tempo lane ---------------------------------------------------------------------

const TEMPO_H = 64;
const TEMPO_PAD = 10;

function tempoRange(doc: PlannerDoc): [number, number] {
	let lo = doc.bpm;
	let hi = doc.bpm;
	for (const t of doc.tempos) {
		lo = Math.min(lo, t.bpm);
		hi = Math.max(hi, t.bpm);
	}
	lo -= 6;
	hi += 6;
	if (hi - lo < 24) {
		const mid = (hi + lo) / 2;
		lo = mid - 12;
		hi = mid + 12;
	}
	return [Math.max(1, lo), hi];
}

// The tempo each block ramps from, worked out from the blocks before it.
function rampStarts(doc: PlannerDoc): Map<string, number> {
	const sorted = [...doc.tempos].sort((a, b) => a.startBeat - b.startBeat);
	const pts = blocksToPoints(sorted, doc.bpm);
	return new Map(sorted.map((t, i) => [t.id, pts[2 * i].bpm]));
}

// The whole tempo curve, drawn over the tempo lane so ramps and holds read at a glance.
function TempoCurve({ doc, width, pxPerBeat, scrollX }: { doc: PlannerDoc; width: number; pxPerBeat: number; scrollX: number }) {
	const [lo, hi] = tempoRange(doc);
	const yOf = (bpm: number): number => TEMPO_PAD + ((hi - bpm) / (hi - lo)) * (TEMPO_H - 2 * TEMPO_PAD);
	const xOf = (beat: number): number => beat * pxPerBeat - scrollX;
	const pts = blocksToPoints(doc.tempos, doc.bpm);
	let path = `M${Math.min(0, xOf(0))} ${yOf(doc.bpm)}`;
	for (const p of pts) path += ` L${xOf(p.beat)} ${yOf(p.bpm)}`;
	const lastBpm = pts.length ? pts[pts.length - 1].bpm : doc.bpm;
	path += ` L${width} ${yOf(lastBpm)}`;
	return (
		<svg className="tempo-curve" width={width} height={TEMPO_H}>
			<line x1={0} x2={width} y1={yOf(doc.bpm)} y2={yOf(doc.bpm)} className="tempo-base" />
			<path d={path} className="tempo-line" />
		</svg>
	);
}

type TempoProps = { block: TempoBlock; from: number; pxPerBeat: number; scrollX: number; width: number; selected: boolean; onDown: (e: ReactPointerEvent, item: Item) => void };

function TempoView({ block, from, pxPerBeat, scrollX, width, selected, onDown }: TempoProps) {
	const left = block.startBeat * pxPerBeat - scrollX;
	const w = Math.max(2, block.lengthBeat * pxPerBeat);
	if (left + w < 0 || left > width) return null;
	const labelPad = Math.max(0, -left) + 6;
	return (
		<div
			className={`tempo-block${selected ? " selected" : ""}`}
			style={{ left, width: w }}
			data-testid="tempo-block"
			data-tempo-id={block.id}
			onPointerDown={(e) => onDown(e, { id: block.id, lane: TEMPO_ROW, startBeat: block.startBeat, lengthBeat: block.lengthBeat })}
			onDoubleClick={(e) => {
				e.stopPropagation();
				store.set({ selection: [block.id] });
				focusTempoEditor();
			}}
		>
			<div className="tempo-block-label" style={{ paddingLeft: labelPad }}>
				{Math.round(from)} → {block.bpm}
			</div>
			<div className="trim left" />
			<div className="trim right" />
		</div>
	);
}

// A new or double-clicked tempo change puts the keyboard in its BPM box.
function focusTempoEditor(): void {
	requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="tempo-bpm"]')?.focus());
}

function TempoEditor({ block }: { block: TempoBlock }) {
	const commit = (text: string): void => {
		const v = parseWholeBpm(text);
		if (v !== null) setTempoBpm(block.id, v);
	};
	return (
		<div className="point-editor" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
			<label>
				BPM
				<input
					data-testid="tempo-bpm"
					defaultValue={block.bpm}
					inputMode="numeric"
					onFocus={(e) => e.currentTarget.select()}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							commit(e.currentTarget.value);
							e.currentTarget.blur();
						} else if (e.key === "Escape") {
							e.currentTarget.value = String(block.bpm);
							e.currentTarget.blur();
						}
						e.stopPropagation();
					}}
					onBlur={(e) => commit(e.currentTarget.value)}
				/>
			</label>
			<button data-testid="tempo-delete" onClick={() => deleteSelection()}>
				Delete
			</button>
		</div>
	);
}

// ---- clips --------------------------------------------------------------------------

// Cue points that share a moment share one line.
type CueMark = { beat: number; memory: boolean; letters: string[] };
const SAME_CUE_SEC = 0.003;

function cueMarks(cues: Cue[] | undefined, track: PlannerTrack | undefined): CueMark[] {
	if (!cues || !track) return [];
	const out: CueMark[] = [];
	let lastSec = -Infinity;
	for (const c of [...cues].sort((a, b) => a.sec - b.sec || a.kind - b.kind)) {
		if (c.sec - lastSec > SAME_CUE_SEC) {
			out.push({ beat: (c.sec * track.bpm) / 60, memory: false, letters: [] });
			lastSec = c.sec;
		}
		const m = out[out.length - 1];
		if (c.kind === 0) m.memory = true;
		else if (c.kind <= 26) m.letters.push(String.fromCharCode(64 + c.kind));
	}
	return out;
}

type ClipProps = { clip: Clip; track: PlannerTrack | undefined; media: Media | undefined; cues: Cue[] | undefined; pxPerBeat: number; scrollX: number; width: number; bpm: number; selected: boolean; laneH: number; onDown: (e: ReactPointerEvent, clip: Clip) => void };

function ClipView({ clip, track, media, cues, pxPerBeat, scrollX, width, bpm, selected, laneH, onDown }: ClipProps) {
	const ref = useRef<HTMLCanvasElement>(null);
	const left = clip.startBeat * pxPerBeat - scrollX;
	const w = Math.max(2, clip.lengthBeat * pxPerBeat);
	const visL = Math.max(0, left);
	const visR = Math.min(width, left + w);
	const visible = visR > visL;
	const peaks = media?.state === "ready" ? media.peaks : null;
	const hue = trackHue(track?.id ?? clip.trackId);
	// Scaled so the loudest point in the whole track fills the clip's height.
	const lowMax = useMemo(() => {
		if (!peaks) return 255;
		let l = 1;
		for (let i = 1; i < peaks.length; i += 2) if (peaks[i] > l) l = peaks[i];
		return l;
	}, [peaks]);

	useLayoutEffect(() => {
		const cv = ref.current;
		if (!cv || !visible) return;
		const cssW = Math.max(1, Math.ceil(visR - visL));
		const cssH = cv.clientHeight || 60;
		const dpr = window.devicePixelRatio || 1;
		cv.width = Math.round(cssW * dpr);
		cv.height = Math.round(cssH * dpr);
		const g = cv.getContext("2d")!;
		g.clearRect(0, 0, cv.width, cv.height);
		if (!peaks) return;
		const framesPerBeat = (60 / bpm) * SAMPLE_RATE;
		const bucketsPerPx = framesPerBeat / pxPerBeat / PEAK_BUCKET / dpr;
		const startBucket = ((clip.offsetBeat + (visL - left) / pxPerBeat) * framesPerBeat) / PEAK_BUCKET;
		const mid = cv.height / 2;
		const buckets = peaks.length >> 1;
		const cols = cv.width;
		const lo = new Float32Array(cols);
		for (let x = 0; x < cols; x++) {
			const b0 = Math.floor(startBucket + x * bucketsPerPx);
			const b1 = Math.max(b0 + 1, Math.floor(startBucket + (x + 1) * bucketsPerPx));
			let l = 0;
			for (let b = Math.max(0, b0); b < b1 && b < buckets; b++) if (peaks[b * 2 + 1] > l) l = peaks[b * 2 + 1];
			lo[x] = l / lowMax;
		}
		// The kick band only, so each kick is a sharp spike whose left edge is the hit.
		g.fillStyle = "rgba(255, 255, 255, 0.85)";
		for (let x = 0; x < cols; x++) {
			const hh = Math.min(1, lo[x]) * mid;
			if (hh > 0.25) g.fillRect(x, mid - hh, 1, hh * 2);
		}
	}, [visible, visL, visR, left, pxPerBeat, peaks, lowMax, clip.offsetBeat, bpm, laneH]);

	const marks = useMemo(() => cueMarks(cues, track), [cues, track]);

	if (!visible) return null;
	const status = !track ? "error" : (media?.state ?? "working");
	const style: CSSProperties = { left, width: w, ["--hue" as string]: hue };
	const labelPad = Math.max(0, -left) + 8;
	return (
		<div
			className={`clip ${status}${selected ? " selected" : ""}`}
			style={style}
			data-testid="clip"
			data-clip-id={clip.id}
			data-status={status}
			onPointerDown={(e) => onDown(e, clip)}
			onContextMenu={(e) => {
				e.preventDefault();
				if (!store.get().selection.includes(clip.id)) store.set({ selection: [clip.id] });
				store.set({ menu: { x: e.clientX, y: e.clientY, clipId: clip.id } });
			}}
		>
			<canvas ref={ref} className="wave" style={{ left: visL - left, width: Math.ceil(visR - visL) }} />
			<div className="clip-label" style={{ paddingLeft: labelPad }}>
				<span className="clip-name">{track?.name ?? "Missing track"}</span>
				{track && <span className="clip-bpm">{Number(track.bpm.toFixed(2))}</span>}
			</div>
			{status === "working" && media?.state === "working" && (
				<div className="clip-status" style={{ paddingLeft: labelPad }}>
					Stretching… {Math.round(media.pct * 100)}%
				</div>
			)}
			{status === "working" && media?.state !== "working" && (
				<div className="clip-status" style={{ paddingLeft: labelPad }}>
					Waiting…
				</div>
			)}
			{media?.state === "error" && (
				<div className="clip-status" style={{ paddingLeft: labelPad }}>
					{media.message}
				</div>
			)}
			{marks.map((m) => {
				// Only the cues inside the part of the track this clip shows, and on screen.
				const x = (m.beat - clip.offsetBeat) * pxPerBeat;
				if (m.beat < clip.offsetBeat - 1e-6 || m.beat >= clip.offsetBeat + clip.lengthBeat || left + x < -12 || left + x > width + 12) return null;
				return (
					<div key={m.beat} className={`cue${m.memory ? " memory" : ""}${m.letters.length ? " hot" : ""}`} style={{ left: Math.round(left + x) - left }} data-testid="cue" data-cue={`${m.memory ? "M" : ""}${m.letters.join("")}`}>
						{m.letters.map((l) => (
							<span key={l}>{l}</span>
						))}
					</div>
				);
			})}
			<div className="trim left" />
			<div className="trim right" />
		</div>
	);
}

// ---- lanes --------------------------------------------------------------------------

// The tempo lane sits above the clip lanes; clips and tempo changes are edited the same way.
const TEMPO_ROW = -1;
type Item = { id: string; lane: number; startBeat: number; lengthBeat: number };

function Lanes({ width }: { width: number }) {
	const doc = useStore((s) => s.doc);
	const pxPerBeat = useStore((s) => s.pxPerBeat);
	const scrollX = useStore((s) => s.scrollX);
	const selection = useStore((s) => s.selection);
	const cues = useStore((s) => s.cues);
	useStore((s) => s.mediaRev);
	useStore((s) => s.progressRev);
	const laneH = useStore((s) => s.viewportH);
	const ref = useRef<HTMLDivElement>(null);
	const clipLanesRef = useRef<HTMLDivElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const tracks = useMemo(() => new Map(doc.tracks.map((t) => [t.id, t])), [doc.tracks]);
	const starts = useMemo(() => rampStarts(doc), [doc]);

	const beatAt = (clientX: number): number => {
		const r = ref.current!.getBoundingClientRect();
		const s = store.get();
		return (clientX - r.left + s.scrollX) / s.pxPerBeat;
	};
	// Row under a y position: the tempo lane, or a clip lane.
	const rowAt = (clientY: number): number => {
		const r = clipLanesRef.current!.getBoundingClientRect();
		if (clientY < r.top) return TEMPO_ROW;
		return Math.min(LANES - 1, Math.floor(((clientY - r.top) / r.height) * LANES));
	};
	const laneAt = (clientY: number): number => Math.max(0, rowAt(clientY));
	const itemsIn = (doc: PlannerDoc, row: number): Item[] => (row === TEMPO_ROW ? doc.tempos.map((t) => ({ ...t, lane: TEMPO_ROW })) : doc.clips.filter((c) => c.lane === row));

	const onItemDown = (e: ReactPointerEvent, item: Item): void => {
		if (e.button !== 0) return;
		e.stopPropagation();
		store.set({ menu: null });
		const el = e.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		const edge = Math.min(EDGE, rect.width / 4);
		const zone = e.clientX - rect.left < edge ? "left" : rect.right - e.clientX < edge ? "right" : "move";
		const s0 = store.get();
		const wasSelected = s0.selection.includes(item.id);
		if (e.shiftKey) store.set({ selection: wasSelected ? s0.selection.filter((id) => id !== item.id) : [...s0.selection, item.id] });
		else if (!wasSelected || zone !== "move") store.set({ selection: [item.id] });

		const base = store.get().doc;
		const moving = new Set(zone === "move" ? store.get().selection : [item.id]);
		if (zone === "move" && !moving.has(item.id)) return; // shift-click that deselected
		const isTempo = item.lane === TEMPO_ROW;
		const clip = isTempo ? null : (base.clips.find((c) => c.id === item.id) ?? null);
		const grabBeat = beatAt(e.clientX);
		const sx = e.clientX;
		const sy = e.clientY;
		const track = clip && base.tracks.find((t) => t.id === clip.trackId);
		const maxBeats = clip ? (track ? trackBeats(track) : clip.offsetBeat + clip.lengthBeat) : Infinity;
		const offset = clip ? clip.offsetBeat : Infinity;
		const group = [...base.clips.filter((c) => moving.has(c.id)), ...base.tempos.filter((t) => moving.has(t.id))];
		const groupClips = base.clips.filter((c) => moving.has(c.id));
		const minStart = Math.min(...group.map((c) => c.startBeat));
		const minLane = Math.min(...groupClips.map((c) => c.lane));
		const maxLane = Math.max(...groupClips.map((c) => c.lane));
		// A clip from a Rekordbox track is moved by its bar line, not its left edge, so its
		// beats stay on the grid however the clip has been trimmed or split.
		const bar = zone === "move" && clip && track ? firstBarBeat(track) : null;
		const anchor = clip && bar !== null ? clip.startBeat - clip.offsetBeat + bar : item.startBeat;
		let moved = false;
		let lastEvent: PointerEvent | null = null;
		let scrollTimer: ReturnType<typeof setInterval> | undefined;

		const apply = (ev: PointerEvent): void => {
			let d = beatAt(ev.clientX) - grabBeat;
			// Snap the edge being moved (the grabbed item's start, or the trimmed edge) to a beat.
			if (zone === "right") d = snap(item.startBeat + item.lengthBeat + d, ev) - (item.startBeat + item.lengthBeat);
			else d = snap(anchor + d, ev) - anchor;
			if (zone === "move") {
				if (d < -minStart) {
					// Against the start of the timeline: the nearest grid position that still fits.
					const step = bar !== null ? snapStep(ev) : 0;
					d = step ? Math.ceil((anchor - minStart) / step - 1e-9) * step - anchor : -minStart;
				}
				// Clips can change lanes when a clip is grabbed; tempo changes stay in their lane.
				const dl = isTempo || groupClips.length === 0 ? 0 : Math.min(LANES - 1 - maxLane, Math.max(-minLane, laneAt(ev.clientY) - item.lane));
				store.transient({
					...base,
					clips: base.clips.map((c) => (moving.has(c.id) ? { ...c, startBeat: c.startBeat + d, lane: c.lane + dl } : c)),
					tempos: base.tempos.map((t) => (moving.has(t.id) ? { ...t, startBeat: t.startBeat + d } : t)),
				});
			} else if (zone === "left") {
				d = Math.min(item.lengthBeat - MIN_CLIP_BEATS, Math.max(d, -offset, -item.startBeat));
				if (isTempo) store.transient({ ...base, tempos: base.tempos.map((t) => (t.id === item.id ? { ...t, startBeat: t.startBeat + d, lengthBeat: t.lengthBeat - d } : t)) });
				else store.transient({ ...base, clips: base.clips.map((c) => (c.id === item.id ? { ...c, startBeat: c.startBeat + d, offsetBeat: c.offsetBeat + d, lengthBeat: c.lengthBeat - d } : c)) });
			} else {
				const room = clip ? maxBeats - clip.offsetBeat - clip.lengthBeat : Infinity;
				d = Math.min(room, Math.max(d, MIN_CLIP_BEATS - item.lengthBeat));
				if (isTempo) store.transient({ ...base, tempos: base.tempos.map((t) => (t.id === item.id ? { ...t, lengthBeat: t.lengthBeat + d } : t)) });
				else store.transient({ ...base, clips: base.clips.map((c) => (c.id === item.id ? { ...c, lengthBeat: c.lengthBeat + d } : c)) });
			}
		};
		// Dragging against the left or right edge scrolls the timeline.
		const autoScroll = (): void => {
			const ev = lastEvent;
			if (!ev || !ref.current) return;
			const r = ref.current.getBoundingClientRect();
			const s = store.get();
			let dx = 0;
			if (ev.clientX > r.right - 30) dx = 18;
			else if (ev.clientX < r.left + 30) dx = -18;
			if (dx === 0) return;
			const next = clampScroll(s.scrollX + dx, s.pxPerBeat);
			if (next !== s.scrollX) {
				store.set({ scrollX: next });
				apply(ev);
			}
		};
		const move = (ev: PointerEvent): void => {
			if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
			if (!moved) {
				moved = true;
				store.beginDrag();
				document.body.classList.add(zone === "move" ? "dragging-move" : "dragging-trim");
				scrollTimer = setInterval(autoScroll, 30);
			}
			lastEvent = ev;
			apply(ev);
		};
		const finish = (cancel: boolean): void => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("keydown", key, true);
			clearInterval(scrollTimer);
			document.body.classList.remove("dragging-move", "dragging-trim");
			if (moved) {
				if (cancel) store.cancelDrag();
				else store.endDrag();
			} else if (!e.shiftKey && zone === "move") {
				store.set({ selection: [item.id] });
			}
		};
		const up = (): void => finish(false);
		const key = (ev: KeyboardEvent): void => {
			if (ev.key === "Escape") {
				ev.stopPropagation();
				finish(true);
			}
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("keydown", key, true);
	};
	const onClipDown = (e: ReactPointerEvent, clip: Clip): void => onItemDown(e, clip);

	// Click on empty space moves the playhead; dragging draws a box that selects clips and tempo changes.
	const onBackgroundDown = (e: ReactPointerEvent): void => {
		if (e.button !== 0) return;
		store.set({ menu: null });
		const el = ref.current!;
		const sx = e.clientX;
		const sy = e.clientY;
		const startBeat = beatAt(sx);
		const keep = e.shiftKey ? store.get().selection : [];
		let moved = false;
		const move = (ev: PointerEvent): void => {
			if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
			moved = true;
			const r = el.getBoundingClientRect();
			const s = store.get();
			const b0 = Math.min(startBeat, beatAt(ev.clientX));
			const b1 = Math.max(startBeat, beatAt(ev.clientX));
			const top = Math.max(r.top, Math.min(sy, ev.clientY));
			const bottom = Math.min(r.bottom - 1, Math.max(sy, ev.clientY));
			const l0 = rowAt(top);
			const l1 = rowAt(bottom);
			const hit: string[] = [];
			for (let row = l0; row <= l1; row++) for (const c of itemsIn(s.doc, row)) if (c.startBeat < b1 && c.startBeat + c.lengthBeat > b0) hit.push(c.id);
			store.set({ selection: [...new Set([...keep, ...hit])] });
			const box = boxRef.current;
			if (box) {
				box.style.display = "block";
				box.style.left = `${b0 * s.pxPerBeat - s.scrollX}px`;
				box.style.width = `${(b1 - b0) * s.pxPerBeat}px`;
				box.style.top = `${top - r.top}px`;
				box.style.height = `${bottom - top}px`;
			}
		};
		const up = (): void => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			if (boxRef.current) boxRef.current.style.display = "none";
			if (!moved) {
				if (!e.shiftKey) store.set({ selection: [] });
				engine.seek(Math.max(0, snap(startBeat, e)));
			}
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	const onDrop = (e: ReactDragEvent): void => {
		e.preventDefault();
		const paths: string[] = [];
		const custom = e.dataTransfer.getData("application/x-dj-path");
		if (custom) paths.push(custom);
		for (const f of Array.from(e.dataTransfer.files)) {
			const p = window.api.pathForFile(f);
			if (p) paths.push(p);
		}
		if (paths.length) void importPaths(paths, laneAt(e.clientY), Math.max(0, snap(beatAt(e.clientX), e)));
	};

	const selTempo = selection.length === 1 ? doc.tempos.find((t) => t.id === selection[0]) : undefined;

	return (
		<div
			className="lanes"
			ref={ref}
			data-testid="lanes"
			onPointerDown={onBackgroundDown}
			onContextMenu={(e) => e.preventDefault()}
			onDragOver={(e) => {
				e.preventDefault();
				e.dataTransfer.dropEffect = "copy";
			}}
			onDrop={onDrop}
		>
			<div
				className="lane tempo-lane"
				data-testid="tempo-lane"
				onDoubleClick={(e) => {
					// A new tempo change starts out at the tempo already playing there.
					const beat = Math.max(0, snap(beatAt(e.clientX), e));
					const d = store.get().doc;
					addTempo(beat, NEW_TEMPO_BEATS, bpmAt(tempoPoints(d), d.bpm, beat));
					focusTempoEditor();
				}}
			>
				<LaneGrid width={width} pxPerBeat={pxPerBeat} scrollX={scrollX} />
				{doc.tempos.map((t) => (
					<TempoView key={t.id} block={t} from={starts.get(t.id) ?? doc.bpm} pxPerBeat={pxPerBeat} scrollX={scrollX} width={width} selected={selection.includes(t.id)} onDown={onItemDown} />
				))}
				<TempoCurve doc={doc} width={width} pxPerBeat={pxPerBeat} scrollX={scrollX} />
				{doc.tempos.length === 0 && <div className="tempo-hint">Double-click to add a tempo change. Tempo changes are applied when you export.</div>}
				{selTempo && <TempoEditor key={selTempo.id + selTempo.bpm} block={selTempo} />}
			</div>
			<div className="clip-lanes" ref={clipLanesRef}>
				{Array.from({ length: LANES }, (_, lane) => (
					<div className="lane" key={lane} data-testid={`lane-${lane}`}>
							<LaneGrid width={width} pxPerBeat={pxPerBeat} scrollX={scrollX} />
						{doc.clips
							.filter((c) => c.lane === lane)
							.map((c) => {
								const t = tracks.get(c.trackId);
								return <ClipView key={c.id} clip={c} track={t} media={mediaFor(t, doc.bpm)} cues={t && cues[t.sourcePath]} pxPerBeat={pxPerBeat} scrollX={scrollX} width={width} bpm={doc.bpm} selected={selection.includes(c.id)} laneH={laneH} onDown={onClipDown} />;
							})}
					</div>
				))}
				{doc.clips.length === 0 && <div className="empty-hint">Drop audio files here</div>}
			</div>
			<div className="marquee" ref={boxRef} />
		</div>
	);
}

// ---- playhead and scrollbar ---------------------------------------------------------

function Playhead() {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let raf = 0;
		const frame = (): void => {
			raf = requestAnimationFrame(frame);
			const el = ref.current;
			if (!el) return;
			const s = store.get();
			const beat = engine.positionBeat();
			const x = beat * s.pxPerBeat - s.scrollX;
			const hidden = x < -1 || x > s.viewportW + 1;
			el.style.visibility = hidden ? "hidden" : "visible";
			el.style.transform = `translateX(${x}px)`;
			el.dataset.beat = beat.toFixed(4);
		};
		raf = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(raf);
	}, []);
	return <div className="playhead" ref={ref} data-testid="playhead" />;
}

function Scrollbar({ width }: { width: number }) {
	const doc = useStore((s) => s.doc);
	const pxPerBeat = useStore((s) => s.pxPerBeat);
	const scrollX = useStore((s) => s.scrollX);
	const total = Math.max(width, (contentBeats(doc) + 64) * pxPerBeat + width * 0.5, scrollX + width);
	const thumbW = Math.max(30, (width / total) * width);
	const span = Math.max(1, total - width);
	const thumbX = (scrollX / span) * (width - thumbW);
	const onDown = (e: ReactPointerEvent): void => {
		const el = e.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		const onThumb = (e.target as HTMLElement).classList.contains("scroll-thumb");
		const grab = onThumb ? e.clientX - rect.left - thumbX : thumbW / 2;
		const to = (x: number): void => {
			const frac = Math.min(1, Math.max(0, (x - rect.left - grab) / Math.max(1, width - thumbW)));
			store.set({ scrollX: clampScroll(frac * span, store.get().pxPerBeat) });
		};
		to(e.clientX);
		el.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent): void => to(ev.clientX);
		const up = (): void => {
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
	};
	return (
		<div className="scrollbar" onPointerDown={onDown}>
			<div className="scroll-thumb" style={{ width: thumbW, transform: `translateX(${thumbX}px)` }} />
		</div>
	);
}

// ---- timeline -----------------------------------------------------------------------

export function Timeline() {
	const mainRef = useRef<HTMLDivElement>(null);
	const width = useStore((s) => s.viewportW);
	const laneMuted = useStore((s) => s.laneMuted);
	const soloLane = useStore((s) => s.soloLane);

	useLayoutEffect(() => {
		const el = mainRef.current!;
		const measure = (): void => store.set({ viewportW: el.clientWidth, viewportH: el.clientHeight });
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		measure();
		return () => ro.disconnect();
	}, []);

	useEffect(() => {
		const el = mainRef.current!;
		const wheel = (e: WheelEvent): void => {
			e.preventDefault();
			const s = store.get();
			if (e.ctrlKey || e.metaKey) {
				const rect = el.getBoundingClientRect();
				zoomAround(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left);
			} else {
				const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
				store.set({ scrollX: clampScroll(s.scrollX + d, s.pxPerBeat) });
			}
		};
		el.addEventListener("wheel", wheel, { passive: false });
		return () => el.removeEventListener("wheel", wheel);
	}, []);

	return (
		<div className="timeline">
			<div className="gutter">
				<div className="gutter-cell ruler-cell" />
				<div className="gutter-cell tempo-cell">BPM</div>
				<div className="gutter-lanes">
					{Array.from({ length: LANES }, (_, i) => (
						<div className="gutter-cell lane-cell" key={i}>
							<span>{i + 1}</span>
							<button
								className={`mute-btn${laneMuted[i] ? " muted" : ""}${soloLane === i ? " solo" : ""}`}
								data-testid={`mute-${i}`}
								title={soloLane === i ? "Soloed: ⌘-click to unsolo" : laneMuted[i] ? "Unmute (⌘-click to solo)" : "Mute (⌘-click to solo)"}
								aria-label={laneMuted[i] ? `Unmute lane ${i + 1}` : `Mute lane ${i + 1}`}
								onClick={(e) => (e.metaKey ? toggleSolo(i) : toggleMute(i))}
							/>
						</div>
					))}
				</div>
				<div className="gutter-cell scroll-cell" />
			</div>
			<div className="timeline-main" ref={mainRef} data-testid="timeline">
				<Ruler width={width} />
				<Lanes width={width} />
				<Scrollbar width={width} />
				<Playhead />
			</div>
		</div>
	);
}
