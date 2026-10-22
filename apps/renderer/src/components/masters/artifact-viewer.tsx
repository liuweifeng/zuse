import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	MasterAction,
	MasterArtifact,
	MasterSnapshot,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Cancel01Icon } from "@zuse/icons/solid-rounded";
import { lazy, Suspense } from "react";
import { Button } from "../ui/button.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
import { ShimmerText } from "../ui/shimmer-text.tsx";
import { MasterScreen } from "./screen.tsx";

const MarkdownBody = lazy(() =>
	import("../markdown-body.tsx").then((module) => ({
		default: module.MarkdownBody,
	})),
);

export type LoadedArtifact = { metadata: MasterArtifact; content: string };

/** Right-hand panel that reads, pins and regenerates one Master artifact. */
export function MasterArtifactViewer({
	snapshot,
	selectedId,
	artifact,
	busy,
	select,
	execute,
	perform,
	openChat,
	onClose,
}: {
	readonly snapshot: MasterSnapshot;
	readonly selectedId: string;
	readonly artifact: LoadedArtifact | null;
	readonly busy: boolean;
	readonly select: (artifact: MasterArtifact) => void;
	readonly execute: (action: MasterAction) => Promise<void>;
	readonly perform: (action: MasterAction) => void;
	readonly openChat: (environmentId: string, chatId: string) => void;
	readonly onClose: () => void;
}) {
	const { message } = useMessages("projects");
	const artifacts = snapshot.master.artifacts;
	const current = artifacts.find((item) => item.id === selectedId);
	const loaded = artifact?.metadata.id === selectedId ? artifact : null;
	return (
		<aside
			aria-label={message("projects:masters_artifacts")}
			className="flex w-[min(40rem,55%)] min-w-80 shrink-0 flex-col border-l border-border/50"
		>
			<div className="flex h-10 shrink-0 items-center gap-1 px-2">
				<Select
					value={selectedId}
					onValueChange={(value) => {
						const next = artifacts.find((item) => item.id === value);
						if (next) select(next);
					}}
				>
					<SelectTrigger
						className="h-7 min-w-0 flex-1 border-transparent bg-transparent shadow-none hover:bg-muted/55"
						aria-label={message("projects:masters_artifacts")}
					>
						<SelectValue>
							{current ? `${current.title} · v${current.version}` : selectedId}
						</SelectValue>
					</SelectTrigger>
					<SelectPopup>
						{artifacts.map((item) => (
							<SelectItem key={item.id} value={item.id}>
								{item.title} · v{item.version}
							</SelectItem>
						))}
					</SelectPopup>
				</Select>
				{current && loaded ? (
					<>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() =>
								perform({
									_tag: "publish",
									id: current.id,
									title: current.title,
									kind: current.kind,
									content: loaded.content,
									expectedVersion: loaded.metadata.version,
									pinned: !current.pinned,
								})
							}
						>
							{current.pinned
								? message("projects:masters_unpin")
								: message("projects:masters_pin")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() =>
								perform({
									_tag: "instruct",
									text: `Regenerate the artifact ${JSON.stringify(current.title)} (${current.id}). Read its current version and publish a new version through master_action.`,
								})
							}
						>
							{message("projects:masters_regenerate")}
						</Button>
					</>
				) : null}
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={message("projects:masters_close")}
					onClick={onClose}
				>
					<HugeiconsIcon icon={Cancel01Icon} />
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
				{!loaded ? (
					<ShimmerText className="py-2 text-xs">
						{message("projects:masters_loading")}
					</ShimmerText>
				) : loaded.metadata.kind === "screen" ? (
					<MasterScreen
						key={`${loaded.metadata.id}:${loaded.metadata.version}`}
						content={loaded.content}
						snapshot={snapshot}
						execute={execute}
						openChat={openChat}
					/>
				) : (
					<Suspense fallback={null}>
						<MarkdownBody>{loaded.content}</MarkdownBody>
					</Suspense>
				)}
			</div>
		</aside>
	);
}
