import "./paths"; // first: points every data folder at dev-data in dev
import { app, BrowserWindow, ipcMain, screen, shell, type Rectangle } from "electron";
import { join } from "path";
import { electronApp, is } from "@electron-toolkit/utils";
import { buildMenu, registerLibraryScheme, setupPlanner } from "./planner";
import { saveWindowState, setupSettings, windowState } from "./settings";
import { cleanupDuplicateInstalls, registerUpdaterHandlers } from "./updater";

registerLibraryScheme();

// Packaged: copied to Resources by extraResources. Dev: app/build/icon.png.
const iconPath = app.isPackaged ? join(process.resourcesPath, "icon.png") : join(app.getAppPath(), "build/icon.png");

const MIN_W = 900;
const MIN_H = 560;

// The saved place of the window, if it still fits on a screen that is there now: a display
// unplugged since leaves the window where the app would put it the first time.
function savedBounds(): { bounds: Rectangle | null; maximized: boolean; fullScreen: boolean } {
	const w = windowState();
	if (!w) return { bounds: null, maximized: false, fullScreen: false };
	const overlap = (a: Rectangle): number => Math.max(0, Math.min(a.x + a.width, w.x + w.width) - Math.max(a.x, w.x)) * Math.max(0, Math.min(a.y + a.height, w.y + w.height) - Math.max(a.y, w.y));
	const area = screen.getAllDisplays().map((d) => d.workArea).sort((a, b) => overlap(b) - overlap(a))[0];
	// at least a good grip of the window must be on that screen
	if (!area || overlap(area) < Math.min(200 * 100, (w.width * w.height) / 4)) return { bounds: null, maximized: !!w.maximized, fullScreen: !!w.fullScreen };
	const width = Math.max(MIN_W, Math.min(w.width, area.width));
	const height = Math.max(MIN_H, Math.min(w.height, area.height));
	const x = Math.min(Math.max(w.x, area.x), area.x + area.width - width);
	const y = Math.min(Math.max(w.y, area.y), area.y + area.height - height);
	return { bounds: { x, y, width, height }, maximized: !!w.maximized, fullScreen: !!w.fullScreen };
}

// Keeps the window's place and size as it changes, so the next launch opens it there.
function rememberBounds(win: BrowserWindow): void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const save = (): void => {
		if (timer) clearTimeout(timer);
		timer = null;
		if (win.isDestroyed() || win.isMinimized()) return;
		saveWindowState({ ...win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() });
	};
	const later = (): void => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(save, 500);
	};
	for (const ev of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) win.on(ev as "resize", later);
	win.on("close", save);
}

function createWindow(): void {
	const saved = savedBounds();
	const win = new BrowserWindow({
		icon: iconPath, // Windows/Linux; macOS uses the bundle's icon.icns
		width: 1440,
		height: 860,
		...(saved.bounds ?? {}),
		minWidth: MIN_W,
		minHeight: MIN_H,
		show: false,
		title: "DJ Utilities",
		backgroundColor: "#0e0f12",
		webPreferences: {
			preload: join(__dirname, "../preload/index.mjs"),
			sandbox: false,
			contextIsolation: true,
		},
	});

	rememberBounds(win);
	// maximize() and setFullScreen() show the window themselves, so they wait for the page too
	win.on("ready-to-show", () => {
		if (saved.fullScreen) win.setFullScreen(true);
		else if (saved.maximized) win.maximize();
		win.show();
	});

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
	// Dev runs use the stock Electron bundle, so set the dock icon by hand.
	if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(iconPath);
	ipcMain.handle("appInfo:get", () => ({ env: is.dev ? "dev" : "prod" }));
	// Double-clicking the version chip toggles DevTools, packaged builds included.
	ipcMain.handle("devtools:toggle", (e) => {
		if (e.sender.isDevToolsOpened()) e.sender.closeDevTools();
		else e.sender.openDevTools({ mode: "detach" });
	});
	setupSettings();
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

app.on("window-all-closed", () => app.quit());
