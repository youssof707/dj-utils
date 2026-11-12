// Playback. Every clip is one buffer source started at a fixed offset from a shared start
// time on the audio clock, so clips stay in sync by construction. There is no live
// stretching. Any change while playing throws the schedule away and rebuilds it.

import { LANES, SAMPLE_RATE } from "@shared/planner";
import { mediaFor } from "./media";
import { store } from "./store";

type Item = { id: string; lane: number; cachePath: string; start: number; offset: number; dur: number };

const LOOKAHEAD = 20; // seconds ahead of the playhead that get loaded and scheduled
const KEEP_BEHIND = 5;
const KEEP_AHEAD = 90;
const MAX_BUFFERS = 12;
const METRO_AHEAD = 0.5; // seconds of metronome clicks scheduled ahead (tick runs every 0.2 s)

// A short percussive tick: a burst of noise plus a fast-decaying high body, about 20 ms long,
// with its peak on the very first sample so the hit point is exact. The bar click is brighter.
function makeClick(accent: boolean): AudioBuffer {
	const len = Math.round(SAMPLE_RATE * 0.02);
	const buf = new AudioBuffer({ numberOfChannels: 1, length: len, sampleRate: SAMPLE_RATE });
	const d = buf.getChannelData(0);
	const f = accent ? 3200 : 2400;
	let seed = 12345;
	let peak = 0;
	for (let i = 0; i < len; i++) {
		const t = i / SAMPLE_RATE;
		seed = (seed * 1103515245 + 12345) >>> 0;
		const noise = (seed / 0xffffffff) * 2 - 1;
		d[i] = noise * Math.exp(-t / 0.0015) * 0.7 + Math.cos(2 * Math.PI * f * t) * Math.exp(-t / 0.004);
		peak = Math.max(peak, Math.abs(d[i]));
	}
	for (let i = 0; i < len; i++) d[i] /= peak;
	return buf;
}

function parseWav(bytes: Uint8Array): AudioBuffer {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = 12;
	let channels = 2;
	let bits = 32;
	let format = 3;
	while (pos + 8 <= bytes.byteLength) {
		const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
		let len = dv.getUint32(pos + 4, true);
		if (id === "fmt ") {
			format = dv.getUint16(pos + 8, true);
			channels = dv.getUint16(pos + 10, true);
			bits = dv.getUint16(pos + 22, true);
		} else if (id === "data") {
			const start = pos + 8;
			if (len === 0 || start + len > bytes.byteLength) len = bytes.byteLength - start;
			if (format !== 3 || bits !== 32) throw new Error("Unexpected cache format");
			const frames = Math.floor(len / (4 * channels));
			const buf = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, frames), sampleRate: SAMPLE_RATE });
			const l = buf.getChannelData(0);
			const r = buf.getChannelData(1);
			const c1 = channels > 1 ? 1 : 0;
			const abs = bytes.byteOffset + start;
			if (abs % 4 === 0) {
				const f = new Float32Array(bytes.buffer, abs, frames * channels);
				for (let i = 0, j = 0; i < frames; i++, j += channels) {
					l[i] = f[j];
					r[i] = f[j + c1];
				}
			} else {
				for (let i = 0; i < frames; i++) {
					l[i] = dv.getFloat32(start + i * channels * 4, true);
					r[i] = dv.getFloat32(start + (i * channels + c1) * 4, true);
				}
			}
			return buf;
		}
		pos += 8 + len + (len % 2);
	}
	throw new Error("Cache file has no audio");
}

class Engine {
	private ctx: AudioContext | null = null;
	private master: GainNode | null = null;
	private laneGains: GainNode[] = [];
	private metroGain: GainNode | null = null;
	private clicks = new Set<AudioBufferSourceNode>();
	private clickBufs: [AudioBuffer, AudioBuffer] | null = null; // [beat, bar]
	private metroNextBeat = 0; // next whole beat whose click hasn't been scheduled
	private buffers = new Map<string, AudioBuffer>();
	private loading = new Map<string, Promise<AudioBuffer | null>>();
	private sources = new Map<string, AudioBufferSourceNode>();
	private items: Item[] = [];
	private token = 0;
	private t0 = 0; // audio-clock time at which `startSec` is heard
	private startSec = 0;
	private endSec = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;
	tap: ((ctx: AudioContext, master: AudioNode) => void) | null = null;

