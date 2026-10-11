import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { connectionWorkspaceActor } from "../lan-auth/services/connection-identity.ts";
import { MessageService } from "./services/conversation-services.ts";

export const SessionWaitHandlers = Layer.mergeAll(
	MemoizeRpcs.toLayerHandler("session.wait", (input) =>
		Effect.flatMap(MessageService, (service) => service.waitSession(input)),
	),
	MemoizeRpcs.toLayerHandler("session.sendAndWait", (input) =>
		Effect.gen(function* () {
			const service = yield* MessageService;
			const actor = yield* connectionWorkspaceActor;
			return yield* service.sendMessageAndWait(
				{
					commandId: input.commandId,
					sessionId: input.sessionId,
					text: input.input.text,
					attachments: input.input.attachments,
					fileRefs: input.input.fileRefs,
					skillRefs: input.input.skillRefs,
					annotations: input.input.annotations,
					actor,
				},
				input.wait,
			);
		}),
	),
);
