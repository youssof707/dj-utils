// Gives each test run one folder in <repo>/dev-data/test-runs and removes it when the run
// ends, pass or fail. Folders left by runs that were killed outright are removed at the start
// of the next run (and by the next dev launch of the app).

import fs from "node:fs";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { OWNER_FILE, sweepTestRuns } from "../src/shared/devData";

const RUNS = path.resolve(__dirname, "../../dev-data/test-runs");

export default function setup(project: TestProject): () => void {
	sweepTestRuns(RUNS);
	const dir = path.join(RUNS, `${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, OWNER_FILE), String(process.pid));
	project.provide("testRun", dir);
	const remove = (): void => fs.rmSync(dir, { recursive: true, force: true });
	// Ctrl-C and kill still clean up; only kill -9 skips this, and the next sweep handles that.
	process.once("exit", remove);
	return remove;
}
