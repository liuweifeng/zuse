import {
	AgentSessionId,
	AgentSessionNotFoundError,
	JobId,
	SessionId,
	SessionStartError,
} from "@zuse/contracts";
import type { Job } from "@zuse/domain/agent-engine/jobs";
import {
	TurnAlreadyRunning,
	ValidationFailed,
} from "@zuse/domain/core/decider";
import { AttemptOwnershipConflict } from "@zuse/domain/engine/dispatch";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import {
	makeProviderJobExecutor,
	type ProviderJobExecutorOptions,
} from "../../src/conversation/core/provider-jobs.ts";

const job = (request: Job["request"]): Job => ({
	id: JobId.make("job:event-ready:0"),
	sequence: 1,
	sessionId: "session-1",
	request,
	status: "running",
	attemptCount: 1,
	availableAt: "2026-01-01T00:00:00.000Z",
	leaseOwner: "test",
	leaseExpiresAt: null,
	causationEventId: "event-ready",
	correlationId: "correlation-1",
	lastError: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	completedAt: null,
});

const unused = () => Effect.die("unused");

const makeOptions = (
	overrides: Partial<ProviderJobExecutorOptions>,
): ProviderJobExecutorOptions => ({
	authorizeQueuedTurn: () => Effect.succeed(true),
	delivery: {
		state: () => Effect.succeed("missing" as const),
		isCompleted: () => Effect.succeed(false),
		begin: () => Effect.succeed("started" as const),
		complete: () => Effect.void,
		markOutcomeUnknown: () => Effect.void,
		releaseUndelivered: () => Effect.void,
	},
	getSession: (() =>
		Effect.succeed({
			archivedAt: null,
			status: "idle",
			providerId: "claude",
		})) as unknown as ProviderJobExecutorOptions["getSession"],
	ensureForTurn: unused as ProviderJobExecutorOptions["ensureForTurn"],
	persistMessage: unused as ProviderJobExecutorOptions["persistMessage"],
	ndjsonAppend: () => Effect.void,
	setStatus: () => Effect.void,
	getProviderStartJson: () => Effect.succeed(null),
	settleTurn: () => Effect.void,
	rememberActiveTurn: () => undefined,
	provider: {} as ProviderJobExecutorOptions["provider"],
	sessionDomain: {
		dispatch: (input) =>
			input.command._tag === "RecoverTurn"
				? Effect.fail(
						new ValidationFailed({ message: "No native identity in fixture" }),
					)
				: unused(),
		activeAttempt: () =>
			Effect.succeed({
				turnId: "turn-active",
				attemptId: "attempt:turn:turn-active:ordinal:1",
			}),
	},
	...overrides,
});

