import { type CloudProject, CloudWorkspaceOpError } from "@zuse/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { loadCloudProjects } from "./cloud-workspace-session-cache.ts";
import { subscribeControlPlaneSessionCache } from "./control-plane-client.ts";
import {
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "./renderer-account.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "./renderer-workspace.ts";

const EMPTY: ReadonlyArray<CloudProject> = [];

/** Uses the existing scoped cache; never stores cloud folders in a runtime shell. */
export const useCloudProjects = (): ReadonlyArray<CloudProject> => {
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
		rendererWorkspaceSnapshot,
	);
	const account = useSyncExternalStore(
		subscribeRendererAccount,
		rendererAccountSnapshot,
		rendererAccountSnapshot,
	);
	const [result, setResult] = useState<{
		workspace: typeof workspace;
		account: typeof account;
		projects: ReadonlyArray<CloudProject>;
	} | null>(null);
	useEffect(() => {
		if (!account.subject) return;
		let cancelled = false;
		let loading = false;
		let reload = false;
		const load = () => {
			if (cancelled) return;
			if (loading) {
				reload = true;
				return;
			}
			loading = true;
			reload = false;
			let succeeded = false;
			void loadCloudProjects()
				.then(({ projects }) => {
					succeeded = true;
					if (!cancelled && !reload)
						setResult({ workspace, account, projects });
				})
				.catch((cause) => {
					if (
						!cancelled &&
						cause instanceof CloudWorkspaceOpError &&
						cause.code === "not-allowed"
					)
						setResult(null);
				})
				.finally(() => {
					loading = false;
					if (reload && succeeded) load();
				});
		};
		load();
		const unsubscribe = subscribeControlPlaneSessionCache((key) => {
			if (key === "cloud-workspace:projects") load();
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [workspace, account]);
	return result?.workspace === workspace && result.account === account
		? result.projects
		: EMPTY;
};
