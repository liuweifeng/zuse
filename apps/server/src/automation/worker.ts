import { Effect, Layer, Schedule } from "effect";
import { QueueTransactionService } from "../conversation/services/conversation-services.ts";
import { AutomationService } from "./service.ts";

export const AutomationWorkerLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const automation = yield* AutomationService;
		const transaction = yield* QueueTransactionService;
		yield* automation
			.sweep((sessionId, commandId, text, committed, actor) =>
				transaction.addQueuedMessageTransactionally(
					commandId,
					sessionId,
					{
						text,
						attachments: [],
						fileRefs: [],
						skillRefs: [],
						annotations: [],
					},
					commandId,
					true,
					() => committed,
					actor,
				),
			)
			.pipe(
				Effect.catchCause(() =>
					Effect.logWarning("Scheduled task delivery will retry."),
				),
				Effect.repeat(Schedule.spaced("1 second")),
				Effect.forkScoped,
			);
	}),
);
