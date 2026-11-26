// Exporting an edited track: the source file's own samples, rearranged. Nothing here
// resamples or stretches. Whole stretches of the file are copied byte for byte; only the few
// milliseconds leading up to a join are computed, the sections whose bass was cut in the
// editor, which go through the set's low cut, and the stretches where layers play over each
// other, which are mixed to the level of the loudest of them and kept under a true-peak
// ceiling (see layerMix.ts). An edit with no layers over each other changes no level and is
// not dithered.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fadeGain } from "../../shared/fades";
import { editLayers, srcOf, type Layer, type Span } from "../../shared/trackEdit";
import { LowCut, stretchFile } from "./dsp";
import { CEILING_MAX_DB, CEILING_MIN_DB, CLIP_DB, KWeight, LevelMeter, SoftClipper, Tpdf, TruePeakLimiter, TruePeakMeter, type ClipperStats, type LimiterStats } from "./layerMix";
import { parseWavHeader, type WavInfo } from "./wav";

// At a join the audio blends, over this long and ending exactly on the join, from the end of
// the outgoing section into what led up to the incoming one in the source. The beat that
// sits on the join is therefore the incoming section's own, untouched, and there is no step
// in the waveform to click. The two weights always add up to one, so the blend can never be
// louder than its inputs, and they follow a raised cosine, which eases in and out with no
// corner at either end.
export const JOIN_SEC = 0.005;
// A file that starts part-way into the track fades in over this long.
export const EDGE_SEC = 0.002;

// The beat grid an exported edit carries with it, in a chunk of its own after the audio
// (players skip chunks they do not know). `downbeatSec` is left out for a track without a grid.
export type GridTag = { bpm: number; downbeatSec?: number };
const GRID_CHUNK = "djgr";

// How much of the incoming audio frame `k` of an `n`-frame blend takes: just above 0 on the
// first frame, just below 1 on the last.
export function blendWeight(k: number, n: number): number {
	return 0.5 - 0.5 * Math.cos((Math.PI * (k + 1)) / (n + 1));
}

// For an edit with layers over each other, what was done where they meet: per stretch
// (frames of the result), the range of the leveler's gain and what the limiter did.
// `sourcePeakDb`: the highest true peak of the layers as they go into the mix; `ceilingDb`: the
// ceiling the mix was held under, which follows it.
export type MixStats = { from: number; to: number; levelMinDb: number; levelMaxDb: number; sourcePeakDb: number; ceilingDb: number; limiter: LimiterStats; clipper: ClipperStats | null };
export type SpliceResult = { frames: number; sampleRate: number; bits: number; channels: number; mix?: MixStats[] };
// For measuring the mix (the app passes none): `clipDb`, the soft clipper's depth (0 for none),
// and `probe`, handed the mix before and after the clipper and limiter, frame for frame.
export type MixOptions = {
	clipDb?: number;
	probe?: { pre: (y: Float64Array, frames: number) => void; post: (y: Float64Array, frames: number) => void };
};

