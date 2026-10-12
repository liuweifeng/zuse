import { describe, expect, test, vi } from "vitest";

const sdkLoads = vi.hoisted(() => ({ count: 0 }));

vi.mock("@cursor/sdk", async (importOriginal) => {
	sdkLoads.count += 1;
	const actual = await importOriginal<typeof import("@cursor/sdk")>();
	return {
		...actual,
		Cursor: {
			...actual.Cursor,
			models: {
				list: async () => [{ id: "composer-2", displayName: "Composer 2" }],
			},
		},
	};
});

import { listCursorModels } from "../../../src/drivers/cursor-models.ts";
import {
	cursorSdkErrorOf,
	cursorSdkLoaded,
	isCursorAgentNotFoundError,
	isCursorAuthenticationError,
	loadCursorSdk,
} from "../../../src/drivers/cursor-sdk.ts";

describe("Cursor SDK lazy loading", () => {
	test("importing the driver modules does not load the SDK; the first Cursor call does, once", async () => {
		// The driver, the models helper and the loader are all imported above.
		await import("../../../src/drivers/cursor.ts");
		expect(sdkLoads.count).toBe(0);
		expect(cursorSdkLoaded()).toBe(false);
		// Classification before any load never touches the SDK.
		expect(isCursorAuthenticationError(new Error("401"))).toBe(false);
		expect(cursorSdkErrorOf(new Error("boom"))).toBeNull();
		expect(cursorSdkLoaded()).toBe(false);

		const [models, first, second] = await Promise.all([
			listCursorModels("key"),
			loadCursorSdk(),
			loadCursorSdk(),
		]);
		expect(models).toEqual([{ id: "composer-2", label: "Composer 2" }]);
		expect(first).toBe(second);
		expect(sdkLoads.count).toBe(1);
		expect(cursorSdkLoaded()).toBe(true);
	});

	test("classifies SDK errors exactly once the SDK is loaded", async () => {
		const sdk = await loadCursorSdk();
		expect(
			isCursorAuthenticationError(new sdk.AuthenticationError("rejected")),
		).toBe(true);
		const unauthorized = new sdk.CursorSdkError("denied", { status: 401 });
		expect(isCursorAuthenticationError(unauthorized)).toBe(true);
		expect(cursorSdkErrorOf(unauthorized)?.status).toBe(401);
		expect(isCursorAuthenticationError(new Error("unrelated"))).toBe(false);
		expect(isCursorAgentNotFoundError(new sdk.AgentNotFoundError("gone"))).toBe(
			true,
		);
		expect(isCursorAgentNotFoundError(new Error("gone"))).toBe(false);
	});
});
