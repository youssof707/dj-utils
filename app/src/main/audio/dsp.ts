// Offline audio work: waveform peaks, mixing clips to one file, and applying the tempo
// curve to the mixed file. Runs inside a worker thread (see worker.ts) and in tests.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PEAK_BUCKET, SAMPLE_RATE, type ExportClip } from "../../shared/planner";
import { TempoMap, isFlat, type Pt } from "../../shared/tempo";
import { WavReader, WavWriter } from "./wav";

export const RUBBERBAND = ["/opt/homebrew/bin/rubberband-r3", "/usr/local/bin/rubberband-r3"].find((p) => fs.existsSync(p)) ?? "rubberband-r3";

type Progress = (pct: number) => void;

// Two bytes per PEAK_BUCKET frames, each 0..255: the loudest sample in the bucket, and the
// loudest sample of the kick band (everything below about 150 Hz). The kick band is what
// shows where kicks land; hats, synths and vocals are left out of it.
const KICK_HZ = 150;

// Second-order low-pass section (RBJ biquad) with running state, so a long file can be
// filtered chunk by chunk.
class LowPass {
	private b0: number;
	private b1: number;
	private b2: number;
	private a1: number;
	private a2: number;
	private x1 = 0;
	private x2 = 0;
	private y1 = 0;
	private y2 = 0;
	constructor(hz: number, q: number) {
		const w = (2 * Math.PI * hz) / SAMPLE_RATE;
		const alpha = Math.sin(w) / (2 * q);
		const cos = Math.cos(w);
		const a0 = 1 + alpha;
		this.b0 = (1 - cos) / 2 / a0;
		this.b1 = (1 - cos) / a0;
		this.b2 = this.b0;
		this.a1 = (-2 * cos) / a0;
		this.a2 = (1 - alpha) / a0;
	}
	step(x: number): number {
		const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
		this.x2 = this.x1;
		this.x1 = x;
		this.y2 = this.y1;
		this.y1 = y;
		return y;
	}
}

export function computePeaks(wavPath: string): Uint8Array {
	const r = new WavReader(wavPath);
	try {
		const n = Math.ceil(r.frames / PEAK_BUCKET);
		const peaks = new Uint8Array(n * 2);
		// Fourth-order Butterworth: two sections with Q 0.5412 and 1.3066.
		const lp1 = new LowPass(KICK_HZ, 0.5412);
		const lp2 = new LowPass(KICK_HZ, 1.3066);
		// The filter delays the kick band by its group delay; move it back so the kick body
		// lines up with the full-band attack.
		const delayFrames = (1 / 0.5412 + 1 / 1.3066) / (2 * Math.PI * KICK_HZ) * SAMPLE_RATE;
		const shift = Math.round(delayFrames / PEAK_BUCKET);
		const chunkBuckets = 4096;
		const buf = new Float32Array(chunkBuckets * PEAK_BUCKET * 2);
		for (let b = 0; b < n; b += chunkBuckets) {
			const got = r.read(b * PEAK_BUCKET, chunkBuckets * PEAK_BUCKET, buf);
			for (let i = 0; i * PEAK_BUCKET < got; i++) {
				let m = 0;
				let low = 0;
				const end = Math.min(got, (i + 1) * PEAK_BUCKET);
				for (let f = i * PEAK_BUCKET; f < end; f++) {
					const l = buf[f * 2];
					const rr = buf[f * 2 + 1];
					const al = Math.abs(l);
					const ar = Math.abs(rr);
					if (al > m) m = al;
					if (ar > m) m = ar;
					const y = Math.abs(lp2.step(lp1.step((l + rr) * 0.5)));
					if (y > low) low = y;
				}
				const k = b + i;
				peaks[k * 2] = Math.min(255, Math.round(m * 255));
				const at = k - shift;
				if (at >= 0) peaks[at * 2 + 1] = Math.min(255, Math.round(low * 255));
			}
		}
		return peaks;
	} finally {
		r.close();
	}
}

