import fs from "node:fs";
import path from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { SHOTS, testDir } from "../testdata";

export { SHOTS };
export const APP_DIR = path.resolve(__dirname, "../..");

export type Harness = {
	app: ElectronApplication;
	page: Page;
	dataDir: string;
	workDir: string;
	// Closes the app and deletes the folders this harness made (stretched audio is large).
	close: () => Promise<void>;
	// Closes the app and starts it again on the same data, back in the set that was open.
	// With `home`, it stays on the list of sets the app opens on. With `abrupt`, the app is
	// closed as it stands, without first waiting for the set to be stored.
	relaunch: (opts?: { home?: boolean; abrupt?: boolean }) => Promise<Harness>;
};

// Starts the app on its own data folder, with a new empty set open. With `home`, it is left
// on the list of sets, as the app opens.
export async function launch(dataDir?: string, workDir?: string, env: Record<string, string> = {}, opts: { home?: boolean } = {}): Promise<Harness> {
	const made: string[] = [];
	const temp = (prefix: string): string => {
		const dir = testDir(prefix);
		made.push(dir);
		return dir;
	};
	return start(dataDir ?? temp("planner-data-"), workDir ?? temp("planner-work-"), env, made, opts.home === true);
}

async function start(data: string, work: string, env: Record<string, string>, made: string[], home: boolean): Promise<Harness> {
	fs.mkdirSync(SHOTS, { recursive: true });
	// --mute-audio: everything still plays and can be recorded from the audio graph, but nothing
	// reaches the speakers.
	const app = await _electron.launch({ args: ["--mute-audio", APP_DIR], cwd: APP_DIR, env: { ...process.env, ...env, DJ_PLANNER_DATA: data } });
	const page = await app.firstWindow();
	// And mute the window itself as well, so a test run is never heard.
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.setAudioMuted(true)));
	page.on("console", (m) => {
		if (m.type() === "error") console.log("[renderer error]", m.text());
	});
	page.on("pageerror", (e) => console.log("[page error]", e.message));
	await page.waitForFunction(() => (window as any).planner?.store.get().loaded === true, undefined, { polling: 100 });
	if (!home) await page.evaluate(() => (window as any).planner.newSet());
	return {
		app,
		page,
		dataDir: data,
		workDir: work,
		close: async () => {
			await app.close();
			for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
		},
		relaunch: async (opts = {}) => {
			const id: string | null = await page.evaluate((wait) => (wait ? (window as any).planner.flush() : Promise.resolve()).then(() => (window as any).planner.store.get().setId), !opts.abrupt);
			await app.close();
			const next = await start(data, work, env, made, true);
			if (opts.home) return next;
			const reopened: boolean = await next.page.evaluate(async (setId) => {
				const p = (window as any).planner;
				if (setId && p.store.get().sets.some((s: { id: string }) => s.id === setId)) await p.openSet(setId);
				else await p.newSet();
				return p.store.get().setId === setId;
			}, id);
			if (id && !reopened) console.log("[harness] the set that was open had nothing in it to keep");
			return next;
		},
	};
}

// Where the app keeps a set.
export function setFile(h: Harness, id: string): string {
	return path.join(h.dataDir, "sets", `${id}.json`);
}

// Waits until everything about the open set is stored, and returns its id.
export function stored(page: Page): Promise<string> {
	return page.evaluate(() => (window as any).planner.flush().then(() => (window as any).planner.store.get().setId));
}

export async function shot(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

export function state<T>(page: Page, fn: string): Promise<T> {
	return page.evaluate(`(() => { const s = window.planner.store.get(); return (${fn})(s); })()`) as Promise<T>;
}

// Imports files through the same path a drop takes, answering the BPM prompt for each.
export async function importTrack(page: Page, file: string, bpm: number | string, lane: number, beat: number | null): Promise<void> {
	await page.evaluate(([f, l, b]) => (window as any).planner.importPaths([f], l, b), [file, lane, beat] as const);
	await page.getByTestId("import-modal").waitFor();
	await page.getByTestId("bpm-input").fill(String(bpm));
	await page.getByTestId("bpm-confirm").click();
	await page.getByTestId("import-modal").waitFor({ state: "detached" });
}

export async function waitReady(page: Page, timeout = 300000): Promise<void> {
	await page.waitForFunction(
		() => {
			const els = Array.from(document.querySelectorAll('[data-testid="clip"]'));
			const p = (window as any).planner;
			return p.store.get().doc.tracks.length > 0 && document.querySelector('[data-testid="working"]') === null && els.every((e) => (e as HTMLElement).dataset.status !== "working");
		},
		undefined,
		{ timeout, polling: 200 },
	);
}

// Waits until every clip under a tempo change has the audio it plays there.
export async function waitTempoReady(page: Page, timeout = 300000): Promise<void> {
	await page.waitForFunction(
		() => {
			const p = (window as any).planner;
			return p.tempoProgress(p.store.get().doc).left === 0;
		},
		undefined,
		{ timeout, polling: 200 },
	);
}

export async function exportTo(page: Page, out: string, keyLock: boolean): Promise<void> {
	await page.evaluate(([o, k]) => {
		const p = (window as any).planner;
		p.store.set({ exportUi: { phase: "options" } });
		return p.runExport(k, o);
	}, [out, keyLock] as const);
}
