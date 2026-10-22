import "@zuse/i18n/english/projects";
import {
	EnvironmentId,
	type Master,
	type MasterAction,
	MasterMemoryPage,
	type ProviderId,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Schema } from "effect";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { formatError } from "../../lib/format-error.ts";
import { type MasterSelection, masterCommand } from "../../store/masters.ts";
import {
	MODEL_PICKER_SETTINGS_TRIGGER,
	ModelPicker,
} from "../model-picker.tsx";
import { Button } from "../ui/button.tsx";
import { Switch } from "../ui/switch.tsx";
import { Textarea } from "../ui/textarea.tsx";

/** Compact, on-demand memory controls inside the existing Details panel. */
export function MasterMemoryPanel({
	master,
	selection,
	busy,
	execute,
}: {
	master: Master;
	selection: MasterSelection;
	busy: boolean;
	execute: (action: MasterAction) => Promise<void>;
}) {
	const { message } = useMessages("projects");
	const automaticId = useId();
	const memory = master.memory;
	// Tidying settings come from the server; only a model the user picked but
	// that can't tidy (and so wasn't saved) is kept locally.
	const [unsaved, setUnsaved] = useState<{
		providerId: ProviderId;
		model: string;
	} | null>(null);
	const providerId =
		unsaved?.providerId ??
		memory?.config?.providerId ??
		master.settings.providerId;
	const model =
		unsaved?.model ?? memory?.config?.model ?? master.settings.model;
	const automatic = memory?.config?.automatic ?? false;
	const [search, setSearch] = useState("");
	const [loaded, setLoaded] = useState<MasterMemoryPage | null>(null);
	const [content, setContent] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const request = useRef(0);
	useEffect(
		() => () => {
			request.current++;
		},
		[],
	);
	const perform = async (action: MasterAction) => {
		setError(null);
		try {
			await execute(action);
			return true;
		} catch (cause) {
			setError(formatError(cause));
			return false;
		}
	};
	const load = async (path: string, version: number) => {
		const id = ++request.current;
		setLoading(true);
		setError(null);
		try {
			const response = await masterCommand<
				{ masterId: string; artifactId: string; version: number },
				{ content: string }
			>(selection.environmentId, "masters.artifact", {
				masterId: master.id,
				artifactId: `memory/${path}`,
				version,
			});
			const page = Schema.decodeUnknownSync(
				Schema.fromJsonString(MasterMemoryPage),
			)(response.content);
			if (id === request.current) {
				setLoaded(page);
				setContent(page.content);
			}
		} catch (cause) {
			if (id === request.current) setError(formatError(cause));
		} finally {
			if (id === request.current) setLoading(false);
		}
	};
	const topics = memory?.topics ?? [];
	const current = topics.find((topic) => topic.path === loaded?.topic.path);
	const supported = providerId === "claude" || providerId === "zuse";
	const pending =
		memory?.run?.state === "running" || memory?.run?.state === "queued";
	const needle = search.trim().toLocaleLowerCase();
	// Tidying settings save as soon as they change; there is no separate Save.
	const saveConfig = (next: {
		automatic: boolean;
		providerId: ProviderId;
		model: string;
	}) => {
		const canTidy = next.providerId === "claude" || next.providerId === "zuse";
		setUnsaved(canTidy ? null : next);
		if (canTidy) void perform({ _tag: "memoryConfig", config: next });
	};
	const visible = topics.filter((topic) =>
		`${topic.path} ${topic.title} ${topic.summary}`
			.toLocaleLowerCase()
			.includes(needle),
	);
	return (
		<div className="flex flex-col gap-3 text-[12px]">
			{topics.length > 0 ? (
				<input
					aria-label={message("projects:masters_memory_search")}
					placeholder={message("projects:masters_memory_search")}
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					className="h-7 w-full rounded-md bg-muted/55 px-2.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/24"
				/>
			) : null}
			<div className="flex flex-col gap-0.5">
				{visible.map((topic) => (
					<button
						key={topic.path}
						type="button"
						aria-current={
							loaded?.topic.path === topic.path ? "true" : undefined
						}
						className="w-full rounded-md px-2 py-1.5 text-left hover:bg-muted/45 aria-[current]:bg-muted/55"
						onClick={() => void load(topic.path, topic.version)}
					>
						<span className="block truncate text-foreground">
							{topic.title}
							{topic.archived ? (
								<span className="text-muted-foreground">
									{` · ${message("projects:masters_memory_archived")}`}
								</span>
							) : null}
						</span>
						<span className="block truncate text-[11px] text-muted-foreground">
							{topic.summary}
						</span>
					</button>
				))}
				{!topics.length && (
					<p className="px-2 py-1 text-[11px] leading-4 text-muted-foreground">
						{message("projects:masters_memory_empty")}
					</p>
				)}
			</div>
			{loading && (
				<p role="status" className="px-2 text-muted-foreground">
					{message("projects:masters_loading")}
				</p>
			)}
			{loaded && current && (
				<div className="flex flex-col gap-2 rounded-lg bg-muted/25 p-2">
					<div className="flex h-7 items-center justify-between gap-2 px-1">
						<span className="truncate font-medium">{loaded.topic.title}</span>
						<span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground">
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={message("projects:masters_memory_previous")}
								disabled={loading || loaded.topic.version <= 1}
								onClick={() =>
									void load(current.path, loaded.topic.version - 1)
								}
							>
								<ChevronLeft />
							</Button>
							<span className="tabular-nums">v{loaded.topic.version}</span>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={message("projects:masters_memory_next")}
								disabled={loading || loaded.topic.version >= current.version}
								onClick={() =>
									void load(current.path, loaded.topic.version + 1)
								}
							>
								<ChevronRight />
							</Button>
						</span>
					</div>
					<Textarea
						unstyled
						className="block w-full rounded-md bg-background/60 text-xs [&_textarea]:min-h-32 [&_textarea]:resize-none"
						aria-label={message("projects:masters_memory_content")}
						value={content}
						readOnly={loaded.topic.version !== current.version}
						onChange={(event) => setContent(event.target.value)}
					/>
					<div className="flex items-center gap-1">
						<Button
							size="sm"
							disabled={
								busy ||
								loading ||
								(content === loaded.content &&
									loaded.topic.version === current.version)
							}
							onClick={async () => {
								const saved = await perform(
									loaded.topic.version < current.version
										? {
												_tag: "restoreMemory",
												path: current.path,
												version: loaded.topic.version,
												expectedVersion: current.version,
											}
										: {
												_tag: "remember",
												path: current.path,
												title: loaded.topic.title,
												summary: loaded.topic.summary,
												content,
												sources: loaded.topic.sources,
												expectedVersion: current.version,
												archived: loaded.topic.archived,
											},
								);
								if (saved) await load(current.path, current.version + 1);
							}}
						>
							{loaded.topic.version < current.version
								? message("projects:masters_memory_restore")
								: message("projects:masters_save")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={
								busy || loading || loaded.topic.version !== current.version
							}
							onClick={async () => {
								const saved = await perform({
									_tag: "remember",
									path: current.path,
									title: current.title,
									summary: current.summary,
									content: loaded.content,
									sources: current.sources,
									expectedVersion: current.version,
									archived: !current.archived,
								});
								if (saved) await load(current.path, current.version + 1);
							}}
						>
							{current.archived
								? message("projects:masters_memory_restore")
								: message("projects:masters_memory_archive")}
						</Button>
					</div>
					{loaded.evidence.length ? (
						<details className="px-1 text-muted-foreground">
							<summary className="cursor-pointer text-[11px]">
								{message("projects:masters_memory_sources")} ·{" "}
								{loaded.evidence.length}
							</summary>
							{loaded.evidence.map((entry) => (
								<div
									key={`${entry.id}:${entry.updatedAt}`}
									className="py-1 text-[11px]"
								>
									<p className="text-foreground/80">
										{entry.author} ·{" "}
										{new Date(entry.updatedAt).toLocaleDateString()}
									</p>
									<p className="whitespace-pre-wrap break-words">
										{entry.text}
									</p>
								</div>
							))}
						</details>
					) : null}
				</div>
			)}
			<section className="mt-2 flex flex-col gap-2 border-t border-border/50 px-2 pt-3">
				<div className="flex items-center justify-between gap-2">
					<span className="font-medium text-foreground">
						{message("projects:masters_memory_tidy")}
					</span>
					{pending ? (
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() => void perform({ _tag: "cancelDream" })}
						>
							{message("projects:masters_memory_cancel")}
						</Button>
					) : (
						<Button
							variant="ghost"
							size="sm"
							disabled={
								busy ||
								!supported ||
								!memory?.config ||
								master.status !== "active"
							}
							onClick={() => void perform({ _tag: "dream" })}
						>
							{message("projects:masters_memory_consolidate")}
						</Button>
					)}
				</div>
				{memory?.run && (
					<p className="text-[11px] text-muted-foreground" role="status">
						{message(`projects:masters_memory_run_${memory.run.state}`)}
						{memory.run.error ? ` · ${memory.run.error}` : ""}
					</p>
				)}
				<label
					htmlFor={automaticId}
					className="flex h-7 items-center justify-between gap-2"
				>
					{message("projects:masters_memory_automatic")}
					<Switch
						id={automaticId}
						checked={automatic}
						disabled={busy || !supported}
						onCheckedChange={(checked) =>
							saveConfig({ automatic: checked, providerId, model })
						}
					/>
				</label>
				<div className="flex items-center justify-between gap-2">
					<span className="shrink-0 text-muted-foreground">
						{message("projects:masters_memory_tidy_model")}
					</span>
					<ModelPicker
						mode="configuration"
						environmentId={EnvironmentId.make(selection.environmentId)}
						providerId={providerId}
						currentModel={model}
						onSelect={(provider, next) =>
							saveConfig({ automatic, providerId: provider, model: next })
						}
						triggerClassName={`${MODEL_PICKER_SETTINGS_TRIGGER} w-auto max-w-44 border-transparent bg-transparent hover:bg-muted/55`}
					/>
				</div>
				{!supported && (
					<p className="text-[11px] text-muted-foreground">
						{message("projects:masters_memory_supported")}
					</p>
				)}
			</section>
			{error && (
				<p role="alert" className="px-2 text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