// Sums every clip into one float32 WAV at project tempo. Reads in chunks so the size of
// the set is bounded by disk, not memory.
export function mixClips(clips: ExportClip[], outPath: string, onProgress: Progress = () => {}): { frames: number; peak: number } {
	const total = clips.reduce((m, c) => Math.max(m, c.startFrame + c.frames), 0);
	const readers = new Map<string, WavReader>();
	const w = new WavWriter(outPath, SAMPLE_RATE, "float32");
	const chunk = SAMPLE_RATE * 2;
	const buf = new Float32Array(chunk * 2);
	let peak = 0;
	try {
		for (let pos = 0; pos < total; pos += chunk) {
			const n = Math.min(chunk, total - pos);
			buf.fill(0);
			for (const c of clips) {
				const from = Math.max(pos, c.startFrame);
				const to = Math.min(pos + n, c.startFrame + c.frames);
				if (to <= from) continue;
				let r = readers.get(c.cachePath);
				if (!r) {
					r = new WavReader(c.cachePath);
					readers.set(c.cachePath, r);
				}
				r.read(c.offsetFrame + (from - c.startFrame), to - from, buf, from - pos, true);
			}
			for (let i = 0; i < n * 2; i++) {
				const v = Math.abs(buf[i]);
				if (v > peak) peak = v;
			}
			w.write(buf, n);
			onProgress((pos + n) / total);
		}
	} finally {
		w.close();
		for (const r of readers.values()) r.close();
	}
	return { frames: total, peak };
}

// Windowed-sinc interpolation tables, one per cutoff, built on demand.
const HALF = 16;
const PHASES = 512;
const tables = new Map<number, Float32Array>();

function bessel0(x: number): number {
	let sum = 1;
	let term = 1;
	for (let k = 1; k < 40; k++) {
		term *= (x / (2 * k)) ** 2;
		sum += term;
		if (term < 1e-12 * sum) break;
	}
	return sum;
}

function sincTable(cutoff: number): Float32Array {
	const key = Math.round(cutoff * 50);
	let t = tables.get(key);
	if (t) return t;
	const fc = key / 50;
	const beta = 9;
	t = new Float32Array((PHASES + 1) * HALF * 2);
	for (let p = 0; p <= PHASES; p++) {
		const frac = p / PHASES;
		let sum = 0;
		for (let k = 0; k < HALF * 2; k++) {
			const x = k - (HALF - 1) - frac; // distance from the wanted position
			const s = x === 0 ? fc : Math.sin(Math.PI * fc * x) / (Math.PI * x);
			const wpos = x / HALF;
			const win = Math.abs(wpos) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - wpos * wpos)) / bessel0(beta);
			const v = s * win;
			t[p * HALF * 2 + k] = v;
			sum += v;
		}
		for (let k = 0; k < HALF * 2; k++) t[p * HALF * 2 + k] /= sum;
	}
	tables.set(key, t);
	return t;
}

