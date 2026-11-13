// The library panel on a small Rekordbox database made for the test: all tracks, search,
// the playlist picker, sorting, and adding a track to the set.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryDb } from "../rekordboxDb";
import { writeBarTrack } from "../signals";
import { testDir } from "../testdata";
import { launch, shot, state, type Harness } from "./harness";

let h: Harness;
let work: string;
let song: string;

beforeAll(async () => {
	work = testDir("library-");
	song = path.join(work, "Belfast.wav");
	writeBarTrack(song, 128, 10);
	const q = (v: string): string => `'${v.replace(/'/g, "''")}'`;
	// these only need to be there; Belfast is the one that gets loaded
	const file = (name: string): string => {
		fs.writeFileSync(path.join(work, name), "");
		return q(path.join(work, name));
	};
	const db = path.join(work, "master.db");
	queryDb(
		db,
		[
			"create table djmdArtist (ID text, Name text, rb_local_deleted integer);",
			"create table djmdKey (ID text, ScaleName text, rb_local_deleted integer);",
			"create table djmdContent (ID text, FolderPath text, Title text, ArtistID text, BPM integer, Length integer, KeyID text, rb_local_deleted integer, created_at text);",
			"create table djmdPlaylist (ID text, Seq integer, Name text, Attribute integer, ParentID text, rb_local_deleted integer);",
			"create table djmdSongPlaylist (ID text, PlaylistID text, ContentID text, TrackNo integer, rb_local_deleted integer);",
			"insert into djmdArtist values ('a1', 'Orbital', 0), ('a2', 'Aphex Twin', 0), ('a3', 'Étienne', 0);",
			"insert into djmdKey values ('k1', '8A', 0), ('k2', '2B', 0), ('k3', '12A', 0), ('k4', '1A', 0);",
			`insert into djmdContent values ('t1', ${q(song)}, 'Belfast', 'a1', 12800, 10, 'k1', 0, '2024-01-01');`,
			`insert into djmdContent values ('t2', ${file("Halcyon.mp3")}, 'Halcyon', 'a1', 12650, 200, 'k2', 0, '2024-01-02');`,
			`insert into djmdContent values ('t3', ${file("Windowlicker.mp3")}, 'Windowlicker', 'a2', 0, 200, null, 0, '2024-01-03');`,
			`insert into djmdContent values ('t4', ${file("Cafe.mp3")}, 'Café Noir', 'a3', 9000, 200, 'k3', 0, '2024-01-04');`,
			`insert into djmdContent values ('t5', ${file("Xtal.mp3")}, 'Xtal', 'a2', 11500, 200, 'k4', 0, '2024-01-05');`,
			// no file to load: hidden, but still numbered
			`insert into djmdContent values ('t6', ${q(path.join(work, "Lost.mp3"))}, 'Lost', 'a1', 12000, 200, 'k1', 0, '2024-01-06');`,
			"insert into djmdContent values ('t7', '/bs/catalog/1234', 'Streamed', 'a2', 12000, 200, 'k1', 0, '2024-01-07');",
			"insert into djmdPlaylist values ('f1', 0, 'Clubs', 1, 'root', 0);",
			"insert into djmdPlaylist values ('p1', 0, 'Warm up', 0, 'f1', 0);",
			"insert into djmdPlaylist values ('p2', 1, 'Late', 0, 'root', 0);",
			"insert into djmdPlaylist values ('p3', 2, 'Nothing yet', 0, 'root', 0);",
			// Belfast is in the playlist twice
			"insert into djmdSongPlaylist values ('s1', 'p1', 't4', 1, 0), ('s6', 'p1', 't6', 2, 0), ('s2', 'p1', 't1', 3, 0), ('s3', 'p1', 't5', 4, 0), ('s4', 'p1', 't1', 5, 0), ('s7', 'p1', 't7', 6, 0), ('s5', 'p2', 't2', 1, 0);",
		].join("\n"),
	);
	h = await launch(undefined, undefined, { DJ_REKORDBOX_DB: db });
	await h.page.getByTestId("library-toggle").click();
	await h.page.getByTestId("library-list").waitFor();
});
afterAll(async () => {
	await h?.close();
	fs.rmSync(work, { recursive: true, force: true });
});

const titles = (): Promise<string[]> => h.page.locator("[data-testid=library-row] .library-title").allTextContents();
const numbers = (): Promise<string[]> => h.page.locator("[data-testid=library-row] .library-no").allTextContents();
const count = (): Promise<string | null> => h.page.getByTestId("library-count").textContent();
const options = (): Promise<string[]> => h.page.getByTestId("playlist-option").allTextContents();

