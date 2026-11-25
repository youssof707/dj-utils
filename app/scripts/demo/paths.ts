import fs from "node:fs";
import path from "node:path";

// Where demo recordings go: dev-data/demo/<run>/.
export const DEMO = path.resolve(import.meta.dirname, "../../../dev-data/demo");

// ffmpeg-full has drawtext (captions); the plain formula does not.
const FULL = "/opt/homebrew/opt/ffmpeg-full/bin";
export const FFMPEG = fs.existsSync(path.join(FULL, "ffmpeg")) ? path.join(FULL, "ffmpeg") : "ffmpeg";
export const FFPROBE = fs.existsSync(path.join(FULL, "ffprobe")) ? path.join(FULL, "ffprobe") : "ffprobe";
