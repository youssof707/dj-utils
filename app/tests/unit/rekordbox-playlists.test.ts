// Making a Rekordbox playlist and syncing it to a set (createPlaylist, fillPlaylist and
// notePlaylist in main/rekordbox.ts).
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { testDir } from "../testdata";
import { createPlaylist, fillPlaylist } from "../../src/main/rekordbox";
import { makeMasterDb, PLAYLIST_TABLE, queryDb, SONG_PLAYLIST_TABLE, SQLCIPHER } from "../rekordboxDb";

const DAT = (n: number): string => `/PIONEER/USBANLZ/00${n}/00${n}aa-1f81-4747-b48a-e4dce25729c8/ANLZ0000.DAT`;
const now = "'2026-01-01 00:00:00.000 +00:00'";
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n\n<MASTER_PLAYLIST Version="3.0.0" AutomaticSync="0">\n  <PLAYLISTS>\n    <NODE Id="2A" ParentId="0" Attribute="0" Timestamp="1" Lib_Type="0" CheckType="0"/>\n  </PLAYLISTS>\n</MASTER_PLAYLIST>\n';

let db: string;
let xml: string;
beforeEach(() => {
	const dir = testDir("rekordbox-playlists-");
	db = path.join(dir, "master.db");
	xml = path.join(dir, "masterPlaylists6.xml");
	fs.writeFileSync(xml, XML);
	makeMasterDb(
		db,
		[1, 2, 3].map((n) => ({ id: `${n}00`, uuid: `uuid-${n}`, dat: DAT(n) })),
		[],
		{
			extra: [
				PLAYLIST_TABLE,
				SONG_PLAYLIST_TABLE,
				`insert into djmdPlaylist (ID, Seq, Name, Attribute, ParentID, created_at, updated_at) values ('42', 1, 'Old set', 0, 'root', ${now}, ${now});`,
				`insert into djmdPlaylist (ID, Seq, Name, Attribute, ParentID, SmartList, created_at, updated_at) values ('43', 2, 'Smart', 0, 'root', '<rules/>', ${now}, ${now});`,
				`insert into djmdSongPlaylist (ID, PlaylistID, ContentID, TrackNo, created_at, updated_at) values ('a', '42', '300', 1, ${now}, ${now});`,
				`insert into djmdSongPlaylist (ID, PlaylistID, ContentID, TrackNo, created_at, updated_at) values ('b', '43', '300', 1, ${now}, ${now});`,
			],
		},
	);
});

const inList = (id: string): string[] => queryDb(db, `select ContentID from djmdSongPlaylist where PlaylistID = '${id}' order by TrackNo;`).map((r) => String(r["ContentID"]));

describe("playlists", () => {
	it("makes a playlist after the others and lists it in masterPlaylists6.xml", () => {
		const p = createPlaylist(SQLCIPHER, db, "  Friday set ");
		expect(p.name).toBe("Friday set");
		expect(queryDb(db, `select Seq, Attribute, ParentID from djmdPlaylist where ID = '${p.id}';`)).toEqual([{ Seq: 3, Attribute: 0, ParentID: "root" }]);
		expect(fs.readFileSync(xml, "utf8")).toContain(`<NODE Id="${Number(p.id).toString(16).toUpperCase()}" ParentId="0" Attribute="0"`);
	});

	it("wipes the playlist and fills it in the order given, leaving out unknown tracks", () => {
		expect(fillPlaylist(SQLCIPHER, db, "42", ["200", "999", "100", "200"])).toEqual(["200", "100"]);
		expect(inList("42")).toEqual(["200", "100"]);
		expect(queryDb(db, "select TrackNo from djmdSongPlaylist where PlaylistID = '42' order by TrackNo;")).toEqual([{ TrackNo: 1 }, { TrackNo: 2 }]);
		expect(inList("43")).toEqual(["300"]); // other playlists stay as they were
		expect(fs.readFileSync(xml, "utf8")).not.toContain('Timestamp="1"');
		expect(fillPlaylist(SQLCIPHER, db, "42", [])).toEqual([]);
	});

	it("refuses a smart playlist or one that is gone", () => {
		expect(() => fillPlaylist(SQLCIPHER, db, "43", ["100"])).toThrow(/no longer in Rekordbox/);
		expect(() => fillPlaylist(SQLCIPHER, db, "77", ["100"])).toThrow(/no longer in Rekordbox/);
		expect(inList("43")).toEqual(["300"]);
	});
});
