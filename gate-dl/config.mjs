import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Where finished tracks go. Hard-coded for now.
export const STORE_DIR = path.join(ROOT, 'store');
export const RUNS_DIR = path.join(ROOT, 'gate-dl', 'runs');


export const CDP_PORT = 9333;
export const PROFILE_DIR = path.join(os.homedir(), '.claude-browser', 'soundcloud');
export const VIEWPORT = { width: 1280, height: 1100 };

// Whole run is killed after this.
export const RUN_TIMEOUT_MS = 4 * 60 * 1000;

// Playlist mode: minimum gap between tracks that did SoundCloud writes (DataDome flags bursts).
export const PLAYLIST_GAP_MS = 20 * 1000;

// SoundCloud support actions done before any gate.
export const ACTIONS = { follow: true, like: true, repost: true, comment: true };

// One is picked at random. Posted publicly from the logged-in account.
export const COMMENT_PHRASES = ['🔥🔥', '🔥', 'tune 🔥', 'banger', 'heater 🔥', 'love this one', '🔥🔥🔥'];

// Files smaller than this are treated as broken downloads.
export const MIN_AUDIO_BYTES = 500 * 1024;

// Used when a gate REQUIRES an email (optional email steps are skipped). null = fail loudly.
// Hypeddit checks it server-side (POST /verifyEmailAddress -> status F for mailinator.com), so a
// disposable domain won't do; it must be a real inbox the user picks.
export const GATE_EMAIL = null; // { name: 'phvraoh', email: '…' }
