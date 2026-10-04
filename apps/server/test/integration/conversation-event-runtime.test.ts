import {
	AgentItemId,
	AgentTurnId,
	AttemptId,
	EnvironmentId,
	type ProviderEventEnvelope,
	SessionId,
} from "@zuse/contracts";
import {
	AttemptOwnershipConflict,
	ProviderSessionOwnershipConflict,
} from "@zuse/domain/engine/dispatch";
import { Deferred, Effect, Exit, Layer, Ref, Stream } from "effect";
import { describe, expect, test, vi } from "vitest";
import {
	ApiActivityPublisher,
	ApiActivityPublisherLive,
} from "../../src/api/activity-publisher.ts";
import { makeConversationEventRuntime } from "../../src/conversation/core/conversation-event-runtime.ts";
import { LanAuthService } from "../../src/lan-auth/services/lan-auth-service.ts";
import {
	bindProviderEventDelivery,
	type ProviderEventDelivery,
} from "../../src/provider/provider-event-delivery.ts";

describe("ConversationEventRuntime", () => {
	const options = (
		scope: import("effect").Scope.Scope,
		events: () => Stream.Stream<ProviderEventEnvelope | ProviderEventDelivery>,
		settleTurn: (
			sessionId: SessionId,
			turnId: AgentTurnId,
			outcome: "completed" | "interrupted" | "error",
		) => Effect.Effect<void> = () => Effect.void,
	) => ({
		scope,
		events: () =>
			events().pipe(
				Stream.map((envelope) => ({
					providerSessionId: "test-residency",
					...envelope,
				})),
			),
		ownsAttempt: () => Effect.succeed(true),
		ownsProviderSession: () => Effect.succeed(true),
		providerId: () => Effect.succeed("claude" as const),
		setStatus: () => Effect.void,
		beginProviderTurn: (_sessionId: SessionId, turnId: AgentTurnId) =>
			Effect.succeed(turnId),
		settleTurn: (...args: Parameters<typeof settleTurn>) =>
			settleTurn(...args).pipe(Effect.as(true)),
		bindProviderThread: () => Effect.void,
		bindAttemptProviderTurn: () => Effect.void,
		setPermissionMode: () => Effect.void,
		publishGoal: () => Effect.void,
		publishApiActivity: () => Effect.void,
		reconcileQuestionResolution: () => Effect.succeed(false),
		ignoreError: () => false,
		isDuplicateToolUse: () => Effect.succeed(false),
		persist: () => Effect.void,
	});

	test("a stalled account activity request does not stall provider completion", async () => {
		let requestSignal: AbortSignal | undefined;
		const started = Deferred.makeUnsafe<void>();
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init: RequestInit) => {
				requestSignal = init.signal ?? undefined;
				Effect.runSync(Deferred.succeed(started, undefined));
				return new Promise<Response>((_resolve, reject) => {
					requestSignal?.addEventListener("abort", () =>
						reject(requestSignal?.reason),
					);
				});
			}),
		);
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const activity = yield* ApiActivityPublisher;
						const settled = yield* Deferred.make<void>();
						const runtime = yield* makeConversationEventRuntime({
							...options(
								yield* Effect.scope,
								() =>
									Stream.fromIterable([
										{
											scope: "turn",
											turnId: AgentTurnId.make("turn-1"),
											event: { _tag: "Status", status: "running" },
										},
										{
											scope: "turn",
											turnId: AgentTurnId.make("turn-1"),
											event: { _tag: "Completed", reason: "ended" },
										},
									]),
								() => Deferred.succeed(settled, undefined).pipe(Effect.asVoid),
							),
							publishApiActivity: (sessionId, kind) =>
								activity.publish({ sessionId, kind }).pipe(Effect.orDie),
						});
						yield* runtime.start(SessionId.make("session-1"));
						yield* Deferred.await(started);
						yield* Deferred.await(settled).pipe(Effect.timeout("250 millis"));
					}),
				).pipe(
					Effect.provide(
						ApiActivityPublisherLive.pipe(
							Layer.provide(
								Layer.succeed(LanAuthService, {
									getApiConfig: (): ReturnType<
										LanAuthService["Service"]["getApiConfig"]
									> =>
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
						),
					),
				),
			);
			expect(requestSignal?.aborted).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test("rejected ingestion ownership interrupts startup before delivery can continue", async () => {
		let continued = false;
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* makeConversationEventRuntime({
						...options(yield* Effect.scope, () => Stream.never),
						acquireIngestionLease: () => Effect.succeed(null),
					});
					return yield* runtime
						.start(SessionId.make("session-1"), {
							turnId: "turn-1",
							attemptId: "attempt-1",
							providerSessionId: "test-residency",
						})
						.pipe(
							Effect.andThen(
								Effect.sync(() => {
									continued = true;
								}),
							),
							Effect.exit,
						);
				}),
			),
		);
		expect(Exit.isFailure(result)).toBe(true);
		expect(continued).toBe(false);
	});

	test("releases an arriving cursor when lease renewal revokes its consumer", async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		let released = 0;
		let bound = 0;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const ended = yield* Deferred.make<void>();
						const runtime = yield* makeConversationEventRuntime({
							...options(yield* Effect.scope, () =>
								Stream.fromEffect(
									Effect.sync(() => {
										clock.mockReturnValue(now + 60_000);
										return bindProviderEventDelivery(
											{
												releaseProviderEventCursor: () =>
													Effect.sync(() => {
														released++;
													}),
											},
											{
												scope: "session",
												event: {
													_tag: "SessionCursor",
													cursor: "thread-1",
													strategy: "claude-session-id",
													providerEventCursor: "cursor-1",
												},
											},
											"test-residency",
										);
									}),
								),
							),
							ingestionHeartbeatMs: 30_000,
							acquireIngestionLease: () =>
								Effect.succeed({
									renew: () => Effect.succeed(false),
									release: Effect.void,
									expire: Deferred.succeed(ended, undefined).pipe(
										Effect.asVoid,
									),
								}),
							bindProviderThread: () =>
								Effect.sync(() => {
									bound++;
								}),
						});
						yield* runtime.start(SessionId.make("session-1"), {
							turnId: "turn-1",
							attemptId: "attempt-1",
							providerSessionId: "test-residency",
						});
						yield* Deferred.await(ended);
						expect(released).toBe(1);
						expect(bound).toBe(0);
					}),
				),
			);
		} finally {
			clock.mockRestore();
		}
	});

	test.each([
		false,
		true,
	])("heartbeat shares the event consumer (blocked write: %s)", async (blocked) => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					const heartbeat = yield* Deferred.make<void>();
					let renewed = 0;
					let expired = 0;
					let activity: number | undefined;
					const runtime = yield* makeConversationEventRuntime({
						...options(yield* Effect.scope, () =>
							blocked
								? Stream.succeed({
										scope: "turn" as const,
										turnId: "turn-1" as AgentTurnId,
										event: {
											_tag: "AssistantMessage" as const,
											itemId: AgentItemId.make("output"),
											text: "hello",
										},
									}).pipe(Stream.concat(Stream.never))
								: Stream.never,
						),
						ingestionHeartbeatMs: 10,
						acquireIngestionLease: () =>
							Effect.succeed({
								renew: (lastActivity) =>
									Effect.sync(() => {
										renewed++;
										activity = lastActivity;
									}).pipe(
										Effect.andThen(
											!blocked || lastActivity !== undefined
												? Deferred.succeed(heartbeat, undefined)
												: Effect.void,
										),
										Effect.as(true),
									),
								release: Effect.void,
								expire: Effect.sync(() => {
									expired++;
								}),
							}),
						persist: () =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
							),
					});
					const sessionId = SessionId.make("session-1");
					yield* runtime.start(sessionId, {
						turnId: "turn-1",
						attemptId: "attempt-1",
						providerSessionId: "test-residency",
					});
					if (blocked) {
						yield* Deferred.await(entered);
						const before = renewed;
						yield* Effect.sleep("40 millis");
						expect(renewed).toBe(before);
						yield* Deferred.succeed(release, undefined);
					}
					yield* Deferred.await(heartbeat);
					expect(activity === undefined).toBe(!blocked);
					yield* runtime.interrupt(sessionId);
					expect(expired).toBe(1);
				}),
			),
		);
	});

	test.each([
		"valid",
		"revoked",
		"unowned",
		"foreign-provider",
	] as const)("admits only owned native execution references: %s", async (mode) => {
		const bound: unknown[] = [];
		const ownership = {
			turnId: "turn-1" as AgentTurnId,
			attemptId: AttemptId.make("attempt-1"),
		};
		const reference = {
			provider:
				mode === "foreign-provider" ? ("codex" as const) : ("claude" as const),
			nativeThreadId: "thread",
			nativeTurnId: "turn",
		};
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const done = yield* Deferred.make<void>();
					const runtime = yield* makeConversationEventRuntime({
						...options(yield* Effect.scope, () =>
							Stream.succeed({
								scope: "turn" as const,
								turnId: ownership.turnId,
								...(mode === "unowned" ? {} : { ownership }),
								event: { _tag: "NativeTurnStarted" as const, reference },
							}).pipe(Stream.ensuring(Deferred.succeed(done, undefined))),
						),
						ownsProviderSession: () => Effect.succeed(mode !== "revoked"),
						bindAttemptProviderTurn: (_session, value, expected, residency) =>
							Effect.sync(() => {
								bound.push({ value, expected, residency });
							}),
					});
					yield* runtime.start(SessionId.make("session-1"));
					yield* Deferred.await(done);
				}),
			),
		);
		expect(bound).toEqual(
			mode === "valid"
				? [
						{
							value: reference,
							expected: ownership,
							residency: "test-residency",
						},
					]
				: [],
		);
	});

	test.each([
		"committed",
		"rejected",
		"revoked",
		"interrupted",
	] as const)("settles cursor delivery on its emitting handle when persistence is %s", async (outcome) => {
		const observed: string[] = [];
		const handle = (name: string) => ({
			acknowledgeProviderEventCursor: (cursor: string) =>
				Effect.sync(() => {
					observed.push(`${name}:ack:${cursor}`);
				}),
			releaseProviderEventCursor: (cursor: string) =>
				Effect.sync(() => {
					observed.push(`${name}:release:${cursor}`);
				}),
		});
		let current = handle("old");
		const delivery = bindProviderEventDelivery(
			current,
			{
				scope: "session",
				event: {
					_tag: "SessionCursor",
					cursor: "thread",
					strategy: "grok-session-id",
					providerEventCursor: "cursor",
				},
			},
			"old-residency",
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const persisting = yield* Deferred.make<void>();
					const streamDone = yield* Deferred.make<void>();
					const runtime = yield* makeConversationEventRuntime({
						...options(yield* Effect.scope, () =>
							Stream.succeed(delivery).pipe(
								Stream.ensuring(Deferred.succeed(streamDone, undefined)),
							),
						),
						bindProviderThread: () =>
							Effect.gen(function* () {
								current = handle("replacement");
								yield* Deferred.succeed(persisting, undefined);
								if (outcome === "interrupted") return yield* Effect.never;
								if (outcome === "revoked")
									return yield* Effect.fail(
										new ProviderSessionOwnershipConflict({
											expectedProviderSessionId: "old-residency",
											actualProviderSessionId: "replacement",
										}),
									);
								if (outcome === "rejected")
									return yield* Effect.fail(
										new AttemptOwnershipConflict({
											turnId: "turn",
											expectedAttemptId: "old",
											actualAttemptId: "new",
										}),
									);
							}),
					});
					yield* runtime.start(SessionId.make("session"));
					yield* Deferred.await(persisting);
					if (outcome !== "interrupted") yield* Deferred.await(streamDone);
					yield* runtime.interrupt(SessionId.make("session"));
				}),
			),
		);
		expect(observed).toEqual([
			`old:${outcome === "committed" ? "ack" : "release"}:cursor`,
		]);
	});

	test.each([
		"end",
		"failure",
		"interrupt",
	] as const)("releases unfinished notification delivery on stream %s", async (ending) => {
		let releases = 0;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const pending = yield* Deferred.make<void>();
					const ended = yield* Deferred.make<void>();
					const delivery = bindProviderEventDelivery(
						{
							releaseProviderEventCursor: () =>
								Effect.sync(() => {
									releases++;
								}),
						},
						{
							scope: "session",
							event: {
								_tag: "ProviderNotificationMetadata",
								eventId: "pending",
								isReplay: false,
							},
						},
						"old-residency",
					);
					const stream = Stream.concat(
						Stream.succeed(delivery),
						Stream.fromEffect(
							Deferred.succeed(pending, undefined).pipe(
								Effect.andThen(
									ending === "end"
										? Effect.void
										: ending === "failure"
											? Effect.die("stream failed")
											: Effect.never,
								),
							),
						).pipe(Stream.drain),
					);
					const runtime = yield* makeConversationEventRuntime(
						options(yield* Effect.scope, () =>
							stream.pipe(Stream.ensuring(Deferred.succeed(ended, undefined))),
						),
					);
					yield* runtime.start(SessionId.make("session"));
					yield* Deferred.await(pending);
					if (ending !== "interrupt") yield* Deferred.await(ended);
					yield* runtime.interrupt(SessionId.make("session"));
				}),
			),
		);
		expect(releases).toBe(1);
	});

	test("does not publish completion when settlement loses ownership", async () => {
		let publications = 0;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const done = yield* Deferred.make<void>();
					const runtime = yield* makeConversationEventRuntime({
						...options(yield* Effect.scope, () =>
							Stream.succeed<ProviderEventEnvelope>({
								scope: "turn",
								turnId: "turn-1" as AgentTurnId,
								event: { _tag: "Completed", reason: "ended" },
							}).pipe(Stream.ensuring(Deferred.succeed(done, undefined))),
						),
						settleTurn: () => Effect.succeed(false),
						publishApiActivity: () =>
							Effect.sync(() => {
								publications++;
							}),
					});
					yield* runtime.start(SessionId.make("session-1"));
					yield* Deferred.await(done);
				}),
			),
		);
		expect(publications).toBe(0);
	});

	test("rejects obsolete events before publication", async () => {
		let callbacks = 0;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const consumed = yield* Deferred.make<void>();
					const ownership = {
						turnId: "turn-1" as AgentTurnId,
						attemptId: AttemptId.make("old-attempt"),
					};
					const envelopes: ProviderEventEnvelope[] = [
						{
							scope: "turn",
							turnId: ownership.turnId,
							ownership,
							event: { _tag: "Completed", reason: "ended" },
						},
						{
							scope: "session",
							ownership,
							event: {
								_tag: "SessionCursor",
								strategy: "claude-session-id",
								cursor: "old-head",
							},
						},
						{
							scope: "turn",
							turnId: ownership.turnId,
							ownership,
							event: {
								_tag: "AssistantMessage",
								itemId: AgentItemId.make("old-item"),
								text: "obsolete",
							},
						},
					];
					const callback = () =>
						Effect.sync(() => {
							callbacks++;
						});
					const runtime = yield* makeConversationEventRuntime({
						...options(yield* Effect.scope, () =>
							Stream.fromIterable(envelopes).pipe(
								Stream.ensuring(Deferred.succeed(consumed, undefined)),
							),
						),
						ownsAttempt: () => Effect.succeed(false),
						settleTurn: () => callback().pipe(Effect.as(true)),
						bindProviderThread: () =>
							Effect.fail(
								new AttemptOwnershipConflict({
									turnId: ownership.turnId,
									expectedAttemptId: ownership.attemptId,
									actualAttemptId: "new",
								}),
							),
						persist: callback,
						publishApiActivity: callback,
					});
					yield* runtime.start(SessionId.make("session-1"));
					yield* Deferred.await(consumed);
				}),
			),
		);
		expect(callbacks).toBe(0);
	});
	test("continues consuming when ownership changes between preflight and persistence", async () => {
		const persisted: string[] = [];
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const done = yield* Deferred.make<void>();
					const ownership = {
						turnId: "turn-1" as AgentTurnId,
						attemptId: AttemptId.make("attempt-1"),
					};
					const envelopes: ProviderEventEnvelope[] = ["racing", "current"].map(
						(text) => ({
							scope: "turn",
							turnId: ownership.turnId,
							ownership,
							event: {
								_tag: "AssistantMessage",
								itemId: AgentItemId.make(text),
								text,
							},
						}),
					);
					const runtime = yield* makeConversationEventRuntime({
						...options(yield* Effect.scope, () =>
							Stream.fromIterable(envelopes).pipe(
								Stream.ensuring(Deferred.succeed(done, undefined)),
							),
						),
						persist: (_session, _turn, content, _identity, expected) => {
							expect(expected).toEqual(ownership);
							if (content._tag === "assistant" && content.text === "racing")
								return Effect.fail(
									new AttemptOwnershipConflict({
										turnId: ownership.turnId,
										expectedAttemptId: ownership.attemptId,
										actualAttemptId: "new",
									}),
								);
							return Effect.sync(() => {
								if (content._tag === "assistant") persisted.push(content.text);
							});
						},
					});
					yield* runtime.start(SessionId.make("session-1"));
					yield* Deferred.await(done);
				}),
			),
		);
		expect(persisted).toEqual(["current"]);
	});

	test("does not guess a terminal when an uncorrelated stream ends", async () => {
		const settlements = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Effect.scope;
					const settled = yield* Ref.make(0);
					const runtime = yield* makeConversationEventRuntime(
						options(
							scope,
							() => Stream.empty,
							() => Ref.update(settled, (count) => count + 1),
						),
					);
					yield* runtime.start(SessionId.make("session-1"));
					yield* Effect.sleep(10);
					return yield* Ref.get(settled);
				}),
			),
		);

		expect(settlements).toBe(0);
	});

	test("replaces the previous subscription and releases it", async () => {
		let active = 0;
		let maximumActive = 0;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Effect.scope;
					const events = () =>
						Stream.scoped(
							Stream.fromEffect(
								Effect.acquireRelease(
									Effect.sync(() => {
										active += 1;
										maximumActive = Math.max(maximumActive, active);
									}),
									() => Effect.sync(() => (active -= 1)),
								),
							).pipe(Stream.drain, Stream.concat(Stream.never)),
						);
					const runtime = yield* makeConversationEventRuntime(
						options(scope, events),
					);
					const sessionId = SessionId.make("session-1");
					yield* runtime.start(sessionId);
					yield* Effect.sleep(1);
					yield* runtime.start(sessionId);
					yield* Effect.sleep(1);
					yield* runtime.interrupt(sessionId);
				}),
			),
		);

		expect(maximumActive).toBe(1);
		expect(active).toBe(0);
	});

	test("reconciles a restored session-scoped question before projection", async () => {
		const outcome = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Effect.scope;
					const reconciled = yield* Deferred.make<void>();
					const persisted = yield* Ref.make(0);
					const activities = yield* Ref.make(0);
					const sessionId = SessionId.make("session-1");
					const itemId = AgentItemId.make("question-1");
					const runtime = yield* makeConversationEventRuntime({
						...options(scope, () =>
							Stream.make({
								scope: "session",
								event: {
									_tag: "UserQuestion",
									itemId,
									questions: [
										{ question: "Continue?", options: ["Yes", "No"] },
									],
								},
							}),
						),
						reconcileQuestionResolution: (actualSessionId, actualItemId) =>
							Effect.sync(() => {
								expect(actualSessionId).toBe(sessionId);
								expect(actualItemId).toBe(itemId);
							}).pipe(
								Effect.andThen(Deferred.succeed(reconciled, undefined)),
								Effect.as(true),
							),
						publishApiActivity: () =>
							Ref.update(activities, (count) => count + 1),
						persist: () => Ref.update(persisted, (count) => count + 1),
					});
					yield* runtime.start(sessionId);
					yield* Deferred.await(reconciled);
					yield* Effect.sleep(1);
					return {
						persisted: yield* Ref.get(persisted),
						activities: yield* Ref.get(activities),
					};
				}),
			),
		);

		expect(outcome).toEqual({ persisted: 0, activities: 0 });
	});

	const runProviderTurn = (
		resolveStart: (turnId: AgentTurnId) => AgentTurnId,
	) =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Effect.scope;
					const providerTurn = AgentTurnId.make("turn_provider");
					const itemId = AgentItemId.make("message-1");
					const started = yield* Ref.make<ReadonlyArray<AgentTurnId>>([]);
					const persisted = yield* Ref.make<ReadonlyArray<AgentTurnId>>([]);
					const settled = yield* Ref.make<ReadonlyArray<AgentTurnId>>([]);
					const done = yield* Deferred.make<void>();
					const runtime = yield* makeConversationEventRuntime({
						...options(
							scope,
							() =>
								Stream.make<ReadonlyArray<ProviderEventEnvelope>>(
									{
										scope: "turn",
										turnId: providerTurn,
										event: { _tag: "ProviderTurnStarted" },
									},
									{
										scope: "turn",
										turnId: providerTurn,
										event: { _tag: "AssistantMessage", itemId, text: "done" },
									},
									{
										scope: "turn",
										turnId: providerTurn,
										event: { _tag: "Completed", reason: "ended" },
									},
								).pipe(
									Stream.concat(
										Stream.fromEffect(Deferred.succeed(done, undefined)).pipe(
											Stream.drain,
										),
									),
								),
							(_sessionId, turnId) =>
								Ref.update(settled, (turns) => [...turns, turnId]),
						),
						beginProviderTurn: (_sessionId, turnId) =>
							Ref.update(started, (turns) => [...turns, turnId]).pipe(
								Effect.as(resolveStart(turnId)),
							),
						persist: (_sessionId, turnId) =>
							Ref.update(persisted, (turns) =>
								turnId === null ? turns : [...turns, turnId],
							),
					});
					yield* runtime.start(SessionId.make("session-1"));
					yield* Deferred.await(done);
					yield* Effect.sleep(1);
					return {
						started: yield* Ref.get(started),
						persisted: yield* Ref.get(persisted),
						settled: yield* Ref.get(settled),
					};
				}),
			),
		);

	test("durably starts and settles a turn the provider opened itself", async () => {
		const outcome = await runProviderTurn((turnId) => turnId);

		expect(outcome).toEqual({
			started: ["turn_provider"],
			persisted: ["turn_provider"],
			settled: ["turn_provider"],
		});
	});

	test("folds a provider turn into an application turn that won the race", async () => {
		const outcome = await runProviderTurn(() =>
			AgentTurnId.make("turn_application"),
		);

		// The application turn settles on its own terminal, not the provider's.
		expect(outcome).toEqual({
			started: ["turn_provider"],
			persisted: ["turn_application"],
			settled: [],
		});
	});

	test.each([
		"current",
		"revoked",
		"commit-race",
	] as const)("persists startup questions only under current residency (%s)", async (mode) => {
		const order: string[] = [];
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const done = yield* Deferred.make<void>();
					const itemId = AgentItemId.make("startup-question");
					const runtime = yield* makeConversationEventRuntime({
						...options(yield* Effect.scope, () =>
							Stream.make(
								{
									scope: "session",
									event: {
										_tag: "UserQuestion",
										itemId,
										questions: [{ question: "Continue?", options: ["Yes"] }],
									},
								},
								{
									scope: "session",
									event: {
										_tag: "UserQuestionResolved",
										itemId,
										resolution: "timed-out",
									},
								},
								{
									scope: "session",
									event: {
										_tag: "AssistantMessage",
										itemId: AgentItemId.make("unowned"),
										text: "must remain unprojected",
									},
								},
							).pipe(Stream.ensuring(Deferred.succeed(done, undefined))),
						),
						ownsProviderSession: () => Effect.succeed(mode !== "revoked"),
						persist: (
							_session,
							turnId,
							content,
							identity,
							ownership,
							residency,
						) => {
							expect(turnId).toBeNull();
							expect(ownership).toBeUndefined();
							expect(residency).toBe("test-residency");
							expect(identity).toContain("startup-question");
							if (mode === "commit-race")
								return Effect.fail(
									new ProviderSessionOwnershipConflict({
										expectedProviderSessionId: "test-residency",
										actualProviderSessionId: "replacement",
									}),
								);
							return Effect.sync(() => {
								order.push(content._tag);
							});
						},
						publishApiActivity: (_session, activity) =>
							Effect.sync(() => {
								order.push(activity);
							}),
					});
					yield* runtime.start(SessionId.make("session-1"));
					yield* Deferred.await(done);
				}),
			),
		);
		expect(order).toEqual(
			mode === "current"
				? ["user_question", "question-needed", "user_question_answer"]
				: [],
		);
	});
});