// Plays the mixed file back along the tempo curve by resampling: where the curve is above
// the project BPM the audio runs faster. Pitch moves with speed. Timing is exact.
export function varispeed(inPath: string, outPath: string, points: Pt[], projectBpm: number, onProgress: Progress = () => {}): number {
	const map = new TempoMap(points, projectBpm);
	const r = new WavReader(inPath);
	const w = new WavWriter(outPath, SAMPLE_RATE, "float32");
	try {
		const srcFrames = r.frames;
		const framesPerBeat = (60 / projectBpm) * SAMPLE_RATE;
		const outFrames = Math.round(map.secondsAtBeat(srcFrames / framesPerBeat) * SAMPLE_RATE);
		const block = 4096;
		const step = 64; // source position is exact every `step` frames, linear between
		const out = new Float32Array(block * 2);
		let src = new Float32Array(0);
		const srcPosAt = (n: number): number => map.beatAtSeconds(n / SAMPLE_RATE) * framesPerBeat;
		for (let n0 = 0; n0 < outFrames; n0 += block) {
			const n = Math.min(block, outFrames - n0);
			const p0 = srcPosAt(n0);
			const p1 = srcPosAt(n0 + n);
			const ratio = (p1 - p0) / n;
			const table = sincTable(Math.min(0.94, 0.94 / Math.max(1, ratio)));
			const first = Math.floor(p0) - HALF;
			const count = Math.ceil(p1) + HALF + 2 - first;
			if (src.length < count * 2) src = new Float32Array(count * 2);
			src.fill(0, 0, count * 2);
			r.read(first, count, src);
			for (let s0 = 0; s0 < n; s0 += step) {
				const sn = Math.min(step, n - s0);
				const a = srcPosAt(n0 + s0);
				const b = srcPosAt(n0 + s0 + sn);
				const inc = (b - a) / sn;
				for (let i = 0; i < sn; i++) {
					const pos = a + inc * i;
					const ip = Math.floor(pos);
					const fr = (pos - ip) * PHASES;
					const ph = Math.floor(fr);
					const mix = fr - ph;
					const t0 = ph * HALF * 2;
					const t1 = t0 + HALF * 2;
					let base = (ip - (HALF - 1) - first) * 2;
					let l = 0;
					let rr = 0;
					for (let k = 0; k < HALF * 2; k++) {
						const c = table[t0 + k] + (table[t1 + k] - table[t0 + k]) * mix;
						l += src[base] * c;
						rr += src[base + 1] * c;
						base += 2;
					}
					const o = (s0 + i) * 2;
					out[o] = l;
					out[o + 1] = rr;
				}
			}
			w.write(out, n);
			onProgress((n0 + n) / outFrames);
		}
		return outFrames;
	} finally {
		w.close();
		r.close();
	}
}

// Child processes currently running, so a cancelled job can stop them.
const children = new Set<ChildProcess>();
export function killChildren(): void {
	for (const c of children) c.kill("SIGKILL");
}

