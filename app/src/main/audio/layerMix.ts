// Where layers of an edit play at once, their sum is brought back to the level of the loudest
// of them and kept under the ceiling, rather than added up and clipped. A club master sits near
// full scale, so two of them together are up to 6 dB over it. The pieces, in the order the
// samples go through them:
//
// - KWeight: the loudness filter of ITU-R BS.1770, so levels are compared as they are heard.
// - LevelMeter and Leveler: how loud each layer and the mix are over a few seconds, and the gain
//   that makes the mix no louder than its loudest layer. It follows the music slowly, so it
//   never pumps, and moves with a layer's own fade where one comes in or goes out.
// - TruePeakLimiter: takes what is left over the ceiling off the peaks, measured between the
//   samples too (4x oversampled), with a few milliseconds of look-ahead and no delay.
// - Tpdf: dither for a 16-bit result, from a seeded generator so an export is reproducible.
//
// Everything works on interleaved float frames in the file's own integer scale.

// --- Loudness filter -----------------------------------------------------------------------

// The two stages of BS.1770's K-weighting (a high shelf for the head, a high pass for the low
// end), worked out for any sample rate as libebur128 does.
function kCoefs(rate: number): number[][] {
	let f0 = 1681.974450955533;
	const gain = 3.999843853973347;
	let q = 0.7071752369554196;
	let k = Math.tan((Math.PI * f0) / rate);
	const vh = 10 ** (gain / 20);
	const vb = vh ** 0.4996667741545416;
	let a0 = 1 + k / q + k * k;
	const shelf = [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0];
	f0 = 38.13547087602444;
	q = 0.5003270373238773;
	k = Math.tan((Math.PI * f0) / rate);
	a0 = 1 + k / q + k * k;
	const high = [1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0];
	return [shelf, high];
}

export class KWeight {
	private c: number[][];
	private s: Float64Array;
	constructor(
		rate: number,
		private channels: number,
	) {
		this.c = kCoefs(rate);
		this.s = new Float64Array(channels * 4);
	}
	// Filters `frames` interleaved frames in place, carrying on from the last call.
	run(data: Float64Array, frames: number): void {
		const [[b0, b1, b2, a1, a2], [c0, c1, c2, d1, d2]] = this.c;
		const n = this.channels;
		const s = this.s;
		for (let c = 0; c < n; c++) {
			let x1 = s[c * 4];
			let x2 = s[c * 4 + 1];
			let y1 = s[c * 4 + 2];
			let y2 = s[c * 4 + 3];
			// Direct form II for each stage: two delay values each.
			for (let i = c; i < frames * n; i += n) {
				const w = data[i] - a1 * x1 - a2 * x2;
				const u = b0 * w + b1 * x1 + b2 * x2;
				x2 = x1;
				x1 = w;
				const v = u - d1 * y1 - d2 * y2;
				data[i] = c0 * v + c1 * y1 + c2 * y2;
				y2 = y1;
				y1 = v;
			}
			s[c * 4] = x1;
			s[c * 4 + 1] = x2;
			s[c * 4 + 2] = y1;
			s[c * 4 + 3] = y2;
		}
	}
}

// --- Leveler -------------------------------------------------------------------------------

// How long the leveler listens, around each moment, to decide how loud things are. Long enough
// that it follows phrases rather than beats, so the gain never moves with the kick.
export const LEVEL_WINDOW_SEC = 3;
// The leveler never turns the mix down by more than this, however many layers there are.
export const LEVEL_FLOOR = 10 ** (-12 / 20);
// Powers are summed in blocks of this many frames before they are smoothed.
const HOP = 512;

