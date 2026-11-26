import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { testDir } from "../testdata";
import { afconvertToWav } from "../../src/main/audio/dsp";
import { CLIP_DB, KWeight, LevelMeter, levelGain, LEVEL_FLOOR, SoftClipper, Tpdf, TruePeakLimiter, TruePeakMeter } from "../../src/main/audio/layerMix";
import { blendWeight, EDGE_SEC, exportEdit, JOIN_SEC, mixZones, spliceWav } from "../../src/main/audio/splice";
import { parseWavHeader, WavReader } from "../../src/main/audio/wav";
import { fadeGain } from "../../src/shared/fades";
import { editLayers, type Layer } from "../../src/shared/trackEdit";

// Stretches one after the other, as layers: a silent one is a stretch with nothing in it.
type Slice = { start: number; frames: number; silent?: boolean; src?: number };
const seq = (parts: Slice[]): Layer[] => {
	let at = 0;
	const out: Layer[] = [];
	for (const p of parts) {
		if (!p.silent) out.push({ src: p.src ?? 0, start: p.start, frames: p.frames, at });
		at += p.frames;
	}
	return out;
};

let dir: string;
beforeAll(() => {
	dir = testDir("splice-");
});

type Fmt = { sampleRate: number; bits: 16 | 24 | 32; channels: number };

// Writes an integer PCM WAV whose samples come from `sample` (-1..1 by frame and channel).
function writePcm(file: string, fmt: Fmt, frames: number, sample: (frame: number, ch: number) => number): void {
	const bps = fmt.bits / 8;
	const data = Buffer.alloc(frames * fmt.channels * bps);
	const full = 2 ** (fmt.bits - 1) - 1;
	for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) data.writeIntLE(Math.round(sample(i, c) * full), (i * fmt.channels + c) * bps, bps);
	const h = Buffer.alloc(44);
	h.write("RIFF", 0, "latin1");
	h.writeUInt32LE(36 + data.length, 4);
	h.write("WAVE", 8, "latin1");
	h.write("fmt ", 12, "latin1");
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(fmt.channels, 22);
	h.writeUInt32LE(fmt.sampleRate, 24);
	h.writeUInt32LE(fmt.sampleRate * fmt.channels * bps, 28);
	h.writeUInt16LE(fmt.channels * bps, 32);
	h.writeUInt16LE(fmt.bits, 34);
	h.write("data", 36, "latin1");
	h.writeUInt32LE(data.length, 40);
	fs.writeFileSync(file, Buffer.concat([h, data]));
}

// The file's format and its audio as raw bytes.
function pcmOf(file: string): { fmt: Fmt; frames: number; data: Buffer; frame: (i: number, ch?: number) => number } {
	const fd = fs.openSync(file, "r");
	try {
		const info = parseWavHeader(fd);
		const bps = info.bits / 8;
		const data = Buffer.alloc(info.frames * info.channels * bps);
		fs.readSync(fd, data, 0, data.length, info.dataOffset);
		return { fmt: { sampleRate: info.sampleRate, bits: info.bits as Fmt["bits"], channels: info.channels }, frames: info.frames, data, frame: (i, ch = 0) => data.readIntLE((i * info.channels + ch) * bps, bps) };
	} finally {
		fs.closeSync(fd);
	}
}

function noise(seed: number): (frame: number, ch: number) => number {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) >>> 0;
		return (s / 0xffffffff) * 1.8 - 0.9;
	};
}

const bytes = (p: { data: Buffer; fmt: Fmt }, fromFrame: number, toFrame: number): Buffer => {
	const fb = (p.fmt.bits / 8) * p.fmt.channels;
	return p.data.subarray(fromFrame * fb, toFrame * fb);
};

