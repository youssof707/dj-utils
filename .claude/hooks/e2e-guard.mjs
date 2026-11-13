#!/usr/bin/env node
// PreToolUse(Bash) guard: E2E tests only run through `npm run test:e2e -- <specs>`, scoped to
// what was changed. Blocks calling vitest with the E2E config directly, and blocks --all unless
// the command is tagged `# user-asked-all` (only when the user asked for the whole suite).

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
	let cmd = "";
	try {
		cmd = JSON.parse(input).tool_input?.command ?? "";
	} catch {
		process.exit(0);
	}
	const block = (why) => {
		process.stderr.write(`${why}\nRun only the E2E specs that cover the files you changed: npm --prefix app run test:e2e -- tests/e2e/<spec>.e2e.ts [-t "<name>"]\n`);
		process.exit(2);
	};
	if (/vitest/.test(cmd) && /vitest\.e2e\.config/.test(cmd)) block("Blocked: E2E vitest must go through the test:e2e script.");
	if (/(test:e2e|scripts\/e2e\.mjs)/.test(cmd) && /(^|\s)--all(\s|$)/.test(cmd) && !/#\s*user-asked-all/.test(cmd)) block("Blocked: the full E2E suite runs only when the user asks for it (tag the command `# user-asked-all`).");
	process.exit(0);
});
