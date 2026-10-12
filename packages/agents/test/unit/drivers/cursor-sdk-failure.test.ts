import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import { AgentSessionId, FolderId } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { expect, test, vi } from "vitest";
import { startCursorSession } from "../../../src/drivers/cursor.ts";
import { loadCursorSdk } from "../../../src/drivers/cursor-sdk.ts";

const attachments = Layer.succeed(AttachmentService, {
	upload: () => Effect.die("not used"),
	saveText: () => Effect.die("not used"),
	read: () => Effect.succeed(null),
	readForSession: () => Effect.succeed(null),
	readPath: () => Effect.succeed(null),
});

test("SDK import failure is a typed startup error and later imports can retry", async () => {
	vi.doMock("@cursor/sdk", () => {
		throw new Error("SDK temporarily unavailable");
	});
	const result = await Effect.runPromise(
		startCursorSession(
			{
				folderId: FolderId.make("folder-1"),
				providerId: "cursor",
				mode: "sdk",
				model: "composer-2",
				permissionMode: "default",
			},
			"/tmp/workspace",
			null,
			AgentSessionId.make("session-1"),
		).pipe(Effect.result, Effect.provide(attachments)),
	);
	expect(result).toMatchObject({
		_tag: "Failure",
		failure: { _tag: "AgentSessionStartError", providerId: "cursor" },
	});
	vi.doMock("@cursor/sdk", async (original) => original());
	const first = loadCursorSdk();
	const second = loadCursorSdk();
	expect(first).toBe(second);
	await expect(first).resolves.toHaveProperty("Agent");
	vi.doUnmock("@cursor/sdk");
});
