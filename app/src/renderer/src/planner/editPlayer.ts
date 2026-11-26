// Preview for the track editor: plays the lane, overlaps and all, at the editor's tempo (the
// first track's own, unless changed), so an arrangement can be heard before it is exported. The export itself never uses this audio; it reads the source file.

import { LOW_CUT_EDGE_SEC, LOW_CUT_END_HZ, LOW_CUT_HZ, LOW_CUT_QS, trackBeats } from "@shared/planner";
import { fadeGain } from "@shared/fades";
import { editRuns, totalBeats } from "@shared/trackEdit";
import { engine } from "./engine";
import { mediaFor } from "./media";
import { store } from "./store";

const JOIN_SEC = 0.005; // the same blend into a join as the export makes
const FADE_IN_STEPS = 24; // straight pieces the fade-in curve is drawn with, as the set's playback does

type Voice = { src: AudioBufferSourceNode; filters: BiquadFilterNode[]; gain: GainNode; fade: GainNode | null };

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
		for (const f of v.filters) f.disconnect();
		v.gain.disconnect();
		v.fade?.disconnect();
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
	// What plays: the same stretches as the export makes (see editRuns).
	const runs = editRuns(e.sections).map((r) => ({ outBeat: r.atBeat, srcBeat: r.startBeat, length: r.lengthBeat, src: r.src, lowCut: r.lowCut, fadeIn: r.fadeInBeat, fadeOut: r.fadeOutBeat }));
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
		const pre = startBeat === r.outBeat && r.fadeIn <= 0 ? Math.min(JOIN_SEC, offset, when - ctx.currentTime - 0.01) : 0;
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
		// Without its bass: the same low cut as the set's "Mute bass", with the cut-off sliding
		// down over the last moment so the bass is back by the join. Web Audio takes Q in dB.
		const filters = r.lowCut ? LOW_CUT_QS.map((q) => new BiquadFilterNode(ctx, { type: "highpass", frequency: LOW_CUT_HZ, Q: 20 * Math.log10(q) })) : [];
		let tail: AudioNode = src;
		for (const flt of filters) {
			flt.frequency.setValueAtTime(LOW_CUT_HZ, Math.max(when, endAt - LOW_CUT_EDGE_SEC));
			flt.frequency.exponentialRampToValueAtTime(LOW_CUT_END_HZ, endAt);
			tail.connect(flt);
			tail = flt;
		}
		// Its volume fades, from wherever the preview starts in them: the fade-in along its
		// curve, the fade-out straight down.
		let fade: GainNode | null = null;
		if (r.fadeIn > 0 || r.fadeOut > 0) {
			fade = new GainNode(ctx, { gain: 1 });
			const g = fade.gain;
			const gainAt = (beat: number): number => fadeGain(beat - r.outBeat, r.length, r.fadeIn, r.fadeOut);
			g.setValueAtTime(gainAt(startBeat), when);
			const inEnd = r.outBeat + r.fadeIn;
			if (startBeat < inEnd) for (let k = 1; k <= FADE_IN_STEPS; k++) {
				const b = startBeat + ((inEnd - startBeat) * k) / FADE_IN_STEPS;
				g.linearRampToValueAtTime(gainAt(b), clock(b));
			}
			const outStart = Math.max(startBeat, endBeat - r.fadeOut);
			if (r.fadeOut > 0) {
				g.setValueAtTime(gainAt(outStart), clock(outStart));
				g.linearRampToValueAtTime(0, endAt);
			}
		}
		tail.connect(gain);
		(fade ? gain.connect(fade) : gain).connect(out!);
		src.start(when - Math.max(0, pre), Math.max(0, offset - Math.max(0, pre)));
		src.stop(endAt);
		voices.push({ src, filters, gain, fade });
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
