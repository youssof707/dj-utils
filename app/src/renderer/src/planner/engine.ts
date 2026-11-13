// Playback. Every clip is played by buffer sources started at fixed offsets from a shared
// start time on the audio clock, so clips stay in sync by construction. There is no live
// stretching: a clip under a tempo change is played in pieces, each from a file rendered at
// the tempo of that part of the set (see media.ts). A document change while playing throws
// the schedule away and rebuilds it; newly ready audio is swapped in without a break.

import { fadeGain } from "@shared/fades";
import { clipPieces } from "@shared/pieces";
import { JOIN_FADE_SEC, LANES, LOW_CUT_EDGE_SEC, LOW_CUT_END_HZ, LOW_CUT_HZ, LOW_CUT_QS, SAMPLE_RATE } from "@shared/planner";
import type { TempoMap } from "@shared/tempo";
import { lostMedia, pieceSource, tempoMap } from "./media";
import { store } from "./store";

// One piece of a clip. Times are seconds on the set's clock, tempo changes included.
type Item = {
	id: string;
	lane: number;
	cachePath: string;
	start: number;
	dur: number;
	offset: number; // seconds into the file at `start`
	// How fast the file runs at the piece's start and end (it moves between them the way the
	// tempo does). 1 for a file rendered for this piece; otherwise a stand-in file is being
	// sped up or slowed down to fit.
	rateA: number;
	rateB: number;
	lead: number; // fades in over this long before `start`, across the join with the piece before
	fadeOut: number; // fades out over this long before its end, under the next piece's fade-in
	// The clip's volume fades, shared by all its pieces: the clip runs from `start` to `end`,
	// is at full volume from `inEnd` to `outStart`, and silent at both ends.
	fades: { start: number; inEnd: number; outStart: number; end: number } | null;
	// The clip's bass is muted: 0 for no, 1 for yes, 2 for yes on the clip's last piece, where
	// the bass comes back over the final moment (see LOW_CUT_EDGE_SEC).
	lowCut: 0 | 1 | 2;
};

// `fade` carries the clip's volume fade, after `gain` (joins and swaps), when the clip has one.
// `filters` take the bass out, before `gain`, when the clip's bass is muted.
type Voice = { src: AudioBufferSourceNode; filters: BiquadFilterNode[]; gain: GainNode; fade: GainNode | null; sig: string; endAt: number };

const sigOf = (it: Item): string => `${it.cachePath}|${it.start}|${it.dur}|${it.offset}|${it.rateA}|${it.rateB}|${it.lead}|${it.fadeOut}|${it.fades ? `${it.fades.start}|${it.fades.inEnd}|${it.fades.outStart}|${it.fades.end}` : ""}|${it.lowCut}`;

