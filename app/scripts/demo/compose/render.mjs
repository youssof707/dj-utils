// The compositor: turns a take (frames + log) into the picture of the finished video, frame by
// frame at exactly 60 a second. Each frame is the app's picture seen through a camera that eases
// between the places the take asked for, with the pointer drawn on the path it was sent along,
// the keys that were pressed shown as keycaps, and the titles. Raw frames go straight to ffmpeg.

import { lastAt, pointerAt } from "../cursor-path.mjs";
import { atOut, segments, toOut } from "../plan.mjs";

const fs = window.require("node:fs");
const path = window.require("node:path");
const { spawn } = window.require("node:child_process");
const { ipcRenderer } = window.require("electron");

const q = new URLSearchParams(location.search);
const TAKE = q.get("take");
const OUT = q.get("out") || path.join(TAKE, "picture.mp4");
const FROM = q.get("from") ? Number(q.get("from")) : null; // only these seconds of the video (for checks)
const TO = q.get("to") ? Number(q.get("to")) : null;
const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const FFMPEG = fs.existsSync("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg") ? "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" : "ffmpeg";

const FPS = 60;
const W = 2560;
const H = 1440;
const CURSOR_SCALE = 1.25; // a little larger than life, as screen recordings for video are
const FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", sans-serif';

const say = (s) => ipcRenderer.send("log", s);

