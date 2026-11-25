// Starts the built app for the demo: muted, on a throwaway copy of the demo's data and of the
// Rekordbox database, with the page laid out at a fixed size whatever the window is, and with
// page-init.js loaded first so the page's sound can be recorded.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { _electron, type CDPSession, type ElectronApplication, type Page } from "playwright";
import { DEMO } from "./paths.ts";

export const APP_DIR = path.resolve(import.meta.dirname, "../..");
// The untouched starting point: data/ (sets and audio caches) and rekordbox/master.db.
export const MASTER = path.join(DEMO, "world-master");
export const RB_ANLZ = path.join(process.env["HOME"]!, "Library/Pioneer/rekordbox/share/PIONEER/USBANLZ");

// The page is laid out at VIEW_W x VIEW_H and drawn at `scale` times that.
export const VIEW_W = 1440;
export const VIEW_H = 810;

export type Stage = { app: ElectronApplication; page: Page; cdp: CDPSession; scale: number; world: string; close: () => Promise<void> };

// A fresh copy of the starting point (file clones, so it is instant and takes no space).
export function freshWorld(dir: string): string {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	execFileSync("cp", ["-c", "-R", MASTER, dir]);
	return dir;
}

export async function openStage(opts: { world: string; scale?: number }): Promise<Stage> {
	const scale = opts.scale ?? 2;
	const data = path.join(opts.world, "data");
	const env = { ...process.env, DJ_PLANNER_DATA: data, DJ_REKORDBOX_DB: path.join(opts.world, "rekordbox", "master.db"), DJ_REKORDBOX_DIR: RB_ANLZ };
	let app: ElectronApplication | null = null;
	for (let attempt = 0; attempt < 3 && !app; attempt++) {
		app = await _electron.launch({ args: ["--mute-audio", APP_DIR], cwd: APP_DIR, env }).catch((e) => (attempt === 2 ? Promise.reject(e) : null));
	}
	const page = await app!.firstWindow();
	// On the external display: its steady refresh rate gives evenly spaced frames.
	await app!.evaluate(({ BrowserWindow, screen }) => {
		const ds = screen.getAllDisplays();
		const d = ds.find((x) => !x.internal) ?? ds[0];
		for (const w of BrowserWindow.getAllWindows()) {
			w.webContents.setAudioMuted(true);
			if (w.isMaximized()) w.unmaximize();
			w.setBounds({ x: d.workArea.x + 40, y: d.workArea.y + 40, width: Math.min(1640, d.workArea.width - 80), height: Math.min(960, d.workArea.height - 80) });
		}
	});
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Page.setBypassCSP", { enabled: true });
	await page.addInitScript({ path: path.join(import.meta.dirname, "page-init.js") });
	await page.reload();
	await page.waitForFunction(() => (window as any).planner?.store.get().loaded === true && (window as any).__demo, undefined, { polling: 100 });
	// After the reload: a reload drops both of these.
	await cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEW_W * scale, height: VIEW_H * scale, deviceScaleFactor: 1, mobile: false });
	if (scale !== 1) await app!.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.setZoomFactor(z)), scale);
	await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [VIEW_W, VIEW_H] as const, { polling: 100, timeout: 10000 });
	page.on("pageerror", (e) => console.log("[page error]", e.message));
	return { app: app!, page, cdp, scale, world: opts.world, close: () => app!.close() };
}

// Answers the app's file dialogs (which can not be filmed or driven) with a fixed path.
export async function answerSaveDialog(stage: Stage, filePath: string): Promise<void> {
	await stage.app.evaluate(({ dialog }, p) => {
		dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
	}, filePath);
}
