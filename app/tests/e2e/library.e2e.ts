// The library panel on a small Rekordbox database made for the test: all tracks, search,
// the playlist picker, sorting, and adding a track to the set.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MY_TAG_TABLE, myTagRows, queryDb, SONG_MY_TAG_TABLE } from "../rekordboxDb";
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
			// My Tags, the tables as Rekordbox has them: the app's category and one of Rekordbox's
			// own. Halcyon is tagged Techno (the app's) and Deep (Rekordbox's).
			MY_TAG_TABLE,
			SONG_MY_TAG_TABLE,
			...myTagRows(
				[
					{ id: "g1", name: "DJ Utilities", tags: [["x1", "Techno"], ["x2", "House"], ["x3", "Peak Time"]] },
					{ id: "g2", name: "Genre", tags: [["x4", "Deep"]] },
				],
				[
					{ id: "m1", tag: "x1", track: "t2" },
					{ id: "m2", tag: "x4", track: "t2" },
				],
			),
		].join("\n"),
	);
	h = await launch(undefined, undefined, { DJ_REKORDBOX_DB: db });
	await h.page.getByTestId("library-list").waitFor();
});
afterAll(async () => {
	await h?.close();
	fs.rmSync(work, { recursive: true, force: true });
});

const titles = (): Promise<string[]> => h.page.locator("[data-testid=library-row] .library-title").allTextContents();
const numbers = (): Promise<string[]> => h.page.getByTestId("library-row").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.no ?? ""));
// Picks an order from the menu; picking the one already chosen turns it round with the arrow.
const sortBy = async (by: "number" | "bpm" | "key"): Promise<void> => {
	const menu = h.page.getByTestId("library-sort");
	if ((await menu.inputValue()) === by) await h.page.getByTestId("library-sort-dir").click();
	else await menu.selectOption(by);
};
// the rows shown (the test library is small enough for all of them to be drawn)
const count = (): Promise<number> => h.page.getByTestId("library-row").count();
const options = (): Promise<string[]> => h.page.getByTestId("playlist-option").allTextContents();