// Collects, block by block, the K-weighted power of each layer and of each pair of layers
// together (their sum's power is made of these), over a stretch of `frames` frames. A layer
// plays over [from, to) of it; a pair's measure only covers the frames where both play.
export class LevelMeter {
	readonly n: number;
	private blocks: number;
	private sums: Float64Array[];
	private counts: Float64Array[];
	constructor(
		private spans: { from: number; to: number }[],
		frames: number,
	) {
		this.n = spans.length;
		this.blocks = Math.max(1, Math.ceil(frames / HOP));
		const pairs = (this.n * (this.n + 1)) / 2;
		this.sums = Array.from({ length: pairs }, () => new Float64Array(this.blocks));
		this.counts = Array.from({ length: pairs }, () => new Float64Array(this.blocks));
		for (let i = 0, p = 0; i < this.n; i++)
			for (let j = i; j < this.n; j++, p++) {
				const from = Math.max(spans[i].from, spans[j].from);
				const to = Math.min(spans[i].to, spans[j].to);
				for (let f = from; f < to; ) {
					const b = Math.floor(f / HOP);
					const e = Math.min(to, (b + 1) * HOP);
					this.counts[p][b] += e - f;
					f = e;
				}
			}
	}
	// The K-weighted audio of every layer (zero where one does not play) for frames
	// [at, at + count) of the stretch, `channels` to a frame.
	add(k: Float64Array[], channels: number, at: number, count: number): void {
		for (let i = 0, p = 0; i < this.n; i++)
			for (let j = i; j < this.n; j++, p++) {
				const from = Math.max(at, this.spans[i].from, this.spans[j].from);
				const to = Math.min(at + count, this.spans[i].to, this.spans[j].to);
				const a = k[i];
				const b = k[j];
				const sum = this.sums[p];
				for (let f = from; f < to; ) {
					const blk = Math.floor(f / HOP);
					const e = Math.min(to, (blk + 1) * HOP);
					let acc = 0;
					for (let x = (f - at) * channels, end = (e - at) * channels; x < end; x++) acc += a[x] * b[x];
					sum[blk] += acc;
					f = e;
				}
			}
	}
	// The powers smoothed over a Hann window `windowSec` long (Infinity: one average over each
	// pair's whole span), centred on each moment, so it looks ahead as far as it looks back. A
	// window running past where a pair plays only counts the frames it does play.
	leveler(rate: number, windowSec = LEVEL_WINDOW_SEC): Leveler {
		const half = Number.isFinite(windowSec) ? Math.max(1, Math.round((windowSec * rate) / HOP / 2)) : Infinity;
		const win = Number.isFinite(half) ? Float64Array.from({ length: 2 * half + 1 }, (_, k) => 0.5 + 0.5 * Math.cos((Math.PI * (k - half)) / (half + 1))) : null;
		const smooth = this.sums.map((sum, p) => {
			const count = this.counts[p];
			const out = new Float64Array(this.blocks);
			if (!win) {
				let s = 0;
				let c = 0;
				for (let b = 0; b < this.blocks; b++) {
					s += sum[b];
					c += count[b];
				}
				out.fill(c > 0 ? s / c : 0);
				return out;
			}
			for (let b = 0; b < this.blocks; b++) {
				let s = 0;
				let c = 0;
				const lo = Math.max(0, b - half);
				const hi = Math.min(this.blocks - 1, b + half);
				for (let k = lo; k <= hi; k++) {
					const h = win[k - b + half];
					s += h * sum[k];
					c += h * count[k];
				}
				out[b] = c > 0 ? s / c : 0;
			}
			return out;
		});
		return new Leveler(this.n, smooth, this.blocks);
	}
}

// The gain for the mix at any frame, from the smoothed powers and how far in each layer is.
export class Leveler {
	private m: Float64Array;
	private w: Float64Array;
	// Gains at the middles of the blocks for each set of layers fully in (all weights 0 or 1),
	// worked out as they are first needed.
	private steady = new Map<number, Float64Array>();
	constructor(
		private n: number,
		private smooth: Float64Array[],
		private blocks: number,
	) {
		this.m = new Float64Array(n * n);
		this.w = new Float64Array(n);
	}
	// `w[i]`: how far layer i is in at `frame` (its fade weight; 0 where it does not play).
	gain(frame: number, w: ArrayLike<number>): number {
		// Linear between the middles of the blocks, so the powers have no steps.
		const x = Math.min(this.blocks - 1, Math.max(0, frame / HOP - 0.5));
		const b = Math.floor(x);
		const t = x - b;
		const b2 = Math.min(this.blocks - 1, b + 1);
		let mask = 0;
		for (let i = 0; i < this.n; i++) {
			if (w[i] === 1) mask |= 1 << i;
			else if (w[i] !== 0) mask = -1;
			if (mask < 0) break;
		}
		if (mask >= 0 && this.n <= 30) {
			// No layer part-way in or out: the gain moves as slowly as the powers do, so it is
			// worked out at the middles of the blocks and drawn straight between them.
			let at = this.steady.get(mask);
			if (!at) this.steady.set(mask, (at = new Float64Array(this.blocks).fill(NaN)));
			for (let i = 0; i < this.n; i++) this.w[i] = (mask >> i) & 1;
			if (Number.isNaN(at[b])) at[b] = this.at(b, b, 0, this.w);
			if (Number.isNaN(at[b2])) at[b2] = this.at(b2, b2, 0, this.w);
			return at[b] === at[b2] ? at[b] : at[b] + (at[b2] - at[b]) * t;
		}
		return this.at(b, b2, t, w);
	}
	private at(b: number, b2: number, t: number, w: ArrayLike<number>): number {
		const m = this.m;
		const n = this.n;
		for (let i = 0, p = 0; i < n; i++)
			for (let j = i; j < n; j++, p++) {
				const s = this.smooth[p];
				m[i * n + j] = m[j * n + i] = s[b] + (s[b2] - s[b]) * t;
			}
		return levelGain(m, n, w);
	}
}

