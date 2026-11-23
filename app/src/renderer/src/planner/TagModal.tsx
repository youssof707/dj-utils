// The app's tags on one library track (Rekordbox My Tags in a category of the app's own):
// pick from the tags there are, make a new one by typing its name, and take tags off.
// Nothing is written until Save, and then in one go.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RekordboxTag, RekordboxTrack, TagChangeResult } from "@shared/planner";
import { Modal } from "./Panels";
import { plain } from "./text";

type NewTag = { name: string };
// A line of the list the arrow keys move through: "Create …", a tag of the library, or one
// made here that is not saved yet.
type Line = { kind: "create" } | { kind: "tag"; id: string; name: string } | { kind: "new"; index: number; name: string };

const same = (a: string, b: string): boolean => plain(a.trim()) === plain(b.trim());
const key = (l: Line): string => (l.kind === "tag" ? l.id : l.kind === "new" ? `new-${l.index}` : "create");

// Rows the list has room for at most; it is sized by every tag there is, not by the ones a
// search leaves, so the modal keeps its size while typing.
const MAX_ROWS = 8;
const MIN_ROWS = 3;
const ROW_PX = 32;

export function TagModal({ track, title, artist, tags, canTag, onClose, onSaved }: { track: RekordboxTrack; title: string; artist: string; tags: RekordboxTag[]; canTag: boolean; onClose: () => void; onSaved: (r: TagChangeResult) => void }) {
	const byId = useMemo(() => new Map(tags.map((t) => [t.id, t] as const)), [tags]);
	const [chosen, setChosen] = useState<string[]>(() => track.tags.filter((id) => byId.has(id)));
	const [made, setMade] = useState<NewTag[]>([]);
	const [query, setQuery] = useState("");
	// The highlighted line: the one under the mouse or moved to with the arrow keys; -1 for none.
	const [at, setAt] = useState(-1);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);

	const words = plain(query).split(/\s+/).filter(Boolean);
	const matches = (n: string): boolean => words.every((w) => plain(n).includes(w));
	const name = query.trim();
	// Offered when no tag, and no tag about to be made, has the name typed.
	const canCreate = canTag && !!name && !tags.some((t) => same(t.name, name)) && !made.some((t) => same(t.name, name));
	const lines: Line[] = [
		...(canCreate ? [{ kind: "create" } as const] : []),
		...tags.filter((t) => matches(t.name)).map((t) => ({ kind: "tag", id: t.id, name: t.name }) as const),
		...made.map((t, index) => ({ kind: "new", index, name: t.name }) as const).filter((l) => matches(l.name)),
	];
	const cursor = at < 0 ? -1 : Math.min(at, lines.length - 1);
	const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, tags.length + made.length));
	const count = chosen.length + made.length;

	// The line the arrow keys are on stays in view.
	useLayoutEffect(() => {
		list.current?.querySelector(".at")?.scrollIntoView({ block: "nearest" });
	}, [cursor, query]);

	const pick = (l: Line): void => {
		if (!canTag) return;
		if (l.kind === "create") return create();
		if (l.kind === "tag") setChosen((c) => (c.includes(l.id) ? c.filter((x) => x !== l.id) : [...c, l.id]));
		else setMade((m) => m.filter((_, j) => j !== l.index));
		input.current?.focus();
	};
	const create = (): void => {
		if (!canCreate) return;
		setMade((m) => [...m, { name }]);
		setQuery("");
		setAt(-1);
		input.current?.focus();
	};

	const changed = made.length > 0 || chosen.length !== track.tags.filter((id) => byId.has(id)).length || chosen.some((id) => !track.tags.includes(id));
	const save = async (): Promise<void> => {
		if (saving) return;
		if (!changed) return onClose();
		setSaving(true);
		setError(null);
		try {
			const r = await window.api.setTrackTags({ contentId: track.id, keep: chosen, create: made });
			onSaved(r);
			onClose();
		} catch (e) {
			// Electron puts its own words in front of the message from the main process
			setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
			setSaving(false);
		}
	};

	const close = (): void => {
		if (!saving) onClose();
	};

	return (
		<Modal onClose={close} testId="tag-modal">
			<div className="tag-modal">
				<h3>Tags</h3>
				<p className="file-name">{artist ? `${title} · ${artist}` : title}</p>

				<input
					ref={input}
					className="search tag-search"
					data-testid="tag-search"
					placeholder={canTag ? "Search or make a tag" : "Search tags"}
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
							if (lines.length) setAt(cursor < 0 ? (e.key === "ArrowDown" ? 0 : lines.length - 1) : (cursor + (e.key === "ArrowDown" ? 1 : lines.length - 1)) % lines.length);
						} else if (e.key === "Enter") {
							e.preventDefault();
							// with nothing typed, Enter saves
							if (!name) return void save();
							// with nothing highlighted, the first line
							const line = lines[Math.max(0, cursor)];
							if (!line) return;
							pick(line);
							if (line.kind !== "create") {
								setQuery("");
								setAt(-1);
							}
						} else if (e.key === "Escape" && query) {
							e.stopPropagation();
							setQuery("");
							setAt(-1);
						}
					}}
				/>

				<div className="tag-list" data-testid="tag-list" ref={list} style={{ height: rows * ROW_PX }} onMouseLeave={() => setAt(-1)}>
					{lines.length === 0 ? (
						<p className="tag-empty">{tags.length === 0 && made.length === 0 ? (canTag ? "No tags yet. Type a name to make one." : "No tags yet") : "No tags match"}</p>
					) : (
						lines.map((l, i) => {
							const on = l.kind === "new" || (l.kind === "tag" && chosen.includes(l.id));
							const at = i === cursor ? " at" : "";
							if (l.kind === "create")
								return (
									<button key="create" className={`tag-line tag-create${at}`} data-testid="tag-create" onMouseMove={() => setAt(i)} onClick={create}>
										<svg className="tag-plus" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
											<path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
										</svg>
										<span className="tag-name">Create “{name}”</span>
									</button>
								);
							return (
								<button
									key={key(l)}
									className={`tag-line tag-option${at}${on ? " on" : ""}`}
									data-testid="tag-option"
									data-new={l.kind === "new" || undefined}
									aria-pressed={on}
									disabled={!canTag}
									onMouseMove={() => setAt(i)}
									onClick={() => pick(l)}
								>
									<span className="tag-name">{l.name}</span>
									{l.kind === "new" && <span className="tag-new">new</span>}
									<svg className="tag-check" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
										<path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
									</svg>
								</button>
							);
						})
					)}
				</div>

				{!canTag && <p className="muted">Tags cannot be changed in this build of the app.</p>}
				{error && (
					<p className="error" data-testid="tag-error">
						{error}
					</p>
				)}
				<div className="buttons">
					{count > 0 && <span className="tag-count muted">{count === 1 ? "1 tag" : `${count} tags`}</span>}
					<button className="ghost" onClick={close} disabled={saving}>
						Cancel
					</button>
					<button className="primary" data-testid="tag-save" onClick={() => void save()} disabled={saving || !canTag}>
						{saving ? "Saving…" : "Save"}
					</button>
				</div>
			</div>
		</Modal>
	);
}
