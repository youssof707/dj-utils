// The library panel: Rekordbox's tracks and playlists, to search, sort and add to the set. Read-only.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { RekordboxLibrary, RekordboxPlaylist, RekordboxTag, RekordboxTrack, TagChangeResult } from "@shared/planner";
import { snapBpm } from "@shared/tempo";
import { startLibraryDrag } from "./libraryDrag";
import { libraryPreviewAt, playLibraryPreview, stopLibraryPreview, useLibraryPreview } from "./libraryPreview";
import { hueVars, keyHue } from "./Timeline";
import { setTrackKeys } from "./trackKeys";
import { NO_FILTER, store, useStore, type LibraryFilter, type LibrarySort } from "./store";
import { TagModal } from "./TagModal";
import { plain } from "./text";
import { VersionChip } from "../VersionChip";

// Where the last press on a row was, to tell a click from the end of a drag.
let pressedAt: { x: number; y: number } | null = null;

const ROW = 50; // px; every row is the same height, so only the rows in view are drawn
const SPARE = 6; // rows drawn beyond each edge of the view

// The panel's width is dragged from its right edge and survives restarts.
const WIDTH_KEY = "planner.libraryWidth";
const WIDTH_DEFAULT = 340;
const WIDTH_MIN = 260;
const widthMax = (): number => Math.max(WIDTH_MIN, Math.round(window.innerWidth * 0.6));
const clampWidth = (w: number): number => Math.min(widthMax(), Math.max(WIDTH_MIN, w));

function savedWidth(): number {
	const v = Number(localStorage.getItem(WIDTH_KEY));
	return v > 0 ? clampWidth(v) : WIDTH_DEFAULT;
}

function fmtBpm(bpm: number): string {
	return bpm > 0 ? String(Math.round(snapBpm(bpm) * 10) / 10) : "";
}

// A line of the list: a track and its number, which is its place in the chosen playlist, or
// among all tracks in the order they were added to Rekordbox.
type Row = { track: RekordboxTrack; no: number; text: string };

// Tracks with no key or no BPM go last whichever way the rest is ordered.
function sorted(rows: Row[], sort: LibrarySort): Row[] {
	const way = sort.down ? -1 : 1;
	if (sort.by === "number") return sort.down ? [...rows].reverse() : rows;
	const value = (r: Row): number | null => (sort.by === "key" ? r.track.keyOrder : r.track.bpm > 0 ? snapBpm(r.track.bpm) : null);
	return [...rows].sort((a, b) => {
		const x = value(a);
		const y = value(b);
		if (x === null || y === null) return x === y ? a.no - b.no : x === null ? 1 : -1;
		return x === y ? a.no - b.no : (x - y) * way;
	});
}

// The title and artist a row shows. Tracks tagged badly often have no artist but carry it in
// the title ("Zedd - Clarity"), or have no real title at all ("-"), when the file name is the
// best there is.
function names(t: RekordboxTrack): { title: string; artist: string } {
	let title = t.title.trim();
	if (!title || /^[-–—_.\s]+$/.test(title)) title = (t.path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");
	if (t.artist.trim()) return { title, artist: t.artist.trim() };
	const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
	return m ? { title: m[2], artist: m[1] } : { title, artist: "" };
}

// What is under the pointer while a track is dragged: a small tag with its title.
function dragPicture(t: RekordboxTrack): { png: string; scale: number } {
	const scale = Math.max(1, Math.round(window.devicePixelRatio || 1));
	const font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
	const cv = document.createElement("canvas");
	const g = cv.getContext("2d")!;
	g.font = font;
	const text = t.artist ? `${t.title} · ${t.artist}` : t.title;
	let shown = text;
	while (shown.length > 1 && g.measureText(shown).width > 260) shown = shown.slice(0, -2);
	if (shown !== text) shown = `${shown.trimEnd()}…`;
	const w = Math.ceil(g.measureText(shown).width) + 24;
	const h = 26;
	cv.width = w * scale;
	cv.height = h * scale;
	g.scale(scale, scale);
	g.fillStyle = "rgba(91, 140, 255, 0.92)";
	g.beginPath();
	g.roundRect(0, 0, w, h, 6);
	g.fill();
	g.font = font;
	g.fillStyle = "#fff";
	g.textBaseline = "middle";
	g.fillText(shown, 12, h / 2 + 0.5);
	return { png: cv.toDataURL("image/png"), scale };
}

const ALL = "All tracks";

// Along the foot of a row: click anywhere on it to hear the track from there. While it
// plays, it fills up to where the preview is.
function PreviewBar({ track, playing, onSelect }: { track: RekordboxTrack; playing: boolean; onSelect: () => void }) {
	const fill = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!playing) return;
		let frame = 0;
		const step = (): void => {
			if (fill.current) fill.current.style.width = `${libraryPreviewAt(track.lengthSec) * 100}%`;
			frame = requestAnimationFrame(step);
		};
		step();
		return () => cancelAnimationFrame(frame);
	}, [playing, track]);
	return (
		<div
			className="library-bar"
			data-testid="library-bar"
			onPointerDown={(e) => {
				e.stopPropagation();
				if (e.button !== 0) return;
				onSelect();
				const box = e.currentTarget.getBoundingClientRect();
				playLibraryPreview(track.path, (e.clientX - box.left) / box.width, track.lengthSec);
			}}
			onClick={(e) => e.stopPropagation()}
			onDoubleClick={(e) => e.stopPropagation()}
		>
			<div className="library-bar-line">{playing && <div className="library-bar-fill" data-testid="library-bar-fill" ref={fill} />}</div>
		</div>
	);
}

