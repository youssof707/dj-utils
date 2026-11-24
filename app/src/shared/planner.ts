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
	// Set from the clip's menu and saved with the set; left out when off. A muted clip makes
	// no sound; a clip with `lowCut` plays without its bass (see LOW_CUT_HZ).
	muted?: boolean;
	lowCut?: boolean;
};

// "Mute bass" is a mixer's low knob turned all the way down: everything below the low
// band's crossover is removed. 250 Hz is where DJ mixer isolators split low from mid; the
// slope is 24 dB per octave (two second-order sections, together a fourth-order Butterworth).
export const LOW_CUT_HZ = 250;
export const LOW_CUT_QS = [0.5412, 1.3066];
// Over the last moment of the clip the cut-off slides down to here, so the bass is back by
// the time the next clip carries on and the join does not click.
export const LOW_CUT_EDGE_SEC = 0.03;
export const LOW_CUT_END_HZ = 20;

// A tempo change sits in the tempo lane like a clip: over its length the tempo ramps from
// whatever it was before to `bpm`, then holds there until the next change.
// `off`: switched off from its dot; it stays on the lane but changes nothing.
export type TempoBlock = { id: string; startBeat: number; lengthBeat: number; bpm: number; off?: boolean };

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
// cue; 1 and up are the hot cues A, B, C... `id` is Rekordbox's own for it.
export type Cue = { id: string; sec: number; kind: number; loop?: boolean };
// A track's cues, and whether they can be added to and deleted from here.
export type CueInfo = { cues: Cue[]; canEdit: boolean };
// A cue exactly as Rekordbox's database holds it, every column: what undo puts back.
export type CueRow = Record<string, string | number | null>;
// What a change to a track's cues did, and the cues the track has now.
export type CueChange = { cues: Cue[]; added: CueRow[]; removed: CueRow[] };
export const HOT_CUES = 8; // A to H
export const MEMORY_CUES = 10; // Rekordbox keeps at most this many memory cues on a track

// A track in the Rekordbox library. `bpm` is 0 and `key` is "" when Rekordbox has none.
// `key` is in Camelot form (8A, 7B) where Rekordbox's can be read that way, and `keyOrder`
// then puts keys in the order 1A, 1B, 2A ... 12B; it is null for any other key. `added`
// counts up in the order tracks were added to Rekordbox. `available` is false when there
// is no file to load: a streaming track, or a file that is gone. `tags` are the ids of its
// app tags.
export type RekordboxTrack = { id: string; title: string; artist: string; bpm: number; key: string; keyOrder: number | null; lengthSec: number; path: string; available: boolean; added: number; tags: string[] };
// A playlist with the folders it sits in as part of its name ("Folder / Playlist"), and
// its tracks' ids in playlist order.
export type RekordboxPlaylist = { id: string; name: string; tracks: string[] };
// The tags this app made, which are Rekordbox My Tags in a category of their own
// (APP_TAG_GROUP), in Rekordbox's order. Rekordbox's other My Tags are left out.
export const APP_TAG_GROUP = "DJ Utilities";
export type RekordboxTag = { id: string; name: string };
// `canTag` is false when this build cannot write to Rekordbox's database.
export type RekordboxLibrary = { tracks: RekordboxTrack[]; playlists: RekordboxPlaylist[]; tags: RekordboxTag[]; canTag?: boolean };
// The app's tags a track is to have from now on: these existing ones, and new ones by these
// names (a tag of the same name already there is used instead). Its other My Tags stay.
export type TagChange = { contentId: string; keep: string[]; create: { name: string }[] };
// The track's app tags after the change, and the tags that were made for it.
export type TagChangeResult = { tags: string[]; created: RekordboxTag[] };

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
// `lowCut` clips are mixed without their bass. Muted clips are not sent at all.
export type ExportClip = { cachePath: string; startFrame: number; offsetFrame: number; frames: number; fadeInFrames?: number; fadeOutFrames?: number; lowCut?: boolean };
export type ExportRequest = {
	outPath: string;
	projectBpm: number;
	clips: ExportClip[];
	points: { beat: number; bpm: number }[];
	keyLock: boolean;
};
export type ExportResult = { path: string; seconds: number; gainDb: number };
export type ExportProgress = { stage: string; pct: number };

// An edited track to write out: stretches of tracks, each at its place in the result (see
// @shared/trackEdit). Beats are each track's own, at `bpm`. The file is named after `name` and
// goes in the export folder from the settings. A section with `src` i > 0 is a stretch of
// `others[i - 1]`; the file is at the first track's tempo, the others stretched to it.
// `outPath`: a file held for it with reserveEdit (a background export); else one is picked.
export type EditExportRequest = { sourcePath: string; name: string; outPath?: string; bpm: number; downbeatSec?: number; sections: { startBeat: number; lengthBeat: number; atBeat: number; src?: number }[]; others?: { sourcePath: string; bpm: number }[] };
export type EditExportResult = { path: string; seconds: number; sampleRate: number; bits: number; channels: number };

// `lastSetId`: the set that was open when the app last closed, reopened at launch.
export type Settings = { exportDir: string; lastSetId: string | null };

// A set as the app stores it. The app keeps every set itself; there are no set files to
// save or open. `view` is where the timeline was left.
// `starred`: the library tracks starred for this set, by file, in the order they were starred.
export type SetView = { pxPerBeat: number; scrollX: number; playheadBeat: number; starred?: string[] };
// `playlist`: the Rekordbox playlist this set owns (playlist mode), by id. No two sets own
// the same one; syncing makes it hold exactly the set's tracks.
export type SetFile = { id: string; name: string; createdAt: number; updatedAt: number; openedAt: number; view: SetView; doc: PlannerDoc; playlist?: string };

// Where a set stands with its Rekordbox playlist. `playlists` are all of Rekordbox's, each
// with the name of the other set that owns it, if one does. `tracks` is how many of the
// set's tracks would go in; `missing` names the ones Rekordbox does not have. `synced` is
// true when the playlist already holds exactly those, in order. `canWrite` is false when
// this build cannot write to Rekordbox's database. Null when there is no Rekordbox here.
export type PlaylistStatus = { linked: RekordboxPlaylist | null; playlists: (RekordboxPlaylist & { takenBy?: string })[]; tracks: number; missing: string[]; synced: boolean; canWrite: boolean };
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