// The gain that makes a mix no louder than its loudest layer, from the layers' powers and
// cross powers `m` (an n x n matrix, row by row) and their fade weights `w`. The mix's power is
// the sum of w_i w_j m_ij. A layer part-way into its fade counts as w_i m_ii, in proportion to
// how far in it is: a track fading in over its own double then comes out as just the track,
// and a plain crossfade between two unrelated tracks is left alone. Never above 1 (the
// leveler only turns down) nor below LEVEL_FLOOR.
export function levelGain(m: ArrayLike<number>, n: number, w: ArrayLike<number>): number {
	let mix = 0;
	let loudest = 0;
	for (let i = 0; i < n; i++) {
		const wi = w[i];
		if (wi === 0) continue;
		const own = m[i * n + i];
		if (wi * own > loudest) loudest = wi * own;
		mix += wi * wi * own;
		for (let j = i + 1; j < n; j++) if (w[j] !== 0) mix += 2 * wi * w[j] * m[i * n + j];
	}
	if (!(mix > 0) || mix <= loudest) return 1;
	return Math.max(LEVEL_FLOOR, Math.sqrt(loudest / mix));
}

// --- True-peak limiter ---------------------------------------------------------------------

// The ceiling the mix is kept under, in dB of full scale, between samples as well as on them:
// the layers' own highest true peak, kept between these. Loud masters peak over full scale
// between samples; the mix may too, as far as they do, so a doubled part comes out as its
// track rather than squeezed under it. The samples themselves stay inside full scale.
export const CEILING_MIN_DB = -1;
export const CEILING_MAX_DB = 3;
// How long before a peak the gain starts to come down, all told; the gain moves smoothly
// over this, so the turning down has no edge to it. It is a peak limiter: the leveler in front
// of it already sets the level, so it only has to catch peaks, and let go of them quickly.
export const LOOKAHEAD_SEC = 0.003;
// How long the gain is held after a peak before it starts to come back: just under half a cycle
// of 40 Hz, so a low note is turned down evenly over its cycle rather than within it, which is
// what distorts bass (a 40-60 Hz sine 3-6 dB over: 0.02% THD with this, 0.3-2.3% with 4 ms).
export const HOLD_SEC = 0.012;
// How quickly the gain comes back after a peak: fast after a lone peak, so the level between
// kicks is kept, and slower the longer the limiter has been working, so a run of peaks is not
// followed by pumping.
export const RELEASE_FAST_SEC = 0.02;
export const RELEASE_SLOW_SEC = 0.08;
// How long it takes to count as "working for a while".
const SUSTAIN_SEC = 1;
// Peaks within this of the held gain count as the same peak again, so they keep it held.
const HOLD_TOLERANCE = 10 ** (0.1 / 20);
// Aimed this far under a fixed ceiling: 4x oversampling with a filter this short can read the
// top of a peak between samples up to about a tenth of a dB low (measured against 24 and 64
// taps). A ceiling that is the layers' own peak, measured with the same filter, needs none: a
// mix no hotter than its layers then goes through untouched.
const MARGIN = 10 ** (-0.15 / 20);
// Points within this (relative) of the ceiling count as at it, not over it: a track over its
// own double, levelled, can come out a rounding error above the track.
const SAME = 1 + 1e-9;

// 4x oversampling: windowed-sinc interpolation at a quarter, a half and three quarters of the
// way to the next sample, from TAPS samples either side.
const TAPS = 16;
const PHASES = (() => {
	const bessel = (x: number): number => {
		let s = 1;
		let t = 1;
		for (let k = 1; k < 30; k++) {
			t *= (x / (2 * k)) ** 2;
			s += t;
		}
		return s;
	};
	const beta = 7;
	return [1, 2, 3].map((j) => {
		const c = new Float64Array(2 * TAPS);
		let sum = 0;
		// Coefficient k is for the sample k - TAPS + 1 frames from the earlier of the two.
		for (let k = 0; k < 2 * TAPS; k++) {
			const t = j / 4 - (k - TAPS + 1);
			const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
			const r = t / (TAPS + 0.5);
			c[k] = sinc * (bessel(beta * Math.sqrt(Math.max(0, 1 - r * r))) / bessel(beta));
			sum += c[k];
		}
		for (let k = 0; k < 2 * TAPS; k++) c[k] /= sum;
		return c;
	});
})();
// How far above the samples around it an interpolated point can reach: below the ceiling
// divided by this, there is nothing to look for between samples.
const OVERSHOOT = Math.max(...PHASES.map((c) => c.reduce((s, x) => s + Math.abs(x), 0)));

