// The film's sound, built sample by sample so everything is where the picture is:
// the app's own sound (plus the library previews, rebuilt from their files), cut and dissolved
// exactly as the picture is, lowered under each narration line, with the narration on top.
// Then levelled for online video and joined to the picture.
//
//   node scripts/demo/mix.ts <take name> [--picture picture.mp4] [--out final.mp4]

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEMO, FFMPEG } from "./paths.ts";
import { segments, toOut, XFADE } from "./plan.mjs";
import type { Log } from "./director.ts";

const argv = process.argv.slice(2);
const flag = (n: string): string | null => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const take = path.join(DEMO, "takes", argv[0]);
const VOICE_DIR = path.join(DEMO, "voice");
const RATE = 48000;

const MUSIC_GAIN = 0.3; // the app's sound when nobody is talking
const DUCK = 0.2; // ... and how much of that is left under the voice
const DUCK_RAMP = 0.35; // seconds to go down or come back
const DUCK_HOLD = 1.3; // stay down across gaps between lines shorter than this
const VOICE_LUFS = -17.5; // each line is brought to this before the mix
const FINAL_LUFS = -14.5;

const log: Log = JSON.parse(fs.readFileSync(path.join(take, "log.json"), "utf8"));
const { segs, duration } = segments(log);
const voice: { lines: Record<string, { file: string; dur: number }> } = JSON.parse(fs.readFileSync(path.join(VOICE_DIR, "voice.json"), "utf8"));

