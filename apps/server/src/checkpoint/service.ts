import type {
	SessionCheckpointError,
	SessionCheckpointSummary,
	SessionId,
} from "@zuse/contracts";
import { Context, type Effect } from "effect";
export class CheckpointService extends Context.Service<
	CheckpointService,
	{
		readonly list: (
			sessionId: SessionId,
		) => Effect.Effect<
			readonly SessionCheckpointSummary[],
			SessionCheckpointError
		>;
		readonly preview: (
			sessionId: SessionId,
			checkpointId: string,
		) => Effect.Effect<
			{ previewId: string; files: readonly string[]; expiresAt: number },
			SessionCheckpointError
		>;
		readonly restore: (
			sessionId: SessionId,
			previewId: string,
		) => Effect.Effect<void, SessionCheckpointError>;
		readonly retry: (
			sessionId: SessionId,
		) => Effect.Effect<void, SessionCheckpointError>;
	}
>()("zuse/checkpoint/CheckpointService") {}