describe("exporting an edit", () => {
	const formats: Fmt[] = [
		{ sampleRate: 44100, bits: 16, channels: 2 },
		{ sampleRate: 48000, bits: 24, channels: 1 },
		{ sampleRate: 96000, bits: 24, channels: 2 },
	];

	for (const fmt of formats) {
		it(`leaves an uncut track byte for byte as it was (${fmt.bits} bit, ${fmt.sampleRate} Hz, ${fmt.channels} ch)`, () => {
			const src = path.join(dir, `same-${fmt.bits}-${fmt.sampleRate}.wav`);
			const out = path.join(dir, `same-${fmt.bits}-${fmt.sampleRate}-out.wav`);
			const frames = fmt.sampleRate * 3 + 17;
			writePcm(src, fmt, frames, noise(3));
			// Cut in three places and left in order: still one unbroken copy.
			const bpm = 128;
			const lead = 0.37;
			const total = (frames / fmt.sampleRate) * (bpm / 60);
			const sections = [
				{ startBeat: 0, lengthBeat: lead + 2, atBeat: 0 },
				{ startBeat: lead + 2, lengthBeat: 1, atBeat: lead + 2 },
				{ startBeat: lead + 3, lengthBeat: total - lead - 3, atBeat: lead + 3 },
			];
			const slices = editLayers(sections, bpm, fmt.sampleRate, [frames]);
			expect(slices).toEqual([{ src: 0, start: 0, frames, at: 0 }]);
			const r = spliceWav(src, out, slices, { bpm, downbeatSec: 0.1 });
			expect(r).toEqual({ frames, sampleRate: fmt.sampleRate, bits: fmt.bits, channels: fmt.channels });
			const a = pcmOf(src);
			const b = pcmOf(out);
			expect(b.fmt).toEqual(fmt);
			expect(b.frames).toBe(frames);
			expect(b.data.equals(a.data)).toBe(true);
		});
	}

	it("copies rearranged sections exactly, end to end, and only blends the moment before a join", () => {
		const fmt: Fmt = { sampleRate: 44100, bits: 16, channels: 2 };
		const src = path.join(dir, "move.wav");
		const out = path.join(dir, "move-out.wav");
		writePcm(src, fmt, 60000, noise(11));
		const slices: Slice[] = [
			{ start: 0, frames: 1000 },
			{ start: 30000, frames: 20000 },
			{ start: 5000, frames: 10000 },
		];
		const r = spliceWav(src, out, seq(slices), null);
		// Nothing overlaps: the length is the sum of the sections.
		expect(r.frames).toBe(31000);
		const a = pcmOf(src);
		const b = pcmOf(out);
		const n = Math.round(JOIN_SEC * fmt.sampleRate);
		// Each section is the source's own bytes up to the blend before the next join...
		expect(bytes(b, 0, 1000 - n).equals(bytes(a, 0, 1000 - n))).toBe(true);
		expect(bytes(b, 1000, 21000 - n).equals(bytes(a, 30000, 50000 - n))).toBe(true);
		expect(bytes(b, 21000, 31000 - n).equals(bytes(a, 5000, 15000 - n))).toBe(true);
		// ...and the blend goes from the outgoing audio to what led up to the incoming section.
		for (const [at, from, to] of [
			[1000, 1000, 30000],
			[21000, 50000, 5000],
		]) {
			for (let k = 0; k < n; k++) {
				const w = blendWeight(k, n);
				for (let c = 0; c < 2; c++) {
					const want = Math.round(a.frame(from - n + k, c) * (1 - w) + a.frame(to - n + k, c) * w);
					expect(b.frame(at - n + k, c)).toBe(want);
				}
			}
		}
		// The file ends before the track does, so it fades out rather than stop dead.
		expect(Math.abs(b.frame(30999))).toBeLessThan(32768 / n);
		expect(blendWeight(0, n)).toBeGreaterThan(0);
		expect(blendWeight(n - 1, n)).toBeLessThan(1);
	});

	it("fades a section in and out as set in the editor, and leaves the middle byte for byte", () => {
		const fmt: Fmt = { sampleRate: 44100, bits: 16, channels: 2 };
		const src = path.join(dir, "fades.wav");
		const out = path.join(dir, "fades-out.wav");
		const frames = 20000;
		writePcm(src, fmt, frames, noise(5));
		const r = spliceWav(src, out, [{ src: 0, start: 0, frames, at: 0, fadeIn: 1000, fadeOut: 2000 }], null);
		expect(r.frames).toBe(frames);
		const a = pcmOf(src);
		const b = pcmOf(out);
		expect(bytes(b, 1000, frames - 2000).equals(bytes(a, 1000, frames - 2000))).toBe(true);
		for (const k of [0, 10, 500, 999, frames - 2000, frames - 1000, frames - 1]) {
			const want = Math.round(a.frame(k) * fadeGain(k + 0.5, frames, 1000, 2000));
			expect(b.frame(k)).toBe(want);
		}
		// The fade-in rises along its curve: a quarter of the way up at half way through.
		expect(fadeGain(500, frames, 1000, 2000)).toBeCloseTo(0.25, 6);
	});

	it("puts the fades of the editor's sections into the layers, and keeps faded sections apart", () => {
		const bpm = 120; // half a second a beat
		const rate = 1000;
		const sections = [
			{ startBeat: 0, lengthBeat: 4, atBeat: 0, fadeInBeat: 1 },
			{ startBeat: 4, lengthBeat: 4, atBeat: 4, fadeOutBeat: 2 },
		];
		// One unbroken stretch of the track still makes one layer, with both fades.
		expect(editLayers(sections, bpm, rate, [10000])).toEqual([{ src: 0, start: 0, frames: 4000, at: 0, fadeIn: 500, fadeOut: 1000 }]);
		// A fade where they meet keeps them as two.
		const apart = editLayers([{ ...sections[0], fadeOutBeat: 1 }, sections[1]], bpm, rate, [10000]);
		expect(apart).toEqual([
			{ src: 0, start: 0, frames: 2000, at: 0, fadeIn: 500, fadeOut: 500 },
			{ src: 0, start: 2000, frames: 2000, at: 2000, fadeOut: 1000 },
		]);
	});

	it("takes the bass out of a section whose bass is cut, and leaves the rest as it was", () => {
		const fmt: Fmt = { sampleRate: 44100, bits: 24, channels: 2 };
		const src = path.join(dir, "bass.wav");
		const out = path.join(dir, "bass-out.wav");
		const frames = 44100 * 2;
		const low = 50;
		const high = 2000;
		writePcm(src, fmt, frames, (i) => 0.4 * Math.sin((2 * Math.PI * low * i) / fmt.sampleRate) + 0.4 * Math.sin((2 * Math.PI * high * i) / fmt.sampleRate));
		// The second of two sections, still in order, has its bass cut: they stay two layers.
		const bpm = 120;
		const half = frames / 2;
		const layers = editLayers(
			[
				{ startBeat: 0, lengthBeat: 2, atBeat: 0 },
				{ startBeat: 2, lengthBeat: 2, atBeat: 2, lowCut: true },
			],
			bpm,
			fmt.sampleRate,
			[frames],
		);
		expect(layers).toEqual([
			{ src: 0, start: 0, frames: half, at: 0 },
			{ src: 0, start: half, frames: half, at: half, lowCut: true },
		]);
		spliceWav(src, out, layers, null);
		const a = pcmOf(src);
		const b = pcmOf(out);
		const n = Math.round(JOIN_SEC * fmt.sampleRate);
		// The full-bass section is the source's own bytes up to the join.
		expect(bytes(b, 0, half - n).equals(bytes(a, 0, half - n))).toBe(true);
		// How much of a tone is in a stretch of the result (left channel), against the source.
		const level = (p: typeof a, hz: number, from: number, to: number): number => {
			let re = 0;
			let im = 0;
			for (let i = from; i < to; i++) {
				const ph = (2 * Math.PI * hz * i) / fmt.sampleRate;
				re += p.frame(i) * Math.cos(ph);
				im += p.frame(i) * Math.sin(ph);
			}
			return Math.hypot(re, im);
		};
		// Past the filter's settling and before the bass slides back at the end.
		const from = half + 4410;
		const to = frames - 4410;
		expect(level(b, low, from, to) / level(a, low, from, to)).toBeLessThan(0.02);
		expect(level(b, high, from, to) / level(a, high, from, to)).toBeGreaterThan(0.95);
	});
});

describe("where the cuts land", () => {
	it("keeps every section on the beat however many there are", () => {
		const bpm = 174;
		const sr = 44100;
		const lead = 0.37;
		const frameAt = (beat: number): number => Math.round(((beat * 60) / bpm) * sr);
		// 200 one-beat sections played in reverse order.
		const sections = Array.from({ length: 200 }, (_, i) => ({ startBeat: lead + 199 - i, lengthBeat: 1, atBeat: lead + i }));
		const layers = editLayers(sections, bpm, sr, [frameAt(lead + 400)]);
		expect(layers.length).toBe(200);
		layers.forEach((l, i) => {
			// Each one starts on the frame nearest its beat line in the result, and ends where the next starts.
			expect(l.at).toBe(frameAt(lead + i));
			expect(l.start).toBe(frameAt(lead + 199 - i));
			expect(l.at + l.frames).toBe(frameAt(lead + i + 1));
		});
	});
});

