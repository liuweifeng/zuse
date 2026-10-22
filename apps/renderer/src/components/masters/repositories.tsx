import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	Folder,
	MasterCapabilities,
	MasterRepository,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import {
	Add01Icon,
	Cancel01Icon,
	Folder01Icon,
	GithubIcon,
	Tick02Icon,
} from "@zuse/icons/solid-rounded";
import { useEffect, useState } from "react";
import { useActiveEnvironmentEntities } from "../../lib/environment-entity-hooks.ts";
import { githubOwnerAvatarUrl } from "../../lib/github-avatar.ts";
import { repositoryEnvironmentIds } from "../../lib/master-capabilities.ts";
import {
	environmentLabel,
	useEnvironmentCatalogStore,
	withConnectedEnvironments,
} from "../../store/environment-catalog.ts";
import { masterCommand } from "../../store/masters.ts";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu.tsx";

const repositoryKey = (repository: MasterRepository) =>
	`${repository.environmentId}:${repository.folderId}`;

/**
 * Repositories open in Zuse on the home, plus connected machines when the
 * Master's server allows cross-environment work.
 */
function useRepositoryChoices(home: string, capabilities: MasterCapabilities) {
	const entries = useEnvironmentCatalogStore((state) => state.entries);
	const [choices, setChoices] = useState<readonly MasterRepository[]>([]);
	const environmentIds = [
		...repositoryEnvironmentIds(
			home,
			withConnectedEnvironments(entries, home),
			capabilities,
		),
	]
		.sort()
		.join("\n");
	useEffect(() => {
		let disposed = false;
		void Promise.allSettled(
			environmentIds.split("\n").map(async (environmentId) => {
				const folders = await masterCommand<
					Record<string, never>,
					readonly Folder[]
				>(environmentId, "workspace.list", {});
				return folders.map((folder) => ({
					environmentId,
					folderId: folder.id,
					name: folder.name,
				}));
			}),
		).then((results) => {
			if (!disposed)
				setChoices(
					results.flatMap((result) =>
						result.status === "fulfilled" ? result.value : [],
					),
				);
		});
		return () => {
			disposed = true;
		};
	}, [environmentIds]);
	return choices;
}

export function RepositoryIcon({
	repository,
}: {
	readonly repository: MasterRepository;
}) {
	const { originsByFolder } = useActiveEnvironmentEntities();
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const origin =
		repository.environmentId === activeEnvironmentId
			? originsByFolder[repository.folderId]
			: undefined;
	const avatar = githubOwnerAvatarUrl(origin, 32);
	if (avatar)
		return (
			<img
				src={avatar}
				alt=""
				className="size-4 shrink-0 rounded-[4px] bg-muted"
			/>
		);
	return (
		<HugeiconsIcon
			icon={origin ? GithubIcon : Folder01Icon}
			className="size-3.5 shrink-0 text-muted-foreground"
		/>
	);
}

export function RepositoryChips({
	home,
	capabilities,
	value,
	disabled = false,
	onChange,
}: {
	readonly home: string;
	readonly capabilities: MasterCapabilities;
	readonly value: readonly MasterRepository[];
	readonly disabled?: boolean;
	readonly onChange: (repositories: readonly MasterRepository[]) => void;
}) {
	const { message } = useMessages("projects");
	const choices = useRepositoryChoices(home, capabilities);
	const entries = useEnvironmentCatalogStore((state) => state.entries);
	const selected = new Set(value.map(repositoryKey));
	const multiEnvironment =
		new Set(choices.map((choice) => choice.environmentId)).size > 1;
	// Callers pass `disabled` while a save is in flight, so a second toggle
	// can't build on a list that is about to change.
	const toggle = (repository: MasterRepository) =>
		onChange(
			selected.has(repositoryKey(repository))
				? value.filter(
						(item) => repositoryKey(item) !== repositoryKey(repository),
					)
				: [...value, repository],
		);
	return (
		<div className="flex flex-col gap-0.5">
			{value.map((repository) => (
				<div
					key={repositoryKey(repository)}
					className="group flex h-7 items-center gap-2 rounded-md px-2 hover:bg-muted/40"
				>
					<RepositoryIcon repository={repository} />
					<span className="min-w-0 flex-1 truncate">{repository.name}</span>
					<button
						type="button"
						aria-label={message("projects:masters_remove_repository", {
							name: repository.name,
						})}
						disabled={disabled}
						onClick={() => toggle(repository)}
						className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
					>
						<HugeiconsIcon icon={Cancel01Icon} className="size-3" />
					</button>
				</div>
			))}
			<Menu>
				<MenuTrigger
					disabled={disabled}
					className="flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground outline-none hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-muted/40"
				>
					<HugeiconsIcon icon={Add01Icon} className="size-3.5" />
					{message("projects:masters_add_repository")}
				</MenuTrigger>
				<MenuPopup align="start" className="max-h-72 w-64">
					{choices.length === 0 ? (
						<MenuItem disabled>
							{message(
								"projects:masters_open_a_repository_in_zuse_to_add_it_here",
							)}
						</MenuItem>
					) : (
						choices.map((repository) => (
							<MenuItem
								key={repositoryKey(repository)}
								closeOnClick={false}
								disabled={disabled}
								onClick={() => toggle(repository)}
							>
								<RepositoryIcon repository={repository} />
								<span className="min-w-0 flex-1 truncate">
									{repository.name}
								</span>
								{multiEnvironment ? (
									<span className="max-w-20 truncate text-[10px] text-muted-foreground">
										{environmentLabel(entries, repository.environmentId) ??
											message("projects:masters_this_environment")}
									</span>
								) : null}
								<span className="inline-grid size-3.5 place-items-center">
									{selected.has(repositoryKey(repository)) ? (
										<HugeiconsIcon
											icon={Tick02Icon}
											strokeWidth={2.5}
											className="size-3.5 text-primary"
										/>
									) : null}
								</span>
							</MenuItem>
						))
					)}
				</MenuPopup>
			</Menu>
		</div>
	);
}
