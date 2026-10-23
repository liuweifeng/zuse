import { emptyPr } from "./github-pr-info.ts";

export { emptyPr } from "./github-pr-info.ts";

import {
	type GitHubObservation,
	type GitHubTarget,
	GitPrCheckRun,
	GitPrDetails,
	GitPrFile,
	GitPrInfo,
} from "@zuse/contracts";
import {
	type ActionsJob,
	actionsJobsApiPath,
	checkRunFromRollup,
	collectActionsRunIds,
	isFailedCheckRollup,
	metadataForRollupEntry,
} from "./check-runs.ts";
import {
	type GitHubClient,
	GitHubFailure,
	type GitHubRepository,
} from "./github-client.ts";
import { type GitHubPr, GitHubPullRequests } from "./github-pull-requests.ts";
import {
	feedbackComments,
	feedbackReviews,
	parseFeedbackPages,
	parseReviewThreads,
} from "./pr-feedback.ts";

const aggregateChecks = (
	rollup: ReadonlyArray<{
		status?: string;
		state?: string;
		conclusion?: string;
	}>,
): GitPrInfo["checks"] => {
	if (rollup.length === 0) return "none";
	let pending = false;
	for (const entry of rollup) {
		const conclusion = (entry.conclusion ?? "").toUpperCase();
		const status = (entry.status ?? "").toUpperCase();
		const state = (entry.state ?? "").toUpperCase();
		if (isFailedCheckRollup(entry)) {
			return "failure";
		}
		if (
			status === "QUEUED" ||
			status === "IN_PROGRESS" ||
			status === "PENDING" ||
			state === "PENDING" ||
			(status !== "COMPLETED" && conclusion === "" && state === "")
		) {
			pending = true;
		}
	}
	return pending ? "pending" : "success";
};

const countChecks = (
	rollup: ReadonlyArray<{
		status?: string;
		state?: string;
		conclusion?: string;
	}>,
): {
	total: number;
	running: number;
	passing: number;
	failing: number;
} => {
	let running = 0;
	let passing = 0;
	let failing = 0;
	for (const entry of rollup) {
		const conclusion = (entry.conclusion ?? "").toUpperCase();
		const status = (entry.status ?? "").toUpperCase();
		const state = (entry.state ?? "").toUpperCase();
		if (isFailedCheckRollup(entry)) {
			failing += 1;
		} else if (
			status === "QUEUED" ||
			status === "IN_PROGRESS" ||
			status === "PENDING" ||
			state === "PENDING" ||
			(status !== "COMPLETED" && conclusion === "" && state === "")
		) {
			running += 1;
		} else {
			passing += 1;
		}
	}
	return { total: rollup.length, running, passing, failing };
};

export const infoFromPr = (pr: GitHubPr): GitPrInfo => {
	const counts = countChecks(pr.statusCheckRollup);
	return GitPrInfo.make({
		nodeId: pr.id,
		state:
			pr.state === "OPEN"
				? "open"
				: pr.state === "MERGED"
					? "merged"
					: "closed",
		branch: pr.headRefName,
		baseBranch: pr.baseRefName,
		headSha: pr.headRefOid,
		additions: pr.additions,
		deletions: pr.deletions,
		number: pr.number,
		url: pr.url,
		isDraft: pr.isDraft,
		checks: aggregateChecks(pr.statusCheckRollup),
		checkRuns: pr.statusCheckRollup.map(checkRunFromRollup),
		mergeable: mapMergeable(pr.mergeable),
		checksTotal: counts.total,
		checksRunning: counts.running,
		checksPassing: counts.passing,
		checksFailing: counts.failing,
		autoMergeEnabled: pr.autoMergeRequest != null,
		prCapability: "available",
		stale: false,
		statusRevision: pr.statusRevision,
		remarksRevision: pr.remarksRevision,
		observedAt: new Date(pr.observedAt),
		checksComplete: pr.checksComplete,
	});
};
const mapMergeable = (raw: string | undefined): GitPrInfo["mergeable"] => {
	switch ((raw ?? "").toUpperCase()) {
		case "MERGEABLE":
		case "CLEAN":
			return "clean";
		case "CONFLICTING":
			return "conflicting";
		default:
			return "unknown";
	}
};

