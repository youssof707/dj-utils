// Adding and deleting cue points in a Rekordbox database.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { testDir } from "../testdata";
import { backupDatabase, changeCues, datKey, newCueRow, readCues } from "../../src/main/rekordbox";
import { cueRows, makeMasterDb, queryDb, SQLCIPHER } from "../rekordboxDb";

const DAT = "/PIONEER/USBANLZ/001/001aa-1f81-4747-b48a-e4dce25729c8/ANLZ0000.DAT";
const OTHER = "/PIONEER/USBANLZ/002/002aa-1f81-4747-b48a-e4dce25729c8/ANLZ0000.DAT";
const A = { id: "100", uuid: "uuid-a" };
const B = { id: "200", uuid: "uuid-b" };

let db: string;
beforeEach(() => {
	db = path.join(testDir("rekordbox-cues-"), "master.db");
	makeMasterDb(
		db,
		[
			{ ...A, dat: DAT },
			{ ...B, dat: OTHER },
		],
		[
			{ id: "1", contentId: A.id, ms: 4000, kind: 0 },
			{ id: "2", contentId: A.id, ms: 4000, kind: 1 },
			{ id: "3", contentId: A.id, ms: 8000, kind: 3 },
			{ id: "4", contentId: A.id, ms: 9000, kind: 5 }, // D
			{ id: "5", contentId: A.id, ms: 10000, kind: 6, outMs: 12000 }, // a loop on E
			{ id: "6", contentId: A.id, ms: 11000, kind: 4 }, // not a cue we know
			{ id: "7", contentId: B.id, ms: 500, kind: 3 },
		],
	);
});

const change = (job: Partial<Parameters<typeof changeCues>[2]>): ReturnType<typeof changeCues> => changeCues(SQLCIPHER, db, { contentId: A.id, remove: [], clear: [], insert: [], ...job });
const ids = (rows: Record<string, unknown>[]): unknown[] => rows.map((r) => r["ID"]);

describe("cues in the database", () => {
	it("adds a memory cue the way Rekordbox writes one", () => {
		const done = change({ insert: [newCueRow(A, 64001, 0)] });
		expect(done.removed).toEqual([]);
		expect(done.added).toHaveLength(1);
		const row = cueRows(db, A.id).find((r) => r["InMsec"] === 64001)!;
		expect(row).toEqual(done.added[0]);
		expect(row).toMatchObject({ ContentID: "100", ContentUUID: "uuid-a", InFrame: 9600, InMpegFrame: 0, OutMsec: -1, OutFrame: 0, Kind: 0, Color: -1, rb_local_deleted: 0, usn: null, rb_local_usn: null, Comment: null });
		expect(String(row["created_at"])).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \+00:00$/);
		expect(readCues(db).cues[datKey(DAT)].map((c) => c.ms)).toContain(64001);
	});

	it("never touches another track's cues", () => {
		expect(change({ remove: ["7"] }).removed).toEqual([]);
		expect(() => change({ insert: [newCueRow(B, 100, 0)] })).toThrow(/another track/);
		expect(ids(cueRows(db, B.id))).toEqual(["7"]);
	});

	it("writes nothing to a cue table it does not know", () => {
		const odd = path.join(testDir("rekordbox-cues-"), "master.db");
		makeMasterDb(odd, [{ ...A, dat: DAT }], [], { cueTable: "CREATE TABLE djmdCue (ID VARCHAR(255) PRIMARY KEY, ContentID VARCHAR(255), InMsec INTEGER, Kind INTEGER, Extra INTEGER);" });
		expect(() => changeCues(SQLCIPHER, odd, { contentId: A.id, remove: [], clear: [], insert: [newCueRow(A, 100, 0)] })).toThrow(/not supported/);
		expect(queryDb(odd, "select count(*) as n from djmdCue;")).toEqual([{ n: 0 }]);
	});

	it("says so when Rekordbox holds the database", async () => {
		// another program in the middle of a change of its own
		const holder = spawn(SQLCIPHER, ["-batch", db], { stdio: ["pipe", "pipe", "inherit"] });
		holder.stdin.write("PRAGMA key = '402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497';\nBEGIN IMMEDIATE;\nselect 'held';\n");
		await new Promise<void>((ok) => holder.stdout.on("data", (d: Buffer) => d.toString().includes("held") && ok()));
		try {
			expect(() => change({ remove: ["1"] })).toThrow(/busy/);
		} finally {
			holder.stdin.end("ROLLBACK;\n");
			await new Promise((ok) => holder.on("exit", ok));
		}
		expect(ids(cueRows(db, A.id))).toContain("1");
		expect(ids(change({ remove: ["1"] }).removed)).toEqual(["1"]);
	}, 20000);

	it("keeps one copy of the database from before the first change", () => {
		const copy = backupDatabase(db);
		expect(path.dirname(copy)).toBe(path.dirname(db));
		change({ remove: ["1"] });
		expect(backupDatabase(db)).toBe(copy);
		expect(ids(cueRows(copy, A.id))).toContain("1"); // the copy opens, and is as it was
		expect(fs.readdirSync(path.dirname(db)).filter((f) => f.endsWith(".part"))).toEqual([]);
	});
});
