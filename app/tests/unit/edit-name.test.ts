import { describe, expect, it } from "vitest";
import type { PlannerTrack } from "../../src/shared/planner";
import { autoEditName, cleanTrackName } from "../../src/shared/trackEdit";

const t = (name: string): PlannerTrack => ({ id: name, sourcePath: `/${name}.wav`, name, bpm: 150, durationSec: 60 });

describe("edit names", () => {
	it("strips (Original Mix) and (edit), any case", () => {
		expect(cleanTrackName("Lockdown_(Original Mix)")).toBe("Lockdown");
		expect(cleanTrackName("Space Laces - Dominate VIP (ORIGINAL MIX) (Edit 2)")).toBe("Space Laces - Dominate VIP");
	});

	it("names an edit after all its tracks", () => {
		expect(autoEditName([t("A (Original Mix)"), t("B (edit)"), t("C")])).toBe("A x B x C (edit)");
		expect(autoEditName([t("A (edit)"), t("A")])).toBe("A (edit)");
	});
});
