import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
	resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
	test: { include: ["tests/unit/**/*.test.ts"], testTimeout: 120000 },
});
