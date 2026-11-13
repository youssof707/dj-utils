import type { RekordboxLibrary } from "@shared/planner";
import { store } from "./store";

// Rekordbox's key for each file in its library, shown before a clip's name on the timeline.
export function setTrackKeys(library: RekordboxLibrary | null): void {
	const keys: Record<string, string> = {};
	for (const t of library?.tracks ?? []) if (t.key) keys[t.path] = t.key;
	store.set({ trackKeys: keys });
}

// Read again when the window comes back to the front, so a key changed in Rekordbox shows.
export function refreshTrackKeys(): void {
	window.api.rekordboxLibrary().then(setTrackKeys, () => {});
}
