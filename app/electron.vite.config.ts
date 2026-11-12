import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: { rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts"), worker: resolve(__dirname, "src/main/audio/worker.ts") } } },
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: { rollupOptions: { input: { index: resolve(__dirname, "src/preload/index.ts") } } },
	},
	renderer: {
		root: resolve(__dirname, "src/renderer"),
		resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
		build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
		plugins: [react()],
	},
});
