// Drives the staged app the way a person would, and keeps a record of everything the edit
// needs afterwards: every frame the page drew, the pointer's path, clicks, keys, the app's
// sound, where the camera should look, which stretches to drop, and where each narration line
// starts. All times are seconds since the recording started.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Locator } from "playwright";
import { along } from "./cursor-path.mjs";
import { FFMPEG } from "./paths.ts";
import { XFADE } from "./plan.mjs";
import { VIEW_H, VIEW_W, type Stage } from "./stage.ts";

export type Rect = { x: number; y: number; w: number; h: number };
export type Move = { t0: number; t1: number; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number };
export type Log = {
	epoch: number; // wall-clock ms at time 0
	view: { w: number; h: number; scale: number };
	frames: { t: number; f: string }[];
	moves: Move[];
	buttons: { t: number; down: boolean }[];
	cursors: { t: number; c: string }[];
	keys: { t: number; label: string }[];
	cams: { t: number; rect: Rect | null; snap?: boolean }[];
	cuts: { a: number; b: number }[];
	says: { t: number; id: string }[];
	marks: { t: number; name: string }[];
	gains: { t: number; to: number; dur: number }[]; // the app's sound: fade to this level
	audio: { file: string; rate: number; start: number } | null;
	players: { t: number; id: number; src: string; pos: number; playing: boolean; vol: number }[];
};

export type Target = string | Locator | { x: number; y: number };
export type At = { fx?: number; fy?: number; dx?: number; dy?: number };

