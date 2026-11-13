#!/usr/bin/env node
// The only way to run E2E tests: `npm run test:e2e -- <spec files> [-t "<test name>"]`.
// Runs only what is named. The whole suite needs an explicit --all.
// Builds first, then runs vitest; test data is removed afterwards however the run ends.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = path.resolve(APP, "..", "dev-data", "test-runs");

const args = process.argv.slice(2);
const all = args.includes("--all");
const rest = args.filter((a) => a !== "--all");
const scoped = rest.some((a) => !a.startsWith("-")) || rest.some((a) => a === "-t" || a.startsWith("-t=") || a.startsWith("--testNamePattern"));
if (!all && !scoped) {
	console.error(
		"Refusing to run every E2E test.\n" +
			"Name the spec file(s) that cover what you changed, e.g.\n" +
			"  npm run test:e2e -- tests/e2e/tempo.e2e.ts\n" +
			'  npm run test:e2e -- tests/e2e/editing.e2e.ts -t "trims"\n' +
			"Use --all only when the whole suite was asked for.",
	);
	process.exit(1);
}

const { sweepTestRuns } = await import("../src/shared/devData.ts");

const build = spawnSync("npx", ["electron-vite", "build"], { cwd: APP, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const child = spawn("npx", ["vitest", "run", "-c", "vitest.e2e.config.ts", ...rest], { cwd: APP, stdio: "inherit" });
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(sig, () => {
		if (stopping) return;
		stopping = true;
		child.kill(sig);
	});
}
child.on("exit", (code, signal) => {
	// vitest removes its own run folder; this catches anything a crash left behind.
	sweepTestRuns(RUNS);
	process.exit(code ?? (signal ? 1 : 0));
});