// The playlist to show: a button that opens a list with its own search.
function PlaylistPicker({ playlists, chosen, onPick }: { playlists: RekordboxPlaylist[]; chosen: RekordboxPlaylist | null; onPick: (id: string | null) => void }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [at, setAt] = useState(0);
	const box = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const options = useRef<HTMLDivElement>(null);

	const found = useMemo(() => {
		const words = plain(query).split(/\s+/).filter(Boolean);
		const all: { id: string | null; name: string }[] = [{ id: null, name: ALL }, ...playlists];
		return words.length ? all.filter((p) => words.every((w) => plain(p.name).includes(w))) : all;
	}, [playlists, query]);

	const close = (): void => {
		setOpen(false);
		setQuery("");
	};
	// A click anywhere else closes it.
	useEffect(() => {
		if (!open) return;
		const down = (e: MouseEvent): void => {
			if (!box.current?.contains(e.target as Node)) close();
		};
		window.addEventListener("mousedown", down, true);
		return () => window.removeEventListener("mousedown", down, true);
	}, [open]);
	// The option the arrow keys are on stays in view.
	useLayoutEffect(() => {
		if (open) options.current?.children[at]?.scrollIntoView({ block: "nearest" });
	}, [open, at, found]);

	const pick = (id: string | null): void => {
		close();
		onPick(id);
	};

	return (
		<div className="library-playlist" ref={box}>
			<button
				ref={button}
				data-testid="library-playlist"
				onClick={() => {
					if (open) return close();
					setAt(Math.max(0, chosen ? playlists.indexOf(chosen) + 1 : 0));
					setOpen(true);
				}}
			>
				<span>{chosen ? chosen.name : ALL}</span>
				<span>▾</span>
			</button>
			{open && (
				<div className="playlist-menu" data-testid="playlist-menu">
					<input
						className="search"
						data-testid="playlist-search"
						placeholder="Search playlists"
						spellCheck={false}
						autoFocus
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setAt(0);
						}}
						onKeyDown={(e) => {
							if (e.key === "ArrowDown" || e.key === "ArrowUp") {
								e.preventDefault();
								if (found.length) setAt((at + (e.key === "ArrowDown" ? 1 : found.length - 1)) % found.length);
							} else if (e.key === "Enter") {
								const p = found[at];
								if (p) pick(p.id);
							} else if (e.key === "Escape") {
								close();
								button.current?.focus();
							}
						}}
					/>
					<div className="playlist-options" ref={options}>
						{found.length === 0 ? (
							<p className="muted">No playlists match</p>
						) : (
							found.map((p, i) => (
								<button
									key={p.id ?? ""}
									data-testid="playlist-option"
									className={`${i === at ? "at" : ""}${p.id === (chosen?.id ?? null) ? " chosen" : ""}`}
									onMouseMove={() => setAt(i)}
									onClick={() => pick(p.id)}
								>
									{p.name}
								</button>
							))
						)}
					</div>
				</div>
			)}
		</div>
	);
}

const KEYS = ["A", "B"].map((m) => Array.from({ length: 12 }, (_, i) => `${i + 1}${m}`));
const filtering = (f: LibraryFilter): boolean => f.bpmMin !== null || f.bpmMax !== null || f.keys.length > 0 || f.tags.length > 0;

