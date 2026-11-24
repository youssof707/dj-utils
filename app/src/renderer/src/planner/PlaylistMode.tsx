// Playlist mode: the set owns one Rekordbox playlist, picked or made here, and Sync makes it
// hold exactly the set's tracks in the order the set first plays them. Switched on from the
// top bar; while on, its own toolbar sits under the top bar.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PlannerDoc, PlaylistStatus } from "@shared/planner";
import { cueLetter } from "@shared/cues";
import { HOT_CUES } from "@shared/planner";
import { tracksToEdit } from "@shared/cdj";
import { flushAutoSave } from "./actions";
import { toggleCueTool } from "./cues";
import { errorText, PLAYLIST_KEY, store, toast, useStore } from "./store";
import { plain } from "./text";

// The set's files, each once, in the order the set first plays them.
export function setOrder(doc: PlannerDoc): string[] {
	const pathOf = new Map(doc.tracks.map((t) => [t.id, t.sourcePath]));
	const clips = [...doc.clips].sort((a, b) => a.startBeat - b.startBeat || a.lane - b.lane);
	const out: string[] = [];
	for (const c of clips) {
		const p = pathOf.get(c.trackId);
		if (p && !out.includes(p)) out.push(p);
	}
	return out;
}

type Line = { kind: "create"; name: string } | { kind: "list"; id: string; name: string; takenBy?: string } | { kind: "unlink" };