// Sources that have to be decoded first, made here with the system encoder from one known
// recording: 24 bits at 48 kHz, so a wrong bit depth or a rate conversion would show.
describe("other source formats", () => {
	const fmt: Fmt = { sampleRate: 48000, bits: 24, channels: 2 };
	const frames = 48000 * 6;
	const bpm = 120; // 24000 frames to the beat
	let master = "";
	beforeAll(() => {
		master = path.join(dir, "master.wav");
		const hiss = noise(31);
		writePcm(master, fmt, frames, (i, c) => 0.5 * Math.sin((2 * Math.PI * (c ? 330 : 220) * i) / 48000) + 0.2 * hiss(i, c));
	});

	const lossless: [string, string[]][] = [
		["aiff", ["-f", "AIFF", "-d", "BEI24"]],
		["flac", ["-f", "flac", "-d", "flac"]],
		["m4a", ["-f", "m4af", "-d", "alac"]],
	];
	for (const [ext, args] of lossless) {
		it(`exports a ${ext} source at its own rate and depth, bit for bit`, async () => {
			const src = path.join(dir, `lossless.${ext}`);
			const out = path.join(dir, `lossless-${ext}-out.wav`);
			execFileSync("/usr/bin/afconvert", [...args, master, src]);
			// Uncut: the whole recording comes back exactly.
			const whole = await exportEdit({ sourcePath: src, outPath: out, tmpDir: dir, bpm, downbeatSec: 0, sections: [{ startBeat: 0, lengthBeat: 12, atBeat: 0 }] });
			expect(whole).toMatchObject({ sampleRate: 48000, bits: 24, channels: 2, frames });
			const a = pcmOf(master);
			expect(pcmOf(out).data.equals(a.data)).toBe(true);
			// Rearranged: each half is the recording's own samples.
			await exportEdit({ sourcePath: src, outPath: out, tmpDir: dir, bpm, downbeatSec: 0, sections: [{ startBeat: 6, lengthBeat: 6, atBeat: 0 }, { startBeat: 0, lengthBeat: 6, atBeat: 6 }] });
			const b = pcmOf(out);
			const n = Math.round(JOIN_SEC * 48000);
			const edge = Math.round(EDGE_SEC * 48000);
			expect(b.frames).toBe(frames);
			expect(bytes(b, edge, 144000 - n).equals(bytes(a, 144000 + edge, 288000 - n))).toBe(true);
			expect(bytes(b, 144000, 288000 - n).equals(bytes(a, 0, 144000 - n))).toBe(true);
		});
	}

	it("exports an AAC source as 24 bits at its own rate, on the clock the app places beats on", async () => {
		const src = path.join(dir, "lossy.m4a");
		const out = path.join(dir, "lossy-out.wav");
		execFileSync("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", "-b", "256000", master, src]);
		const r = await exportEdit({ sourcePath: src, outPath: out, tmpDir: dir, bpm, sections: [{ startBeat: 0, lengthBeat: 12, atBeat: 0 }] });
		expect(r).toMatchObject({ sampleRate: 48000, bits: 24, channels: 2 });
		// The app's own decode (44.1 kHz) is the same length in time, so beats found on it
		// point at the same audio in the export.
		const app = path.join(dir, "lossy-app.wav");
		await afconvertToWav(src, app);
		const f = new WavReader(app);
		const appSec = f.frames / 44100;
		f.close();
		console.log("AAC: export", r.seconds.toFixed(5), "s, app decode", appSec.toFixed(5), "s, master", (frames / 48000).toFixed(5), "s");
		expect(Math.abs(r.seconds - appSec)).toBeLessThan(0.001);
		// And it is the recording, in time: the tone crosses zero where the master's does.
		const a = pcmOf(master);
		const b = pcmOf(out);
		let err = 0;
		let count = 0;
		for (let i = 48000; i < 48000 * 4; i++) {
			err += Math.abs(a.frame(i, 0) - b.frame(i, 0));
			count++;
		}
		console.log("AAC: mean difference from the master", ((100 * err) / count / 8388608).toFixed(3), "% of full scale");
		expect(err / count / 8388608).toBeLessThan(0.08); // out of step it would be several times that
	});
});

// Kept the same as dev-data/layermix-lab/fixture.ts, which the real-audio lab uses: a music-like
// synthetic track. Four-on-the-floor kick (pitch sweeping down to `kickHz`, with a click on top),
// an off-beat bass line, hats and a little pad; it peaks near full scale. `seed` changes the
// hats and the notes, so two seeds make two different tracks.
function music(rate: number, opts: { bpm?: number; kickHz?: number; seed?: number; level?: number } = {}): (frame: number, ch: number) => number {
	const bpm = opts.bpm ?? 128;
	const kickHz = opts.kickHz ?? 55;
	const level = opts.level ?? 1;
	const seed = opts.seed ?? 1;
	const beat = (60 / bpm) * rate;
	const notes = [kickHz, kickHz * 1.189, kickHz * 1.335, kickHz * 0.891].map((f, i) => f * (1 + 0.06 * ((seed + i) % 3)));
	const hash = (n: number): number => {
		let h = Math.imul(n ^ Math.imul(seed, 0x9e3779b1), 0x85ebca6b);
		h ^= h >>> 13;
		h = Math.imul(h, 0xc2b2ae35);
		h ^= h >>> 16;
		return (h >>> 0) / 4294967296 - 0.5;
	};
	return (i, c) => {
		const b = Math.floor(i / beat);
		const t = (i - b * beat) / rate;
		// Kick: a sweep from 150 Hz down, decaying; a short click on its start.
		const ph = 2 * Math.PI * (kickHz * t + ((150 - kickHz) * 0.012) * (1 - Math.exp(-t / 0.012)));
		let v = 0.62 * Math.sin(ph) * Math.exp(-t / 0.22) * Math.min(1, t / 0.0005);
		if (t < 0.002) v += 0.22 * hash(i) * (1 - t / 0.002);
		// Bass on the off-beat.
		const tb = t - 0.5 * (beat / rate);
		if (tb > 0) v += 0.26 * Math.sin(2 * Math.PI * notes[b % 4] * tb) * Math.exp(-tb / 0.18) * Math.min(1, tb / 0.004);
		// Hats on the eighths, a touch to one side.
		const th = (i % (beat / 2)) / rate;
		v += 0.09 * hash(i * 2 + c) * Math.exp(-th / 0.03) * (c === 0 ? 1 : 0.8);
		// A pad.
		v += 0.05 * Math.sin((2 * Math.PI * (220 + 30 * seed) * i) / rate + c);
		return Math.max(-1, Math.min(1, v * level));
	};
}

// --- Layers over each other ------------------------------------------------------------------

