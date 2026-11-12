// Types shared by the set planner's main process, preload and renderer.

export const SAMPLE_RATE = 44100;
export const LANES = 4;
export const PEAK_BUCKET = 64; // frames per waveform peak (about 1.5 ms)
export const PEAKS_EXT = ".peaks3"; // waveform file next to each stretched file

export type PlannerTrack = {
	id: string;
	sourcePath: string;
	name: string;
	bpm: number; // the track's own tempo, as typed on import
	durationSec: number; // length of the source file
	// From Rekordbox's beat grid: where a bar line falls in the source file. Tracks that have
	// it are placed, and later moved, by their bar lines.
	downbeatSec?: number;
};

// Positions are in beats so they survive a project BPM change.
export type Clip = {
	id: string;
	trackId: string;
	lane: number;
	startBeat: number; // where the clip sits on the timeline
	offsetBeat: number; // how far into the track the clip starts
	lengthBeat: number;
	// Reserved for later versions (volume, fades).
	gain?: number;
	fadeInBeat?: number;
	fadeOutBeat?: number;
};

// A tempo change sits in the tempo lane like a clip: over its length the tempo ramps from
// whatever it was before to `bpm`, then holds there until the next change.
export type TempoBlock = { id: string; startBeat: number; lengthBeat: number; bpm: number };

// Older files stored the tempo as a list of curve points.
export type TempoPoint = { id: string; beat: number; bpm: number };

export type PlannerDoc = {
	version: 1;
	bpm: number; // project BPM, fixed for editing and playback
	tracks: PlannerTrack[];
	clips: Clip[];
	tempos: TempoBlock[];
};

// A track's beat grid as Rekordbox analysed it, on our own decode of the file.
export type RekordboxGrid = { bpm: number; downbeatSec: number };

// A Rekordbox cue point, in seconds into our own decode of the file. Kind 0 is a memory
// cue; 1 and up are the hot cues A, B, C...
export type Cue = { sec: number; kind: number };

export type ProbeResult = {
	path: string;
	name: string;
	durationSec: number;
	tagBpm: number | null;
	rekordbox: RekordboxGrid | null;
	// Rekordbox has a track by this file name, but analysed different audio (an earlier
	// version of the file, say): its BPM is worth suggesting, its bar line is not.
	rekordboxBpm: number | null;
};

export type StretchRequest = { sourcePath: string; bpm: number; projectBpm: number };
export type StretchResult = { cachePath: string; frames: number };
export type StretchProgress = { key: string; pct: number };

export type ExportClip = { cachePath: string; startFrame: number; offsetFrame: number; frames: number };
export type ExportRequest = {
	outPath: string;
	projectBpm: number;
	clips: ExportClip[];
	points: { beat: number; bpm: number }[];
	keyLock: boolean;
};
export type ExportResult = { path: string; seconds: number; gainDb: number };
export type ExportProgress = { stage: string; pct: number };

export type Session = {
	doc: PlannerDoc;
	filePath: string | null;
	dirty: boolean;
	pxPerBeat: number;
	scrollX: number;
	playheadBeat: number;
};

export function stretchKey(r: StretchRequest): string {
	return `${r.sourcePath}|${r.bpm}|${r.projectBpm}`;
}

export function trackBeats(t: PlannerTrack): number {
	return (t.durationSec * t.bpm) / 60;
}

// A bar line this close before the first sample still counts as the track's first bar line.
// Rekordbox's clock starts up to about 0.1 s before ours on MP3 and AAC files (it keeps the
// encoder's padding), so its first bar line can sit that far ahead of the audio we have.
const EARLY_BAR_SEC = 0.25;

// Where a Rekordbox track's first bar line sits, in the track's own beats from the start of
// the file. Usually a little after the start; slightly negative when the bar line falls a
// hair before the first sample. Null for tracks without a Rekordbox grid.
export function firstBarBeat(t: PlannerTrack): number | null {
	if (t.downbeatSec === undefined || !Number.isFinite(t.downbeatSec)) return null;
	const beatSec = 60 / t.bpm;
	const beat = t.downbeatSec / beatSec;
	let bar = beat - Math.floor(beat / 4) * 4;
	if ((4 - bar) * beatSec < EARLY_BAR_SEC) bar -= 4;
	return bar;
}

export function emptyDoc(): PlannerDoc {
	return { version: 1, bpm: 128, tracks: [], clips: [], tempos: [] };
}
