import { describe, expect, test } from "vitest";
import { launchGrantRequestId } from "../../src/cloud-launch-grant.ts";

const base = {
	workspaceId: "workspace_1",
	runtimeGeneration: 3,
	keyThumbprint: "thumb-1",
	providerId: "claude",
	protocolVersion: 1 as const,
};

const AUTHORITY_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

describe("launch grant request id", () => {
	test("is a valid authority request id and stable for the same binding", async () => {
		const first = await launchGrantRequestId(base);
		expect(first).toMatch(AUTHORITY_UUID);
		expect(await launchGrantRequestId({ ...base })).toBe(first);
	});

	test("changes with every bound field", async () => {
		const original = await launchGrantRequestId(base);
		const variants = await Promise.all([
			launchGrantRequestId({ ...base, workspaceId: "workspace_2" }),
			launchGrantRequestId({ ...base, runtimeGeneration: 4 }),
			launchGrantRequestId({ ...base, keyThumbprint: "thumb-2" }),
			launchGrantRequestId({ ...base, providerId: "codex" }),
		]);
		expect(new Set([original, ...variants]).size).toBe(5);
	});
});
