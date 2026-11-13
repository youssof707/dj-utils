// Checks the Rekordbox reader against the real library on this machine. Read-only, and
// only runs when asked: DJ_REAL_LIBRARY=<folder holding the music files> npx vitest run ...
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testDir } from "../testdata";
import { afconvertToWav } from "../../src/main/audio/dsp";
import { findAnalysisRoot, matchTrack, measureShift, nameKey, parseWaveform, scanLibrary, type LibraryEntry } from "../../src/main/rekordbox";
import { SAMPLE_RATE as SR } from "../../src/shared/planner";
import { knownShifts } from "../anlz";

const MUSIC = process.env["DJ_REAL_LIBRARY"] ?? "";
const ROOT = process.env["DJ_REKORDBOX_DIR"] ?? path.join(os.homedir(), "Library/Pioneer/rekordbox/share/PIONEER/USBANLZ");
const EVERY = Number(process.env["DJ_REAL_EVERY"] ?? 12);

function indexMusic(dir: string, out: Map<string, string[]>): void {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) indexMusic(p, out);
		else if (/\.(mp3|wav|aiff?|m4a|flac)$/i.test(e.name)) out.set(nameKey(e.name), [...(out.get(nameKey(e.name)) ?? []), p]);
	}
}

describe.skipIf(!MUSIC || !fs.existsSync(ROOT))("the real Rekordbox library", () => {
	it("scans quickly, and measures every kind of file the way Rekordbox decodes it", async () => {
		// the app finds this library by itself, from Rekordbox's own settings
		if (!process.env["DJ_REKORDBOX_DIR"]) expect(findAnalysisRoot(os.homedir())).toBe(ROOT);
		const tmp = testDir("rb-real-");
		const cache = path.join(tmp, "cache.json");
		let t = performance.now();
		const entries = scanLibrary(ROOT, cache);
		const cold = performance.now() - t;
		t = performance.now();
		const again = scanLibrary(ROOT, cache);
		const warm = performance.now() - t;
		console.log(`library: ${entries.length} tracks with a grid; first scan ${cold.toFixed(0)} ms, later scans ${warm.toFixed(0)} ms, cache ${(fs.statSync(cache).size / 1024).toFixed(0)} KB`);
		expect(again).toEqual(entries);
		expect(entries.length).toBeGreaterThan(100);
		expect(warm).toBeLessThan(2000);

		const music = new Map<string, string[]>();
		indexMusic(MUSIC, music);
		const byName = new Map<string, LibraryEntry[]>();
		for (const e of entries) byName.set(nameKey(e.name), [...(byName.get(nameKey(e.name)) ?? []), e]);
		const names = [...byName.keys()].filter((k) => music.get(k)?.length === 1).sort();
		const decoded = path.join(tmp, "decoded.wav");
		const kinds: Record<string, number[]> = {};
		const misses: string[] = [];
		const wrong: string[] = [];
		let tested = 0;
		let matchMs = 0;
		for (let i = 0; i < names.length; i += EVERY) {
			const file = music.get(names[i])![0];
			const cands = byName.get(names[i])!;
			fs.rmSync(decoded, { force: true });
			try {
				await afconvertToWav(file, decoded);
			} catch {
				continue;
			}
			tested++;
			t = performance.now();
			const grid = matchTrack(decoded, cands);
			matchMs += performance.now() - t;
			if (!grid) {
				misses.push(path.basename(file));
				continue;
			}
			// the shift the match used, straight from the waveform of the entry it chose
			const entry = cands.find((c) => Math.abs(c.bpm - grid.bpm) < 1e-9 && Math.abs(c.downbeatMs / 1000 - grid.downbeatSec) < 0.25)!;
			const m = measureShift(parseWaveform(fs.readFileSync(entry.dat.replace(/\.DAT$/, ".EXT")))!, decoded)!;
			const shift = m.shiftSec * SR;
			const known = knownShifts(file);
			(kinds[known.kind] ??= []).push(Math.round(shift));
			// A file re-rendered since Rekordbox analysed it scores low and can sit anywhere.
			if (m.score >= 0.75 && !known.shifts.some((x) => Math.abs(shift - x * SR) < 9)) wrong.push(`${path.basename(file)}: measured ${shift.toFixed(1)}, expected ${known.shifts.map((x) => (x * SR).toFixed(1)).join(" or ")} (score ${m.score.toFixed(2)})`);
		}
		for (const [k, v] of Object.entries(kinds).sort()) {
			const counts = new Map<number, number>();
			for (const x of v) counts.set(x, (counts.get(x) ?? 0) + 1);
			console.log(`${k.padEnd(44)} ${String(v.length).padStart(4)} files, shift in frames: ${[...counts].sort((a, b) => a[0] - b[0]).map(([x, c]) => `${x}×${c}`).join(" ")}`);
		}
		console.log(`tested ${tested}; matched ${tested - misses.length}; ${(matchMs / tested).toFixed(0)} ms per match`);
		if (misses.length) console.log("not matched (file differs from the one Rekordbox analysed):\n  " + misses.join("\n  "));
		if (wrong.length) console.log("unexpected shift:\n  " + wrong.join("\n  "));
		expect(wrong).toEqual([]);
		expect(misses.length).toBeLessThanOrEqual(Math.ceil(tested * 0.03));
	}, 3600000);
});
