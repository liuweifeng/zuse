import "@zuse/i18n/english/projects";
import { MASTER_SETTINGS_LIMITS } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Search } from "lucide-react";
import { useState } from "react";
import { useGlobalSkills } from "../settings/skills-settings-list.tsx";
import { Button } from "../ui/button.tsx";
import { Switch } from "../ui/switch.tsx";

/** A bare YAML block marker (`|`, `>-`) means the provider kept no summary. */
const describes = (description: string) =>
	!/^[|>][-+]?$/.test(description.trim()) && description.trim() !== "";

/**
 * Searchable list of the skills installed on the Master's home, each with a
 * switch. Chosen skills sort first; a chosen name that isn't installed there
 * stays listed so it can still be switched off.
 */
export function MasterSkillPicker({
	environmentId,
	value,
	disabled,
	onChange,
}: {
	readonly environmentId: string;
	readonly value: readonly string[];
	readonly disabled: boolean;
	readonly onChange: (skills: readonly string[]) => void;
}) {
	const { message } = useMessages("projects");
	const { skills, failed, reload } = useGlobalSkills(environmentId);
	const [query, setQuery] = useState("");
	const selected = new Set(value);
	const installed = new Map(
		(skills ?? [])
			.filter((skill) => skill.enabled)
			.map((skill) => [skill.name, skill.description] as const),
	);
	for (const name of value) if (!installed.has(name)) installed.set(name, "");
	const needle = query.trim().toLowerCase();
	const rows = [...installed]
		.filter(([name, description]) =>
			`${name} ${description}`.toLowerCase().includes(needle),
		)
		.toSorted(
			([left], [right]) =>
				Number(selected.has(right)) - Number(selected.has(left)) ||
				left.localeCompare(right),
		);
	const toggle = (name: string, on: boolean) =>
		onChange(on ? [...value, name] : value.filter((item) => item !== name));
	return (
		<div className="flex flex-col gap-2">
			<label className="flex h-7 items-center gap-2 rounded-md bg-muted/55 px-2.5 focus-within:ring-2 focus-within:ring-ring/24">
				<Search className="size-3.5 shrink-0 text-muted-foreground" />
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={message("projects:masters_search_skills")}
					aria-label={message("projects:masters_search_skills")}
					className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
				/>
				{value.length ? (
					<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
						{message("projects:masters_skills_selected", {
							count: value.length,
						})}
					</span>
				) : null}
			</label>
			{skills === null && failed ? (
				<p className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
					{message("projects:masters_skills_failed")}
					<Button variant="ghost" size="sm" onClick={() => void reload()}>
						{message("projects:masters_retry")}
					</Button>
				</p>
			) : skills === null ? (
				<p className="px-1 py-2 text-xs text-muted-foreground">
					{message("projects:masters_loading")}
				</p>
			) : rows.length === 0 ? (
				<p className="px-1 py-2 text-xs text-muted-foreground">
					{installed.size
						? message("projects:masters_no_matching_skills")
						: message("projects:masters_no_skills_installed")}
				</p>
			) : (
				<ul className="flex flex-col">
					{rows.map(([name, description]) => {
						const on = selected.has(name);
						return (
							<li key={name}>
								<div className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/35">
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[13px] text-foreground">
											{name}
										</span>
										{describes(description) ? (
											<span className="block truncate text-[11px] text-muted-foreground">
												{description}
											</span>
										) : null}
									</span>
									<Switch
										checked={on}
										disabled={
											disabled ||
											(!on && value.length >= MASTER_SETTINGS_LIMITS.skills)
										}
										onCheckedChange={(checked) => toggle(name, checked)}
										aria-label={name}
									/>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
