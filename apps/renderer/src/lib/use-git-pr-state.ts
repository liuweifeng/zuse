import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import { useMemo } from "react";
import { useWorkspaceStore } from "../store/workspace.ts";
import { useEnvironmentShellResource } from "./environment-shell-client-bus.ts";
import { resolveGitPrState } from "./git-pr-state.ts";
import {
	useGitPrDetailsResource,
	useGitWorkspaceResource,
} from "./git-workspace-client-bus.ts";
import { getActiveEnvironment } from "./rpc-client.ts";

export function useGitPrState(
	ref: ExecutionRef | null,
	requestDetails = false,
) {
	const shell = useEnvironmentShellResource(ref?.environmentId ?? null);
	const localScratch = useWorkspaceStore(
		(state) =>
			ref !== null &&
			ref.environmentId === getActiveEnvironment() &&
			state.folders.some(
				(folder) => folder.id === ref.folderId && folder.kind === "scratch",
			),
	);
	const scratch =
		localScratch ||
		shell.data?.folders.some(
			(folder) => folder.id === ref?.folderId && folder.kind === "scratch",
		) === true;
	const gitRef = scratch ? null : ref;
	const gitView = useGitWorkspaceResource(gitRef, "connect");
	const prDetailsView = useGitPrDetailsResource(
		gitRef,
		requestDetails || gitView.data?.pr?.state === "open"
			? "connect"
			: "cache-only",
	);
	const pr = gitView.data?.pr ?? null;
	const details = prDetailsView.data?.details ?? null;
	const branch = gitView.data?.status?.branch ?? null;
	const state = useMemo(
		() => resolveGitPrState(pr, details, branch),
		[pr, details, branch],
	);
	return { gitView, prDetailsView, ...state };
}
