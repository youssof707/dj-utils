// The repo's gitignored dev-data folder: in dev, and in every test run, the app keeps all of
// its data there. Test runs each get a folder in dev-data/test-runs, removed when the run ends;
// a run that was killed outright is removed by the next test run or the next dev launch.
// Node builtins only: imported by the main process and by the tests.

import fs from "node:fs";
import path from "node:path";

export const OWNER_FILE = "owner.pid";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

// Removes every run folder whose test run is no longer running.
export function sweepTestRuns(runsDir: string): void {
	let names: string[];
	try {
		names = fs.readdirSync(runsDir);
	} catch {
		return; // nothing there
	}
	for (const name of names) {
		const dir = path.join(runsDir, name);
		try {
			const pid = Number(fs.readFileSync(path.join(dir, OWNER_FILE), "utf8"));
			if (Number.isInteger(pid) && pid > 0 && alive(pid)) continue;
		} catch {
			// no owner: only a run that is just starting has none, and only for a moment
			try {
				if (Date.now() - fs.statSync(dir).mtimeMs < 60e3) continue;
			} catch {
				continue;
			}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