	private context(): AudioContext {
		if (!this.ctx) {
			this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "playback" });
			// Overlapping tracks add up, so leave headroom and catch the rest with a limiter.
			const gain = new GainNode(this.ctx, { gain: 0.6 });
			const limiter = new DynamicsCompressorNode(this.ctx, { threshold: -2, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
			gain.connect(limiter).connect(this.ctx.destination);
			this.master = gain;
			const muted = store.get().laneMuted;
			this.laneGains = Array.from({ length: LANES }, (_, i) => {
				const g = new GainNode(this.ctx!, { gain: muted[i] ? 0 : 1 });
				g.connect(gain);
				return g;
			});
			// Clicks are always scheduled while playing; this gain turns them on and off live.
			// The click bypasses the music's headroom and limiter so it stays loud over a full mix.
			this.metroGain = new GainNode(this.ctx, { gain: store.get().metronome ? 1 : 0 });
			this.metroGain.connect(this.ctx.destination);
			this.clickBufs = [makeClick(false), makeClick(true)];
			if (this.tap) this.tap(this.ctx, limiter);
		}
		return this.ctx;
	}

	private secPerBeat(): number {
		return 60 / store.get().doc.bpm;
	}

	private buildItems(): Item[] {
		const { doc } = store.get();
		const spb = 60 / doc.bpm;
		const tracks = new Map(doc.tracks.map((t) => [t.id, t]));
		const out: Item[] = [];
		for (const c of doc.clips) {
			const m = mediaFor(tracks.get(c.trackId), doc.bpm);
			if (m?.state !== "ready") continue;
			const offset = c.offsetBeat * spb;
			const dur = Math.min(c.lengthBeat * spb, m.frames / SAMPLE_RATE - offset);
			if (dur <= 0) continue;
			out.push({ id: c.id, lane: c.lane, cachePath: m.cachePath, start: c.startBeat * spb, offset, dur });
		}
		return out;
	}

	private load(cachePath: string): Promise<AudioBuffer | null> {
		const have = this.buffers.get(cachePath);
		if (have) return Promise.resolve(have);
		const pending = this.loading.get(cachePath);
		if (pending) return pending;
		{
			const p = window.api
				.readAudio(cachePath)
				.then((bytes) => {
					const buf = parseWav(bytes);
					this.buffers.set(cachePath, buf);
					return buf;
				})
				.catch((e) => {
					console.error("Could not load audio", cachePath, e);
					return null;
				})
				.finally(() => this.loading.delete(cachePath));
			this.loading.set(cachePath, p);
			return p;
		}
	}

	private evict(nowSec: number, items: Item[]): void {
		if (this.buffers.size <= MAX_BUFFERS) return;
		const keep = new Set<string>();
		for (const it of items) if (it.start + it.dur > nowSec - KEEP_BEHIND && it.start < nowSec + KEEP_AHEAD) keep.add(it.cachePath);
		for (const key of this.buffers.keys()) {
			if (this.buffers.size <= MAX_BUFFERS) break;
			if (!keep.has(key)) this.buffers.delete(key);
		}
	}

	// Mute changes apply live with a short fade so nothing clicks.
	applyMutes(): void {
		if (!this.ctx) return;
		const muted = store.get().laneMuted;
		const now = this.ctx.currentTime;
		this.laneGains.forEach((g, i) => {
			g.gain.cancelScheduledValues(now);
			g.gain.setTargetAtTime(muted[i] ? 0 : 1, now, 0.005);
		});
	}

	applyMetronome(): void {
		if (!this.ctx || !this.metroGain) return;
		const now = this.ctx.currentTime;
		this.metroGain.gain.cancelScheduledValues(now);
		this.metroGain.gain.setTargetAtTime(store.get().metronome ? 1 : 0, now, 0.003);
	}

	// One click per beat, on the same audio clock as the clips, so a kick that sits on the grid
	// lands exactly on its click. Bar downbeats (every 4 beats from beat 0) are brighter.
	private scheduleClicks(now: number): void {
		const ctx = this.ctx!;
		const spb = this.secPerBeat();
		const until = (now + METRO_AHEAD) / spb;
		for (; this.metroNextBeat <= until; this.metroNextBeat++) {
			const b = this.metroNextBeat;
			const when = this.t0 + (b * spb - this.startSec);
			if (when < ctx.currentTime + 0.005) continue;
			const src = new AudioBufferSourceNode(ctx, { buffer: this.clickBufs![b % 4 === 0 ? 1 : 0] });
			src.connect(this.metroGain!);
			src.start(when);
			this.clicks.add(src);
			src.onended = () => {
				this.clicks.delete(src);
				src.disconnect();
			};
		}
	}

	// Current playhead in seconds of project time.
	positionSec(): number {
		if (!this.running || !this.ctx) return store.get().playheadBeat * this.secPerBeat();
		const latency = this.ctx.outputLatency || 0;
		return Math.max(this.startSec, this.startSec + (this.ctx.currentTime - latency - this.t0));
	}

	positionBeat(): number {
		return this.positionSec() / this.secPerBeat();
	}

	isPlaying(): boolean {
		return store.get().playing;
	}

