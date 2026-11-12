import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";

export const APP_DIR = path.resolve(__dirname, "../..");
export const SHOTS = path.join(APP_DIR, "tests/e2e/shots");

export type Harness = { app: ElectronApplication; page: Page; dataDir: string; workDir: string; close: () => Promise<void>; relaunch: () => Promise<Harness> };

export async function launch(dataDir?: string, workDir?: string, env: Record<string, string> = {}): Promise<Harness> {
	const data = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "planner-data-"));
	const work = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "planner-work-"));
	fs.mkdirSync(SHOTS, { recursive: true });
	const app = await _electron.launch({ args: [APP_DIR], cwd: APP_DIR, env: { ...process.env, ...env, DJ_PLANNER_DATA: data } });
	const page = await app.firstWindow();
	page.on("console", (m) => {
		if (m.type() === "error") console.log("[renderer error]", m.text());
	});
	page.on("pageerror", (e) => console.log("[page error]", e.message));
	await page.waitForFunction(() => (window as any).planner?.store.get().loaded === true, undefined, { polling: 100 });
	const h: Harness = {
		app,
		page,
		dataDir: data,
		workDir: work,
		close: () => app.close(),
		relaunch: async () => {
			await app.close();
			return launch(data, work, env);
		},
	};
	return h;
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

export async function exportTo(page: Page, out: string, keyLock: boolean): Promise<void> {
	await page.evaluate(([o, k]) => {
		const p = (window as any).planner;
		p.store.set({ exportUi: { phase: "options" } });
		return p.runExport(k, o);
	}, [out, keyLock] as const);
}
