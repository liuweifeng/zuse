import type {
	GitPrChecks,
	GitPrInfo,
	GitPrMergeable,
	GitStackResult,
} from "@zuse/contracts";

/**
 * One pull request linked to a chat. Today a chat's PRs are the PR for its
 * checkout plus any `gh stack` layers around it; both feed this one shape so
 * every surface (summary, sidebar hover) lists them the same way, base
 * first, so a stack reads top-down like the chain it builds.
 */
export interface ChatPullRequest {
	readonly number: number;
	readonly url: string | null;
	readonly title: string | null;
	readonly state: "open" | "closed" | "merged";
	readonly isDraft: boolean;
	readonly checks: GitPrChecks;
	readonly mergeable: GitPrMergeable;
	/** The PR for the chat's own checkout. */
	readonly isCurrent: boolean;
}

export const chatPullRequests = (input: {
	readonly pr: GitPrInfo | null;
	readonly title: string | null;
	readonly stack: GitStackResult | null;
}): ReadonlyArray<ChatPullRequest> => {
	const { pr, title, stack } = input;
	const current =
		pr !== null && pr.state !== "none" && pr.number !== null
			? {
					number: pr.number,
					url: pr.url,
					title,
					state: pr.state,
					isDraft: pr.isDraft,
					checks: pr.checks,
					mergeable: pr.mergeable,
				}
			: null;
	const layers = (stack?.branches ?? [])
		.slice()
		.reverse()
		.flatMap((branch): ReadonlyArray<ChatPullRequest> => {
			const layer = branch.pr;
			// The checkout's own PR can be known before the stack reports it;
			// it still belongs at its branch's place in the chain.
			if (layer === undefined)
				return branch.isCurrent && current !== null
					? [{ ...current, isCurrent: true }]
					: [];
			const live =
				current !== null && layer.number === current.number ? current : null;
			return [
				{
					number: layer.number,
					url: layer.url ?? live?.url ?? null,
					title: live?.title ?? layer.title ?? null,
					state:
						live?.state ??
						(layer.state === "unknown" ? ("open" as const) : layer.state),
					isDraft: live?.isDraft ?? layer.isDraft === true,
					checks: live?.checks ?? ("none" as const),
					mergeable: live?.mergeable ?? ("unknown" as const),
					isCurrent: branch.isCurrent,
				},
			];
		});
	if (current === null || layers.some((l) => l.number === current.number))
		return layers;
	return [{ ...current, isCurrent: true }, ...layers];
};
