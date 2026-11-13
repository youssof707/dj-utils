import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Track } from "@shared/types";
import type { PlannerDoc } from "@shared/planner";
import { TempoMap, isFlat } from "@shared/tempo";
import { alignPoint, alignSelectionToGrid, cancelExport, confirmImport, contentBeats, tempoPoints, duplicateSelection, deleteSelection, importPaths, toggleMetronome, deleteSet, goHome, openExport, parseBpm, parseWholeBpm, relocateTrack, requestProjectBpm, renameSet, runExport, setProjectBpm, setTrackBpm, skipImport, splitAt, zoomAround, zoomToFit } from "./actions";
import { engine } from "./engine";
import { mediaFor, retryMedia, tempoProgress, workingCount } from "./media";
import { store, useStore } from "./store";

function fmtClock(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = sec - m * 60;
	return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function fmtLength(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = Math.round(sec % 60);
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// A name being typed over: Enter or clicking away keeps it, Escape leaves it as it was.
// `onDone` gets the new name, or null when nothing is to change.
export function NameEdit({ name, testId, placeholder, onDone }: { name: string; testId: string; placeholder?: string; onDone: (name: string | null) => void }) {
	const [text, setText] = useState(name);
	const done = useRef(false);
	const finish = (keep: boolean): void => {
		if (done.current) return;
		done.current = true;
		const next = text.trim();
		onDone(keep && next && next !== name ? next : null);
	};
	return (
		<input
			className="name-edit"
			data-testid={testId}
			autoFocus
			value={text}
			maxLength={80}
			placeholder={placeholder}
			onFocus={(e) => e.currentTarget.select()}
			onChange={(e) => setText(e.target.value)}
			onClick={(e) => e.stopPropagation()}
			onBlur={() => finish(true)}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Enter") finish(true);
				else if (e.key === "Escape") finish(false);
			}}
		/>
	);
}

// ---- top bar ------------------------------------------------------------------------

function Position() {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let raf = 0;
		let last = "";
		// The time is where the playhead is heard, tempo changes included.
		let mapDoc: PlannerDoc | null = null;
		let map: TempoMap | null = null;
		const frame = (): void => {
			raf = requestAnimationFrame(frame);
			const beat = engine.positionBeat();
			const doc = store.get().doc;
			if (doc !== mapDoc || !map) {
				mapDoc = doc;
				map = new TempoMap(tempoPoints(doc), doc.bpm);
			}
			const bar = Math.floor(beat / 4) + 1;
			const inBar = Math.floor(beat % 4) + 1;
			const text = `${bar}.${inBar}   ${fmtClock(map.secondsAtBeat(beat))}`;
			if (text !== last && ref.current) {
				ref.current.textContent = text;
				last = text;
			}
		};
		raf = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(raf);
	}, []);
	return <div className="position" ref={ref} data-testid="position" title="Bar.beat, and time into the set (tempo changes included)" />;
}

function BpmField() {
	const bpm = useStore((s) => s.doc.bpm);
	const [text, setText] = useState(String(bpm));
	const [bad, setBad] = useState(false);
	useEffect(() => {
		setText(String(bpm));
		setBad(false);
	}, [bpm]);
	const commit = (): void => {
		const v = parseWholeBpm(text);
		if (v === null) {
			setBad(true);
			return;
		}
		setBad(false);
		requestProjectBpm(v);
		setText(String(store.get().doc.bpm));
	};
	return (
		<label className="bpm-field" title="Project BPM: the tempo the set starts at. Tempo changes take it from there.">
			<span>BPM</span>
			<input
				data-testid="project-bpm"
				className={bad ? "bad" : ""}
				value={text}
				inputMode="numeric"
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Enter") {
						commit();
						if (parseWholeBpm(text) !== null) e.currentTarget.blur();
					} else if (e.key === "Escape") {
						setText(String(bpm));
						setBad(false);
						e.currentTarget.blur();
					}
				}}
				onBlur={() => {
					if (parseWholeBpm(text) === null) {
						setText(String(bpm));
						setBad(false);
					} else commit();
				}}
			/>
		</label>
	);
}

