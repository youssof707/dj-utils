// Preview for the track editor: plays the lane, overlaps and all, at the editor's tempo (the
// first track's own, unless changed), so an arrangement can be heard before it is exported. The export itself never uses this audio; it reads the source file.

import { trackBeats } from "@shared/planner";
import { place, srcOf, totalBeats } from "@shared/trackEdit";
import { engine } from "./engine";
import { mediaFor } from "./media";
import { store } from "./store";

const JOIN_SEC = 0.005; // the same blend into a join as the export makes

type Voice = { src: AudioBufferSourceNode; gain: GainNode };

let voices: Voice[] = [];
let out: GainNode | null = null;
let token = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let t0 = 0; // audio-clock time at which `fromBeat` is heard
let fromBeat = 0;
let secPerBeat = 0.5;

function silence(): void {
	clearInterval(timer);
	timer = undefined;
	for (const v of voices) {
		try {
			v.src.stop();
		} catch {
			// not started yet
		}
		v.src.disconnect();
		v.gain.disconnect();
	}
	voices = [];
}

function setPlaying(playing: boolean): void {
	const e = store.get().trackEdit;
	if (e && e.playing !== playing) store.set({ trackEdit: { ...e, playing } });
}

export function stopEditPreview(): void {
	token++;
	silence();
	setPlaying(false);
}

// Where the preview is, in beats of the result; the cursor while it is not playing.
export function editPositionBeat(): number {
	const e = store.get().trackEdit;
	if (!e) return 0;
	if (!e.playing || voices.length === 0) return e.cursorBeat;
	const ctx = engine.audio();
	return Math.max(fromBeat, fromBeat + (ctx.currentTime - (ctx.outputLatency || 0) - t0) / secPerBeat);
}

export async function playEditPreview(): Promise<void> {
	const s = store.get();
	const e = s.trackEdit;
	if (!e) return;
	engine.stopPreviews(stopEditPreview);
	// What plays: each section, with sections that follow each other in their track as well as
	// on the lane played as one stretch.
	const runs: { outBeat: number; srcBeat: number; length: number; src: number }[] = [];
	for (const p of place(e.sections)) {
		const src = srcOf(p.section);
		const prev = runs.find((r) => r.src === src && Math.abs(r.srcBeat + r.length - p.section.startBeat) < 1e-6 && Math.abs(r.outBeat + r.length - p.outBeat) < 1e-6);
		if (prev) prev.length += p.lengthBeat;
		else runs.push({ outBeat: p.outBeat, srcBeat: p.section.startBeat, length: p.lengthBeat, src });
	}
	const total = totalBeats(e.sections);
	// Each track's audio at the editor's tempo.
	const paths: (string | null)[] = e.tracks.map(() => null);
	for (const src of new Set(runs.map((r) => r.src))) {
		const t = e.tracks[src];
		const media = t ? mediaFor(t, e.bpm) : null;
		if (media?.state !== "ready") {
			store.set({ trackEdit: { ...e, error: "The track's audio is not ready to play yet" } });
			return;
		}
		paths[src] = media.cachePath;
	}
	if (s.playing) engine.stop();
	const my = ++token;
	silence();
	setPlaying(true);
	const ctx = engine.audio();
	const [bufs] = await Promise.all([Promise.all(paths.map((p) => (p ? engine.buffer(p) : null))), ctx.resume()]);
	if (my !== token) return;
	if (runs.some((r) => !bufs[r.src])) {
		stopEditPreview();
		return;
	}
	if (!out) {
		// The same level as the set plays at.
		out = new GainNode(ctx, { gain: 0.6 });
		out.connect(ctx.destination);
	}
	secPerBeat = 60 / e.bpm;
	fromBeat = e.cursorBeat >= total - 1e-6 ? 0 : Math.max(0, e.cursorBeat);
	t0 = ctx.currentTime + 0.08;
	const clock = (beat: number): number => t0 + (beat - fromBeat) * secPerBeat;
	runs.forEach((r) => {
		const endBeat = r.outBeat + r.length;
		if (endBeat <= fromBeat + 1e-6) return;
		const startBeat = Math.max(r.outBeat, fromBeat);
		const when = clock(startBeat);
		const endAt = clock(endBeat);
		const offset = (r.srcBeat + (startBeat - r.outBeat)) * secPerBeat;
		// A join: this run fades in over the moment before it, from the audio that led up to
		// it in the track, while the run before fades out.
		const pre = startBeat === r.outBeat ? Math.min(JOIN_SEC, offset, when - ctx.currentTime - 0.01) : 0;
		const src = new AudioBufferSourceNode(ctx, { buffer: bufs[r.src]! });
		const gain = new GainNode(ctx, { gain: 1 });
		if (pre > 0) {
			gain.gain.setValueAtTime(0, when - pre);
			gain.gain.linearRampToValueAtTime(1, when);
		}
		// It fades out at its end, unless it runs to the end of its track.
		if (r.srcBeat + r.length < trackBeats(e.tracks[r.src]) - 1e-6) {
			gain.gain.setValueAtTime(1, Math.max(when, endAt - JOIN_SEC));
			gain.gain.linearRampToValueAtTime(0, endAt);
		}
		src.connect(gain).connect(out!);
		src.start(when - Math.max(0, pre), Math.max(0, offset - Math.max(0, pre)));
		src.stop(endAt);
		voices.push({ src, gain });
	});
	const endAt = clock(total);
	timer = setInterval(() => {
		if (my !== token) return;
		if (ctx.currentTime > endAt + 0.2) stopEditPreview();
	}, 100);
}

export function toggleEditPreview(): void {
	if (store.get().trackEdit?.playing) stopEditPreview();
	else void playEditPreview();
}

// The set starting to play, or the library's preview, stops this preview.
engine.addPreview(stopEditPreview);