export type LimiterStats = { frames: number; active: number; maxDb: number; sumDb: number };
export type LimiterOptions = {
	// Frames in the stretch, and the frames at its start and end over which its gain is eased
	// back to exactly 1, to meet the audio either side of it with no step.
	frames: number;
	fadeIn?: number;
	fadeOut?: number;
	lookaheadSec?: number;
	holdSec?: number;
	releaseFastSec?: number;
	releaseSlowSec?: number;
	// A ceiling for the samples themselves, under the true-peak one: full scale, when the
	// true-peak ceiling is above it. Samples need no estimate, so it gets no margin.
	sampleCeiling?: number;
	// The same below zero (one step further down, as whole numbers go), if it differs.
	sampleFloor?: number;
	// The true-peak ceiling is the layers' own measured peak (no margin), not a fixed one.
	measured?: boolean;
};

// A stereo-linked (all channels together) look-ahead limiter. It sees each frame
// `latency` frames after it is pushed, but hands it back with its gain at the same place in
// time, so the result lines up sample for sample with what was pushed. Under the ceiling it
// leaves the samples exactly as they were.
export class TruePeakLimiter {
	readonly latency: number;
	readonly stats: LimiterStats = { frames: 0, active: 0, maxDb: 0, sumDb: 0 };
	private ch: number;
	private ceiling: number;
	private sampleCeiling: number;
	private sampleFloor: number;
	private mask: number;
	private y: Float64Array; // the pushed audio
	private peak: Float64Array; // per frame: the largest sample, over the channels
	private low: Float64Array; // per frame: how far below zero the lowest sample goes
	private between: Float64Array; // per frame: the largest point between it and the next
	private need: Float64Array; // per frame: the gain it needs on its own
	private half: number;
	// The sliding minimum reaches TAPS further than the smoothing either side, so the gain is
	// flat over all the samples the points between them are worked out from: the peak between
	// samples is then turned down exactly as far as it was measured to need.
	private minHalf: number;
	private hold: number;
	private fast: number;
	private slow: number;
	private sustainRate: number;
	private frames: number;
	private fadeIn: number;
	private fadeOut: number;
	private pushed = 0;
	private real = Infinity;
	private out = 0;
	private lastBig = -Infinity;
	// The sliding minimum of `need` over 2 * minHalf + 1 frames, as a queue of frame numbers.
	private dq: Int32Array;
	private dqHead = 0;
	private dqTail = 0;
	private gain = 1;
	private holding = 0;
	private sustain = 0;
	// Two running means over half + 1 frames, one after the other, of how much the gain is
	// turned down: together a triangle of 2 * half + 1 frames. Counts of non-zero values keep
	// the means at exactly 0 once the limiter is idle again.
	private box1: Float64Array;
	private box2: Float64Array;
	private sum1 = 0;
	private sum2 = 0;
	private nz1 = 0;
	private nz2 = 0;
	private at1 = 0;
	private at2 = 0;
	private emitBuf: Float64Array;
	private emitCount = 0;
	constructor(rate: number, channels: number, ceiling: number, opts: LimiterOptions) {
		this.ch = channels;
		this.ceiling = opts.measured ? ceiling * SAME : ceiling * MARGIN;
		this.sampleCeiling = opts.sampleCeiling ?? Infinity;
		this.sampleFloor = opts.sampleFloor ?? this.sampleCeiling;
		this.half = Math.max(1, Math.round(((opts.lookaheadSec ?? LOOKAHEAD_SEC) * rate) / 2));
		this.hold = Math.round((opts.holdSec ?? HOLD_SEC) * rate);
		this.fast = 1 - Math.exp(-1 / ((opts.releaseFastSec ?? RELEASE_FAST_SEC) * rate));
		this.slow = 1 - Math.exp(-1 / ((opts.releaseSlowSec ?? RELEASE_SLOW_SEC) * rate));
		this.sustainRate = 1 - Math.exp(-1 / (SUSTAIN_SEC * rate));
		this.frames = opts.frames;
		this.fadeIn = opts.fadeIn ?? 0;
		this.fadeOut = opts.fadeOut ?? 0;
		this.minHalf = this.half + TAPS;
		this.latency = TAPS + this.minHalf + this.half;
		let size = 1;
		while (size < this.latency + 2 * TAPS + 4) size *= 2;
		this.mask = size - 1;
		this.y = new Float64Array(size * channels);
		this.peak = new Float64Array(size);
		this.low = new Float64Array(size);
		this.between = new Float64Array(size);
		this.need = new Float64Array(size).fill(1);
		this.dq = new Int32Array(size);
		this.box1 = new Float64Array(this.half + 1);
		this.box2 = new Float64Array(this.half + 1);
		this.emitBuf = new Float64Array(4096 * channels);
	}

