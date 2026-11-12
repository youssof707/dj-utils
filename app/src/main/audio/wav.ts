// Streaming WAV reading and writing. Everything is handled as interleaved stereo float32.

import fs from "node:fs";

export type WavInfo = {
	format: number; // 1 = integer PCM, 3 = float
	channels: number;
	sampleRate: number;
	bits: number;
	dataOffset: number;
	frames: number;
};

export function parseWavHeader(fd: number): WavInfo {
	const size = fs.fstatSync(fd).size;
	const head = Buffer.alloc(12);
	fs.readSync(fd, head, 0, 12, 0);
	if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") {
		throw new Error("Not a WAV file");
	}
	let pos = 12;
	let fmt: Omit<WavInfo, "dataOffset" | "frames"> | null = null;
	const ch = Buffer.alloc(8);
	while (pos + 8 <= size) {
		fs.readSync(fd, ch, 0, 8, pos);
		const id = ch.toString("latin1", 0, 4);
		let len = ch.readUInt32LE(4);
		if (id === "fmt ") {
			const b = Buffer.alloc(Math.min(len, 40));
			fs.readSync(fd, b, 0, b.length, pos + 8);
			let format = b.readUInt16LE(0);
			if (format === 0xfffe && b.length >= 26) format = b.readUInt16LE(24);
			fmt = { format, channels: b.readUInt16LE(2), sampleRate: b.readUInt32LE(4), bits: b.readUInt16LE(14) };
		} else if (id === "data") {
			if (!fmt) throw new Error("WAV data before format");
			const dataOffset = pos + 8;
			// Streamed files can carry a wrong or zero length; trust the file size then.
			if (len === 0 || len === 0xffffffff || dataOffset + len > size) len = size - dataOffset;
			const frameBytes = (fmt.bits / 8) * fmt.channels;
			return { ...fmt, dataOffset, frames: Math.floor(len / frameBytes) };
		}
		pos += 8 + len + (len % 2);
	}
	throw new Error("WAV has no data");
}

export class WavReader {
	readonly fd: number;
	readonly info: WavInfo;
	private raw = Buffer.alloc(0);

	constructor(path: string) {
		this.fd = fs.openSync(path, "r");
		try {
			this.info = parseWavHeader(this.fd);
		} catch (e) {
			fs.closeSync(this.fd);
			throw e;
		}
		const { format, bits } = this.info;
		const ok = (format === 3 && bits === 32) || (format === 1 && (bits === 16 || bits === 24 || bits === 32));
		if (!ok) {
			fs.closeSync(this.fd);
			throw new Error(`Unsupported WAV encoding (format ${format}, ${bits} bit)`);
		}
	}

	get frames(): number {
		return this.info.frames;
	}

	// Reads up to `count` frames starting at `start` into `out` (interleaved stereo) at
	// frame index `outFrame`. Frames outside the file are left untouched. Returns frames read.
	read(start: number, count: number, out: Float32Array, outFrame = 0, add = false): number {
		if (start < 0) {
			outFrame -= start;
			count += start;
			start = 0;
		}
		count = Math.min(count, this.info.frames - start);
		if (count <= 0) return 0;
		const { channels, bits, format, dataOffset } = this.info;
		const bps = bits / 8;
		const bytes = count * channels * bps;
		if (this.raw.length < bytes) this.raw = Buffer.alloc(bytes);
		const raw = this.raw;
		let got = 0;
		while (got < bytes) {
			const n = fs.readSync(this.fd, raw, got, bytes - got, dataOffset + start * channels * bps + got);
			if (n <= 0) break;
			got += n;
		}
		const n = Math.floor(got / (channels * bps));
		const c1 = channels > 1 ? 1 : 0;
		if (format === 3 && channels === 2 && raw.byteOffset % 4 === 0) {
			// Fast path for the cache format (stereo float32).
			const f = new Float32Array(raw.buffer, raw.byteOffset, n * 2);
			const o = outFrame * 2;
			if (add) for (let i = 0; i < n * 2; i++) out[o + i] += f[i];
			else out.set(f, o);
			return n;
		}
		for (let i = 0; i < n; i++) {
			const base = i * channels * bps;
			let l: number;
			let r: number;
			if (format === 3) {
				l = raw.readFloatLE(base);
				r = raw.readFloatLE(base + c1 * 4);
			} else if (bits === 16) {
				l = raw.readInt16LE(base) / 32768;
				r = raw.readInt16LE(base + c1 * 2) / 32768;
			} else if (bits === 24) {
				l = raw.readIntLE(base, 3) / 8388608;
				r = raw.readIntLE(base + c1 * 3, 3) / 8388608;
			} else {
				l = raw.readInt32LE(base) / 2147483648;
				r = raw.readInt32LE(base + c1 * 4) / 2147483648;
			}
			const o = (outFrame + i) * 2;
			if (add) {
				out[o] += l;
				out[o + 1] += r;
			} else {
				out[o] = l;
				out[o + 1] = r;
			}
		}
		return n;
	}

	close(): void {
		fs.closeSync(this.fd);
	}
}

function header(format: 1 | 3, bits: number, sampleRate: number, dataBytes: number): Buffer {
	const h = Buffer.alloc(44);
	const blockAlign = (bits / 8) * 2;
	h.write("RIFF", 0, "latin1");
	h.writeUInt32LE(Math.min(0xffffffff, 36 + dataBytes), 4);
	h.write("WAVE", 8, "latin1");
	h.write("fmt ", 12, "latin1");
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(format, 20);
	h.writeUInt16LE(2, 22);
	h.writeUInt32LE(sampleRate, 24);
	h.writeUInt32LE(sampleRate * blockAlign, 28);
	h.writeUInt16LE(blockAlign, 32);
	h.writeUInt16LE(bits, 34);
	h.write("data", 36, "latin1");
	h.writeUInt32LE(Math.min(0xffffffff, dataBytes), 40);
	return h;
}

// Writes stereo WAV, either float32 or 16-bit integer.
export class WavWriter {
	private fd: number;
	private bytes = 0;
	frames = 0;

	constructor(
		path: string,
		private sampleRate: number,
		private kind: "float32" | "int16",
	) {
		this.fd = fs.openSync(path, "w");
		fs.writeSync(this.fd, header(kind === "float32" ? 3 : 1, kind === "float32" ? 32 : 16, sampleRate, 0), 0, 44, 0);
	}

	// `data` is interleaved stereo; `frames` frames are written. `gain` applies to int16 output.
	write(data: Float32Array, frames: number, gain = 1): void {
		if (frames <= 0) return;
		let buf: Buffer;
		if (this.kind === "float32") {
			buf = Buffer.from(data.buffer, data.byteOffset, frames * 8);
		} else {
			buf = Buffer.alloc(frames * 4);
			for (let i = 0; i < frames * 2; i++) {
				// Triangular dither keeps quiet tails from turning into quantisation noise.
				const d = (Math.random() - Math.random()) / 65536;
				let v = Math.round((data[i] * gain + d) * 32767);
				if (v > 32767) v = 32767;
				else if (v < -32768) v = -32768;
				buf.writeInt16LE(v, i * 2);
			}
		}
		let off = 0;
		while (off < buf.length) off += fs.writeSync(this.fd, buf, off, buf.length - off, 44 + this.bytes + off);
		this.bytes += buf.length;
		this.frames += frames;
	}

	close(): void {
		const kind = this.kind;
		fs.writeSync(this.fd, header(kind === "float32" ? 3 : 1, kind === "float32" ? 32 : 16, this.sampleRate, this.bytes), 0, 44, 0);
		fs.closeSync(this.fd);
	}
}
