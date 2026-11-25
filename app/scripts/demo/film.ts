// The demo film: every move, in order. Each narration line (say) is followed by the actions
// that go with it; waits are sized to the voiced lines when voice.json exists.
//
//   node scripts/demo/film.ts <take name> [--fast] [--scale 1|2] [--until <scene>]
//
// --fast skips the narration waits (for trying the moves out). The take lands in
// dev-data/demo/takes/<name>/: frames/, log.json, app-audio.wav, and world/ (the app data and
// Rekordbox copy the take ran on).

import fs from "node:fs";
import path from "node:path";
import { Director, frame16x9 } from "./director.ts";
import { DEMO } from "./paths.ts";
import { answerSaveDialog, freshWorld, openStage, VIEW_H, VIEW_W } from "./stage.ts";
import { LINES } from "./script.ts";

const argv = process.argv.slice(2);
const flag = (n: string): string | null => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const name = argv[0];
const dir = path.join(DEMO, "takes", name);
const until = flag("--until");

const SATURDAY = "smwfm6j341odbz";
// A track Rekordbox has not seen: a copy under another name, so nothing matches it.
const LOOSE_SRC = path.resolve(import.meta.dirname, "../../../store/Temperature (Afinity Remix).mp3");
const TEMPERATURE = path.join(dir, "world", "files", "Sean Paul - Temperature (Afinity Remix).mp3");

fs.rmSync(dir, { recursive: true, force: true });
const stage = await openStage({ world: freshWorld(path.join(dir, "world")), scale: Number(flag("--scale") ?? 2) });
const { page } = stage;
fs.mkdirSync(path.dirname(TEMPERATURE), { recursive: true });
fs.copyFileSync(LOOSE_SRC, TEMPERATURE);
const d = new Director(stage, dir);
d.fast = argv.includes("--fast");
const voiceFile = path.join(DEMO, "voice", "voice.json");
if (fs.existsSync(voiceFile)) for (const [id, v] of Object.entries(JSON.parse(fs.readFileSync(voiceFile, "utf8")).lines as Record<string, { dur: number }>)) d.voice[id] = v.dur;

const say = (id: keyof typeof LINES): void => d.say(id, LINES[id]);
const P = <T,>(fn: string): Promise<T> => page.evaluate(`(async () => { const p = window.planner; return (${fn})(p); })()`) as Promise<T>;
const tid = (id: string) => page.getByTestId(id);

let splitY = 0;
class Stop extends Error {}
const scene = (n: string): void => {
	d.mark("scene:" + n);
	console.log(`[film] ${d.now().toFixed(1)}s  ${n}`);
};
const done = (n: string): void => {
	if (until === n) throw new Stop();
};
function check(ok: unknown, what: string): asserts ok {
	if (!ok) console.log("[film] state:", JSON.stringify(lastClips));
	if (!ok) throw new Error("Not as planned: " + what);
}

// ---- where things are on the timeline -------------------------------------------------------
type Clip = { id: string; trackId: string; lane: number; startBeat: number; offsetBeat: number; lengthBeat: number; lowCut?: boolean; fadeOutBeat?: number; fadeInBeat?: number };
let lastClips: unknown = null;
const clips = async (): Promise<(Clip & { name: string })[]> =>
	(lastClips = await d.st("s => s.doc.clips.map(c => ({ ...c, name: s.doc.tracks.find(t => t.id === c.trackId).name })).sort((a, b) => a.startBeat - b.startBeat)")) as (Clip & { name: string })[];
const clipsOf = async (part: string): Promise<(Clip & { name: string })[]> => (await clips()).filter((c) => c.name.includes(part));
const clipEl = (id: string) => page.locator(`[data-testid="clip"][data-clip-id="${id}"]`);
const near = (a: number, b: number, tol = 0.6): boolean => Math.abs(a - b) <= tol;
// Screen x of a beat, and the middle of a lane.
async function beatX(beat: number): Promise<number> {
	const box = (await tid("timeline").boundingBox())!;
	const v = await d.st<{ ppb: number; sx: number }>("s => ({ ppb: s.pxPerBeat, sx: s.scrollX })");
	return box.x + beat * v.ppb - v.sx;
}
async function laneY(n: number, f = 0.55): Promise<number> {
	const b = (await tid(`lane-${n}`).boundingBox())!;
	return b.y + b.height * f;
}
const ready = (): Promise<unknown> =>
	page.waitForFunction(
		() => {
			const p = (window as any).planner;
			const els = Array.from(document.querySelectorAll('[data-testid="clip"]')) as HTMLElement[];
			return document.querySelector('[data-testid="working"]') === null && document.querySelector('[data-testid="tempo-working"]') === null && els.every((e) => e.dataset.status === "ready") && p.tempoProgress(p.store.get().doc).left === 0;
		},
		undefined,
		{ timeout: 600000, polling: 100 },
	);
