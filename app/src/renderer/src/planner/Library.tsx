// The library panel: Rekordbox's tracks and playlists, to search, sort and add to the set. Read-only.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RekordboxLibrary, RekordboxPlaylist, RekordboxTrack } from "@shared/planner";
import { importPaths } from "./actions";
import { startLibraryDrag } from "./libraryDrag";
import { hueVars, keyHue } from "./Timeline";
import { setTrackKeys } from "./trackKeys";
import { store, useStore, type LibrarySort } from "./store";

const ROW = 44; // px; every row is the same height, so only the rows in view are drawn
const SPARE = 6; // rows drawn beyond each edge of the view

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
									title={p.name}
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
	const sort = useStore((s) => s.librarySort);

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
	// Choosing the order it is already in turns it round.
	const sortBy = (by: LibrarySort["by"]): void => store.set({ librarySort: { by, down: sort.by === by ? !sort.down : false } });
	const sortButton = (by: LibrarySort["by"], label: string, name: string) => (
		<button className={`${by === "number" ? "no" : by}${sort.by === by ? " on" : ""}`} data-testid={`library-sort-${by}`} title={`Sort by ${name}`} onClick={() => sortBy(by)}>
			{label}
			{sort.by === by ? (sort.down ? " ▼" : " ▲") : ""}
		</button>
	);

	return (
		<aside className="library" data-testid="library">
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
						{sortButton("number", "#", "number")}
						<span>Title</span>
						{sortButton("bpm", "BPM", "BPM")}
						{sortButton("key", "Key", "key")}
					</div>
					<div className="library-list" data-testid="library-list" ref={list} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
						{shown.length === 0 ? (
							<p className="muted">{rows.length ? "No tracks match" : "This playlist is empty"}</p>
						) : (
							<div style={{ height: shown.length * ROW }}>
								{shown.slice(first, last).map(({ track: t, no }, i) => (
									<div
										key={no}
										className="library-row"
										data-testid="library-row"
										style={{ top: (first + i) * ROW, height: ROW }}
										title={t.path}
										onPointerDown={(e) => startLibraryDrag(e, t.path, () => dragPicture(t))}
										onDoubleClick={() => add(t)}
									>
										<div className="library-no">{no}</div>
										<div className="library-names">
											<div className="library-title">{t.title}</div>
											<div className="library-artist">{t.artist}</div>
										</div>
										<div className="library-bpm">{fmtBpm(t.bpm)}</div>
										<div className="library-key" style={hueVars(keyHue(t.key))}>
												{t.key}
											</div>
									</div>
								))}
							</div>
						)}
					</div>
				</>
			)}
		</aside>
	);
}
