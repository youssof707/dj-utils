// The library panel: Rekordbox's tracks and playlists, to search, sort and add to the set. Read-only.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { RekordboxLibrary, RekordboxPlaylist, RekordboxTrack } from "@shared/planner";
import { importPaths } from "./actions";
import { startLibraryDrag } from "./libraryDrag";
import { libraryPreviewAt, playLibraryPreview, stopLibraryPreview, toggleLibraryPreview, useLibraryPreview } from "./libraryPreview";
import { hueVars, keyHue } from "./Timeline";
import { setTrackKeys } from "./trackKeys";
import { store, useStore, type LibrarySort } from "./store";
import { VersionChip } from "../VersionChip";

// Where the last press on a row was, to tell a click from the end of a drag.
let pressedAt: { x: number; y: number } | null = null;

const ROW = 58; // px; every row is the same height, so only the rows in view are drawn
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

// Lower case and without accents, so "beyonce" finds "Beyoncé".
function plain(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase();
}

function fmtBpm(bpm: number): string {
	return bpm > 0 ? String(Math.round(bpm * 10) / 10) : "";
}

// A line of the list: a track and its number, which is its place in the chosen playlist, or
// among all tracks in the order they were added to Rekordbox.
type Row = { track: RekordboxTrack; no: number; text: string };

// Tracks with no key or no BPM go last whichever way the rest is ordered.
function sorted(rows: Row[], sort: LibrarySort): Row[] {
	const way = sort.down ? -1 : 1;
	if (sort.by === "number") return sort.down ? [...rows].reverse() : rows;
	const value = (r: Row): number | null => (sort.by === "key" ? r.track.keyOrder : r.track.bpm > 0 ? r.track.bpm : null);
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
function PreviewBar({ track, playing }: { track: RekordboxTrack; playing: boolean }) {
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

// One track in the library: click to preview, double-click or drag to add it, and a star
// that keeps it in the Starred list for this set. `top` places it in the scrolled list; the
// Starred list stacks its rows instead.
function TrackRow({ track: t, no, top, previewing, starred, onAdd }: { track: RekordboxTrack; no: number; top?: number; previewing: boolean; starred: boolean; onAdd: (t: RekordboxTrack) => void }) {
	const n = names(t);
	return (
		<div
			className={`library-row${previewing ? " playing" : ""}${top === undefined ? " stacked" : ""}`}
			data-testid={top === undefined ? "starred-row" : "library-row"}
			data-no={no}
			style={top === undefined ? { height: ROW } : { top, height: ROW }}
			onPointerDown={(e) => {
				pressedAt = { x: e.clientX, y: e.clientY };
				startLibraryDrag(e, t.path, () => dragPicture(t));
			}}
			// A click (not the end of a drag, nor the second of a double-click) previews the
			// track, or stops it; a double-click adds it to the set.
			onClick={(e) => {
				if (e.detail > 1 || !pressedAt || Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > 4) return;
				toggleLibraryPreview(t.path, t.lengthSec);
			}}
			onDoubleClick={() => {
				stopLibraryPreview();
				onAdd(t);
			}}
		>
			<button
				className="library-play"
				data-testid="library-play"
				aria-label={previewing ? "Stop preview" : "Preview"}
				onPointerDown={(e) => e.stopPropagation()}
				onDoubleClick={(e) => e.stopPropagation()}
				onClick={(e) => {
					e.stopPropagation();
					toggleLibraryPreview(t.path, t.lengthSec);
				}}
			>
				{previewing ? "■" : "▶"}
			</button>
			<div className="library-names">
				<div className="library-title">{n.title}</div>
				<div className={n.artist ? "library-artist" : "library-artist none"}>{n.artist || "Unknown artist"}</div>
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
			<PreviewBar track={t} playing={previewing} />
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
	const starred = useStore((s) => s.starred);
	const [width, setWidth] = useState(savedWidth);

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
	const shown = useMemo(() => {
		const words = plain(query).split(/\s+/).filter(Boolean);
		return sorted(words.length ? rows.filter((r) => words.every((w) => r.text.includes(w))) : rows, sort);
	}, [rows, query, sort]);

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
	// A new search, playlist or order starts at the top.
	useLayoutEffect(() => {
		if (list.current) list.current.scrollTop = 0;
		setScrollTop(0);
	}, [query, playlist, sort]);

	const first = Math.max(0, Math.floor(scrollTop / ROW) - SPARE);
	const last = Math.min(shown.length, Math.ceil((scrollTop + height) / ROW) + SPARE);
	const add = (t: RekordboxTrack): void => {
		void importPaths([t.path], 0, store.get().playheadBeat);
	};
	// A new order starts going up; the arrow turns it round.
	const sortBy = (by: LibrarySort["by"]): void => store.set({ librarySort: { by, down: false } });
	const flipSort = (): void => store.set({ librarySort: { ...sort, down: !sort.down } });

	return (
		<aside className="library" data-testid="library" style={{ width }}>
			<div className="library-head">
				<h2>Rekordbox</h2>
				{library && (
					<span className="muted" data-testid="library-count">
						{shown.length === rows.length ? `${shown.length.toLocaleString()} tracks` : `${shown.length.toLocaleString()} of ${rows.length.toLocaleString()}`}
					</span>
				)}
			</div>
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
					<PlaylistPicker
						playlists={library.playlists}
						chosen={playlist}
						onPick={(id) => {
							store.set({ libraryPlaylist: id });
							search.current?.focus();
						}}
					/>
					<div className="library-tools">
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
									<TrackRow key={no} track={t} no={no} top={(first + i) * ROW} previewing={previewing === t.path} starred={starred.includes(t.path)} onAdd={add} />
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
									<TrackRow key={t.path} track={t} no={i + 1} previewing={previewing === t.path} starred onAdd={add} />
								))}
							</div>
						</section>
					)}
				</>
			)}
			{/* the version sits here while the library covers the bottom-left corner it otherwise uses */}
			<div className="library-foot">
				<VersionChip />
			</div>
			<div className="library-resize" data-testid="library-resize" role="separator" aria-orientation="vertical" aria-label="Resize library" onPointerDown={onResize} onDoubleClick={resetWidth} />
		</aside>
	);
}