// Small deterministic random source, so two takes move alike.
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Director {
	readonly page;
	readonly log: Log;
	private readonly stage: Stage;
	private readonly dir: string;
	private readonly rand = rng(20261125);
	private pos = { x: VIEW_W * 0.55, y: VIEW_H * 0.5 };
	private inputScale = 1;
	private writes: Promise<void> = Promise.resolve();
	private frameNo = 0;
	private pcm: fs.WriteStream | null = null;
	private pcmFrames = 0;
	private pump: ReturnType<typeof setInterval> | null = null;
	private pumping: Promise<void> = Promise.resolve();
	private cutFrom: number | null = null;
	private cutTotal = 0; // seconds the cuts so far take out of the film
	private sayEnd = 0; // on the film's clock
	// How long each narration line lasts, by id; lines not listed are timed from their text.
	voice: Record<string, number> = {};
	// Fast mode: narration waits are skipped, for trying out the moves.
	fast = false;

	constructor(stage: Stage, dir: string) {
		this.stage = stage;
		this.page = stage.page;
		this.dir = dir;
		fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
		this.log = { epoch: 0, view: { w: VIEW_W, h: VIEW_H, scale: stage.scale }, frames: [], moves: [], buttons: [], cursors: [], keys: [], cams: [], cuts: [], says: [], marks: [], gains: [], audio: null, players: [] };
	}

	now(): number {
		return (performance.timeOrigin + performance.now() - this.log.epoch) / 1000;
	}

	// The time in the finished film: the recording's time less what the cuts take out. It stands
	// still during a cut.
	filmNow(): number {
		const t = this.now();
		return t - this.cutTotal - (this.cutFrom !== null ? t - this.cutFrom : 0);
	}

	// ---- start and finish -----------------------------------------------------------------

	// Finds how pointer coordinates sent to the page relate to the page's own (it is zoomed).
	async calibrate(): Promise<void> {
		await this.page.evaluate(() => {
			(window as any).__probe = null;
			addEventListener("mousemove", (e) => ((window as any).__probe = [e.clientX, e.clientY]), { capture: true, once: true });
		});
		await this.page.mouse.move(400, 300);
		await sleep(100);
		const got: [number, number] | null = await this.page.evaluate(() => (window as any).__probe);
		if (!got) throw new Error("The page did not see the pointer");
		this.inputScale = 400 / got[0];
		await this.page.mouse.move(this.pos.x * this.inputScale, this.pos.y * this.inputScale);
	}

	async start(): Promise<void> {
		await this.calibrate();
		const { cdp } = this.stage;
		this.log.epoch = performance.timeOrigin + performance.now();
		this.log.moves.push({ t0: 0, t1: 0, x0: this.pos.x, y0: this.pos.y, x1: this.pos.x, y1: this.pos.y, cx: this.pos.x, cy: this.pos.y });
		this.pcm = fs.createWriteStream(path.join(this.dir, "app-audio.f32"));
		cdp.on("Page.screencastFrame", (f) => {
			const t = (f.metadata.timestamp ?? 0) - this.log.epoch / 1000;
			const name = String(++this.frameNo).padStart(6, "0") + ".jpg";
			this.log.frames.push({ t, f: name });
			const buf = Buffer.from(f.data, "base64");
			this.writes = this.writes.then(() => fs.promises.writeFile(path.join(this.dir, "frames", name), buf));
			cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
		});
		await cdp.send("Page.startScreencast", { format: "jpeg", quality: 93, maxWidth: VIEW_W * this.stage.scale, maxHeight: VIEW_H * this.stage.scale, everyNthFrame: 1 });
		this.pump = setInterval(() => {
			this.pumping = this.pumping.then(() => this.drain());
		}, 1500);
	}

	// Pulls what the page has recorded so far: its sound, its <audio> players, pointer shapes.
	private async drain(): Promise<void> {
		const got: { audio: { frame: number; at: number; data: string }[]; rate: number; players: Log["players"]; cursors: Log["cursors"] } = await this.page
			.evaluate(() => {
				const d = (window as any).__demo;
				return { audio: d.take(40), rate: d.rate, players: d.playerLog.splice(0), cursors: d.cursorLog.splice(0) };
			})
			.catch(() => ({ audio: [], rate: 0, players: [], cursors: [] }));
		for (const p of got.players) this.log.players.push({ ...p, t: (p.t - this.log.epoch) / 1000 });
		for (const c of got.cursors) this.log.cursors.push({ t: (c.t - this.log.epoch) / 1000, c: c.c });
		for (const c of got.audio) {
			const buf = Buffer.from(c.data, "base64");
			const n = buf.length / 8;
			if (!this.log.audio) {
				this.log.audio = { file: "app-audio.wav", rate: got.rate, start: (c.at - this.log.epoch) / 1000 };
				this.pcmFrames = 0;
			}
			// Where this piece belongs on the recording's clock; silence fills any gap before it
			// (the audio clock stops while nothing plays).
			const want = Math.round(((c.at - this.log.epoch) / 1000 - this.log.audio.start) * got.rate);
			const gap = want - this.pcmFrames;
			if (gap > got.rate * 0.02) {
				this.pcm!.write(Buffer.alloc(gap * 8));
				this.pcmFrames += gap;
			}
			this.pcm!.write(buf);
			this.pcmFrames += n;
		}
	}

	async finish(): Promise<void> {
		if (this.cutFrom !== null) this.cutEnd();
		if (this.pump) clearInterval(this.pump);
		await this.pumping;
		for (let i = 0; i < 50; i++) {
			const before = this.pcmFrames;
			await this.drain();
			if (this.pcmFrames === before) break;
		}
		await this.stage.cdp.send("Page.stopScreencast").catch(() => {});
		await this.writes;
		await new Promise<void>((r) => this.pcm!.end(r));
		const raw = path.join(this.dir, "app-audio.f32");
		if (this.log.audio) execFileSync(FFMPEG, ["-y", "-v", "error", "-f", "f32le", "-ar", String(this.log.audio.rate), "-ac", "2", "-i", raw, "-c:a", "pcm_s24le", path.join(this.dir, this.log.audio.file)]);
		fs.rmSync(raw, { force: true });
		this.log.cursors.sort((a, b) => a.t - b.t);
		// No stretch of the recording may be without frames.
		let worst = 0;
		let at = 0;
		for (let i = 1; i < this.log.frames.length; i++) {
			const g = this.log.frames[i].t - this.log.frames[i - 1].t;
			if (g > worst) [worst, at] = [g, this.log.frames[i - 1].t];
		}
		console.log(`[film] longest gap between frames: ${worst.toFixed(2)}s at ${at.toFixed(1)}s`);
		fs.writeFileSync(path.join(this.dir, "log.json"), JSON.stringify(this.log));
	}

	// ---- pointer ----------------------------------------------------------------------------

	async point(target: Target, at: At = {}): Promise<{ x: number; y: number }> {
		if (typeof target === "object" && "x" in target) return { x: target.x + (at.dx ?? 0), y: target.y + (at.dy ?? 0) };
		const loc = typeof target === "string" ? this.page.getByTestId(target).first() : target;
		const box = await loc.boundingBox({ timeout: 15000 });
		if (!box) throw new Error(`Not on screen: ${typeof target === "string" ? target : "locator"}`);
		// boundingBox is in the zoomed page's pixels.
		const k = this.inputScale;
		return { x: box.x / k + (box.width / k) * (at.fx ?? 0.5) + (at.dx ?? 0), y: box.y / k + (box.height / k) * (at.fy ?? 0.5) + (at.dy ?? 0) };
	}

	// Moves the pointer there along a slightly bent path, at a hand's pace.
	async move(target: Target, at: At & { dur?: number; straight?: boolean } = {}): Promise<void> {
		const to = await this.point(target, at);
		const from = this.pos;
		const dist = Math.hypot(to.x - from.x, to.y - from.y);
		if (dist < 0.5) return;
		const dur = at.dur ?? (0.26 + 0.145 * Math.log2(1 + dist / 30)) * (0.92 + this.rand() * 0.16);
		const bend = at.straight ? 0 : (this.rand() - 0.5) * 0.16 * dist;
		const nx = -(to.y - from.y) / dist;
		const ny = (to.x - from.x) / dist;
		const t0 = this.now();
		const m: Move = { t0, t1: t0 + dur, x0: from.x, y0: from.y, x1: to.x, y1: to.y, cx: (from.x + to.x) / 2 + nx * bend, cy: (from.y + to.y) / 2 + ny * bend };
		this.log.moves.push(m);
		for (;;) {
			const t = this.now();
			const p = along(m, t);
			await this.page.mouse.move(p.x * this.inputScale, p.y * this.inputScale);
			if (t >= m.t1) break;
			await sleep(6);
		}
		this.pos = to;
	}

	async down(button: "left" | "right" = "left", clickCount = 1): Promise<void> {
		this.log.buttons.push({ t: this.now(), down: true });
		await this.page.mouse.down({ button, clickCount });
	}

	async up(button: "left" | "right" = "left", clickCount = 1): Promise<void> {
		await this.page.mouse.up({ button, clickCount });
		this.log.buttons.push({ t: this.now(), down: false });
	}

	async click(target?: Target, at: At & { button?: "left" | "right"; settle?: number } = {}): Promise<void> {
		if (target !== undefined) {
			await this.move(target, at);
			await sleep(at.settle ?? 90 + this.rand() * 70);
		}
		await this.down(at.button ?? "left");
		await sleep(65 + this.rand() * 45);
		await this.up(at.button ?? "left");
	}

	async dblclick(target?: Target, at: At = {}): Promise<void> {
		if (target !== undefined) {
			await this.move(target, at);
			await sleep(110);
		}
		await this.down("left", 1);
		await sleep(60);
		await this.up("left", 1);
		await sleep(95);
		await this.down("left", 2);
		await sleep(60);
		await this.up("left", 2);
	}

	// Press on `from`, carry to `to` (through `via` points if given), let go.
	async drag(from: Target, to: Target, opts: { fromAt?: At; toAt?: At; via?: { x: number; y: number }[]; dur?: number; hold?: number; settle?: number; keys?: string[] } = {}): Promise<void> {
		await this.move(from, opts.fromAt ?? {});
		await sleep(110);
		for (const k of opts.keys ?? []) await this.page.keyboard.down(k);
		await this.down();
		await sleep(opts.hold ?? 120);
		// A first small move, as a hand does before it commits, also gets past drag thresholds.
		await this.move({ x: this.pos.x + 7, y: this.pos.y + 3 }, { dur: 0.12, straight: true });
		for (const v of opts.via ?? []) await this.move(v, {});
		await this.move(to, { ...(opts.toAt ?? {}), ...(opts.dur ? { dur: opts.dur } : {}) });
		await sleep(opts.settle ?? 200);
		await this.up();
		for (const k of [...(opts.keys ?? [])].reverse()) await this.page.keyboard.up(k);
	}

	// Scrolls the wheel at the pointer in a few steps, as a hand does; with `meta`, ⌘ is held.
	async wheel(dy: number, meta = false, steps = 6): Promise<void> {
		if (meta) await this.page.keyboard.down("Meta");
		for (let i = 0; i < steps; i++) {
			await this.page.mouse.wheel(0, dy / steps);
			await sleep(45 + this.rand() * 30);
		}
		if (meta) await this.page.keyboard.up("Meta");
	}

	// ---- keyboard ---------------------------------------------------------------------------

	async type(text: string): Promise<void> {
		for (const ch of text) {
			await this.page.keyboard.type(ch);
			await sleep(ch === " " ? 95 + this.rand() * 70 : 55 + this.rand() * 85);
		}
	}

	// Presses a key or chord (Playwright's names, e.g. "Meta+D"). `label` is shown on screen.
	async key(combo: string, label?: string): Promise<void> {
		if (label) this.log.keys.push({ t: this.now(), label });
		await this.page.keyboard.press(combo, { delay: 70 });
	}

	// ---- time, narration, camera, cuts ------------------------------------------------------

	async wait(ms: number): Promise<void> {
		await sleep(ms);
	}

	mark(name: string): void {
		this.log.marks.push({ t: this.now(), name });
	}

	// The app's sound fades to `to` (1 = as recorded) over `dur` seconds, from now.
	music(to: number, dur: number): void {
		this.log.gains.push({ t: this.now(), to, dur });
	}

	// A narration line starts now. Its text is only used to guess a length before the line has
	// been voiced.
	say(id: string, text = ""): void {
		const film = this.filmNow();
		const at = Math.max(film, this.sayEnd + 0.25);
		const dur = this.voice[id] ?? Math.max(1, text.length / 15);
		this.log.says.push({ t: this.now() + (at - film), id });
		this.sayEnd = at + dur;
	}

	// Waits until the line being spoken has ended, plus a breath. Time that is cut out of the
	// film does not count.
	async said(extra = 0.35): Promise<void> {
		if (this.fast) return void (await sleep(150));
		await this.untilLeft(-extra);
	}

	// Waits until there are `sec` seconds of the current line left (0 = its end).
	async untilLeft(sec: number): Promise<void> {
		if (this.fast) return;
		for (;;) {
			const left = this.sayEnd - sec - this.filmNow();
			if (left <= 0) return;
			await sleep(Math.min(left * 1000, 80));
		}
	}

	// Where the camera should look from now on: a part of the page, or all of it (null).
	cam(rect: Rect | null, snap = false): void {
		this.log.cams.push({ t: this.now(), rect, ...(snap ? { snap } : {}) });
	}

	async camOn(target: Target | Target[], pad = 60, minW = 640): Promise<void> {
		const list = Array.isArray(target) ? target : [target];
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (const t of list) {
			if (typeof t === "object" && "x" in t) {
				x0 = Math.min(x0, t.x);
				y0 = Math.min(y0, t.y);
				x1 = Math.max(x1, t.x);
				y1 = Math.max(y1, t.y);
				continue;
			}
			const loc = typeof t === "string" ? this.page.getByTestId(t).first() : t;
			const b = await loc.boundingBox({ timeout: 15000 });
			if (!b) continue;
			const k = this.inputScale;
			x0 = Math.min(x0, b.x / k);
			y0 = Math.min(y0, b.y / k);
			x1 = Math.max(x1, (b.x + b.width) / k);
			y1 = Math.max(y1, (b.y + b.height) / k);
		}
		this.cam(frame16x9({ x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad }, minW));
	}

	// Everything from here to cutEnd() is left out of the video (waiting on the app).
	cutStart(): void {
		if (this.cutFrom === null) this.cutFrom = this.now();
	}

	cutEnd(): void {
		if (this.cutFrom === null) return;
		const b = this.now();
		if (b - this.cutFrom > 2 * XFADE + 0.1) {
			this.log.cuts.push({ a: this.cutFrom, b });
			this.cutTotal += b - this.cutFrom + XFADE;
		}
		this.cutFrom = null;
	}

	// Waits for something in the app; if it takes longer than `show` seconds, the rest is cut.
	async patience(waitFor: () => Promise<unknown>, show = 1.2): Promise<void> {
		const t = setTimeout(() => this.cutStart(), show * 1000);
		try {
			await waitFor();
		} finally {
			clearTimeout(t);
			if (this.cutFrom !== null) {
				await sleep(350);
				this.cutEnd();
			}
		}
	}

	st<T>(fn: string): Promise<T> {
		return this.page.evaluate(`(() => { const s = window.planner.store.get(); return (${fn})(s); })()`) as Promise<T>;
	}
}

// The smallest 16:9 frame around a rectangle, at least minW wide, kept on the page.
export function frame16x9(r: Rect, minW = 640): Rect {
	let w = Math.max(r.w, (r.h * 16) / 9, minW);
	w = Math.min(w, VIEW_W);
	const h = (w * 9) / 16;
	let x = r.x + r.w / 2 - w / 2;
	let y = r.y + r.h / 2 - h / 2;
	x = Math.max(0, Math.min(VIEW_W - w, x));
	y = Math.max(0, Math.min(VIEW_H - h, y));
	return { x, y, w, h };
}
