// A Rekordbox database for tests: encrypted the way Rekordbox's is, with its cue table as
// it really is and just enough of its track table to find a track's cues.

import { spawnSync } from "node:child_process";
import path from "node:path";

export const SQLCIPHER = path.resolve(__dirname, "../resources/sqlcipher");
const KEY = "402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497";
const NOW = "2026-01-01 00:00:00.000 +00:00";

const CUE_TABLE =
	"CREATE TABLE `djmdCue` (`ID` VARCHAR(255) PRIMARY KEY, `ContentID` VARCHAR(255) DEFAULT NULL, `InMsec` INTEGER DEFAULT NULL, `InFrame` INTEGER DEFAULT NULL, `InMpegFrame` INTEGER DEFAULT NULL, `InMpegAbs` INTEGER DEFAULT NULL, `OutMsec` INTEGER DEFAULT NULL, `OutFrame` INTEGER DEFAULT NULL, `OutMpegFrame` INTEGER DEFAULT NULL, `OutMpegAbs` INTEGER DEFAULT NULL, `Kind` INTEGER DEFAULT NULL, `Color` INTEGER DEFAULT NULL, `ColorTableIndex` INTEGER DEFAULT NULL, `ActiveLoop` INTEGER DEFAULT NULL, `Comment` VARCHAR(255) DEFAULT NULL, `BeatLoopSize` INTEGER DEFAULT NULL, `CueMicrosec` INTEGER DEFAULT NULL, `InPointSeekInfo` VARCHAR(255) DEFAULT NULL, `OutPointSeekInfo` VARCHAR(255) DEFAULT NULL, `ContentUUID` VARCHAR(255) DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);";
const CONTENT_TABLE = "CREATE TABLE `djmdContent` (`ID` VARCHAR(255) PRIMARY KEY, `UUID` VARCHAR(255) DEFAULT NULL, `AnalysisDataPath` VARCHAR(255) DEFAULT NULL, `rb_local_deleted` TINYINT(1) DEFAULT 0);";

// Rekordbox's My Tag tables as they really are.
export const PLAYLIST_TABLE =
	"CREATE TABLE `djmdPlaylist` (`ID` VARCHAR(255) PRIMARY KEY, `Seq` INTEGER DEFAULT NULL, `Name` VARCHAR(255) DEFAULT NULL, `ImagePath` VARCHAR(255) DEFAULT NULL, `Attribute` INTEGER DEFAULT NULL, `ParentID` VARCHAR(255) DEFAULT NULL, `SmartList` TEXT DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);";
export const SONG_PLAYLIST_TABLE =
	"CREATE TABLE `djmdSongPlaylist` (`ID` VARCHAR(255) PRIMARY KEY, `PlaylistID` VARCHAR(255) DEFAULT NULL, `ContentID` VARCHAR(255) DEFAULT NULL, `TrackNo` INTEGER DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);";
export const MY_TAG_TABLE =
	"CREATE TABLE `djmdMyTag` (`ID` VARCHAR(255) PRIMARY KEY, `Seq` INTEGER DEFAULT NULL, `Name` VARCHAR(255) DEFAULT NULL, `Attribute` INTEGER DEFAULT NULL, `ParentID` VARCHAR(255) DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);";
export const SONG_MY_TAG_TABLE =
	"CREATE TABLE `djmdSongMyTag` (`ID` VARCHAR(255) PRIMARY KEY, `MyTagID` VARCHAR(255) DEFAULT NULL, `ContentID` VARCHAR(255) DEFAULT NULL, `TrackNo` INTEGER DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);";

// SQL that fills the tag tables: `groups` are categories with their tags as [id, name],
// `on` says which track has which tag.
export function myTagRows(groups: { id: string; name: string; tags: [string, string][] }[], on: { id: string; tag: string; track: string }[] = []): string[] {
	const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
	const lines: string[] = [];
	groups.forEach((g, i) => {
		lines.push(`insert into djmdMyTag (ID, Seq, Name, Attribute, ParentID, UUID, created_at, updated_at) values (${q(g.id)}, ${i + 1}, ${q(g.name)}, 1, 'root', ${q(`uuid-${g.id}`)}, ${q(NOW)}, ${q(NOW)});`);
		g.tags.forEach(([id, name], j) => lines.push(`insert into djmdMyTag (ID, Seq, Name, Attribute, ParentID, UUID, created_at, updated_at) values (${q(id)}, ${j + 1}, ${q(name)}, 0, ${q(g.id)}, ${q(`uuid-${id}`)}, ${q(NOW)}, ${q(NOW)});`));
	});
	on.forEach((s, i) => lines.push(`insert into djmdSongMyTag (ID, MyTagID, ContentID, TrackNo, UUID, created_at, updated_at) values (${q(s.id)}, ${q(s.tag)}, ${q(s.track)}, ${i + 1}, ${q(`uuid-${s.id}`)}, ${q(NOW)}, ${q(NOW)});`));
	return lines;
}

// Runs SQL on an encrypted database and gives the rows of its last query.
export function queryDb(file: string, sql: string): Record<string, unknown>[] {
	const r = spawnSync(SQLCIPHER, ["-batch", "-bail", file], { input: `PRAGMA key = '${KEY}';\n.mode json\n${sql}\n`, encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	const at = r.stdout.indexOf("[");
	return at < 0 ? [] : (JSON.parse(r.stdout.slice(at)) as Record<string, unknown>[]);
}

export type TestContent = { id: string; uuid: string; dat: string };
// `kind` is as the database has it: 0 memory, 1 to 3 hot cues A to C, 5 to 9 D to H.
export type TestCue = { id: string; contentId: string; ms: number; kind: number; outMs?: number };

// Where a track's analysis file is, the way the database writes it.
export const storedDat = (dat: string): string => `/PIONEER/USBANLZ/${dat.split(path.sep).slice(-3).join("/")}`;

// `extra` is more SQL to run, such as the tag tables and their rows.
export function makeMasterDb(file: string, contents: TestContent[], cues: TestCue[], opts: { cueTable?: string; extra?: string[] } = {}): void {
	const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
	const lines = [opts.cueTable ?? CUE_TABLE, CONTENT_TABLE, ...(opts.extra ?? []), "PRAGMA journal_mode = wal;"];
	for (const c of contents) lines.push(`insert into djmdContent (ID, UUID, AnalysisDataPath) values (${q(c.id)}, ${q(c.uuid)}, ${q(c.dat)});`);
	for (const c of cues) {
		const uuid = contents.find((t) => t.id === c.contentId)?.uuid ?? "";
		lines.push(
			"insert into djmdCue (ID, ContentID, InMsec, InFrame, InMpegFrame, InMpegAbs, OutMsec, OutFrame, OutMpegFrame, OutMpegAbs, Kind, Color, ContentUUID, UUID, created_at, updated_at) " +
				`values (${q(c.id)}, ${q(c.contentId)}, ${c.ms}, ${Math.round(c.ms * 0.15)}, 0, 0, ${c.outMs ?? -1}, ${c.outMs ? Math.round(c.outMs * 0.15) : 0}, 0, 0, ${c.kind}, -1, ${q(uuid)}, ${q(`uuid-${c.id}`)}, ${q(NOW)}, ${q(NOW)});`,
		);
	}
	queryDb(file, lines.join("\n"));
}

// The cue rows of a track, in time order.
export function cueRows(file: string, contentId: string): Record<string, unknown>[] {
	return queryDb(file, `select * from djmdCue where ContentID = '${contentId}' order by InMsec, Kind;`);
}