// Samples of a file as floats of full scale, frame by frame.
const floats = (p: ReturnType<typeof pcmOf>, from: number, to: number): Float64Array => {
	const ch = p.fmt.channels;
	const full = 2 ** (p.fmt.bits - 1);
	const out = new Float64Array((to - from) * ch);
	for (let i = from; i < to; i++) for (let c = 0; c < ch; c++) out[(i - from) * ch + c] = p.frame(i, c) / full;
	return out;
};
// True peak in dB of full scale, 4x oversampled with a Blackman-windowed sinc of 24 taps a side
// (on purpose not the limiter's own filter).
function truePeakDb(x: Float64Array, ch: number): number {
	const T = 24;
	const phases = [1, 2, 3].map((j) =>
		Array.from({ length: 2 * T }, (_, k) => {
			const t = j / 4 - (k - T + 1);
			const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / (T + 1)) + 0.08 * Math.cos((2 * Math.PI * t) / (T + 1));
			return (Math.sin(Math.PI * t) / (Math.PI * t)) * w;
		}),
	);
	const frames = x.length / ch;
	let m = 0;
	for (let c = 0; c < ch; c++)
		for (let i = 0; i < frames; i++) {
			m = Math.max(m, Math.abs(x[i * ch + c]));
			if (i < T || i + T >= frames) continue;
			for (const co of phases) {
				let s = 0;
				for (let k = 0; k < 2 * T; k++) s += co[k] * x[(i - T + 1 + k) * ch + c];
				m = Math.max(m, Math.abs(s));
			}
		}
	return 20 * Math.log10(m);
}
// K-weighted loudness (BS.1770, ungated) of float frames, in LUFS.
function lufs(x: Float64Array, ch: number, rate: number): number {
	const k = Float64Array.from(x);
	new KWeight(rate, ch).run(k, k.length / ch);
	let e = 0;
	for (const v of k) e += v * v;
	return -0.691 + 10 * Math.log10(e / (k.length / ch));
}
// The largest step from one frame to the next around `at` (+-span frames), over the channels.
function jump(p: ReturnType<typeof pcmOf>, at: number, span = 0): number {
	let m = 0;
	for (let i = Math.max(1, at - span); i <= Math.min(p.frames - 1, at + span); i++) for (let c = 0; c < p.fmt.channels; c++) m = Math.max(m, Math.abs(p.frame(i, c) - p.frame(i - 1, c)));
	return m;
}
// The longest run of samples at (or a step off) full scale.
function fullScaleRun(p: ReturnType<typeof pcmOf>, from: number, to: number): number {
	const top = 2 ** (p.fmt.bits - 1) - 2;
	let best = 0;
	for (let c = 0; c < p.fmt.channels; c++) {
		let run = 0;
		for (let i = from; i < to; i++) {
			run = Math.abs(p.frame(i, c)) >= top ? run + 1 : 0;
			best = Math.max(best, run);
		}
	}
	return best;
}

