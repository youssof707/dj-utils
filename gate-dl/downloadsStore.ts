// Ledger of successfully downloaded tracks. The gate-dl script imports this .ts file
// directly via Node's native type stripping, so keep it to node builtins and erasable TS
// syntax only.
//
// One pretty-printed JSON file, written atomically (temp file + rename), created on first write:
//   ~/Library/Application Support/gate-dl/data/downloads.json
// Shape: { "tracks": { "<normalized track url>": { id, title, files, gate, gateUrl, at } } }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Track = {
  id?: number;
  title?: string;
  files: string[];
  gate?: string;
  gateUrl?: string;
  at: string;
  seededFrom?: string;
};

export type DownloadsDb = { tracks: Record<string, Track> };

function dataDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'gate-dl', 'data');
}

function storeFile(): string {
  return path.join(dataDir(), 'downloads.json');
}

// soundcloud.com/a/b, www./m. variants, trailing slash, ?query and #hash all map to one key.
// Private tracks keep their secret_token so they stay distinct.
export function trackKey(url: string): string {
  const u = new URL(url);
  const host = u.hostname.replace(/^(www|m)\./, '').toLowerCase();
  const token = u.searchParams.get('secret_token');
  return `https://${host}${u.pathname.replace(/\/+$/, '').toLowerCase()}${token ? `?secret_token=${token}` : ''}`;
}

function writeAtomic(db: DownloadsDb): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = storeFile();
  const tmp = `${file}.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function load(): DownloadsDb {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { tracks: {} };
    throw e;
  }
}

// Returns the record if this track (by url, or SoundCloud id when given) was downloaded before.
export function downloaded(url: string, id?: number | null): Track | null {
  const { tracks } = load();
  return tracks[trackKey(url)] || (id != null && Object.values(tracks).find(t => t.id === id)) || null;
}

export function markDownloaded(url: string, rec: Omit<Track, 'at'>): void {
  const db = load();
  db.tracks[trackKey(url)] = { ...rec, at: new Date().toISOString() };
  writeAtomic(db);
}
