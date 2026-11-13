// Sets are kept by the app itself: it opens on the list of them, every change is stored as
// it is made, and there is never a file to save or a folder to pick. The stretched audio
// behind them is shared between sets and cleaned up once no recent set needs it.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testDir } from "../testdata";
import { writeClickTrack } from "../signals";
import { importTrack, launch, setFile, shot, state, stored, waitReady, waitTempoReady, type Harness } from "./harness";

let h: Harness;
const extraDirs: string[] = [];

afterAll(async () => {
	await h?.close();
	for (const dir of extraDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const setFiles = (): string[] => fs.readdirSync(path.join(h.dataDir, "sets")).filter((f) => f.endsWith(".json"));
const onDisk = (id: string): any => JSON.parse(fs.readFileSync(setFile(h, id), "utf8"));
const rows = (): Promise<string[]> => h.page.locator('[data-testid="set-row"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name ?? ""));
const row = (name: string) => h.page.locator(`[data-testid="set-row"][data-name="${name}"]`);
const clips = (): Promise<any[]> => state(h.page, "s => s.doc.clips");

describe("sets kept by the app", () => {
	let id = "";

	it("opens on the list of sets, which is empty the first time", async () => {
		h = await launch(undefined, undefined, {}, { home: true });
		await h.page.getByTestId("home").waitFor();
		await h.page.getByTestId("home-empty").waitFor();
		expect(await rows()).toEqual([]);
		expect(setFiles()).toEqual([]);
		await shot(h.page, "sets-01-empty");
	});

	it("keeps a new set as soon as there is something in it, with nothing to save", async () => {
		await h.page.getByTestId("new-set").click();
		// a new set asks for its name right away; leaving it blank keeps the automatic name
		const ask = h.page.getByTestId("set-name-input");
		await ask.waitFor();
		expect(await ask.evaluate((el) => el === document.activeElement)).toBe(true);
		await h.page.keyboard.press("Escape");
		await h.page.getByTestId("set-name").waitFor();
		expect(await h.page.getByTestId("home").count()).toBe(0);
		// an untouched new set leaves nothing behind
		await h.page.waitForTimeout(900);
		expect(setFiles()).toEqual([]);
		// a new set starts at 150 BPM; the rest of these cases are written around 128
		expect(await h.page.getByTestId("project-bpm").inputValue()).toBe("150");
		await state(h.page, "s => { window.planner.store.commit({ ...s.doc, bpm: 128 }); return 0; }");
		const a = path.join(h.workDir, "clicks.wav");
		writeClickTrack(a, 128, 30);
		await importTrack(h.page, a, 128, 0, 0);
		// stored by itself, a moment after the change
		await expect.poll(() => setFiles().length, { timeout: 5000 }).toBe(1);
		id = await stored(h.page);
		const s = onDisk(id);
		expect(s.name).toMatch(/^Set \d{4}-\d\d-\d\d \d\d\.\d\d$/);
		expect(s.doc.clips.length).toBe(1);
		await expect.poll(() => h.page.getByTestId("set-name").textContent()).toBe(s.name);
		await expect.poll(() => h.page.title()).toBe(s.name);
		await waitReady(h.page);
	});

	it("renames the open set from the top bar", async () => {
		await h.page.getByTestId("set-name").click();
		await h.page.getByTestId("set-name-input").fill("Friday");
		// typing a name, spaces included, does not play, split or delete anything
		await h.page.keyboard.type(" warm-up");
		expect(await h.page.getByTestId("set-name-input").inputValue()).toBe("Friday warm-up");
		expect(await state(h.page, "s => s.playing")).toBe(false);
		await h.page.keyboard.press("Enter");
		await expect.poll(() => onDisk(id).name, { timeout: 5000 }).toBe("Friday warm-up");
		expect(await h.page.getByTestId("set-name").textContent()).toBe("Friday warm-up");
		expect((await clips()).length).toBe(1);
		expect(await state(h.page, "s => s.playing")).toBe(false);
		// Escape leaves the name as it was
		await h.page.getByTestId("set-name").click();
		await h.page.getByTestId("set-name-input").fill("Nope");
		await h.page.keyboard.press("Escape");
		expect(await h.page.getByTestId("set-name").textContent()).toBe("Friday warm-up");
		expect((await clips()).length).toBe(1);
	});

	it("goes back to the list and reopens the set where it was left", async () => {
		await h.page.keyboard.press("Meta+=");
		await h.page.evaluate(() => (window as any).planner.engine.seek(8));
		const zoom = await state<number>(h.page, "s => s.pxPerBeat");
		await h.page.getByTestId("all-sets").click();
		await h.page.getByTestId("home").waitFor();
		expect(await rows()).toEqual(["Friday warm-up"]);
		expect(await row("Friday warm-up").textContent()).toContain("1 track");
		expect(await row("Friday warm-up").textContent()).toContain("0:30");
		await shot(h.page, "sets-02-list");
		// keys that act on the timeline do nothing here
		await h.page.keyboard.press("Space");
		await h.page.keyboard.press("Backspace");
		expect(await state(h.page, "s => s.playing")).toBe(false);
		await row("Friday warm-up").click();
		await h.page.getByTestId("set-name").waitFor();
		expect((await clips()).length).toBe(1);
		expect(await state(h.page, "s => s.pxPerBeat")).toBeCloseTo(zoom, 6);
		expect(await state(h.page, "s => s.playheadBeat")).toBe(8);
		await waitReady(h.page);
		expect(await h.page.locator('[data-testid="clip"][data-status="ready"]').count()).toBe(1);
	});

	it("loses nothing when the window is closed right after a change", async () => {
		await h.page.keyboard.press("Home"); // the start of the clip is in view again
		await h.page.locator('[data-testid="clip"]').first().click({ position: { x: 40, y: 30 } });
		await h.page.keyboard.press("Meta+d");
		expect((await clips()).length).toBe(2);
		h = await h.relaunch({ home: true, abrupt: true });
		expect(onDisk(id).doc.clips.length).toBe(2);
		// the app is back on the list, with the set in it
		await h.page.getByTestId("home").waitFor();
		expect(await rows()).toEqual(["Friday warm-up"]);
		await row("Friday warm-up").click();
		await expect.poll(async () => (await clips()).length).toBe(2);
	});

	it("Cmd+O goes to the list and Cmd+N starts a set from anywhere", async () => {
		await h.page.keyboard.press("Meta+o");
		await h.page.getByTestId("home").waitFor();
		await h.page.keyboard.press("Meta+n");
		await h.page.getByTestId("set-name-input").waitFor();
		await h.page.keyboard.press("Escape");
		await h.page.getByTestId("set-name").waitFor();
		expect((await clips()).length).toBe(0);
		expect(await h.page.getByTestId("set-name").textContent()).toBe("New set");
		// an empty set that was never touched is not kept
		await h.page.keyboard.press("Meta+o");
		await h.page.getByTestId("home").waitFor();
		expect(await rows()).toEqual(["Friday warm-up"]);
		expect(setFiles().length).toBe(1);
	});

	it("asks for a new set's name right away, and Space types into it", async () => {
		await h.page.getByTestId("new-set").click();
		await h.page.getByTestId("set-name-input").waitFor();
		await h.page.keyboard.type("Late night");
		expect(await state(h.page, "s => s.playing")).toBe(false);
		await h.page.keyboard.press("Enter");
		expect(await h.page.getByTestId("set-name").textContent()).toBe("Late night");
		expect(await h.page.title()).toBe("Late night");
		// a set given a name is kept, even before anything is in it
		await h.page.keyboard.press("Meta+o");
		await h.page.getByTestId("home").waitFor();
		await expect.poll(rows).toEqual(["Late night", "Friday warm-up"]);
		await row("Late night").getByTestId("set-delete").click();
		await h.page.getByTestId("delete-set-confirm").click();
		await expect.poll(rows).toEqual(["Friday warm-up"]);
	});

	it("duplicates, renames and deletes sets from the list", async () => {
		await row("Friday warm-up").getByTestId("set-duplicate").click();
		await expect.poll(rows).toEqual(["Friday warm-up copy", "Friday warm-up"]);
		expect(setFiles().length).toBe(2);
		// rename the copy; opening does not happen while typing
		await row("Friday warm-up copy").getByTestId("set-rename").click();
		await h.page.getByTestId("set-rename-input").fill("Saturday peak");
		await h.page.keyboard.press("Enter");
		await expect.poll(rows).toEqual(["Saturday peak", "Friday warm-up"]);
		expect(await h.page.getByTestId("home").count()).toBe(1);
		// a name that is taken is told apart
		await row("Saturday peak").getByTestId("set-rename").click();
		await h.page.getByTestId("set-rename-input").fill("Friday warm-up");
		await h.page.keyboard.press("Enter");
		await expect.poll(rows).toEqual(["Friday warm-up 2", "Friday warm-up"]);
		// the copy is a set of its own
		await row("Friday warm-up 2").click();
		await expect.poll(async () => (await clips()).length).toBe(2);
		await h.page.keyboard.press("Meta+a");
		await h.page.keyboard.press("Backspace");
		expect((await clips()).length).toBe(0);
		await h.page.getByTestId("all-sets").click();
		await h.page.getByTestId("home").waitFor();
		expect(onDisk(id).doc.clips.length).toBe(2);
		// delete asks once, and Cancel keeps the set
		await row("Friday warm-up 2").getByTestId("set-delete").click();
		await h.page.getByTestId("delete-set-modal").waitFor();
		await h.page.waitForTimeout(200); // the dialog takes the keyboard a moment after it opens
		await h.page.keyboard.press("Escape");
		await h.page.getByTestId("delete-set-modal").waitFor({ state: "detached" });
		expect((await rows()).length).toBe(2);
		await row("Friday warm-up 2").getByTestId("set-delete").click();
		await h.page.getByTestId("delete-set-confirm").click();
		await expect.poll(rows).toEqual(["Friday warm-up"]);
		expect(setFiles()).toEqual([`${id}.json`]);
	});

	it("brings in the sets from before the app kept them itself, once", async () => {
		await h.close();
		const data = testDir("planner-data-");
		const work = testDir("planner-work-");
		extraDirs.push(data, work);
		const doc = (name: string) => ({
			version: 1,
			bpm: 128,
			tracks: [{ id: "t1", sourcePath: path.join(work, `${name}.wav`), name, bpm: 128, durationSec: 30 }],
			clips: [{ id: "c1", trackId: "t1", lane: 0, startBeat: 0, offsetBeat: 0, lengthBeat: 64 }],
			tempos: [],
		});
		// the set that was open last, saved somewhere of the user's choosing
		fs.writeFileSync(path.join(data, "planner-session.json"), JSON.stringify({ doc: doc("open"), filePath: "/somewhere/else/Old Night.djset", dirty: false, pxPerBeat: 20, scrollX: 0, playheadBeat: 4 }));
		// and one the app had auto-saved as a file
		fs.mkdirSync(path.join(data, "sets"));
		fs.writeFileSync(path.join(data, "sets", "Set 2026-01-02 03.04.djset"), JSON.stringify(doc("auto")));
		h = await launch(data, work, {}, { home: true });
		expect((await rows()).sort()).toEqual(["Old Night", "Set 2026-01-02 03.04"]);
		expect(fs.existsSync(path.join(data, "planner-session.json"))).toBe(false);
		await row("Old Night").click();
		await h.page.getByTestId("set-name").waitFor();
		expect((await clips()).length).toBe(1);
		expect(await state(h.page, "s => s.pxPerBeat")).toBe(20);
		expect(await state(h.page, "s => s.playheadBeat")).toBe(4);
		// and not a second time
		h = await h.relaunch({ home: true });
		expect((await rows()).sort()).toEqual(["Old Night", "Set 2026-01-02 03.04"]);
		await h.close();
	});
});

describe("the cache of stretched audio", () => {
	let cache = "";
	let first = "";
	let second = "";
	const wavs = (): string[] => fs.readdirSync(cache).filter((f) => f.endsWith(".wav"));
	const prune = (): Promise<void> => h.page.evaluate(() => (window as any).api.pruneCache());
	// Makes every cached file look as if it was last used `hours` ago.
	const age = (hours: number): void => {
		const t = new Date(Date.now() - hours * 3600e3);
		for (const f of fs.readdirSync(cache)) if (f.endsWith(".wav")) fs.utimesSync(path.join(cache, f), t, t);
	};
	// Makes a set look as if it was last opened and edited `days` ago.
	const ageSet = (id: string, days: number): void => {
		const file = setFile(h, id);
		const s = JSON.parse(fs.readFileSync(file, "utf8"));
		s.openedAt = s.updatedAt = Date.now() - days * 86400e3;
		fs.writeFileSync(file, JSON.stringify(s));
	};
	const goHome = (): Promise<void> => h.page.evaluate(() => (window as any).planner.goHome());
	const open = (id: string): Promise<void> => h.page.evaluate((i) => (window as any).planner.openSet(i), id);

	it("stores a track stretched to one tempo once, however many sets use it", async () => {
		h = await launch();
		cache = path.join(h.dataDir, "planner-cache");
		const a = path.join(h.workDir, "shared.wav");
		writeClickTrack(a, 120, 40);
		await importTrack(h.page, a, 120, 0, 0);
		await waitReady(h.page);
		first = await stored(h.page);
		expect(wavs().length).toBe(1);
		const made = fs.statSync(path.join(cache, wavs()[0])).birthtimeMs;
		await h.page.evaluate(() => (window as any).planner.newSet());
		await importTrack(h.page, a, 120, 0, 0);
		await waitReady(h.page);
		second = await stored(h.page);
		expect(second).not.toBe(first);
		// the second set plays the file the first one made
		expect(wavs().length).toBe(1);
		expect(fs.statSync(path.join(cache, wavs()[0])).birthtimeMs).toBe(made);
	});

	it("drops the audio of a tempo that was tried and given up, after an hour unused", async () => {
		const base = wavs();
		await h.page.evaluate(() => {
			const p = (window as any).planner;
			const d = p.store.get().doc;
			p.store.commit({ ...d, tempos: [{ id: "b1", startBeat: 16, lengthBeat: 16, bpm: 140 }] });
		});
		await waitTempoReady(h.page);
		expect(wavs().length).toBe(3); // the ramp, and the track at 140
		await h.page.keyboard.press("Meta+z");
		await stored(h.page);
		// still fresh: kept, in case the change comes back
		await prune();
		expect(wavs().length).toBe(3);
		age(2);
		await prune();
		expect(wavs()).toEqual(base);
		expect(fs.readdirSync(cache).filter((f) => f.includes(".peaks")).length).toBe(1);
		// the change comes back after all: its audio is simply made again
		// nothing in the window still counts on the files that went
		expect(await h.page.evaluate(() => (window as any).planner.tempoProgress((window as any).planner.store.get().doc).left)).toBe(0);
		await h.page.keyboard.press("Meta+Shift+z");
		expect(await h.page.evaluate(() => (window as any).planner.tempoProgress((window as any).planner.store.get().doc).left)).toBe(2);
		await waitTempoReady(h.page);
		expect(wavs().length).toBe(3);
		expect(await h.page.locator('[data-testid="clip"][data-status="ready"]').count()).toBe(1);
		await h.page.keyboard.press("Meta+z");
		await stored(h.page);
	});

	it("keeps what the sets of the last week need, however long ago it was made", async () => {
		await goHome();
		ageSet(first, 6);
		ageSet(second, 6);
		age(24 * 30);
		await prune();
		expect(wavs().length).toBe(1);
	});

	it("drops the audio of sets not opened for a week, and makes it again when one is opened", async () => {
		ageSet(first, 8);
		ageSet(second, 8);
		await prune();
		expect(wavs()).toEqual([]);
		expect(fs.readdirSync(cache).filter((f) => f.includes(".peaks"))).toEqual([]);
		await open(first);
		await waitReady(h.page);
		expect(wavs().length).toBe(1);
		expect(await h.page.locator('[data-testid="clip"][data-status="ready"]').count()).toBe(1);
	});

	it("never drops what the open set is playing", async () => {
		// the open set looks stale on disk and its audio long unused, and still it stays
		ageSet(first, 30);
		age(24 * 30);
		await prune();
		expect(wavs().length).toBe(1);
		// deleting the other set changes nothing for this one
		await h.page.evaluate((i) => (window as any).api.deleteSet(i), second);
		await prune();
		expect(wavs().length).toBe(1);
	});

	it("holds the cache under its size limit, sparing the open set", async () => {
		await stored(h.page);
		// everything recent and in use, so only the limit can be what removes it
		ageSet(first, 0);
		age(0);
		const data = h.dataDir;
		const work = h.workDir;
		await h.app.close();
		extraDirs.push(data, work);
		// a limit of one byte: at launch nothing is open, so everything goes
		h = await launch(data, work, { DJ_PLANNER_CACHE_CAP: "1" }, { home: true });
		expect(wavs()).toEqual([]);
		await open(first);
		await waitReady(h.page);
		expect(wavs().length).toBe(1);
		await prune();
		expect(wavs().length).toBe(1);
	});
});

describe("the audio a set stops using, cleaned up in the background", () => {
	let cache = "";
	let first = "";
	let second = "";
	let a = "";
	let b = "";
	const wavs = (): string[] => fs.readdirSync(cache).filter((f) => f.endsWith(".wav")).sort();
	const ageSet = (id: string, days: number): void => {
		const file = setFile(h, id);
		const s = JSON.parse(fs.readFileSync(file, "utf8"));
		s.openedAt = s.updatedAt = Date.now() - days * 86400e3;
		fs.writeFileSync(file, JSON.stringify(s));
	};
	// Takes every clip of a track out of the open set.
	const dropTrack = (name: string): Promise<void> =>
		h.page.evaluate((n) => {
			const p = (window as any).planner;
			const d = p.store.get().doc;
			const t = d.tracks.find((x: any) => x.name === n);
			p.store.commit({ ...d, clips: d.clips.filter((c: any) => c.trackId !== t.id) });
		}, name);

	it("drops a track's old tempo once it is restretched", async () => {
		await h?.close();
		h = await launch(undefined, undefined, { DJ_PLANNER_DROP_GRACE_MS: "1500" });
		cache = path.join(h.dataDir, "planner-cache");
		a = path.join(h.workDir, "alpha.wav");
		b = path.join(h.workDir, "beta.wav");
		writeClickTrack(a, 120, 20);
		writeClickTrack(b, 124, 20);
		await importTrack(h.page, a, 120, 0, 0);
		await importTrack(h.page, b, 124, 1, 0);
		await waitReady(h.page);
		first = await stored(h.page);
		const before = wavs();
		expect(before.length).toBe(2);
		await h.page.evaluate(() => {
			const p = (window as any).planner;
			const d = p.store.get().doc;
			p.store.commit({ ...d, tracks: d.tracks.map((t: any) => (t.name === "alpha" ? { ...t, bpm: 121 } : t)) });
		});
		await waitReady(h.page);
		await stored(h.page);
		await expect.poll(wavs, { timeout: 10000 }).toHaveLength(2);
		expect(wavs().filter((f) => before.includes(f)).length).toBe(1);
		expect(await state(h.page, "s => s.playing")).toBe(false);
	});

	it("keeps a removed track's audio while another recent set uses it, and drops it once none does", async () => {
		// a second set that also plays beta
		await h.page.evaluate(() => (window as any).planner.newSet());
		await importTrack(h.page, b, 124, 0, 0);
		await waitReady(h.page);
		second = await stored(h.page);
		await h.page.evaluate((i) => (window as any).planner.openSet(i), first);
		await waitReady(h.page);
		const all = wavs();
		await dropTrack("beta");
		await stored(h.page);
		await h.page.waitForTimeout(3000);
		expect(wavs()).toEqual(all);
		// undo plays at once: nothing was lost
		await h.page.keyboard.press("Meta+z");
		await waitReady(h.page);
		await stored(h.page);
		// the other set has not been opened for over a week: beta's audio goes this time
		ageSet(second, 8);
		await dropTrack("beta");
		await stored(h.page);
		await expect.poll(wavs, { timeout: 10000 }).toHaveLength(all.length - 1);
		// and comes back when it is needed again
		await h.page.keyboard.press("Meta+z");
		await waitReady(h.page);
		expect(wavs()).toEqual(all);
		expect(await h.page.locator('[data-testid="clip"][data-status="ready"]').count()).toBe(2);
	});
});
