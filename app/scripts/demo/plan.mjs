// How a take becomes the finished video's timeline: the stretches that were cut are dropped,
// what is left is joined with a short dissolve, and anything on the recording's clock can be
// placed on the video's clock. Used by the compositor (in a page) and the sound mix (in node).

export const XFADE = 0.35; // dissolve across a dropped stretch, seconds
export const HEAD = 0.0; // black before the first frame

// log.cuts -> the kept stretches, each with where it starts in the video.
export function segments(log) {
	const end = log.end ?? log.frames[log.frames.length - 1].t;
	const start = log.begin ?? 0;
	const cuts = [...log.cuts].filter((c) => c.b > start && c.a < end).sort((x, y) => x.a - y.a);
	const segs = [];
	let a = start;
	for (const c of cuts) {
		if (c.a - a > 2 * XFADE) segs.push({ a, b: c.a });
		a = Math.max(a, c.b);
	}
	if (end - a > 0.1) segs.push({ a, b: end });
	let out = HEAD;
	for (const s of segs) {
		s.out = out;
		out += s.b - s.a - XFADE;
	}
	const duration = out + XFADE;
	return { segs, duration };
}

// A time on the recording's clock -> the video's clock. Inside a dropped stretch: where the
// next kept stretch starts.
export function toOut(segs, t) {
	for (const s of segs) {
		if (t < s.a) return s.out;
		if (t <= s.b) return s.out + (t - s.a);
	}
	const last = segs[segs.length - 1];
	return last.out + (last.b - last.a);
}

// The kept stretches showing at a time on the video's clock: one, or two during a dissolve
// (then `mix` is how much of the second is seen). `t` is the recording's time in each.
export function atOut(segs, tau) {
	for (let i = 0; i < segs.length; i++) {
		const s = segs[i];
		const len = s.b - s.a;
		if (tau < s.out + len || i === segs.length - 1) {
			const next = segs[i + 1];
			if (next && tau >= next.out) {
				const mix = (tau - next.out) / XFADE;
				return { a: { t: s.a + (tau - s.out) }, b: { t: next.a + (tau - next.out) }, mix: Math.min(1, Math.max(0, mix)) };
			}
			return { a: { t: Math.min(s.b, s.a + Math.max(0, tau - s.out)) }, b: null, mix: 0 };
		}
	}
	return { a: { t: segs[0].a }, b: null, mix: 0 };
}
