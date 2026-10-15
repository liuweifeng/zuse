import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type {
	AgentItemId,
	EnvironmentId,
	Message,
	SessionId,
} from "@zuse/contracts";
import { useMemo } from "react";

import { deriveSubagentTimelineRows } from "../lib/subagent-transcript.ts";
import { TranscriptRow } from "./transcript-row.tsx";

/** A subagent's run, grouped and collapsed by the main chat's turn rules. */
export function SubagentTranscript({
	parent,
	parentItemId,
	messages,
	summaryText,
	live,
	chatRef,
	sessionId,
	environmentId,
	readOnly = false,
}: {
	readonly parent: Message;
	readonly parentItemId: AgentItemId;
	readonly messages: ReadonlyArray<Message>;
	readonly summaryText: string | null;
	readonly live: boolean;
	readonly chatRef: ChatRef | null;
	readonly sessionId?: SessionId;
	readonly environmentId: EnvironmentId | undefined;
	readonly readOnly?: boolean;
}) {
	const rows = useMemo(
		() =>
			deriveSubagentTimelineRows({
				parent,
				parentItemId,
				children: messages,
				summaryText,
				live,
			}),
		[parent, parentItemId, messages, summaryText, live],
	);
	return rows.map((row) => (
		<TranscriptRow
			key={row.id}
			row={row}
			chatRef={chatRef}
			parentLive={live}
			assistantCommands={false}
			sessionId={sessionId}
			environmentId={environmentId}
			readOnly={readOnly}
		/>
	));
}
