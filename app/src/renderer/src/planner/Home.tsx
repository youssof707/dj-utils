// The list of sets the app opens on: make a new one, or pick up one from before.

import { useState } from "react";
import type { SetInfo } from "@shared/planner";
import { newSet, openSet, renameSet } from "./actions";
import { fmtLength, NameEdit } from "./Panels";
import { openSettings } from "./Settings";
import { store, useStore } from "./store";

function fmtWhen(at: number): string {
	const min = Math.floor((Date.now() - at) / 60000);
	if (min < 1) return "just now";
	if (min < 60) return `${min} min ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return d === 1 ? "yesterday" : `${d} days ago`;
	return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function Row({ set }: { set: SetInfo }) {
	const [renaming, setRenaming] = useState(false);
	const stop = (fn: () => void) => (e: React.MouseEvent): void => {
		e.stopPropagation();
		fn();
	};
	return (
		<div className="set-row" data-testid="set-row" data-name={set.name} onClick={() => !renaming && void openSet(set.id)}>
			<div className="set-row-main">
				{renaming ? (
					<NameEdit
						name={set.name}
						testId="set-rename-input"
						onDone={(name) => {
							setRenaming(false);
							if (name !== null) void renameSet(set.id, name);
						}}
					/>
				) : (
					<div className="set-row-name">{set.name}</div>
				)}
				<div className="muted">
					Edited {fmtWhen(set.updatedAt)} · {set.tracks} track{set.tracks === 1 ? "" : "s"}
					{set.lengthSec > 0 ? ` · ${fmtLength(set.lengthSec)}` : ""}
				</div>
			</div>
			<div className="set-row-actions">
				<button className="ghost" data-testid="set-rename" onClick={stop(() => setRenaming(true))}>
					Rename
				</button>
				<button className="ghost" data-testid="set-duplicate" onClick={stop(() => store.set({ pendingDuplicate: set }))}>
					Duplicate
				</button>
				<button className="ghost" data-testid="set-delete" onClick={stop(() => store.set({ pendingDelete: set }))}>
					Delete
				</button>
			</div>
		</div>
	);
}

export function Home() {
	const sets = useStore((s) => s.sets) ?? [];
	return (
		<div className="home" data-testid="home">
			<div className="home-inner">
				<div className="home-head">
					<h1>Your sets</h1>
					<div className="home-actions">
						<button className="ghost" data-testid="open-settings" onClick={openSettings}>
							Settings
						</button>
						<button className="primary" data-testid="new-set" onClick={() => void newSet({ askName: true })}>
							New set
						</button>
					</div>
				</div>
				{sets.length === 0 ? (
					<p className="muted home-empty" data-testid="home-empty">
						No sets yet. Start one, and it is kept here from then on. There is nothing to save.
					</p>
				) : (
					<div className="set-list">
						{sets.map((s) => (
							<Row key={s.id} set={s} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}
