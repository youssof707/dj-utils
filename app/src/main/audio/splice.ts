// Exporting an edited track: the source file's own samples, rearranged. Nothing here
// resamples, stretches, changes level or dithers. Whole stretches of the file are copied
// byte for byte; only the few milliseconds leading up to a join are computed.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { editSlices, srcOf, type Slice, type Span } from "../../shared/trackEdit";
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

// Writes `slices` of the integer PCM WAV at `srcPath`, one after the other, to `outPath` in
// the same sample rate, bit depth and channel count. With several source files (a slice's
// `src` says which) they must all be in the same format.
export function spliceWav(srcPath: string | string[], outPath: string, slices: Slice[], tag: GridTag | null): SpliceResult {
	const fds: number[] = [];
	let out: number | null = null;
	try {
		for (const p of Array.isArray(srcPath) ? srcPath : [srcPath]) fds.push(fs.openSync(p, "r"));
		const infos = fds.map((fd) => parseWavHeader(fd));
		const info = infos[0];
		if (!isPcm(info)) throw new Error(`Unsupported WAV encoding (format ${info.format}, ${info.bits} bit)`);
		if (infos.some((i) => i.format !== info.format || i.bits !== info.bits || i.channels !== info.channels || i.sampleRate !== info.sampleRate)) throw new Error("The tracks are not in the same audio format");
		const bps = info.bits / 8;
		const frameBytes = bps * info.channels;
		for (const s of slices) {
			if (!Number.isInteger(s.frames) || s.frames <= 0) throw new Error("A section lies outside the track");
			if (!s.silent && (!infos[srcOf(s)] || !Number.isInteger(s.start) || s.start < 0 || s.start + s.frames > infos[srcOf(s)].frames)) throw new Error("A section lies outside the track");
		}
		// Reads `frames` frames of a slice's source file into `buf`.
		const read = (of: Slice, buf: Buffer, frames: number, frame: number): void => readFully(fds[srcOf(of)], buf, frames * frameBytes, infos[srcOf(of)].dataOffset + frame * frameBytes);
		const joinFrames = Math.max(1, Math.round(JOIN_SEC * info.sampleRate));
		const edgeFrames = Math.max(1, Math.round(EDGE_SEC * info.sampleRate));
		out = fs.openSync(outPath, "w");
		let pos = 44;
		const chunkFrames = Math.max(1, Math.floor((1 << 20) / frameBytes));
		const copy = Buffer.alloc(chunkFrames * frameBytes);
		const a = Buffer.alloc(joinFrames * frameBytes);
		const b = Buffer.alloc(joinFrames * frameBytes);

		slices.forEach((s, i) => {
			const next = slices[i + 1];
			if (s.silent) {
				// Silence, then the same blend into the next section as at any join: from the
				// silence into what led up to it in the source, so its first beat is untouched.
				const tail = next && !next.silent ? Math.min(joinFrames, s.frames) : 0;
				copy.fill(0);
				for (let left = s.frames - tail; left > 0; ) {
					const n = Math.min(chunkFrames, left);
					writeFully(out!, copy, n * frameBytes, pos);
					pos += n * frameBytes;
					left -= n;
				}
				if (tail > 0) {
					b.fill(0);
					const from = Math.max(0, next.start - tail);
					const have = next.start - from;
					if (have > 0) read(next, b.subarray((tail - have) * frameBytes), have, from);
					for (let k = 0; k < tail; k++) {
						const w = blendWeight(k, tail);
						for (let c = 0; c < info.channels; c++) {
							const o = (k * info.channels + c) * bps;
							b.writeIntLE(Math.round(b.readIntLE(o, bps) * w), o, bps);
						}
					}
					writeFully(out!, b, tail * frameBytes, pos);
					pos += tail * frameBytes;
				}
				return;
			}
			const end = s.start + s.frames;
			// The last frames of the slice are blended: towards the next slice's lead-up at a
			// join, towards silence where the file ends before the track does.
			const joined = next ? next.silent || srcOf(next) !== srcOf(s) || next.start !== end : end < infos[srcOf(s)].frames;
			const tail = joined ? Math.min(joinFrames, s.frames) : 0;
			const head = i === 0 && s.start > 0 ? Math.min(edgeFrames, s.frames - tail) : 0;

			if (head > 0) {
				read(s, a, head, s.start);
				for (let k = 0; k < head; k++) {
					const w = blendWeight(k, head);
					for (let c = 0; c < info.channels; c++) {
						const o = (k * info.channels + c) * bps;
						a.writeIntLE(Math.round(a.readIntLE(o, bps) * w), o, bps);
					}
				}
				writeFully(out!, a, head * frameBytes, pos);
				pos += head * frameBytes;
			}

			// Everything between is the source, byte for byte.
			let frame = s.start + head;
			const bodyEnd = end - tail;
			while (frame < bodyEnd) {
				const n = Math.min(chunkFrames, bodyEnd - frame);
				read(s, copy, n, frame);
				writeFully(out!, copy, n * frameBytes, pos);
				pos += n * frameBytes;
				frame += n;
			}

			if (tail > 0) {
				read(s, a, tail, bodyEnd);
				b.fill(0);
				// What led up to the next slice in the source (silence before the file's start);
				// with silence next, the section fades out.
				if (next && !next.silent) {
					const from = Math.max(0, next.start - tail);
					const have = next.start - from;
					if (have > 0) read(next, b.subarray((tail - have) * frameBytes), have, from);
				}
				for (let k = 0; k < tail; k++) {
					const w = blendWeight(k, tail);
					for (let c = 0; c < info.channels; c++) {
						const o = (k * info.channels + c) * bps;
						a.writeIntLE(Math.round(a.readIntLE(o, bps) * (1 - w) + b.readIntLE(o, bps) * w), o, bps);
					}
				}
				writeFully(out!, a, tail * frameBytes, pos);
				pos += tail * frameBytes;
			}
		});

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

// The second track of an edit as integer PCM in the first one's format and at its tempo, so
// the two can be cut together: converted to that sample rate, channel count and bit depth,
// and stretched (pitch kept) when its tempo is another. A file that already is all that is
// used as it stands.
async function matchedPcm(sourcePath: string, dir: string, like: WavInfo, fromBpm: number, toBpm: number): Promise<string> {
	const out = path.join(dir, "second.wav");
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
	const float = path.join(dir, "second-float.wav");
	const stretched = path.join(dir, "second-stretched.wav");
	await convert(sourcePath, float, `LEF32@${like.sampleRate}`);
	await stretchFile(float, stretched, fromBpm, toBpm);
	await convert(stretched, out, `LEI${like.bits}@${like.sampleRate}`);
	return out;
}

// `second`: the other track of a two-track edit, which the sections with `src` 1 come from.
// The result is in the first track's format and at its tempo (`bpm`).
export type EditExportJob = { sourcePath: string; outPath: string; tmpDir: string; bpm: number; downbeatSec?: number; leadBeat: number; sections: Span[]; second?: { sourcePath: string; bpm: number } };

export async function exportEdit(job: EditExportJob): Promise<SpliceResult & { seconds: number }> {
	const dir = await fs.promises.mkdtemp(path.join(job.tmpDir, "dj-edit-"));
	const part = `${job.outPath}.part`;
	try {
		const pcm = await sourcePcm(job.sourcePath, dir);
		const info = wavInfo(pcm);
		const sources = [pcm];
		const frames = [info.frames];
		if (job.sections.some((s) => srcOf(s) !== 0)) {
			if (!job.second || job.sections.some((s) => srcOf(s) > 1)) throw new Error("A section's track is missing");
			sources.push(await matchedPcm(job.second.sourcePath, dir, info, job.second.bpm, job.bpm));
			frames.push(wavInfo(sources[1]).frames);
		}
		const slices = editSlices(job.leadBeat, job.sections, job.bpm, info.sampleRate, frames);
		if (slices.length === 0) throw new Error("There is nothing to export");
		const tag: GridTag = job.downbeatSec === undefined ? { bpm: job.bpm } : { bpm: job.bpm, downbeatSec: job.downbeatSec };
		const r = spliceWav(sources, part, slices, tag);
		await fs.promises.rename(part, job.outPath);
		return { ...r, seconds: r.frames / r.sampleRate };
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true });
		await fs.promises.rm(part, { force: true });
	}
}
