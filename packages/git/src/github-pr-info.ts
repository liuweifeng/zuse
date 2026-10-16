import { GitPrInfo } from "@zuse/contracts";
export const emptyPr = (
	branch: string | null,
	capability: GitPrInfo["prCapability"] = "available",
): GitPrInfo =>
	GitPrInfo.make({
		nodeId: null,
		state: "none",
		branch,
		baseBranch: null,
		additions: 0,
		deletions: 0,
		number: null,
		url: null,
		isDraft: false,
		checks: "none",
		mergeable: "unknown",
		checksTotal: 0,
		checksRunning: 0,
		checksPassing: 0,
		checksFailing: 0,
		autoMergeEnabled: false,
		prCapability: capability,
		stale: capability !== "available",

		checksComplete: true,
	});
