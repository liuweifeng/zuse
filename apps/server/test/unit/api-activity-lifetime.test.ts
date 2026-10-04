import { EnvironmentId, SessionId } from "@zuse/contracts";
import { Deferred, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, it, vi } from "vitest";
import {
	ApiActivityPublisher,
	ApiActivityPublisherLive,
} from "../../src/api/activity-publisher.ts";
import { LanAuthService } from "../../src/lan-auth/services/lan-auth-service.ts";

const linkedLayer = ApiActivityPublisherLive.pipe(
	Layer.provide(
		Layer.succeed(LanAuthService, {
			getApiConfig: (): ReturnType<LanAuthService["Service"]["getApiConfig"]> =>
				Effect.succeed({
					apiUrl: "https://example.invalid",
					environmentId: EnvironmentId.make("test"),
					apiIssuer: "test",
					label: undefined,
					connectorToken: undefined,
					tunnelHostname: undefined,
					mintPublicKey: undefined,
					environmentCredential: "test",
				}),
		} as LanAuthService["Service"]),
	),
);

afterEach(() => vi.unstubAllGlobals());

it("aborts a stalled notification and delivers the next activity in order", async () => {
	const kinds: string[] = [];
	let firstSignal: AbortSignal | undefined;
	await Effect.runPromise(
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const completed = yield* Deferred.make<void>();
			vi.stubGlobal(
				"fetch",
				vi.fn((_url: string, init: RequestInit) => {
					kinds.push(JSON.parse(String(init.body)).kind);
					if (kinds.length > 1) {
						Effect.runSync(Deferred.succeed(completed, undefined));
						return Promise.resolve(Response.json({}));
					}
					firstSignal = init.signal ?? undefined;
					Effect.runSync(Deferred.succeed(started, undefined));
					return new Promise<Response>((_resolve, reject) =>
						firstSignal?.addEventListener("abort", () =>
							reject(firstSignal?.reason),
						),
					);
				}),
			);
			yield* Effect.gen(function* () {
				const activity = yield* ApiActivityPublisher;
				yield* activity.publish({
					sessionId: SessionId.make("session"),
					kind: "running",
				});
				yield* activity.publish({
					sessionId: SessionId.make("session"),
					kind: "completed",
				});
				yield* Deferred.await(started);
				yield* TestClock.adjust("5 seconds");
				yield* Deferred.await(completed);
				expect(firstSignal?.aborted).toBe(true);
				expect(kinds).toEqual(["running", "completed"]);
			}).pipe(Effect.provide(linkedLayer));
		}).pipe(Effect.provide(TestClock.layer())),
	);
});

it("keeps the backlog bounded and aborts delivery when the service closes", async () => {
	let requestSignal: AbortSignal | undefined;
	const delivered: string[] = [];
	await Effect.runPromise(
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			vi.stubGlobal(
				"fetch",
				vi.fn((_url: string, init: RequestInit) => {
					delivered.push(JSON.parse(String(init.body)).sessionId);
					requestSignal = init.signal ?? undefined;
					Effect.runSync(Deferred.succeed(started, undefined));
					return new Promise<Response>((_resolve, reject) =>
						requestSignal?.addEventListener("abort", () =>
							reject(requestSignal?.reason),
						),
					);
				}),
			);
			yield* Effect.gen(function* () {
				const activity = yield* ApiActivityPublisher;
				yield* activity.publish({
					sessionId: SessionId.make("first"),
					kind: "running",
				});
				yield* Deferred.await(started);
				for (let i = 0; i < 150; i++)
					yield* activity.publish({
						sessionId: SessionId.make(`queued-${i}`),
						kind: "running",
					});
				yield* TestClock.adjust("5 seconds");
				expect(delivered).toEqual(["first", "queued-50"]);
			}).pipe(Effect.provide(linkedLayer));
			expect(requestSignal?.aborted).toBe(true);
		}).pipe(Effect.provide(TestClock.layer())),
	);
});
