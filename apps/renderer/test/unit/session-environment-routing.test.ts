import {
	ChatId,
	EnvironmentId,
	FolderId,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { emptyTimelineProjection } from "@zuse/domain/projectors/timeline-reducer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	activeEnvironment: "local",
	protocolVersion: 7,
	dispatch: vi.fn(),
	patchActive: vi.fn(),
	cloudSummary: vi.fn(),
	attach: vi.fn(),
	localProject: vi.fn(),
	upsertFork: vi.fn(),
	machineFork: vi.fn(),
}));

vi.mock("../../src/lib/cloud-workspace-catalog.ts", () => ({
	cloudSummaryForChat: mocks.cloudSummary,
	cloudSummaryForSelection: mocks.cloudSummary,
	localProjectForCloudChat: mocks.localProject,
}));

vi.mock("../../src/lib/cloud-machine-fork.ts", () => ({
	forkCloudMachine: mocks.machineFork,
}));

vi.mock("../../src/store/chat-commands.ts", () => ({
	upsertForkedChat: mocks.upsertFork,
	selectChatSession: vi.fn(),
}));

vi.mock("../../src/lib/cloud-workspaces.ts", () => ({
	ensureCloudWorkspaceAttached: mocks.attach,
}));

vi.mock("../../src/lib/environment-entities.ts", () => ({
	activeSessionById: () => null,
	environmentShellData: () => null,
	activeSessionsByProject: () => ({}),
	overlayActiveEnvironmentShell: mocks.patchActive,
	overlayEnvironmentShell: () => false,
}));

vi.mock("@zuse/client-runtime/connection", async (original) => ({
	...(await original<typeof import("@zuse/client-runtime/connection")>()),
	getClientProtocolVersion: () => mocks.protocolVersion,
}));

vi.mock("../../src/lib/rpc-client.ts", () => ({
	getVerifiedRpcClient: async () => ({}),
	getActiveEnvironment: () => mocks.activeEnvironment,
}));

vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	dispatchSessionCommand: mocks.dispatch,
	getRendererClientBus: () => ({
		snapshot: () => ({
			failedCommands: [],
			connection: "connected",
			sync: "live",
			data: emptyTimelineProjection(),
			cursor: { epoch: "test", version: 1 },
		}),
		subscribe: () => () => undefined,
	}),
	sessionTimelineResourceKey: vi.fn(),
	retainSessionTimeline: () => ({
		key: "test-key",
		lease: { release: () => undefined },
	}),
}));

vi.mock("../../src/store/workspace.ts", () => ({
	useWorkspaceStore: {
		getState: () => ({ selectedFolderId: null, select: vi.fn() }),
		subscribe: () => () => undefined,
	},
}));

const { useSessionsStore } = await import("../../src/store/sessions.ts");

