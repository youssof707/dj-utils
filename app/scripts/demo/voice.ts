// Voices the narration with ElevenLabs, a paragraph per request so the delivery carries
// through, and cuts each paragraph into its lines at the pauses between sentences (the
// service returns when every character is spoken). Results are kept in dev-data/demo/voice/
// and a paragraph is only voiced again when its text or the voice settings change, so reruns
// cost nothing.
//
//   node scripts/demo/voice.ts [--only a1,b1] [--dry]
//
// The key is the one set up for the ElevenLabs MCP server in ~/.claude.json.

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEMO, FFMPEG, FFPROBE } from "./paths.ts";
import { LINES, PARAGRAPHS } from "./script.ts";

export const VOICE = {
	voiceId: process.env["DEMO_VOICE_ID"] ?? "bIHbv24MWmeRgasZH58o", // Will
	model: process.env["DEMO_VOICE_MODEL"] ?? "eleven_v4",
	settings: { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: true, speed: 0.94 },
};

const OUT = path.join(DEMO, "voice");
const INDEX = path.join(OUT, "voice.json");

function apiKey(): string {
	const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
	let key = "";
	const walk = (o: unknown): void => {
		if (!o || typeof o !== "object" || key) return;
		for (const [k, v] of Object.entries(o as Record<string, any>)) {
			if (k === "mcpServers" && v?.elevenlabs?.env?.ELEVENLABS_API_KEY) key = v.elevenlabs.env.ELEVENLABS_API_KEY;
			else walk(v);
		}
	};
	walk(cfg);
	if (!key) throw new Error("No ElevenLabs key in ~/.claude.json");
	return key;
}

type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
type Index = { voice: typeof VOICE; lines: Record<string, { file: string; dur: number; text: string }>; paragraphs: Record<string, string>; chars: number };

const dur = (f: string): number => Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

async function main(): Promise<void> {
	fs.mkdirSync(OUT, { recursive: true });
	const index: Index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, "utf8")) : { voice: VOICE, lines: {}, paragraphs: {}, chars: 0 };
	const onlyArg = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1].split(",")) : null;
	const dry = process.argv.includes("--dry");
	let spent = 0;
	for (let pi = 0; pi < PARAGRAPHS.length; pi++) {
		const ids = PARAGRAPHS[pi];
		if (onlyArg && !ids.some((i) => onlyArg.has(i))) continue;
		const text = ids.map((i) => LINES[i]).join(" ");
		const hash = crypto.createHash("sha1").update(JSON.stringify([VOICE, text])).digest("hex").slice(0, 12);
		const pkey = ids.join("+");
		const whole = path.join(OUT, `p-${pkey}-${hash}.mp3`);
		const alignFile = whole.replace(/\.mp3$/, ".json");
		if (!fs.existsSync(whole) || !fs.existsSync(alignFile)) {
			if (dry) {
				console.log(`would voice ${pkey}: ${text.length} characters`);
				spent += text.length;
				continue;
			}
			const prev = pi > 0 ? PARAGRAPHS[pi - 1].map((i) => LINES[i]).join(" ") : undefined;
			const next = pi < PARAGRAPHS.length - 1 ? PARAGRAPHS[pi + 1].map((i) => LINES[i]).join(" ") : undefined;
			const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE.voiceId}/with-timestamps?output_format=mp3_44100_128`, {
				method: "POST",
				headers: { "xi-api-key": apiKey(), "content-type": "application/json" },
				body: JSON.stringify({ text, model_id: VOICE.model, voice_settings: VOICE.settings, ...(prev ? { previous_text: prev } : {}), ...(next ? { next_text: next } : {}) }),
			});
			if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 400)}`);
			const body = (await res.json()) as { audio_base64: string; alignment: Alignment };
			spent += text.length;
			index.chars = (index.chars ?? 0) + text.length;
			fs.writeFileSync(whole, Buffer.from(body.audio_base64, "base64"));
			fs.writeFileSync(alignFile, JSON.stringify(body.alignment));
		}
		if (dry) continue;
		const alignment: Alignment = JSON.parse(fs.readFileSync(alignFile, "utf8"));
		// Where each line is in the paragraph, roughly (the service's timings are coarse), then
		// the real pauses in the sound, so each cut falls inside a pause.
		const spoken = alignment.characters.join("");
		const total = dur(whole);
		const det = (() => {
			const r = spawnSync(FFMPEG, ["-hide_banner", "-i", whole, "-af", "silencedetect=noise=-40dB:d=0.1", "-f", "null", "-"], { encoding: "utf8" });
			const starts = [...r.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
			const ends = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
			return starts.map((st, i) => ({ a: st, b: ends[i] ?? total }));
		})();
		const speechStart = det.length && det[0].a < 0.02 ? det[0].b : 0;
		const speechEnd = det.length && det[det.length - 1].b >= total - 0.02 ? det[det.length - 1].a : total;
		let at = 0;
		const spans = ids.map((i) => {
			const from = spoken.indexOf(LINES[i], at);
			if (from < 0) throw new Error(`Line ${i} not found in what was spoken`);
			at = from + LINES[i].length;
			return { id: i, start: alignment.character_start_times_seconds[from], end: alignment.character_end_times_seconds[at - 1] };
		});
		// The pause between two lines: the longest silence that touches the stretch around where the
		// service says one ends and the next starts.
		const pauses = spans.slice(1).map((s2, k) => {
			const around = { a: spans[k].end - 0.7, b: s2.start + 0.25 };
			const cands = det.filter((q) => q.b > around.a && q.a < around.b && q.a > spans[k].start + 0.3);
			if (!cands.length) throw new Error(`No pause found between ${spans[k].id} and ${s2.id}`);
			return cands.sort((x, y) => y.b - y.a - (x.b - x.a))[0];
		});
		spans.forEach((sp, k) => {
			const from = Math.max(0, (k === 0 ? speechStart : pauses[k - 1].b) - 0.06);
			const to = Math.min(total, (k === spans.length - 1 ? speechEnd : pauses[k].a) + 0.22);
			const file = `${sp.id}-${hash}.wav`;
			const len = to - from;
			execFileSync(FFMPEG, ["-y", "-v", "error", "-ss", from.toFixed(3), "-t", len.toFixed(3), "-i", whole, "-af", `afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, len - 0.12).toFixed(3)}:d=0.12`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", path.join(OUT, file)]);
			index.lines[sp.id] = { file, dur: len, text: LINES[sp.id] };
			console.log(`${sp.id}  ${len.toFixed(2)}s  ${(LINES[sp.id].length / (len - 0.28)).toFixed(1)} ch/s  pause after ${k < pauses.length ? (pauses[k].b - pauses[k].a).toFixed(2) + "s" : "-"}`);
		});
		index.paragraphs[pkey] = hash;
		index.voice = VOICE;
		fs.writeFileSync(INDEX, JSON.stringify(index, null, "\t"));
	}
	console.log(`${dry ? "would spend" : "spent"} ${spent} characters this run; ${index.chars} in all`);
}

await main();
