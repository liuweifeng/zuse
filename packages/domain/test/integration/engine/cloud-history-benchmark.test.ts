import { writeFileSync } from "node:fs";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { makeSessionDomain } from "../../../src/engine/session-domain";
import { makeSqlDispatchStorage } from "../../../src/engine/sql-dispatch-storage";
import { createSessionCommand } from "../../../src/test/session";
import { createDomainTestSchema } from "../../../src/test/sql-schema";

test("recent cloud synchronization remains bounded as history grows", async () => {
	const results = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO chats (id, updated_at) VALUES ('chat-1', '1970-01-01T00:00:00.000Z')`;
				let nextEvent = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`benchmark-event-${++nextEvent}`),
				);
				yield* domain.dispatch({
					commandId: "create-benchmark",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const results = [];
				let seeded = 0;
				const append = () => {
					const index = ++seeded;
					return domain.dispatch({
						commandId: `message-${index}`,
						streamId: "session-1",
						command: {
							_tag: "PersistMessage",
							messageId: `message-${index}`,
							turnId: null,
							role: "assistant",
							kind: "assistant",
							contentJson: JSON.stringify({
								_tag: "assistant",
								text: "large command output ✓\n".repeat(100),
							}),
							parentItemId: null,
							createdAt: index,
						},
					});
				};
				for (const count of [10, 1000, 10000]) {
					const storage = makeSqlDispatchStorage(sql);
					const expectedVersion =
						yield* domain.currentStreamVersion("session-1");
					const events = Array.from({ length: count - seeded }, () => {
						const index = ++seeded;
						return {
							eventId: `seed-event-${index}`,
							event: {
								_tag: "MessagePersisted" as const,
								messageId: `message-${index}`,
								turnId: null,
								role: "assistant",
								kind: "assistant",
								contentJson: JSON.stringify({
									_tag: "assistant",
									text: "large command output ✓\n".repeat(100),
								}),
								parentItemId: null,
								createdAt: index,
							},
						};
					});
					yield* storage.append({
						commandId: `seed-${count}`,
						streamId: "session-1",
						correlationId: "seed",
						causationEventId: null,
						expectedVersion,
						events,
					});
					yield* domain.catchUp;
					for (const background of [false, true]) {
						const start = performance.now();
						const frames = yield* domain
							.synchronizedEvents({
								streamId: "session-1",
								hasProjection: false,
								...(background ? { historyMode: "background" as const } : {}),
							})
							.pipe(
								Stream.takeUntil((frame) => frame.kind === "synchronized"),
								Stream.runCollect,
							);
						const ms = performance.now() - start;
						const delivered = frames.flatMap((frame) =>
							frame.kind === "snapshot"
								? frame.projection.messages
								: frame.kind === "snapshot-chunk"
									? frame.messages
									: [],
						);
						expect(delivered.length).toBe(
							background ? Math.min(100, count) : count,
						);
						if (background) expect(frames.length).toBe(2);
						results.push({
							count,
							background,
							ms,
							initialBytes: Buffer.byteLength(JSON.stringify(frames)),
						});
					}
					const afterVersion = yield* domain.currentStreamVersion("session-1");
					for (let index = 0; index < 5; index++) yield* append();
					const start = performance.now();
					const resumed = yield* domain
						.synchronizedEvents({
							streamId: "session-1",
							hasProjection: true,
							afterVersion,
						})
						.pipe(
							Stream.takeUntil((frame) => frame.kind === "synchronized"),
							Stream.runCollect,
						);
					const ms = performance.now() - start;
					expect(resumed.map((frame) => frame.kind)).toEqual([
						"event",
						"event",
						"event",
						"event",
						"event",
						"synchronized",
					]);
					expect(
						resumed.flatMap((frame) =>
							frame.kind === "event" ? [frame.record.streamVersion] : [],
						),
					).toEqual(
						Array.from({ length: 5 }, (_, index) => afterVersion + index + 1),
					);
					const bytes = Buffer.byteLength(JSON.stringify(resumed));
					expect(bytes).toBeLessThan(20000);
					results.push({
						count,
						mode: "resume-five-events",
						ms,
						initialBytes: bytes,
					});
				}
				return results;
			}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
		),
	);
	if (process.env.ZUSE_BENCHMARK_OUTPUT)
		writeFileSync(
			process.env.ZUSE_BENCHMARK_OUTPUT,
			JSON.stringify(results, null, 2),
		);
}, 60_000);
