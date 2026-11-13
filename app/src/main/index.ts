import "./paths"; // first: points every data folder at dev-data in dev
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "path";
import { electronApp, is } from "@electron-toolkit/utils";
import { listDownloads } from "../shared/downloadsStore";
import { buildMenu, setupPlanner } from "./planner";
import { cleanupDuplicateInstalls, registerUpdaterHandlers } from "./updater";

function createWindow(): void {
	const win = new BrowserWindow({
		width: 1440,
		height: 860,
		minWidth: 900,
		minHeight: 560,
		show: false,
		title: "DJ Utilities",
		backgroundColor: "#0e0f12",
		webPreferences: {
			preload: join(__dirname, "../preload/index.mjs"),
			sandbox: false,
			contextIsolation: true,
		},
	});

	win.on("ready-to-show", () => win.show());

	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		try {
			if (new URL(url).origin === new URL(win.webContents.getURL()).origin) return;
		} catch {
			// unparseable: block it and let the OS decide
		}
		event.preventDefault();
		void shell.openExternal(url);
	});

	if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
		win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
	} else {
		win.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

app.whenReady().then(() => {
	electronApp.setAppUserModelId("com.youssof.dj-utilities");
	ipcMain.handle("downloads:list", () => listDownloads());
	setupPlanner();
	registerUpdaterHandlers();
	buildMenu();
	// Remove stray "DJ Utilities 2.app" copies left by Finder or a failed update.
	if (!is.dev) {
		void cleanupDuplicateInstalls().catch((err) => console.warn("[updater] startup cleanup failed:", err));
	}
	createWindow();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
