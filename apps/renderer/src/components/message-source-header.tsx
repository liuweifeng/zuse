import "@zuse/i18n/english/chat";
import type { MessageSource } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useState } from "react";
import { SlackIcon } from "./icons/slack-icon.tsx";
import {
	PreviewCard,
	PreviewCardPopup,
	PreviewCardTrigger,
} from "./ui/preview-card.tsx";

/** "Ada Lovelace in #eng-alerts" attribution for a message sent from Slack. */
export function MessageSourceHeader({
	source,
	text,
}: {
	source: MessageSource;
	text: string;
}) {
	const [open, setOpen] = useState(false);
	const { message: uiMessage } = useUiMessages(["chat"]);
	const label =
		source.author !== undefined && source.channel !== undefined
			? uiMessage("chat:message_row_slack_author_in_channel", {
					author: source.author,
					channel: source.channel,
				})
			: source.author !== undefined
				? uiMessage("chat:message_row_slack_author", { value: source.author })
				: source.channel !== undefined
					? uiMessage("chat:message_row_slack_channel", {
							value: source.channel,
						})
					: uiMessage("chat:message_row_from_slack");
	return (
		<div className="mb-1.5 max-w-full">
			<PreviewCard open={open} onOpenChange={setOpen}>
				<PreviewCardTrigger
					delay={200}
					render={
						<button
							type="button"
							onClick={() => setOpen((value) => !value)}
							className="flex h-7 max-w-full items-center gap-1.5 rounded-sm text-[11px] text-user-bubble-foreground/65 outline-none hover:text-user-bubble-foreground focus-visible:ring-2 focus-visible:ring-ring"
						/>
					}
				>
					<SlackIcon className="size-3 shrink-0" />
					<span className="truncate">{label}</span>
				</PreviewCardTrigger>
				<PreviewCardPopup
					side="top"
					align="end"
					sideOffset={6}
					className="w-[min(26rem,calc(100vw-2rem))] p-3"
				>
					<div className="max-h-80 min-w-0 flex-1 overflow-y-auto overscroll-contain text-xs">
						<div className="mb-2 flex items-center gap-1.5 font-medium">
							<SlackIcon className="size-3 shrink-0" />
							<span>{label}</span>
						</div>
						<div className="whitespace-pre-wrap break-words text-left leading-relaxed [overflow-wrap:anywhere]">
							{text}
						</div>
					</div>
				</PreviewCardPopup>
			</PreviewCard>
		</div>
	);
}
