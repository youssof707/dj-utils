// Checks the voiced narration: transcribes each paragraph back and compares it to the script,
// and measures each line's loudness so an odd one stands out.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEMO, FFMPEG } from "./paths.ts";
import { LINES, PARAGRAPHS } from "./script.ts";
const OUT = path.join(DEMO, "voice");
const index = JSON.parse(fs.readFileSync(path.join(OUT, "voice.json"), "utf8"));
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
const key = ((): string => {
	let k = "";
	const walk = (o: any): void => {
		if (!o || typeof o !== "object" || k) return;
		for (const [n, v] of Object.entries(o as Record<string, any>)) {
			if (n === "mcpServers" && v?.elevenlabs?.env?.ELEVENLABS_API_KEY) k = v.elevenlabs.env.ELEVENLABS_API_KEY;
			else walk(v);
		}
	};
	walk(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8")));
	return k;
})();
async function transcribe(file: string): Promise<string> {
	const form = new FormData();
	form.append("model_id", "scribe_v1");
	form.append("language_code", "eng");
	form.append("tag_audio_events", "true");
	form.append("file", new Blob([fs.readFileSync(file)], { type: "audio/mpeg" }), path.basename(file));
	const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: form });
	if (!res.ok) throw new Error(`speech-to-text ${res.status}: ${(await res.text()).slice(0, 300)}`);
	return ((await res.json()) as { text: string }).text;
}
let bad = 0;
for (const ids of PARAGRAPHS) {
	if (only && !ids.some((i) => only.has(i))) continue;
	const pkey = ids.join("+");
	const file = path.join(OUT, `p-${pkey}-${index.paragraphs[pkey]}.mp3`);
	const heard = await transcribe(file);
	const want = norm(ids.map((i) => LINES[i as keyof typeof LINES]).join(" "));
	const got = norm(heard);
	const ok = want === got;
	if (!ok) bad++;
	console.log(`${ok ? "ok  " : "DIFF"} ${pkey}${ok ? "" : `\n     want: ${want}\n     got:  ${got}`}`);
}
for (const [id, l] of Object.entries(index.lines as Record<string, { file: string; dur: number }>)) {
	if (only && !only.has(id)) continue;
	const r = spawnSync(FFMPEG, ["-hide_banner", "-i", path.join(OUT, l.file), "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
	const I = r.stderr.match(/I:\s+(-?[\d.]+) LUFS/g)?.pop();
	const P = r.stderr.match(/Peak:\s+(-?[\d.]+) dBFS/g)?.pop();
	console.log(id, l.dur.toFixed(2) + "s", I, P);
}
console.log(bad ? `${bad} paragraph(s) differ` : "all paragraphs heard as written");
void execFileSync;
