import {
	emptyGitHubView,
	GitHubObserver,
} from "@zuse/client-runtime/github-observer";
import { GitHubObservation, type GitHubTarget } from "@zuse/contracts";
import { Schema } from "effect";
import { useCallback, useSyncExternalStore } from "react";
import {
	invalidateControlPlaneCache,
	peekControlPlaneCache,
	runCachedRead,
	runCloudControl,
	runControlPlane,
} from "./control-plane-client.ts";
import { isHostedProduct } from "./hosted-session.ts";
import {
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "./renderer-account.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "./renderer-workspace.ts";

const cacheKey = (target: GitHubTarget) =>
	`github-observation:${JSON.stringify(target)}`;
const decodeObservation = Schema.decodeUnknownSync(GitHubObservation);
export const rendererGitHubObserver = new GitHubObserver(
	(input, signal) => {
		const read = async () => {
			if (
				isHostedProduct() ||
				rendererWorkspaceSnapshot().scope.kind === "organization"
			)
				return runCloudControl(
					(client) => client["cloud.github.observe"](input),
					{ signal },
				);
			const local = await runControlPlane(
				(client) => client["github.observe"](input),
				{ signal },
			);
			if (
				local.pr.prCapability === "authentication" &&
				input.target.host === "github.com" &&
				rendererAccountSnapshot().subject
			)
				return runCloudControl(
					(client) => client["cloud.github.observe"](input),
					{ signal },
				);
			return local;
		};
		return read().then((value) => {
			if (input.details) return value;
			if (value.pr.stale) {
				if (
					value.pr.prCapability === "authentication" ||
					value.pr.prCapability === "access"
				)
					invalidateControlPlaneCache(cacheKey(input.target));
				return value;
			}
			return runCachedRead(cacheKey(input.target), async () => value, {
				refresh: true,
				decode: decodeObservation,
			});
		});
	},
	(target) =>
		peekControlPlaneCache(cacheKey(target), decodeObservation) ?? null,
);

subscribeRendererAccount(() => rendererGitHubObserver.clear());
subscribeRendererWorkspace(() => rendererGitHubObserver.clear());

export const useGitHubObservation = (
	target: GitHubTarget | null,
	active: boolean,
) => {
	const account = useSyncExternalStore(
		subscribeRendererAccount,
		rendererAccountSnapshot,
	);
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
	);
	const key = target ? rendererGitHubObserver.key(target) : "";
	const subscribe = useCallback(
		(listener: () => void) =>
			target
				? rendererGitHubObserver.subscribe(target, listener, active)
				: () => {},
		[key, active, account, workspace],
	);
	const snapshot = useCallback(
		() => (target ? rendererGitHubObserver.snapshot(target) : emptyGitHubView),
		[key, account, workspace],
	);
	return useSyncExternalStore(subscribe, snapshot);
};

export { githubTargetFromSummary } from "@zuse/client-runtime/github-observer";