describe("where layers play over each other", () => {
	// The ceiling a stretch is held under follows its layers' own highest true peak, kept
	// between -1 and +3 dBTP: worked out here from the layers' source frames over the stretch.
	const expectedCeiling = (parts: { p: ReturnType<typeof pcmOf>; from: number; to: number }[]): number =>
		Math.min(3, Math.max(-1, ...parts.map(({ p, from, to }) => truePeakDb(floats(p, from, to), p.fmt.channels))));
	const core: Fmt[] = [
		{ sampleRate: 44100, bits: 16, channels: 2 },
		{ sampleRate: 48000, bits: 24, channels: 2 },
		{ sampleRate: 44100, bits: 24, channels: 1 },
		{ sampleRate: 48000, bits: 16, channels: 1 },
	];
	const tagOf = (f: Fmt): string => `${f.bits} bit, ${f.sampleRate} Hz, ${f.channels} ch`;

	it("leaves an edit with nothing over anything exactly as it was, lowCut, joins, silence and all", () => {
		// The same edit and source as dev-data/layermix-lab/baseline-hash.ts, whose hash is of the
		// file the code before layers were mixed wrote.
		const fmt: Fmt = { sampleRate: 44100, bits: 16, channels: 2 };
		const src = path.join(dir, "plain-src.wav");
		const out = path.join(dir, "plain-out.wav");
		writePcm(src, fmt, 44100 * 4, music(44100, { seed: 2 }));
		const layers: Layer[] = [
			{ src: 0, start: 44100 * 2, frames: 30000, at: 0 },
			{ src: 0, start: 1000, frames: 40000, at: 30000, lowCut: true },
			{ src: 0, start: 90000, frames: 50000, at: 70000 },
			{ src: 0, start: 0, frames: 20000, at: 125000 },
		];
		const r = spliceWav(src, out, layers, { bpm: 128, downbeatSec: 0.25 });
		expect(r.mix).toBeUndefined();
		expect(createHash("sha256").update(fs.readFileSync(out)).digest("hex")).toBe("81de434053811ecd31c2034183650cf9a3aacfc59ff4da26d5c087bdbee05d86");
	});

	it("finds the stretches where layers overlap, and not plain joins", () => {
		const part = (at: number, frames: number, pre = 220, tail = 220) => ({ at, end: at + frames, from: at - pre, pre, head: 0, tail });
		// One after the other: the lead-in over the outgoing tail is a join, not layering.
		expect(mixZones([part(220, 10000), part(10220, 10000)], 20220)).toEqual([]);
		// Over each other: from the incoming layer's lead-in to where the overlap ends.
		expect(mixZones([part(220, 10000), part(5000, 10000)], 15000)).toEqual([{ from: 4780, to: 10220 }]);
		// A third coming in where the second has the lane to itself is another stretch.
		expect(mixZones([part(220, 10000), part(5000, 10000), part(12000, 2000)], 15000)).toEqual([
			{ from: 4780, to: 10220 },
			{ from: 11780, to: 14000 },
		]);
	});

	for (const fmt of core) {
		const rate = fmt.sampleRate;
		const n = Math.round(JOIN_SEC * rate);

		it(`mixes two loud tracks to the louder one's level, under their own peak level, with the rest untouched (${tagOf(fmt)})`, () => {
			const a = path.join(dir, `two-a-${tagOf(fmt)}.wav`);
			const b = path.join(dir, `two-b-${tagOf(fmt)}.wav`);
			const out = path.join(dir, `two-out-${tagOf(fmt)}.wav`);
			writePcm(a, fmt, rate * 8, music(rate, { seed: 1 }));
			writePcm(b, fmt, rate * 6, music(rate, { seed: 5, bpm: 126, kickHz: 50 }));
			const at = Math.round(rate * 2.5);
			const len = rate * 3;
			const layers: Layer[] = [
				{ src: 0, start: 0, frames: rate * 8, at: 0 },
				{ src: 1, start: rate, frames: len, at },
			];
			const r = spliceWav([a, b], out, layers, null);
			const z0 = at - n;
			const z1 = at + len;
			expect(r.mix?.map((m) => [m.from, m.to])).toEqual([[z0, z1]]);
			const pa = pcmOf(a);
			const pb = pcmOf(b);
			const po = pcmOf(out);
			// Outside the stretch: the first track's own bytes.
			expect(bytes(po, 0, z0).equals(bytes(pa, 0, z0))).toBe(true);
			expect(bytes(po, z1, po.frames).equals(bytes(pa, z1, pa.frames))).toBe(true);
			// Inside, away from its edges: as loud as the louder track over the same span...
			const body = [at + n, z1 - n];
			const ch = fmt.channels;
			const mixed = lufs(floats(po, body[0], body[1]), ch, rate);
			const loudest = Math.max(lufs(floats(pa, body[0], body[1]), ch, rate), lufs(floats(pb, body[0] - at + rate, body[1] - at + rate), ch, rate));
			const m = r.mix![0];
			console.log(`two tracks (${tagOf(fmt)}): mix ${mixed.toFixed(2)} LUFS, louder track ${loudest.toFixed(2)}, leveler ${m.levelMinDb.toFixed(2)} dB, ceiling ${m.ceilingDb.toFixed(2)} dBTP, clipper max ${m.clipper?.maxDb.toFixed(2)} dB, limiter max ${m.limiter.maxDb.toFixed(2)} dB`);
			expect(Math.abs(mixed - loudest)).toBeLessThan(1);
			expect(m.levelMinDb).toBeGreaterThan(-4.5);
			expect(m.levelMinDb).toBeLessThan(-1.5);
			// ...under the ceiling (the tracks' own peak level here) between samples too, and never
			// stuck at full scale.
			expect(Math.abs(m.ceilingDb - expectedCeiling([{ p: pa, from: z0, to: z1 }, { p: pb, from: z0 - at + rate, to: z1 - at + rate }]))).toBeLessThan(0.15);
			expect(truePeakDb(floats(po, body[0], body[1]), ch)).toBeLessThan(m.ceilingDb + 0.1);
			expect(fullScaleRun(po, z0, z1)).toBeLessThan(2);
			// No click where the stretch meets the tracks' own audio.
			for (const edge of [z0, z1]) expect(jump(po, edge)).toBeLessThanOrEqual(Math.max(jump(pa, edge, 64), jump(pb, edge - at + rate, 64)) * 1.05 + 2);
		});

		it(`brings a track layered over its own double back to the track itself (${tagOf(fmt)})`, () => {
			const a = path.join(dir, `double-${tagOf(fmt)}.wav`);
			const out = path.join(dir, `double-out-${tagOf(fmt)}.wav`);
			// Mastered with room to spare, so neither the clipper nor the limiter has anything to do.
			writePcm(a, fmt, rate * 6, music(rate, { seed: 3, level: 0.8 }));
			const pa = pcmOf(a);
			expect(truePeakDb(floats(pa, 0, pa.frames), fmt.channels)).toBeLessThan(-1.2);
			const r = spliceWav(a, out, [
				{ src: 0, start: 0, frames: rate * 6, at: 0 },
				{ src: 0, start: rate * 2, frames: rate * 2, at: rate * 2 },
			], null);
			expect(r.mix).toHaveLength(1);
			expect(r.mix![0].levelMinDb).toBeCloseTo(-6.02, 2);
			expect(r.mix![0].ceilingDb).toBe(-1);
			expect(r.mix![0].limiter.active).toBe(0);
			expect(r.mix![0].clipper?.touched).toBe(0);
			const po = pcmOf(out);
			// Every frame within a step of the track (the step is dither, at 16 bits).
			let worst = 0;
			for (let i = 0; i < po.frames; i++) for (let c = 0; c < fmt.channels; c++) worst = Math.max(worst, Math.abs(po.frame(i, c) - pa.frame(i, c)));
			expect(worst).toBeLessThanOrEqual(fmt.bits === 16 ? 1 : 0);
			// So the loudness is flat across the edit: each second as loud as the track's.
			for (let s = 0; s < 6; s++) expect(Math.abs(lufs(floats(po, s * rate, (s + 1) * rate), fmt.channels, rate) - lufs(floats(pa, s * rate, (s + 1) * rate), fmt.channels, rate))).toBeLessThan(0.01);
		});
	}

	for (const fmt of [core[0], core[1], core[3]]) {
		const rate = fmt.sampleRate;
		const n = Math.round(JOIN_SEC * rate);
		it(`exports a build-up, a doubled part with a bass-cut layer on top, and an outro (${tagOf(fmt)})`, () => {
			const a = path.join(dir, `three-a-${tagOf(fmt)}.wav`);
			const b = path.join(dir, `three-b-${tagOf(fmt)}.wav`);
			const out = path.join(dir, `three-out-${tagOf(fmt)}.wav`);
			writePcm(a, fmt, rate * 12, music(rate, { seed: 1 }));
			writePcm(b, fmt, rate * 12, music(rate, { seed: 7, kickHz: 58 }));
			const layers: Layer[] = [
				{ src: 0, start: 0, frames: rate * 10, at: 0 },
				{ src: 1, start: rate * 2, frames: rate * 6, at: rate * 4, lowCut: true },
				{ src: 1, start: rate * 8, frames: rate * 4, at: rate * 10 },
			];
			const r = spliceWav([a, b], out, layers, null);
			const z0 = rate * 4 - n;
			const z1 = rate * 10;
			expect(r.mix?.map((m) => [m.from, m.to])).toEqual([[z0, z1]]);
			const pa = pcmOf(a);
			const pb = pcmOf(b);
			const po = pcmOf(out);
			expect(po.frames).toBe(rate * 14);
			// The build-up and the outro are the tracks' own bytes.
			expect(bytes(po, 0, z0).equals(bytes(pa, 0, z0))).toBe(true);
			expect(bytes(po, z1, rate * 14).equals(bytes(pb, rate * 8, rate * 12))).toBe(true);
			// A layer without its bass over a full one hardly needs turning down, and the doubled
			// part is as loud as the full track.
			console.log(`three parts (${tagOf(fmt)}): leveler ${r.mix![0].levelMinDb.toFixed(2)}..${r.mix![0].levelMaxDb.toFixed(2)} dB, ceiling ${r.mix![0].ceilingDb.toFixed(2)} dBTP, limiter max ${r.mix![0].limiter.maxDb.toFixed(2)} dB`);
			expect(r.mix![0].levelMinDb).toBeGreaterThan(-2);
			const body = [rate * 4 + n, z1 - n];
			const ch = fmt.channels;
			expect(Math.abs(lufs(floats(po, body[0], body[1]), ch, rate) - lufs(floats(pa, body[0], body[1]), ch, rate))).toBeLessThan(1);
			expect(r.mix![0].ceilingDb).toBeGreaterThanOrEqual(-1);
			expect(r.mix![0].ceilingDb).toBeLessThanOrEqual(0);
			expect(truePeakDb(floats(po, body[0], body[1]), ch)).toBeLessThan(r.mix![0].ceilingDb + 0.1);
			expect(fullScaleRun(po, z0, z1)).toBeLessThan(2);
			expect(jump(po, z0)).toBeLessThanOrEqual(jump(pa, z0, 64) * 1.05 + 2);
			expect(jump(po, z1)).toBeLessThanOrEqual(Math.max(jump(pa, z1, 64), jump(pb, rate * 8, 64)) * 1.05 + 2);
		});
	}

	// A tone at a quarter of the sample rate, its samples at full scale: half way between them it
	// peaks 3.01 dB higher, over the +3 dBTP cap.
	const overCap = (frame: number): number => Math.sin((Math.PI * frame) / 2 + Math.PI / 4) * Math.SQRT2;
	for (const [kind, what, levelA, levelB] of [
		["quiet", "quiet masters keep 1 dB of room", 0.7, 0.7],
		["under", "a ceiling between -1 and 0 dBTP is the masters' own peak", 1.3, 1.3],
		["over", "masters that peak over full scale between samples may do so in the mix as far as they do", 1.8, 1.8],
		["cap", "no further than +3 dBTP", 0, 1.8],
	] as const) {
		it(`holds the mix at its layers' own peak level: ${what}`, () => {
			const fmt: Fmt = { sampleRate: 44100, bits: 24, channels: 2 };
			const rate = fmt.sampleRate;
			const n = Math.round(JOIN_SEC * rate);
			const a = path.join(dir, `peak-a-${kind}.wav`);
			const b = path.join(dir, `peak-b-${kind}.wav`);
			const out = path.join(dir, `peak-out-${kind}.wav`);
			writePcm(a, fmt, rate * 6, kind === "cap" ? overCap : music(rate, { seed: 2, level: levelA }));
			writePcm(b, fmt, rate * 6, music(rate, { seed: 6, kickHz: 52, level: levelB }));
			const at = rate * 2;
			// The mix as it is written, before it is rounded, in the stretch's body (frames
			// counted from where the stretch starts, a lead-in before the layer).
			let top = 0;
			let bottom = 0;
			let seen = 0;
			const probe = {
				pre: () => {},
				post: (y: Float64Array, k: number) => {
					for (let f = 0; f < k; f++, seen++) if (seen >= 2 * n && seen < rate * 3 - n) for (let c = 0; c < 2; c++) {
							top = Math.max(top, y[f * 2 + c]);
							bottom = Math.min(bottom, y[f * 2 + c]);
						}
				},
			};
			const r = spliceWav([a, b], out, [
				{ src: 0, start: 0, frames: rate * 6, at: 0 },
				{ src: 1, start: rate, frames: rate * 3, at },
			], null, { probe });
			const pa = pcmOf(a);
			const pb = pcmOf(b);
			const po = pcmOf(out);
			const [z0, z1] = [at - n, at + rate * 3];
			const want = expectedCeiling([{ p: pa, from: z0, to: z1 }, { p: pb, from: z0 - at + rate, to: z1 - at + rate }]);
			const m = r.mix![0];
			console.log(`peak level (${kind}): layers ${want.toFixed(2)} dBTP, ceiling ${m.ceilingDb.toFixed(2)}, mix ${truePeakDb(floats(po, at + n, z1 - n), 2).toFixed(2)}`);
			if (kind === "quiet") expect(m.ceilingDb).toBe(-1);
			if (kind === "under") expect(want).toBeGreaterThan(-1);
			if (kind === "under") expect(want).toBeLessThan(0);
			if (kind === "over") expect(want).toBeGreaterThan(0);
			if (kind === "over") expect(want).toBeLessThan(3);
			if (kind === "cap") expect(m.ceilingDb).toBe(3);
			expect(Math.abs(m.ceilingDb - want)).toBeLessThan(0.15);
			const body = floats(po, at + n, z1 - n);
			expect(truePeakDb(body, 2)).toBeLessThan(m.ceilingDb + 0.1);
			// Whatever the ceiling between samples, the samples never go past full scale, so the
			// last-resort clamp is never needed.
			// (Whole steps reach one further below zero than above it.)
			expect(top).toBeLessThan(2 ** 23 - 1 + 0.5);
			expect(bottom).toBeGreaterThan(-(2 ** 23) - 0.5);
			if (kind === "cap") return;
			// And loud masters come out as loud as the louder of them.
			const loudest = Math.max(lufs(floats(pa, at + n, z1 - n), 2, rate), lufs(floats(pb, rate + n, z1 - n - at + rate), 2, rate));
			expect(Math.abs(lufs(body, 2, rate) - loudest)).toBeLessThan(1);
		});
	}

	it("fades out a layer that stops dead at the end of its file while another plays on", () => {
		const fmt: Fmt = { sampleRate: 44100, bits: 16, channels: 2 };
		const rate = fmt.sampleRate;
		const a = path.join(dir, "dead-a.wav");
		const b = path.join(dir, "dead-b.wav");
		const out = path.join(dir, "dead-out.wav");
		// A loud steady tone in the first file, so stopping dead would be a step.
		writePcm(a, fmt, rate * 3, (i) => 0.5 * Math.sin((2 * Math.PI * 300 * i) / rate + 0.3));
		writePcm(b, fmt, rate * 6, music(rate, { seed: 4, level: 0.6 }));
		const end = rate * 3;
		const r = spliceWav([a, b], out, [
			{ src: 0, start: 0, frames: rate * 3, at: 0 },
			{ src: 1, start: 0, frames: rate * 5, at: rate },
		], null);
		expect(r.mix?.map((m) => [m.from, m.to])).toEqual([[rate - Math.round(JOIN_SEC * rate), end]]);
		const po = pcmOf(out);
		const pb = pcmOf(b);
		// Where it ends the step is no bigger than the other track's own (the tone moves
		// 0.5 * 2pi * 300 / 44100 of full scale a frame, about 700 at 16 bits).
		expect(jump(po, end)).toBeLessThanOrEqual(jump(pb, end - rate, 64) * 1.05 + 2);
		// By its last frame it has all but gone: what is left is the other track (the tone alone
		// would be thousands of steps off it).
		for (let c = 0; c < 2; c++) expect(Math.abs(po.frame(end - 1, c) - pb.frame(end - 1 - rate, c))).toBeLessThan(200);
	});

	it("leaves silence over silence as digital silence (16 bit: no dither on whole steps)", () => {
		const fmt: Fmt = { sampleRate: 44100, bits: 16, channels: 2 };
		const a = path.join(dir, "black-a.wav");
		const b = path.join(dir, "black-b.wav");
		const out = path.join(dir, "black-out.wav");
		writePcm(a, fmt, 44100 * 6, () => 0);
		writePcm(b, fmt, 44100 * 6, () => 0);
		const r = spliceWav([a, b], out, [
			{ src: 0, start: 0, frames: 44100 * 6, at: 0 },
			{ src: 1, start: 0, frames: 44100 * 5, at: 44100 },
		], null);
		expect(r.mix).toHaveLength(1);
		expect(pcmOf(out).data.every((x) => x === 0)).toBe(true);
	});

	for (const fmt of [
		{ sampleRate: 44100, bits: 16, channels: 2 },
		{ sampleRate: 48000, bits: 24, channels: 2 },
	] as Fmt[]) {
		it(`passes a loud layer over a silent one through exactly as its source (${tagOf(fmt)})`, () => {
			const rate = fmt.sampleRate;
			const a = path.join(dir, `over-silence-a-${fmt.bits}.wav`);
			const b = path.join(dir, `over-silence-b-${fmt.bits}.wav`);
			const out = path.join(dir, `over-silence-out-${fmt.bits}.wav`);
			// Loud enough to peak over full scale between samples.
			writePcm(a, fmt, rate * 6, music(rate, { seed: 2, level: 1.8 }));
			writePcm(b, fmt, rate * 6, () => 0);
			const r = spliceWav([a, b], out, [
				{ src: 0, start: 0, frames: rate * 6, at: 0 },
				{ src: 1, start: 0, frames: rate * 3, at: rate * 2 },
			], null);
			const m = r.mix![0];
			expect(m.ceilingDb).toBeGreaterThan(0);
			expect(m.limiter.active).toBe(0);
			expect(m.clipper?.touched).toBe(0);
			expect(pcmOf(out).data.equals(pcmOf(a).data)).toBe(true);
		});
	}

	it("brings a hot master over its own double back to the master, within a step (24 bit)", () => {
		const fmt: Fmt = { sampleRate: 48000, bits: 24, channels: 2 };
		const rate = fmt.sampleRate;
		const a = path.join(dir, "hot-double.wav");
		const out = path.join(dir, "hot-double-out.wav");
		writePcm(a, fmt, rate * 6, music(rate, { seed: 3, level: 1.8 }));
		const r = spliceWav(a, out, [
			{ src: 0, start: 0, frames: rate * 6, at: 0 },
			{ src: 0, start: rate * 2, frames: rate * 2, at: rate * 2 },
		], null);
		expect(r.mix![0].ceilingDb).toBeGreaterThan(0);
		const pa = pcmOf(a);
		const po = pcmOf(out);
		let worst = 0;
		for (let i = 0; i < po.frames; i++) for (let c = 0; c < 2; c++) worst = Math.max(worst, Math.abs(po.frame(i, c) - pa.frame(i, c)));
		expect(worst).toBeLessThanOrEqual(1);
	});

	it("writes the same bytes every time (16 bit, dithered)", () => {
		const fmt: Fmt = { sampleRate: 44100, bits: 16, channels: 2 };
		const a = path.join(dir, "again-a.wav");
		const b = path.join(dir, "again-b.wav");
		writePcm(a, fmt, 44100 * 4, music(44100, { seed: 1 }));
		writePcm(b, fmt, 44100 * 4, music(44100, { seed: 4 }));
		const layers: Layer[] = [
			{ src: 0, start: 0, frames: 44100 * 4, at: 0 },
			{ src: 1, start: 0, frames: 44100 * 2, at: 44100, lowCut: true },
		];
		const outs = [1, 2].map((k) => {
			const out = path.join(dir, `again-${k}.wav`);
			spliceWav([a, b], out, layers, { bpm: 128 });
			return fs.readFileSync(out);
		});
		expect(outs[0].equals(outs[1])).toBe(true);
	});
});

