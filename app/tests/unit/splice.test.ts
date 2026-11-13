import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { testDir } from "../testdata";
import { afconvertToWav } from "../../src/main/audio/dsp";
import { blendWeight, EDGE_SEC, exportEdit, JOIN_SEC, readGridTag, spliceWav } from "../../src/main/audio/splice";
import { parseWavHeader, WavReader } from "../../src/main/audio/wav";
import { editSlices, type Slice } from "../../src/shared/trackEdit";
import { writeClickTrack } from "../signals";

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
				{ startBeat: lead, lengthBeat: 2 },
				{ startBeat: lead + 2, lengthBeat: 1 },
				{ startBeat: lead + 3, lengthBeat: total - lead - 3 },
			];
			const slices = editSlices(lead, sections, bpm, fmt.sampleRate, frames);
			expect(slices).toEqual([{ start: 0, frames }]);
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
		const r = spliceWav(src, out, slices, null);
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

	it("leaves no step in the waveform at a join", () => {
		const fmt: Fmt = { sampleRate: 44100, bits: 16, channels: 1 };
		const src = path.join(dir, "sine.wav");
		const out = path.join(dir, "sine-out.wav");
		const period = 441; // 100 Hz
		writePcm(src, fmt, period * 40, (i) => 0.8 * Math.sin((2 * Math.PI * i) / period));
		// The first section ends on a crest and the second starts in a trough: a plain cut
		// would jump by almost the full range.
		const slices: Slice[] = [
			{ start: 0, frames: period * 10 + 110 },
			{ start: period * 20 + 331, frames: period * 10 },
		];
		const a = pcmOf(src);
		expect(Math.abs(a.frame(slices[0].frames - 1) - a.frame(slices[1].start))).toBeGreaterThan(0.75 * 2 * 32767 * 0.8);
		spliceWav(src, out, slices, null);
		const b = pcmOf(out);
		let sourceStep = 0;
		for (let i = 1; i < a.frames; i++) sourceStep = Math.max(sourceStep, Math.abs(a.frame(i) - a.frame(i - 1)));
		let step = 0;
		for (let i = 1; i < slices[0].frames + 2000; i++) step = Math.max(step, Math.abs(b.frame(i) - b.frame(i - 1)));
		console.log("largest step: source", sourceStep, "edit", step);
		expect(step).toBeLessThan(sourceStep * 4);
		// And the incoming section starts on its own first sample.
		expect(b.frame(slices[0].frames)).toBe(a.frame(slices[1].start));
	});

	it("fades in when the file starts part-way into the track", () => {
		const fmt: Fmt = { sampleRate: 44100, bits: 16, channels: 1 };
		const src = path.join(dir, "dc.wav");
		const out = path.join(dir, "dc-out.wav");
		writePcm(src, fmt, 20000, () => 0.5);
		spliceWav(src, out, [{ start: 1000, frames: 19000 }], null);
		const b = pcmOf(out);
		expect(b.frames).toBe(19000);
		expect(b.frame(0)).toBeLessThan(400);
		expect(b.frame(500)).toBe(Math.round(0.5 * 32767));
		// It runs to the end of the source, so the end is left alone.
		expect(b.frame(18999)).toBe(Math.round(0.5 * 32767));
	});

	it("carries the parent's beat grid, and still reads as an ordinary WAV", () => {
		const fmt: Fmt = { sampleRate: 48000, bits: 24, channels: 1 };
		const src = path.join(dir, "tag.wav");
		const out = path.join(dir, "tag-out.wav");
		// An odd number of bytes of audio: the chunk after it has to start on an even byte.
		writePcm(src, fmt, 1001, noise(5));
		spliceWav(src, out, [{ start: 0, frames: 1001 }], { bpm: 174.01, downbeatSec: 0.2135 });
		expect(readGridTag(out)).toEqual({ bpm: 174.01, downbeatSec: 0.2135 });
		expect(readGridTag(src)).toBeNull();
		const r = new WavReader(out);
		expect(r.frames).toBe(1001);
		expect(r.info.sampleRate).toBe(48000);
		r.close();
		expect(fs.statSync(out).size % 2).toBe(0);
		// A track without a grid passes on its tempo only.
		spliceWav(src, out, [{ start: 0, frames: 1001 }], { bpm: 140 });
		expect(readGridTag(out)).toEqual({ bpm: 140 });
	});

	it("writes silence between sections, fading out into it and in from what led up to the next", () => {
		const fmt: Fmt = { sampleRate: 48000, bits: 24, channels: 2 };
		const src = path.join(dir, "gap.wav");
		const out = path.join(dir, "gap-out.wav");
		writePcm(src, fmt, 60000, noise(21));
		const slices: Slice[] = [
			{ start: 0, frames: 10000 },
			{ start: 0, frames: 7000, silent: true },
			{ start: 30000, frames: 20000 },
		];
		const r = spliceWav(src, out, slices, null);
		expect(r.frames).toBe(37000);
		const a = pcmOf(src);
		const b = pcmOf(out);
		const n = Math.round(JOIN_SEC * fmt.sampleRate);
		// The section before is the source up to its fade out...
		expect(bytes(b, 0, 10000 - n).equals(bytes(a, 0, 10000 - n))).toBe(true);
		for (let k = 0; k < n; k++) {
			for (let c = 0; c < 2; c++) expect(b.frame(10000 - n + k, c)).toBe(Math.round(a.frame(10000 - n + k, c) * (1 - blendWeight(k, n))));
		}
		// ...then true digital silence...
		expect(bytes(b, 10000, 17000 - n).every((x) => x === 0)).toBe(true);
		// ...then what led up to the next section in the source fades in, so that section's
		// first beat is its own, sample for sample, and the rest is a plain copy (up to the fade
		// at the end, as the file stops before the track does).
		for (let k = 0; k < n; k++) {
			for (let c = 0; c < 2; c++) expect(b.frame(17000 - n + k, c)).toBe(Math.round(a.frame(30000 - n + k, c) * blendWeight(k, n)));
		}
		expect(bytes(b, 17000, 37000 - n).equals(bytes(a, 30000, 50000 - n))).toBe(true);
	});

	it("starts with silence when the first section is moved later in a track without a lead-in", () => {
		const fmt: Fmt = { sampleRate: 44100, bits: 16, channels: 1 };
		const src = path.join(dir, "gap-first.wav");
		const out = path.join(dir, "gap-first-out.wav");
		writePcm(src, fmt, 20000, noise(4));
		spliceWav(src, out, [{ start: 0, frames: 5000, silent: true }, { start: 0, frames: 20000 }], null);
		const a = pcmOf(src);
		const b = pcmOf(out);
		expect(b.frames).toBe(25000);
		expect(bytes(b, 0, 5000).every((x) => x === 0)).toBe(true);
		expect(bytes(b, 5000, 25000).equals(a.data)).toBe(true);
	});

	it("refuses sections outside the track", () => {
		const src = path.join(dir, "short.wav");
		writePcm(src, { sampleRate: 44100, bits: 16, channels: 2 }, 1000, noise(9));
		expect(() => spliceWav(src, path.join(dir, "short-out.wav"), [{ start: 500, frames: 501 }], null)).toThrow();
	});
});

