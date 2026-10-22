import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	EnvironmentId,
	MASTER_SETTINGS_LIMITS as LIMITS,
	type MasterAction,
	type MasterSettings,
	type MasterSnapshot,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Add01Icon, Cancel01Icon } from "@zuse/icons/solid-rounded";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { formatError } from "../../lib/format-error.ts";
import {
	MODEL_PICKER_SETTINGS_TRIGGER,
	ModelPicker,
} from "../model-picker.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { MasterSkillPicker } from "./skill-picker.tsx";

/** Settings saved by `configure`; name, avatar and repositories save on their own. */
const draftFrom = (snapshot: MasterSnapshot): MasterSettings => {
	const { master, coordinator } = snapshot;
	return {
		...master.settings,
		providerId: coordinator?.providerId ?? master.settings.providerId,
		model: coordinator?.model ?? master.settings.model,
		// Model guidance was a second free-text prompt; it now lives in the
		// instructions so there is one place to edit.
		instructions: [master.settings.instructions, master.settings.modelGuidance]
			.filter((text) => text.trim())
			.join("\n\n"),
		modelGuidance: "",
	};
};
const draftKey = (settings: MasterSettings) =>
	JSON.stringify({ ...settings, name: undefined, avatar: undefined });

type Section = "instructions" | "skills" | "models" | "limits";
const SECTIONS = ["instructions", "skills", "models", "limits"] as const;

/**
 * Full-page preferences for a Master: instructions, skills, task models and
 * limits. They are drafted together and saved once with `configure`, which
 * starts a fresh chat.
 */
