// E2E runs: the shared test-run folder, plus a fresh screenshots folder. Screenshots are kept
// after the run (they are the proof of what was tested) and cleared when the next one starts.

import fs from "node:fs";
import path from "node:path";
import type { TestProject } from "vitest/node";
import shared from "../globalSetup";

const SHOTS = path.resolve(__dirname, "../../../dev-data/shots");

export default function setup(project: TestProject): () => void {
	fs.rmSync(SHOTS, { recursive: true, force: true });
	fs.mkdirSync(SHOTS, { recursive: true });
	return shared(project);
}
