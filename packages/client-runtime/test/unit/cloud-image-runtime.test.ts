import type { CloudAccountImage } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { cloudImageRuntimeBehind } from "../../src/cloud-sandbox-providers.ts";

const image = (patch: Partial<CloudAccountImage>): CloudAccountImage => ({
	providerId: "boxd",
	state: "ready",
	repositories: [],
	providers: [],
	builds: [],
	updatedAt: 1,
	...patch,
});

describe("cloud image runtime catch-up", () => {
	it("flags usable managed images built on an older or unknown runtime", () => {
		expect(
			cloudImageRuntimeBehind(
				image({ runtime: { appVersion: "0.23.0", wireProtocolVersion: 6 } }),
				7,
			),
		).toBe(true);
		// Builds from before runtime tracking cannot prove they are current.
		expect(cloudImageRuntimeBehind(image({ state: "outdated" }), 7)).toBe(true);
	});

	it("leaves current, unusable and custom images alone", () => {
		const current = { appVersion: "0.24.0", wireProtocolVersion: 7 };
		expect(cloudImageRuntimeBehind(image({ runtime: current }), 7)).toBe(false);
		for (const state of [
			"building",
			"failed",
			"not-built",
			"auth-broken",
		] as const)
			expect(cloudImageRuntimeBehind(image({ state }), 7)).toBe(false);
		expect(
			cloudImageRuntimeBehind(image({ source: "custom-snapshot" }), 7),
		).toBe(false);
	});
});