describe("provider job executor", () => {
	it.each([
		"old-process",
		undefined,
	])("carries stop residency through closure and detachment (%s)", async (providerSessionId) => {
		const observed: unknown[] = [];
		const defaults = makeOptions({});
		const execute = makeProviderJobExecutor(
			makeOptions({
				provider: {
					...defaults.provider,
					close: (_session, ownership, expected) =>
						Effect.sync(() => {
							observed.push({ ownership, expected });
						}),
				},
				sessionDomain: {
					...defaults.sessionDomain,
					dispatch: (input) =>
						Effect.sync(() => {
							observed.push(input.command);
							return {
								commandId: input.commandId,
								streamId: input.streamId,
								streamVersion: 1,
								eventIds: [],
							};
						}),
				},
			}),
		);
		await Effect.runPromise(
			execute(
				job({ _tag: "provider.stop", providerSessionId, requestedAt: 9 }),
			),
		);
		expect(observed).toEqual([
			{ ownership: undefined, expected: providerSessionId ?? null },
			{
				_tag: "DetachProvider",
				expectedProviderSessionId: providerSessionId ?? null,
				detachedAt: 9,
			},
		]);
	});

	it("targets interrupt cleanup at the failed attempt's handle", async () => {
		const closed: unknown[] = [];
		const defaults = makeOptions({});
		const execute = makeProviderJobExecutor(
			makeOptions({
				sessionDomain: {
					...defaults.sessionDomain,
					dispatch: () =>
						Effect.succeed({
							commandId: "cleanup",
							streamId: "session-1",
							streamVersion: 1,
							eventIds: [],
						}),
				},
				provider: {
					...defaults.provider,
					interrupt: () => Effect.die("transport unavailable"),
					close: (_session, ownership) =>
						Effect.sync(() => {
							closed.push(ownership);
						}),
				},
			}),
		);
		await Effect.runPromise(
			execute(
				job({
					_tag: "provider.turn.interrupt",
					turnId: "turn-active",
					attemptId: "attempt:turn:turn-active:ordinal:1",
					requestedAt: 1,
				}),
			),
		);
		expect(closed).toEqual([
			{
				turnId: "turn-active",
				attemptId: "attempt:turn:turn-active:ordinal:1",
			},
		]);
	});

	it.each([
		"before-send",
		"unknown-send",
		"startup-error",
	] as const)("stops stale job writes at %s", async (stage) => {
		const writes: string[] = [];
		const ownership = {
			requireUninterrupted: true,
			turnId: "turn-active",
			attemptId: "attempt:turn:turn-active:ordinal:1",
		};
		const rejected = () =>
			Effect.fail(
				new AttemptOwnershipConflict({
					turnId: ownership.turnId,
					expectedAttemptId: ownership.attemptId,
					actualAttemptId: "replacement",
				}),
			);
		const execute = makeProviderJobExecutor(
			makeOptions({
				setStatus: (_session, status, expected) => {
					expect(expected).toEqual(ownership);
					writes.push(status);
					return stage === "before-send" ? rejected() : Effect.void;
				},
				persistMessage: (_session, _content, _id, turnId, expected) => {
					expect(turnId).toBe(ownership.turnId);
					expect(expected).toEqual(ownership);
					writes.push("guarded-message");
					return rejected();
				},
				provider: {
					send: () => {
						writes.push("send");
						return stage === "startup-error"
							? Effect.fail(
									new AgentSessionNotFoundError({
										sessionId: AgentSessionId.make("session-1"),
									}),
								)
							: Effect.die("ambiguous provider failure");
					},
				} as unknown as ProviderJobExecutorOptions["provider"],
				ensureForTurn: () =>
					Effect.fail(
						new SessionStartError({
							providerId: "claude",
							reason: "late startup failure",
						}),
					),
				ndjsonAppend: () =>
					Effect.sync(() => {
						writes.push("ndjson");
					}),
				settleTurn: () =>
					Effect.sync(() => {
						writes.push("settle");
					}),
			}),
		);
		await Effect.runPromise(
			execute(
				job({
					_tag: "provider.turn.send",
					turnId: ownership.turnId,
					attemptId: ownership.attemptId,
					providerInputJson:
						'{"text":"hello","attachments":[],"fileRefs":[],"skillRefs":[]}',
				}),
			),
		);
		expect(writes).toEqual(
			stage === "before-send"
				? ["running"]
				: ["running", "send", "guarded-message"],
		);
	});

	it.each([
		"provider.turn.send",
		"provider.turn.interrupt",
	] as const)("skips an obsolete %s attempt before touching the provider", async (kind) => {
		let calls = 0;
		const execute = makeProviderJobExecutor(
			makeOptions({
				provider: {
					send: () =>
						Effect.sync(() => {
							calls++;
						}),
					interrupt: () =>
						Effect.sync(() => {
							calls++;
						}),
				} as unknown as ProviderJobExecutorOptions["provider"],
			}),
		);
		await Effect.runPromise(
			execute(
				job(
					kind === "provider.turn.send"
						? {
								_tag: kind,
								turnId: "turn-active",
								attemptId: "superseded-attempt",
								providerInputJson: "{}",
							}
						: {
								_tag: kind,
								turnId: "turn-active",
								attemptId: "superseded-attempt",
								requestedAt: 1,
							},
				),
			),
		);
		expect(calls).toBe(0);
	});
	it.each([
		true,
		false,
	])("stops after interrupt ownership is lost (provider success: %s)", async (success) => {
		let settled = 0;
		let closed = 0;
		const execute = makeProviderJobExecutor(
			makeOptions({
				provider: {
					interrupt: () =>
						success
							? Effect.void
							: Effect.fail(
									new AgentSessionNotFoundError({
										sessionId: AgentSessionId.make("session-1"),
									}),
								),
					close: () =>
						Effect.sync(() => {
							closed++;
						}),
				} as unknown as ProviderJobExecutorOptions["provider"],
				settleTurn: () =>
					Effect.sync(() => {
						settled++;
					}),
				sessionDomain: {
					activeAttempt: () =>
						Effect.succeed({
							turnId: "turn-active",
							attemptId: "attempt:turn:turn-active:ordinal:1",
						}),
					dispatch: (input) => {
						expect(input.expectedAttempt).toEqual({
							turnId: "turn-active",
							attemptId: "attempt:turn:turn-active:ordinal:1",
						});
						return Effect.fail(
							new AttemptOwnershipConflict({
								turnId: "turn-active",
								expectedAttemptId: "attempt:turn:turn-active:ordinal:1",
								actualAttemptId: "replacement",
							}),
						);
					},
				},
			}),
		);
		await Effect.runPromise(
			execute(
				job({
					_tag: "provider.turn.interrupt",
					turnId: "turn-active",
					requestedAt: 1,
				}),
			),
		);
		expect(settled).toBe(0);
		expect(closed).toBe(0);
	});

	it("settles interrupted provider startup instead of leaving the turn running", async () => {
		const settled: unknown[] = [];
		const execute = makeProviderJobExecutor(
			makeOptions({
				provider: {
					send: () =>
						Effect.fail(
							new AgentSessionNotFoundError({
								sessionId: AgentSessionId.make("session-1"),
							}),
						),
				} as unknown as ProviderJobExecutorOptions["provider"],
				ensureForTurn: () => Effect.interrupt,
				persistMessage: () => Effect.succeed({} as never),
				settleTurn: (_session, turn, outcome, expected) =>
					Effect.sync(() => {
						settled.push({ turn, outcome, expected });
					}),
			}),
		);
		await Effect.runPromise(
			execute(
				job({
					_tag: "provider.turn.send",
					turnId: "turn-active",
					providerInputJson:
						'{"text":"hello","attachments":[],"fileRefs":[],"skillRefs":[]}',
				}),
			).pipe(Effect.exit),
		);
		expect(settled).toEqual([
			{
				turn: "turn-active",
				outcome: "error",
				expected: {
					requireUninterrupted: true,
					turnId: "turn-active",
					attemptId: "attempt:turn:turn-active:ordinal:1",
				},
			},
		]);
	});

	it.each([
		"native",
		"superseded",
	] as const)("fences externally interrupted startup recovery (%s)", async (owner) => {
		const writes: string[] = [];
		await Effect.runPromise(
			Effect.gen(function* () {
				const starting = yield* Deferred.make<void>();
				const defaults = makeOptions({});
				const execute = makeProviderJobExecutor(
					makeOptions({
						provider: {
							...defaults.provider,
							send: () =>
								Effect.fail(
									new AgentSessionNotFoundError({
										sessionId: AgentSessionId.make("session-1"),
									}),
								),
						},
						ensureForTurn: () =>
							Deferred.succeed(starting, undefined).pipe(
								Effect.andThen(Effect.never),
							),
						sessionDomain: {
							...defaults.sessionDomain,
							dispatch: (input) => {
								expect(input.command._tag).toBe("RecoverTurn");
								expect(input.expectedAttempt).toEqual({
									requireUninterrupted: true,
									turnId: "turn-active",
									attemptId: "attempt:turn:turn-active:ordinal:1",
								});
								writes.push("fenced-recovery");
								return owner === "superseded"
									? Effect.fail(
											new AttemptOwnershipConflict({
												turnId: "turn-active",
												expectedAttemptId: "attempt:turn:turn-active:ordinal:1",
												actualAttemptId: "replacement",
											}),
										)
									: Effect.succeed({
											commandId: input.commandId,
											streamId: input.streamId,
											streamVersion: 1,
											eventIds: [],
										});
							},
						},
						delivery: {
							...defaults.delivery,
							markOutcomeUnknown: () =>
								Effect.sync(() => {
									writes.push("outcome-unknown");
								}),
						},
						persistMessage: () =>
							Effect.sync(() => {
								writes.push("persist-error");
								return {} as never;
							}),
						settleTurn: () =>
							Effect.sync(() => {
								writes.push("settle");
							}),
					}),
				);
				const fiber = yield* execute(
					job({
						_tag: "provider.turn.send",
						turnId: "turn-active",
						providerInputJson:
							'{"text":"hello","attachments":[],"fileRefs":[],"skillRefs":[]}',
					}),
				).pipe(Effect.forkChild);
				yield* Deferred.await(starting);
				yield* Fiber.interrupt(fiber);
			}),
		);
		expect(writes).toEqual(
			owner === "native"
				? ["fenced-recovery", "outcome-unknown"]
				: ["fenced-recovery"],
		);
	});

	it.each([
		"ambiguous-send",
		"crash-before-receipt",
	] as const)("does not resend after %s", async (failurePoint) => {
		let state: "missing" | "started" | "completed" | "outcome-unknown" =
			"missing";
		let sends = 0;
		let starts = 0;
		let crash = failurePoint === "crash-before-receipt";
		const errors: string[] = [];
		const settled: string[] = [];
		const execute = makeProviderJobExecutor(
			makeOptions({
				delivery: {
					state: () => Effect.sync(() => state),
					isCompleted: () =>
						Effect.sync(
							() => state === "completed" || state === "outcome-unknown",
						),
					begin: () =>
						Effect.sync(() => {
							if (state === "missing") {
								state = "started";
								return "started" as const;
							}
							return state === "started" ? ("already-started" as const) : state;
						}),
					complete: () =>
						Effect.sync(() => {
							if (crash) {
								crash = false;
								throw new Error("crash before receipt");
							}
							state = "completed";
						}),
					markOutcomeUnknown: () =>
						Effect.sync(() => {
							state = "outcome-unknown";
						}),
					releaseUndelivered: () =>
						Effect.sync(() => {
							state = "missing";
						}),
				},
				provider: {
					send: () =>
						Effect.sync(() => {
							sends += 1;
							if (failurePoint === "ambiguous-send")
								throw new Error("provider accepted then disconnected");
						}),
				} as unknown as ProviderJobExecutorOptions["provider"],
				ensureForTurn: () =>
					Effect.sync(() => {
						starts += 1;
						return true;
					}),
				persistMessage: (_session, content) =>
					Effect.sync(() => {
						if (content._tag === "error") errors.push(content.message);
						return {} as never;
					}),
				settleTurn: (_session, turn) =>
					Effect.sync(() => {
						settled.push(turn);
					}),
			}),
		);
		const request = job({
			_tag: "provider.turn.send",
			turnId: "turn-active",
			providerInputJson:
				'{"text":"hello","attachments":[],"fileRefs":[],"skillRefs":[]}',
		});
		if (failurePoint === "crash-before-receipt") {
			await expect(Effect.runPromise(execute(request))).rejects.toThrow(
				"crash before receipt",
			);
		}
		await Effect.runPromise(execute(request));
		await Effect.runPromise(execute(request));
		expect(sends).toBe(1);
		expect(starts).toBe(0);
		expect(errors).toEqual([expect.stringContaining("did not send it again")]);
		expect(settled).toEqual(["turn-active"]);
		expect(state).toBe("outcome-unknown");
	});

	it("requeues a scheduled successor that was superseded before it ran", async () => {
		const dispatched: Array<{
			readonly commandId: string;
			readonly command: { readonly _tag: string };
		}> = [];
		const sessionDomain = {
			dispatch: (input: Parameters<SessionDomainApi["dispatch"]>[0]) => {
				dispatched.push(input);
				return input.command._tag === "SubmitTurn"
					? Effect.fail(new TurnAlreadyRunning({ turnId: "turn-current" }))
					: Effect.succeed({
							commandId: input.commandId,
							streamId: input.streamId,
							streamVersion: 1,
							eventIds: [],
						});
			},
		} as unknown as SessionDomainApi;
		const execute = makeProviderJobExecutor(makeOptions({ sessionDomain }));

		await Effect.runPromise(
			execute(
				job({
					_tag: "provider.successor.start",
					turnId: "turn-scheduled",
					queueId: "queue-1",
					inputJson:
						'{"text":"preserve me","attachments":[],"fileRefs":[],"skillRefs":[],"annotations":[]}',
				}),
			),
		);

		expect(dispatched.map(({ command }) => command._tag)).toEqual([
			"SubmitTurn",
			"EnqueueTurn",
		]);
		expect(dispatched.map(({ commandId }) => commandId)).toEqual([
			"job:event-ready:0:submit",
			"job:event-ready:0:requeue",
		]);
	});

	it("skips a provider turn whose durable turn is no longer active", async () => {
		let sent = 0;
		const execute = makeProviderJobExecutor(
			makeOptions({
				provider: {
					send: () =>
						Effect.sync(() => {
							sent += 1;
						}),
				} as unknown as ProviderJobExecutorOptions["provider"],
			}),
		);
		await Effect.runPromise(
			execute(
				job({
					_tag: "provider.turn.send",
					turnId: "turn-stale",
					providerInputJson:
						'{"text":"stale","attachments":[],"fileRefs":[],"skillRefs":[]}',
				}),
			),
		);
		expect(sent).toBe(0);
	});

	it("reports a retryable failure when the provider cannot start for an active turn", async () => {
		const statuses: string[] = [];
		const execute = makeProviderJobExecutor(
			makeOptions({
				provider: {
					send: () =>
						Effect.fail(
							new AgentSessionNotFoundError({
								sessionId: AgentSessionId.make("session-1"),
							}),
						),
				} as unknown as ProviderJobExecutorOptions["provider"],
				ensureForTurn: () =>
					Effect.fail({
						_tag: "SessionStartError",
						providerId: "claude",
						reason: "scripted start failure",
					} as never),
				persistMessage: () =>
					Effect.succeed({} as never) as ReturnType<
						ProviderJobExecutorOptions["persistMessage"]
					>,
				setStatus: (_sessionId, status) =>
					Effect.sync(() => {
						statuses.push(status);
					}),
			}),
		);
		const exit = await Effect.runPromiseExit(
			execute(
				job({
					_tag: "provider.turn.send",
					turnId: "turn-active",
					providerInputJson:
						'{"text":"go","attachments":[],"fileRefs":[],"skillRefs":[]}',
				}),
			),
		);
		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			expect(String(exit.cause)).toContain("scripted start failure");
		}
		expect(statuses).toEqual(["running", "error"]);
		expect(SessionId.make("session-1")).toBe("session-1");
	});
});