// The stretches of the result where layers play over each other: where two or more layers'
// own frames ([at, end)) are under way at once, widened by the fades that run into them (the
// lead-in of a layer coming in, the fade of one going out). Everywhere else the result is
// made exactly as it would be with no layers over each other. Empty if none overlap.
type Part = { at: number; end: number; from: number; pre: number; head: number; tail: number };
export function mixZones(parts: Part[], total: number): { from: number; to: number }[] {
	const edges = parts.flatMap((p) => [[p.at, 1] as const, [p.end, -1] as const]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let zones: { from: number; to: number }[] = [];
	let on = 0;
	let start = 0;
	for (const [at, d] of edges) {
		if (d > 0 && ++on === 2) start = at;
		if (d < 0 && on-- === 2 && at > start) zones.push({ from: start, to: at });
	}
	if (zones.length === 0) return zones;
	const fades = parts.flatMap((p) => [
		{ from: p.from, to: p.at, leadIn: true },
		{ from: p.at, to: p.at + p.head, leadIn: false },
		{ from: p.end - p.tail, to: p.end, leadIn: false },
	]).filter((f) => f.to > f.from);
	for (let changed = true; changed; ) {
		changed = false;
		for (const z of zones)
			for (const f of fades) {
				// A lead-in counts when it ends where the stretch starts, as it leads into it.
				if (!(f.from < z.to && (f.to > z.from || (f.leadIn && f.to === z.from)))) continue;
				if (f.from < z.from || f.to > z.to) {
					z.from = Math.min(z.from, f.from);
					z.to = Math.max(z.to, f.to);
					changed = true;
				}
			}
		zones.sort((a, b) => a.from - b.from);
		const merged: typeof zones = [];
		for (const z of zones) {
			const last = merged[merged.length - 1];
			if (last && z.from <= last.to) {
				last.to = Math.max(last.to, z.to);
				changed = true;
			} else merged.push({ ...z });
		}
		zones = merged;
	}
	return zones.map((z) => ({ from: Math.max(0, z.from), to: Math.min(total, z.to) }));
}

function readFully(fd: number, buf: Buffer, length: number, position: number): void {
	let got = 0;
	while (got < length) {
		const n = fs.readSync(fd, buf, got, length - got, position + got);
		if (n <= 0) throw new Error("The audio file ended early");
		got += n;
	}
}

function writeFully(fd: number, buf: Buffer, length: number, position: number): void {
	let off = 0;
	while (off < length) off += fs.writeSync(fd, buf, off, length - off, position + off);
}

function pcmHeader(info: { channels: number; sampleRate: number; bits: number }, dataBytes: number, fileBytes: number): Buffer {
	const h = Buffer.alloc(44);
	const blockAlign = (info.bits / 8) * info.channels;
	h.write("RIFF", 0, "latin1");
	h.writeUInt32LE(fileBytes - 8, 4);
	h.write("WAVE", 8, "latin1");
	h.write("fmt ", 12, "latin1");
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(info.channels, 22);
	h.writeUInt32LE(info.sampleRate, 24);
	h.writeUInt32LE(info.sampleRate * blockAlign, 28);
	h.writeUInt16LE(blockAlign, 32);
	h.writeUInt16LE(info.bits, 34);
	h.write("data", 36, "latin1");
	h.writeUInt32LE(dataBytes, 40);
	return h;
}

function isPcm(info: WavInfo): boolean {
	return info.format === 1 && (info.bits === 16 || info.bits === 24 || info.bits === 32) && info.channels >= 1;
}

// Writes the `layers` of the integer PCM WAVs at `srcPath` (a layer's `src` says which file)
// into one file at `outPath`, in the same sample rate, bit depth and channel count, which all
// the files must share. Where only one layer plays, its bytes are copied as they are; where
// layers overlap they are mixed (see mixZones and mixZone).
// Each layer fades in over the moment before it, from what led up to it in its file, and out
// over its last moment unless it runs to the end of its file, so a join has no click and its
// first beat is the incoming layer's own. A `lowCut` layer is filtered as the set's "Mute
// bass" is, from the first frame of its lead-in to its end, where the bass slides back.
export function spliceWav(srcPath: string | string[], outPath: string, layers: Layer[], tag: GridTag | null, opts: MixOptions = {}): SpliceResult {
	const fds: number[] = [];
	let out: number | null = null;
	try {
		for (const p of Array.isArray(srcPath) ? srcPath : [srcPath]) fds.push(fs.openSync(p, "r"));
		const infos = fds.map((fd) => parseWavHeader(fd));
		const info = infos[0];
		if (!isPcm(info)) throw new Error(`Unsupported WAV encoding (format ${info.format}, ${info.bits} bit)`);
		if (infos.some((i) => i.format !== info.format || i.bits !== info.bits || i.channels !== info.channels || i.sampleRate !== info.sampleRate)) throw new Error("The tracks are not in the same audio format");
		const bps = info.bits / 8;
		const ch = info.channels;
		const frameBytes = bps * ch;
		for (const l of layers) {
			const src = infos[l.src];
			if (!src || !Number.isInteger(l.frames) || l.frames <= 0 || !Number.isInteger(l.start) || l.start < 0 || l.start + l.frames > src.frames || !Number.isInteger(l.at) || l.at < 0) throw new Error("A section lies outside the track");
		}
		if (layers.length === 0) throw new Error("There is nothing to export");
		const joinFrames = Math.max(1, Math.round(JOIN_SEC * info.sampleRate));
		const edgeFrames = Math.max(1, Math.round(EDGE_SEC * info.sampleRate));
		// Each layer with its fades: `pre` frames before it, `head` (a file that starts part-way
		// into a track, with no room before it) and `tail` at its own start and end.
		// `full`: the frames where it plays at its own level, with no fade of any kind.
		const parts = layers.map((l) => {
			const pre = Math.min(joinFrames, l.at);
			const head = pre === 0 && l.start > 0 ? Math.min(edgeFrames, l.frames) : 0;
			const tail = l.start + l.frames < infos[l.src].frames ? Math.min(joinFrames, l.frames) : 0;
			const from = l.at - pre;
			const end = l.at + l.frames;
			const fadeIn = l.fadeIn ?? 0;
			const fadeOut = l.fadeOut ?? 0;
			const full = { from: l.at + Math.max(head, fadeIn), to: end - Math.max(tail, fadeOut) };
			return { ...l, pre, head, tail, from, end, fadeIn, fadeOut, full, cut: l.lowCut ? new LowCut(end - from, info.sampleRate, ch) : null };
		});
		const total = Math.max(...parts.map((p) => p.end));
		const cuts = [...new Set(parts.flatMap((p) => [p.from, p.at, p.at + p.head, p.end - p.tail, p.end, p.full.from, p.full.to]).concat([0, total]))].filter((b) => b >= 0 && b <= total).sort((x, y) => x - y);

		out = fs.openSync(outPath, "w");
		let pos = 44;
		const chunkFrames = Math.max(1, Math.floor((1 << 20) / frameBytes));
		const copy = Buffer.alloc(chunkFrames * frameBytes);
		const acc = new Float64Array(chunkFrames * ch);
		const lows = new Float64Array(chunkFrames * ch);
		const max = 2 ** (info.bits - 1) - 1;
		const min = -(2 ** (info.bits - 1));
		const write = (buf: Buffer, frames: number): void => {
			writeFully(out!, buf, frames * frameBytes, pos);
			pos += frames * frameBytes;
		};
		// `n` frames of a layer's file from `frame` into `copy`; silence before the file starts.
		const read = (p: (typeof parts)[number], frame: number, n: number): void => {
			const skip = Math.max(0, -frame);
			if (skip > 0) copy.fill(0, 0, Math.min(n, skip) * frameBytes);
			if (n > skip) readFully(fds[p.src], copy.subarray(skip * frameBytes), (n - skip) * frameBytes, infos[p.src].dataOffset + (frame + skip) * frameBytes);
		};
		// How loud a layer is at frame `o` of the result.
		const weight = (p: (typeof parts)[number], o: number): number => {
			// A layer that fades in from silence has nothing to blend in before it.
			if (o < p.at) return p.fadeIn ? 0 : blendWeight(joinFrames - (p.at - o), joinFrames);
			let w = 1;
			if (o - p.at < p.head) w *= blendWeight(o - p.at, p.head);
			const t = o - (p.end - p.tail);
			if (t >= 0) w *= 1 - blendWeight(t, p.tail);
			// Its volume fades, set in the editor, over the layer's own frames.
			if (p.fadeIn || p.fadeOut) w *= fadeGain(o - p.at + 0.5, p.frames, p.fadeIn, p.fadeOut);
			return w;
		};
		// Where layers play over each other: each such stretch is written in one go when it is
		// reached, and is a cut of its own at both ends. With none, `cuts` is as it always was.
		const zones = mixZones(parts, total);
		if (zones.length) cuts.splice(0, cuts.length, ...[...new Set([...cuts, ...zones.flatMap((z) => [z.from, z.to])])].sort((x, y) => x - y));
		const mix: MixStats[] = [];

		for (let i = 0; i + 1 < cuts.length; i++) {
			const [b0, b1] = [cuts[i], cuts[i + 1]];
			const zone = zones.find((z) => z.from <= b0 && b0 < z.to);
			if (zone) {
				if (b0 === zone.from) mix.push(mixZone({ parts, info, total, joinFrames, chunkFrames, copy, read, weight, write, opts }, zone));
				continue;
			}
			const on = parts.filter((p) => p.from <= b0 && b0 < p.end);
			for (let o = b0; o < b1; ) {
				const n = Math.min(chunkFrames, b1 - o);
				const only = on.length === 1 ? on[0] : null;
				if (on.length === 0) {
					copy.fill(0, 0, n * frameBytes);
					write(copy, n);
				} else if (only && !only.cut && o >= only.full.from && o + n <= only.full.to) {
					// One layer at full level: its file, byte for byte.
					read(only, only.start + (o - only.at), n);
					write(copy, n);
				} else {
					acc.fill(0, 0, n * ch);
					for (const p of on) {
						read(p, p.start + (o - p.at), n);
						if (p.cut) {
							// Frames reach the filter in order: the parts under a stretch of the
							// result are worked through from its start to its end.
							for (let k = 0; k < n * ch; k++) lows[k] = copy.readIntLE(k * bps, bps);
							p.cut.run(lows, o - p.from, n);
							for (let k = 0; k < n; k++) {
								const w = weight(p, o + k);
								for (let c = 0; c < ch; c++) acc[k * ch + c] += lows[k * ch + c] * w;
							}
							continue;
						}
						for (let k = 0; k < n; k++) {
							const w = weight(p, o + k);
							for (let c = 0; c < ch; c++) acc[k * ch + c] += copy.readIntLE((k * ch + c) * bps, bps) * w;
						}
					}
					for (let k = 0; k < n * ch; k++) copy.writeIntLE(Math.min(max, Math.max(min, Math.round(acc[k]))), k * bps, bps);
					write(copy, n);
				}
				o += n;
			}
		}

		const dataBytes = pos - 44;
		if (dataBytes % 2) {
			writeFully(out, Buffer.alloc(1), 1, pos);
			pos += 1;
		}
		if (tag) {
			const text = Buffer.from(JSON.stringify({ v: 1, ...tag }), "utf8");
			const chunk = Buffer.alloc(8 + text.length + (text.length % 2), 0x20);
			chunk.write(GRID_CHUNK, 0, "latin1");
			chunk.writeUInt32LE(text.length, 4);
			text.copy(chunk, 8);
			writeFully(out, chunk, chunk.length, pos);
			pos += chunk.length;
		}
		if (pos > 0xffffffff) throw new Error("The edit is too long for a WAV file");
		writeFully(out, pcmHeader(info, dataBytes, pos), 44, 0);
		const r: SpliceResult = { frames: dataBytes / frameBytes, sampleRate: info.sampleRate, bits: info.bits, channels: info.channels };
		return mix.length ? { ...r, mix } : r;
	} finally {
		for (const fd of fds) fs.closeSync(fd);
		if (out !== null) fs.closeSync(out);
	}
}

type MixPart = Layer & Part & { fadeIn: number; fadeOut: number; full: { from: number; to: number }; cut: LowCut | null };
type ZoneContext = {
	parts: MixPart[];
	info: WavInfo;
	total: number;
	joinFrames: number;
	chunkFrames: number;
	copy: Buffer;
	read: (p: MixPart, frame: number, n: number) => void;
	weight: (p: MixPart, o: number) => number;
	write: (buf: Buffer, frames: number) => void;
	opts: MixOptions;
};

// Integer samples from `buf` as floats into `out` from `at`.
function decode(buf: Buffer, samples: number, bps: number, out: Float64Array, at: number): void {
	if (bps === 2) for (let k = 0; k < samples; k++) out[at + k] = buf.readInt16LE(k * 2);
	else if (bps === 3) for (let k = 0; k < samples; k++) out[at + k] = buf.readIntLE(k * 3, 3);
	else for (let k = 0; k < samples; k++) out[at + k] = buf.readInt32LE(k * 4);
}

// Writes frames [z.from, z.to) of the result, where layers play over each other, in two passes
// over the layers' files. The first measures how loud each layer is and how loud they are
// together (K-weighted, as each goes into the mix: through its low cut, at its fade's weight);
// and their true peaks; the second sums them, turns the sum down to the loudest layer's level
// (Leveler), rounds off the tops of the highest peaks (SoftClipper), takes what is still over the
// ceiling off them (TruePeakLimiter), and dithers a 16-bit result. The ceiling is the layers'
// own highest true peak, between -1 and +3 dBTP: the mix never peaks hotter than the tracks
// around it (and its samples never reach full scale), and quiet ones keep 1 dB of room. The
// leveler, clipper and limiter all leave the audio exactly as it is where the stretch meets the
// audio either side.
function mixZone(ctx: ZoneContext, z: { from: number; to: number }): MixStats {
	const { info, joinFrames, chunkFrames, copy, read, weight, write, opts } = ctx;
	const ch = info.channels;
	const bps = info.bits / 8;
	const frameBytes = bps * ch;
	const len = z.to - z.from;
	const members = ctx.parts.filter((p) => p.from < z.to && p.end > z.from);
	// Each layer's frames in the stretch, counted from its start.
	const spans = members.map((p) => ({ from: Math.max(p.from, z.from) - z.from, to: Math.min(p.end, z.to) - z.from }));
	// How far each layer is in: its fade weight, and for a layer that stops dead at the end of
	// its file while others play on, a fade over its last moment, so it does not click off and
	// the leveler's gain eases back to 1 rather than stepping. (Outside a stretch like this the
	// end of a file is left as it always was.)
	const mixWeight = (i: number, o: number): number => {
		const p = members[i];
		const at = z.from + o;
		if (o < spans[i].from || o >= spans[i].to) return 0;
		let w = weight(p, at);
		if (p.tail === 0 && p.end < ctx.total) {
			const ramp = Math.min(joinFrames, p.frames);
			const t = at - (p.end - ramp);
			if (t >= 0) w *= 1 - blendWeight(t, ramp);
		}
		return w;
	};
	const bufs = members.map(() => new Float64Array(chunkFrames * ch));
	// Frames [a, b) of the chunk at `o` that layer i plays, read into its buffer, through its
	// low cut. Zero elsewhere.
	const load = (i: number, o: number, n: number, cut: LowCut | null): [number, number] => {
		const p = members[i];
		const buf = bufs[i];
		buf.fill(0, 0, n * ch);
		const a = Math.max(o, spans[i].from);
		const b = Math.min(o + n, spans[i].to);
		if (b <= a) return [0, 0];
		read(p, p.start + (z.from + a - p.at), b - a);
		const sub = buf.subarray((a - o) * ch);
		decode(copy, (b - a) * ch, bps, sub, 0);
		if (cut) cut.run(sub, z.from + a - p.from, b - a);
		return [a, b];
	};

	// Pass 1: the powers and peaks. The low cuts are copies, so the real ones carry on from here
	// in pass 2.
	const cuts1 = members.map((p) => p.cut?.clone() ?? null);
	const kw = members.map(() => new KWeight(info.sampleRate, ch));
	// Peaks are only looked for up to the highest the ceiling can be.
	const peakCap = 2 ** (info.bits - 1) * 10 ** (CEILING_MAX_DB / 20);
	const peaks = members.map(() => new TruePeakMeter(ch));
	const meter = new LevelMeter(spans, len);
	const weighted = new Float64Array(chunkFrames * ch);
	for (let o = 0; o < len; o += chunkFrames) {
		const n = Math.min(chunkFrames, len - o);
		members.forEach((_, i) => {
			const [a, b] = load(i, o, n, cuts1[i]);
			if (b <= a) return;
			const buf = bufs[i];
			if (peaks[i].peak < peakCap) {
				for (let f = a; f < b; f++) {
					const g = mixWeight(i, f);
					for (let c = 0, k = (f - a) * ch, x = (f - o) * ch; c < ch; c++, k++, x++) weighted[k] = buf[x] * g;
				}
				peaks[i].push(weighted, b - a);
			}
			kw[i].run(buf.subarray((a - o) * ch), b - a);
		});
		meter.add(bufs, ch, o, n);
	}
	for (const m of peaks) if (m.peak < peakCap) m.finish();
	const leveler = meter.leveler(info.sampleRate);

	// The mix of frames [o, o + n) into `sum`, levelled, with the layers' real low cuts; and in
	// `hot`, the frames where it is louder than the loudest of its layers on its own.
	const sum = new Float64Array(chunkFrames * ch);
	const hot = new Uint8Array(chunkFrames);
	const loudest = new Float64Array(chunkFrames);
	const w = new Float64Array(members.length);
	let lo = 1;
	let hi = 0;
	const mixInto = (o: number, n: number): void => {
		sum.fill(0, 0, n * ch);
		loudest.fill(0, 0, n);
		members.forEach((p, i) => {
			const [a, b] = load(i, o, n, p.cut);
			const buf = bufs[i];
			for (let f = a; f < b; f++) {
				const g = mixWeight(i, f);
				for (let c = 0, k = (f - o) * ch; c < ch; c++, k++) {
					const v = buf[k] * g;
					sum[k] += v;
					const av = v < 0 ? -v : v;
					if (av > loudest[f - o]) loudest[f - o] = av;
				}
			}
		});
		for (let f = 0; f < n; f++) {
			for (let i = 0; i < members.length; i++) w[i] = mixWeight(i, o + f);
			const g = leveler.gain(o + f, w);
			if (g < lo) lo = g;
			if (g > hi) hi = g;
			let top = 0;
			for (let c = 0, k = f * ch; c < ch; c++, k++) {
				if (g !== 1) sum[k] *= g;
				const av = sum[k] < 0 ? -sum[k] : sum[k];
				if (av > top) top = av;
			}
			hot[f] = top > loudest[f] * (1 + 1e-9) ? 1 : 0;
		}
	};

	// Pass 2: the mix, through the clipper and the limiter.
	const full = 2 ** (info.bits - 1);
	const max = full - 1;
	const min = -full;
	const sourcePeakDb = 20 * Math.log10(Math.max(1e-9, ...peaks.map((m) => m.peak)) / full);
	const ceilingDb = Math.min(CEILING_MAX_DB, Math.max(CEILING_MIN_DB, sourcePeakDb));
	const ceiling = full * 10 ** (ceilingDb / 20);
	// Whatever the ceiling between samples, the samples stay whole numbers inside full scale,
	// so nothing reaches the clamp below.
	const sampleCeiling = Math.min(ceiling, max);
	const sampleFloor = Math.min(ceiling, full);
	const edges = { frames: len, fadeIn: z.from > 0 ? joinFrames : 0, fadeOut: z.to < ctx.total ? joinFrames : 0 };
	// The clipper rounds off samples over full scale, and points between samples over the
	// ceiling; with the ceiling the layers' own peak, a mix no hotter than its layers passes
	// both it and the limiter untouched.
	const limiter = new TruePeakLimiter(info.sampleRate, ch, ceiling, { ...edges, sampleCeiling, sampleFloor, measured: ceilingDb === sourcePeakDb });
	const clipDb = opts.clipDb ?? CLIP_DB;
	const clipper = clipDb > 0 ? new SoftClipper(ch, ceiling, { ...edges, clipDb, sampleThreshold: sampleCeiling, sampleFloor }) : null;
	// Dither only where the mix falls between whole steps: digital silence, and a layer that
	// comes through at a gain of 1, stay exactly as they are. Drawn in order of the samples
	// that get it, so it does not depend on how the work was cut into chunks.
	const dither = info.bits === 16 ? new Tpdf((Math.imul(z.from, 0x9e3779b1) ^ 0x2545f491) >>> 0) : null;
	const outBuf = Buffer.alloc(4096 * frameBytes);
	const emit = (y: Float64Array, frames: number): void => {
		opts.probe?.post(y, frames);
		for (let k = 0; k < frames * ch; k++) {
			const x = y[k];
			let v = dither && !Number.isInteger(x) ? Math.round(x + dither.next()) : Math.round(x);
			// Dither never carries a sample past full scale: it stops at the top step.
			if (v > max && x <= max) v = max;
			else if (v < min && x >= min) v = min;
			// A last resort only: the limiter keeps the mix inside full scale.
			outBuf.writeIntLE(v > max ? max : v < min ? min : v, k * bps, bps);
		}
		write(outBuf, frames);
	};
	const toLimiter = (y: Float64Array, frames: number): void => limiter.push(y, frames, emit);
	for (let o = 0; o < len; o += chunkFrames) {
		const n = Math.min(chunkFrames, len - o);
		mixInto(o, n);
		opts.probe?.pre(sum, n);
		if (clipper) clipper.push(sum, n, toLimiter, hot);
		else limiter.push(sum, n, emit);
	}
	if (clipper) clipper.finish(toLimiter);
	limiter.finish(emit);
	return { from: z.from, to: z.to, levelMinDb: 20 * Math.log10(lo), levelMaxDb: 20 * Math.log10(hi), sourcePeakDb, ceilingDb, limiter: limiter.stats, clipper: clipper?.stats ?? null };
}

// The grid an exported edit was given, or null for any other file.
export function readGridTag(file: string): GridTag | null {
	if (!/\.wav$/i.test(file)) return null;
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return null;
	}
	try {
		const size = fs.fstatSync(fd).size;
		const head = Buffer.alloc(12);
		if (fs.readSync(fd, head, 0, 12, 0) < 12 || head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") return null;
		const ch = Buffer.alloc(8);
		let pos = 12;
		while (pos + 8 <= size) {
			fs.readSync(fd, ch, 0, 8, pos);
			const len = ch.readUInt32LE(4);
			if (ch.toString("latin1", 0, 4) === GRID_CHUNK) {
				if (len > 4096 || pos + 8 + len > size) return null;
				const body = Buffer.alloc(len);
				fs.readSync(fd, body, 0, len, pos + 8);
				const v = JSON.parse(body.toString("utf8")) as { bpm?: unknown; downbeatSec?: unknown };
				if (typeof v.bpm !== "number" || !Number.isFinite(v.bpm) || v.bpm <= 0) return null;
				return typeof v.downbeatSec === "number" && Number.isFinite(v.downbeatSec) ? { bpm: v.bpm, downbeatSec: v.downbeatSec } : { bpm: v.bpm };
			}
			pos += 8 + len + (len % 2);
		}
		return null;
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

function run(tool: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(tool, args, { maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
	});
}

// The bit depth to decode a source to: its own when it holds whole-number samples (WAV,
// AIFF, FLAC, Apple Lossless), and 24 bits for everything else (MP3 and AAC decode to more
// detail than 16 bits hold).
async function sourceBits(sourcePath: string): Promise<16 | 24 | 32> {
	try {
		const m = /source bit depth:\s*I(\d+)/.exec(await run("/usr/bin/afinfo", [sourcePath]));
		if (!m) return 24;
		const bits = Number(m[1]);
		return bits <= 16 ? 16 : bits <= 24 ? 24 : 32;
	} catch {
		return 24;
	}
}

// The source as integer PCM at its own sample rate and channel count. A WAV that already is
// that is used as it stands; anything else is decoded once, with no rate conversion.
async function sourcePcm(sourcePath: string, dir: string): Promise<string> {
	if (/\.wav$/i.test(sourcePath)) {
		try {
			const fd = fs.openSync(sourcePath, "r");
			try {
				if (isPcm(parseWavHeader(fd))) return sourcePath;
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			// not a WAV we can read ourselves: let the system decoder try
		}
	}
	const pcm = path.join(dir, "source.wav");
	try {
		await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", `LEI${await sourceBits(sourcePath)}`, sourcePath, pcm]);
	} catch {
		throw new Error("This file could not be read as audio");
	}
	return pcm;
}

function wavInfo(file: string): WavInfo {
	const fd = fs.openSync(file, "r");
	try {
		return parseWavHeader(fd);
	} finally {
		fs.closeSync(fd);
	}
}

// Another track of an edit as integer PCM in the first one's format and at its tempo, so
// the two can be cut together: converted to that sample rate, channel count and bit depth,
// and stretched (pitch kept) when its tempo is another. A file that already is all that is
// used as it stands.
async function matchedPcm(sourcePath: string, dir: string, name: string, like: WavInfo, fromBpm: number, toBpm: number): Promise<string> {
	const out = path.join(dir, `${name}.wav`);
	const convert = async (from: string, to: string, format: string): Promise<void> => {
		try {
			await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", format, "-c", String(like.channels), from, to]);
		} catch {
			throw new Error("This file could not be read as audio");
		}
	};
	if (Math.abs(fromBpm - toBpm) < 1e-9) {
		if (/\.wav$/i.test(sourcePath)) {
			try {
				const info = wavInfo(sourcePath);
				if (isPcm(info) && info.bits === like.bits && info.channels === like.channels && info.sampleRate === like.sampleRate) return sourcePath;
			} catch {
				// not a WAV we can read ourselves: let the system decoder try
			}
		}
		await convert(sourcePath, out, `LEI${like.bits}@${like.sampleRate}`);
		return out;
	}
	// Stretched as floating point, so nothing clips or is rounded on the way.
	const float = path.join(dir, `${name}-float.wav`);
	const stretched = path.join(dir, `${name}-stretched.wav`);
	await convert(sourcePath, float, `LEF32@${like.sampleRate}`);
	await stretchFile(float, stretched, fromBpm, toBpm);
	await convert(stretched, out, `LEI${like.bits}@${like.sampleRate}`);
	return out;
}

// `others`: the editor's other tracks; a section with `src` i > 0 is a stretch of `others[i - 1]`.
// The result is in the first track's format and at its tempo (`bpm`).
export type EditExportJob = { sourcePath: string; outPath: string; tmpDir: string; bpm: number; downbeatSec?: number; sections: Span[]; others?: { sourcePath: string; bpm: number }[] };

export async function exportEdit(job: EditExportJob): Promise<SpliceResult & { seconds: number }> {
	const dir = await fs.promises.mkdtemp(path.join(job.tmpDir, "dj-edit-"));
	const part = `${job.outPath}.part`;
	try {
		const pcm = await sourcePcm(job.sourcePath, dir);
		const info = wavInfo(pcm);
		const sources = [pcm];
		const frames = [info.frames];
		const used = new Set(job.sections.map(srcOf));
		const others = job.others ?? [];
		if ([...used].some((i) => i > others.length)) throw new Error("A section's track is missing");
		for (let i = 1; i <= others.length; i++) {
			// Tracks with nothing in the edit are not read at all; their place is kept.
			if (!used.has(i)) {
				sources.push(pcm);
				frames.push(0);
				continue;
			}
			sources.push(await matchedPcm(others[i - 1].sourcePath, dir, `track${i}`, info, others[i - 1].bpm, job.bpm));
			frames.push(wavInfo(sources[i]).frames);
		}
		const layers = editLayers(job.sections, job.bpm, info.sampleRate, frames);
		if (layers.length === 0) throw new Error("There is nothing to export");
		const tag: GridTag = job.downbeatSec === undefined ? { bpm: job.bpm } : { bpm: job.bpm, downbeatSec: job.downbeatSec };
		const r = spliceWav(sources, part, layers, tag);
		await fs.promises.rename(part, job.outPath);
		return { ...r, seconds: r.frames / r.sampleRate };
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true });
		await fs.promises.rm(part, { force: true });
	}
}