describe("where the cuts land", () => {
	it("keeps every section on the beat however many there are", () => {
		const bpm = 174;
		const sr = 44100;
		const lead = 0.37;
		const frameAt = (beat: number): number => Math.round(((beat * 60) / bpm) * sr);
		// 200 one-beat sections played in reverse order.
		const sections = Array.from({ length: 200 }, (_, i) => ({ startBeat: lead + 199 - i, lengthBeat: 1 }));
		const slices = editSlices(lead, sections, bpm, sr, frameAt(lead + 400));
		expect(slices.length).toBe(201);
		let at = 0;
		slices.forEach((s, i) => {
			// Each one starts on the frame nearest its beat line in the result.
			expect(at).toBe(i === 0 ? 0 : frameAt(lead + i - 1));
			if (i > 0) expect(s.start).toBe(frameAt(lead + 200 - i));
			at += s.frames;
		});
		expect(at).toBe(frameAt(lead + 200));
	});

	it("drops the part beat at the end of the track when that section is moved forward", () => {
		const bpm = 120;
		const sr = 48000;
		const frames = sr * 10 + 4800; // 20.2 beats
		const sections = [
			{ startBeat: 16, lengthBeat: 4.2 },
			{ startBeat: 0, lengthBeat: 16 },
		];
		expect(editSlices(0, sections, bpm, sr, frames)).toEqual([
			{ start: sr * 8, frames: sr * 2 },
			{ start: 0, frames: sr * 8 },
		]);
	});
});

