import {
	AgentSessionId,
	ChatId,
	CloudWorkspace,
	type WorkspaceScope,
} from "@zuse/contracts";
import { expect, it } from "vitest";
import { summaryFromLaunch } from "../../src/cloud-catalog.ts";

it.each<WorkspaceScope>([
	{ kind: "personal" },
	{ kind: "organization", organizationId: "org_a" },
	{ kind: "organization", organizationId: "org_b" },
])("keeps launch ownership for connection and catalog filtering: %j", (workspaceScope) => {
	const input = {
		workspaceScope,
		workspace: CloudWorkspace.make({
			workspaceId: "workspace-1",
			projectId: "project-1",
			providerId: "boxd",
			branch: "cloud/task",
			baseRef: "main",
			state: "queued",
			desiredState: "ready",
			statusCode: "queued",
			startupPhase: "booting",
			startupTimings: {},
			runtimeState: "offline",
			revision: 1,
			chatId: ChatId.make("chat-1"),
			initialSessionId: AgentSessionId.make("session-1"),
			createdAt: 1,
			updatedAt: 1,
			lastActivityAt: 1,
		}),
		repositoryIdentity: "github.com/example/repo",
		repositoryDisplayName: "example/repo",
		title: "Task",
		agent: "grok" as const,
		model: "grok-code-fast-1",
		runtimeMode: "full-access" as const,
	};
	const summary = summaryFromLaunch(input);

	expect(summary.workspaceScope).toEqual(workspaceScope);
	expect(summary.workspaceId).toBe(input.workspace.workspaceId);
});
