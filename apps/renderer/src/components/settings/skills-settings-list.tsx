import "@zuse/i18n/english/plugins";
import { HugeiconsIcon } from "@hugeicons/react";
import { CommandId, EnvironmentId, type Skill } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { CubeIcon } from "@zuse/icons/solid-rounded";
import { useCallback, useEffect, useState } from "react";
import { dispatchEnvironmentShellCommand } from "~/lib/environment-shell-client-bus.ts";
import { providerDisplayName } from "~/lib/provider-labels";
import { useEnvironmentCatalogStore } from "~/store/environment-catalog.ts";
import { PluginsLoading } from "../plugins/plugins-loading.tsx";
import { Button } from "../ui/button.tsx";
import { SettingsGroup } from "../ui/settings-panel.tsx";
import { Switch } from "../ui/switch.tsx";
import { toastManager } from "../ui/toast.tsx";

const skillKey = (skill: Pick<Skill, "providerId" | "name">) =>
	`${skill.providerId}:${skill.name}`;

const skillCommand = async <Payload, Result>(
	kind: "skill.listGlobal" | "skill.setEnabled",
	payload: Payload,
): Promise<Result> => {
	const receipt = await dispatchEnvironmentShellCommand<Payload, Result>({
		environmentId: EnvironmentId.make(
			useEnvironmentCatalogStore.getState().activeEnvironmentId,
		),
		kind,
		commandId: CommandId.make(`skill:${crypto.randomUUID()}`),
		payload,
	});
	return receipt.result;
};

export type GlobalSkills = {
	readonly skills: readonly Skill[] | null;
	readonly failed: boolean;
	readonly reload: () => Promise<void>;
	readonly setEnabled: (skill: Skill, enabled: boolean) => Promise<void>;
};

/** User-level skills for every provider, with their on/off state. */
export function useGlobalSkills(): GlobalSkills {
	const { message: m } = useUiMessages(["plugins"]);
	const [skills, setSkills] = useState<readonly Skill[] | null>(null);
	const [failed, setFailed] = useState(false);
	const reload = useCallback(async () => {
		try {
			setSkills(
				await skillCommand<Record<string, never>, readonly Skill[]>(
					"skill.listGlobal",
					{},
				),
			);
			setFailed(false);
		} catch {
			setFailed(true);
		}
	}, []);
	useEffect(() => {
		void reload();
	}, [reload]);
	const setEnabled = useCallback(
		async (skill: Skill, enabled: boolean) => {
			const key = skillKey(skill);

			const apply = (value: boolean) =>
				setSkills(
					(current) =>
						current?.map((item) =>
							skillKey(item) === key ? { ...item, enabled: value } : item,
						) ?? null,
				);
			apply(enabled);
			try {
				const result = await skillCommand<
					{
						readonly providerId: Skill["providerId"];
						readonly name: string;
						readonly scope: Skill["scope"];
						readonly enabled: boolean;
					},
					{ readonly enabled: boolean }
				>("skill.setEnabled", {
					providerId: skill.providerId,
					name: skill.name,
					scope: skill.scope,
					enabled,
				});
				apply(result.enabled);
			} catch {
				apply(skill.enabled);
				toastManager.add({
					title: m("plugins:plugins_settings_toggle_failed", {
						name: skill.name,
					}),
					type: "error",
				});
			}
		},
		[m],
	);
	return { skills, failed, reload, setEnabled };
}

export function SkillsSettingsList({
	state,
	query,
}: {
	readonly state: GlobalSkills;
	readonly query: string;
}) {
	const { message: m } = useUiMessages(["plugins"]);
	const needle = query.trim().toLowerCase();
	if (state.skills === null && !state.failed)
		return <PluginsLoading label={m("plugins:plugins_skills_loading")} />;
	if (state.skills === null)
		return (
			<p className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
				{m("plugins:plugins_skills_load_failed")}
				<Button variant="ghost" onClick={() => void state.reload()}>
					{m("plugins:plugins_retry")}
				</Button>
			</p>
		);
	const skills = state.skills
		.filter((skill) =>
			`${skill.name} ${skill.description}`.toLowerCase().includes(needle),
		)
		.toSorted((left, right) => left.name.localeCompare(right.name));
	if (skills.length === 0)
		return (
			<p className="py-12 text-center text-muted-foreground">
				{needle
					? m("plugins:plugins_no_results", { query: query.trim() })
					: m("plugins:plugins_skills_none")}
			</p>
		);

	const groups = new Map<Skill["providerId"], Skill[]>();
	for (const skill of skills)
		groups.set(skill.providerId, [
			...(groups.get(skill.providerId) ?? []),
			skill,
		]);
	return (
		<div className="flex flex-col gap-4">
			{[...groups].map(([providerId, providerSkills]) => (
				<SettingsGroup
					key={providerId}
					title={providerDisplayName(providerId)}
					footer={
						providerId === "codex"
							? m("plugins:plugins_skills_codex_note")
							: undefined
					}
				>
					{providerSkills.map((skill) => (
						<div
							key={`${skillKey(skill)}:${skill.filePath}`}
							className="flex items-center gap-3 px-3 py-2.5"
						>
							<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
								<HugeiconsIcon icon={CubeIcon} className="size-4" />
							</span>
							<div className="min-w-0 flex-1">
								<p className="truncate text-[13px] font-medium text-foreground">
									{skill.name}
								</p>
								<p className="truncate text-muted-foreground">
									{skill.description}
								</p>
							</div>
							<span className="shrink-0 text-muted-foreground">
								{skill.scope === "global"
									? m("plugins:plugins_skills_personal")
									: m("plugins:plugins_skills_project")}
							</span>
							{skill.toggleSupported ? (
								<Switch
									checked={skill.enabled}
									aria-label={skill.name}
									onCheckedChange={(next) => void state.setEnabled(skill, next)}
								/>
							) : (
								<span className="shrink-0 text-[11px] text-muted-foreground">
									{m("plugins:plugins_skills_always_on")}
								</span>
							)}
						</div>
					))}
				</SettingsGroup>
			))}
		</div>
	);
}