// Keys: any of the picked ones. Tags: all of them.
function passes(t: RekordboxTrack, f: LibraryFilter): boolean {
	if (f.keys.length && !f.keys.includes(t.key.toUpperCase())) return false;
	if (f.tags.some((id) => !t.tags.includes(id))) return false;
	if (f.bpmMin === null && f.bpmMax === null) return true;
	if (!(t.bpm > 0)) return false;
	const bpm = snapBpm(t.bpm);
	return (f.bpmMin === null || bpm >= f.bpmMin) && (f.bpmMax === null || bpm <= f.bpmMax);
}

// A BPM typed in the filter; anything that is not a number leaves that end open.
const bpmOf = (text: string): number | null => {
	const n = Number(text.trim());
	return text.trim() && n > 0 ? n : null;
};

// Next to the playlist: a filter icon that opens the BPM range, keys and tags to show. While a
// filter is on, the icon lights up and an X beside it clears it. At its foot, tag editor
// mode: the tags picked there show hollow on every row, to add with one click.
function FilterButton({ filter, tags, canTag }: { filter: LibraryFilter; tags: RekordboxTag[]; canTag: boolean }) {
	const tagMode = useStore((s) => s.tagMode);
	const quickTags = useStore((s) => s.quickTags);
	const pickQuick = (id: string): void => store.set({ quickTags: quickTags.includes(id) ? quickTags.filter((x) => x !== id) : [...quickTags, id] });
	const [open, setOpen] = useState(false);
	const [min, setMin] = useState("");
	const [max, setMax] = useState("");
	const box = useRef<HTMLDivElement>(null);
	const on = filtering(filter);
	const set = (f: Partial<LibraryFilter>): void => store.set({ libraryFilter: { ...store.get().libraryFilter, ...f } });

	useEffect(() => {
		if (!open) return;
		const down = (e: MouseEvent): void => {
			if (!box.current?.contains(e.target as Node)) setOpen(false);
		};
		const key = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", down, true);
		window.addEventListener("keydown", key);
		return () => {
			window.removeEventListener("mousedown", down, true);
			window.removeEventListener("keydown", key);
		};
	}, [open]);

	const toggle = (): void => {
		if (!open) {
			setMin(filter.bpmMin === null ? "" : String(filter.bpmMin));
			setMax(filter.bpmMax === null ? "" : String(filter.bpmMax));
		}
		setOpen(!open);
	};
	const pickKey = (k: string): void => set({ keys: filter.keys.includes(k) ? filter.keys.filter((x) => x !== k) : [...filter.keys, k] });
	const pickTag = (id: string): void => set({ tags: filter.tags.includes(id) ? filter.tags.filter((x) => x !== id) : [...filter.tags, id] });

	return (
		<div className="library-filter-box" ref={box}>
			<div className={`library-filter${on ? " on" : ""}${open ? " open" : ""}`}>
				<button data-testid="library-filter" aria-label="Filter" aria-expanded={open} onClick={toggle}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden="true">
						<path d="M3 4.5h18l-7 8.2V19l-4 2v-8.3z" />
					</svg>
				</button>
				{on && (
					<button
						className="library-filter-clear"
						data-testid="library-filter-clear"
						aria-label="Clear filter"
						onClick={() => {
							store.set({ libraryFilter: NO_FILTER });
							setMin("");
							setMax("");
						}}
					>
						<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" aria-hidden="true">
							<path d="M5 5l14 14M19 5L5 19" />
						</svg>
					</button>
				)}
			</div>
			{open && (
				<div className="filter-menu" data-testid="filter-menu">
					<div className="filter-bpm">
						<span className="filter-label">BPM</span>
						<input
							data-testid="filter-bpm-min"
							aria-label="Lowest BPM"
							inputMode="decimal"
							placeholder="Min"
							spellCheck={false}
							value={min}
							onChange={(e) => {
								setMin(e.target.value);
								set({ bpmMin: bpmOf(e.target.value) });
							}}
						/>
						<span className="muted">–</span>
						<input
							data-testid="filter-bpm-max"
							aria-label="Highest BPM"
							inputMode="decimal"
							placeholder="Max"
							spellCheck={false}
							value={max}
							onChange={(e) => {
								setMax(e.target.value);
								set({ bpmMax: bpmOf(e.target.value) });
							}}
						/>
					</div>
					<div className="filter-keys" data-testid="filter-keys">
						{KEYS.map((row, r) => (
							<div key={r}>
								{row.map((k) => (
									<button key={k} className={filter.keys.includes(k) ? "on" : ""} data-testid="filter-key" aria-pressed={filter.keys.includes(k)} style={hueVars(keyHue(k))} onClick={() => pickKey(k)}>
										{k}
									</button>
								))}
							</div>
						))}
					</div>
					{tags.length > 0 && (
						<div className="filter-quick" data-testid="filter-tags">
							{tags.map((t) => (
								<button key={t.id} className={filter.tags.includes(t.id) ? "on" : ""} data-testid="filter-tag" aria-pressed={filter.tags.includes(t.id)} onClick={() => pickTag(t.id)}>
									{t.name}
								</button>
							))}
						</div>
					)}
					{canTag && (
						<div className="filter-tagmode">
							<label className="switch small">
								<span>Tag editor mode</span>
								<button role="switch" aria-checked={tagMode} className={`switch-track${tagMode ? " on" : ""}`} data-testid="tag-mode" onClick={() => store.set({ tagMode: !tagMode })}>
									<span className="switch-knob" />
								</button>
							</label>
							{tagMode &&
								(tags.length ? (
									<div className="filter-quick" data-testid="quick-tags">
										{tags.map((t) => (
											<button key={t.id} className={quickTags.includes(t.id) ? "on" : ""} data-testid="quick-tag" aria-pressed={quickTags.includes(t.id)} onClick={() => pickQuick(t.id)}>
												{t.name}
											</button>
										))}
									</div>
								) : (
									<p className="muted">No tags yet</p>
								))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// One track in the library: click to select it, drag it to add it, its bar to
// preview it, and a star that keeps it in the Starred list for this set. `top` places it in
// the scrolled list; the Starred list stacks its rows instead.
// In tag editor mode, a picked tag as a row shows it: solid when the track has it (or it is
// being written), hollow when one click would add it.
type QuickTag = { id: string; name: string; on: boolean };
type RowTag = { id: string; name: string };

// A tag on a row in tag editor mode: its name opens the tag editor, its X takes it off.
function EditTag({ tag, testId, onOpen, onRemove }: { tag: RowTag; testId: string; onOpen: () => void; onRemove: () => void }) {
	return (
		<span className="library-tag library-edit-tag" data-testid={testId}>
			<button
				className="library-tag-name"
				onClick={(e) => {
					e.stopPropagation();
					onOpen();
				}}
			>
				{tag.name}
			</button>
			<button
				className="library-tag-x"
				data-testid="tag-remove"
				aria-label={`Remove tag ${tag.name}`}
				onClick={(e) => {
					e.stopPropagation();
					onRemove();
				}}
			>
				<svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true">
					<path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
				</svg>
			</button>
		</span>
	);
}

function TrackRow({ track: t, tags, ghosts, editing, no, top, previewing, starred, selected, numbered, onSelect, onMenu, onTag, onQuickTag }: { track: RekordboxTrack; tags: RowTag[]; ghosts: QuickTag[]; editing: boolean; no: number; top?: number; previewing: boolean; starred: boolean; selected: boolean; numbered: boolean; onSelect: () => void; onMenu: (t: RekordboxTrack, x: number, y: number) => void; onTag: (t: RekordboxTrack) => void; onQuickTag: (t: RekordboxTrack, id: string, add: boolean) => void }) {
	const n = names(t);
	return (
		<div
			className={`library-row${previewing ? " playing" : ""}${selected ? " selected" : ""}${numbered ? " numbered" : ""}${top === undefined ? " stacked" : ""}`}
			data-testid={top === undefined ? "starred-row" : "library-row"}
			data-no={no}
			style={top === undefined ? { height: ROW } : { top, height: ROW }}
			onPointerDown={(e) => {
				pressedAt = { x: e.clientX, y: e.clientY };
				startLibraryDrag(e, t.path, () => dragPicture(t));
			}}
			// A click (not the end of a drag, nor the second of a double-click) selects the
			// track. A double-click does nothing.
			onClick={(e) => {
				if (e.detail > 1 || !pressedAt || Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > 4) return;
				onSelect();
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				onMenu(t, e.clientX, e.clientY);
			}}
		>
			<div className="library-names">
				<div className="library-line">
					{previewing ? (
						<button
							className="library-no library-stop"
							data-testid="library-stop"
							aria-label="Stop preview"
							onPointerDown={(e) => e.stopPropagation()}
							onDoubleClick={(e) => e.stopPropagation()}
							onClick={(e) => {
								e.stopPropagation();
								stopLibraryPreview();
							}}
						>
							<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
								<rect x="1" y="1" width="8" height="8" rx="1" />
							</svg>
						</button>
					) : numbered && (
						<span className="library-no" data-testid="library-no">
							{no}
						</span>
					)}
					<div className="library-title">{n.title}</div>
				</div>
				<div className="library-sub">
					<div className={n.artist ? "library-artist" : "library-artist none"}>{n.artist || "Unknown artist"}</div>
					{/* after the artist, its tags, or a plus on hover where there are none: either opens the
					    tag editor. In tag editor mode the picked tags follow, always in the same place: solid
					    when the track has them, hollow to add with a click. */}
					<div className="library-tag-line" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
						{editing ? (
							<>
								{tags.map((g) => (
									<EditTag key={g.id} tag={g} testId="row-tag" onOpen={() => onTag(t)} onRemove={() => onQuickTag(t, g.id, false)} />
								))}
								{ghosts.map((g) =>
									g.on ? (
										<EditTag key={g.id} tag={g} testId="quick-tag-on" onOpen={() => onTag(t)} onRemove={() => onQuickTag(t, g.id, false)} />
									) : (
										<button
											key={g.id}
											className="library-tag library-edit-tag library-ghost-tag"
											data-testid="ghost-tag"
											aria-label={`Add tag ${g.name}`}
											onClick={(e) => {
												e.stopPropagation();
												onQuickTag(t, g.id, true);
											}}
										>
											<span className="library-tag-name">{g.name}</span>
											<span className="library-tag-x" aria-hidden="true">
												<svg width="7" height="7" viewBox="0 0 8 8">
													<path d="M4 1v6M1 4h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
												</svg>
											</span>
										</button>
									),
								)}
								{tags.length === 0 && ghosts.length === 0 && (
									<button className="library-tags none" data-testid="library-tags" aria-label="Add tags" onClick={(e) => { e.stopPropagation(); onTag(t); }}>
										<span className="library-tag library-tag-add" aria-hidden="true">
									<svg width="8" height="8" viewBox="0 0 8 8">
										<path d="M4 1v6M1 4h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
									</svg>
								</span>
									</button>
								)}
							</>
						) : (
							<button
								className={`library-tags${tags.length ? "" : " none"}`}
								data-testid="library-tags"
								aria-label={tags.length ? `Tags: ${tags.map((g) => g.name).join(", ")}` : "Add tags"}
								onClick={(e) => {
									e.stopPropagation();
									onTag(t);
								}}
							>
								{tags.length ? (
									tags.map((g) => (
										<span key={g.id} className="library-tag">
											{g.name}
										</span>
									))
								) : (
									<span className="library-tag library-tag-add" aria-hidden="true">
									<svg width="8" height="8" viewBox="0 0 8 8">
										<path d="M4 1v6M1 4h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
									</svg>
								</span>
								)}
							</button>
						)}
					</div>
				</div>
			</div>
			<div className="library-meta">
				<div className="library-key" style={hueVars(keyHue(t.key))}>
					{t.key}
				</div>
				<div className="library-bpm">{fmtBpm(t.bpm)}</div>
			</div>
			<button
				className={`library-star${starred ? " on" : ""}`}
				data-testid="library-star"
				aria-label={starred ? "Unstar" : "Star"}
				aria-pressed={starred}
				onPointerDown={(e) => e.stopPropagation()}
				onDoubleClick={(e) => e.stopPropagation()}
				onClick={(e) => {
					e.stopPropagation();
					toggleStar(t.path);
				}}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill={starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
					<path d="M12 2.8l2.84 5.76 6.36.92-4.6 4.49 1.09 6.33L12 17.31l-5.69 2.99 1.09-6.33-4.6-4.49 6.36-.92z" />
				</svg>
			</button>
			<PreviewBar track={t} playing={previewing} onSelect={onSelect} />
		</div>
	);
}

// The right-click menu of a library track.
function RowMenu({ x, y, onTag, onClose }: { x: number; y: number; onTag: () => void; onClose: () => void }) {
	useEffect(() => {
		window.addEventListener("pointerdown", onClose);
		window.addEventListener("blur", onClose);
		return () => {
			window.removeEventListener("pointerdown", onClose);
			window.removeEventListener("blur", onClose);
		};
	}, [onClose]);
	return (
		<div className="menu" data-testid="library-menu" style={{ left: Math.min(x, window.innerWidth - 230), top: Math.min(y, window.innerHeight - 50) }} onContextMenu={(e) => e.preventDefault()}>
			<button
				data-testid="library-menu-tag"
				onPointerDown={(e) => e.stopPropagation()}
				onClick={() => {
					onClose();
					onTag();
				}}
			>
				<span>Tag…</span>
			</button>
		</div>
	);
}

// Stars a track for the open set, or takes its star away.
function toggleStar(path: string): void {
	const { starred } = store.get();
	store.set({ starred: starred.includes(path) ? starred.filter((p) => p !== path) : [...starred, path] });
}

export function Library() {
	// undefined while it is being read; null when there is no Rekordbox library here
	const [library, setLibrary] = useState<RekordboxLibrary | null | undefined>(undefined);
	const [failed, setFailed] = useState(false);
	const [query, setQuery] = useState("");
	const [scrollTop, setScrollTop] = useState(0);
	const [height, setHeight] = useState(0);
	const list = useRef<HTMLDivElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const playlistId = useStore((s) => s.libraryPlaylist);
	const previewing = useLibraryPreview();
	// Closing the panel stops its preview.
	useEffect(() => stopLibraryPreview, []);
	const sort = useStore((s) => s.librarySort);
	const filter = useStore((s) => s.libraryFilter);
	const tagMode = useStore((s) => s.tagMode);
	const quickTags = useStore((s) => s.quickTags);
	// Tags being put on or taken off tracks in tag editor mode, shown before Rekordbox has them.
	const [ops, setOps] = useState<{ track: string; id: string; add: boolean }[]>([]);
	const starred = useStore((s) => s.starred);
	const [width, setWidth] = useState(savedWidth);
	const [menu, setMenu] = useState<{ x: number; y: number; track: RekordboxTrack } | null>(null);
	const [tagging, setTagging] = useState<RekordboxTrack | null>(null);
	// The row clicked last, by its number in the list it was picked from. It stays through a
	// new search or order, so a track found by search can be seen in its place afterwards.
	const [picked, setPicked] = useState<{ list: string | null; no: number } | null>(null);
	const openMenu = (track: RekordboxTrack, x: number, y: number): void => setMenu({ x, y, track });
	const closeMenu = useCallback(() => setMenu(null), []);
	// What was written to Rekordbox, put into the library as it is shown.
	const tagged = (id: string, r: TagChangeResult): void =>
		setLibrary((lib) => {
			if (!lib) return lib;
			const tags = [...lib.tags, ...r.created.filter((t) => !lib.tags.some((x) => x.id === t.id))];
			return { ...lib, tags, tracks: lib.tracks.map((t) => (t.id === id ? { ...t, tags: r.tags } : t)) };
		});

	const onResize = (e: ReactPointerEvent): void => {
		if (e.button !== 0) return;
		e.preventDefault();
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		const startX = e.clientX;
		const startW = width;
		let next = width;
		const move = (ev: PointerEvent): void => {
			next = clampWidth(startW + ev.clientX - startX);
			setWidth(next);
		};
		const up = (): void => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", up);
			handle.removeEventListener("pointercancel", up);
			localStorage.setItem(WIDTH_KEY, String(next));
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up);
		handle.addEventListener("pointercancel", up);
	};
	// Double-click the edge to go back to the default width.
	const resetWidth = (): void => {
		setWidth(WIDTH_DEFAULT);
		localStorage.setItem(WIDTH_KEY, String(WIDTH_DEFAULT));
	};

	// Asked for each time the panel opens, so what was changed in Rekordbox since is there.
	useEffect(() => {
		let open = true;
		window.api.rekordboxLibrary().then(
			(read) => {
				setTrackKeys(read);
				if (open) setLibrary(read);
			},
			() => open && setFailed(true),
		);
		return () => {
			open = false;
		};
	}, []);

	// A playlist that is no longer in Rekordbox falls back to all tracks.
	const playlist = useMemo(() => library?.playlists.find((p) => p.id === playlistId) ?? null, [library, playlistId]);
	const rows = useMemo(() => {
		if (!library) return [];
		const row = (t: RekordboxTrack, no: number): Row => ({ track: t, no, text: plain(`${t.title} ${t.artist}`) });
		// Tracks with no file to load (streaming, or the file is gone) are left out, but
		// still count towards the numbers, so they match Rekordbox's.
		if (!playlist) return library.tracks.map((t, i) => row(t, i + 1)).filter((r) => r.track.available);
		const byId = new Map(library.tracks.map((t) => [t.id, t]));
		const out: Row[] = [];
		let no = 0;
		for (const id of playlist.tracks) {
			const t = byId.get(id);
			if (!t) continue;
			no++;
			if (t.available) out.push(row(t, no));
		}
		return out;
	}, [library, playlist]);
	// The picked tags of tag editor mode, in the order the tags are listed; none while it is off.
	const quick = useMemo(() => (tagMode && library?.canTag !== false ? (library?.tags ?? []).filter((t) => quickTags.includes(t.id)) : []), [library, tagMode, quickTags]);
	// A track's tags as they are about to be: with the ones being written put on or taken off.
	const tagsNow = useCallback(
		(t: RekordboxTrack): string[] => ops.reduce((tags, o) => (o.track !== t.id ? tags : o.add ? (tags.includes(o.id) ? tags : [...tags, o.id]) : tags.filter((x) => x !== o.id)), t.tags),
		[ops],
	);
	// A track's tags, in the order the tags are listed, leaving out the picked ones of tag
	// editor mode, which have their own place after them.
	const tagsOf = useMemo(() => {
		const order = new Map((library?.tags ?? []).map((t, i) => [t.id, i]));
		const name = new Map((library?.tags ?? []).map((t) => [t.id, t.name]));
		const skip = new Set(quick.map((q) => q.id));
		return (t: RekordboxTrack): RowTag[] =>
			tagsNow(t)
				.filter((id) => name.has(id) && !skip.has(id))
				.sort((a, b) => order.get(a)! - order.get(b)!)
				.map((id) => ({ id, name: name.get(id)! }));
	}, [library, quick, tagsNow]);
	const ghostsOf = useMemo(() => {
		return (t: RekordboxTrack): QuickTag[] => {
			const now = tagsNow(t);
			return quick.map((q) => ({ id: q.id, name: q.name, on: now.includes(q.id) }));
		};
	}, [quick, tagsNow]);
	// One click in tag editor mode puts a tag on a track in Rekordbox, or takes it off. It shows
	// at once; a write that fails puts it back as it was.
	const changeTag = (t: RekordboxTrack, id: string, add: boolean): void => {
		if (ops.some((o) => o.track === t.id && o.id === id)) return;
		const now = tagsNow(t);
		const op = { track: t.id, id, add };
		setOps((o) => [...o, op]);
		window.api
			.setTrackTags({ contentId: t.id, keep: add ? [...now, id] : now.filter((x) => x !== id), create: [] })
			.then(
				(r) => tagged(t.id, r),
				(e) => store.set({ toast: `Could not ${add ? "add" : "remove"} the tag: ${String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}` }),
			)
			.finally(() => setOps((o) => o.filter((x) => x !== op)));
	};
	const selected = picked && picked.list === (playlist?.id ?? null) ? picked.no : null;
	const select = (no: number): void => setPicked({ list: playlist?.id ?? null, no });
	// A starred track picks its row in the list, if it is there.
	const selectTrack = (t: RekordboxTrack): void => {
		const r = rows.find((x) => x.track.path === t.path);
		if (r) select(r.no);
	};
	const shown = useMemo(() => {
		const words = plain(query).split(/\s+/).filter(Boolean);
		const on = filtering(filter);
		return sorted(words.length || on ? rows.filter((r) => words.every((w) => r.text.includes(w)) && (!on || passes(r.track, filter))) : rows, sort);
	}, [rows, query, sort, filter]);

	// The starred tracks that are in the library, in the order they were starred.
	const starredTracks = useMemo(() => {
		if (!library) return [];
		const byPath = new Map(library.tracks.filter((t) => t.available).map((t) => [t.path, t]));
		return starred.flatMap((p) => byPath.get(p) ?? []);
	}, [library, starred]);

	const ready = !!library;
	useLayoutEffect(() => {
		const el = list.current;
		if (!el) return;
		setHeight(el.clientHeight);
		const watch = new ResizeObserver(() => setHeight(el.clientHeight));
		watch.observe(el);
		return () => watch.disconnect();
	}, [ready]);
	// A new search, playlist or order starts at the top, unless the selected track is still in
	// the list: then it is brought to the middle of the view.
	useLayoutEffect(() => {
		const el = list.current;
		const at = selected === null ? -1 : shown.findIndex((r) => r.no === selected);
		const view = el?.clientHeight ?? 0;
		const top = at < 0 ? 0 : Math.max(0, Math.min(at * ROW - (view - ROW) / 2, shown.length * ROW - view));
		if (el) el.scrollTop = top;
		setScrollTop(el ? el.scrollTop : top);
	}, [query, playlist, sort, filter]);

	const first = Math.max(0, Math.floor(scrollTop / ROW) - SPARE);
	const last = Math.min(shown.length, Math.ceil((scrollTop + height) / ROW) + SPARE);
	// A new order starts going up; the arrow turns it round.
	const sortBy = (by: LibrarySort["by"]): void => store.set({ librarySort: { by, down: false } });
	const flipSort = (): void => store.set({ librarySort: { ...sort, down: !sort.down } });

	return (
		<aside className="library" data-testid="library" style={{ width }}>
			{failed ? (
				<p className="muted" data-testid="library-failed">
					The Rekordbox library could not be read
				</p>
			) : library === undefined ? (
				<p className="muted">Reading the Rekordbox library…</p>
			) : library === null ? (
				<p className="muted" data-testid="library-missing">
					No Rekordbox library found on this Mac
				</p>
			) : (
				<>
					<div className="library-pick">
						<PlaylistPicker
							playlists={library.playlists}
							chosen={playlist}
							onPick={(id) => {
								store.set({ libraryPlaylist: id });
								search.current?.focus();
							}}
						/>
						<FilterButton filter={filter} tags={library.tags} canTag={library.canTag !== false} />
					</div>
					<div className="library-tools">
						<div className="library-search">
							<input
								ref={search}
								className="search"
								data-testid="library-search"
								placeholder="Search title or artist"
								spellCheck={false}
								autoFocus
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								onKeyDown={(e) => {
									if (e.key !== "Escape") return;
									if (query) setQuery("");
									else e.currentTarget.blur();
								}}
							/>
							{query && (
								<button
									className="library-search-clear"
									data-testid="library-search-clear"
									aria-label="Clear search"
									onClick={() => {
										setQuery("");
										search.current?.focus();
									}}
								>
									<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
										<path d="M5 5l14 14M19 5L5 19" />
									</svg>
								</button>
							)}
						</div>
						<div className="library-sort">
							<select data-testid="library-sort" aria-label="Sort by" value={sort.by} onChange={(e) => sortBy(e.target.value as LibrarySort["by"])}>
								<option value="number">{playlist ? "Playlist order" : "Date added"}</option>
								<option value="bpm">BPM</option>
								<option value="key">Key</option>
							</select>
							<button data-testid="library-sort-dir" aria-label={sort.down ? "Sort descending" : "Sort ascending"} onClick={flipSort}>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
									{sort.down ? <path d="m3 16 4 4 4-4M7 20V4M11 4h10M11 8h7M11 12h4" /> : <path d="m3 8 4-4 4 4M7 4v16M11 12h4M11 16h7M11 20h10" />}
								</svg>
							</button>
						</div>
					</div>
					<div className="library-list" data-testid="library-list" ref={list} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
						{shown.length === 0 ? (
							<p className="muted">{rows.length ? "No tracks match" : "This playlist is empty"}</p>
						) : (
							<div style={{ height: shown.length * ROW }}>
								{shown.slice(first, last).map(({ track: t, no }, i) => (
									<TrackRow key={no} track={t} tags={tagsOf(t)} ghosts={ghostsOf(t)} editing={tagMode && library.canTag !== false} no={no} top={(first + i) * ROW} previewing={previewing === t.path} starred={starred.includes(t.path)} selected={no === selected} numbered={!!playlist} onSelect={() => select(no)} onMenu={openMenu} onTag={setTagging} onQuickTag={changeTag} />
								))}
							</div>
						)}
					</div>
					{starredTracks.length > 0 && (
						<section className="library-starred" data-testid="library-starred">
							<h2>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
									<path d="M12 2.8l2.84 5.76 6.36.92-4.6 4.49 1.09 6.33L12 17.31l-5.69 2.99 1.09-6.33-4.6-4.49 6.36-.92z" />
								</svg>
								Starred
								<span className="library-starred-count">{starredTracks.length}</span>
							</h2>
							<div className="library-starred-list">
								{starredTracks.map((t, i) => (
									<TrackRow key={t.path} track={t} tags={tagsOf(t)} ghosts={ghostsOf(t)} editing={tagMode && library.canTag !== false} no={i + 1} previewing={previewing === t.path} starred selected={false} numbered={false} onSelect={() => selectTrack(t)} onMenu={openMenu} onTag={setTagging} onQuickTag={changeTag} />
								))}
							</div>
						</section>
					)}
				</>
			)}
			{menu && <RowMenu x={menu.x} y={menu.y} onClose={closeMenu} onTag={() => setTagging(menu.track)} />}
			{tagging && library && (
				<TagModal
					track={tagging}
					{...names(tagging)}
					tags={library.tags}
					canTag={library.canTag !== false}
					onClose={() => setTagging(null)}
					onSaved={(r) => tagged(tagging.id, r)}
				/>
			)}
			{/* the version sits here while the library covers the bottom-left corner it otherwise uses */}
			<div className="library-foot">
				<VersionChip />
			</div>
			<div className="library-resize" data-testid="library-resize" role="separator" aria-orientation="vertical" aria-label="Resize library" onPointerDown={onResize} onDoubleClick={resetWidth} />
		</aside>
	);
}