// Decodes anything to stereo float at RATE.
function decode(file: string, opts: { ss?: number; t?: number; af?: string } = {}): Float32Array {
	const args = ["-v", "error", ...(opts.ss !== undefined ? ["-ss", opts.ss.toFixed(4)] : []), ...(opts.t !== undefined ? ["-t", opts.t.toFixed(4)] : []), "-i", file, ...(opts.af ? ["-af", opts.af] : []), "-ar", String(RATE), "-ac", "2", "-f", "f32le", "-"];
	const out = execFileSync(FFMPEG, args, { maxBuffer: 2 ** 31 - 1 });
	return new Float32Array(out.buffer, out.byteOffset, Math.floor(out.byteLength / 4));
}
const loudness = (file: string): number => {
	const r = spawnSync(FFMPEG, ["-hide_banner", "-i", file, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
	const m = [...r.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
	if (!m) throw new Error("No loudness for " + file);
	return Number(m[1]);
};
const frames = (sec: number): number => Math.round(sec * RATE);
// Adds `src` into `dst` starting at frame `at`, with short fades at both ends.
function place(dst: Float32Array, src: Float32Array, at: number, gain = 1, fade = 0.012): void {
	const n = src.length / 2;
	const f = Math.max(1, frames(fade));
	for (let i = 0; i < n; i++) {
		const j = at + i;
		if (j < 0 || j * 2 + 1 >= dst.length) continue;
		const g = gain * Math.min(1, i / f, (n - 1 - i) / f);
		dst[2 * j] += src[2 * i] * g;
		dst[2 * j + 1] += src[2 * i + 1] * g;
	}
}

// ---- 1. the app's sound on the recording's clock ---------------------------------------------
const srcEnd = log.frames[log.frames.length - 1].t + 1;
const music = new Float32Array(frames(srcEnd) * 2);
if (log.audio) place(music, decode(path.join(take, log.audio.file)), frames(log.audio.start), 1, 0.002);
// Library previews: runs of an <audio> player playing; the same stretch is taken from its file.
type Run = { src: string; t0: number; pos0: number; t1: number; vol: number };
const runs: Run[] = [];
let cur: Run | null = null;
for (const p of log.players) {
	const cont = cur && p.playing && p.src === cur.src && Math.abs(p.pos - (cur.pos0 + (p.t - cur.t0))) < 0.25;
	if (cont) cur!.t1 = p.t;
	else {
		if (cur && cur.t1 - cur.t0 > 0.1) runs.push(cur);
		cur = p.playing ? { src: p.src, t0: p.t, pos0: p.pos, t1: p.t, vol: p.vol } : null;
	}
	if (cur && !p.playing) {
		if (cur.t1 - cur.t0 > 0.1) runs.push(cur);
		cur = null;
	}
}
if (cur && cur.t1 - cur.t0 > 0.1) runs.push(cur);
for (const r of runs) {
	const file = new URL(r.src).searchParams.get("path");
	if (!file || !fs.existsSync(file)) throw new Error("Preview file not found: " + r.src);
	// The set's own playback goes through a 0.6 gain; match it so previews are not louder.
	place(music, decode(file, { ss: r.pos0, t: r.t1 - r.t0 + 0.03 }), frames(r.t0), 0.6 * r.vol, 0.02);
	console.log(`[mix] preview ${path.basename(file)} from ${r.pos0.toFixed(1)}s for ${(r.t1 - r.t0).toFixed(1)}s at ${r.t0.toFixed(1)}s`);
}
// Fades asked for during the take.
{
	let level = 1;
	let at = 0;
	const steps = [...log.gains].sort((a, b) => a.t - b.t);
	const apply = (from: number, to: number, g0: number, g1: number): void => {
		const a = Math.max(0, frames(from));
		const b = Math.min(music.length / 2, frames(to));
		for (let i = a; i < b; i++) {
			const g = g0 + ((g1 - g0) * (i - a)) / Math.max(1, b - a);
			music[2 * i] *= g;
			music[2 * i + 1] *= g;
		}
	};
	for (const s of steps) {
		apply(at, s.t, level, level);
		apply(s.t, s.t + s.dur, level, s.to);
		level = s.to;
		at = s.t + s.dur;
	}
	apply(at, srcEnd, level, level);
}

// ---- 2. onto the film's clock: the same cuts and dissolves as the picture -----------------------
const total = frames(duration);
const bed = new Float32Array(total * 2);
const xf = frames(XFADE);
(segs as { a: number; b: number; out: number }[]).forEach((s, k) => {
	const a = frames(s.a);
	const n = frames(s.b - s.a);
	const at = frames(s.out);
	for (let i = 0; i < n; i++) {
		const j = at + i;
		if (j >= total) break;
		// Equal-power fades over the overlap with the stretches before and after.
		let g = 1;
		if (k > 0 && i < xf) g *= Math.sin((Math.PI / 2) * (i / xf));
		if (k < segs.length - 1 && i >= n - xf) g *= Math.cos((Math.PI / 2) * ((i - (n - xf)) / xf));
		bed[2 * j] += (music[2 * (a + i)] ?? 0) * g;
		bed[2 * j + 1] += (music[2 * (a + i) + 1] ?? 0) * g;
	}
});

// ---- 3. narration, and the bed lowered under it ---------------------------------------------------
const lines = log.says.map((s) => ({ id: s.id, out: toOut(segs, s.t), dur: voice.lines[s.id]?.dur ?? 0, file: voice.lines[s.id]?.file })).sort((a, b) => a.out - b.out);
for (let i = 0; i < lines.length; i++) {
	if (!lines[i].file) throw new Error("No voice for line " + lines[i].id);
	if (i > 0 && lines[i].out < lines[i - 1].out + lines[i - 1].dur - 0.05) throw new Error(`Lines ${lines[i - 1].id} and ${lines[i].id} overlap`);
	if (lines[i].out + lines[i].dur > duration) throw new Error(`Line ${lines[i].id} runs past the end`);
}
// Spans the bed stays down for: each line, joined across short gaps.
const spans: { a: number; b: number }[] = [];
for (const l of lines) {
	const last = spans[spans.length - 1];
	if (last && l.out - last.b < DUCK_HOLD) last.b = l.out + l.dur;
	else spans.push({ a: l.out, b: l.out + l.dur });
}
const env = new Float32Array(total).fill(1);
for (const s of spans) {
	const a = frames(s.a - DUCK_RAMP * 0.8);
	const b = frames(s.b + DUCK_RAMP * 0.6);
	const r = frames(DUCK_RAMP);
	for (let i = Math.max(0, a); i < Math.min(total, b + r); i++) {
		const down = Math.min(1, (i - a) / r);
		const up = Math.min(1, Math.max(0, (i - b) / r));
		const k = Math.min(down, 1 - up); // 0 = full, 1 = ducked
		const smooth = k * k * (3 - 2 * k);
		env[i] = Math.min(env[i], 1 - (1 - DUCK) * smooth);
	}
}
// ---- 3b. background music: the opening set carries on quietly under everything else -------------
// It is the app's own export of the set the film opens on, lined up with what the app played in
// the opening so it simply continues. It makes way whenever the app itself is heard.
const BED_FILE = path.join(DEMO, "bed", "saturday.wav");
const BED_GAP_LUFS = -27.5; // between lines
const BED_UNDER_DB = -7; // further down under the voice
const under = new Float32Array(total * 2);
if (fs.existsSync(BED_FILE) && !argv.includes("--no-bed")) {
	const mono = (file: string, rate: number, ss?: number, t?: number): Float32Array => {
		const o = execFileSync(FFMPEG, ["-v", "error", ...(ss !== undefined ? ["-ss", String(ss)] : []), ...(t !== undefined ? ["-t", String(t)] : []), "-i", file, "-ar", String(rate), "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 2 ** 31 - 1 });
		return new Float32Array(o.buffer, o.byteOffset, Math.floor(o.byteLength / 4));
	};
	// Where in the export the film's 5th second is: slide a few seconds of the opening along it.
	const R = 4000;
	const REF_AT = 5;
	const ref = new Float32Array(R * 4);
	for (let i = 0; i < ref.length; i++) {
		const j = Math.floor(((REF_AT + i / R) * RATE));
		ref[i] = ((bed[2 * j] ?? 0) + (bed[2 * j + 1] ?? 0)) / 2;
	}
	const SEARCH_FROM = 110;
	const hay = mono(BED_FILE, R, SEARCH_FROM, 60);
	let best = { lag: 0, score: -1 };
	let refE = 0;
	for (const v of ref) refE += v * v;
	for (let lag = 0; lag + ref.length < hay.length; lag++) {
		let dot = 0;
		let e = 0;
		for (let i = 0; i < ref.length; i += 2) {
			dot += ref[i] * hay[lag + i];
			e += hay[lag + i] * hay[lag + i];
		}
		const score = dot / Math.sqrt((refE / 2) * e + 1e-12);
		if (score > best.score) best = { lag, score };
	}
	const exportAt = SEARCH_FROM + best.lag / R - REF_AT; // the export's time at film time 0
	console.log(`[mix] background music lines up at ${exportAt.toFixed(2)}s of the export (match ${best.score.toFixed(2)})`);
	if (best.score < 0.5) throw new Error("The background music does not line up with the opening");
	const music2 = decode(BED_FILE, { ss: exportAt, t: duration + 1 });
	const level = Math.pow(10, (BED_GAP_LUFS - loudness(BED_FILE)) / 20);
	// Where the app itself is heard (opening, previews, playback, the ending): 50 ms blocks.
	const block = frames(0.05);
	const heard: boolean[] = [];
	for (let b = 0; b * block < total; b++) {
		let e = 0;
		for (let i = b * block; i < Math.min(total, (b + 1) * block); i++) e += bed[2 * i] * bed[2 * i];
		heard.push(Math.sqrt(e / block) > 0.003);
	}
	const wins: { a: number; b: number }[] = [];
	heard.forEach((h, b) => {
		if (!h) return;
		const t = b * 0.05;
		const last = wins[wins.length - 1];
		if (last && t - last.b < 2.5) last.b = t + 0.05;
		else wins.push({ a: t, b: t + 0.05 });
	});
	const keep = new Float32Array(total).fill(1);
	for (const w of wins) {
		const a0 = frames(w.a - 0.9);
		const a1 = frames(w.a - 0.3);
		const b0 = frames(w.b - 0.5);
		const b1 = frames(w.b + 1.3);
		for (let i = Math.max(0, a0); i < Math.min(total, b1); i++) {
			const g = i < a1 ? 1 - (i - a0) / (a1 - a0) : i < b0 ? 0 : (i - b0) / (b1 - b0);
			keep[i] = Math.min(keep[i], Math.max(0, Math.min(1, g)));
		}
	}
	const underVoice = Math.pow(10, BED_UNDER_DB / 20);
	for (let i = 0; i < total; i++) {
		const ducked = (1 - env[i]) / (1 - DUCK); // 0 = nobody talking, 1 = fully under the voice
		const k = keep[i] * keep[i] * (3 - 2 * keep[i]);
		const g = level * k * (1 - (1 - underVoice) * ducked);
		under[2 * i] = (music2[2 * i] ?? 0) * g;
		under[2 * i + 1] = (music2[2 * i + 1] ?? 0) * g;
	}
	console.log(`[mix] the app is heard ${wins.map((w) => `${w.a.toFixed(0)}-${w.b.toFixed(0)}s`).join(", ")}; background music fills the rest`);
}

// Opening and closing fades of the whole bed.
const mixed = new Float32Array(total * 2);
const outFade = frames(2.6);
for (let i = 0; i < total; i++) {
	const edge = Math.min(1, i / frames(0.5), (total - 1 - i) / outFade);
	const g = MUSIC_GAIN * env[i] * edge * edge;
	mixed[2 * i] = bed[2 * i] * g + under[2 * i] * edge;
	mixed[2 * i + 1] = bed[2 * i + 1] * g + under[2 * i + 1] * edge;
}
for (const l of lines) {
	const file = path.join(VOICE_DIR, l.file!);
	const gainDb = VOICE_LUFS - loudness(file);
	// A little shaping: rumble out, gentle levelling, a touch of presence.
	const v = decode(file, { af: `highpass=f=70,acompressor=threshold=-24dB:ratio=2.2:attack=6:release=140:makeup=1,equalizer=f=3600:t=q:w=1.2:g=1.2,volume=${gainDb.toFixed(2)}dB` });
	place(mixed, v, frames(l.out), 1, 0.004);
}

// ---- 4. level, limit, and join to the picture ------------------------------------------------------
const raw = path.join(take, "mix.f32");
fs.writeFileSync(raw, Buffer.from(mixed.buffer, mixed.byteOffset, mixed.byteLength));
const pre = path.join(take, "mix-pre.wav");
execFileSync(FFMPEG, ["-y", "-v", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", raw, "-c:a", "pcm_f32le", pre]);
fs.rmSync(raw);
const gain = FINAL_LUFS - loudness(pre);
const wav = path.join(take, "mix.wav");
execFileSync(FFMPEG, ["-y", "-v", "error", "-i", pre, "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.76:attack=4:release=60:level=disabled`, "-ar", String(RATE), "-c:a", "pcm_s24le", wav]);
fs.rmSync(pre);
const picture = path.join(take, flag("--picture") ?? "picture.mp4");
const out = path.join(take, flag("--out") ?? "final.mp4");
if (fs.existsSync(picture)) {
	execFileSync(FFMPEG, ["-y", "-v", "error", "-i", picture, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", out]);
	console.log(`[mix] ${out}`);
}
fs.writeFileSync(path.join(take, "lines.json"), JSON.stringify(lines.map((l) => ({ id: l.id, at: +l.out.toFixed(2), dur: +l.dur.toFixed(2) })), null, "\t"));
console.log(`[mix] ${duration.toFixed(1)}s, ${lines.length} lines, ${runs.length} preview(s), final ${loudness(wav).toFixed(1)} LUFS`);