export function TopBar() {
	const playing = useStore((s) => s.playing);
	const setName = useStore((s) => s.setName);
	const setId = useStore((s) => s.setId);
	const [renaming, setRenaming] = useState(false);
	const askName = useStore((s) => s.askName);
	const setGen = useStore((s) => s.setGen);
	const doc = useStore((s) => s.doc);
	const libraryOpen = useStore((s) => s.libraryOpen);
	const metronome = useStore((s) => s.metronome);
	useStore((s) => s.mediaRev);
	useStore((s) => s.progressRev);
	const working = workingCount(doc);
	const tempo = working > 0 ? null : tempoProgress(doc);
	const name = setName ?? "New set";
	// A set just made from the UI opens on its name.
	useEffect(() => {
		if (!askName) return;
		setRenaming(true);
		store.set({ askName: false });
	}, [askName]);
	useEffect(() => {
		document.title = name;
		return () => {
			document.title = "DJ Utilities";
		};
	}, [name]);
	const beats = contentBeats({ ...doc, tempos: [] });
	const length = beats > 0 ? new TempoMap(tempoPoints(doc), doc.bpm).secondsAtBeat(beats) : 0;
	return (
		<header className="topbar">
			<button className="ghost" data-testid="all-sets" onClick={() => void goHome()} title="Back to your sets (Cmd+O)">
				‹ Sets
			</button>
			<button className={`ghost${libraryOpen ? " on" : ""}`} data-testid="library-toggle" onClick={() => store.set({ libraryOpen: !libraryOpen })} title="Downloaded songs">
				Library
			</button>
			{renaming ? (
				<NameEdit
					key={setGen}
					name={setName ?? ""}
					testId="set-name-input"
					placeholder="Name this set"
					onDone={(next) => {
						setRenaming(false);
						if (next !== null && setId) void renameSet(setId, next);
					}}
				/>
			) : (
				<div className="set-name" data-testid="set-name" title="Click to rename. Every change is kept as you go." onClick={() => setRenaming(true)}>
					{name}
				</div>
			)}
			<BpmField />
			<div className="transport">
				<button className="ghost icon" data-testid="to-start" onClick={() => engine.seek(0)} title="Back to start (Home)">
					<svg viewBox="0 0 16 16" width="14" height="14">
						<rect x="2" y="3" width="2" height="10" fill="currentColor" />
						<path d="M14 3v10L5 8z" fill="currentColor" />
					</svg>
				</button>
				<button className={`play${playing ? " on" : ""}`} data-testid="play" onClick={() => engine.toggle()} title="Play / stop (Space)">
					{playing ? (
						<svg viewBox="0 0 16 16" width="14" height="14">
							<rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor" />
						</svg>
					) : (
						<svg viewBox="0 0 16 16" width="14" height="14">
							<path d="M4 2.5v11l9-5.5z" fill="currentColor" />
						</svg>
					)}
				</button>
				<button className={`ghost icon metro${metronome ? " active" : ""}`} data-testid="metronome" onClick={() => toggleMetronome()} title={`Metronome ${metronome ? "on" : "off"}: a click on every beat, higher on each bar`}>
					<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
						<path d="M6 1.75h4l3.25 12.5H2.75z" />
						<path d="M4.5 10.5h7" />
						<path d="M8 10.5l4-6.5" />
					</svg>
				</button>
				<Position />
			</div>
			<div className="spacer" />
			{working > 0 && (
				<div className="working" data-testid="working">
					<span className="spinner" />
					Stretching {working} track{working === 1 ? "" : "s"}
				</div>
			)}
			{tempo !== null && tempo.left > 0 && (
				<div className="working" data-testid="tempo-working" title="Tracks under a tempo change are being stretched to the tempo they play at there. Until one is done it plays at the right speed, with its pitch off.">
					<span className="spinner" />
					Stretching to tempo changes {Math.round(tempo.pct * 100)}%
				</div>
			)}
			{length > 0 && (
				<div className="set-length" data-testid="set-length" title="Length of the set, tempo changes included">
					{fmtLength(length)}
				</div>
			)}
			<div className="zoom">
				<button className="ghost icon" onClick={() => zoomAround(1 / 1.5)} title="Zoom out (⌘−)">
					−
				</button>
				<button className="ghost" onClick={zoomToFit} title="Fit the whole set (⌘0)">
					Fit
				</button>
				<button className="ghost icon" onClick={() => zoomAround(1.5)} title="Zoom in (⌘=)">
					+
				</button>
			</div>
			<button className="primary" data-testid="export" onClick={openExport}>
				Export
			</button>
		</header>
	);
}

