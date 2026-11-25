// The pointer's path, shared by the recorder (which sends it to the app) and the compositor
// (which draws the pointer on it), so the drawn pointer is exactly where the app was told it was
// at any instant, whatever the frame rate.

// Minimum-jerk easing: how a hand moves between two points.
export const ease = (u) => u * u * u * (u * (6 * u - 15) + 10);

const clamp01 = (u) => (u < 0 ? 0 : u > 1 ? 1 : u);

// A move is a quadratic curve from (x0,y0) to (x1,y1) bent towards (cx,cy), from t0 to t1.
export function along(m, t) {
	const u = m.t1 > m.t0 ? clamp01((t - m.t0) / (m.t1 - m.t0)) : 1;
	const e = ease(u);
	const a = (1 - e) * (1 - e);
	const b = 2 * (1 - e) * e;
	const c = e * e;
	return { x: a * m.x0 + b * m.cx + c * m.x1, y: a * m.y0 + b * m.cy + c * m.y1 };
}

// Where the pointer is at time t: on the move under way, else at the end of the last one.
export function pointerAt(moves, t) {
	let lo = 0;
	let hi = moves.length - 1;
	if (hi < 0) return { x: 0, y: 0 };
	if (t <= moves[0].t0) return { x: moves[0].x0, y: moves[0].y0 };
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (moves[mid].t0 <= t) lo = mid;
		else hi = mid - 1;
	}
	return along(moves[lo], t);
}

// The last entry of a time-sorted list at or before t (null before the first).
export function lastAt(list, t) {
	let lo = 0;
	let hi = list.length - 1;
	if (hi < 0 || list[0].t > t) return null;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (list[mid].t <= t) lo = mid;
		else hi = mid - 1;
	}
	return list[lo];
}