const FADE_IN_STEPS = 24; // straight pieces the fade-in curve is drawn with in playback
const SWAP_SEC = 0.03; // crossfade when a better rendering replaces one that is sounding
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
			// The decoder writes the extended header for some sources (AAC files); the real
			// format code is then further in.
			if (format === 0xfffe && len >= 26) format = dv.getUint16(pos + 8 + 24, true);
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
	private sources = new Map<string, Voice>();
	private map: TempoMap = tempoMap(store.get().doc); // the tempo curve of the schedule now playing
	private items: Item[] = [];
	private token = 0;
	private t0 = 0; // audio-clock time at which `startSec` is heard
	private startSec = 0;
	private endSec = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;
	// For tests: taps the music after the limiter, and the metronome on its own.
	tap: ((ctx: AudioContext, master: AudioNode, metronome: AudioNode) => void) | null = null;

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
			if (this.tap) this.tap(this.ctx, limiter, this.metroGain);
		}
		return this.ctx;
	}

	private buildItems(): Item[] {
		const { doc } = store.get();
		const map = tempoMap(doc);
		const tracks = new Map(doc.tracks.map((t) => [t.id, t]));
		const out: Item[] = [];
		for (const c of doc.clips) {
			const track = tracks.get(c.trackId);
			if (!track || c.muted) continue;
			let prev: Item | null = null;
			let last: Item | null = null;
			const end = c.startBeat + c.lengthBeat;
			const fades = c.fadeInBeat || c.fadeOutBeat ? { start: map.secondsAtBeat(c.startBeat), inEnd: map.secondsAtBeat(c.startBeat + (c.fadeInBeat ?? 0)), outStart: map.secondsAtBeat(end - (c.fadeOutBeat ?? 0)), end: map.secondsAtBeat(end) } : null;
			clipPieces(c, track, map).forEach((p, i) => {
				const src = pieceSource(track, p);
				const start = map.secondsAtBeat(p.fromBeat);
				let dur = map.secondsAtBeat(p.toBeat) - start;
				const before = prev;
				prev = null;
				if (!src) return;
				let offset: number;
				let rateA = 1;
				let rateB = 1;
				let room: number; // seconds of audio in the file before the piece
				if (src.exact) {
					offset = src.offsetSec;
					room = src.leadSec;
					dur = Math.min(dur, src.frames / SAMPLE_RATE - offset);
				} else {
					offset = (p.trackBeat * 60) / src.fileBpm;
					rateA = p.bpmA / src.fileBpm;
					rateB = p.bpmB / src.fileBpm;
					room = offset / rateA;
				}
				if (dur <= 0) return;
				const lead = before ? Math.max(0, Math.min(JOIN_FADE_SEC, room, before.dur)) : 0;
				if (before) before.fadeOut = lead;
				const item: Item = { id: `${c.id}:${i}`, lane: c.lane, cachePath: src.cachePath, start, dur, offset, rateA, rateB, lead, fadeOut: 0, fades, lowCut: c.lowCut ? 1 : 0 };
				out.push(item);
				prev = item;
				last = item;
			});
			if (last && c.lowCut) (last as Item).lowCut = 2;
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
					lostMedia([cachePath]);
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
		const until = this.map.beatAtSeconds(now + METRO_AHEAD);
		for (; this.metroNextBeat <= until; this.metroNextBeat++) {
			const b = this.metroNextBeat;
			const when = this.t0 + (this.map.secondsAtBeat(b) - this.startSec);
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

	// Current playhead in seconds on the set's clock.
	private positionSec(): number {
		const latency = this.ctx!.outputLatency || 0;
		return Math.max(this.startSec, this.startSec + (this.ctx!.currentTime - latency - this.t0));
	}

	positionBeat(): number {
		if (!this.running || !this.ctx) return store.get().playheadBeat;
		return this.map.beatAtSeconds(this.positionSec());
	}

	isPlaying(): boolean {
		return store.get().playing;
	}

	// The audio context and a cached file's audio, for the track editor's preview, and a hook
	// it sets so that its preview stops when the set starts playing.
	onPlay: (() => void) | null = null;
	audio(): AudioContext {
		return this.context();
	}
	buffer(cachePath: string): Promise<AudioBuffer | null> {
		return this.load(cachePath);
	}

	async play(): Promise<void> {
		this.onPlay?.();
		const token = ++this.token;
		this.silence();
		const ctx = this.context();
		const map = tempoMap(store.get().doc);
		const from = map.secondsAtBeat(store.get().playheadBeat);
		this.items = this.buildItems();
		this.endSec = this.items.reduce((m, it) => Math.max(m, it.start + it.dur), 0);
		store.set({ playing: true });
		const first = this.items.filter((it) => it.start + it.dur > from && it.start < from + 2);
		await Promise.all([ctx.resume(), ...first.map((it) => this.load(it.cachePath))]);
		if (token !== this.token) return;
		this.map = map;
		this.startSec = from;
		this.t0 = ctx.currentTime + 0.08;
		this.running = true;
		this.metroNextBeat = Math.ceil(map.beatAtSeconds(from) - 1e-6);
		this.tick(token);
		this.timer = setInterval(() => this.tick(token), 200);
	}

	// Starts one piece no earlier than `earliest` on the audio clock: from its beginning if
	// that is still ahead, otherwise part-way in, still locked to the shared clock.
	private launch(it: Item, buf: AudioBuffer, earliest: number, swapIn: boolean): Voice | null {
		const ctx = this.ctx!;
		const startAt = this.t0 + (it.start - this.startSec);
		const endAt = startAt + it.dur;
		let when = Math.max(startAt - it.lead, earliest);
		if (when >= endAt - 0.002) return null;
		const late = when > startAt - it.lead;
		// The file's speed follows the tempo, which moves exponentially in time along a ramp.
		const g = it.rateA !== it.rateB ? Math.log(it.rateB / it.rateA) / it.dur : 0;
		const rel = when - startAt;
		let offset = it.offset + (rel <= 0 || g === 0 ? rel * it.rateA : (it.rateA * Math.expm1(g * rel)) / g);
		if (offset < 0) {
			when += -offset / it.rateA;
			offset = 0;
		}
		const src = new AudioBufferSourceNode(ctx, { buffer: buf });
		if (it.rateA !== 1 || it.rateB !== 1) {
			const now = rel <= 0 ? it.rateA : it.rateA * Math.exp(g * rel);
			src.playbackRate.value = now;
			src.playbackRate.setValueAtTime(now, Math.max(when, startAt));
			if (g !== 0) src.playbackRate.exponentialRampToValueAtTime(it.rateB, endAt);
		}
		const gain = new GainNode(ctx, { gain: 1 });
		const fadedIn = late ? (swapIn ? when + SWAP_SEC : when) : startAt;
		if (fadedIn > when) {
			gain.gain.setValueAtTime(0, when);
			gain.gain.linearRampToValueAtTime(1, fadedIn);
		}
		const fadeFrom = Math.max(fadedIn, endAt - it.fadeOut);
		if (fadeFrom < endAt) {
			gain.gain.setValueAtTime(1, fadeFrom);
			gain.gain.linearRampToValueAtTime(0, endAt);
		}
		// The clip's volume fade, picked up wherever this piece starts sounding. The fade-in's
		// curve is followed in short straight steps.
		let fade: GainNode | null = null;
		const f = it.fades;
		if (f) {
			const clock = (sec: number): number => this.t0 + (sec - this.startSec);
			const level = (at: number): number => fadeGain(at - clock(f.start), f.end - f.start, f.inEnd - f.start, f.end - f.outStart);
			fade = new GainNode(ctx, { gain: level(when) });
			fade.gain.setValueAtTime(level(when), when);
			const steps = Array.from({ length: FADE_IN_STEPS }, (_, k) => clock(f.start + ((f.inEnd - f.start) * (k + 1)) / FADE_IN_STEPS));
			for (const at of [...steps, clock(f.outStart), endAt]) {
				if (at > when && at <= endAt) fade.gain.linearRampToValueAtTime(level(at), at);
			}
			gain.connect(fade);
		}
		// A bass-muted clip goes through the low cut first. Web Audio takes a high-pass's Q in dB.
		const filters = it.lowCut ? LOW_CUT_QS.map((q) => new BiquadFilterNode(ctx, { type: "highpass", frequency: LOW_CUT_HZ, Q: 20 * Math.log10(q) })) : [];
		let tail: AudioNode = src;
		for (const flt of filters) {
			if (it.lowCut === 2) {
				flt.frequency.setValueAtTime(LOW_CUT_HZ, Math.max(when, endAt - LOW_CUT_EDGE_SEC));
				flt.frequency.exponentialRampToValueAtTime(LOW_CUT_END_HZ, endAt);
			}
			tail.connect(flt);
			tail = flt;
		}
		tail.connect(gain);
		(fade ?? gain).connect(this.laneGains[it.lane] ?? this.master!);
		src.start(when, offset);
		src.stop(endAt);
		return { src, filters, gain, fade, sig: sigOf(it), endAt };
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
			const v = this.launch(it, buf, ctx.currentTime + 0.03, false);
			if (v) this.sources.set(it.id, v);
		}
		this.scheduleClicks(now);
		this.evict(now, this.items);
		if (now > this.endSec + 0.3 && now > this.startSec + 0.3) {
			const endBeat = this.map.beatAtSeconds(this.endSec);
			this.stop(Math.max(endBeat, store.get().playheadBeat));
		}
	}

	private drop(v: Voice): void {
		try {
			v.src.stop();
		} catch {
			// not started yet
		}
		v.src.disconnect();
		for (const flt of v.filters) flt.disconnect();
		v.gain.disconnect();
		v.fade?.disconnect();
	}

	private silence(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.running = false;
		for (const v of this.sources.values()) this.drop(v);
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

	// Audio became ready (or failed) and the document is as it was. Pieces that have not
	// started yet simply use what is there now. A piece that is sounding and now has a better
	// file is crossfaded over to it, once that file is loaded, at the same place in the music.
	refreshMedia(): void {
		if (!store.get().playing) {
			this.warm();
			return;
		}
		if (!this.running || !this.ctx) {
			this.refresh();
			return;
		}
		const ctx = this.ctx;
		const token = this.token;
		this.items = this.buildItems();
		this.endSec = this.items.reduce((m, it) => Math.max(m, it.start + it.dur), 0);
		const byId = new Map(this.items.map((it) => [it.id, it]));
		for (const [id, old] of this.sources) {
			const it = byId.get(id);
			if (it && sigOf(it) === old.sig) continue;
			if (!it) {
				this.drop(old);
				this.sources.delete(id);
				continue;
			}
			if (old.endAt < ctx.currentTime + 0.1) continue; // all but over
			void this.load(it.cachePath).then((buf) => {
				// Only if nothing else has changed this piece meanwhile.
				if (!buf || token !== this.token || this.sources.get(id) !== old || this.items.find((x) => x.id === id) !== it) return;
				const at = ctx.currentTime + 0.05;
				const v = this.launch(it, buf, at, true);
				if (!v) return;
				old.gain.gain.cancelAndHoldAtTime(at);
				old.gain.gain.linearRampToValueAtTime(0, at + SWAP_SEC);
				old.src.stop(at + SWAP_SEC);
				old.src.onended = () => {
					old.src.disconnect();
					for (const flt of old.filters) flt.disconnect();
					old.gain.disconnect();
					old.fade?.disconnect();
				};
				this.sources.set(id, v);
			});
		}
		this.tick(token);
	}

	// While stopped, load what sits under and just after the playhead so play starts at once.
	private warmTimer: ReturnType<typeof setTimeout> | undefined;
	warm(): void {
		clearTimeout(this.warmTimer);
		this.warmTimer = setTimeout(() => {
			if (store.get().playing) return;
			const from = tempoMap(store.get().doc).secondsAtBeat(store.get().playheadBeat);
			const items = this.buildItems();
			for (const it of items) if (it.start + it.dur > from && it.start < from + LOOKAHEAD) void this.load(it.cachePath);
			this.evict(from, items);
		}, 150);
	}

	// Lets go of the audio held for the set that was open.
	forget(): void {
		this.buffers.clear();
	}

	debug(): { buffers: number; sources: number; contextTime: number; state: string } {
		return { buffers: this.buffers.size, sources: this.sources.size, contextTime: this.ctx?.currentTime ?? 0, state: this.ctx?.state ?? "none" };
	}
}

export const engine = new Engine();
