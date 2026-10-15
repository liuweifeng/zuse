/** Archive expiry retires compute; it must never imply deletion of conversation data. */
export const ARCHIVED_WORKSPACE_RETENTION_MS = 10 * 24 * 60 * 60 * 1_000;
export const WORKSPACE_DELETION_TOMBSTONE_RETENTION_MS =
	30 * 24 * 60 * 60 * 1_000;

/** Old rows may have a longer deadline. Never extend a previously requested deadline. */
export const archivedWorkspaceExpiry = (workspace: {
	readonly archiveRequestedAtMs?: number;
	readonly archiveDeleteAtMs?: number;
}): number | undefined => {
	const requested = workspace.archiveRequestedAtMs;
	if (requested === undefined) return workspace.archiveDeleteAtMs;
	return Math.min(
		requested + ARCHIVED_WORKSPACE_RETENTION_MS,
		workspace.archiveDeleteAtMs ?? Number.MAX_SAFE_INTEGER,
	);
};

/** Bring older thirty-day rows into the new policy without a destructive deadline migration. */
export const archivedWorkspaceNeedsRetentionReconciliation = (
	workspace: {
		readonly state: string;
		readonly desiredState: string;
		readonly statusCode: string;
		readonly archiveRequestedAtMs?: number;
	},
	nowMs: number,
): boolean =>
	workspace.state === "archived" &&
	workspace.desiredState === "archived" &&
	workspace.statusCode === "archived" &&
	workspace.archiveRequestedAtMs !== undefined &&
	workspace.archiveRequestedAtMs + ARCHIVED_WORKSPACE_RETENTION_MS <= nowMs;