function run(cmd: string, args: string[], onLine: (s: string) => void = () => {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
		children.add(p);
		p.on("close", () => children.delete(p));
		let err = "";
		p.stderr.on("data", (d: Buffer) => {
			const s = d.toString();
			err = (err + s).slice(-2000);
			onLine(s);
		});
		p.on("error", (e) => reject(new Error(`Could not run ${path.basename(cmd)}: ${e.message}`)));
		p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} failed (${code}): ${err.trim().split("\n").pop()}`))));
	});
}

function percentFeed(onProgress: Progress): (s: string) => void {
	// Rubber Band prints "NN%" while studying (pass 1) and processing (pass 2).
	let pass = 0;
	let last = -1;
	return (s) => {
		for (const m of s.matchAll(/(\d+)%/g)) {
			const v = Number(m[1]);
			if (v < last) pass = Math.min(1, pass + 1);
			last = v;
			onProgress((pass * 100 + v) / 200);
		}
	};
}

// Pitch-preserving stretch of a whole file by one ratio. Used once per track on import.
export async function stretchFile(inPath: string, outPath: string, fromBpm: number, toBpm: number, onProgress: Progress = () => {}): Promise<void> {
	if (Math.abs(fromBpm - toBpm) < 1e-9) {
		await fs.promises.copyFile(inPath, outPath);
		return;
	}
	await run(RUBBERBAND, ["--tempo", `${fromBpm}:${toBpm}`, "--ignore-clipping", inPath, outPath], percentFeed(onProgress));
}

// Key-locked tempo curve: the tempo follows the curve while pitch stays where it was.
// Two steps. First Rubber Band shifts the pitch by the inverse of the speed change at
// each moment, leaving timing alone. Then the varispeed pass speeds the audio along the
// curve, which moves the pitch back to where it started and gives exact timing.
export async function keylock(inPath: string, outPath: string, points: Pt[], projectBpm: number, tmpDir: string, onProgress: Progress = () => {}): Promise<number> {
	const map = new TempoMap(points, projectBpm);
	const r = new WavReader(inPath);
	const srcFrames = r.frames;
	r.close();
	const framesPerBeat = (60 / projectBpm) * SAMPLE_RATE;
	const lines: string[] = [];
	const stepFrames = 2048;
	let prev = NaN;
	for (let f = 0; f <= srcFrames; f += stepFrames) {
		const mult = projectBpm / map.bpmAtBeat(f / framesPerBeat);
		if (f === 0 || Math.abs(mult - prev) > 1e-7) {
			lines.push(`${f} ${mult.toFixed(8)}`);
			prev = mult;
		}
	}
	const mapFile = path.join(tmpDir, "freqmap.txt");
	const shifted = path.join(tmpDir, "shifted.wav");
	await fs.promises.writeFile(mapFile, lines.join("\n") + "\n");
	await run(RUBBERBAND, ["--time", "1", "--freqmap", mapFile, "--ignore-clipping", inPath, shifted], percentFeed((p) => onProgress(p * 0.7)));
	const frames = varispeed(shifted, outPath, points, projectBpm, (p) => onProgress(0.7 + p * 0.3));
	await fs.promises.rm(shifted, { force: true });
	return frames;
}

// Converts the float32 working file to the final 16-bit WAV, turning the level down only
// if the mix would otherwise clip.
export function finalize(inPath: string, outPath: string, onProgress: Progress = () => {}): { frames: number; gain: number } {
	const r = new WavReader(inPath);
	const chunk = SAMPLE_RATE * 2;
	const buf = new Float32Array(chunk * 2);
	try {
		let peak = 0;
		for (let pos = 0; pos < r.frames; pos += chunk) {
			const n = r.read(pos, chunk, buf);
			for (let i = 0; i < n * 2; i++) {
				const v = Math.abs(buf[i]);
				if (v > peak) peak = v;
			}
			onProgress((0.5 * (pos + n)) / r.frames);
		}
		const ceiling = 0.989; // about -0.1 dBFS
		const gain = peak > ceiling ? ceiling / peak : 1;
		const w = new WavWriter(outPath, SAMPLE_RATE, "int16");
		try {
			for (let pos = 0; pos < r.frames; pos += chunk) {
				const n = r.read(pos, chunk, buf);
				w.write(buf, n, gain);
				onProgress(0.5 + (0.5 * (pos + n)) / r.frames);
			}
		} finally {
			w.close();
		}
		return { frames: r.frames, gain };
	} finally {
		r.close();
	}
}

export type ExportJob = { outPath: string; projectBpm: number; clips: ExportClip[]; points: Pt[]; keyLock: boolean; tmpDir: string };

export async function exportSet(job: ExportJob, onProgress: (stage: string, pct: number) => void): Promise<{ seconds: number; gainDb: number }> {
	const dir = await fs.promises.mkdtemp(path.join(job.tmpDir, "export-"));
	try {
		const mix = path.join(dir, "mix.wav");
		const { frames } = mixClips(job.clips, mix, (p) => onProgress("Mixing", p));
		if (frames === 0) throw new Error("There is nothing on the timeline to export");
		let staged = mix;
		if (!isFlat(job.points, job.projectBpm)) {
			const tempo = path.join(dir, "tempo.wav");
			if (job.keyLock) await keylock(mix, tempo, job.points, job.projectBpm, dir, (p) => onProgress("Applying tempo changes", p));
			else varispeed(mix, tempo, job.points, job.projectBpm, (p) => onProgress("Applying tempo changes", p));
			staged = tempo;
		}
		const tmpOut = job.outPath + ".part";
		const fin = finalize(staged, tmpOut, (p) => onProgress("Writing file", p));
		await fs.promises.rename(tmpOut, job.outPath);
		return { seconds: fin.frames / SAMPLE_RATE, gainDb: 20 * Math.log10(fin.gain) };
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
}

export function afconvertToWav(inPath: string, outPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("/usr/bin/afconvert", ["-f", "WAVE", "-d", `LEF32@${SAMPLE_RATE}`, "-c", "2", inPath, outPath], (err) => {
			if (err) reject(new Error("This file could not be read as audio"));
			else resolve();
		});
	});
}