	// Pushes `count` interleaved frames; finished frames go to `emit` (which must use them
	// before it returns), in order, with their gain applied.
	push(input: Float64Array, count: number, emit: (out: Float64Array, frames: number) => void): void {
		for (let i = 0; i < count; i++) this.step(input, i * this.ch, emit);
		this.flushEmit(emit);
	}

	// Hands back the last `latency` frames.
	finish(emit: (out: Float64Array, frames: number) => void): void {
		const zero = new Float64Array(this.ch);
		this.real = this.pushed;
		while (this.out < this.real) this.step(zero, 0, emit);
		this.flushEmit(emit);
	}

	private step(input: Float64Array, off: number, emit: (out: Float64Array, frames: number) => void): void {
		const ch = this.ch;
		const mask = this.mask;
		const n = this.pushed++;
		const slot = n & mask;
		let a = 0;
		let up = 0;
		let down = 0;
		for (let c = 0; c < ch; c++) {
			const v = input[off + c];
			this.y[slot * ch + c] = v;
			if (v > up) up = v;
			else if (-v > down) down = -v;
		}
		a = up > down ? up : down;
		this.peak[slot] = a;
		this.low[slot] = down;
		if (a * OVERSHOOT > this.ceiling) this.lastBig = n;

		// Between frame p and the next: needs up to frame p + TAPS.
		const p = n - TAPS;
		if (p >= -TAPS) {
			let b = 0;
			if (this.lastBig >= p - TAPS + 1) {
				// Frames before the first are still zero in the ring, as nothing has been written there.
				const y = this.y;
				const first = p - TAPS + 1;
				for (let c = 0; c < ch; c++)
					for (let j = 0; j < 3; j++) {
						const coef = PHASES[j];
						let s = 0;
						for (let k = 0; k < 2 * TAPS; k++) s += coef[k] * y[((first + k) & mask) * ch + c];
						const av = s < 0 ? -s : s;
						if (av > b) b = av;
					}
			}
			this.between[p & mask] = b;
			if (p >= 0) {
				const top = Math.max(this.peak[p & mask], b, p > 0 ? this.between[(p - 1) & mask] : 0);
				let need = top > this.ceiling ? this.ceiling / top : 1;
				// The samples: whole steps reach one further below zero than above it.
				const lowest = this.low[p & mask];
				const highest = this.peak[p & mask] === lowest ? 0 : this.peak[p & mask];
				if (highest > this.sampleCeiling * SAME && this.sampleCeiling / highest < need) need = this.sampleCeiling / highest;
				if (lowest > this.sampleFloor * SAME && this.sampleFloor / lowest < need) need = this.sampleFloor / lowest;
				this.need[p & mask] = need;
				this.minPush(p);
			}
		}

		// The sliding minimum around frame q, then hold and release.
		const q = n - TAPS - this.minHalf;
		if (q >= 0) {
			while (this.dqHead !== this.dqTail && this.dq[this.dqHead & mask] < q - this.minHalf) this.dqHead++;
			const m = this.need[this.dq[this.dqHead & mask] & mask];
			let g = this.gain;
			if (m <= g * HOLD_TOLERANCE) {
				if (m < g) g = m;
				this.holding = this.hold;
			} else if (this.holding > 0) this.holding--;
			else {
				g += (1 - g) * (this.fast + (this.slow - this.fast) * this.sustain);
				if (g > m) g = m;
			}
			this.gain = g;
			this.sustain += ((g < 0.97 ? 1 : 0) - this.sustain) * this.sustainRate;
			this.smooth(1 - g);
		}

		// The smoothed gain for frame r is ready once frame r + half has been held.
		const r = n - this.latency;
		if (r >= 0 && r < this.real) {
			let g = this.nz2 === 0 ? 1 : 1 - this.sum2 / ((this.half + 1) * (this.half + 1));
			// Eased back to 1 at the stretch's edges.
			const fromEnd = this.frames - 1 - r;
			let edge = 1;
			if (r < this.fadeIn) edge = Math.min(edge, 0.5 - 0.5 * Math.cos((Math.PI * (r + 1)) / (this.fadeIn + 1)));
			if (fromEnd < this.fadeOut) edge = Math.min(edge, 0.5 - 0.5 * Math.cos((Math.PI * (fromEnd + 1)) / (this.fadeOut + 1)));
			if (edge < 1 && g < 1) g = 1 - (1 - g) * edge;
			this.emitFrame(r, g, emit);
		}
	}

