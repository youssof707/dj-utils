import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
	resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
	test: {
		include: ["tests/unit/**/*.test.ts"],
		testTimeout: 120000,
		// All test files go in this run's folder in dev-data/test-runs, removed when the run ends.
		globalSetup: ["tests/globalSetup.ts"],
		setupFiles: ["tests/testdata.ts"],
	},
});