	async play(): Promise<void> {
		const token = ++this.token;
		this.silence();
		const ctx = this.context();
		const from = store.get().playheadBeat * this.secPerBeat();
		this.items = this.buildItems();
		this.endSec = this.items.reduce((m, it) => Math.max(m, it.start + it.dur), 0);
		store.set({ playing: true });
		const first = this.items.filter((it) => it.start + it.dur > from && it.start < from + 2);
		await Promise.all([ctx.resume(), ...first.map((it) => this.load(it.cachePath))]);
		if (token !== this.token) return;
		this.startSec = from;
		this.t0 = ctx.currentTime + 0.08;
		this.running = true;
		this.metroNextBeat = Math.ceil(from / this.secPerBeat() - 1e-6);
		this.tick(token);
		this.timer = setInterval(() => this.tick(token), 200);
	}

	private tick(token: number): void {
		if (token !== this.token || !this.ctx || !this.master) return;
		const ctx = this.ctx;
		const now = this.startSec + (ctx.currentTime - this.t0);
		for (const it of this.items) {
			if (this.sources.has(it.id)) continue;
			if (it.start + it.dur <= now + 0.05 || it.start > now + LOOKAHEAD) continue;
			const buf = this.buffers.get(it.cachePath);
			if (!buf) {
				void this.load(it.cachePath).then((b) => {
					if (b) this.tick(token);
				});
				continue;
			}
			let when = this.t0 + (it.start - this.startSec);
			let offset = it.offset;
			let dur = it.dur;
			const earliest = ctx.currentTime + 0.03;
			if (when < earliest) {
				// Already under way: join in mid-clip, still locked to the shared clock.
				const late = earliest - when;
				when = earliest;
				offset += late;
				dur -= late;
			}
			if (dur <= 0) continue;
			const src = new AudioBufferSourceNode(ctx, { buffer: buf });
			src.connect(this.laneGains[it.lane] ?? this.master);
			src.start(when, offset, dur);
			this.sources.set(it.id, src);
		}
		this.scheduleClicks(now);
		this.evict(now, this.items);
		if (now > this.endSec + 0.3 && now > this.startSec + 0.3) {
			const endBeat = this.endSec / this.secPerBeat();
			this.stop(Math.max(endBeat, store.get().playheadBeat));
		}
	}

	private silence(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.running = false;
		for (const s of this.sources.values()) {
			try {
				s.stop();
			} catch {
				// not started yet
			}
			s.disconnect();
		}
		this.sources.clear();
		for (const c of this.clicks) {
			try {
				c.stop();
			} catch {
				// not started yet
			}
			c.disconnect();
		}
		this.clicks.clear();
	}

	stop(atBeat?: number): void {
		const beat = atBeat ?? this.positionBeat();
		this.token++;
		this.silence();
		store.set({ playing: false, playheadBeat: beat });
		this.warm();
	}

	toggle(): void {
		if (store.get().playing) this.stop();
		else {
			store.set({ cueBeat: store.get().playheadBeat });
			void this.play();
		}
	}

	// Jump back to where playback last started and play from there.
	cue(): void {
		const b = store.get().cueBeat;
		if (store.get().playing) {
			this.token++;
			this.silence();
		}
		store.set({ playheadBeat: b });
		void this.play();
	}

	seek(beat: number): void {
		const b = Math.max(0, beat);
		store.set({ cueBeat: b });
		if (store.get().playing) {
			this.token++;
			this.silence();
			store.set({ playheadBeat: b });
			void this.play();
		} else {
			store.set({ playheadBeat: b });
			this.warm();
		}
	}

	// The document or the available audio changed. Rebuild from where we are.
	refresh(): void {
		if (store.get().playing) {
			const beat = this.running ? this.positionBeat() : store.get().playheadBeat;
			this.token++;
			this.silence();
			store.set({ playheadBeat: beat });
			void this.play();
		} else {
			this.warm();
		}
	}

	// While stopped, load what sits under and just after the playhead so play starts at once.
	private warmTimer: ReturnType<typeof setTimeout> | undefined;
	warm(): void {
		clearTimeout(this.warmTimer);
		this.warmTimer = setTimeout(() => {
			if (store.get().playing) return;
			const from = store.get().playheadBeat * this.secPerBeat();
			const items = this.buildItems();
			for (const it of items) if (it.start + it.dur > from && it.start < from + LOOKAHEAD) void this.load(it.cachePath);
			this.evict(from, items);
		}, 150);
	}

	debug(): { buffers: number; sources: number; contextTime: number; state: string } {
		return { buffers: this.buffers.size, sources: this.sources.size, contextTime: this.ctx?.currentTime ?? 0, state: this.ctx?.state ?? "none" };
	}
}

export const engine = new Engine();
