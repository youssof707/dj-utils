// Waveform drawing shared by the timeline's clips and the track editor. Peaks hold two bytes
// per bucket: the whole signal's peak (band 0) and the kick band's (band 1).

// The loudest value of a band over the whole file, so drawings can be scaled to fill their height.
export function peakMax(peaks: Uint8Array | null, band: 0 | 1): number {
	if (!peaks) return 255;
	let m = 1;
	for (let i = band; i < peaks.length; i += 2) if (peaks[i] > m) m = peaks[i];
	return m;
}

// Sizes the canvas for `cssW` by `cssH` CSS pixels and clears it.
export function sizeCanvas(cv: HTMLCanvasElement, cssW: number, cssH: number): CanvasRenderingContext2D {
	const dpr = window.devicePixelRatio || 1;
	cv.width = Math.round(cssW * dpr);
	cv.height = Math.round(cssH * dpr);
	const g = cv.getContext("2d")!;
	g.clearRect(0, 0, cv.width, cv.height);
	return g;
}

// Draws one band over the whole (already sized) canvas, mirrored around the middle.
// `startBucket` is the bucket at the canvas's left edge and `bucketsPerPx` how many buckets
// one CSS pixel covers. `vol` scales the height at a given CSS pixel from the left edge.
export function drawBand(cv: HTMLCanvasElement, peaks: Uint8Array, o: { band: 0 | 1; max: number; startBucket: number; bucketsPerPx: number; fill: string; vol?: (px: number) => number }): void {
	const g = cv.getContext("2d")!;
	const dpr = window.devicePixelRatio || 1;
	const perCol = o.bucketsPerPx / dpr;
	const mid = cv.height / 2;
	const buckets = peaks.length >> 1;
	g.fillStyle = o.fill;
	for (let x = 0; x < cv.width; x++) {
		const b0 = Math.floor(o.startBucket + x * perCol);
		const b1 = Math.max(b0 + 1, Math.floor(o.startBucket + (x + 1) * perCol));
		let l = 0;
		for (let b = Math.max(0, b0); b < b1 && b < buckets; b++) if (peaks[b * 2 + o.band] > l) l = peaks[b * 2 + o.band];
		const hh = Math.min(1, l / o.max) * mid * (o.vol ? o.vol(x / dpr) : 1);
		if (hh > 0.25) g.fillRect(x, mid - hh, 1, hh * 2);
	}
}
