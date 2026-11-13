// Clip volume fades: from silence up to full volume over the start of a clip, and back down
// to silence over its end. The fade-in rises along a curve (volume = t²) so the loudness
// builds evenly instead of jumping up in the first part of the fade; the fade-out is straight.

import type { Clip } from "./planner";

// How loud a clip is at `pos`, 0..1. `pos`, `length` and the two fade lengths share one unit
// (beats, seconds or frames).
export function fadeGain(pos: number, length: number, fadeIn: number, fadeOut: number): number {
	let g = 1;
	if (fadeIn > 0) g = Math.min(g, Math.max(0, pos / fadeIn) ** 2);
	if (fadeOut > 0) g = Math.min(g, (length - pos) / fadeOut);
	return Math.max(0, Math.min(1, g));
}

// The clip with its fades made to fit inside it: when the two no longer fit (after a trim,
// say) both shrink by the same factor. A clip without a fade has no fade field at all.
export function fitFades(c: Clip): Clip {
	let a = Math.max(0, c.fadeInBeat ?? 0);
	let b = Math.max(0, c.fadeOutBeat ?? 0);
	if (a + b > c.lengthBeat) {
		const k = c.lengthBeat / (a + b);
		a *= k;
		b *= k;
	}
	const out: Clip = { ...c };
	delete out.fadeInBeat;
	delete out.fadeOutBeat;
	if (a > 1e-6) out.fadeInBeat = a;
	if (b > 1e-6) out.fadeOutBeat = b;
	return out;
}
