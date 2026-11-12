import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ["tests/e2e/**/*.e2e.ts"], testTimeout: 600000, hookTimeout: 120000, fileParallelism: false },
});
