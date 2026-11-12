// Test signals and measurements shared by unit and end-to-end tests.
import { SAMPLE_RATE } from "../src/shared/planner";
import { WavReader, WavWriter } from "../src/main/audio/wav";

const SR = SAMPLE_RATE;

// A click on every beat: a 4 ms burst of `clickHz`. Optional steady tone underneath.
export function writeClickTrack(path: string, bpm: number, seconds: number, opts: { clickHz?: number; toneHz?: number; clickAmp?: number; kind?: "float32" | "int16" } = {}): void {
	const frames = Math.round(seconds * SR);
	const data = new Float32Array(frames * 2);
	const clickHz = opts.clickHz ?? 1000;
	const amp = opts.clickAmp ?? 0.8;
	const len = Math.round(0.004 * SR);
	for (let beat = 0; ; beat++) {
		const start = Math.round(((beat * 60) / bpm) * SR);
		if (start + len >= frames) break;
		for (let i = 0; i < len; i++) {
			const v = amp * Math.sin((2 * Math.PI * clickHz * i) / SR + Math.PI / 2) * (1 - i / len);
			data[(start + i) * 2] += v;
			data[(start + i) * 2 + 1] += v;
		}
	}
	if (opts.toneHz) {
		for (let i = 0; i < frames; i++) {
			const v = 0.2 * Math.sin((2 * Math.PI * opts.toneHz * i) / SR);
			data[i * 2] += v;
			data[i * 2 + 1] += v;
		}
	}
	const w = new WavWriter(path, SR, opts.kind ?? "int16");
	w.write(data, frames);
	w.close();
}

export function writeTone(path: string, hz: number, seconds: number, amp = 0.5): void {
	const frames = Math.round(seconds * SR);
	const data = new Float32Array(frames * 2);
	for (let i = 0; i < frames; i++) {
		const v = amp * Math.sin((2 * Math.PI * hz * i) / SR);
		data[i * 2] = v;
		data[i * 2 + 1] = v;
	}
	const w = new WavWriter(path, SR, "int16");
	w.write(data, frames);
	w.close();
}

export function readAll(path: string): { left: Float32Array; frames: number } {
	const r = new WavReader(path);
	const buf = new Float32Array(r.frames * 2);
	r.read(0, r.frames, buf);
	const left = new Float32Array(r.frames);
	for (let i = 0; i < r.frames; i++) left[i] = buf[i * 2];
	const frames = r.frames;
	r.close();
	return { left, frames };
}

// Frame positions where the signal first rises above `threshold`, at least `gapSec` apart.
export function onsets(x: Float32Array, threshold: number, gapSec = 0.1): number[] {
	const out: number[] = [];
	const gap = Math.round(gapSec * SR);
	for (let i = 0; i < x.length; i++) {
		if (Math.abs(x[i]) > threshold) {
			out.push(i);
			i += gap;
		}
	}
	return out;
}

// Dominant frequency over a window, from zero crossings.
export function frequency(x: Float32Array, startSec: number, lenSec: number): number {
	const a = Math.round(startSec * SR);
	const b = Math.min(x.length - 1, Math.round((startSec + lenSec) * SR));
	let first = -1;
	let last = -1;
	let count = 0;
	for (let i = a + 1; i <= b; i++) {
		if (x[i - 1] <= 0 && x[i] > 0) {
			const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
			if (first < 0) first = t;
			else count++;
			last = t;
		}
	}
	return count > 0 ? (count * SR) / (last - first) : 0;
}
