// Builds Rekordbox analysis files (ANLZ0000.DAT / .EXT) for tests, in the layout Rekordbox
// itself writes: <root>/<3 chars>/<rest of a UUID>/ANLZ0000.*
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SAMPLE_RATE } from "../src/shared/planner";
import { WavReader } from "../src/main/audio/wav";
import type { AnlzBeat } from "../src/main/rekordbox";

function section(tag: string, head: Buffer, body: Buffer): Buffer {
	const h = Buffer.alloc(12);
	h.write(tag, 0, "latin1");
	h.writeUInt32BE(12 + head.length, 4);
	h.writeUInt32BE(12 + head.length + body.length, 8);
	return Buffer.concat([h, head, body]);
}

function file(parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);
	const h = Buffer.alloc(28);
	h.write("PMAI", 0, "latin1");
	h.writeUInt32BE(28, 4);
	h.writeUInt32BE(28 + body.length, 8);
	return Buffer.concat([h, body]);
}

function ppth(storedPath: string): Buffer {
	const text = Buffer.from(`${storedPath}\0`, "utf16le").swap16();
	const head = Buffer.alloc(4);
	head.writeUInt32BE(text.length, 0);
	return section("PPTH", head, text);
}

export function datFile(storedPath: string, beats: AnlzBeat[]): Buffer {
	const head = Buffer.alloc(12);
	head.writeUInt32BE(0x00080000, 4);
	head.writeUInt32BE(beats.length, 8);
	const body = Buffer.alloc(beats.length * 8);
	beats.forEach((b, i) => {
		body.writeUInt16BE(b.no, i * 8);
		body.writeUInt16BE(b.tempo, i * 8 + 2);
		body.writeUInt32BE(b.ms, i * 8 + 4);
	});
	// Rekordbox puts other sections around the grid; readers must skip what they don't know.
	return file([ppth(storedPath), section("PVBR", Buffer.alloc(4), Buffer.alloc(1600)), section("PQTZ", head, body), section("PWAV", Buffer.alloc(8), Buffer.alloc(400))]);
}

export function extFile(storedPath: string, heights: Uint8Array, tag: "PWV3" | "PWV5" = "PWV3"): Buffer {
	const head = Buffer.alloc(12);
	head.writeUInt32BE(tag === "PWV3" ? 1 : 2, 0);
	head.writeUInt32BE(heights.length, 4);
	head.writeUInt32BE(0x00960000, 8);
	let body: Buffer;
	if (tag === "PWV3") {
		body = Buffer.alloc(heights.length);
		heights.forEach((v, i) => (body[i] = (v & 0x1f) | 0xa0)); // top bits are the colour
	} else {
		body = Buffer.alloc(heights.length * 2);
		heights.forEach((v, i) => body.writeUInt16BE(((v & 0x1f) << 2) | 0x9280, i * 2));
	}
	return file([ppth(storedPath), section("PCOB", Buffer.alloc(12), Buffer.alloc(0)), section(tag, head, body)]);
}

// A steady grid as Rekordbox stores it: whole-millisecond times, BPM to two decimals.
export function gridBeats(bpm: number, firstSec: number, firstNo: number, count: number): AnlzBeat[] {
	const out: AnlzBeat[] = [];
	for (let i = 0; i < count; i++) out.push({ no: ((firstNo - 1 + i) % 4) + 1, tempo: Math.round(bpm * 100), ms: Math.round((firstSec + (i * 60) / bpm) * 1000) });
	return out;
}

// The waveform Rekordbox would draw of a 44.1 kHz WAV if its decode of the file started
// `shiftFrames` before ours (the padding it keeps at the start of MP3 and AAC files).
export function waveformOf(wavPath: string, shiftFrames = 0): Uint8Array {
	const r = new WavReader(wavPath);
	const column = SAMPLE_RATE / 150;
	const n = Math.ceil((r.frames + shiftFrames) / column);
	const out = new Uint8Array(n);
	const buf = new Float32Array(column * 2);
	for (let k = 0; k < n; k++) {
		buf.fill(0);
		r.read(k * column - shiftFrames, column, buf);
		let m = 0;
		for (let i = 0; i < column; i++) m = Math.max(m, Math.abs(buf[i * 2] + buf[i * 2 + 1]) * 0.5);
		out[k] = Math.min(31, Math.round(31 * Math.sqrt(m)));
	}
	r.close();
	return out;
}

let counter = 0;

// Writes one track's analysis folder and returns the .DAT path. `storedPath` is what
// Rekordbox records for the file: "?/<file name>" these days, a full path in older libraries.
export function writeAnalysis(root: string, storedPath: string, beats: AnlzBeat[], heights: Uint8Array | null, opts: { mtime?: Date; tag?: "PWV3" | "PWV5" } = {}): string {
	counter++;
	const id = counter.toString(16).padStart(3, "0");
	const dir = path.join(root, id, `${id}aa-1f81-4747-b48a-e4dce25729c8`);
	fs.mkdirSync(dir, { recursive: true });
	const dat = path.join(dir, "ANLZ0000.DAT");
	fs.writeFileSync(dat, datFile(storedPath, beats));
	if (heights) fs.writeFileSync(path.join(dir, "ANLZ0000.EXT"), extFile(storedPath, heights, opts.tag));
	if (opts.mtime) fs.utimesSync(dat, opts.mtime, opts.mtime);
	return dat;
}

// How far ahead of our decode Rekordbox's clock is known to start for a real file, in
// seconds. Rekordbox keeps everything its decoder puts out. Ours drops the MP3 decoder's
// own 528 frames and whatever priming the file declares. An MP3 written by LAME carries
// one more frame in Rekordbox (it plays the info frame as audio). AAC files come both ways.
export function knownShifts(file: string): { kind: string; shifts: number[] } {
	const ext = path.extname(file).toLowerCase();
	if (ext !== ".mp3" && ext !== ".m4a") return { kind: ext, shifts: [0] };
	let priming = 0;
	let rate = SAMPLE_RATE;
	try {
		const info = execFileSync("/usr/bin/afinfo", [file], { encoding: "utf8" });
		priming = Number(info.match(/\+ (\d+) priming/)?.[1] ?? 0);
		rate = Number(info.match(/(\d+) Hz/)?.[1] ?? SAMPLE_RATE);
	} catch {
		// leave the defaults
	}
	if (ext === ".m4a") return { kind: ".m4a", shifts: [0, priming / rate] };
	// The first audio frame comes after the ID3 tag, which can be large (cover art).
	const fd = fs.openSync(file, "r");
	const id3 = Buffer.alloc(10);
	fs.readSync(fd, id3, 0, 10, 0);
	const skip = id3.toString("latin1", 0, 3) === "ID3" ? 10 + (((id3[6] & 0x7f) << 21) | ((id3[7] & 0x7f) << 14) | ((id3[8] & 0x7f) << 7) | (id3[9] & 0x7f)) : 0;
	const head = Buffer.alloc(4096);
	const n = fs.readSync(fd, head, 0, head.length, skip);
	fs.closeSync(fd);
	const tag = Math.max(head.subarray(0, n).indexOf("Info"), head.subarray(0, n).indexOf("Xing"));
	const lame = tag >= 0 && head.toString("latin1", tag + 120, tag + 124) === "LAME";
	return { kind: `mp3 ${lame ? "LAME" : tag >= 0 ? "other encoder" : "no header"}, priming ${priming}, ${rate} Hz`, shifts: [(528.5 + priming + (lame ? 1152 : 0)) / rate] };
}
