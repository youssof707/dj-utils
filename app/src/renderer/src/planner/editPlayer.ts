// Preview for the track editor: plays the sections in their new order from the track's
// audio as the set has it (stretched to the set's tempo), so an arrangement can be heard
// before it is exported. The export itself never uses this audio; it reads the source file.

import { leadBeat, place, totalBeats } from "@shared/trackEdit";
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
	const media = mediaFor(e.track, s.doc.bpm);
	if (media?.state !== "ready") {
		store.set({ trackEdit: { ...e, error: "The track's audio is not ready to play yet" } });
		return;
	}
	if (s.playing) engine.stop();
	const my = ++token;
	silence();
	setPlaying(true);
	const ctx = engine.audio();
	const [buf] = await Promise.all([engine.buffer(media.cachePath), ctx.resume()]);
	if (my !== token) return;
	if (!buf) {
		stopEditPreview();
		return;
	}
	if (!out) {
		// The same level as the set plays at.
		out = new GainNode(ctx, { gain: 0.6 });
		out.connect(ctx.destination);
	}
	// What plays, in order: the lead-in, then each section, with silence where there is a gap.
	// Sections that follow each other in the track as well, with no gap, play as one stretch.
	const lead = leadBeat(e.track);
	const runs: { outBeat: number; srcBeat: number; length: number }[] = lead > 0 ? [{ outBeat: 0, srcBeat: 0, length: lead }] : [];
	for (const p of place(lead, e.sections)) {
		const last = runs[runs.length - 1];
		if (last && Math.abs(last.srcBeat + last.length - p.section.startBeat) < 1e-6 && Math.abs(last.outBeat + last.length - p.outBeat) < 1e-6) last.length += p.lengthBeat;
		else runs.push({ outBeat: p.outBeat, srcBeat: p.section.startBeat, length: p.lengthBeat });
	}
	const total = totalBeats(lead, e.sections);
	secPerBeat = 60 / s.doc.bpm;
	fromBeat = e.cursorBeat >= total - 1e-6 ? 0 : Math.max(0, e.cursorBeat);
	t0 = ctx.currentTime + 0.08;
	const clock = (beat: number): number => t0 + (beat - fromBeat) * secPerBeat;
	runs.forEach((r, i) => {
		const endBeat = r.outBeat + r.length;
		if (endBeat <= fromBeat + 1e-6) return;
		const startBeat = Math.max(r.outBeat, fromBeat);
		const when = clock(startBeat);
		const endAt = clock(endBeat);
		const offset = (r.srcBeat + (startBeat - r.outBeat)) * secPerBeat;
		// A join: this run fades in over the moment before it, from the audio that led up to
		// it in the track, while the run before fades out.
		const pre = i > 0 && startBeat === r.outBeat ? Math.min(JOIN_SEC, offset, when - ctx.currentTime - 0.01) : 0;
		const src = new AudioBufferSourceNode(ctx, { buffer: buf });
		const gain = new GainNode(ctx, { gain: 1 });
		if (pre > 0) {
			gain.gain.setValueAtTime(0, when - pre);
			gain.gain.linearRampToValueAtTime(1, when);
		}
		if (i < runs.length - 1) {
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

// The set starting to play stops the preview.
engine.onPlay = stopEditPreview;
