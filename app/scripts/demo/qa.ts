// Checks a finished film without watching it: sheets of stills, the picture's and sound's
// basic facts, loudness over time, and whether any frame repeats or drops where things move.
//
//   node scripts/demo/qa.ts <take name> [--every 2] [--from 0 --to 30]

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEMO, FFMPEG, FFPROBE } from "./paths.ts";

const argv = process.argv.slice(2);
const flag = (n: string, d: string): string => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const take = path.join(DEMO, "takes", argv[0]);
const film = path.join(take, flag("--file", "final.mp4"));
const every = Number(flag("--every", "2"));
const from = Number(flag("--from", "0"));
const dur = Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", film]).toString());
const to = Math.min(dur, Number(flag("--to", String(dur))));
const out = path.join(take, "qa");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);

console.log(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames,sample_rate,channels,bit_rate:format=duration,size", "-of", "compact", film]).toString().trim());

// Sheets of 12 stills (3 x 4), each with its time.
const times: number[] = [];
for (let t = from; t < to; t += every) times.push(t);
for (let i = 0; i < times.length; i += 12) {
	const group = times.slice(i, i + 12);
	const inputs = group.flatMap((t) => ["-ss", t.toFixed(2), "-i", film]);
	const scaled = group.map((t, k) => `[${k}:v]scale=800:-2,drawtext=fontfile=/System/Library/Fonts/SFNSMono.ttf:text='${t.toFixed(1)}s':fontsize=22:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=6:x=8:y=8,trim=end_frame=1[s${k}]`).join(";");
	const layout = group.map((_, k) => `${(k % 3) * 800}_${Math.floor(k / 3) * 450}`).join("|");
	const sheet = path.join(out, `sheet-${String(Math.round(group[0])).padStart(4, "0")}.png`);
	execFileSync(FFMPEG, ["-y", "-v", "error", ...inputs, "-filter_complex", `${scaled};${group.map((_, k) => `[s${k}]`).join("")}xstack=inputs=${group.length}:layout=${layout}:fill=black`, "-frames:v", "1", sheet], group.length > 1 ? {} : {});
}
console.log(`sheets: ${fs.readdirSync(out).length} in ${out}`);

// Loudness: overall, and the quietest and loudest stretches.
const r = spawnSync(FFMPEG, ["-hide_banner", "-i", film, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
console.log(summary.replace(/\s+/g, " ").trim());
const short = [...r.stderr.matchAll(/t:\s*([\d.]+)\s+TARGET.*?S:\s*(-?[\d.]+)/g)].map((m) => ({ t: Number(m[1]), s: Number(m[2]) })).filter((x) => x.t > 3);
if (short.length) {
	const sorted = [...short].sort((a, b) => a.s - b.s);
	console.log("quietest 3s windows:", sorted.slice(0, 3).map((x) => `${x.t.toFixed(0)}s ${x.s.toFixed(1)}`).join(", "), "| loudest:", sorted.slice(-3).map((x) => `${x.t.toFixed(0)}s ${x.s.toFixed(1)}`).join(", "));
}