// ---- library ------------------------------------------------------------------------

export function Library() {
	const [tracks, setTracks] = useState<Track[] | null>(null);
	useEffect(() => {
		void window.api
			.listDownloads()
			.then(setTracks)
			.catch(() => setTracks([]));
	}, []);
	const label = (t: Track): string => t.title ?? t.files[0]?.split("/").pop() ?? "Untitled";
	return (
		<aside className="library" data-testid="library">
			<h2>Downloaded songs</h2>
			{tracks === null ? null : tracks.length === 0 ? (
				<p className="muted">No downloads yet</p>
			) : (
				<ul>
					{tracks.map((t) => {
						const file = t.files[0];
						return (
							<li
								key={t.at + label(t)}
								draggable={!!file}
								title={file ? "Drag onto a lane, or double-click to add at the playhead" : "No file"}
								onDragStart={(e) => {
									if (!file) return;
									e.dataTransfer.setData("application/x-dj-path", file);
									e.dataTransfer.effectAllowed = "copy";
								}}
								onDoubleClick={() => file && void importPaths([file], 0, store.get().playheadBeat)}
							>
								{label(t)}
							</li>
						);
					})}
				</ul>
			)}
		</aside>
	);
}

// ---- modals -------------------------------------------------------------------------

function Modal({ children, onClose, onEnter, testId }: { children: ReactNode; onClose: () => void; onEnter?: () => void; testId: string }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// Take focus a moment after opening, so the key press that opened the dialog cannot
		// also confirm it.
		const t = setTimeout(() => {
			if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus();
		}, 60);
		return () => clearTimeout(t);
	}, []);
	return (
		<div
			className="modal-backdrop"
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Escape") onClose();
				else if (e.key === "Enter" && !e.repeat && onEnter && e.target === ref.current) onEnter();
			}}
		>
			<div className="modal" data-testid={testId} role="dialog" tabIndex={-1} ref={ref}>
				{children}
			</div>
		</div>
	);
}

function BpmForm({ title, detail, initial, confirmLabel, cancelLabel, onConfirm, onCancel, note }: { title: string; detail: string; initial: string; confirmLabel: string; cancelLabel: string; onConfirm: (bpm: number) => void; onCancel: () => void; note?: string }) {
	const [text, setText] = useState(initial);
	const [bad, setBad] = useState(false);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	const submit = (): void => {
		const v = parseBpm(text);
		if (v === null) setBad(true);
		else onConfirm(v);
	};
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			<h3>{title}</h3>
			<p className="file-name">{detail}</p>
			<input
				ref={ref}
				data-testid="bpm-input"
				className={`big${bad ? " bad" : ""}`}
				value={text}
				inputMode="decimal"
				placeholder="e.g. 128 or 127.5"
				onChange={(e) => {
					setText(e.target.value);
					setBad(false);
				}}
			/>
			{bad && <p className="error">Enter a BPM between 20 and 400.</p>}
			{note && !bad && <p className="muted">{note}</p>}
			<div className="buttons">
				<button type="button" className="ghost" data-testid="bpm-cancel" onClick={onCancel}>
					{cancelLabel}
				</button>
				<button type="submit" className="primary" data-testid="bpm-confirm">
					{confirmLabel}
				</button>
			</div>
		</form>
	);
}

