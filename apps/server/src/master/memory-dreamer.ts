import {
	AgentSessionId,
	AgentTurnId,
	type FolderId,
	MasterError,
	type ProviderId,
} from "@zuse/contracts";
import { Context, Effect, Layer, Stream } from "effect";
import { ProviderService } from "../provider/services/provider-service.ts";
import { DREAM_INSTRUCTIONS } from "./memory.ts";
import { masterFailure } from "./store.ts";

export class MasterMemoryDreamer extends Context.Service<
	MasterMemoryDreamer,
	{
		generate: (input: {
			folderId: FolderId;
			cwd: string;
			providerId: ProviderId;
			model: string;
			prompt: string;
		}) => Effect.Effect<string, MasterError>;
	}
>()("zuse/MasterMemoryDreamer") {}

export const MasterMemoryDreamerLive = Layer.effect(
	MasterMemoryDreamer,
	Effect.gen(function* () {
		const provider = yield* ProviderService;
		return {
			generate: (input) =>
				Effect.gen(function* () {
					const sessionId = AgentSessionId.make(
						`memory-dream-${crypto.randomUUID()}`,
					);
					const turnId = AgentTurnId.make(
						`memory-dream-turn-${crypto.randomUUID()}`,
					);
					return yield* Effect.gen(function* () {
						yield* provider.start(
							{
								folderId: input.folderId,
								providerId: input.providerId,
								mode: "sdk",
								model: input.model,
								sessionId,
								initialTurnId: turnId,
								initialPrompt: input.prompt,
								workspaceInstructions: DREAM_INSTRUCTIONS,
								cwdOverride: input.cwd,
								outputOnly: true,
								enableSubagents: false,
							},
							null,
							() => "approval-required",
						);
						const text = new Map<string, string>();
						let completed = false;
						yield* provider.events(sessionId).pipe(
							Stream.filter(
								(envelope) =>
									envelope.scope === "turn" && envelope.turnId === turnId,
							),
							Stream.takeUntil(
								(envelope) =>
									envelope.event._tag === "Completed" ||
									envelope.event._tag === "Error" ||
									envelope.event._tag === "Interrupted",
							),
							Stream.runForEach((envelope) =>
								Effect.try({
									try: () => {
										const event = envelope.event;
										if (
											event._tag === "ToolUse" ||
											event._tag === "PermissionRequest"
										)
											throw new Error(
												"Memory provider attempted to use a disabled tool.",
											);
										if (event._tag === "AssistantMessage") {
											text.set(event.itemId, event.text);
											if (
												[...text.values()].reduce(
													(size, value) => size + value.length,
													0,
												) > 64_000
											)
												throw new Error("Memory output exceeded 64 KB.");
										} else if (event._tag === "Completed") {
											if (event.reason !== "ended")
												throw new Error(
													"Memory consolidation did not finish successfully.",
												);
											completed = true;
										} else if (
											event._tag === "Error" ||
											event._tag === "Interrupted"
										)
											throw new Error("Memory consolidation did not finish.");
									},
									catch: masterFailure,
								}),
							),
						);
						if (!completed)
							return yield* Effect.fail(
								new MasterError({
									reason:
										"Memory consolidation ended without a completed turn.",
								}),
							);
						return [...text.values()].join("\n");
					}).pipe(
						Effect.timeout("90 seconds"),
						Effect.ensuring(
							provider.close(sessionId).pipe(Effect.catch(() => Effect.void)),
						),
						Effect.mapError(masterFailure),
					);
				}),
		};
	}),
);