describe("the limiter", () => {
	const rate = 48000;
	const ceiling = 10 ** (-1 / 20);
	const limit = (x: Float64Array, ch: number, opts: { fadeIn?: number; fadeOut?: number } = {}): { y: Float64Array; lim: TruePeakLimiter } => {
		const frames = x.length / ch;
		const lim = new TruePeakLimiter(rate, ch, ceiling, { frames, ...opts });
		const y = new Float64Array(x.length);
		let o = 0;
		const emit = (b: Float64Array, k: number): void => {
			y.set(b.subarray(0, k * ch), o * ch);
			o += k;
		};
		for (let i = 0; i < frames; i += 777) lim.push(x.subarray(i * ch, Math.min(frames, i + 777) * ch), Math.min(777, frames - i), emit);
		lim.finish(emit);
		expect(o).toBe(frames);
		return { y, lim };
	};
	const sine = (hz: number, db: number, sec: number, ch = 1): Float64Array => Float64Array.from({ length: Math.round(rate * sec) * ch }, (_, k) => ceiling * 10 ** (db / 20) * Math.sin((2 * Math.PI * hz * Math.floor(k / ch)) / rate));
	const thd = (y: Float64Array, hz: number, from: number, to: number): number => {
		const amp = (f: number): number => {
			let re = 0;
			let im = 0;
			for (let i = from; i < to; i++) {
				re += y[i] * Math.cos((2 * Math.PI * f * i) / rate);
				im += y[i] * Math.sin((2 * Math.PI * f * i) / rate);
			}
			return Math.hypot(re, im);
		};
		let h = 0;
		for (let k = 2; k <= 8; k++) h += amp(hz * k) ** 2;
		return Math.sqrt(h) / amp(hz);
	};

	for (const hz of [40, 50, 60, 1000, 11025]) {
		it(`holds a ${hz} Hz sine driven 6 dB over at the ceiling, between samples too`, () => {
			const { y } = limit(sine(hz, 6, 1.5, 2), 2);
			expect(truePeakDb(y.subarray(rate, 2 * rate), 2)).toBeLessThan(-1 + 0.02);
			// And it does not just duck: once settled, it is at the ceiling (aimed 0.15 dB under).
			expect(truePeakDb(y.subarray(rate, 2 * rate), 2)).toBeGreaterThan(-1.3);
		});
	}

	it("barely distorts low bass pushed into it", () => {
		for (const hz of [40, 50, 60])
			for (const db of [3, 6]) {
				const { y } = limit(sine(hz, db, 2), 1);
				// Whole cycles from 0.5 s on.
				const cycle = rate / hz;
				const d = thd(y, hz, rate / 2, rate / 2 + Math.floor((rate * 1.4) / cycle) * cycle);
				expect(d).toBeLessThan(0.001);
			}
	});

	it("leaves audio under the ceiling exactly as it was, with no delay", () => {
		const x = Float64Array.from({ length: 2 * 30000 }, (_, k) => 0.8 * Math.sin(k * 0.37) * Math.cos(k * 0.0011));
		const { y, lim } = limit(x, 2);
		expect(y.every((v, k) => v === x[k])).toBe(true);
		expect(lim.stats.active).toBe(0);
		// A peak far over comes out where it went in.
		const imp = new Float64Array(2 * 30000);
		imp[2 * 12345] = 4;
		imp[2 * 12345 + 1] = -4;
		const out = limit(imp, 2).y;
		let at = 0;
		for (let i = 0; i < 30000; i++) if (Math.abs(out[2 * i]) > Math.abs(out[2 * at])) at = i;
		expect(at).toBe(12345);
		expect(Math.abs(out[2 * at])).toBeLessThan(ceiling);
		// Linked: both channels get the same gain.
		expect(out[2 * at + 1]).toBe(-out[2 * at]);
	});

	it("eases its gain back to 1 at the edges of its stretch", () => {
		const x = sine(1000, 6, 0.2);
		const { y } = limit(x, 1, { fadeIn: 240, fadeOut: 240 });
		const gainAt = (i: number): number => y[i] / x[i];
		expect(gainAt(1)).toBeGreaterThan(0.999);
		expect(gainAt(x.length - 2)).toBeGreaterThan(0.999);
		// In between, at the ceiling (aimed 0.15 dB under it).
		expect(Math.abs(gainAt(x.length / 2 + 3) - 10 ** (-6.15 / 20))).toBeLessThan(0.01);
	});
});