function ExportModal() {
	const ui = useStore((s) => s.exportUi)!;
	const doc = useStore((s) => s.doc);
	const [keyLock, setKeyLock] = useState(true);
	const flat = isFlat(tempoPoints(doc), doc.bpm);
	const close = (): void => {
		if (ui.phase !== "running") store.set({ exportUi: null });
	};
	return (
		<Modal onClose={close} testId="export-modal">
			<h3>Export</h3>
			{ui.phase === "options" && (
				<>
					<p className="muted">The whole set is mixed to one WAV file{flat ? "." : ", then the tempo changes are applied to that file."}</p>
					{!flat && (
						<label className="check">
							<input type="checkbox" data-testid="keylock" checked={keyLock} onChange={(e) => setKeyLock(e.target.checked)} />
							<span>
								Key lock
								<small>{keyLock ? "Pitch stays the same while the tempo changes." : "Off: pitch rises and falls with the tempo, like a turntable."}</small>
							</span>
						</label>
					)}
					<div className="buttons">
						<button className="ghost" onClick={close}>
							Cancel
						</button>
						<button className="primary" data-testid="export-go" onClick={() => void runExport(keyLock)}>
							Choose file…
						</button>
					</div>
				</>
			)}
			{ui.phase === "running" && (
				<>
					<p data-testid="export-stage">{ui.stage}…</p>
					<div className="progress">
						<div style={{ width: `${Math.round(ui.pct * 100)}%` }} />
					</div>
					<div className="buttons">
						<button className="ghost" data-testid="export-cancel" onClick={cancelExport}>
							Cancel
						</button>
					</div>
				</>
			)}
			{ui.phase === "done" && (
				<>
					<p data-testid="export-done">
						Exported {fmtLength(ui.result.seconds)} to <strong>{ui.result.path.split("/").pop()}</strong>
					</p>
					{ui.result.gainDb < -0.05 && <p className="muted">The mix was turned down {Math.abs(ui.result.gainDb).toFixed(1)} dB so overlapping tracks do not clip.</p>}
					<div className="buttons">
						<button className="ghost" onClick={() => void window.api.reveal(ui.result.path)}>
							Show in Finder
						</button>
						<button className="primary" data-testid="export-close" onClick={close}>
							Done
						</button>
					</div>
				</>
			)}
			{ui.phase === "error" && (
				<>
					<p className="error" data-testid="export-error">
						{ui.message}
					</p>
					<div className="buttons">
						<button className="primary" onClick={close}>
							Close
						</button>
					</div>
				</>
			)}
		</Modal>
	);
}

export function Modals() {
	const queue = useStore((s) => s.importQueue);
	const trackBpmEdit = useStore((s) => s.trackBpmEdit);
	const pending = useStore((s) => s.pendingProjectBpm);
	const exportUi = useStore((s) => s.exportUi);
	const pendingDelete = useStore((s) => s.pendingDelete);
	const doc = useStore((s) => s.doc);
	const item = queue[0];
	const editTrack = doc.tracks.find((t) => t.id === trackBpmEdit);
	if (item && "probe" in item) {
		const more = queue.filter((q) => "probe" in q).length - 1;
		return (
			<Modal onClose={skipImport} testId="import-modal">
				<BpmForm
					key={item.probe.path + queue.length}
					title="What is this track's BPM?"
					detail={item.probe.name}
					initial={item.probe.rekordboxBpm ? String(item.probe.rekordboxBpm) : item.probe.tagBpm ? String(item.probe.tagBpm) : ""}
					note={`It will be stretched to ${doc.bpm} BPM. ${item.probe.rekordboxBpm ? "Suggested from Rekordbox, which analysed a different version of this file, so the track is not lined up by its grid." : item.probe.tagBpm ? "Suggested from the file's tag." : "Decimals are fine."}${more > 0 ? ` ${more} more to go.` : ""}`}
					confirmLabel="Add track"
					cancelLabel="Skip"
					onConfirm={confirmImport}
					onCancel={skipImport}
				/>
			</Modal>
		);
	}
	if (editTrack) {
		const close = (): void => store.set({ trackBpmEdit: null });
		return (
			<Modal onClose={close} testId="track-bpm-modal">
				<BpmForm
					title="Change track BPM"
					detail={editTrack.name}
					initial={String(editTrack.bpm)}
					note="The track is stretched again from the original file. Its clips keep their place and their audio."
					confirmLabel="Restretch"
					cancelLabel="Cancel"
					onConfirm={(v) => {
						setTrackBpm(editTrack.id, v);
						close();
					}}
					onCancel={close}
				/>
			</Modal>
		);
	}
	if (pending !== null) {
		const close = (): void => store.set({ pendingProjectBpm: null });
		const confirm = (): void => {
			setProjectBpm(pending);
			close();
		};
		return (
			<Modal onClose={close} onEnter={confirm} testId="project-bpm-modal">
				<h3>Change project BPM to {pending}?</h3>
				<p className="muted">
					{doc.tracks.length} track{doc.tracks.length === 1 ? "" : "s"} will be stretched again from the original files. Clips stay on the same bars.
				</p>
				<div className="buttons">
					<button className="ghost" onClick={close}>
						Cancel
					</button>
					<button
						className="primary"
						data-testid="project-bpm-confirm"
						onClick={confirm}
					>
						Change BPM
					</button>
				</div>
			</Modal>
		);
	}
	if (pendingDelete) {
		const close = (): void => store.set({ pendingDelete: null });
		const go = (): void => {
			close();
			void deleteSet(pendingDelete.id);
		};
		return (
			<Modal onClose={close} onEnter={go} testId="delete-set-modal">
				<h3>Delete this set?</h3>
				<p className="file-name">{pendingDelete.name}</p>
				<p className="muted">It cannot be brought back. Your audio files are not touched.</p>
				<div className="buttons">
					<button className="ghost" onClick={close}>
						Cancel
					</button>
					<button className="primary" data-testid="delete-set-confirm" onClick={go}>
						Delete set
					</button>
				</div>
			</Modal>
		);
	}
	if (exportUi) return <ExportModal />;
	return null;
}

