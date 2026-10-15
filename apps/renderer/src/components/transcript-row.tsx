import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { ComponentProps } from "react";

import type { ChatTimelineRow } from "../lib/chat-timeline-rows.ts";
import { DelegationGroup } from "./delegation-group.tsx";
import { MessageRow } from "./message-row.tsx";
import { ToolActivityTree } from "./tool-activity-tree.tsx";
import { TurnSummary } from "./turn-summary.tsx";

type RowProps = Pick<
	ComponentProps<typeof MessageRow>,
	| "sessionId"
	| "environmentId"
	| "readOnly"
	| "forkDestination"
	| "sourceProjectId"
>;

/**
 * A timeline row outside the live chat list — archived chats and subagent
 * transcripts — rendered with the main chat's components.
 */
export function TranscriptRow({
	row,
	chatRef,
	parentLive,
	assistantCommands,
	...rowProps
}: {
	readonly row: ChatTimelineRow;
	readonly chatRef: ChatRef | null;
	readonly parentLive: boolean;
	/** Nested transcripts have no replies of their own to copy or fork. */
	readonly assistantCommands: boolean;
} & RowProps) {
	switch (row.kind) {
		case "tool-activity":
			return (
				<ToolActivityTree
					{...rowProps}
					messages={row.messages}
					live={row.live}
				/>
			);
		case "message":
			return (
				<MessageRow
					{...rowProps}
					message={row.message}
					showAssistantCommands={assistantCommands && row.showAssistantCommands}
				/>
			);
		case "delegation":
			return (
				<DelegationGroup
					members={row.members}
					providerId={null}
					parentLive={parentLive}
					chatRef={chatRef}
					environmentId={rowProps.environmentId}
					readOnly={rowProps.readOnly}
				/>
			);
		case "turn-summary":
			return (
				<TurnSummary
					body={row.body}
					chatId={chatRef?.chatId}
					sessionId={rowProps.sessionId}
					environmentId={rowProps.environmentId}
					forkDestination={rowProps.forkDestination}
					sourceProjectId={rowProps.sourceProjectId}
					showAssistantCommands={assistantCommands && row.showAssistantCommands}
				/>
			);
		case "working":
			return null;
	}
}
