import { describe, expect, it } from "vitest";

import {
	shouldAutoInstallUpdateOnQuit,
	shouldInstallPendingUpdateOnQuit,
} from "../../src/updater-policy.ts";

describe("desktop updater policy", () => {
	it("requires explicit engine-safe installation on every platform", () => {
		expect(shouldAutoInstallUpdateOnQuit("darwin")).toBe(false);
		expect(shouldAutoInstallUpdateOnQuit("win32")).toBe(false);
		expect(shouldAutoInstallUpdateOnQuit("linux")).toBe(false);
	});

	it("stages a ready update when the user quits", () => {
		expect(
			shouldInstallPendingUpdateOnQuit({
				platform: "darwin",
				status: { kind: "ready", version: "0.18.5" },
				installing: false,
			}),
		).toBe(true);
	});

	it("intercepts only ready updates that are not already installing", () => {
		expect(
			shouldInstallPendingUpdateOnQuit({
				platform: "darwin",
				status: { kind: "downloading", percent: 50, bytesPerSecond: 1_000 },
				installing: false,
			}),
		).toBe(false);
		expect(
			shouldInstallPendingUpdateOnQuit({
				platform: "linux",
				status: { kind: "ready", version: "0.18.5" },
				installing: false,
			}),
		).toBe(true);
		expect(
			shouldInstallPendingUpdateOnQuit({
				platform: "darwin",
				status: { kind: "ready", version: "0.18.5" },
				installing: true,
			}),
		).toBe(false);
	});
});
