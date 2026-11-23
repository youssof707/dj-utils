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
	it("takes app tags off and puts others on, the way Rekordbox writes them", () => {
		const r = change({ keep: ["31", "32"] });
		expect([...r.tags].sort()).toEqual(["31", "32"]);
		expect(tagsOn(A.id)).toEqual(["21", "31", "32"]);
		const row = queryDb(db, `select * from djmdSongMyTag where ContentID = '${A.id}' and MyTagID = '32';`)[0];
		expect(row).toMatchObject({ TrackNo: 1, rb_local_deleted: 0 });
		expect(typeof row["UUID"]).toBe("string");
		expect(typeof row["created_at"]).toBe("string");
		// the tag already on the track keeps its row
		expect(queryDb(db, `select ID from djmdSongMyTag where ContentID = '${A.id}' and MyTagID = '31';`)).toEqual([{ ID: "s1" }]);
	});

	it("leaves the track's Rekordbox tags alone, and puts none on", () => {
		const r = change({ keep: ["11"] });
		expect(r.tags).toEqual([]);
		// Peak Time stays, Opener comes off, Techno is not put on
		expect(tagsOn(A.id)).toEqual(["21"]);
	});

	it("numbers a tag's tracks on from the last one", () => {
		change({ contentId: B.id, keep: ["31", "32"] });
		change({ keep: ["31", "32"] });
		expect(queryDb(db, `select TrackNo from djmdSongMyTag where ContentID = '${A.id}' and MyTagID = '32';`)).toEqual([{ TrackNo: 2 }]);
	});

	it("makes a new tag at the end of the app's category", () => {
		const r = change({ keep: ["31"], create: [{ name: " Acid " }] });
		expect(r.created).toEqual([{ id: r.created[0].id, name: "Acid" }]);
		expect(queryDb(db, `select Seq, Attribute, ParentID from djmdMyTag where ID = '${r.created[0].id}';`)).toEqual([{ Seq: 3, Attribute: 0, ParentID: "3" }]);
		expect(tagsOn(A.id)).toEqual(["21", "31", r.created[0].id].sort());
	});

	it("makes the app's category when Rekordbox has none", () => {
		const bare = path.join(testDir("rekordbox-tags-bare-"), "master.db");
		makeMasterDb(bare, [{ ...A, dat: DAT }], [], { extra: [MY_TAG_TABLE, SONG_MY_TAG_TABLE, ...myTagRows(GROUPS.slice(0, 2), [{ id: "s1", tag: "11", track: A.id }])] });
		const r = changeTags(SQLCIPHER, bare, { contentId: A.id, keep: [], create: [{ name: "Acid" }, { name: "Opener" }] });
		const group = queryDb(bare, "select ID, Seq, Attribute, ParentID from djmdMyTag where Name = 'DJ Utilities';");
		expect(group).toEqual([{ ID: group[0]["ID"], Seq: 3, Attribute: 1, ParentID: "root" }]);
		expect(queryDb(bare, "select Name, Seq from djmdMyTag where Attribute = 0 and ParentID = (select ID from djmdMyTag where Name = 'DJ Utilities') order by Seq;")).toEqual([
			{ Name: "Acid", Seq: 1 },
			{ Name: "Opener", Seq: 2 },
		]);
		expect(r.tags).toHaveLength(2);
		// Techno, from Rekordbox's Genre, stays on
		expect(queryDb(bare, `select count(*) as n from djmdSongMyTag where ContentID = '${A.id}';`)).toEqual([{ n: 3 }]);
		// a second time uses the category it made
		changeTags(SQLCIPHER, bare, { contentId: A.id, keep: [], create: [{ name: "Late" }] });
		expect(queryDb(bare, "select count(*) as n from djmdMyTag where Name = 'DJ Utilities';")).toEqual([{ n: 1 }]);
	});

	it("makes no category when no tag is made", () => {
		const bare = path.join(testDir("rekordbox-tags-none-"), "master.db");
		makeMasterDb(bare, [{ ...A, dat: DAT }], [], { extra: [MY_TAG_TABLE, SONG_MY_TAG_TABLE, ...myTagRows(GROUPS.slice(0, 2), [{ id: "s1", tag: "11", track: A.id }])] });
		expect(changeTags(SQLCIPHER, bare, { contentId: A.id, keep: [], create: [] }).tags).toEqual([]);
		expect(queryDb(bare, "select count(*) as n from djmdMyTag where Name = 'DJ Utilities';")).toEqual([{ n: 0 }]);
		expect(queryDb(bare, `select MyTagID from djmdSongMyTag where ContentID = '${A.id}';`)).toEqual([{ MyTagID: "11" }]);
	});

	it("uses a tag already in the app's category instead of making one of the same name", () => {
		const r = change({ create: [{ name: "opener" }] });
		expect(r.created).toEqual([]);
		expect(r.tags).toEqual(["31"]);
		expect(queryDb(db, "select count(*) as n from djmdMyTag where Attribute = 0;")).toEqual([{ n: 6 }]);
	});

	it("makes its own tag even when a Rekordbox category has one of that name", () => {
		const r = change({ create: [{ name: "Techno" }] });
		expect(r.created).toHaveLength(1);
		expect(queryDb(db, `select ParentID from djmdMyTag where ID = '${r.created[0].id}';`)).toEqual([{ ParentID: "3" }]);
	});

	it("makes a tag of the same name only once", () => {
		const r = change({ create: [{ name: "Acid" }, { name: "acid " }] });
		expect(queryDb(db, "select count(*) as n from djmdMyTag where lower(Name) = 'acid';")).toEqual([{ n: 1 }]);
		expect(r.tags).toHaveLength(1);
	});

	it("doing it twice changes nothing", () => {
		change({ keep: ["32"] });
		const rows = queryDb(db, "select * from djmdSongMyTag order by ID;");
		change({ keep: ["32"] });
		expect(queryDb(db, "select * from djmdSongMyTag order by ID;")).toEqual(rows);
	});

	it("never touches another track's tags", () => {
		change({ keep: [] });
		expect(tagsOn(A.id)).toEqual(["21"]);
		expect(tagsOn(B.id)).toEqual(["31"]);
	});

	it("writes nothing for a track that is not in Rekordbox", () => {
		expect(() => change({ contentId: "999", keep: ["31"] })).toThrow(/no longer in Rekordbox/);
		expect(tagsOn("999")).toEqual([]);
	});

	it("writes nothing to a tag table it does not know", () => {
		const odd = path.join(testDir("rekordbox-tags-odd-"), "master.db");
		makeMasterDb(odd, [{ ...A, dat: DAT }], [], { extra: [MY_TAG_TABLE, "CREATE TABLE djmdSongMyTag (ID VARCHAR(255) PRIMARY KEY, MyTagID VARCHAR(255), ContentID VARCHAR(255), Extra INTEGER);", ...myTagRows(GROUPS)] });
		expect(() => changeTags(SQLCIPHER, odd, { contentId: A.id, keep: ["31"], create: [{ name: "Acid" }] })).toThrow(/not supported/);
		expect(queryDb(odd, "select count(*) as n from djmdMyTag where Name = 'Acid';")).toEqual([{ n: 0 }]);
	});
});