export const emptyDetails: GitPrDetails = GitPrDetails.make({
	state: "none",
	number: null,
	url: null,
	isDraft: false,
	checks: "none",
	mergeable: "unknown",
	additions: 0,
	deletions: 0,
	title: "",
	body: "",
	author: "",
	baseBranch: null,
	headBranch: null,
	comments: [],
	reviews: [],
	files: [],
	checkRuns: [],
});

export const readPrDetails = async (
	github: GitHubClient,
	pullRequests: GitHubPullRequests,
	repository: GitHubRepository,
	pr: GitHubPr,
	branch: string,
	signal: AbortSignal,
): Promise<GitPrDetails> => {
	const credential = await github.credential(repository, signal);
	const [feedback, files, jobs] = await Promise.all([
		pullRequests.feedback(repository, pr, signal),
		pullRequests.files(repository, pr, signal),
		Promise.all(
			collectActionsRunIds(pr.statusCheckRollup).map(async (runId) => {
				try {
					return [
						runId,
						await github.pages<ActionsJob>(
							credential,
							actionsJobsApiPath(repository.owner, repository.repo, runId),
							signal,
							(value) => (value as { jobs: ActionsJob[] }).jobs,
						),
					] as const;
				} catch (error) {
					if (error instanceof GitHubFailure && error.kind === "access")
						return [runId, []] as const;
					throw error;
				}
			}),
		),
	]);
	const threads = parseReviewThreads(JSON.stringify(feedback.threads));
	const discussion =
		parseFeedbackPages(JSON.stringify([feedback.comments])) ?? [];
	const inline = parseFeedbackPages(JSON.stringify([feedback.inline])) ?? [];
	const reviews = parseFeedbackPages(JSON.stringify([feedback.reviews])) ?? [];
	const jobsByRunId = new Map<string, ReadonlyArray<ActionsJob>>(jobs);
	return GitPrDetails.make({
		...infoFromPr(pr),
		title: pr.title,
		body: pr.body,
		author: pr.author?.login ?? "",
		authorAvatarUrl: pr.author?.avatarUrl ?? null,
		headBranch: branch,
		headSha: pr.headRefOid,
		baseBranch: pr.baseRefName,
		comments: [
			...feedbackComments(discussion),
			...feedbackComments(inline, threads),
		],
		reviews: feedbackReviews(reviews, threads, inline),
		files: files.map((file) => GitPrFile.make(file)),
		checkRuns: pr.statusCheckRollup.map((check) =>
			GitPrCheckRun.make({
				...checkRunFromRollup(check),
				...metadataForRollupEntry(check, jobsByRunId),
				appName: check.checkSuite?.app?.name ?? null,
				appAvatarUrl: check.checkSuite?.app?.logoUrl ?? null,
			}),
		),
	});
};
/** GitHub reads require a repository identity, never a checkout or Git executable. */
export class GitHubObservations {
	readonly pullRequests: GitHubPullRequests;
	constructor(readonly client: GitHubClient) {
		this.pullRequests = new GitHubPullRequests(client);
	}
	async observe(
		target: GitHubTarget,
		repository: GitHubRepository,
		signal: AbortSignal,
		details = false,
		force = false,
	): Promise<GitHubObservation> {
		try {
			return await this.read(target, repository, signal, details, force);
		} catch (error) {
			if (signal.aborted) throw error;
			const failure =
				error instanceof GitHubFailure
					? error
					: new GitHubFailure("unknown", "GitHub refresh failed.");
			return {
				pr: GitPrInfo.make({
					...emptyPr(target.branch, failure.kind),
					observationError: failure.message,
					retryAt: failure.retryAt ? new Date(failure.retryAt) : null,
				}),
				details: null,
			};
		}
	}
	async read(
		target: GitHubTarget,
		repository: GitHubRepository,
		signal: AbortSignal,
		details = false,
		force = false,
	): Promise<GitHubObservation> {
		const number =
			target.number ??
			(target.branch === null
				? null
				: await this.pullRequests.discover(
						repository,
						target.branch,
						signal,
						true,
						force,
						target.headOwner,
					));
		if (number === null)
			return {
				pr: emptyPr(target.branch),
				details: details ? emptyDetails : null,
			};
		const pr = await this.pullRequests.read(repository, number, signal, {
			interactive: true,
			force,
		});
		return {
			pr: infoFromPr(pr),
			details: details
				? await readPrDetails(
						this.client,
						this.pullRequests,
						repository,
						pr,
						target.branch ?? pr.headRefName,
						signal,
					)
				: null,
		};
	}
}
