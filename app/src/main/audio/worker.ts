// Worker thread entry: one task per worker, so heavy audio work never blocks the app.
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import { computePeaks, exportSet, killChildren, stretchFile, type ExportJob } from "./dsp";
import { WavReader } from "./wav";

export type PrepareJob = { decodedPath: string; outPath: string; peaksPath: string; fromBpm: number; toBpm: number };
export type PeaksJob = { wavPath: string; peaksPath: string };
export type Task = { type: "prepare"; job: PrepareJob } | { type: "peaks"; job: PeaksJob } | { type: "export"; job: ExportJob };

const post = (m: unknown): void => parentPort!.postMessage(m);

parentPort!.on("message", (m) => {
	if (m === "cancel") {
		killChildren();
		process.exit(0);
	}
});

async function main(): Promise<unknown> {
	const task = workerData as Task;
	if (task.type === "prepare") {
		const { decodedPath, outPath, peaksPath, fromBpm, toBpm } = task.job;
		const tmp = `${outPath}.${process.pid}.${Date.now()}.part.wav`;
		try {
			await stretchFile(decodedPath, tmp, fromBpm, toBpm, (p) => post({ progress: { pct: p * 0.95 } }));
			const peaks = computePeaks(tmp);
			const r = new WavReader(tmp);
			const frames = r.frames;
			r.close();
			await fs.promises.writeFile(peaksPath, peaks);
			await fs.promises.rename(tmp, outPath);
			return { frames };
		} finally {
			await fs.promises.rm(tmp, { force: true });
		}
	}
	if (task.type === "peaks") {
		const tmp = `${task.job.peaksPath}.${process.pid}.${Date.now()}.part.tmp`;
		await fs.promises.writeFile(tmp, computePeaks(task.job.wavPath));
		await fs.promises.rename(tmp, task.job.peaksPath);
		return {};
	}
	return exportSet(task.job, (stage, pct) => post({ progress: { stage, pct } }));
}

main().then(
	(result) => post({ result }),
	(e) => post({ error: e instanceof Error ? e.message : String(e) }),
);
