import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	projectlessThreadsRoot,
	scratchDirectoryName,
} from "../../src/workspace/scratch-directory.ts";

const now = new Date("2026-10-12T12:00:00Z");
describe("projectless thread directories", () => {
	it("places new threads under the runtime user's ~/.zuse/threads directory", () => {
		expect(projectlessThreadsRoot("/home/example")).toBe(
			join("/home/example", ".zuse", "threads"),
		);
	});
	it("uses only the date and a short stable identity", () => {
		const name = scratchDirectoryName("first", now);
		expect(name).toMatch(/^2026-10-12-[a-f0-9]{12}$/);
		expect(name.length).toBe(23);
		expect(name).toBe(scratchDirectoryName("first", now));
		expect(name).not.toBe(scratchDirectoryName("second", now));
	});
});
