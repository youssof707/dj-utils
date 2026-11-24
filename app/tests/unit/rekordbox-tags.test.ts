// Changing a track's app tags (My Tags in the "DJ Utilities" category) in Rekordbox's database (changeTags in main/rekordbox.ts).
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { testDir } from "../testdata";
import { changeTags } from "../../src/main/rekordbox";
import type { TagChange } from "../../src/shared/planner";
import { makeMasterDb, MY_TAG_TABLE, myTagRows, queryDb, SONG_MY_TAG_TABLE, SQLCIPHER } from "../rekordboxDb";

const DAT = "/PIONEER/USBANLZ/001/001aa-1f81-4747-b48a-e4dce25729c8/ANLZ0000.DAT";
const OTHER = "/PIONEER/USBANLZ/002/002aa-1f81-4747-b48a-e4dce25729c8/ANLZ0000.DAT";
const A = { id: "100", uuid: "uuid-a" };
const B = { id: "200", uuid: "uuid-b" };

// Genre and Situation are Rekordbox's own; "DJ Utilities" holds the app's tags
const GROUPS = [
	{ id: "1", name: "Genre", tags: [["11", "Techno"], ["12", "Deep House"]] as [string, string][] },
	{ id: "2", name: "Situation", tags: [["21", "Peak Time"], ["22", "Morning"]] as [string, string][] },
	{ id: "3", name: "DJ Utilities", tags: [["31", "Opener"], ["32", "Vocal"]] as [string, string][] },
];

let db: string;
beforeEach(() => {
	db = path.join(testDir("rekordbox-tags-"), "master.db");
	makeMasterDb(
		db,
		[
			{ ...A, dat: DAT },
			{ ...B, dat: OTHER },
		],
		[],
		{
			extra: [
				MY_TAG_TABLE,
				SONG_MY_TAG_TABLE,
				...myTagRows(GROUPS, [
					{ id: "s1", tag: "31", track: A.id },
					{ id: "s2", tag: "21", track: A.id },
					{ id: "s3", tag: "31", track: B.id },
				]),
			],
		},
	);
});

const change = (job: Partial<TagChange>): ReturnType<typeof changeTags> => changeTags(SQLCIPHER, db, { contentId: A.id, keep: [], create: [], ...job });
const tagsOn = (track: string): string[] => queryDb(db, `select MyTagID from djmdSongMyTag where ContentID = '${track}' order by MyTagID;`).map((r) => String(r["MyTagID"]));

describe("changing a track's tags", () => {
	it("leaves the track's Rekordbox tags alone, and puts none on", () => {
		const r = change({ keep: ["11"] });
		expect(r.tags).toEqual([]);
		// Peak Time stays, Opener comes off, Techno is not put on
		expect(tagsOn(A.id)).toEqual(["21"]);
	});

	it("never touches another track's tags", () => {
		change({ keep: [] });
		expect(tagsOn(A.id)).toEqual(["21"]);
		expect(tagsOn(B.id)).toEqual(["31"]);
	});

	it("writes nothing to a tag table it does not know", () => {
		const odd = path.join(testDir("rekordbox-tags-odd-"), "master.db");
		makeMasterDb(odd, [{ ...A, dat: DAT }], [], { extra: [MY_TAG_TABLE, "CREATE TABLE djmdSongMyTag (ID VARCHAR(255) PRIMARY KEY, MyTagID VARCHAR(255), ContentID VARCHAR(255), Extra INTEGER);", ...myTagRows(GROUPS)] });
		expect(() => changeTags(SQLCIPHER, odd, { contentId: A.id, keep: ["31"], create: [{ name: "Acid" }] })).toThrow(/not supported/);
		expect(queryDb(odd, "select count(*) as n from djmdMyTag where Name = 'Acid';")).toEqual([{ n: 0 }]);
	});
});
