// Where tests keep files: only ever inside this run's folder in <repo>/dev-data/test-runs,
// which globalSetup makes and removes. Use testDir() for any folder a test needs; never
// os.tmpdir() or a path of your own.

import fs from "node:fs";
import path from "node:path";
import { inject } from "vitest";

export const DEV_DATA = path.resolve(__dirname, "../../dev-data");
export const RUNS = path.join(DEV_DATA, "test-runs");
// E2E screenshots: cleared when an E2E run starts, kept after it ends as proof.
export const SHOTS = path.join(DEV_DATA, "shots");

declare module "vitest" {
	export interface ProvidedContext {
		testRun: string;
	}
}

// This run's folder.
export function runDir(): string {
	const dir = inject("testRun");
	if (!dir || !dir.startsWith(RUNS + path.sep)) throw new Error("No test-run folder: run tests through the vitest configs in app/");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// A new empty folder inside this run's folder.
export function testDir(prefix: string): string {
	return fs.mkdtempSync(path.join(runDir(), prefix));
}

// Anything that still asks the OS for a temp folder (code under test, child processes, the
// app the E2E tests launch) lands in this run's folder too.
const tmp = path.join(runDir(), "tmp");
fs.mkdirSync(tmp, { recursive: true });
process.env["TMPDIR"] = tmp;