describe("exporting through the decoder", () => {
	it("writes a rearranged file from a WAV source without touching its format", async () => {
		const fmt: Fmt = { sampleRate: 48000, bits: 24, channels: 2 };
		const src = path.join(dir, "export-src.wav");
		const out = path.join(dir, "export-out.wav");
		const bpm = 120; // 24000 frames per beat
		writePcm(src, fmt, 48000 * 8, noise(21));
		const r = await exportEdit({ sourcePath: src, outPath: out, tmpDir: dir, bpm, downbeatSec: 0, leadBeat: 0, sections: [{ startBeat: 8, lengthBeat: 8 }, { startBeat: 0, lengthBeat: 8 }] });
		expect(r.bits).toBe(24);
		expect(r.sampleRate).toBe(48000);
		expect(r.seconds).toBeCloseTo(8, 6);
		const a = pcmOf(src);
		const b = pcmOf(out);
		const n = Math.round(JOIN_SEC * 48000);
		// The file starts part-way into the track, so its first moment fades in.
		const edge = Math.round(EDGE_SEC * 48000);
		expect(bytes(b, edge, 192000 - n).equals(bytes(a, 192000 + edge, 384000 - n))).toBe(true);
		expect(bytes(b, 192000, 384000 - n).equals(bytes(a, 0, 192000 - n))).toBe(true);
		expect(readGridTag(out)).toEqual({ bpm, downbeatSec: 0 });
		expect(fs.existsSync(`${out}.part`)).toBe(false);
	});

	it("decodes a source that is not integer PCM once, at its own sample rate", async () => {
		const src = path.join(dir, "float.wav");
		const out = path.join(dir, "float-out.wav");
		writeClickTrack(src, 120, 8, { kind: "float32" });
		const r = await exportEdit({ sourcePath: src, outPath: out, tmpDir: dir, bpm: 120, leadBeat: 0, sections: [{ startBeat: 0, lengthBeat: 16 }] });
		expect(r).toMatchObject({ bits: 24, sampleRate: 44100, channels: 2, frames: 44100 * 8 });
		// Uncut, so every sample is the source's, to within the 24 bits it is stored in.
		const want = new WavReader(src);
		const got = new WavReader(out);
		const x = new Float32Array(want.frames * 2);
		const y = new Float32Array(got.frames * 2);
		want.read(0, want.frames, x);
		got.read(0, got.frames, y);
		want.close();
		got.close();
		let worst = 0;
		for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
		expect(worst).toBeLessThan(2 / 8388608);
	});
});

// Real tracks from <repo>/store, when there are any: every export is checked sample by
// sample against the source, and each join is measured.
const STORE = path.resolve(__dirname, "../../../store");
const realTracks = fs.existsSync(STORE)
	? fs
			.readdirSync(STORE)
			.filter((f) => /\.(mp3|wav)$/i.test(f))
			.sort()
	: [];