	private minPush(p: number): void {
		const mask = this.mask;
		const v = this.need[p & mask];
		while (this.dqHead !== this.dqTail && this.need[this.dq[(this.dqTail - 1) & mask] & mask] >= v) this.dqTail--;
		this.dq[this.dqTail & mask] = p;
		this.dqTail++;
	}

	private smooth(cut: number): void {
		const len = this.half + 1;
		const i1 = this.at1++ % len;
		const old1 = this.box1[i1];
		this.box1[i1] = cut;
		this.sum1 += cut - old1;
		this.nz1 += (cut !== 0 ? 1 : 0) - (old1 !== 0 ? 1 : 0);
		if (this.nz1 === 0) this.sum1 = 0;
		const mean = this.sum1;
		const i2 = this.at2++ % len;
		const old2 = this.box2[i2];
		this.box2[i2] = mean;
		this.sum2 += mean - old2;
		this.nz2 += (mean !== 0 ? 1 : 0) - (old2 !== 0 ? 1 : 0);
		if (this.nz2 === 0) this.sum2 = 0;
	}

	private emitFrame(r: number, g: number, emit: (out: Float64Array, frames: number) => void): void {
		const ch = this.ch;
		const slot = (r & this.mask) * ch;
		const o = this.emitCount * ch;
		for (let c = 0; c < ch; c++) this.emitBuf[o + c] = g === 1 ? this.y[slot + c] : this.y[slot + c] * g;
		this.emitCount++;
		this.out++;
		this.stats.frames++;
		if (g < 1) {
			const db = -20 * Math.log10(g);
			this.stats.active++;
			this.stats.sumDb += db;
			if (db > this.stats.maxDb) this.stats.maxDb = db;
		}
		if (this.emitCount * ch === this.emitBuf.length) this.flushEmit(emit);
	}

	private flushEmit(emit: (out: Float64Array, frames: number) => void): void {
		if (this.emitCount === 0) return;
		emit(this.emitBuf, this.emitCount);
		this.emitCount = 0;
	}
}

// The highest true peak (4x, as the limiter measures it) of audio pushed through in order.
export class TruePeakMeter {
	peak = 0;
	private ch: number;
	private hist: Float64Array; // the last frames, in a ring
	private mask: number;
	private n = 0;
	private lastBig = -Infinity;
	constructor(channels: number) {
		this.ch = channels;
		let size = 1;
		while (size < 2 * TAPS + 2) size *= 2;
		this.mask = size - 1;
		this.hist = new Float64Array(size * channels);
	}
	push(data: Float64Array, frames: number): void {
		const ch = this.ch;
		const mask = this.mask;
		const hist = this.hist;
		for (let i = 0; i < frames; i++) {
			const n = this.n++;
			const slot = (n & mask) * ch;
			let a = 0;
			for (let c = 0; c < ch; c++) {
				const v = data[i * ch + c];
				hist[slot + c] = v;
				const av = v < 0 ? -v : v;
				if (av > a) a = av;
			}
			if (a > this.peak) this.peak = a;
			// Only where a point between samples could top what has been found already. (Frames
			// before the first are zero in the ring, as nothing has been written there yet.)
			if (a * OVERSHOOT > this.peak) this.lastBig = n;
			const p = n - TAPS;
			if (this.lastBig < p - TAPS + 1) continue;
			const first = p - TAPS + 1;
			for (let c = 0; c < ch; c++)
				for (let j = 0; j < 3; j++) {
					const coef = PHASES[j];
					let s = 0;
					for (let k = 0; k < 2 * TAPS; k++) s += coef[k] * hist[((first + k) & mask) * ch + c];
					const av = s < 0 ? -s : s;
					if (av > this.peak) this.peak = av;
				}
		}
	}
	// The points between the last frames and the silence after them.
	finish(): void {
		const zero = new Float64Array(TAPS * this.ch);
		this.push(zero, TAPS);
	}
}

// --- Soft clipper --------------------------------------------------------------------------

