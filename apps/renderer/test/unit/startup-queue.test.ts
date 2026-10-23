import { ComposerInput, EnvironmentId, SessionId } from "@zuse/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ finalize: vi.fn(), update: vi.fn() }));
vi.mock("../../src/composer/startup-input.ts", () => ({
	finalizeStartupInputWhenReady: fixture.finalize,
	releaseDraftAttachmentPreviews: vi.fn(),
}));
vi.mock("../../src/lib/session-actions.ts", () => ({
	updateQueuedMessage: fixture.update,
}));
const { prepareStartupQueue, useStartupQueueStore, startupQueueKey } =
	await import("../../src/composer/startup-queue.ts");
const target = {
	ref: {
		environmentId: EnvironmentId.make("local"),
		sessionId: SessionId.make("session"),
	},
	uploadRoot: null,
};
const file = new File(["video"], "recording.mov", { type: "video/quicktime" });
const input = ComposerInput.make({
	text: "fix it",
	attachments: [
		{ id: "pending-video", mimeType: file.type, originalName: file.name },
	],
	fileRefs: [],
	skillRefs: [],
});
const options = {
	issueMarkdown: null,
	pendingContextFiles: [],
	pendingAttachments: [{ tempId: "pending-video", file, previewUrl: "" }],
};
const key = startupQueueKey(target.ref, "queue");
const job = () => useStartupQueueStore.getState().jobs[key];
beforeEach(() => {
	for (const job of Object.values(useStartupQueueStore.getState().jobs))
		job.cancel();
	fixture.finalize.mockReset();
	fixture.update.mockReset().mockResolvedValue(true);
});
it("retains a failed first-message upload for an in-chat retry", async () => {
	fixture.finalize.mockRejectedValueOnce(
		new Error("File too large (max 100 MB)"),
	);
	expect(await prepareStartupQueue(input, target, options, "queue")).toBe(
		false,
	);
	expect(job()?.status).toBe("failed");
	expect(job()?.error).toContain("File too large");
	expect(fixture.update).not.toHaveBeenCalled();
	const finalized = ComposerInput.make({
		...input,
		attachments: [
			{ id: "saved", mimeType: file.type, originalName: file.name },
		],
	});
	fixture.finalize.mockResolvedValue(finalized);
	expect(await job()?.retry()).toBe(true);
	expect(fixture.finalize).toHaveBeenLastCalledWith(input, target, options, {
		signal: expect.any(AbortSignal),
	});
	expect(fixture.update).toHaveBeenCalledWith(target.ref, "queue", finalized);
	expect(job()).toBeUndefined();
});
it("does not lose the prepared input when releasing the queue fails", async () => {
	fixture.finalize.mockResolvedValue(input);
	fixture.update.mockResolvedValueOnce(false);
	expect(await prepareStartupQueue(input, target, options, "queue")).toBe(
		false,
	);
	expect(job()?.status).toBe("failed");
	expect(await job()?.retry()).toBe(true);
	expect(fixture.finalize).toHaveBeenCalledTimes(1);
	expect(fixture.update).toHaveBeenCalledTimes(2);
});
it("does not release a deleted message after an in-flight upload finishes", async () => {
	let finish!: (value: typeof input) => void;
	fixture.finalize.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const running = prepareStartupQueue(input, target, options, "queue");
	expect(job()?.status).toBe("preparing");
	job()?.cancel();
	finish(input);
	expect(await running).toBe(false);
	expect(fixture.update).not.toHaveBeenCalled();
	expect(job()).toBeUndefined();
});
it("coalesces repeated retry clicks while an upload is running", async () => {
	let finish!: (value: typeof input) => void;
	fixture.finalize.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const running = prepareStartupQueue(input, target, options, "queue");
	const retry = job()?.retry();
	expect(fixture.finalize).toHaveBeenCalledTimes(1);
	finish(input);
	expect(await running).toBe(true);
	expect(await retry).toBe(true);
	expect(fixture.update).toHaveBeenCalledTimes(1);
});

it("discards retained files and blocks queue release after an account change", async () => {
	const { observeRendererAccount } = await import(
		"../../src/lib/renderer-account.ts"
	);
	let finish!: (value: typeof input) => void;
	fixture.finalize.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const running = prepareStartupQueue(input, target, options, "queue");
	observeRendererAccount("another-account");
	expect(job()).toBeUndefined();
	finish(input);
	expect(await running).toBe(false);
	expect(fixture.update).not.toHaveBeenCalled();
});
