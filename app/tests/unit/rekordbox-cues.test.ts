// Adding and deleting cue points in a Rekordbox database, and the pure parts of the UI
// around them.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { testDir } from "../testdata";
import { backupDatabase, changeCues, cuesAfter, datKey, newCueRow, readCues } from "../../src/main/rekordbox";
import { cueMarks, cuesAt, cueSnapBeat, cueName, hotCueKind } from "../../src/shared/cues";
import type { PlannerTrack } from "../../src/shared/planner";
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
	it("reads each cue with its id, its letter and whether it is a loop", () => {
		const lib = readCues(db);
		expect(lib.contents[datKey(DAT)]).toEqual(A);
		expect(lib.cues[datKey(DAT)]).toEqual([
			{ id: "1", ms: 4000, kind: 0, loop: false },
			{ id: "2", ms: 4000, kind: 1, loop: false },
			{ id: "3", ms: 8000, kind: 3, loop: false },
			{ id: "4", ms: 9000, kind: 4, loop: false },
			{ id: "5", ms: 10000, kind: 5, loop: true },
		]);
	});

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

	it("stores hot cue D and later one kind higher", () => {
		expect(change({ clear: [8], insert: [newCueRow(A, 2000, 8)] }).added[0]["Kind"]).toBe(9);
		expect(readCues(db).cues[datKey(DAT)].find((c) => c.ms === 2000)?.kind).toBe(8);
	});

	it("a hot cue takes the place of the one on its letter, on that track only", () => {
		const done = change({ clear: [3], insert: [newCueRow(A, 2000, 3)] });
		expect(ids(done.removed)).toEqual(["3"]);
		expect(cueRows(db, A.id).filter((r) => r["Kind"] === 3)).toEqual(done.added);
		expect(ids(cueRows(db, B.id))).toEqual(["7"]);
	});

	it("puts a deleted cue back exactly, and doing it twice changes nothing", () => {
		const before = cueRows(db, A.id);
		const gone = change({ remove: ["5", "1"] });
		expect(ids(gone.removed).sort()).toEqual(["1", "5"]);
		expect(ids(cueRows(db, A.id))).not.toContain("5");
		for (let i = 0; i < 2; i++) {
			const back = change({ insert: gone.removed });
			expect(back.removed).toEqual([]);
			expect(cueRows(db, A.id)).toEqual(before);
		}
		// deleting what is already gone is nothing, too
		change({ remove: ["5"] });
		expect(change({ remove: ["5"] })).toEqual({ removed: [], added: [] });
	});

	it("undoing a replaced hot cue brings the old one back in one go", () => {
		const before = cueRows(db, A.id);
		const done = change({ clear: [3], insert: [newCueRow(A, 2000, 3)] });
		change({ remove: ids(done.added) as string[], insert: done.removed });
		expect(cueRows(db, A.id)).toEqual(before);
		// and redo
		change({ remove: ids(done.removed) as string[], insert: done.added });
		expect(cueRows(db, A.id).filter((r) => r["Kind"] === 3)).toEqual(done.added);
	});

	it("leaves out a hot cue whose letter has been taken since", () => {
		const gone = change({ remove: ["3"] });
		change({ insert: [newCueRow(A, 2000, 3)] });
		expect(change({ insert: gone.removed }).added).toEqual([]);
		expect(cueRows(db, A.id).filter((r) => r["Kind"] === 3)).toHaveLength(1);
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

	it("works out a track's cues after a change", () => {
		const cues = readCues(db).cues[datKey(DAT)];
		const done = change({ clear: [3], insert: [newCueRow(A, 2000, 3)] });
		expect(cuesAfter(cues, done.removed, done.added)).toEqual(readCues(db).cues[datKey(DAT)]);
	});
});

describe("cues on a track", () => {
	// 120 BPM, first bar line a quarter of a second in: beat lines at 0.5, 1.5, 2.5... beats
	const track: PlannerTrack = { id: "t", name: "t", sourcePath: "/t.wav", bpm: 120, durationSec: 60, downbeatSec: 0.25 };
	const cues = [
		{ id: "m", sec: 4.25, kind: 0 },
		{ id: "a", sec: 4.251, kind: 1 },
		{ id: "c", sec: 8.25, kind: 3 },
	];

	it("puts cues at the same moment on one line and keeps them", () => {
		const marks = cueMarks(cues, track);
		expect(marks.map((m) => [m.beat, m.memory, m.letters.join("")])).toEqual([
			[8.5, true, "A"],
			[16.5, false, "C"],
		]);
		expect(marks[0].cues.map((c) => c.id)).toEqual(["m", "a"]);
	});

	it("finds the cues under the pointer, within a few pixels and inside what is drawn", () => {
		const marks = cueMarks(cues, track);
		expect(cuesAt(marks, 8.7, 20).map((c) => c.id)).toEqual(["m", "a"]); // 4 px away
		expect(cuesAt(marks, 8.9, 20)).toEqual([]); // 8 px away
		expect(cuesAt(marks, 16.5, 20, { from: 0, to: 16 })).toEqual([]);
		expect(cuesAt(marks, 16.5, 20, { from: 16.5, to: 20 }).map((c) => c.id)).toEqual(["c"]);
	});

	it("puts a new cue on the nearest beat line of the track", () => {
		expect(cueSnapBeat(track, 10.1)).toBeCloseTo(10.5, 9);
		expect(cueSnapBeat(track, 9.9)).toBeCloseTo(9.5, 9);
		expect(cueSnapBeat(track, 0.1)).toBeCloseTo(0.5, 9); // never before the first line
		expect(cueSnapBeat(track, 1e6)).toBeLessThan(120); // nor past the end of the file
	});

	it("names cues and reads their letters", () => {
		expect(cueName({ id: "", sec: 0, kind: 0 })).toBe("memory cue");
		expect(cueName({ id: "", sec: 0, kind: 3 })).toBe("hot cue C");
		expect(cueName({ id: "", sec: 0, kind: 5, loop: true })).toBe("hot loop E");
		expect([..."aAhH"].map(hotCueKind)).toEqual([1, 1, 8, 8]);
		expect(["i", "z", "1", " ", "Escape", "Shift", "é"].map(hotCueKind)).toEqual([0, 0, 0, 0, 0, 0, 0]);
	});
});
