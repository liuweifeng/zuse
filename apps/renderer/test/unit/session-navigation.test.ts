import { EnvironmentId, SessionId } from "@zuse/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	environment: "local",
	workspace: {},
	selectedChatId: "chat",
	selectedSessionId: "recipient",
	landingRevision: 0,
	archivedAt: null as Date | null,
	missing: false,
	deferSwitch: false,
	finish: () => {},
	activate: vi.fn(),
}));
vi.mock("../../src/state/registry.tsx", () => ({
	batchAtomUpdates: (f: () => void) => f(),
}));
vi.mock("../../src/lib/environment-entities.ts", () => ({
	environmentShellData: (environment: string) =>
		state.missing
			? null
			: {
					chatsByProject: {
						project: [{ id: `${environment}-chat`, archivedAt: null }],
					},
					sessionsByProject: {
						project: [
							{
								id: "sender",
								chatId: `${environment}-chat`,
								projectId: "project",
								archivedAt: state.archivedAt,
							},
						],
					},
				},
}));
vi.mock("../../src/lib/renderer-workspace.ts", () => ({
	rendererWorkspaceSnapshot: () => state.workspace,
}));
vi.mock("../../src/lib/rpc-client.ts", () => ({
	getActiveEnvironment: () => state.environment,
}));
vi.mock("../../src/store/chats.ts", () => ({
	useChatsStore: {
		getState: () => ({
			selectedChatId: state.selectedChatId,
			landingRevision: state.landingRevision,
			select: (id: string) => {
				state.selectedChatId = id;
				state.selectedSessionId = "recipient";
			},
		}),
	},
}));
vi.mock("../../src/store/sessions.ts", () => ({
	useSessionsStore: {
		getState: () => ({
			selectedSessionId: state.selectedSessionId,
			select: (id: string) => {
				state.selectedSessionId = id;
			},
		}),
	},
}));
vi.mock("../../src/store/ui.ts", () => ({
	useUiStore: { getState: () => ({ setView: vi.fn() }) },
}));
vi.mock("../../src/lib/switch-environment.ts", () => ({
	switchToEnvironment: state.activate,
}));

import { openSession } from "../../src/lib/session-navigation.ts";

const ref = (environment: string) => ({
	environmentId: EnvironmentId.make(environment),
	sessionId: SessionId.make("sender"),
});
beforeEach(() => {
	Object.assign(state, {
		environment: "local",
		workspace: {},
		selectedChatId: "local-chat",
		selectedSessionId: "recipient",
		landingRevision: 0,
		archivedAt: null,
		missing: false,
		deferSwitch: false,
	});
	state.activate.mockReset().mockImplementation(async (input) => {
		if (state.deferSwitch)
			await new Promise<void>((resolve) => {
				state.finish = resolve;
			});
		const switched = input.isCurrent();
		if (switched) {
			state.environment = input.environmentId;
			state.selectedChatId = input.chatId;
		}
		return { switched, selectedFolderId: switched ? input.folderId : null };
	});
});

it("opens the sender tab even when both sessions share the already-selected chat", async () => {
	expect(await openSession(ref("local"))).toBe(true);
	expect(state.selectedChatId).toBe("local-chat");
	expect(state.selectedSessionId).toBe("sender");
	expect(state.activate).not.toHaveBeenCalled();
});
it("uses the message's environment instead of an identically named local session", async () => {
	expect(await openSession(ref("remote"))).toBe(true);
	expect(state.environment).toBe("remote");
	expect(state.selectedChatId).toBe("remote-chat");
	expect(state.selectedSessionId).toBe("sender");
});
it("leaves navigation unchanged for missing or archived senders", async () => {
	state.missing = true;
	expect(await openSession(ref("local"))).toBe(false);
	state.missing = false;
	state.archivedAt = new Date(1);
	expect(await openSession(ref("local"))).toBe(false);
	expect(state.selectedSessionId).toBe("recipient");
});
it("does not replace newer navigation when remote activation finishes late", async () => {
	state.deferSwitch = true;
	const opened = openSession(ref("remote"));
	state.selectedSessionId = "newer-selection";
	state.finish();
	expect(await opened).toBe(false);
	expect(state.environment).toBe("local");
	expect(state.selectedSessionId).toBe("newer-selection");
});
