import {
	ChatId,
	CommandId,
	FolderId,
	MessagesSendRpc,
	SessionId,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { RpcGroup, RpcTest } from "effect/unstable/rpc";
import { expect, it, vi } from "vitest";
import { MessageService } from "../../src/conversation/services/conversation-services.ts";
import {
	ConnectionIdentity,
	type CredentialIdentity,
} from "../../src/lan-auth/services/connection-identity.ts";
import { MessagesSend } from "../../src/provider/handlers.ts";

it.each([
	true,
	false,
])("uses the server-attested prompt author (organization=%s)", async (organization) => {
	const sendMessage = vi.fn<MessageService["Service"]["sendMessage"]>(
		() => Effect.void,
	);
	const identity: CredentialIdentity | { readonly kind: "local" } = organization
		? {
				kind: "workspace",
				subject: "verified-author",
				membershipId: "verified-membership",
				workspaceId: "workspace",
				chatId: ChatId.make("chat"),
				projectId: FolderId.make("project"),
				expiresAt: Number.MAX_SAFE_INTEGER,
				authorize: Effect.succeed("edit"),
			}
		: { kind: "local" };
	const services = Layer.mergeAll(
		Layer.succeed(ConnectionIdentity, identity),
		Layer.succeed(MessageService, {
			sendMessage,
			waitSession: () => Effect.die("not expected"),
			sendMessageAndWait: () => Effect.die("not expected"),
			listMessages: () => Effect.succeed([]),
			sendMessageWithInput: () => Effect.succeed({ accepted: true }),
			interruptSession: () => Effect.die("not expected"),
		}),
	);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(
					RpcGroup.make(MessagesSendRpc),
					{ flatten: true },
				);
				const payload = {
					commandId: CommandId.make("prompt-author"),
					sessionId: SessionId.make("session"),
					text: "hello",
					actor: {
						subject: "forged-author",
						membershipId: "forged-membership",
					},
				};
				yield* client("messages.send", payload);
			}),
		).pipe(Effect.provide(MessagesSend.pipe(Layer.provideMerge(services)))),
	);
	expect(sendMessage).toHaveBeenCalledTimes(1);
	expect(sendMessage.mock.calls[0]?.[11]).toEqual(
		organization
			? { subject: "verified-author", membershipId: "verified-membership" }
			: undefined,
	);
});