describe("the Rekordbox library panel", () => {
	it("lists every track with a file, in the order it was added", async () => {
		expect(await titles()).toEqual(["Belfast", "Halcyon", "Windowlicker", "Café Noir", "Xtal"]);
		expect(await numbers()).toEqual(["1", "2", "3", "4", "5"]);
		expect(await count()).toBe("5 tracks");
		const rows = h.page.getByTestId("library-row");
		expect(await rows.nth(0).textContent()).toBe("1BelfastOrbital1288A");
		expect(await rows.nth(1).textContent()).toBe("2HalcyonOrbital126.52B");
		await shot(h.page, "library-01-all");
	});

	it("searches title and artist, whatever the case or accents", async () => {
		const search = h.page.getByTestId("library-search");
		await search.fill("ORBITAL");
		expect(await titles()).toEqual(["Belfast", "Halcyon"]);
		expect(await count()).toBe("2 of 5");
		// a space is typed, it does not start playback
		await search.fill("");
		await search.pressSequentially("etienne cafe");
		expect(await search.inputValue()).toBe("etienne cafe");
		expect(await state(h.page, "s => s.playing")).toBe(false);
		expect(await titles()).toEqual(["Café Noir"]);
		await search.fill("nothing like this");
		expect(await titles()).toEqual([]);
		await search.press("Escape");
		expect(await search.inputValue()).toBe("");
		expect(await count()).toBe("5 tracks");
	});

	it("sorts by BPM, key and number, and turns the order round on a second click", async () => {
		await h.page.getByTestId("library-sort-bpm").click();
		expect(await titles()).toEqual(["Café Noir", "Xtal", "Halcyon", "Belfast", "Windowlicker"]);
		await h.page.getByTestId("library-sort-bpm").click();
		// the track with no BPM stays last
		expect(await titles()).toEqual(["Belfast", "Halcyon", "Xtal", "Café Noir", "Windowlicker"]);
		await h.page.getByTestId("library-sort-key").click();
		// 1A, 2B, 8A, 12A, then no key
		expect(await titles()).toEqual(["Xtal", "Halcyon", "Belfast", "Café Noir", "Windowlicker"]);
		await shot(h.page, "library-02-by-key");
		await h.page.getByTestId("library-sort-key").click();
		expect(await titles()).toEqual(["Café Noir", "Belfast", "Halcyon", "Xtal", "Windowlicker"]);
		await h.page.getByTestId("library-sort-number").click();
		expect(await numbers()).toEqual(["1", "2", "3", "4", "5"]);
		await h.page.getByTestId("library-sort-number").click();
		expect(await numbers()).toEqual(["5", "4", "3", "2", "1"]);
		await h.page.getByTestId("library-sort-number").click();
	});

	it("filters by a playlist found by searching, in the playlist's order", async () => {
		await h.page.getByTestId("library-playlist").click();
		expect(await options()).toEqual(["All tracks", "Clubs / Warm up", "Late", "Nothing yet"]);
		const search = h.page.getByTestId("playlist-search");
		await search.fill("warm clubs");
		expect(await options()).toEqual(["Clubs / Warm up"]);
		await shot(h.page, "library-03-playlists");
		await search.press("Enter");
		await h.page.getByTestId("playlist-menu").waitFor({ state: "detached" });
		expect(await h.page.getByTestId("library-playlist").textContent()).toContain("Clubs / Warm up");
		expect(await titles()).toEqual(["Café Noir", "Belfast", "Xtal", "Belfast"]);
		// Lost (2) and Streamed (6) have no file
		expect(await numbers()).toEqual(["1", "3", "4", "5"]);
		expect(await count()).toBe("4 tracks");
		// search and sorting act inside the playlist
		await h.page.getByTestId("library-search").fill("aphex");
		expect(await titles()).toEqual(["Xtal"]);
		expect(await numbers()).toEqual(["4"]);
		expect(await count()).toBe("1 of 4");
		await h.page.getByTestId("library-search").fill("");
		await h.page.getByTestId("library-sort-bpm").click();
		expect(await titles()).toEqual(["Café Noir", "Xtal", "Belfast", "Belfast"]);
		expect(await numbers()).toEqual(["1", "4", "3", "5"]);
		await shot(h.page, "library-04-playlist");
	});

	it("keeps the playlist and order while the panel is closed", async () => {
		await h.page.getByTestId("library-toggle").click();
		await h.page.getByTestId("library").waitFor({ state: "detached" });
		await h.page.getByTestId("library-toggle").click();
		await h.page.getByTestId("library-list").waitFor();
		expect(await titles()).toEqual(["Café Noir", "Xtal", "Belfast", "Belfast"]);
		await h.page.getByTestId("library-sort-number").click();
	});

	it("moves through the playlists with the arrow keys, and Escape leaves things as they were", async () => {
		await h.page.getByTestId("library-playlist").click();
		const search = h.page.getByTestId("playlist-search");
		// opens on the playlist that is chosen
		expect(await h.page.locator("[data-testid=playlist-option].at").textContent()).toBe("Clubs / Warm up");
		await search.press("Escape");
		await h.page.getByTestId("playlist-menu").waitFor({ state: "detached" });
		expect(await count()).toBe("4 tracks");
		await h.page.getByTestId("library-playlist").click();
		await search.press("ArrowDown");
		await search.press("ArrowDown");
		await search.press("Enter");
		expect(await h.page.getByTestId("library-list").textContent()).toBe("This playlist is empty");
		// a click outside closes the list; up from the top goes round to the last
		await h.page.getByTestId("library-playlist").click();
		await h.page.getByTestId("library-list").click();
		await h.page.getByTestId("playlist-menu").waitFor({ state: "detached" });
		await h.page.getByTestId("library-playlist").click();
		await search.fill("a");
		expect(await options()).toEqual(["All tracks", "Clubs / Warm up", "Late"]);
		await search.press("ArrowUp");
		await search.press("Enter");
		expect(await titles()).toEqual(["Halcyon"]);
		await h.page.getByTestId("library-playlist").click();
		await h.page.getByTestId("playlist-option").first().click();
		expect(await count()).toBe("5 tracks");
		expect(await state(h.page, "s => s.libraryPlaylist")).toBeNull();
	});

	it("adds a track to the set on a double-click", async () => {
		await h.page.getByTestId("library-row").nth(0).dblclick();
		await h.page.getByTestId("import-modal").waitFor();
		await h.page.getByTestId("bpm-input").fill("128");
		await h.page.getByTestId("bpm-confirm").click();
		await h.page.getByTestId("import-modal").waitFor({ state: "detached" });
		expect(await state(h.page, "s => s.doc.tracks.map((t) => t.sourcePath)")).toEqual([song]);
	});
});
