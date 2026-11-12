// Loud, structured failures. Every unexpected state must end up as a GateDlError
// so the babysitting agent gets a code, the step it happened in, and evidence.

export const CODES = {
  BROWSER: 'BROWSER',             // Chrome / CDP could not start or talk
  NOT_LOGGED_IN: 'NOT_LOGGED_IN', // SoundCloud session missing in the profile
  TRACK: 'TRACK',                 // could not resolve the SoundCloud track
  SC_ACTION: 'SC_ACTION',         // follow / like / repost / comment failed
  CAPTCHA: 'CAPTCHA',             // SoundCloud's DataDome wants a captcha: session flagged, stop the batch
  NO_GATE_FOUND: 'NO_GATE_FOUND', // no download link of any kind on the track
  UNKNOWN_GATE: 'UNKNOWN_GATE',   // links found, but no gate utility matches them
  GATE_CHANGED: 'GATE_CHANGED',   // a known gate's page no longer looks as expected
  GATE_FAILED: 'GATE_FAILED',     // gate flow ran but refused to unlock
  DOWNLOAD: 'DOWNLOAD',           // fetching the file failed
  BAD_FILE: 'BAD_FILE',           // the file is not audio / too small
  TIMEOUT: 'TIMEOUT',             // global run timeout
  INTERNAL: 'INTERNAL',           // bug in the script itself
};

export class GateDlError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const fail = (code, message, details) => { throw new GateDlError(code, message, details); };

// Tracks which step we are in, so failures say where they happened.
export const progress = { step: 'start', history: [] };
export function step(name) {
  progress.step = name;
  progress.history.push({ step: name, t: new Date().toISOString() });
  process.stderr.write(`[gate-dl] ${name}\n`);
}
