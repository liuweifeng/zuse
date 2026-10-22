import {
	MASTER_MASCOT_COLORS,
	MASTER_MASCOTS,
	type Master,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { avatarFor } from "../../src/components/masters/mascot.tsx";
import { MASCOT_SPRITES } from "../../src/components/masters/mascot-sprites.ts";

describe("Master mascots", () => {
	it("has square, same-size frames using only known pixel keys", () => {
		for (const mascot of MASTER_MASCOTS)
			for (const [size, expected] of [
				["large", 28],
				["small", 16],
			] as const)
				for (const rows of Object.values(MASCOT_SPRITES[mascot][size])) {
					expect(rows).toHaveLength(expected);
					for (const row of rows) {
						expect(row).toHaveLength(expected);
						expect(row).toMatch(/^[.bskwhft]+$/);
					}
				}
	});
	it("keeps a saved avatar and derives a stable one for older Masters", () => {
		const master = (avatar?: Master["settings"]["avatar"]) =>
			({ id: "master-1", settings: { avatar } }) as Pick<
				Master,
				"id" | "settings"
			>;
		expect(avatarFor(master({ mascot: "fuzz", color: "pink" }))).toEqual({
			mascot: "fuzz",
			color: "pink",
		});
		const derived = avatarFor(master());
		expect(avatarFor(master())).toEqual(derived);
		expect(MASTER_MASCOTS).toContain(derived.mascot);
		expect(MASTER_MASCOT_COLORS).toContain(derived.color);
	});
});