function Picker({ status, setId, onChanged }: { status: PlaylistStatus; setId: string; onChanged: () => void }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [at, setAt] = useState(-1); // the highlighted line; -1 for none
	const [busy, setBusy] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const options = useRef<HTMLDivElement>(null);
	const linked = status.linked;

	const lines = useMemo((): Line[] => {
		const name = query.trim();
		const words = plain(name).split(/\s+/).filter(Boolean);
		const found = status.playlists.filter((p) => words.every((w) => plain(p.name).includes(w)));
		const exact = status.playlists.some((p) => plain(p.name) === plain(name));
		return [
			...(name && !exact && status.canWrite ? [{ kind: "create" as const, name }] : []),
			...found.map((p) => ({
				kind: "list" as const,
				id: p.id,
				name: p.name,
				takenBy: p.takenBy,
			})),
			...(linked && !name ? [{ kind: "unlink" as const }] : []),
		];
	}, [status, query, linked]);

	const close = (): void => {
		setOpen(false);
		setQuery("");
		setAt(-1);
	};
	useEffect(() => {
		if (!open) return;
		const down = (e: MouseEvent): void => {
			if (!box.current?.contains(e.target as Node)) close();
		};
		window.addEventListener("mousedown", down, true);
		return () => window.removeEventListener("mousedown", down, true);
	}, [open]);
	useLayoutEffect(() => {
		if (open && at >= 0) options.current?.children[at]?.scrollIntoView({ block: "nearest" });
	}, [open, at]);

	const usable = (l: Line): boolean => l.kind !== "list" || !l.takenBy;
	const pick = async (l: Line): Promise<void> => {
		if (!usable(l) || busy) return;
		if (l.kind === "list" && l.id === linked?.id) return close();
		setBusy(true);
		try {
			await flushAutoSave(); // the set has to be stored to own a playlist
			if (l.kind === "create") await window.api.createPlaylist(setId, l.name);
			else await window.api.linkPlaylist(setId, l.kind === "list" ? l.id : null);
			close();
			onChanged();
		} catch (e) {
			toast(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="sync-pick" ref={box}>
			<button className={`ghost${open ? " on" : ""}`} data-testid="sync-playlist" disabled={busy} onClick={() => (open ? close() : setOpen(true))}>
				<span className={linked ? "" : "muted"}>{linked ? linked.name : "Link a playlist"}</span>
				<span className="muted">▾</span>
			</button>
			{open && (
				<div className="playlist-menu sync-menu" data-testid="sync-menu">
					<input
						className="search"
						data-testid="sync-search"
						placeholder={status.canWrite ? "Search or name a new playlist" : "Search playlists"}
						spellCheck={false}
						autoFocus
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setAt(-1);
						}}
						onKeyDown={(e) => {
							if (e.key === "ArrowDown" || e.key === "ArrowUp") {
								e.preventDefault();
								const n = lines.length;
								if (n) setAt(e.key === "ArrowDown" ? (at + 1) % n : (at <= 0 ? n : at) - 1);
							} else if (e.key === "Enter") {
								const l = lines[at] ?? lines.find(usable);
								if (l && (at >= 0 || query.trim())) void pick(l);
							} else if (e.key === "Escape") close();
						}}
					/>
					<div className="playlist-options" ref={options} onMouseLeave={() => setAt(-1)}>
						{lines.length === 0 && <p className="muted">No playlists match</p>}
						{lines.map((l, i) => (
							<button
								key={l.kind === "list" ? l.id : l.kind}
								data-testid={l.kind === "create" ? "sync-create" : l.kind === "unlink" ? "sync-unlink" : "sync-option"}
								className={`${i === at ? "at" : ""}${l.kind === "list" && l.id === linked?.id ? " chosen" : ""}${l.kind === "create" ? " tag-create" : ""}${l.kind === "unlink" ? " sync-unlink" : ""}`}
								disabled={!usable(l)}
								onMouseMove={() => usable(l) && setAt(i)}
								onClick={() => void pick(l)}
							>
								{l.kind === "create" ? (
									<span>Create “{l.name}”</span>
								) : l.kind === "unlink" ? (
									<span>Unlink</span>
								) : (
									<>
										<span>{l.name}</span>
										{l.takenBy && <span className="sync-owner">{l.takenBy}</span>}
									</>
								)}
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

// The cue buttons: a memory cue, then the hot cues A to H. One on at a time; while it is on,
// a click on a track puts that cue there (see placeCue).
function CueButtons() {
	const tool = useStore((s) => s.cueTool);
	useEffect(() => {
		document.body.classList.toggle("cue-tool", tool !== null);
	}, [tool]);
	useEffect(
		() => () => {
			document.body.classList.remove("cue-tool");
			store.set({ cueTool: null });
		},
		[],
	);
	return (
		<div className="cue-tools" data-testid="cue-tools">
			{Array.from({ length: HOT_CUES + 1 }, (_, kind) => (
				<button
					key={kind}
					className={`cue-tool-btn${kind === 0 ? " memory" : ""}${tool === kind ? " on" : ""}`}
					data-testid={`cue-tool-${kind === 0 ? "memory" : cueLetter(kind)}`}
					aria-label={kind === 0 ? "Place memory cue" : `Place hot cue ${cueLetter(kind)}`}
					aria-pressed={tool === kind}
					onClick={() => toggleCueTool(kind)}
				>
					{kind === 0 ? (
						<svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true">
							<path d="M0 0h10L5 8z" fill="currentColor" />
						</svg>
					) : (
						cueLetter(kind)
					)}
				</button>
			))}
		</div>
	);
}

export function PlaylistToggle() {
	const on = useStore((s) => s.playlistMode);
	return (
		<button
			className={`ghost icon${on ? " on" : ""}`}
			data-testid="playlist-mode"
			aria-label="Playlist mode"
			aria-pressed={on}
			onClick={() => {
				localStorage.setItem(PLAYLIST_KEY, on ? "0" : "1");
				store.set(on ? { playlistMode: false, cueTool: null } : { playlistMode: true });
			}}
		>
			{/* a playlist: three lines, the last one short, beside a note */}
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
				<path d="M1.5 3.5h8M1.5 7.5h8M1.5 11.5h4.5" />
				<path d="M12.5 12.5V4.5l2.5 -1" />
				<circle cx="11" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
			</svg>
		</button>
	);
}

export function PlaylistBar() {
	const on = useStore((s) => s.playlistMode);
	const setId = useStore((s) => s.setId);
	const doc = useStore((s) => s.doc);
	const paths = useMemo(() => setOrder(doc), [doc]);
	const order = paths.join("\n");
	const toEdit = useMemo(() => tracksToEdit(doc).size, [doc]);
	const [status, setStatus] = useState<PlaylistStatus | null | undefined>(undefined);
	const [syncing, setSyncing] = useState(false);
	const asked = useRef(0);

	const refresh = useCallback(() => {
		if (!setId) return;
		const n = ++asked.current;
		window.api.playlistStatus(setId, order ? order.split("\n") : []).then(
			(s) => n === asked.current && setStatus(s),
			() => n === asked.current && setStatus(null),
		);
	}, [setId, order]);

	useEffect(() => {
		if (!on) return;
		const t = setTimeout(refresh, 250);
		return () => clearTimeout(t);
	}, [on, refresh]);
	// What was changed in Rekordbox meanwhile shows when the window is back.
	useEffect(() => {
		if (!on) return;
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [on, refresh]);
	// In playlist mode every track is grey, without its key colour (index.css).
	useEffect(() => {
		document.body.classList.toggle("playlist-mode", on);
		return () => document.body.classList.remove("playlist-mode");
	}, [on]);
	useEffect(() => setStatus(undefined), [setId]);

	if (!on || !setId) return null;

	const sync = async (): Promise<void> => {
		if (!status?.linked) return;
		setSyncing(true);
		try {
			const gone = await window.api.syncPlaylist(setId, paths);
			if (gone.length) toast(`File missing, left out: ${gone.join(", ")}`);
		} catch (e) {
			toast(errorText(e));
		} finally {
			setSyncing(false);
			refresh();
		}
	};

	return (
		<div className="toolbar" data-testid="toolbar">
			<div className="sync" data-testid="sync">
				{status === null && <span className="muted">No Rekordbox library</span>}
				{status && (
					<>
						<Picker status={status} setId={setId} onChanged={refresh} />
						{status.missing.length > 0 && (
							<span className="sync-missing" data-testid="sync-missing">
								{status.missing.length} new to Rekordbox
							</span>
						)}
						{status.linked && (
							<button className={`ghost sync-go${status.synced ? " done" : ""}`} data-testid="sync-go" disabled={syncing || status.synced || !status.canWrite} onClick={() => void sync()}>
								{syncing ? "Syncing…" : status.synced ? "Synced" : `Sync ${status.tracks} track${status.tracks === 1 ? "" : "s"}`}
							</button>
						)}
					</>
				)}
			</div>
			<CueButtons />
			{toEdit > 0 && (
				<span className="to-edit-badge" data-testid="to-edit">
					{toEdit} to edit
				</span>
			)}
		</div>
	);
}