describe("the soft clipper", () => {
	const rate = 44100;
	const clipOf = (x: Float64Array, ch: number, clipDb = CLIP_DB, threshold = 1): Float64Array => {
		const c = new SoftClipper(ch, threshold, { frames: x.length / ch, clipDb });
		const y = new Float64Array(x.length);
		let o = 0;
		const emit = (b: Float64Array, k: number): void => {
			y.set(b.subarray(0, k * ch), o * ch);
			o += k;
		};
		for (let i = 0; i < x.length / ch; i += 1000) c.push(x.subarray(i * ch, Math.min(x.length / ch, i + 1000) * ch), Math.min(1000, x.length / ch - i), emit);
		c.finish(emit);
		expect(o).toBe(x.length / ch);
		return y;
	};
	const sine = (hz: number, amp: number, sec: number): Float64Array => Float64Array.from({ length: Math.round(rate * sec) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

	it("leaves audio under its threshold exactly as it was", () => {
		const x = Float64Array.from({ length: 2 * 40000 }, (_, k) => 0.9 * Math.sin(k * 0.21) * Math.cos(k * 0.0007));
		const y = clipOf(x, 2);
		expect(y.every((v, k) => v === x[k])).toBe(true);
	});

	it("takes no more than its depth off, and never makes a peak higher", () => {
		for (const db of [1, 3, 6, 12]) {
			const x = sine(100, 10 ** (db / 20), 1);
			const y = clipOf(x, 1);
			const peak = (v: Float64Array): number => v.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
			expect(peak(y)).toBeLessThanOrEqual(peak(x));
			// Its depth, with a little for the filter's ripple around the rounded tops.
			expect(20 * Math.log10(peak(x) / peak(y))).toBeLessThan(CLIP_DB + 0.3);
		}
	});

	it("rounds peaks off without folding what that makes back under the file's Nyquist", () => {
		// A 9 kHz tone 6 dB over: what it makes above 22 kHz would come back at odd frequencies.
		const hz = 9000;
		const y = clipOf(sine(hz, 2, 2), 1);
		const N = 32768;
		let fund = 0;
		let other = 0;
		for (let k = 1; k < N / 2; k += 1) {
			const f = (k * rate) / N;
			let re = 0;
			let im = 0;
			// A Hann-windowed DFT bin, only on a grid of 1 in 8 bins to keep it quick.
			if (k % 8 !== 0 && Math.abs(f - hz) > 30) continue;
			for (let i = 0; i < N; i++) {
				const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
				re += y[4410 + i] * w * Math.cos((2 * Math.PI * k * i) / N);
				im -= y[4410 + i] * w * Math.sin((2 * Math.PI * k * i) / N);
			}
			const e = re * re + im * im;
			const harmonic = [1, 2].some((h) => Math.abs(f - h * hz) < 30);
			if (Math.abs(f - hz) < 30) fund += e;
			else if (!harmonic) other += e;
		}
		expect(10 * Math.log10(other / fund)).toBeLessThan(-40);
	});

	it("keeps every peak where it was, with no delay", () => {
		const x = new Float64Array(20000);
		for (let i = -40; i <= 40; i++) x[10000 + i] = 2.5 * (0.5 + 0.5 * Math.cos((Math.PI * i) / 41)) * Math.cos(i * 0.3);
		const y = clipOf(x, 1);
		let at = 0;
		for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[at])) at = i;
		expect(at).toBe(10000);
		expect(Math.abs(y[at])).toBeLessThan(2.5);
	});
});

