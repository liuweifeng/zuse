import type {
	EnvironmentId,
	FolderId,
	RepositorySettings,
	RepositorySettingsPatch,
} from "@zuse/contracts";
import { CommandId } from "@zuse/contracts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { formatError } from "../lib/format-error.ts";
import { rendererAccountSnapshot } from "../lib/renderer-account.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "../lib/renderer-workspace.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

export const repositorySettingsKey = (
	environmentId: EnvironmentId,
	projectId: FolderId,
): string => `${environmentId}:${projectId}`;

type RepoSettingsState = {
	readonly byProject: Readonly<Record<string, RepositorySettings>>;
	readonly error: string | null;
	readonly refresh: (
		environmentId: EnvironmentId,
		projectId: FolderId,
	) => Promise<RepositorySettings | null>;
	readonly update: (
		environmentId: EnvironmentId,
		projectId: FolderId,
		patch: RepositorySettingsPatch,
	) => Promise<RepositorySettings | null>;
};

export const useRepositorySettingsStore = create<RepoSettingsState>((set) => {
	const request = async (
		environmentId: EnvironmentId,
		projectId: FolderId,
		patch?: RepositorySettingsPatch,
	): Promise<RepositorySettings | null> => {
		const account = rendererAccountSnapshot();
		const workspace = rendererWorkspaceSnapshot();
		const isCurrent = () =>
			account === rendererAccountSnapshot() &&
			workspace === rendererWorkspaceSnapshot();
		const action = patch === undefined ? "get" : "update";
		try {
			const { result: settings } = await dispatchEnvironmentShellCommand<
				{
					readonly projectId: FolderId;
					readonly patch?: RepositorySettingsPatch;
				},
				RepositorySettings
			>({
				environmentId,
				kind: `repositorySettings.${action}`,
				commandId: CommandId.make(
					`repository-settings-${action}:${crypto.randomUUID()}`,
				),
				payload: patch === undefined ? { projectId } : { projectId, patch },
			});
			if (!isCurrent()) return null;
			set((state) => ({
				byProject: {
					...state.byProject,
					[repositorySettingsKey(environmentId, projectId)]: settings,
				},
				error: null,
			}));
			return settings;
		} catch (error) {
			if (isCurrent()) set({ error: formatError(error) });
			return null;
		}
	};
	return {
		byProject: {},
		error: null,
		refresh: (environmentId, projectId) => request(environmentId, projectId),
		update: request,
	};
});

const unsubscribeWorkspace = subscribeRendererWorkspace(() => {
	useRepositorySettingsStore.setState({ byProject: {}, error: null });
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribeWorkspace);
