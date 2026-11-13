// Preview for the track editor: plays the sections in their new order (or, with two tracks
// open, one of them as it is) from the tracks' audio as the set has it (stretched to the set's tempo), so an arrangement can be heard
// before it is exported. The export itself never uses this audio; it reads the source file.

import { trackBeats } from "@shared/planner";
import { leadBeat, place, secondOffset, srcOf, totalBeats } from "@shared/trackEdit";
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
	// What plays, in order. On the result: the lead-in, then each section, with silence where
	// there is a gap; sections that follow each other in their track as well, with no gap, play
	// as one stretch. On a track's own lane: that track, as it is.
	const lead = leadBeat(e.track);
	const runs: { outBeat: number; srcBeat: number; length: number; src: number }[] = [];
	const source = e.lane === "out" ? null : e.lane === 0 ? e.track : e.second;
	let total: number;
	if (e.lane !== "out" && source) {
		const off = e.lane === 1 && e.second ? secondOffset(e.track, e.second) : 0;
		runs.push({ outBeat: off, srcBeat: 0, length: trackBeats(source), src: e.lane });
		total = off + trackBeats(source);
	} else {
		const placed = place(lead, e.sections);
		// The lead-in is the first track's: an edit that opens with the other track starts silent.
		if (lead > 0 && (placed.length === 0 || srcOf(placed[0].section) === 0)) runs.push({ outBeat: 0, srcBeat: 0, length: lead, src: 0 });
		for (const p of placed) {
			const last = runs[runs.length - 1];
			const src = srcOf(p.section);
			if (last && last.src === src && Math.abs(last.srcBeat + last.length - p.section.startBeat) < 1e-6 && Math.abs(last.outBeat + last.length - p.outBeat) < 1e-6) last.length += p.lengthBeat;
			else runs.push({ outBeat: p.outBeat, srcBeat: p.section.startBeat, length: p.lengthBeat, src });
		}
		total = totalBeats(lead, e.sections);
	}
	// Each track's audio as the set has it.
	const tracks = [e.track, e.second];
	const paths: (string | null)[] = [null, null];
	for (const src of new Set(runs.map((r) => r.src))) {
		const t = tracks[src];
		const media = t ? mediaFor(t, s.doc.bpm) : null;
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
		const src = new AudioBufferSourceNode(ctx, { buffer: bufs[r.src]! });
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