// Waits until the set has `n` clips and all their audio is ready.
const landed = (n: number): Promise<unknown> => page.waitForFunction((k) => (window as any).planner.store.get().doc.clips.length === k, n, { polling: 50, timeout: 30000 }).then(ready);
const fit = async (): Promise<void> => {
	await d.click(page.locator(".zoom button", { hasText: "Fit" }));
	await d.wait(450);
};
const libRow = (title: string) => page.locator('[data-testid="library-row"]', { has: page.locator(".library-title", { hasText: title }) }).first();

// ---- before the camera rolls ------------------------------------------------------------------
await answerSaveDialog(stage, path.join(dir, "world", "Friday night.wav"));
await P(`p => { p.store.set({ libraryOpen: false }); return p.openSet(${JSON.stringify(SATURDAY)}); }`);
await ready();
await page.locator(".zoom button", { hasText: "Fit" }).click();
await P(`p => p.engine.seek(346)`);
await page.mouse.move(1180, 716);
await d.wait(1200);
(d as any).pos = { x: 1180, y: 716 };

try {
	await d.start();

	// ================= A. Cold open: the finished set, playing ======================================
	scene("open");
	{
		const x = await beatX(378);
		d.cam(frame16x9({ x: x - 330, y: 52, w: 760, h: 430 }, 760), true);
		await P(`p => p.engine.play()`);
		// The film starts once the music is running.
		await d.wait(800);
		(d.log as { begin?: number }).begin = d.now();
		await d.wait(1300);
		say("a1");
		await d.wait(2600);
		d.cam(null);
		await d.said(0.45);
		say("a2");
		await d.wait(350);
		d.mark("title:in");
		await d.said(0.45);
		d.music(0, 1.1);
		await d.wait(1150);
		await P(`async p => { p.engine.stop(); await p.goHome(); p.store.set({ libraryOpen: false }); }`);
		await tid("home").waitFor();
		await d.move({ x: 1010, y: 300 }, { dur: 0.05 });
		d.cam(frame16x9({ x: 240, y: 0, w: 960, h: 540 }, 960), true);
		d.music(1, 0.05);
		await d.wait(350);
		d.mark("title:out");
		await d.wait(700);
	}
	done("open");

	// ================= B. Home, a new set ===========================================================
	scene("home");
	{
		say("b1");
		await d.wait(500);
		await d.move(page.locator('[data-testid="set-row"][data-name="Saturday set"]'), { fx: 0.3 });
		await d.wait(900);
		await d.move(page.locator('[data-testid="set-row"][data-name="Opening hour"]'), { fx: 0.34 });
		await d.said(0.3);

		say("b3");
		const row = (n: string) => page.locator(`[data-testid="set-row"][data-name="${n}"]`);
		await d.move(row("Opening hour").getByTestId("set-rename"));
		await d.wait(500);
		await d.click(row("Opening hour").getByTestId("set-duplicate"));
		await tid("duplicate-set-modal").waitFor();
		await d.wait(450);
		await d.click("duplicate-set-confirm");
		await row("Opening hour copy").waitFor();
		check((await d.st<string>("s => s.screen")) === "home", "still on the list after duplicating");
		await d.wait(500);
		await d.click(row("Opening hour copy").getByTestId("set-delete"));
		await tid("delete-set-modal").waitFor();
		await d.wait(450);
		await d.click("delete-set-confirm");
		await row("Opening hour copy").waitFor({ state: "detached" });
		check((await d.st<number>("s => s.sets.length")) === 2, "two sets again");
		await d.said(0.3);

		say("b4");
		await d.wait(200);
		await d.click("open-settings");
		await tid("settings").waitFor();
		await d.wait(400);
		await d.move("export-dir", { fx: 0.3 });
		await d.said(0.3);
		await d.click("settings-back");
		await tid("home").waitFor();
		await d.wait(300);

		say("b2");
		await d.wait(300);
		await d.click("new-set");
		await tid("set-name-input").waitFor();
		d.cam(frame16x9({ x: 0, y: 0, w: 800, h: 450 }, 800));
		const nameBox = (await tid("set-name-input").boundingBox())!;
		await d.move({ x: nameBox.x + nameBox.width + 46, y: nameBox.y + nameBox.height + 34 });
		await d.wait(600);
		await d.type("Friday night");
		await d.wait(350);
		await d.key("Enter");
		await d.wait(350);
		await d.click("project-bpm");
		await d.wait(200);
		await page.keyboard.press("Meta+A");
		await d.type("150");
		await d.wait(300);
		await d.key("Enter");
		await d.said(0.3);
		check((await d.st<string>("s => s.setName")) === "Friday night" && (await d.st<number>("s => s.doc.bpm")) === 150, "the new set's name and tempo");
	}
	done("home");

	// ================= C. The library ================================================================
	scene("library");
	{
		await d.click("library-toggle");
		await tid("library-row").first().waitFor();
		await d.wait(300);
		say("c1");
		await d.wait(900);
		await d.click("library-playlist");
		await tid("playlist-menu").waitFor();
		await d.wait(700);
		await d.move(tid("playlist-option").nth(5), { fx: 0.4 });
		await d.wait(500);
		await d.move(tid("playlist-option").nth(9), { fx: 0.45 });
		await d.wait(400);
		await d.type("set t");
		await d.wait(450);
		await d.click(page.locator('[data-testid="playlist-option"]', { hasText: "Set Time" }).first(), { fx: 0.3 });
		await d.wait(400);
		check((await tid("library-row").count()) === 8, "the playlist's 8 tracks");
		await d.said(0.35);

		say("c3");
		// The sort menu is a system menu, which can not be filmed: the choice is made directly.
		await d.move("library-sort", { fx: 0.4 });
		await d.wait(120);
		d.log.buttons.push({ t: d.now(), down: true });
		await d.wait(80);
		d.log.buttons.push({ t: d.now(), down: false });
		await tid("library-sort").selectOption("bpm");
		await d.wait(700);
		await d.click("library-sort-dir");
		await d.wait(600);
		const starRow = libRow("Ground Pound");
		await d.move(starRow, { fx: 0.5, fy: 0.4 });
		await d.wait(250);
		await d.click(starRow.getByTestId("library-star"));
		await d.wait(300);
		check((await d.st<number>("s => s.starred.length")) === 1 && (await d.st<string>("s => s.librarySort.by")) === "bpm", "sorted by BPM, one track starred");
		await d.said(0.35);

		say("c2");
		await d.click("library-search");
		await d.wait(150);
		await d.type("woo");
		await d.wait(750);
		await d.key("Escape");
		await d.wait(150);
		await d.click("library-filter");
		await tid("filter-menu").waitFor();
		await d.wait(250);
		await d.click(page.locator('[data-testid="filter-key"]', { hasText: /^2A$/ }));
		await d.wait(300);
		await d.click("filter-bpm-min");
		await d.type("150");
		await d.wait(450);
		await d.key("Escape");
		await d.wait(250);
		const dfm = libRow("Don't Forget Me");
		await d.move(dfm, { fx: 0.45, fy: 0.45 });
		await d.wait(350);
		await d.click(dfm.getByTestId("library-bar"), { fx: 0.548, fy: 0.6 });
		await d.said(0.1);
		await d.wait(4600);
		d.music(0, 0.5);
		await d.wait(520);
		await d.click(dfm.getByTestId("library-stop"));
		d.music(1, 0.05);
		await d.wait(300);
	}
	done("library");

	// ================= D. Onto the timeline ===========================================================
	scene("drag");
	{
		say("d1");
		d.cam(null);
		await d.wait(350);
		const dfm = libRow("Don't Forget Me");
		await d.drag(dfm, { x: (await beatX(0)) + 2, y: await laneY(1) }, { fromAt: { fx: 0.4, fy: 0.35 }, settle: 220 });
		await d.patience(() => landed(1));
		const c = (await clipsOf("Forget"))[0];
		check(c && c.lane === 1 && near(c.startBeat - c.offsetBeat, 0, 0.1), "Don't Forget Me on lane 2 at the start");
		await d.said(0.2);
		await fit();
		say("d2");
		await d.camOn([{ x: await beatX(250), y: (await laneY(1, 0)) - 20 }, { x: await beatX(470), y: await laneY(1, 1) }], 30, 640);
		await d.move({ x: (await beatX(352)) + 6, y: await laneY(1, 0.3) });
		await d.wait(1500);
		await d.move({ x: (await beatX(448)) + 6, y: await laneY(1, 0.34) });
		await d.said(0.3);
		say("d3");
		d.cam(null);
		const gp = libRow("Ground Pound");
		await d.drag(gp, { x: (await beatX(0)) + 2, y: await laneY(0) }, { fromAt: { fx: 0.4, fy: 0.35 }, settle: 220 });
		await d.patience(() => landed(2));
		const g = (await clipsOf("Ground"))[0];
		check(g && g.lane === 0 && near(g.startBeat - g.offsetBeat, 0, 0.1), "Ground Pound on lane 1 at the start");
		await d.said(0.2);
		await d.click("library-toggle");
		await d.wait(350);
		await fit();
	}
	done("drag");

	// ================= E. Shaping the transition =========================================================
	scene("shape");
	{
		say("e1");
		let dfm = (await clipsOf("Forget"))[0];
		// Trim Don't Forget Me back to its drop (hot cue C, beat 352 of the track).
		await d.drag({ x: (await beatX(dfm.startBeat)) + 2.5, y: await laneY(1, 0.6) }, { x: await beatX(352), y: await laneY(1, 0.62) }, { settle: 200 });
		dfm = (await clipsOf("Forget"))[0];
		check(near(dfm.offsetBeat, 352), `trim to the drop (offset ${dfm.offsetBeat})`);
		await d.wait(250);
		// Slide it back so it comes in at beat 200.
		const grabX = (await beatX(dfm.startBeat)) + 150;
		await d.drag({ x: grabX, y: await laneY(1, 0.6) }, { x: grabX - ((await beatX(152)) - (await beatX(0))), y: await laneY(1, 0.6) }, { settle: 200 });
		dfm = (await clipsOf("Forget"))[0];
		check(near(dfm.startBeat, 200), `slide to beat 200 (at ${dfm.startBeat})`);
		await d.wait(250);
		// Ground Pound ends where the mix is over.
		let gp = (await clipsOf("Ground"))[0];
		await d.drag({ x: (await beatX(gp.startBeat + gp.lengthBeat)) - 2.5, y: await laneY(0, 0.6) }, { x: await beatX(232), y: await laneY(0, 0.62) }, { settle: 200 });
		gp = (await clipsOf("Ground"))[0];
		check(near(gp.startBeat + gp.lengthBeat, 232), `end the first track at 232 (at ${gp.startBeat + gp.lengthBeat})`);
		await d.said(0.2);
		// Closer in on the timeline for the detail work.
		await fit();
		await d.move({ x: await beatX(226), y: await laneY(1, 0.2) });
		await d.wheel(-72, true);
		await d.wait(500);

		say("e2");
		await d.camOn([{ x: await beatX(176), y: await laneY(0, 0) - 96 }, { x: await beatX(262), y: await laneY(1, 1) }], 20, 800);
		await d.click({ x: await beatX(200), y: (await tid("ruler").boundingBox())!.y + 16 });
		await d.wait(300);
		await d.click({ x: await beatX(178), y: await laneY(0, 0.6) });
		await d.wait(300);
		await d.key("Meta+S", "⌘ S");
		await d.wait(600);
		let gps = await clipsOf("Ground");
		check(gps.length === 2 && near(gps[1].startBeat, 200), "split the first track at 200");
		await d.click({ x: await beatX(216), y: await laneY(0, 0.6) });
		await d.wait(300);
		await d.key("Meta+B", "⌘ B");
		await d.wait(500);
		gps = await clipsOf("Ground");
		check(gps[1].lowCut === true && !gps[0].lowCut, "bass cut on the tail only");
		await d.said(0.3);

		say("e3");
		// The fade-out dot sits on the clip's top right corner.
		const tail = (await clipEl(gps[1].id).boundingBox())!;
		await d.move({ x: tail.x + tail.width - 14, y: tail.y + 40 });
		await d.wait(200);
		await d.drag({ x: tail.x + tail.width, y: tail.y + 19 }, { x: await beatX(216), y: tail.y + 22 }, { settle: 200 });
		gps = await clipsOf("Ground");
		check(near(gps[1].fadeOutBeat ?? 0, 16), `a 16-beat fade out (${gps[1].fadeOutBeat})`);
		await d.said(0.3);

		say("e4");
		d.cam(null);
		await d.click({ x: await beatX(196), y: (await tid("ruler").boundingBox())!.y + 16 });
		await d.wait(350);
		await d.key("Space", "Space");
		await d.said(0);
		await d.wait(2600);
		say("e5");
		await d.move({ x: await beatX(246), y: await laneY(2, 0.4) });
		await d.said(0.5);

		say("e6");
		// The breakdown: beats 416 to 448 of the track, between its memory cue and hot cue H.
		dfm = (await clipsOf("Forget"))[0];
		const at = (b: number): number => dfm.startBeat + (b - dfm.offsetBeat);
		await d.camOn([{ x: await beatX(at(416) - 50), y: await laneY(1, 0) - 30 }, { x: await beatX(at(448) + 70), y: await laneY(1, 1) }], 20, 760);
		await d.move({ x: await beatX(at(416)), y: await laneY(1, 0.6) });
		await d.wait(200);
		d.log.keys.push({ t: d.now(), label: "S" });
		await page.keyboard.down("s");
		await d.wait(350);
		await d.click();
		await d.wait(300);
		await d.click({ x: await beatX(at(448)), y: await laneY(1, 0.62) });
		await d.wait(250);
		await page.keyboard.up("s");
		await d.wait(250);
		let dfms = await clipsOf("Forget");
		check(dfms.length === 3 && near(dfms[1].offsetBeat, 416) && near(dfms[2].offsetBeat, 448), `two cuts around the breakdown (${dfms.map((c) => c.offsetBeat)})`);
		await d.click({ x: await beatX(at(432)), y: await laneY(1, 0.6) });
		await d.wait(250);
		await d.key("Backspace", "⌫");
		await d.wait(450);
		dfms = await clipsOf("Forget");
		check(dfms.length === 2, "the breakdown deleted");
		const gx = (await beatX(dfms[1].startBeat)) + 90;
		await d.drag({ x: gx, y: await laneY(1, 0.6) }, { x: gx - ((await beatX(32)) - (await beatX(0))), y: await laneY(1, 0.6) }, { settle: 200 });
		dfms = await clipsOf("Forget");
		check(near(dfms[1].startBeat, dfms[0].startBeat + dfms[0].lengthBeat), "the gap closed");
		await d.said(0.2);
		d.cam(null);
		// Let the bass swap at 232 be heard before stopping.
		await page.waitForFunction(() => (window as any).planner.engine.positionBeat() >= 240 || !(window as any).planner.store.get().playing, undefined, { polling: 50, timeout: 60000 });
		d.music(0, 0.6);
		await d.wait(620);
		await d.key("Space", "Space");
		d.music(1, 0.05);
		await d.wait(400);

		say("e7");
		const count = async (): Promise<number> => (await clips()).length;
		const n0 = await count();
		await d.camOn([{ x: await beatX(176), y: (await laneY(0, 0)) - 96 }, { x: await beatX(290), y: await laneY(1, 1) }], 20, 800);
		await d.click({ x: await beatX(216), y: await laneY(0, 0.6) });
		await d.wait(250);
		await d.key("Meta+C", "⌘ C");
		await d.wait(350);
		await d.click({ x: await beatX(264), y: (await tid("ruler").boundingBox())!.y + 16 });
		await d.wait(250);
		await d.key("Meta+V", "⌘ V");
		await d.wait(600);
		check((await count()) === n0 + 1, "a pasted clip");
		await d.key("Meta+D", "⌘ D");
		await d.wait(600);
		check((await count()) === n0 + 2, "a duplicated clip");
		await d.key("Meta+Z", "⌘ Z");
		await d.wait(450);
		await d.key("Meta+Z", "⌘ Z");
		await d.wait(450);
		check((await count()) === n0, "both undone");
		await d.untilLeft(4.2);
		d.cam(frame16x9({ x: 0, y: (await laneY(0, 0)) - 110, w: 800, h: 450 }, 800));
		await d.wait(500);
		await d.click("mute-1");
		await d.wait(900);
		check((await d.st<boolean[]>("s => s.laneMuted"))[1] === true, "lane 2 muted");
		await d.click("mute-1");
		await d.wait(300);
		check((await d.st<boolean[]>("s => s.laneMuted")).every((m) => !m), "no lane muted");
		await d.said(0.3);
		d.cam(null);
	}
	done("shape");

	// ================= F. Tempo ===========================================================================
	scene("tempo");
	{
		say("f1");
		const lane = (await tid("tempo-lane").boundingBox())!;
		await d.wait(500);
		await d.dblclick({ x: await beatX(296), y: lane.y + lane.height * 0.62 });
		await tid("tempo-bpm").waitFor();
		await d.wait(500);
		await d.type("160");
		await d.wait(300);
		await d.key("Enter");
		await d.wait(500);
		let tempos = await d.st<{ startBeat: number; lengthBeat: number; bpm: number }[]>("s => s.doc.tempos");
		check(tempos.length === 1 && near(tempos[0].startBeat, 296) && tempos[0].bpm === 160, `a change to 160 at beat 296 (${JSON.stringify(tempos)})`);
		await d.camOn([{ x: await beatX(262), y: lane.y - 70 }, { x: await beatX(352), y: await laneY(1, 0.9) }], 20, 800);
		const block = (await tid("tempo-block").boundingBox())!;
		await d.drag({ x: block.x + block.width - 2, y: block.y + block.height * 0.6 }, { x: await beatX(328), y: block.y + block.height * 0.62 }, { settle: 220 });
		tempos = await d.st("s => s.doc.tempos");
		check(near(tempos[0].lengthBeat, 32), `a 32-beat ramp (${tempos[0].lengthBeat})`);
		await d.said(0.2);
		say("f2");
		d.cam(null);
		await d.move({ x: await beatX(316), y: (await tid("ruler").boundingBox())!.y + 16 });
		await d.patience(ready, 1.6);
		await d.said(0.1);
		await d.camOn(["position", { x: await beatX(300), y: lane.y + lane.height }], 30, 800);
		await d.click();
		await d.wait(1100);
		d.cam(null);
		await fit();
	}
	done("tempo");

	// ================= G. A file that is not in Rekordbox =====================================================
	scene("file");
	{
		say("g1");
		await d.move({ x: await beatX(300), y: await laneY(2, 0.5) });
		await d.wait(600);
		const before = (await clips()).length;
		void P(`p => p.importPaths([${JSON.stringify(TEMPERATURE)}], 2, 264)`);
		await tid("import-modal").waitFor();
		await d.camOn("import-modal", 170, 900);
		await d.move("bpm-input", { fx: 0.6 });
		await d.untilLeft(2.6);
		await d.click("bpm-confirm");
		d.cam(null);
		await d.patience(() => landed(before + 1), 1.8);
		await d.said(0.3);
	}
	done("file");

	// ================= H. The track editor ====================================================================
	scene("editor");
	{
		say("h1");
		// More room for the editor: pull the divider up.
		splitY = (await tid("split-handle").boundingBox())!.y;
		await d.drag("split-handle", { x: 720, y: 410 }, { fromAt: { fx: 0.5 }, settle: 200 });
		await d.wait(250);
		const temp = (await clipsOf("Temperature"))[0];
		check(temp, "the dropped file on the timeline");
		const box = (await clipEl(temp.id).boundingBox())!;
		await d.click({ x: box.x + box.width * 0.4, y: box.y + box.height * 0.6 }, { button: "right" });
		await tid("clip-menu").waitFor();
		await d.wait(450);
		await d.click("menu-edit");
		await tid("edit-row").waitFor();
		await page.waitForFunction(() => !(document.querySelector('[data-testid="edit-play"]') as HTMLButtonElement)?.disabled, undefined, { timeout: 120000 });
		await d.wait(500);
		const row = (await tid("edit-row").boundingBox())!;
		const ex = async (beat: number): Promise<number> => row.x + beat * (await P<number>("p => p.editPx(p.store.get().trackEdit)")) - (await d.st<number>("s => s.trackEdit.scrollX"));
		const ey = row.y + row.height * 0.5;
		await d.click({ x: await ex(64), y: ey });
		await d.wait(250);
		await d.click("edit-cut");
		await d.wait(350);
		await d.click({ x: await ex(96), y: ey });
		await d.wait(250);
		await d.click("edit-cut");
		await d.wait(350);
		let secs = await d.st<{ id: string; startBeat: number; lengthBeat: number; atBeat: number }[]>("s => s.trackEdit.sections");
		check(secs.length === 3, `three sections in the editor (${JSON.stringify(secs)})`);
		await d.click({ x: await ex(80), y: ey });
		await d.wait(300);
		await d.click("edit-delete");
		await d.wait(450);
		secs = await d.st("s => s.trackEdit.sections");
		check(secs.length === 2, "the middle section deleted");
		const last = secs.sort((a, b) => a.atBeat - b.atBeat)[1];
		if (last.atBeat > 64.5) {
			const gx = (await ex(last.atBeat)) + 120;
			await d.drag({ x: gx, y: ey }, { x: gx - ((await ex(last.atBeat)) - (await ex(64))), y: ey }, { settle: 200 });
			secs = await d.st("s => s.trackEdit.sections");
			check(secs.some((x) => near(x.atBeat, 64)), `the rest moved up (${JSON.stringify(secs)})`);
		}
		await d.said(0.3);
		say("h2");
		await d.click("edit-export");
		await d.patience(() => tid("edit-exported").waitFor({ timeout: 120000 }), 1.6);
		await d.move("edit-exported", { fx: 0.5 });
		await d.said(0.4);
		await d.click("edit-close");
		await d.wait(400);
	}
	done("editor");

	// ================= I. Playlist mode: CDJ edits and Rekordbox sync ==========================================
	scene("playlist");
	{
		say("i1");
		await d.wait(300);
		await d.click("playlist-mode");
		await tid("toolbar").waitFor();
		await tid("to-edit").waitFor();
		await d.said(0.3);

		say("i2");
		await d.camOn(["to-edit", { x: await beatX(180), y: await laneY(1, 1) }], 30, 1100);
		await d.move("to-edit", { fx: 0.4 });
		await d.wait(900);
		const red = page.locator('[data-testid="clip"][data-to-edit="true"]').last();
		const rb = (await red.boundingBox())!;
		await d.click({ x: rb.x + Math.min(rb.width * 0.5, 220), y: rb.y + rb.height * 0.6 }, { button: "right" });
		await tid("clip-menu").waitFor();
		await d.wait(500);
		d.cam(null);
		await d.click("menu-auto-edit");
		await tid("edit-row").waitFor();
		await page.waitForFunction(() => !(document.querySelector('[data-testid="edit-play"]') as HTMLButtonElement)?.disabled, undefined, { timeout: 120000 });
		await d.wait(900);
		await d.click("edit-export");
		await d.patience(() => page.waitForFunction(() => (window as any).planner.store.get().trackEdit === null, undefined, { timeout: 120000, polling: 50 }).then(ready), 1.6);
		const dfms = await clipsOf("Forget");
		check(dfms.length === 1 && dfms[0].name.includes("(edit)") && (await tid("to-edit").count()) === 0, `one clip of the new edit (${JSON.stringify(dfms.map((c) => c.name))})`);
		await d.said(0.4);
		await d.drag("split-handle", { x: 720, y: splitY }, { fromAt: { fx: 0.5 }, settle: 200 });
		await d.wait(250);

		say("i3");
		await d.camOn(["sync-playlist", "cue-tools"], 40, 960);
		await d.click("sync-playlist");
		await tid("sync-menu").waitFor();
		await d.wait(350);
		await d.type("Friday night");
		await d.wait(450);
		await d.click("sync-create");
		await page.waitForFunction(() => /Sync \d+ track/.test(document.querySelector('[data-testid="sync-go"]')?.textContent ?? ""), undefined, { timeout: 30000 });
		await d.wait(600);
		await d.click("sync-go");
		await d.patience(() => page.waitForFunction(() => document.querySelector('[data-testid="sync-go"]')?.textContent === "Synced", undefined, { timeout: 120000 }), 1.6);
		await d.said(0.4);
	}
	done("playlist");

	// ================= J. Cues ====================================================================================
	scene("cues");
	{
		say("j1");
		const gpPath = await d.st<string>("s => s.doc.tracks.find(t => t.name.includes('Ground')).sourcePath");
		const cueCount = (): Promise<number> => d.st(`s => (s.cues[${JSON.stringify(gpPath)}] ?? []).length`);
		const n0 = await cueCount();
		await d.camOn(["cue-tools", { x: await beatX(40), y: await laneY(0, 1) }, { x: await beatX(190), y: await laneY(0, 1) }], 30, 900);
		await d.click("cue-tool-memory");
		await d.wait(300);
		await d.click({ x: await beatX(64), y: await laneY(0, 0.6) });
		await page.waitForFunction(([p, n]) => ((window as any).planner.store.get().cues[p as string] ?? []).length === (n as number) + 1, [gpPath, n0] as const, { timeout: 20000 });
		await d.wait(450);
		await d.click("cue-tool-E");
		await d.wait(300);
		await d.click({ x: await beatX(144), y: await laneY(0, 0.62) });
		await page.waitForFunction(([p, n]) => ((window as any).planner.store.get().cues[p as string] ?? []).length === (n as number) + 2, [gpPath, n0] as const, { timeout: 20000 });
		await d.wait(450);
		await d.click("cue-tool-E");
		await d.said(0.4);
		d.cam(null);
		await d.click("playlist-mode");
		await d.wait(300);
	}
	done("cues");

	// ================= K. Tags ====================================================================================
	scene("tags");
	{
		await d.click("library-toggle");
		await tid("library-row").first().waitFor();
		say("k1");
		d.cam(frame16x9({ x: 0, y: 0, w: 800, h: 450 }, 800));
		await d.click("library-filter");
		await tid("filter-menu").waitFor();
		await d.wait(300);
		await d.click("tag-mode");
		await d.wait(450);
		await d.click(page.locator('[data-testid="quick-tag"]', { hasText: "Melodic AF" }));
		await d.wait(400);
		await d.key("Escape");
		await d.wait(350);
		await d.click(libRow("Ground Pound").getByTestId("ghost-tag").first());
		await d.wait(450);
		await d.click(libRow("Don't Forget Me").getByTestId("ghost-tag").first());
		await d.wait(300);
		check((await libRow("Ground Pound").getByTestId("quick-tag-on").count()) === 1 && (await libRow("Don't Forget Me").getByTestId("quick-tag-on").count()) === 1, "two tracks tagged");
		await d.said(0.4);
		d.cam(null);
		await d.click("library-toggle");
		await d.wait(300);
	}
	done("tags");

	// ================= L. Export the mix ===========================================================================
	scene("export");
	{
		say("l1");
		await d.wait(300);
		await d.click("export");
		await tid("export-modal").waitFor();
		await d.camOn("export-modal", 150, 900);
		await d.wait(900);
		await d.click("export-go");
		await d.move({ x: VIEW_W / 2 + 120, y: VIEW_H / 2 + 150 });
		await d.patience(() => tid("export-done").waitFor({ timeout: 600000 }), 2.4);
		await d.said(0.3);
		await d.wait(900);
		await d.click("export-close");
		d.cam(null);
		await d.wait(400);
	}
	done("export");

	// ================= M. Back to the finished set ====================================================================
	scene("outro");
	{
		await d.click("all-sets");
		await tid("home").waitFor();
		await P(`p => p.store.set({ libraryOpen: false })`);
		d.cam(frame16x9({ x: 300, y: 0, w: 840, h: 472 }, 840));
		await d.wait(500);
		say("m1");
		await d.move(page.locator('[data-testid="set-row"][data-name="Friday night"]'), { fx: 0.3 });
		await d.wait(1100);
		await d.untilLeft(2.2);
		await d.click(page.locator('[data-testid="set-row"][data-name="Saturday set"]'), { fx: 0.3 });
		// The set opens and settles out of sight; the film picks up with it ready.
		d.cutStart();
		await tid("timeline").waitFor();
		await ready();
		await page.evaluate(() => (Array.from(document.querySelectorAll(".zoom button")).find((b) => b.textContent === "Fit") as HTMLElement).click());
		await P(`p => p.engine.seek(680)`);
		d.cam(null, true);
		await d.wait(700);
		d.cutEnd();
		await d.wait(450);
		await d.key("Space");
		await d.move({ x: 1130, y: 722 });
		await d.said(0.2);
		d.mark("outro");
		await d.wait(7500);
	}
	done("outro");

	scene("end");
	await d.wait(500);
} catch (e) {
	if (!(e instanceof Stop)) {
		console.log("[film] FAILED:", e);
		process.exitCode = 1;
	}
} finally {
	d.mark("end");
	await d.finish();
	await stage.close();
	console.log(`[film] take ${name}: ${d.log.frames.length} frames, ${d.now().toFixed(1)}s`);
}
