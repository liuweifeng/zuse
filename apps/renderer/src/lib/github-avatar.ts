import type { GitOriginInfo } from "@zuse/contracts";

/** GitHub serves owner/org avatars at this path; works for users and orgs alike. */
export const githubAvatarUrl = (owner: string, size = 80): string =>
	`https://github.com/${encodeURIComponent(owner)}.png?size=${size}`;

/** The owner's avatar for a GitHub remote, or null so callers can fall back. */
export const githubOwnerAvatarUrl = (
	origin: Pick<GitOriginInfo, "host" | "owner"> | null | undefined,
	size = 80,
): string | null =>
	origin && origin.host === "github.com"
		? githubAvatarUrl(origin.owner, size)
		: null;