// ---- clip context menu --------------------------------------------------------------

export function ClipMenu() {
	const menu = useStore((s) => s.menu);
	const doc = useStore((s) => s.doc);
	useStore((s) => s.cues);
	useEffect(() => {
		if (!menu) return;
		const close = (): void => store.set({ menu: null });
		window.addEventListener("pointerdown", close);
		window.addEventListener("blur", close);
		return () => {
			window.removeEventListener("pointerdown", close);
			window.removeEventListener("blur", close);
		};
	}, [menu]);
	if (!menu) return null;
	const clip = doc.clips.find((c) => c.id === menu.clipId);
	const track = clip && doc.tracks.find((t) => t.id === clip.trackId);
	if (!clip) return null;
	const beat = engine.positionBeat();
	const canSplit = beat > clip.startBeat && beat < clip.startBeat + clip.lengthBeat;
	const media = mediaFor(track, doc.bpm);
	const item = (label: string, fn: () => void, opts: { disabled?: boolean; hint?: string; testId?: string } = {}): ReactNode => (
		<button
			disabled={opts.disabled}
			data-testid={opts.testId}
			onPointerDown={(e) => e.stopPropagation()}
			onClick={() => {
				store.set({ menu: null });
				fn();
			}}
		>
			<span>{label}</span>
			{opts.hint && <kbd>{opts.hint}</kbd>}
		</button>
	);
	const x = Math.min(menu.x, window.innerWidth - 230);
	const y = Math.min(menu.y, window.innerHeight - 250);
	return (
		<div className="menu" style={{ left: x, top: y }} data-testid="clip-menu">
			{item("Split at playhead", () => splitAt(beat, [clip.id]), { disabled: !canSplit, hint: "S", testId: "menu-split" })}
			{item("Duplicate", duplicateSelection, { hint: "⌘D", testId: "menu-duplicate" })}
			{item("Align to grid", alignSelectionToGrid, { disabled: !track || alignPoint(track) === null, testId: "menu-align" })}
			{item("Delete", deleteSelection, { hint: "⌫", testId: "menu-delete" })}
			<hr />
			{track && item("Change track BPM…", () => store.set({ trackBpmEdit: track.id }), { testId: "menu-bpm" })}
			{track && media?.state === "error" && item("Try again", () => retryMedia(track, doc.bpm))}
			{track && media?.state === "error" && item("Locate file…", () => void relocateTrack(track.id))}
			{track && item("Show original in Finder", () => void window.api.reveal(track.sourcePath))}
		</div>
	);
}

export function Toast() {
	const toast = useStore((s) => s.toast);
	if (!toast) return null;
	return (
		<div className="toast" data-testid="toast" onClick={() => store.set({ toast: null })}>
			{toast}
		</div>
	);
}
