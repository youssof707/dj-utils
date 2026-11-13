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
	gain?: number; // reserved for a later version
	// Volume fades: up from silence over this many beats at the start, and down to silence
	// over this many at the end (see fades.ts). Left out when there is no fade.
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

// `projectBpm` is the tempo the file is stretched to: the project BPM, or the tempo that a
// tempo change settles on for the clips that play there.
export type StretchRequest = { sourcePath: string; bpm: number; projectBpm: number };
export type StretchResult = { cachePath: string; frames: number };

// A stretch of a track that plays while the tempo is moving, rendered with the tempo change
// in it and the pitch held. `fromBeat` and `lengthBeat` are in the track's own beats; the
// tempo goes from `bpmA` to `bpmB` over them, linearly in beats.
export type RampRequest = { sourcePath: string; bpm: number; fromBeat: number; lengthBeat: number; bpmA: number; bpmB: number };

// Where two renderings of a clip meet, the next one fades in over this long, ending on the
// join, so the beat that sits on the join comes from one rendering only. A rendered ramp
// starts this long before the ramp itself, with the audio just before it at the starting
// tempo (silence, at the very start of a track).
export const JOIN_FADE_SEC = 0.02;
// Audio rendered on each side of a ramp and thrown away, so the ramp's own edges are clean.
export const RAMP_PAD_FRAMES = SAMPLE_RATE / 2;
export type StretchProgress = { key: string; pct: number };

// `fadeInFrames` and `fadeOutFrames` are the clip's volume fades, counted inside `frames`.
export type ExportClip = { cachePath: string; startFrame: number; offsetFrame: number; frames: number; fadeInFrames?: number; fadeOutFrames?: number };
export type ExportRequest = {
	outPath: string;
	projectBpm: number;
	clips: ExportClip[];
	points: { beat: number; bpm: number }[];
	keyLock: boolean;
};
export type ExportResult = { path: string; seconds: number; gainDb: number };
export type ExportProgress = { stage: string; pct: number };

// A set as the app stores it. The app keeps every set itself; there are no set files to
// save or open. `view` is where the timeline was left.
export type SetView = { pxPerBeat: number; scrollX: number; playheadBeat: number };
export type SetFile = { id: string; name: string; createdAt: number; updatedAt: number; openedAt: number; view: SetView; doc: PlannerDoc };
export type SetInfo = { id: string; name: string; updatedAt: number; tracks: number; lengthSec: number };

export function stretchKey(r: StretchRequest): string {
	return `${r.sourcePath}|${r.bpm}|${r.projectBpm}`;
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

// Numbers are rounded so that the same ramp reached by different sums has the same key.
export function rampRequest(track: PlannerTrack, fromBeat: number, lengthBeat: number, bpmA: number, bpmB: number): RampRequest {
	return { sourcePath: track.sourcePath, bpm: track.bpm, fromBeat: r6(fromBeat), lengthBeat: r6(lengthBeat), bpmA: r6(bpmA), bpmB: r6(bpmB) };
}

export function rampKey(r: RampRequest): string {
	return `ramp|${r.sourcePath}|${r.bpm}|${r.fromBeat}|${r.lengthBeat}|${r.bpmA}|${r.bpmB}`;
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

// The tempo a new set starts at.
export const DEFAULT_BPM = 150;

export function emptyDoc(bpm = DEFAULT_BPM): PlannerDoc {
	return { version: 1, bpm, tracks: [], clips: [], tempos: [] };
}
