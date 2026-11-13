// Where the app keeps its data. Imported first by index.ts, so it runs before anything else
// reads a path.
//
// Packaged app: Electron's usual folders, unchanged.
// Dev (and tests): everything goes in one folder, Chromium's own caches and temp files
// included: <repo>/dev-data, or the folder a test run passes in DJ_PLANNER_DATA. The folder
// can be deleted at any time; it is made again on the next launch.

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { sweepTestRuns } from "../shared/devData";

const DEV_DATA = path.resolve(app.getAppPath(), "..", "dev-data");

function setup(): string {
	if (app.isPackaged) return app.getPath("userData");
	const forced = process.env["DJ_PLANNER_DATA"];
	const root = forced || DEV_DATA;
	// A dev launch also clears what killed test runs left behind.
	if (!forced) sweepTestRuns(path.join(DEV_DATA, "test-runs"));
	const at = (sub: string): string => {
		const dir = path.join(root, sub);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	};
	app.setPath("userData", root);
	app.setPath("sessionData", at("chromium"));
	app.setPath("logs", at("logs"));
	app.setPath("crashDumps", at("crash-dumps"));
	const tmp = at("tmp");
	app.setPath("temp", tmp);
	// os.tmpdir() and every child process (afconvert, sqlite3) follow TMPDIR.
	process.env["TMPDIR"] = tmp;
	// Shared code (downloadsStore) keeps its files here too.
	process.env["DJ_DATA_DIR"] = root;
	return root;
}

const root = setup();

// The folder all app data lives in.
export function dataRoot(): string {
	fs.mkdirSync(root, { recursive: true });
	return root;
}