export function MasterPreferences({
	snapshot,
	busy,
	execute,
	onClose,
}: {
	readonly snapshot: MasterSnapshot;
	readonly busy: boolean;
	readonly execute: (action: MasterAction) => Promise<void>;
	readonly onClose: () => void;
}) {
	const { message } = useMessages("projects");
	const master = snapshot.master;
	const [section, setSection] = useState<Section>("instructions");
	// The revision the draft was opened at, so a concurrent edit is detected.
	const [opened, setOpened] = useState(() => ({
		settings: draftFrom(snapshot),
		revision: master.revision,
	}));
	const draft = opened.settings;
	const dirty = draftKey(draft) !== draftKey(draftFrom(snapshot));
	const blankTask = (draft.modelProfiles ?? []).some(
		(profile) => !profile.task.trim(),
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const setSettings = (patch: Partial<MasterSettings>) =>
		setOpened((current) => ({
			...current,
			settings: { ...current.settings, ...patch },
		}));
	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			await execute({
				_tag: "configure",
				settings: {
					...draft,
					name: master.settings.name,
					avatar: master.settings.avatar,
				},
				repositories: master.repositories,
				expectedRevision: opened.revision,
			});
			onClose();
		} catch (cause) {
			setError(formatError(cause));
		} finally {
			setSaving(false);
		}
	};
	const label: Record<Section, string> = {
		instructions: message("projects:masters_instructions"),
		skills: message("projects:masters_skills"),
		models: message("projects:masters_work_models"),
		limits: message("projects:masters_limits"),
	};
	const count: Partial<Record<Section, number>> = {
		skills: draft.skills.length,
		models: draft.modelProfiles?.length ?? 0,
	};
	return (
		<div className="details-view-enter flex min-h-0 flex-1 flex-col">
			<div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 px-2">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={message("projects:masters_back")}
					onClick={onClose}
				>
					<ChevronLeft />
				</Button>
				<h2 className="text-[13px] font-medium">
					{message("projects:masters_preferences")}
				</h2>
				<span
					role={error ? "alert" : undefined}
					className={cn(
						"ml-auto truncate px-2 text-[11px]",
						error ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{error ??
						(dirty ? message("projects:masters_save_restarts_chat") : "")}
				</span>
				{dirty ? (
					<Button
						variant="ghost"
						disabled={saving}
						onClick={() =>
							setOpened({
								settings: draftFrom(snapshot),
								revision: master.revision,
							})
						}
					>
						{message("projects:masters_cancel")}
					</Button>
				) : null}
				<Button
					loading={saving}
					disabled={saving || busy || !dirty || blankTask}
					onClick={() => void save()}
				>
					{message("projects:masters_save")}
				</Button>
			</div>
			<div className="flex min-h-0 flex-1">
				<nav
					aria-label={message("projects:masters_preferences")}
					className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border/50 p-1.5"
				>
					{SECTIONS.map((key) => (
						<button
							key={key}
							type="button"
							aria-current={section === key ? "page" : undefined}
							onClick={() => setSection(key)}
							className={cn(
								"flex h-7 items-center justify-between rounded-md px-2 text-left text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
								section === key
									? "bg-sidebar-accent text-sidebar-accent-foreground"
									: "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground",
							)}
						>
							{label[key]}
							{count[key] ? (
								<span className="tabular-nums text-[11px] text-muted-foreground">
									{count[key]}
								</span>
							) : null}
						</button>
					))}
				</nav>
				{section === "instructions" ? (
					<Textarea
						unstyled
						autoFocus
						aria-label={label.instructions}
						value={draft.instructions}
						onChange={(event) =>
							setSettings({ instructions: event.target.value })
						}
						placeholder={message("projects:masters_instructions_placeholder")}
						className="flex min-h-0 flex-1 overflow-y-auto [&_textarea]:min-h-full [&_textarea]:resize-none [&_textarea]:px-6 [&_textarea]:py-5 [&_textarea]:font-mono [&_textarea]:text-[13px] [&_textarea]:leading-6"
					/>
				) : (
					<div className="min-h-0 flex-1 overflow-y-auto">
						<div className="mx-auto w-full max-w-2xl px-6 py-5">
							{section === "skills" ? (
								<MasterSkillPicker
									environmentId={master.homeEnvironmentId}
									value={draft.skills}
									disabled={busy}
									onChange={(skills) => setSettings({ skills })}
								/>
							) : section === "models" ? (
								<WorkModels
									environmentId={master.homeEnvironmentId}
									settings={draft}
									onChange={setSettings}
								/>
							) : (
								<>
									<LimitRow
										title={message("projects:masters_parallel_slaves")}
										help={message("projects:masters_parallel_slaves_help")}
										{...LIMITS.maxConcurrent}
										value={draft.maxConcurrent}
										onChange={(maxConcurrent) => setSettings({ maxConcurrent })}
									/>
									<LimitRow
										title={message("projects:masters_auto_follow_ups")}
										help={message("projects:masters_auto_follow_ups_help")}
										{...LIMITS.maxFollowUps}
										value={draft.maxFollowUps}
										onChange={(maxFollowUps) => setSettings({ maxFollowUps })}
									/>
								</>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function LimitRow({
	title,
	help,
	min,
	max,
	value,
	onChange,
}: {
	readonly title: string;
	readonly help: string;
	readonly min: number;
	readonly max: number;
	readonly value: number;
	readonly onChange: (value: number) => void;
}) {
	return (
		<div className="flex items-center gap-3 px-2 py-1.5">
			<div className="min-w-0 flex-1">
				<p className="text-[12px] text-foreground">{title}</p>
				<p className="text-[11px] leading-4 text-muted-foreground">{help}</p>
			</div>
			<Input
				nativeInput
				className="h-7 w-14 text-center tabular-nums"
				aria-label={title}
				type="number"
				min={min}
				max={max}
				value={value}
				// Empty or out-of-range input snaps to the nearest allowed value.
				onChange={(event) => {
					const next = Math.round(Number(event.target.value));
					if (event.target.value !== "" && Number.isFinite(next))
						onChange(Math.min(max, Math.max(min, next)));
				}}
			/>
		</div>
	);
}

/** "For <kind of work>, use <model>" rules the Master applies when delegating. */
function WorkModels({
	environmentId,
	settings,
	onChange,
}: {
	readonly environmentId: string;
	readonly settings: MasterSettings;
	readonly onChange: (patch: Partial<MasterSettings>) => void;
}) {
	const { message } = useMessages("projects");
	const profiles = settings.modelProfiles ?? [];
	const setProfiles = (modelProfiles: typeof profiles) =>
		onChange({ modelProfiles });
	return (
		<div className="flex flex-col gap-1.5">
			{profiles.map((profile) => (
				<div
					key={profile.id}
					className="flex flex-col gap-1 rounded-md bg-muted/30 p-1.5"
				>
					<div className="flex items-center gap-1">
						<Input
							nativeInput
							className="h-7 min-w-0 flex-1"
							maxLength={LIMITS.profileTaskLength}
							aria-label={message("projects:masters_work_kind")}
							placeholder={message("projects:masters_work_kind_placeholder")}
							value={profile.task}
							onChange={(event) =>
								setProfiles(
									profiles.map((item) =>
										item.id === profile.id
											? { ...item, task: event.target.value }
											: item,
									),
								)
							}
						/>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={message("projects:masters_remove_work_model")}
							onClick={() =>
								setProfiles(profiles.filter((item) => item.id !== profile.id))
							}
						>
							<HugeiconsIcon icon={Cancel01Icon} />
						</Button>
					</div>
					<ModelPicker
						mode="configuration"
						environmentId={EnvironmentId.make(environmentId)}
						providerId={profile.providerId}
						currentModel={profile.model}
						onSelect={(providerId, model) =>
							setProfiles(
								profiles.map((item) =>
									item.id === profile.id
										? { ...item, providerId, model }
										: item,
								),
							)
						}
						triggerClassName={cn(
							MODEL_PICKER_SETTINGS_TRIGGER,
							"w-full max-w-none",
						)}
					/>
				</div>
			))}
			<Button
				variant="ghost"
				size="sm"
				className="self-start"
				disabled={profiles.length >= LIMITS.modelProfiles}
				onClick={() =>
					setProfiles([
						...profiles,
						{
							id: crypto.randomUUID(),
							task: "",
							providerId: settings.providerId,
							model: settings.model,
						},
					])
				}
			>
				<HugeiconsIcon icon={Add01Icon} />
				{message("projects:masters_add_work_model")}
			</Button>
		</div>
	);
}
