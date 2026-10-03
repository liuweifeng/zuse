import { Context } from "effect";
import type { CheckpointService } from "../../checkpoint/service.ts";
import type {
	ChatServiceShape,
	MessageServiceShape,
	QueueServiceShape,
	QueueTransactionServiceShape,
	SessionServiceShape,
	TranscriptServiceShape,
} from "../services/conversation-services.ts";

/** Internal runtime shared by the five public conversation service layers. */
export interface ConversationRuntimeShape {
	readonly checkpoints: CheckpointService["Service"];
	readonly session: SessionServiceShape;
	readonly chat: ChatServiceShape;
	readonly transcript: TranscriptServiceShape;
	readonly message: MessageServiceShape;
	readonly queue: QueueServiceShape;
	readonly queueTransaction: QueueTransactionServiceShape;
}

export class ConversationRuntime extends Context.Service<
	ConversationRuntime,
	ConversationRuntimeShape
>()("zuse/ConversationRuntime") {}
