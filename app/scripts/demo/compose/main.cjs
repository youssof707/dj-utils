// Runs the compositor page in a hidden window. Usage: electron main.cjs <take dir> [out file]
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
if (app.dock) app.dock.hide();
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
app.whenReady().then(() => {
	const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, webSecurity: false } });
	ipcMain.on("log", (_e, line) => process.stdout.write(line + "\n"));
	ipcMain.on("done", (_e, code) => app.exit(code));
	win.webContents.on("render-process-gone", (_e, d) => {
		process.stdout.write("renderer gone: " + d.reason + "\n");
		app.exit(3);
	});
	win.loadFile(path.join(__dirname, "index.html"), { query: { take: args[0], out: args[1] ?? "", from: args[2] ?? "", to: args[3] ?? "" } });
});
