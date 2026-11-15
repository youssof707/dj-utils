// Preview of a Rekordbox track from the library panel, as in Rekordbox's own browser: the file
// as it is (not stretched), played through an <audio> element from where its bar was clicked.
// It stops the set and the track editor's preview, and they stop it.
import { useSyncExternalStore } from "react";
import { engine } from "./engine";
import { store } from "./store";

let audio: HTMLAudioElement | null = null;
let current: string | null = null; // the file playing
let pending = 0; // where to start once the file's length is known, as a fraction of it
const listeners = new Set<() => void>();
const tell = (): void => listeners.forEach((l) => l());

function urlOf(path: string, decoded: boolean): string {
	return `library-audio://track/?path=${encodeURIComponent(path)}${decoded ? "&decoded=1" : ""}`;
}

function lengthOf(a: HTMLAudioElement, lengthSec: number): number {
	return Number.isFinite(a.duration) && a.duration > 0 ? a.duration : lengthSec;
}

// Plays `path` from `fraction` of the way in; on the file already playing, jumps there.
export function playLibraryPreview(path: string, fraction: number, lengthSec: number): void {
	engine.stopPreviews(stopLibraryPreview);
	if (store.get().playing) engine.stop();
	pending = Math.min(Math.max(fraction, 0), 0.999);
	if (audio && current === path) {
		if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) audio.currentTime = pending * lengthOf(audio, lengthSec);
		void audio.play().catch(() => {});
		return;
	}
	stopLibraryPreview();
	const a = new Audio();
	let decoded = false;
	a.addEventListener("loadedmetadata", () => {
		if (pending > 0) a.currentTime = pending * lengthOf(a, lengthSec);
	});
	a.addEventListener("ended", () => {
		if (audio === a) stopLibraryPreview();
	});
	// Chromium cannot play every format (AIFF, ALAC): those go through the system decoder.
	a.addEventListener("error", () => {
		if (audio !== a) return;
		if (decoded) {
			console.error(`Library preview: ${path} could not be played (${a.error?.message || `media error ${a.error?.code}`})`);
			return stopLibraryPreview();
		}
		decoded = true;
		a.src = urlOf(path, true);
		void a.play().catch(() => {});
	});
	a.src = urlOf(path, false);
	audio = a;
	current = path;
	tell();
	void a.play().catch(() => {});
}

export function stopLibraryPreview(): void {
	if (!audio) return;
	const a = audio;
	audio = null;
	current = null;
	a.pause();
	a.removeAttribute("src");
	a.load();
	tell();
}

export function toggleLibraryPreview(path: string, lengthSec: number): void {
	if (current === path) stopLibraryPreview();
	else playLibraryPreview(path, 0, lengthSec);
}

// How far into the playing file the preview is, as a fraction of it.
export function libraryPreviewAt(lengthSec: number): number {
	if (!audio) return 0;
	return Math.min(1, audio.currentTime / lengthOf(audio, lengthSec));
}

const subscribe = (l: () => void): (() => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

// The file the preview is playing, or null.
export function useLibraryPreview(): string | null {
	return useSyncExternalStore(subscribe, () => current);
}

engine.addPreview(stopLibraryPreview);
