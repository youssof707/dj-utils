// Makes the film's background music once: the opening set ("Saturday set") exported by the app
// itself as one mix, so the music under the narration is the same set the film opens on.
import fs from "node:fs";
import path from "node:path";
import { DEMO } from "./paths.ts";
import { freshWorld, openStage } from "./stage.ts";
const out = path.join(DEMO, "bed", "saturday.wav");
fs.mkdirSync(path.dirname(out), { recursive: true });
const world = freshWorld(path.join(DEMO, "bed", "world"));
const stage = await openStage({ world, scale: 1 });
try {
	await stage.page.evaluate(() => (window as any).planner.openSet("smwfm6j341odbz"));
	await stage.page.waitForFunction(() => { const p = (window as any).planner; return document.querySelector('[data-testid="working"]') === null && p.tempoProgress(p.store.get().doc).left === 0 && Array.from(document.querySelectorAll('[data-testid="clip"]')).every((e: any) => e.dataset.status === "ready"); }, undefined, { timeout: 600000, polling: 200 });
	await stage.page.evaluate((o) => { const p = (window as any).planner; p.store.set({ exportUi: { phase: "options" } }); return p.runExport(true, o); }, out);
	console.log(await stage.page.evaluate(() => (window as any).planner.store.get().exportUi));
} finally {
	await stage.close();
	fs.rmSync(world, { recursive: true, force: true });
}
