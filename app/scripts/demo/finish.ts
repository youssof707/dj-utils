// Turns a take into the finished film: the picture (composed in several pieces at once, then
// joined), the sound, and stills for checking.
//
//   node scripts/demo/finish.ts <take name> [--jobs 4]

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEMO, FFMPEG } from "./paths.ts";
import { segments } from "./plan.mjs";

const argv = process.argv.slice(2);
const take = path.join(DEMO, "takes", argv[0]);
const jobs = Number(argv.includes("--jobs") ? argv[argv.indexOf("--jobs") + 1] : 4);
const APP = path.resolve(import.meta.dirname, "../..");
const log = JSON.parse(fs.readFileSync(path.join(take, "log.json"), "utf8"));
const { duration } = segments(log);

// Whole seconds per piece, so each piece starts on a frame.
const per = Math.ceil(duration / jobs);
const parts: string[] = [];
const began = Date.now();
await Promise.all(
	Array.from({ length: jobs }, (_, i) => {
		const from = i * per;
		if (from >= duration) return Promise.resolve();
		const to = Math.min(duration + 1, (i + 1) * per);
		const out = path.join(take, `picture-${i}.mp4`);
		parts[i] = out;
		return new Promise<void>((resolve, reject) => {
			const child = spawn(path.join(APP, "node_modules/.bin/electron"), [path.join(import.meta.dirname, "compose/main.cjs"), take, out, String(from), String(to)], { stdio: ["ignore", "pipe", "pipe"] });
			let tail = "";
			child.stdout.on("data", (d) => (tail = (tail + d).slice(-600)));
			child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`compose piece ${i} failed (${code}): ${tail}`))));
		});
	}),
);
const list = path.join(take, "picture.txt");
fs.writeFileSync(list, parts.filter(Boolean).map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
execFileSync(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", path.join(take, "picture.mp4")]);
for (const p of parts.filter(Boolean)) fs.rmSync(p);
fs.rmSync(list);
console.log(`[finish] picture: ${duration.toFixed(1)}s in ${((Date.now() - began) / 1000).toFixed(0)}s`);
execFileSync("node", [path.join(import.meta.dirname, "mix.ts"), argv[0]], { stdio: "inherit" });
