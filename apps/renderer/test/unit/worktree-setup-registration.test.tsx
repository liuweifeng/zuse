import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	sessionVisible: false,
	providerAttached: false,
	selectedSessionId: "session",
	setupStatus: "running",
	worktreeId: null as string | null,
}));
vi.mock("../../src/store/active-workspace.ts", () => ({
	useActiveContext: () => ({
		status: "ready",
		folderId: "project",
		worktreeId: fixture.worktreeId,
		worktreePending: false,
	}),
}));
vi.mock("../../src/store/chats.ts", () => ({
	useChatsStore: (select: (s: unknown) => unknown) =>
		select({ selectedChatId: "chat", pendingCreationByChat: {} }),
}));
vi.mock("../../src/store/sessions.ts", () => ({
	useSessionsStore: (select: (s: unknown) => unknown) =>
		select({ selectedSessionId: fixture.selectedSessionId }),
}));
vi.mock("../../src/store/workspace.ts", () => ({
	useWorkspaceStore: (select: (s: unknown) => unknown) =>
		select({ folders: [{ id: "project", name: "zuse" }] }),
}));
vi.mock("../../src/store/worktrees.ts", () => ({
	useWorktreesStore: (select: (s: unknown) => unknown) =>
		select({ rerunSetup: vi.fn() }),
}));
vi.mock("../../src/lib/cloud-workspace-catalog.ts", () => ({
	useCloudChatCatalogStore: (select: (s: unknown) => unknown) =>
		select({ summaries: [] }),
}));
vi.mock("../../src/lib/environment-entity-hooks.ts", () => ({
	useActiveEnvironmentEntities: () => ({
		sessionsByProject: {
			project: fixture.sessionVisible
				? [
						{
							id: "session",
							chatId: "chat",
							projectId: "project",
							createdAt: new Date(0),
							providerThread: fixture.providerAttached
								? { id: "thread" }
								: null,
						},
					]
				: [],
		},
		creationOperationsByProject: {
			project: [
				{
					chatId: "chat",
					projectId: "project",
					initialSessionId: "session",
					worktreeId: "reserved-worktree",
					phase: "running_setup",
					workspacePolicy: { _tag: "fresh" },
					createdAt: new Date(0),
				},
			],
		},
	}),
}));
vi.mock("../../src/hooks/use-worktree-setup-lifecycle.ts", () => ({
	useWorktreeSetupLifecycle: (_projectId: string, worktreeId: string | null) =>
		worktreeId === "reserved-worktree"
			? {
					name: "poliwrath",
					branch: "poliwrath",
					baseBranch: "main",
					setupStatus: fixture.setupStatus,
					setupOutput: "Installing dependencies",
				}
			: null,
}));

import { WorktreeSetupCard } from "../../src/components/worktree-setup-card.tsx";

beforeEach(() => {
	fixture.sessionVisible = false;
	fixture.providerAttached = false;
	fixture.worktreeId = null;
	fixture.selectedSessionId = "session";
	fixture.setupStatus = "running";
});
it("shows durable worktree progress before the session summary registers", () => {
	expect(renderToStaticMarkup(<WorktreeSetupCard />)).toContain(
		"Running environment setup",
	);
});
it("follows the reserved worktree before the active context catches up", () => {
	fixture.sessionVisible = true;
	const html = renderToStaticMarkup(<WorktreeSetupCard />);
	expect(html).toContain("Running environment setup");
	expect(html).toContain("Installing dependencies");
});

it("does not show the initial setup for a different selected session", () => {
	fixture.selectedSessionId = "another-session";
	expect(renderToStaticMarkup(<WorktreeSetupCard />)).toBe("");
});
it("hides the card once the reserved worktree finishes setup", () => {
	fixture.setupStatus = "succeeded";
	expect(renderToStaticMarkup(<WorktreeSetupCard />)).toBe("");
});
it("keeps background setup visible while the provider is already replying", () => {
	fixture.sessionVisible = true;
	fixture.providerAttached = true;
	expect(renderToStaticMarkup(<WorktreeSetupCard />)).toContain(
		"Running environment setup",
	);
});
