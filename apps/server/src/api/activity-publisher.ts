import { ApiPaths, type EnvironmentId, type SessionId } from "@zuse/contracts";
import { Context, Data, Effect, Layer, Queue } from "effect";

import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";

export type ApiActivityKind =
	| "approval-needed"
	| "question-needed"
	| "completed"
	| "error"
	| "running";

export class ApiActivityPublishError extends Data.TaggedError(
	"ApiActivityPublishError",
)<{
	readonly reason: string;
}> {}

export interface ApiActivityPublisherApi {
	/** Enqueue best-effort account activity without waiting for network delivery. */
	readonly publish: (input: {
		readonly sessionId: SessionId;
		readonly kind: ApiActivityKind;
	}) => Effect.Effect<void, ApiActivityPublishError>;
}

export class ApiActivityPublisher extends Context.Service<
	ApiActivityPublisher,
	ApiActivityPublisherApi
>()("zuse/ApiActivityPublisher") {}

const fail = (cause: unknown) =>
	new ApiActivityPublishError({
		reason: cause instanceof Error ? cause.message : String(cause),
	});

export const ApiActivityPublisherLive: Layer.Layer<
	ApiActivityPublisher,
	never,
	LanAuthService
> = Layer.effect(
	ApiActivityPublisher,
	Effect.gen(function* () {
		const lanAuth = yield* LanAuthService;

		const pending =
			yield* Queue.sliding<Parameters<ApiActivityPublisherApi["publish"]>[0]>(
				100,
			);
		const publish = (
			input: Parameters<ApiActivityPublisherApi["publish"]>[0],
		) =>
			Effect.gen(function* () {
				const config = yield* lanAuth
					.getApiConfig()
					.pipe(Effect.mapError((error) => fail(error.reason)));
				if (config === null) return;

				yield* Effect.tryPromise({
					try: async (signal) => {
						const response = await fetch(
							`${config.apiUrl}${ApiPaths.agentActivity(
								config.environmentId as EnvironmentId,
							)}`,
							{
								method: "POST",
								signal,
								headers: {
									authorization: `Bearer ${config.environmentCredential}`,
									"content-type": "application/json",
								},
								body: JSON.stringify({
									sessionId: input.sessionId,
									kind: input.kind,
									...(config.label === undefined
										? {}
										: { title: config.label }),
								}),
							},
						);
						await response.body?.cancel();
						if (!response.ok) {
							throw new Error(`api_activity_${response.status}`);
						}
					},
					catch: fail,
				});
			});
		// Account activity is best-effort. Its network latency must never hold up
		// provider ingestion, lease renewal, or durable turn completion.
		yield* Effect.forkScoped(
			Queue.take(pending).pipe(
				Effect.flatMap((input) =>
					publish(input).pipe(
						Effect.timeout("5 seconds"),
						Effect.catch((error) =>
							Effect.logDebug("api activity publish failed", error),
						),
					),
				),
				Effect.forever,
			),
		);
		return ApiActivityPublisher.of({
			publish: (input) => Queue.offer(pending, input).pipe(Effect.asVoid),
		});
	}),
);