// Above the limiter's ceiling, the very tops of the shortest peaks are rounded off by up to
// CLIP_DB before the limiter sees them, so it has less to do and can let go sooner. The curve
// is applied to a 4x oversampled copy, and only what it takes off is filtered back down to
// the file's rate and subtracted: what it does not touch comes through bit for bit, and what it
// adds above the file's band is filtered away rather than folded back into it. 2 dB came out
// within 0.12 LU of 3 dB on every real-track mix tried, but 3 dB left 0.3-1.6 dB less of
// what is not the input turned up and down, and takes more of the kicks off the limiter.
export const CLIP_DB = 3;
// The knee: the reduction grows smoothly from nothing at the ceiling to CLIP_DB this many times
// CLIP_DB above it. Twice keeps the curve rising everywhere (a louder peak always comes out
// louder), so it rounds peaks off rather than flattening them.
const CLIP_KNEE = 2;
// The filter back down to the file's rate: windowed sinc at the 4x rate, cut off at the file's
// Nyquist, DOWN_TAPS 4x samples either side.
const DOWN_TAPS = 32;
const DOWN = (() => {
	const bessel = (x: number): number => {
		let s = 1;
		let t = 1;
		for (let k = 1; k < 30; k++) {
			t *= (x / (2 * k)) ** 2;
			s += t;
		}
		return s;
	};
	const c = new Float64Array(2 * DOWN_TAPS + 1);
	let sum = 0;
	for (let k = -DOWN_TAPS; k <= DOWN_TAPS; k++) {
		const t = k / 4;
		const sinc = k === 0 ? 1 : Math.sin(Math.PI * t * 0.92) / (Math.PI * t * 0.92);
		const r = k / (DOWN_TAPS + 1);
		c[k + DOWN_TAPS] = sinc * (bessel(9 * Math.sqrt(1 - r * r)) / bessel(9));
		sum += c[k + DOWN_TAPS];
	}
	for (let k = 0; k < c.length; k++) c[k] /= sum;
	return c;
})();

export type ClipperStats = { frames: number; touched: number; maxDb: number };
// `sampleThreshold`: where the samples themselves start being rounded off, when that is lower
// than `threshold`, where the points between them do (full scale, under a true-peak ceiling
// above it). Near frames pushed as `hot` (louder than any one of the layers in them), points
// between samples are rounded off from `sampleThreshold` too: there the mix is hotter than
// the tracks themselves; elsewhere it is no hotter than they are and is left alone.
export type ClipperOptions = { frames: number; fadeIn?: number; fadeOut?: number; clipDb?: number; sampleThreshold?: number; sampleFloor?: number };

// Streams like the limiter: frames come back `latency` frames after they go in, in their own
// place in time.
export class SoftClipper {
	readonly latency: number;
	readonly stats: ClipperStats = { frames: 0, touched: 0, maxDb: 0 };
	private ch: number;
	private threshold: number;
	private sampleThreshold: number;
	private sampleFloor: number;
	private clipDb: number;
	private kneeDb: number;
	private mask: number;
	private x: Float64Array; // the pushed audio, at the file's rate
	private r: Float64Array; // what the curve takes off, at 4x
	private rmask: number;
	private pushed = 0;
	private real = Infinity;
	private out = 0;
	private lastCut = -Infinity; // the last 4x sample the curve touched
	private lastBig = -Infinity; // the last frame that could take a point between samples over
	private lastHot = -Infinity; // the last frame pushed as louder than its layers
	private frames: number;
	private fadeIn: number;
	private fadeOut: number;
	private emitBuf: Float64Array;
	private emitCount = 0;
	constructor(channels: number, threshold: number, opts: ClipperOptions) {
		this.ch = channels;
		this.threshold = threshold;
		this.sampleThreshold = Math.min(threshold, opts.sampleThreshold ?? threshold);
		this.sampleFloor = Math.min(threshold, opts.sampleFloor ?? this.sampleThreshold);
		this.clipDb = opts.clipDb ?? CLIP_DB;
		this.kneeDb = this.clipDb * CLIP_KNEE;
		this.frames = opts.frames;
		this.fadeIn = opts.fadeIn ?? 0;
		this.fadeOut = opts.fadeOut ?? 0;
		this.latency = TAPS + Math.ceil(DOWN_TAPS / 4);
		let size = 1;
		while (size < this.latency + 2 * TAPS + 4) size *= 2;
		this.mask = size - 1;
		this.x = new Float64Array(size * channels);
		let rsize = 1;
		while (rsize < 4 * size) rsize *= 2;
		this.rmask = rsize - 1;
		this.r = new Float64Array(rsize * channels);
		this.emitBuf = new Float64Array(4096 * channels);
	}

	// What the curve takes off a 4x sample `u`: nothing up to the threshold.
	private cut(u: number, threshold: number): number {
		const a = u < 0 ? -u : u;
		if (a <= threshold * SAME) return 0;
		const t = Math.min(1, (20 * Math.log10(a / threshold)) / this.kneeDb);
		const db = this.clipDb * t * t * (3 - 2 * t);
		return u * (10 ** (-db / 20) - 1);
	}

