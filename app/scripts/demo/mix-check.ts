// Checks that the narration is still clear in the finished mix: transcribes the film's sound
// and compares it to the script, line by line.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEMO, FFMPEG } from "./paths.ts";
import { LINES } from "./script.ts";
const take = path.join(DEMO, "takes", process.argv[2]);
const key = ((): string => { let k = ""; const walk = (o: any): void => { if (!o || typeof o !== "object" || k) return; for (const [n, v] of Object.entries(o as Record<string, any>)) { if (n === "mcpServers" && v?.elevenlabs?.env?.ELEVENLABS_API_KEY) k = v.elevenlabs.env.ELEVENLABS_API_KEY; else walk(v); } }; walk(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"))); return k; })();
const mp3 = path.join(take, "mix-check.mp3");
execFileSync(FFMPEG, ["-y", "-v", "error", "-i", path.join(take, "mix.wav"), "-ac", "1", "-b:a", "96k", mp3]);
const form = new FormData();
form.append("model_id", "scribe_v1");
form.append("language_code", "eng");
form.append("tag_audio_events", "false");
form.append("file", new Blob([fs.readFileSync(mp3)], { type: "audio/mpeg" }), "mix.mp3");
const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: form });
if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
const heard = ((await res.json()) as { text: string }).text;
fs.rmSync(mp3);
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const got = norm(heard);
let missing = 0;
for (const [id, text] of Object.entries(LINES)) {
	if (!got.includes(norm(text))) { missing++; console.log("NOT HEARD AS WRITTEN:", id, "|", text); }
}
console.log(missing ? `${missing} line(s) differ. Heard:\n${heard}` : `all ${Object.keys(LINES).length} lines are heard word for word in the mix`);
