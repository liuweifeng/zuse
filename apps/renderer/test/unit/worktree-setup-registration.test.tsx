import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	sessionVisible: false,
	durableCreation: true,
	pendingCreation: false,
	creationPhase: "running_setup",
	worktreePresent: true,
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
		select({
			selectedChatId: "chat",
			pendingCreationByChat: fixture.pendingCreation
				? {
						chat: {
							sessionId: "session",
							projectId: "project",
							worktreeId: "reserved-worktree",
							workspaceRequested: true,
							phase: fixture.creationPhase,
						},
					}
				: {},
		}),
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
							id: fixture.selectedSessionId,
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
			project: fixture.durableCreation
				? [
						{
							chatId: "chat",
							projectId: "project",
							initialSessionId: "session",
							worktreeId: "reserved-worktree",
							phase: fixture.creationPhase,
							workspacePolicy: { _tag: "fresh" },
							createdAt: new Date(0),
						},
					]
				: [],
		},
	}),
}));
vi.mock("../../src/hooks/use-worktree-setup-lifecycle.ts", () => ({
	useWorktreeSetupLifecycle: (_projectId: string, worktreeId: string | null) =>
		fixture.worktreePresent && worktreeId === "reserved-worktree"
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
	fixture.durableCreation = true;
	fixture.pendingCreation = false;
	fixture.creationPhase = "running_setup";
	fixture.worktreePresent = true;
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

it.each([
	"durable",
	"optimistic",
])("keeps the %s reserved session authoritative when only a later session is loaded", (source) => {
	fixture.durableCreation = source === "durable";
	fixture.pendingCreation = source === "optimistic";
	fixture.selectedSessionId = "later-session";
	fixture.sessionVisible = true;
	expect(renderToStaticMarkup(<WorktreeSetupCard />)).toBe("");
});
it.each([
	"starting_agent",
	"running",
])("does not hide pending setup when chat creation is %s", (phase) => {
	fixture.creationPhase = phase;
	fixture.setupStatus = "pending";
	const html = renderToStaticMarkup(<WorktreeSetupCard />);
	expect(html).not.toBe("");
	expect(html).not.toContain("Workspace ready");
});
it("does not declare unhydrated setup complete when the agent is running", () => {
	fixture.creationPhase = "running";
	fixture.worktreePresent = false;
	const html = renderToStaticMarkup(<WorktreeSetupCard />);
	expect(html).not.toBe("");
	expect(html).not.toContain("Workspace ready");
});