describe("the Rekordbox library panel", () => {
	it("lists every track with a file, in the order it was added", async () => {
		expect(await titles()).toEqual(["Belfast", "Halcyon", "Windowlicker", "Café Noir", "Xtal"]);
		expect(await numbers()).toEqual(["1", "2", "3", "4", "5"]);
		expect(await count()).toBe(5);
		const rows = h.page.getByTestId("library-row");
		expect(await rows.nth(0).textContent()).toBe("▶BelfastOrbital8A128");
		expect(await rows.nth(1).textContent()).toBe("▶HalcyonOrbital2B126.5");
		await shot(h.page, "library-01-all");
	});

	it("searches title and artist, whatever the case or accents", async () => {
		const search = h.page.getByTestId("library-search");
		await search.fill("ORBITAL");
		expect(await titles()).toEqual(["Belfast", "Halcyon"]);
		expect(await count()).toBe(2);
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
		expect(await count()).toBe(5);
	});

	it("sorts by BPM, key and number from the menu, and the arrow turns the order round", async () => {
		await sortBy("bpm");
		expect(await titles()).toEqual(["Café Noir", "Xtal", "Halcyon", "Belfast", "Windowlicker"]);
		await sortBy("bpm");
		// the track with no BPM stays last
		expect(await titles()).toEqual(["Belfast", "Halcyon", "Xtal", "Café Noir", "Windowlicker"]);
		await sortBy("key");
		// 1A, 2B, 8A, 12A, then no key
		expect(await titles()).toEqual(["Xtal", "Halcyon", "Belfast", "Café Noir", "Windowlicker"]);
		await shot(h.page, "library-02-by-key");
		await sortBy("key");
		expect(await titles()).toEqual(["Café Noir", "Belfast", "Halcyon", "Xtal", "Windowlicker"]);
		await sortBy("number");
		expect(await numbers()).toEqual(["1", "2", "3", "4", "5"]);
		await sortBy("number");
		expect(await numbers()).toEqual(["5", "4", "3", "2", "1"]);
		await sortBy("number");
	});

	it("filters by a BPM range and keys, and the X clears the filter", async () => {
		const button = h.page.getByTestId("library-filter");
		expect(await h.page.getByTestId("library-filter-clear").count()).toBe(0);
		await button.click();
		await h.page.getByTestId("filter-bpm-min").fill("110");
		// the track with no BPM is left out once there is a range
		expect(await titles()).toEqual(["Belfast", "Halcyon", "Xtal"]);
		await h.page.getByTestId("filter-bpm-max").fill("127");
		expect(await titles()).toEqual(["Halcyon", "Xtal"]);
		await h.page.getByTestId("filter-key").filter({ hasText: /^1A$/ }).click();
		expect(await titles()).toEqual(["Xtal"]);
		await shot(h.page, "library-02b-filter");
		await h.page.keyboard.press("Escape");
		await h.page.getByTestId("filter-menu").waitFor({ state: "detached" });
		// the filter stays on, and the button opens it again as it was
		expect(await titles()).toEqual(["Xtal"]);
		await button.click();
		expect(await h.page.getByTestId("filter-bpm-min").inputValue()).toBe("110");
		expect(await h.page.getByTestId("filter-key").filter({ hasText: /^1A$/ }).getAttribute("aria-pressed")).toBe("true");
		await h.page.keyboard.press("Escape");
		await h.page.getByTestId("library-filter-clear").click();
		expect(await count()).toBe(5);
		expect(await h.page.getByTestId("library-filter-clear").count()).toBe(0);
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
		expect(await count()).toBe(4);
		// search and sorting act inside the playlist
		await h.page.getByTestId("library-search").fill("aphex");
		expect(await titles()).toEqual(["Xtal"]);
		expect(await numbers()).toEqual(["4"]);
		expect(await count()).toBe(1);
		await h.page.getByTestId("library-search").fill("");
		await sortBy("bpm");
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
		await sortBy("number");
	});

	it("moves through the playlists with the arrow keys, and Escape leaves things as they were", async () => {
		await h.page.getByTestId("library-playlist").click();
		const search = h.page.getByTestId("playlist-search");
		// opens on the playlist that is chosen
		expect(await h.page.locator("[data-testid=playlist-option].at").textContent()).toBe("Clubs / Warm up");
		await search.press("Escape");
		await h.page.getByTestId("playlist-menu").waitFor({ state: "detached" });
		expect(await count()).toBe(4);
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
		expect(await count()).toBe(5);
		expect(await state(h.page, "s => s.libraryPlaylist")).toBeNull();
	});

	it("previews a track from where its bar is clicked, and a click on the row does not play it", async () => {
		const row = h.page.getByTestId("library-row").nth(0);
		const playing = (): Promise<number> => h.page.locator(".library-row.playing").count();
		const fill = async (): Promise<number> => parseFloat((await h.page.getByTestId("library-bar-fill").evaluate((el) => (el as HTMLElement).style.width)) || "0");
		await row.hover();
		const bar = (await row.getByTestId("library-bar").boundingBox())!;
		await h.page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
		await expect.poll(playing).toBe(1);
		// half way along the bar is half way into the track
		await expect.poll(fill).toBeGreaterThan(45);
		await shot(h.page, "library-05-preview");
		// the stop button, where the number would be, shuts it up
		await row.getByTestId("library-stop").click();
		await expect.poll(playing).toBe(0);
		await expect(row.getByTestId("library-stop")).toHaveCount(0);
		await row.hover();
		await h.page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
		await expect.poll(playing).toBe(1);
		// a click on another row selects it and plays nothing new
		const other = h.page.getByTestId("library-row").nth(1);
		await other.locator(".library-title").click();
		await expect(other).toHaveClass(/selected/);
		expect(await other.evaluate((el) => el.classList.contains("playing"))).toBe(false);
		// a preview adds nothing to the set
		expect(await state(h.page, "s => s.doc.tracks.length")).toBe(0);
	});

	it("keeps the selected track through a search and brings it into view when the search is cleared", async () => {
		const search = h.page.getByTestId("library-search");
		const rows = h.page.getByTestId("library-row");
		// all tracks show no numbers
		expect(await rows.nth(0).getByTestId("library-no").count()).toBe(0);
		const all = await titles();
		const target = all[all.length - 1];
		await search.fill(target);
		const found = rows.filter({ hasText: target }).first();
		const no = await found.getAttribute("data-no");
		await found.locator(".library-title").click();
		await expect(found).toHaveClass(/selected/);
		await search.fill("");
		const selected = h.page.locator(`[data-testid=library-row][data-no="${no}"]`);
		await expect(selected).toHaveClass(/selected/);
		await expect(selected).toBeInViewport();
		expect(await h.page.locator(".library-row.selected").count()).toBe(1);
		// a new order keeps it too
		await h.page.getByTestId("library-sort-dir").click();
		await expect(selected).toHaveClass(/selected/);
		await expect(selected).toBeInViewport();
		await h.page.getByTestId("library-sort-dir").click();
		await shot(h.page, "library-05b-selected");
	});

	it("does nothing on a double-click", async () => {
		await h.page.getByTestId("library-row").nth(0).locator(".library-title").dblclick();
		await h.page.waitForTimeout(300);
		expect(await h.page.getByTestId("import-modal").count()).toBe(0);
		expect(await state(h.page, "s => s.doc.tracks.length")).toBe(0);
	});

	it("adds a track to the set when it is dragged onto a lane", async () => {
		const before = await state(h.page, "s => s.doc.clips.length");
		const row = (await h.page.getByTestId("library-row").nth(0).boundingBox())!;
		const lanes = (await h.page.getByTestId("lanes").boundingBox())!;
		await h.page.mouse.move(row.x + 40, row.y + row.height / 2);
		await h.page.mouse.down();
		await h.page.mouse.move(row.x + 80, row.y + row.height / 2, { steps: 4 });
		await h.page.getByTestId("library-ghost").waitFor();
		await h.page.mouse.move(lanes.x + lanes.width / 2, lanes.y + lanes.height * 0.8, { steps: 8 });
		await h.page.mouse.up();
		await h.page.getByTestId("library-ghost").waitFor({ state: "detached" });
		await expect.poll(() => state(h.page, "s => s.doc.clips.length")).toBe(Number(before) + 1);
		// clips show Rekordbox's key before the name
		expect(await h.page.locator(".clip-name").first().textContent()).toMatch(/^8A - Belfast/);
		// and are coloured by it: 8 is C / Am, pink on the key wheel
		expect(await h.page.locator(".clip").first().evaluate((el) => (el as HTMLElement).style.getPropertyValue("--hue"))).toBe("310");
		await shot(h.page, "library-drag");
	});

	it("tags a track from its right-click menu: picks a tag, makes one and takes one off", async () => {
		await h.page.getByTestId("library-playlist").click();
		await h.page.getByTestId("playlist-option").filter({ hasText: /^All tracks$/ }).click();
		await h.page.getByTestId("library-search").fill("Halcyon");
		const open = async (): Promise<void> => {
			await h.page.getByTestId("library-row").filter({ hasText: "Halcyon" }).click({ button: "right" });
			await h.page.getByTestId("library-menu-tag").click();
			await h.page.getByTestId("tag-modal").waitFor();
		};
		const options = (): Promise<string[]> => h.page.getByTestId("tag-option").locator(".tag-name").allTextContents();
		const ticked = (): Promise<string[]> => h.page.locator("[data-testid=tag-option][aria-pressed=true] .tag-name").allTextContents();
		await open();
		expect(await options()).toEqual(["Techno", "House", "Peak Time"]);
		expect(await ticked()).toEqual(["Techno"]);

		// only the app's tags, in one list: Deep is Rekordbox's own
		expect(await h.page.getByTestId("tag-list").locator("h4").count()).toBe(0);

		// take Techno off, pick Peak Time from a search, make Acid
		await h.page.getByTestId("tag-option").filter({ hasText: "Techno" }).click();
		const search = h.page.getByTestId("tag-search");
		await search.fill("peak");
		await search.press("Enter");
		await search.fill("Acid");
		await h.page.getByTestId("tag-create").click();
		// a tag made here is in the list, ticked and marked new
		expect(await ticked()).toEqual(["Peak Time", "Acid"]);
		expect(await h.page.locator("[data-testid=tag-option][data-new]").locator(".tag-name").allTextContents()).toEqual(["Acid"]);
		await shot(h.page, "library-tags");
		await h.page.getByTestId("tag-save").click();
		await h.page.getByTestId("tag-modal").waitFor({ state: "detached" });

		const db = path.join(work, "master.db");
		const written = queryDb(db, "select t.Name as name, t.ParentID as groupId from djmdSongMyTag s join djmdMyTag t on t.ID = s.MyTagID where s.ContentID = 't2' order by t.Name;");
		expect(written).toEqual([
			{ name: "Acid", groupId: "g1" },
			{ name: "Deep", groupId: "g2" },
			{ name: "Peak Time", groupId: "g1" },
		]);
		// the row shows its tags after the artist, and a click on them opens the tag editor
		const row = h.page.getByTestId("library-row").filter({ hasText: "Halcyon" });
		expect(await row.locator(".library-tag").allTextContents()).toEqual(["Peak Time", "Acid"]);
		await row.getByTestId("library-tags").click();
		await h.page.getByTestId("tag-modal").waitFor();
		// and the modal shows it again, with the new tag at the end
		expect(await options()).toEqual(["Techno", "House", "Peak Time", "Acid"]);
		expect(await ticked()).toEqual(["Peak Time", "Acid"]);
		await h.page.keyboard.press("Escape");
		await h.page.getByTestId("tag-modal").waitFor({ state: "detached" });
		await h.page.getByTestId("library-search").fill("");
	});

	it("in tag editor mode, the picked tags show hollow on every row and a click adds one", async () => {
		await h.page.getByTestId("library-search").fill("Halcyon");
		const row = h.page.getByTestId("library-row").filter({ hasText: "Halcyon" });
		expect(await row.getByTestId("ghost-tag").count()).toBe(0);
		await h.page.getByTestId("library-filter").click();
		expect(await h.page.getByTestId("quick-tag").count()).toBe(0);
		await h.page.getByTestId("tag-mode").click();
		await h.page.getByTestId("quick-tag").filter({ hasText: /^House$/ }).click();
		await h.page.getByTestId("quick-tag").filter({ hasText: /^Acid$/ }).click();
		await h.page.keyboard.press("Escape");
		// the picked tags have their own place after the rest: Acid, which Halcyon has, solid, House hollow
		expect(await row.getByTestId("row-tag").allTextContents()).toEqual(["Peak Time"]);
		expect(await row.getByTestId("quick-tag-on").allTextContents()).toEqual(["Acid"]);
		expect(await row.getByTestId("ghost-tag").allTextContents()).toEqual(["House"]);
		await shot(h.page, "library-tag-mode");
		// a click turns it solid where it is
		const before = await row.getByTestId("ghost-tag").boundingBox();
		await row.getByTestId("ghost-tag").click();
		expect(await row.getByTestId("ghost-tag").count()).toBe(0);
		expect(await row.getByTestId("quick-tag-on").allTextContents()).toEqual(["House", "Acid"]);
		expect(await row.getByTestId("quick-tag-on").first().boundingBox()).toEqual(before);
		const db = path.join(work, "master.db");
		const written = (): unknown => queryDb(db, "select t.Name as name from djmdSongMyTag s join djmdMyTag t on t.ID = s.MyTagID where s.ContentID = 't2' and t.ParentID = 'g1' order by t.Name;");
		await expect.poll(written).toEqual([{ name: "Acid" }, { name: "House" }, { name: "Peak Time" }]);
		// a click on the hollow tag does not select the row
		expect(await row.getAttribute("class")).not.toContain("selected");
		// every tag has an X: on a picked tag it turns it hollow where it is, on another it takes it away
		await row.getByTestId("quick-tag-on").filter({ hasText: "Acid" }).getByTestId("tag-remove").click();
		expect(await row.getByTestId("ghost-tag").allTextContents()).toEqual(["Acid"]);
		await row.getByTestId("row-tag").getByTestId("tag-remove").click();
		expect(await row.getByTestId("row-tag").count()).toBe(0);
		await expect.poll(written).toEqual([{ name: "House" }]);
		expect(await row.getAttribute("class")).not.toContain("selected");
		await h.page.getByTestId("library-filter").click();
		await h.page.getByTestId("tag-mode").click();
		await h.page.keyboard.press("Escape");
		await h.page.getByTestId("library-search").fill("");
	});
});
