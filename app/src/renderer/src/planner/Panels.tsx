import { useEffect, useRef, useState, type ReactNode } from "react";
import { cueName, sameMoment } from "@shared/cues";
import type { PlannerDoc } from "@shared/planner";
import { TempoMap, isFlat } from "@shared/tempo";
import { alignPoint, alignSelectionToGrid, cancelExport, confirmImport, contentBeats, tempoPoints, duplicateSelection, deleteSelection, toggleMetronome, deleteSet, duplicateSet, goHome, openExport, parseBpm, parseWholeBpm, relocateTrack, requestProjectBpm, renameSet, runExport, setProjectBpm, setTrackBpm, skipImport, splitAt, flagAllOn, flagTargets, toggleClipsFlag, zoomAround, zoomToFit } from "./actions";
import { addCue, deleteCue, waitForHotCue } from "./cues";
import { engine } from "./engine";
import { mediaFor, retryMedia, tempoProgress, workingCount } from "./media";
import { store, useStore } from "./store";
import { openTrackEdit } from "./trackEdit";

function fmtClock(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec - m * 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtLength(seconds: number): string {
	const sec = Math.round(seconds); // whole seconds first, so 59.9 s reads 1:00 and not 0:60
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
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
	const barRef = useRef<HTMLSpanElement>(null);
	const clockRef = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		let raf = 0;
		let lastBar = "";
		let lastClock = "";
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
			const bar = String(Math.floor(beat / 4) + 1);
			const clock = fmtClock(map.secondsAtBeat(beat));
			if (bar !== lastBar && barRef.current) {
				barRef.current.textContent = bar;
				lastBar = bar;
			}
			if (clock !== lastClock && clockRef.current) {
				clockRef.current.textContent = clock;
				lastClock = clock;
			}
		};
		raf = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(raf);
	}, []);
	return (
		<div className="position" data-testid="position">
			<span className="position-label">Bar</span>
			<span className="position-bar" ref={barRef} />
			<span className="position-clock" ref={clockRef} />
		</div>
	);
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
		<label className={`bpm-field${bad ? " bad" : ""}`}>
			<input
				data-testid="project-bpm"
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
			<span>BPM</span>
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
	const showCues = useStore((s) => s.showCues);
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
		<header className="topbar" data-testid="topbar">
			<button className="ghost back" data-testid="all-sets" title="All sets" aria-label="All sets" onClick={() => void goHome()}>
				‹
			</button>
			<button className={`ghost${libraryOpen ? " on" : ""}`} data-testid="library-toggle" onClick={() => store.set({ libraryOpen: !libraryOpen })}>
				Library
			</button>
			{/* The set's name is in the window's title; it is only typed here when a new set asks for it. */}
			{renaming && (
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
			)}
			<BpmField />
			<div className="transport">
				<button className={`play${playing ? " on" : ""}`} data-testid="play" onClick={() => engine.toggle()}>
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
				<button className={`ghost icon metro${metronome ? " active" : ""}`} data-testid="metronome" onClick={() => toggleMetronome()}>
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
				<div className="working" data-testid="tempo-working">
					<span className="spinner" />
					Stretching to tempo changes {Math.round(tempo.pct * 100)}%
				</div>
			)}
			{length > 0 && (
				<div className="set-length" data-testid="set-length">
					{fmtLength(length)}
				</div>
			)}
			<div className="zoom" title="Zoom">
				<button className="ghost icon" onClick={() => zoomAround(1 / 1.5)}>
					−
				</button>
				<button className="ghost" onClick={zoomToFit}>
					Fit
				</button>
				<button className="ghost icon" onClick={() => zoomAround(1.5)}>
					+
				</button>
			</div>
			<button className="primary" data-testid="export" onClick={openExport}>
				Export
			</button>
			<label className="switch" title="Show the cue points on the clips">
				<span>Cues</span>
				<button role="switch" aria-checked={showCues} className={`switch-track${showCues ? " on" : ""}`} data-testid="cues-toggle" onClick={() => store.set({ showCues: !showCues })}>
					<span className="switch-knob" />
				</button>
			</label>
		</header>
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
	const pendingDuplicate = useStore((s) => s.pendingDuplicate);
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
					note={`${item.edit ? `It opens in the track editor, previewed at ${doc.bpm} BPM; an export uses the original file.` : `It will be stretched to ${doc.bpm} BPM.`} ${item.probe.rekordboxBpm ? "Suggested from Rekordbox, which analysed a different version of this file, so the track is not lined up by its grid." : item.probe.tagBpm ? "Suggested from the file's tag." : "Decimals are fine."}${more > 0 ? ` ${more} more to go.` : ""}`}
					confirmLabel={item.edit ? "Open in editor" : "Add track"}
					cancelLabel={item.edit ? "Cancel" : "Skip"}
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
	if (pendingDuplicate) {
		const close = (): void => store.set({ pendingDuplicate: null });
		const go = (): void => {
			close();
			void duplicateSet(pendingDuplicate.id);
		};
		return (
			<Modal onClose={close} onEnter={go} testId="duplicate-set-modal">
				<h3>Duplicate this set?</h3>
				<p className="file-name">{pendingDuplicate.name}</p>
				<p className="muted">A copy named “{pendingDuplicate.name} copy” is added to your sets.</p>
				<div className="buttons">
					<button className="ghost" onClick={close}>
						Cancel
					</button>
					<button className="primary" data-testid="duplicate-set-confirm" onClick={go}>
						Duplicate set
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
	const cues = useStore((s) => s.cues);
	const cueEdit = useStore((s) => s.cueEdit);
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
	const spot = menu.cue;
	if (!clip && !spot) return null;
	const track = clip && doc.tracks.find((t) => t.id === clip.trackId);
	const item = (label: string, fn: () => void, opts: { disabled?: boolean; hint?: string; testId?: string; key?: string } = {}): ReactNode => (
		<button
			key={opts.key ?? label}
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
	const clipItems = (): ReactNode => {
		if (!clip) return null;
		const beat = engine.positionBeat();
		const canSplit = beat > clip.startBeat && beat < clip.startBeat + clip.lengthBeat;
		const media = mediaFor(track, doc.bpm);
		const targets = flagTargets(clip.id);
		return (
			<>
				{item("Split at playhead", () => splitAt(beat, [clip.id]), { disabled: !canSplit, hint: "⌘S", testId: "menu-split" })}
				{item(flagAllOn(targets, "muted") ? "Unmute clip" : "Mute clip", () => toggleClipsFlag(targets, "muted"), { hint: "⌘M", testId: "menu-mute" })}
				{item(flagAllOn(targets, "lowCut") ? "Unmute bass" : "Mute bass", () => toggleClipsFlag(targets, "lowCut"), { hint: "⌘B", testId: "menu-lowcut" })}
				{item("Duplicate", duplicateSelection, { hint: "⌘D", testId: "menu-duplicate" })}
				{item("Align to grid", alignSelectionToGrid, { disabled: !track || alignPoint(track) === null, testId: "menu-align" })}
				{item("Delete", deleteSelection, { hint: "⌫", testId: "menu-delete" })}
				<hr />
				{track && item("Edit", () => openTrackEdit(track.id), { testId: "menu-edit" })}
				{track && item("Change track BPM…", () => store.set({ trackBpmEdit: track.id }), { testId: "menu-bpm" })}
				{track && media?.state === "error" && item("Try again", () => retryMedia(track, doc.bpm))}
				{track && media?.state === "error" && item("Locate file…", () => void relocateTrack(track.id))}
				{track && item("Show original in Finder", () => void window.api.reveal(track.sourcePath))}
			</>
		);
	};
	// Rekordbox's cues at this place in the track: the ones under the pointer can be deleted,
	// and one can be added on the nearest beat line. Only for a track Rekordbox knows.
	const cueItems = (): ReactNode => {
		if (!spot) return null;
		const canEdit = cueEdit[spot.path] ?? false;
		const taken = (cues[spot.path] ?? []).some((c) => c.kind === 0 && sameMoment(c.sec, spot.sec));
		return (
			<>
				{clip && <hr />}
				{spot.hits.map((c) => item(`Delete ${cueName(c)}`, () => deleteCue(spot, c.id), { disabled: !canEdit, testId: `menu-cue-delete-${c.kind}`, key: c.id }))}
				{item("Add memory cue", () => addCue(spot, 0), { disabled: !canEdit || taken, testId: "menu-cue-memory" })}
				{item("Add hot cue…", () => waitForHotCue(spot), { disabled: !canEdit, hint: "A–H", testId: "menu-cue-hot" })}
			</>
		);
	};
	const count = (clip ? 9 : 0) + (spot ? 2 + spot.hits.length : 0);
	const x = Math.min(menu.x, window.innerWidth - 230);
	const y = Math.max(0, Math.min(menu.y, window.innerHeight - 20 - count * 31));
	return (
		<div className="menu" style={{ left: x, top: y }} data-testid="clip-menu">
			{clipItems()}
			{cueItems()}
		</div>
	);
}

// Shown while "Add hot cue" waits for its letter. A click anywhere, or leaving the window,
// gives up; the keys are handled in App.tsx.
export function CueWait() {
	const waiting = useStore((s) => s.cueWait !== null);
	useEffect(() => {
		if (!waiting) return;
		const stop = (): void => store.set({ cueWait: null });
		window.addEventListener("pointerdown", stop);
		window.addEventListener("blur", stop);
		return () => {
			window.removeEventListener("pointerdown", stop);
			window.removeEventListener("blur", stop);
		};
	}, [waiting]);
	if (!waiting) return null;
	return (
		<div className="toast cue-wait" data-testid="cue-wait">
			Press A to H for the hot cue. Esc cancels.
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
