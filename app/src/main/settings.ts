// The app's own settings, kept in one small file in its data folder.

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Settings } from "../shared/planner";
import { dataRoot } from "./paths";

// Where the window was and how big, as it was last closed.
export type WindowState = { x: number; y: number; width: number; height: number; maximized?: boolean; fullScreen?: boolean };

type Stored = { version: 1; exportDir?: string; lastSetId?: string | null; window?: WindowState };

const file = (): string => path.join(dataRoot(), "settings.json");

function read(): Stored {
	try {
		const v = JSON.parse(fs.readFileSync(file(), "utf8")) as Stored;
		if (v && v.version === 1) return v;
	} catch {
		// no settings yet
	}
	return { version: 1 };
}

function write(s: Stored): void {
	const tmp = `${file()}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(s));
	fs.renameSync(tmp, file());
}

// Where edited tracks are exported to. Until one is chosen: a folder in Music, or in dev
// (where all data stays in the app's data folder) a folder there.
export function exportDir(): string {
	const chosen = read().exportDir;
	if (typeof chosen === "string" && path.isAbsolute(chosen)) return chosen;
	return app.isPackaged ? path.join(app.getPath("music"), "DJ Utilities Edits") : path.join(dataRoot(), "exports");
}

export function windowState(): WindowState | null {
	const w = read().window;
	if (!w || ![w.x, w.y, w.width, w.height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
	return w;
}

export function saveWindowState(w: WindowState): void {
	try {
		write({ ...read(), window: w });
	} catch (e) {
		console.warn("[settings] could not store the window:", e);
	}
}

const lastSetId = (): string | null => {
	const id = read().lastSetId;
	return typeof id === "string" && id ? id : null;
};

const current = (): Settings => ({ exportDir: exportDir(), lastSetId: lastSetId() });

export function setupSettings(): void {
	ipcMain.handle("settings:get", (): Settings => current());
	ipcMain.handle("settings:set", (_e, patch: Partial<Settings>): Settings => {
		if (patch && typeof patch.exportDir === "string") {
			if (!path.isAbsolute(patch.exportDir)) throw new Error("Not a folder");
			write({ ...read(), exportDir: patch.exportDir });
		}
		if (patch && "lastSetId" in patch) {
			const id = patch.lastSetId;
			if (id !== null && (typeof id !== "string" || !/^[\w-]+$/.test(id))) throw new Error("Not a set");
			write({ ...read(), lastSetId: id });
		}
		return current();
	});
	ipcMain.handle("settings:choose-folder", async (e): Promise<string | null> => {
		const win = BrowserWindow.fromWebContents(e.sender)!;
		const dir = exportDir();
		const r = await dialog.showOpenDialog(win, { defaultPath: fs.existsSync(dir) ? dir : undefined, properties: ["openDirectory", "createDirectory"] });
		return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
	});
}
