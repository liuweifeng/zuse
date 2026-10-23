import type { WorkspaceScope } from "@zuse/contracts";
import { Effect } from "effect";
import { authenticateWorkos } from "./auth.ts";
import { ApiConfiguration } from "./config.ts";
import { forbidden } from "./errors.ts";
import { requireOrganizationMembership } from "./organizations.ts";
import type { WorkosPrincipal } from "./workos.ts";
import { requestWorkspaceScope } from "./workspace-scope.ts";

/** Resolve ownership independently of the verified actor; never rewrite their identity. */
export const resolveWorkspaceActorAccess = Effect.fn(
	"resolveWorkspaceActorAccess",
)(function* (
	actor: WorkosPrincipal,
	scope: WorkspaceScope,
	access: "content" | "administration" | "billing",
) {
	if (scope.kind === "personal")
		return { actor, scope, ownerId: actor.accountId, membership: null };
	const config = yield* ApiConfiguration;
	if (!config.organizationWorkspacesEnabled)
		return yield* forbidden("organization_workspaces_disabled");
	const member = yield* requireOrganizationMembership(
		actor.accountId,
		scope.organizationId,
	);
	const role = member.role.slug;
	if (
		role !== "admin" &&
		!(access === "content" && role === "member") &&
		!(access === "billing" && role === "billing")
	)
		return yield* forbidden("workspace_access_denied");

	return {
		actor,
		scope,
		ownerId: `organization:${scope.organizationId}`,
		membership: member,
	};
});

export const requireWorkspaceAccess = Effect.fn("requireWorkspaceAccess")(
	function* (
		request: Request,
		access: "content" | "administration" | "billing",
	) {
		return yield* resolveWorkspaceActorAccess(
			yield* authenticateWorkos(request),
			yield* requestWorkspaceScope(request),
			access,
		);
	},
);
