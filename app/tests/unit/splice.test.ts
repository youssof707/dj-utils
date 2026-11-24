import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { testDir } from "../testdata";
import { afconvertToWav } from "../../src/main/audio/dsp";
import { blendWeight, EDGE_SEC, exportEdit, JOIN_SEC, spliceWav } from "../../src/main/audio/splice";
import { parseWavHeader, WavReader } from "../../src/main/audio/wav";
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