describe.skipIf(realTracks.length === 0)("real music", () => {
	for (const name of realTracks) {
		it(
			`${name}: rearranged, every sample is the source's`,
			async () => {
				const src = path.join(STORE, name);
				const lossy = /\.mp3$/i.test(name);
				const tag = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 24);
				// What the samples should be: the WAV itself, or one plain decode of the MP3.
				let ref = src;
				if (lossy) {
					ref = path.join(dir, `${tag}-ref.wav`);
					execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI24", src, ref]);
				}
				const a = pcmOf(ref);
				const bpm = 140;
				const lead = 0.31;
				const total = (a.frames / a.fmt.sampleRate) * (bpm / 60);
				// Sixteen-beat sections, then the rest of the track.
				const chunks = Math.floor((total - lead) / 16);
				expect(chunks).toBeGreaterThan(8);
				const chunk = (i: number): { startBeat: number; lengthBeat: number } => ({ startBeat: lead + i * 16, lengthBeat: 16 });
				const rest = { startBeat: lead + chunks * 16, lengthBeat: total - lead - chunks * 16 };
				// Out of order, with a repeat, two that still follow each other, and the end of the track in the middle.
				const sections = [chunk(2), chunk(0), chunk(0), chunk(1), chunk(5), rest, chunk(3), chunk(4), chunk(7)];
				const out = path.join(dir, `${tag}-edit.wav`);
				const t0 = Date.now();
				const r = await exportEdit({ sourcePath: src, outPath: out, tmpDir: dir, bpm, downbeatSec: (lead * 60) / bpm, leadBeat: lead, sections });
				const tookMs = Date.now() - t0;
				const b = pcmOf(out);
				// Same format as the source (24 bits for a decoded MP3), no rate conversion.
				expect(b.fmt).toEqual({ sampleRate: a.fmt.sampleRate, channels: a.fmt.channels, bits: lossy ? 24 : a.fmt.bits });
				expect(r.sampleRate).toBe(a.fmt.sampleRate);

				const slices = editSlices(lead, sections, bpm, a.fmt.sampleRate, a.frames);
				expect(b.frames).toBe(slices.reduce((sum, s) => sum + s.frames, 0));
				const n = Math.round(JOIN_SEC * a.fmt.sampleRate);
				const edge = Math.round(EDGE_SEC * a.fmt.sampleRate);
				const step = (p: typeof a, from: number, to: number): number => {
					let m = 0;
					for (let i = Math.max(1, from); i < Math.min(p.frames, to); i++) for (let c = 0; c < p.fmt.channels; c++) m = Math.max(m, Math.abs(p.frame(i, c) - p.frame(i - 1, c)));
					return m;
				};
				let at = 0;
				let exact = 0;
				let worstRatio = 0;
				let worstPlainCut = 0;
				slices.forEach((s, i) => {
					const next = slices[i + 1];
					const end = s.start + s.frames;
					const joined = next ? next.start !== end : end < a.frames;
					const tail = joined ? Math.min(n, s.frames) : 0;
					const head = i === 0 && s.start > 0 ? edge : 0;
					// Everything but the moment before a join is the source, bit for bit.
					expect(bytes(b, at + head, at + s.frames - tail).equals(bytes(a, s.start + head, end - tail))).toBe(true);
					exact += s.frames - tail - head;
					if (next) {
						const join = at + s.frames;
						// The incoming section starts on its own first sample.
						for (let c = 0; c < a.fmt.channels; c++) expect(b.frame(join, c)).toBe(a.frame(next.start, c));
						// The largest sample-to-sample move across the join, against the largest in the
						// source's own audio on either side of it.
						const across = step(b, join - n, join + 1);
						const around = Math.max(step(a, end - 4 * n, end), step(a, next.start - n, next.start + 4 * n));
						worstRatio = Math.max(worstRatio, across / Math.max(1, around));
						for (let c = 0; c < a.fmt.channels; c++) worstPlainCut = Math.max(worstPlainCut, Math.abs(a.frame(end - 1, c) - a.frame(next.start, c)));
					}
					at += s.frames;
				});
				const full = 2 ** (a.fmt.bits - 1);
				console.log(`${name}: ${slices.length - 1} joins, ${((100 * exact) / b.frames).toFixed(3)}% of frames bit-identical, largest step at a join ${worstRatio.toFixed(2)}x the music's own (a plain cut would have jumped ${((100 * worstPlainCut) / full).toFixed(0)}% of full scale), ${tookMs} ms`);
				expect(worstRatio).toBeLessThan(1.5);
				expect(readGridTag(out)).toEqual({ bpm, downbeatSec: (lead * 60) / bpm });

				if (lossy) {
					// The decode the export is cut from lines up with the one the app places beats on,
					// sample for sample, so the inherited grid points at the same audio.
					const app = path.join(dir, `${tag}-app.wav`);
					await afconvertToWav(src, app);
					const f = new WavReader(app);
					expect(f.frames).toBe(a.frames);
					const x = new Float32Array(f.frames * 2);
					f.read(0, f.frames, x);
					f.close();
					let worst = 0;
					let over = 0;
					let peak = 0;
					for (let i = 0; i < a.frames; i++) {
						for (let c = 0; c < 2; c++) {
							const v = x[i * 2 + c];
							peak = Math.max(peak, Math.abs(v));
							if (Math.abs(v) >= 1) over++;
							else worst = Math.max(worst, Math.abs(v - a.frame(i, c) / 8388608));
						}
					}
					console.log(`${name}: decode peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS, ${over} samples at or over full scale, worst difference from the 24-bit decode ${(worst * 8388608).toFixed(2)} LSB`);
					expect(worst).toBeLessThan(1.01 / 8388608);
				}
			},
			300000,
		);
	}
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
			const whole = await exportEdit({ sourcePath: src, outPath: out, tmpDir: dir, bpm, downbeatSec: 0, leadBeat: 0, sections: [{ startBeat: 0, lengthBeat: 12 }] });
			expect(whole).toMatchObject({ sampleRate: 48000, bits: 24, channels: 2, frames });
			const a = pcmOf(master);
			expect(pcmOf(out).data.equals(a.data)).toBe(true);
			// Rearranged: each half is the recording's own samples.
			await exportEdit({ sourcePath: src, outPath: out, tmpDir: dir, bpm, downbeatSec: 0, leadBeat: 0, sections: [{ startBeat: 6, lengthBeat: 6 }, { startBeat: 0, lengthBeat: 6 }] });
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
		const r = await exportEdit({ sourcePath: src, outPath: out, tmpDir: dir, bpm, leadBeat: 0, sections: [{ startBeat: 0, lengthBeat: 12 }] });
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