it("routes uncertain delivery to a separate recovery attempt when native identity is available", async () => {
	const commands: unknown[] = [];
	let marked = 0;
	const defaults = makeOptions({});
	const execute = makeProviderJobExecutor(
		makeOptions({
			delivery: {
				...defaults.delivery,
				begin: () => Effect.succeed("already-started"),
				markOutcomeUnknown: () =>
					Effect.sync(() => {
						marked++;
					}),
			},
			sessionDomain: {
				...defaults.sessionDomain,
				dispatch: (input) =>
					Effect.sync(() => {
						commands.push({
							command: input.command,
							ownership: input.expectedAttempt,
						});
						return {
							commandId: input.commandId,
							streamId: input.streamId,
							streamVersion: 2,
							eventIds: ["recovery-request"],
						};
					}),
			},
		}),
	);
	await Effect.runPromise(
		execute(
			job({
				_tag: "provider.turn.send",
				turnId: "turn-active",
				attemptId: "attempt:turn:turn-active:ordinal:1",
				providerInputJson:
					'{"text":"hello","attachments":[],"fileRefs":[],"skillRefs":[]}',
			}),
		),
	);
	expect(commands).toEqual([
		{
			command: {
				_tag: "RecoverTurn",
				turnId: "turn-active",
				expectedAttemptId: "attempt:turn:turn-active:ordinal:1",
				requestedAt: expect.any(Number),
			},
			ownership: {
				requireUninterrupted: true,
				turnId: "turn-active",
				attemptId: "attempt:turn:turn-active:ordinal:1",
			},
		},
	]);
	expect(marked).toBe(1);
});

it("delivers a frozen native goal payload through the same durable turn job", async () => {
	const seen: unknown[] = [];
	const defaults = makeOptions({});
	const execute = makeProviderJobExecutor(
		makeOptions({
			provider: {
				...defaults.provider,
				send: (...args) =>
					Effect.sync(() => {
						seen.push(args.at(-1));
					}),
			},
		}),
	);
	await Effect.runPromise(
		execute(
			job({
				_tag: "provider.turn.send",
				turnId: "turn-active",
				providerInputJson: JSON.stringify({
					text: "context plus objective",
					attachments: [],
					fileRefs: [],
					skillRefs: [],
					goal: {
						objective: "original objective",
						status: "active",
						tokenBudget: 3000,
					},
				}),
			}),
		),
	);
	expect(seen).toEqual([
		{ objective: "original objective", status: "active", tokenBudget: 3000 },
	]);
});
