// Exporting an edited track: the source file's own samples, rearranged. Nothing here
// resamples, stretches, changes level or dithers. Whole stretches of the file are copied
// byte for byte; only the few milliseconds leading up to a join are computed.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { editLayers, srcOf, type Layer, type Span } from "../../shared/trackEdit";
import { stretchFile } from "./dsp";
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

export type SpliceResult = { frames: number; sampleRate: number; bits: number; channels: number };

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
// layers overlap they are added together (and held at full scale), as two clips on a lane are.
// Each layer fades in over the moment before it, from what led up to it in its file, and out
// over its last moment unless it runs to the end of its file, so a join has no click and its
// first beat is the incoming layer's own.
export function spliceWav(srcPath: string | string[], outPath: string, layers: Layer[], tag: GridTag | null): SpliceResult {
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
		const parts = layers.map((l) => {
			const pre = Math.min(joinFrames, l.at);
			const head = pre === 0 && l.start > 0 ? Math.min(edgeFrames, l.frames) : 0;
			const tail = l.start + l.frames < infos[l.src].frames ? Math.min(joinFrames, l.frames) : 0;
			return { ...l, pre, head, tail, from: l.at - pre, end: l.at + l.frames };
		});
		const total = Math.max(...parts.map((p) => p.end));
		const cuts = [...new Set(parts.flatMap((p) => [p.from, p.at, p.at + p.head, p.end - p.tail, p.end]).concat([0, total]))].filter((b) => b >= 0 && b <= total).sort((x, y) => x - y);

		out = fs.openSync(outPath, "w");
		let pos = 44;
		const chunkFrames = Math.max(1, Math.floor((1 << 20) / frameBytes));
		const copy = Buffer.alloc(chunkFrames * frameBytes);
		const acc = new Float64Array(chunkFrames * ch);
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
			if (o < p.at) return blendWeight(joinFrames - (p.at - o), joinFrames);
			let w = 1;
			if (o - p.at < p.head) w *= blendWeight(o - p.at, p.head);
			const t = o - (p.end - p.tail);
			if (t >= 0) w *= 1 - blendWeight(t, p.tail);
			return w;
		};

		for (let i = 0; i + 1 < cuts.length; i++) {
			const [b0, b1] = [cuts[i], cuts[i + 1]];
			const on = parts.filter((p) => p.from <= b0 && b0 < p.end);
			for (let o = b0; o < b1; ) {
				const n = Math.min(chunkFrames, b1 - o);
				const only = on.length === 1 ? on[0] : null;
				if (on.length === 0) {
					copy.fill(0, 0, n * frameBytes);
					write(copy, n);
				} else if (only && o >= only.at + only.head && o + n <= only.end - only.tail) {
					// One layer at full level: its file, byte for byte.
					read(only, only.start + (o - only.at), n);
					write(copy, n);
				} else {
					acc.fill(0, 0, n * ch);
					for (const p of on) {
						read(p, p.start + (o - p.at), n);
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
		return { frames: dataBytes / frameBytes, sampleRate: info.sampleRate, bits: info.bits, channels: info.channels };
	} finally {
		for (const fd of fds) fs.closeSync(fd);
		if (out !== null) fs.closeSync(out);
	}
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