	push(input: Float64Array, count: number, emit: (out: Float64Array, frames: number) => void, hot?: Uint8Array): void {
		for (let i = 0; i < count; i++) {
			if (hot && hot[i]) this.lastHot = this.pushed;
			this.step(input, i * this.ch, emit);
		}
		if (this.emitCount) {
			emit(this.emitBuf, this.emitCount);
			this.emitCount = 0;
		}
	}

	finish(emit: (out: Float64Array, frames: number) => void): void {
		const zero = new Float64Array(this.ch);
		this.real = this.pushed;
		while (this.out < this.real) this.step(zero, 0, emit);
		if (this.emitCount) {
			emit(this.emitBuf, this.emitCount);
			this.emitCount = 0;
		}
	}

	private step(input: Float64Array, off: number, emit: (out: Float64Array, frames: number) => void): void {
		const ch = this.ch;
		const mask = this.mask;
		const rmask = this.rmask;
		const n = this.pushed++;
		let big = 0;
		for (let c = 0; c < ch; c++) {
			const v = input[off + c];
			this.x[(n & mask) * ch + c] = v;
			if (v > big) big = v;
			else if (-v > big) big = -v;
		}
		if (big * OVERSHOOT > this.sampleThreshold) this.lastBig = n;
		// The 4x samples from frame p to just before p + 1, now that frame p + TAPS is in: the
		// frame itself against the samples' threshold, the points after it against the threshold
		// for points between samples, which none of them can reach unless a frame near it is
		// high enough.
		const p = n - TAPS;
		if (p >= 0) {
			const between = this.lastBig >= p - TAPS + 1;
			const first = p - TAPS + 1;
			const thr = this.lastHot >= p - TAPS && this.lastHot <= p + TAPS ? this.sampleThreshold : this.threshold;
			for (let c = 0; c < ch; c++) {
				const u0 = this.x[(p & mask) * ch + c];
				let r = this.cut(u0, u0 < 0 ? this.sampleFloor : this.sampleThreshold);
				this.r[((4 * p) & rmask) * ch + c] = r;
				if (r !== 0) this.lastCut = Math.max(this.lastCut, 4 * p);
				for (let j = 1; j < 4; j++) {
					r = 0;
					if (between) {
						const coef = PHASES[j - 1];
						let s = 0;
						for (let k = 0; k < 2 * TAPS; k++) s += coef[k] * this.x[((first + k) & mask) * ch + c];
						r = this.cut(s, thr);
					}
					this.r[((4 * p + j) & rmask) * ch + c] = r;
					if (r !== 0) this.lastCut = Math.max(this.lastCut, 4 * p + j);
				}
			}
		}
		// Frame q is done once the 4x samples DOWN_TAPS after it are.
		const q = n - this.latency;
		if (q < 0 || q >= this.real) return;
		const o = this.emitCount * ch;
		const near = this.lastCut >= 4 * q - DOWN_TAPS;
		let edge = 1;
		const fromEnd = this.frames - 1 - q;
		if (q < this.fadeIn) edge = Math.min(edge, 0.5 - 0.5 * Math.cos((Math.PI * (q + 1)) / (this.fadeIn + 1)));
		if (fromEnd < this.fadeOut) edge = Math.min(edge, 0.5 - 0.5 * Math.cos((Math.PI * (fromEnd + 1)) / (this.fadeOut + 1)));
		let touched = false;
		for (let c = 0; c < ch; c++) {
			const x = this.x[(q & mask) * ch + c];
			let v = x;
			if (near) {
				let s = 0;
				for (let k = -DOWN_TAPS; k <= DOWN_TAPS; k++) {
					const at = 4 * q + k;
					if (at >= 0) s += DOWN[k + DOWN_TAPS] * this.r[(at & rmask) * ch + c];
				}
				if (s !== 0) {
					v = x + s * edge;
					touched = true;
					const ax = Math.abs(x);
					const av = Math.abs(v);
					if (ax > this.sampleThreshold && av < ax) this.stats.maxDb = Math.max(this.stats.maxDb, 20 * Math.log10(ax / av));
				}
			}
			this.emitBuf[o + c] = v;
		}
		this.stats.frames++;
		if (touched) this.stats.touched++;
		this.emitCount++;
		this.out++;
		if (this.emitCount * ch === this.emitBuf.length) {
			emit(this.emitBuf, this.emitCount);
			this.emitCount = 0;
		}
	}
}

// --- Dither --------------------------------------------------------------------------------

// Triangular dither of +-1 step (two uniform values, subtracted), from a small seeded
// generator (mulberry32) so the same export gives the same bytes.
export class Tpdf {
	private s: number;
	constructor(seed: number) {
		this.s = seed >>> 0;
	}
	private uniform(): number {
		let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	next(): number {
		return this.uniform() - this.uniform();
	}
}
