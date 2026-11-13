import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/e2e/**/*.e2e.ts"],
		testTimeout: 600000,
		hookTimeout: 120000,
		fileParallelism: false,
		// All test files go in this run's folder in dev-data/test-runs, removed when the run ends.
		globalSetup: ["tests/e2e/globalSetup.ts"],
		setupFiles: ["tests/testdata.ts"],
	},
});