describe("session command environment routing", () => {
	beforeEach(() => {
		mocks.protocolVersion = 7;
		mocks.activeEnvironment = "local";
		mocks.dispatch.mockReset();
		mocks.patchActive.mockReset();
		mocks.cloudSummary.mockReset().mockReturnValue(null);
		mocks.attach.mockReset().mockResolvedValue(undefined);
		mocks.localProject
			.mockReset()
			.mockReturnValue(FolderId.make("local-project"));
		mocks.upsertFork.mockReset();
		mocks.machineFork.mockReset().mockResolvedValue({
			chatId: "new-chat",
			sessionId: "new-session",
			forkMode: "machine",
		});
		mocks.dispatch.mockResolvedValue({ result: undefined });
		useSessionsStore.setState({ draftSession: null, error: null });
	});

	it.each([
		5, 6, 7,
	])("forks in the source workspace with safe retries only on protocol %i", async (version) => {
		mocks.protocolVersion = version;
		const sessionId = SessionId.make("source-cloud-session");
		const cloud = {
			workspaceId: "boxd-workspace",
			providerId: "boxd",
			state: "paused",
		};
		mocks.cloudSummary.mockReturnValue(cloud);
		mocks.dispatch.mockResolvedValue({
			result: {
				chat: { id: ChatId.make("cloud-chat") },
				session: {
					id: SessionId.make("fork-session"),
					projectId: FolderId.make("project"),
				},
				forkMode: "resume",
			},
		});
		const forked = await useSessionsStore.getState().fork({
			sourceSessionId: sessionId,
			fromMessageId: MessageId.make("fork-point"),
			nativeChildStepId: version === 7 ? "completed-native-step" : undefined,
			destination: "tab",
		});
		expect(mocks.attach).toHaveBeenCalledWith(cloud);
		expect(mocks.attach.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
			mocks.dispatch.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				ref: { environmentId: "boxd-workspace", sessionId },
				kind: "session.fork",
				retry: version === 7 ? "safe" : "never",
				payload: expect.objectContaining({
					destination: "tab",
					nativeChildStepId:
						version === 7 ? "completed-native-step" : undefined,
				}),
			}),
		);
		expect(forked?.sessionId).toBe("fork-session");
		expect(mocks.upsertFork).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "local-project" }),
			expect.objectContaining({ projectId: "local-project" }),
		);
		expect(
			useSessionsStore.getState().selectedSessionByProject["local-project"],
		).toBe("fork-session");
	});

	it("does not insert or select a late native fork in a different environment", async () => {
		const previousSelection = useSessionsStore.getState().selectedSessionId;
		mocks.dispatch.mockImplementation(async () => {
			mocks.activeEnvironment = "other-workspace";
			return {
				result: {
					chat: { id: ChatId.make("late-chat") },
					session: {
						id: SessionId.make("late-session"),
						projectId: FolderId.make("project"),
					},
					forkMode: "copy",
				},
			};
		});
		const result = await useSessionsStore.getState().fork({
			sourceSessionId: SessionId.make("source"),
			fromMessageId: MessageId.make("spawn"),
			nativeChildStepId: "completed-step",
			destination: "tab",
		});
		expect(result?.sessionId).toBe("late-session");
		expect(mocks.patchActive).not.toHaveBeenCalled();
		expect(mocks.upsertFork).not.toHaveBeenCalled();
		expect(useSessionsStore.getState().selectedSessionId).toBe(
			previousSelection,
		);
	});

	it.each([
		{ providerId: "e2b", destination: "tab" as const },
		{ providerId: "boat", destination: "chat" as const },
	])("rejects $providerId $destination forks before waking or dispatching", async ({
		providerId,
		destination,
	}) => {
		mocks.cloudSummary.mockReturnValue({
			workspaceId: "cloud-workspace",
			providerId,
			state: "ready",
		});
		const forked = await useSessionsStore.getState().fork({
			sourceSessionId: SessionId.make("source"),
			fromMessageId: MessageId.make("point"),
			destination,
		});
		expect(forked).toBeNull();
		expect(mocks.attach).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("routes the boxd chat destination to machine provisioning rather than session.fork", async () => {
		const cloud = {
			workspaceId: "boxd-source",
			providerId: "boxd",
			state: "ready",
		};
		mocks.cloudSummary.mockReturnValue(cloud);
		const result = await useSessionsStore.getState().fork({
			sourceSessionId: SessionId.make("source"),
			fromMessageId: MessageId.make("point"),
			destination: "chat",
		});
		expect(mocks.attach).toHaveBeenCalledWith(cloud);
		expect(mocks.machineFork).toHaveBeenCalledWith(
			expect.objectContaining({
				cloud,
				projectId: "local-project",
				sourceSessionId: "source",
				fromMessageId: "point",
			}),
		);
		expect(mocks.dispatch).not.toHaveBeenCalled();
		expect(result?.forkMode).toBe("machine");
	});

	it("does not dispatch a fork after a failed cloud attach", async () => {
		mocks.cloudSummary.mockReturnValue({
			workspaceId: "boxd-workspace",
			providerId: "boxd",
			state: "paused",
		});
		mocks.attach.mockRejectedValue(new Error("Machine unavailable"));
		expect(
			await useSessionsStore.getState().fork({
				sourceSessionId: SessionId.make("source"),
				fromMessageId: MessageId.make("point"),
				destination: "tab",
			}),
		).toBeNull();
		expect(mocks.dispatch).not.toHaveBeenCalled();
		expect(useSessionsStore.getState().error).toBe("Machine unavailable");
	});

	it("does not claim Full Access before a cloud mode change is applied", async () => {
		let reject!: (cause: Error) => void;
		mocks.dispatch.mockReturnValueOnce(
			new Promise((_, fail) => {
				reject = fail;
			}),
		);
		const changing = useSessionsStore
			.getState()
			.setRuntimeMode(
				SessionId.make("cloud-session"),
				"full-access",
				EnvironmentId.make("cloud-workspace"),
			);
		expect(mocks.patchActive).not.toHaveBeenCalled();
		reject(new Error("Runtime unavailable"));
		await changing;
		expect(mocks.patchActive).not.toHaveBeenCalled();
		expect(useSessionsStore.getState().error).toBe("Runtime unavailable");
	});

	it("keeps a new cloud tab's provider mutation in its explicit workspace", async () => {
		const sessionId = SessionId.make("secondary-cloud-session");
		const environmentId = EnvironmentId.make("cloud-workspace");

		await useSessionsStore
			.getState()
			.setProvider(sessionId, "codex", "gpt-5.6-sol", environmentId);

		expect(mocks.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				ref: { environmentId, sessionId },
				kind: "session.setProvider",
			}),
		);
	});

	it("keeps cloud tab removal in its explicit workspace", async () => {
		const sessionId = SessionId.make("removed-cloud-session");
		const environmentId = EnvironmentId.make("cloud-workspace");

		await useSessionsStore.getState().archive(sessionId, environmentId);

		expect(mocks.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				ref: { environmentId, sessionId },
				kind: "session.archive",
			}),
		);
	});

	it("treats an already-removed session as a successful archive", async () => {
		const sessionId = SessionId.make("already-removed-cloud-session");
		const environmentId = EnvironmentId.make("cloud-workspace");
		mocks.dispatch.mockRejectedValueOnce({
			_tag: "SessionNotFoundError",
			sessionId,
		});
		useSessionsStore.setState({ selectedSessionId: sessionId });

		await useSessionsStore.getState().archive(sessionId, environmentId);

		expect(useSessionsStore.getState()).toMatchObject({
			selectedSessionId: null,
			error: null,
		});
	});
});
