import {
	CloudWorkspaceOpError,
	EnvironmentId,
	Message,
	MessageId,
	QueueState,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { afterEach, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ loadHistoryPage: vi.fn() }));
vi.mock("../../src/lib/session-timeline-cache.ts", async (original) => ({
	...(await original<
		typeof import("../../src/lib/session-timeline-cache.ts")
	>()),
	sessionTimelineCache: {
		load: async () => null,
		save: async () => {},
		prune: async () => {},
		loadHistoryPage: cache.loadHistoryPage,
		saveHistoryPage: async () => {},
	},
}));

import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import {
	getRendererClientBus,
	loadOlderSessionMessages,
	registerEnvironmentActivationForTest,
	registerSessionTimelineCheckpointSynchronizer,
	registerSessionTimelineOlderPageSynchronizer,
	resetSessionTimelineClientBusForTest,
	retainSessionTimeline,
} from "../../src/lib/session-timeline-client-bus.ts";

afterEach(() => {
	resetSessionTimelineClientBusForTest();
	vi.resetAllMocks();
});

it.each([
	"missing",
	"offline",
	"denied",
])("uses earlier cached history only when authoritative history is unavailable (%s)", async (failure) => {
	observeRendererAccount("history-cache-account");
	const ref = {
		environmentId: EnvironmentId.make("history-cache-workspace"),
		sessionId: SessionId.make("history-cache-session"),
	};
	registerEnvironmentActivationForTest(
		ref.environmentId,
		async () => {},
		undefined,
		"cloud-workspace",
	);
	const older = Message.make({
		id: MessageId.make("already-cached"),
		sessionId: ref.sessionId,
		role: "user",
		content: { _tag: "user", text: "Previously read history" },
		createdAt: new Date(0),
	});
	cache.loadHistoryPage.mockImplementation(
		async (_ref, _cursor, _before, _namespace, options) =>
			options?.allowEarlierVersion
				? { messages: [older], olderMessageSequence: null }
				: null,
	);
	registerSessionTimelineCheckpointSynchronizer(
		ref.environmentId,
		async () => ({
			data: SessionTimelineProjection.make({
				messages: [],
				olderMessageSequence: 5,
				status: "idle",
				activeTurn: null,
				turnCount: 0,
				queue: QueueState.make({ items: [], paused: false }),
				permissionMode: "default",
				runtimeMode: "full-access",
			}),
			cursor: { epoch: "same-runtime", version: 11 },
		}),
	);
	const denied = new CloudWorkspaceOpError({ code: "access-denied" });
	registerSessionTimelineOlderPageSynchronizer(ref.environmentId, async () => {
		if (failure === "denied") throw denied;
		if (failure === "offline") throw new Error("Network unavailable");
		return null;
	});
	const retained = retainSessionTimeline(ref, "sync");
	await vi.waitFor(() =>
		expect(getRendererClientBus().snapshot(retained.key).data).not.toBeNull(),
	);
	try {
		if (failure === "denied") {
			await expect(loadOlderSessionMessages(ref)).rejects.toBe(denied);
			expect(cache.loadHistoryPage).toHaveBeenCalledTimes(1);
		} else {
			await expect(loadOlderSessionMessages(ref)).resolves.toEqual({
				applied: true,
				loaded: 1,
				hasMore: false,
			});
			expect(
				getRendererClientBus().snapshot(retained.key).data?.messages,
			).toEqual([older]);
		}
	} finally {
		retained.lease.release();
	}
});