async function main() {
	const log = JSON.parse(fs.readFileSync(path.join(TAKE, "log.json"), "utf8"));
	const { segs, duration } = segments(log);
	const VW = log.view.w;
	const VH = log.view.h;
	const S = log.view.scale;

	// ---- assets ------------------------------------------------------------------------------
	const load = async (file) => createImageBitmap(new Blob([fs.readFileSync(file)]));
	const curDir = path.join(HERE, "..", "assets", "cursors");
	const curMeta = JSON.parse(fs.readFileSync(path.join(curDir, "cursors.json"), "utf8"));
	const curs = {};
	for (const name of Object.keys(curMeta)) curs[name] = { img: await load(path.join(curDir, name + ".png")), ...curMeta[name], w: Math.ceil(curMeta[name].w), h: Math.ceil(curMeta[name].h) };
	const custom = new Map();
	const icon = await load(path.join(HERE, "..", "..", "..", "build", "icon.png"));
	const ALIAS = { auto: "default", "col-resize": "ew-resize", "row-resize": "ns-resize", "e-resize": "ew-resize", "w-resize": "ew-resize", move: "grab" };
	async function cursorFor(css) {
		if (!css) return curs.default;
		if (css.startsWith("url(")) {
			if (!custom.has(css)) {
				const m = css.match(/^url\("(data:[^"]+)"\)\s+(\d+)\s+(\d+)/);
				let made = curs.default;
				if (m) {
					const blob = await (await fetch(m[1])).blob();
					const el = new Image();
					el.src = URL.createObjectURL(blob);
					await el.decode();
					const c = new OffscreenCanvas(el.naturalWidth * 4, el.naturalHeight * 4);
					c.getContext("2d").drawImage(el, 0, 0, c.width, c.height);
					made = { img: await createImageBitmap(c), w: el.naturalWidth, h: el.naturalHeight, hx: Number(m[2]), hy: Number(m[3]) };
				}
				custom.set(css, made);
			}
			return custom.get(css);
		}
		const first = css.split(",")[0].trim();
		return curs[ALIAS[first] ?? first] ?? curs.default;
	}
	for (const c of log.cursors) await cursorFor(c.c);

	// ---- the app's frames --------------------------------------------------------------------
	const frames = log.frames;
	const frameIndexAt = (t) => {
		let lo = 0;
		let hi = frames.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (frames[mid].t <= t) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	const cache = new Map();
	async function frameAt(t) {
		const i = frameIndexAt(t);
		if (!cache.has(i)) {
			if (cache.size > 6) {
				const old = cache.keys().next().value;
				cache.get(old).close();
				cache.delete(old);
			}
			cache.set(i, await load(path.join(TAKE, "frames", frames[i].f)));
		}
		return cache.get(i);
	}

	// ---- camera: a spring that follows the place the take asked to look at ------------------------
	const full = { x: 0, y: 0, w: VW, h: VH };
	const wanted = (t) => {
		const k = lastAt(log.cams, t);
		return k && k.rect ? k.rect : full;
	};
	// The pointer counts as in use from a little before a move or press until a while after.
	const inUse = (t) => {
		const p0 = pointerAt(log.moves, t - 1.4);
		const p1 = pointerAt(log.moves, t + 0.3);
		if (Math.hypot(p1.x - p0.x, p1.y - p0.y) > 2) return true;
		const b = lastAt(log.buttons, t + 0.3);
		return !!b && t - b.t < 1.4;
	};
	const camNow = { cx: VW / 2, cy: VH / 2, w: VW, vx: 0, vy: 0, vw: 0 };
	const first = wanted(segs[0].a + 0.5);
	Object.assign(camNow, { cx: first.x + first.w / 2, cy: first.y + first.h / 2, w: first.w });
	const OMEGA = 5.2;
	let snapped = null;
	function stepCam(t, pointer) {
		const r = wanted(t);
		// A change marked "snap" is taken at once rather than eased to.
		const key = lastAt(log.cams, t);
		if (key && key.snap && key !== snapped) {
			snapped = key;
			Object.assign(camNow, { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, vx: 0, vy: 0, vw: 0 });
		}
		let cx = r.x + r.w / 2;
		let cy = r.y + r.h / 2;
		const w = r.w;
		const h = (w * VH) / VW;
		// When looking at a part of the page, keep the pointer in view while it is in use.
		if (w < VW - 1 && inUse(t)) {
			const mx = w * 0.42;
			const my = h * 0.4;
			cx += Math.max(0, pointer.x - (cx + mx)) + Math.min(0, pointer.x - (cx - mx));
			cy += Math.max(0, pointer.y - (cy + my)) + Math.min(0, pointer.y - (cy - my));
			cx = Math.max(w / 2, Math.min(VW - w / 2, cx));
			cy = Math.max(h / 2, Math.min(VH - h / 2, cy));
		}
		const dt = 1 / FPS;
		for (const [k, v, target] of [
			["cx", "vx", cx],
			["cy", "vy", cy],
			["w", "vw", w],
		]) {
			const a = OMEGA * OMEGA * (target - camNow[k]) - 2 * OMEGA * camNow[v];
			camNow[v] += a * dt;
			camNow[k] += camNow[v] * dt;
		}
		const cw = Math.min(VW, camNow.w);
		const ch = (cw * VH) / VW;
		return { x: Math.max(0, Math.min(VW - cw, camNow.cx - cw / 2)), y: Math.max(0, Math.min(VH - ch, camNow.cy - ch / 2)), w: cw, h: ch };
	}

	// ---- drawing -----------------------------------------------------------------------------
	const canvas = new OffscreenCanvas(W, H);
	const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";

	const buttons = log.buttons;
	// How far the pointer is pressed in at t: 0 up, 1 down, eased over a few frames.
	function pressAt(t) {
		const b = lastAt(buttons, t);
		if (!b) return 0;
		const age = (t - b.t) / 0.07;
		const k = age >= 1 ? 1 : age * age * (3 - 2 * age);
		return b.down ? k : 1 - k;
	}

	async function drawScene(t, cam, alpha) {
		const img = await frameAt(t);
		ctx.globalAlpha = alpha;
		ctx.drawImage(img, cam.x * S, cam.y * S, cam.w * S, cam.h * S, 0, 0, W, H);
		const p = pointerAt(log.moves, t);
		const shape = await cursorFor(lastAt(log.cursors, t)?.c);
		const k = (W / cam.w) * CURSOR_SCALE * (1 - 0.1 * pressAt(t));
		const x = ((p.x - cam.x) / cam.w) * W;
		const y = ((p.y - cam.y) / cam.h) * H;
		ctx.drawImage(shape.img, x - shape.hx * k, y - shape.hy * k, shape.w * k, shape.h * k);
		ctx.globalAlpha = 1;
	}

	function roundRect(x, y, w, h, r) {
		ctx.beginPath();
		ctx.roundRect(x, y, w, h, r);
	}

	// Keys pressed: keycaps near the bottom, for a moment.
	const keys = log.keys.map((k) => ({ out: toOut(segs, k.t), label: k.label }));
	const KEY_HOLD = 1.25;
	function drawKeys(tau) {
		let k = null;
		for (const x of keys) if (x.out <= tau && tau < x.out + KEY_HOLD) k = x;
		if (!k) return;
		const age = tau - k.out;
		const a = Math.min(1, age / 0.12) * Math.min(1, (KEY_HOLD - age) / 0.22);
		const rise = (1 - Math.min(1, age / 0.16)) * 10;
		const caps = k.label.split(" ");
		ctx.font = `600 44px ${FONT}`;
		const widths = caps.map((c) => Math.max(96, ctx.measureText(c).width + 56));
		const gap = 14;
		const total = widths.reduce((s, w) => s + w, 0) + gap * (caps.length - 1);
		let x = (W - total) / 2;
		const y = H - 190 + rise;
		ctx.globalAlpha = a;
		caps.forEach((c, i) => {
			ctx.shadowColor = "rgba(0,0,0,0.55)";
			ctx.shadowBlur = 28;
			ctx.shadowOffsetY = 8;
			roundRect(x, y, widths[i], 96, 20);
			ctx.fillStyle = "rgba(24,26,32,0.94)";
			ctx.fill();
			ctx.shadowColor = "transparent";
			ctx.lineWidth = 1.5;
			ctx.strokeStyle = "rgba(255,255,255,0.16)";
			ctx.stroke();
			ctx.fillStyle = "#eef0f5";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(c, x + widths[i] / 2, y + 50);
			x += widths[i] + gap;
		});
		ctx.globalAlpha = 1;
	}

	// Titles: the name over the opening, and the closing card.
	const markOut = (name) => {
		const m = log.marks.find((x) => x.name === name);
		return m ? toOut(segs, m.t) : null;
	};
	const titleIn = markOut("title:in");
	const titleOut = markOut("title:out");
	const outro = markOut("outro");
	const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
	function drawCard(a, sub, cover) {
		if (a <= 0) return;
		ctx.globalAlpha = 1;
		ctx.fillStyle = `rgba(11,12,15,${cover * a})`;
		ctx.fillRect(0, 0, W, H);
		ctx.globalAlpha = a;
		const size = 230;
		const lift = (1 - a) * 14;
		ctx.drawImage(icon, W / 2 - size / 2, H / 2 - size - 30 + lift, size, size);
		ctx.fillStyle = "#f2f4f8";
		ctx.textAlign = "center";
		ctx.textBaseline = "alphabetic";
		ctx.font = `700 104px ${FONT}`;
		ctx.letterSpacing = "-2px";
		ctx.fillText("DJ Utilities", W / 2, H / 2 + 92 + lift);
		ctx.letterSpacing = "0px";
		if (sub) {
			ctx.font = `400 40px ${FONT}`;
			ctx.fillStyle = "rgba(200,205,216,0.92)";
			ctx.fillText(sub, W / 2, H / 2 + 166 + lift);
		}
		ctx.globalAlpha = 1;
	}
	function drawTitles(tau) {
		if (titleIn !== null && titleOut !== null) drawCard(smooth((tau - titleIn) / 0.55) * smooth((titleOut - tau) / 0.55), "", 1);
		if (outro !== null) drawCard(smooth((tau - outro) / 0.9), "", 0.74);
		const fade = Math.min(smooth(tau / 0.45), smooth((duration - tau) / 0.7));
		if (fade < 1) {
			ctx.fillStyle = `rgba(0,0,0,${1 - fade})`;
			ctx.fillRect(0, 0, W, H);
		}
	}

	// ---- encode ------------------------------------------------------------------------------
	const total = Math.round(duration * FPS);
	const n0 = FROM === null ? 0 : Math.round(FROM * FPS);
	const n1 = TO === null ? total : Math.min(total, Math.round(TO * FPS));
	const ff = spawn(
		FFMPEG,
		["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "15", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-movflags", "+faststart", OUT],
		{ stdio: ["pipe", "ignore", "pipe"] },
	);
	let ffErr = "";
	ff.stderr.on("data", (d) => (ffErr += d));
	const closed = new Promise((r) => ff.on("close", r));
	say(`composing ${((n1 - n0) / FPS).toFixed(1)}s of ${duration.toFixed(1)}s (${segs.length} stretch${segs.length === 1 ? "" : "es"}) -> ${OUT}`);
	const began = performance.now();
	for (let n = 0; n < n1; n++) {
		const tau = n / FPS;
		const now = atOut(segs, tau);
		const main = now.b && now.mix >= 0.5 ? now.b : now.a;
		// The camera runs from the very start, so a partial render looks as the full one does.
		const cam = stepCam(main.t, pointerAt(log.moves, main.t));
		if (n < n0) continue;
		ctx.fillStyle = "#0e0f12";
		ctx.fillRect(0, 0, W, H);
		await drawScene(now.a.t, cam, 1);
		if (now.b) await drawScene(now.b.t, cam, smooth(now.mix));
		drawKeys(tau);
		drawTitles(tau);
		const data = ctx.getImageData(0, 0, W, H).data;
		if (!ff.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) await new Promise((r) => ff.stdin.once("drain", r));
		if ((n - n0) % 300 === 299) say(`  ${(((n - n0 + 1) / (n1 - n0)) * 100).toFixed(0)}%  ${((n - n0 + 1) / ((performance.now() - began) / 1000)).toFixed(1)} fps`);
	}
	ff.stdin.end();
	const code = await closed;
	if (code !== 0) say("ffmpeg: " + ffErr.slice(-800));
	say(`done in ${((performance.now() - began) / 1000).toFixed(0)}s`);
	ipcRenderer.send("done", code === 0 ? 0 : 2);
}

main().catch((e) => {
	say("compose failed: " + (e && e.stack ? e.stack : e));
	ipcRenderer.send("done", 1);
});