describe("the leveler", () => {
	it("works out the gain from the layers' powers", () => {
		// The same track twice, in step: -6.02 dB, the track again.
		expect(levelGain([1, 1, 1, 1], 2, [1, 1])).toBeCloseTo(0.5, 12);
		// Two unrelated tracks, as loud as each other: -3 dB.
		expect(levelGain([1, 0, 0, 1], 2, [1, 1])).toBeCloseTo(Math.SQRT1_2, 12);
		// A quiet layer over a loud one: hardly anything.
		expect(20 * Math.log10(levelGain([1, 0, 0, 0.1], 2, [1, 1]))).toBeCloseTo(-0.41, 2);
		// Fading in over its own double, the mix stays the track: 1 / (1 + w).
		expect(levelGain([1, 1, 1, 1], 2, [1, 0.3])).toBeCloseTo(1 / 1.3, 12);
		// A plain crossfade between unrelated tracks is left alone.
		expect(levelGain([1, 0, 0, 1], 2, [0.5, 0.5])).toBe(1);
		// One layer on its own, or out of phase layers: never turned up.
		expect(levelGain([1, 0, 0, 1], 2, [1, 0])).toBe(1);
		expect(levelGain([1, -1, -1, 1], 2, [1, 0.5])).toBe(1);
		// Never down by more than 12 dB.
		expect(levelGain(new Array(64).fill(1), 8, new Array(8).fill(1))).toBe(LEVEL_FLOOR);
	});

	it("measures loudness as BS.1770 does, and levels two copies of a signal to one", () => {
		// A 997 Hz sine at full scale in one channel of two reads -3.01 LUFS.
		const rate = 48000;
		const x = Float64Array.from({ length: rate * 2 * 2 }, (_, k) => (k % 2 ? 0 : Math.sin((2 * Math.PI * 997 * Math.floor(k / 2)) / rate)));
		const k = Float64Array.from(x);
		new KWeight(rate, 2).run(k, rate * 2);
		let e = 0;
		for (let i = rate * 2; i < k.length; i++) e += k[i] * k[i];
		expect(-0.691 + 10 * Math.log10(e / rate)).toBeCloseTo(-3.01, 1);
		const meter = new LevelMeter([{ from: 0, to: rate * 2 }, { from: 0, to: rate * 2 }], rate * 2);
		meter.add([k, k], 2, 0, rate * 2);
		const leveler = meter.leveler(rate);
		for (const f of [0, 1000, rate, rate * 2 - 1]) expect(leveler.gain(f, [1, 1])).toBeCloseTo(0.5, 12);
	});

	it("finds a peak between the very last frames it is given", () => {
		// A tone at a quarter of the sample rate, its samples at 0.7071, for the last 8 frames
		// only: between them it reaches 1.
		const x = new Float64Array(2 * 400);
		for (let i = 392; i < 400; i++) x[2 * i] = x[2 * i + 1] = Math.sin((Math.PI * i) / 2 + Math.PI / 4);
		const m = new TruePeakMeter(2);
		m.push(x, 400);
		m.finish();
		expect(m.peak).toBeGreaterThan(0.95);
	});

	it("dithers reproducibly, +-1 step, triangular", () => {
		const a = new Tpdf(42);
		const b = new Tpdf(42);
		let sum = 0;
		let sq = 0;
		for (let i = 0; i < 100000; i++) {
			const v = a.next();
			expect(v).toBe(b.next());
			expect(Math.abs(v)).toBeLessThan(1);
			sum += v;
			sq += v * v;
		}
		expect(Math.abs(sum / 100000)).toBeLessThan(0.01);
		expect(sq / 100000).toBeCloseTo(1 / 6, 2);
	});
});
