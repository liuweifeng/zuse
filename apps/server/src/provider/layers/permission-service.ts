import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type FolderId,
	PermissionDecision,
	type PermissionKind,
	PermissionRequest,
	type PermissionRequestChange,
	PermissionRequestExpiredError,
	PermissionRequestNotFoundError,
	SavedDecision,
	type SessionId,
} from "@zuse/contracts";
import { ownsInputRequest } from "@zuse/domain/agent-engine/input-owner";
import type { StoredEvent } from "@zuse/domain/engine/dispatch";
import { ReactorRunner } from "@zuse/domain/engine/reactor-runner";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import {
	makeSqlConsumerStorage,
	type SqlConsumerStorageError,
} from "@zuse/domain/engine/sql-consumer-storage";
import {
	DateTime,
	Deferred,
	Effect,
	Layer,
	PubSub,
	Ref,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";

import { AppPaths } from "../../app-paths.ts";
import {
	PermissionService,
	type PermissionServiceShape,
	type RequestOptions,
} from "../services/permission-service.ts";

interface PendingEntry {
	readonly request: PermissionRequest;
	readonly deferred: Deferred.Deferred<PermissionDecision>;
	readonly projectId: FolderId;
	readonly authority?: RequestOptions;
}

interface DecisionRow {
	readonly request_id: string;
	readonly session_id: string;
	readonly project_id: string | null;
	readonly kind_tag: string;
	readonly kind_key: string;
	readonly kind_json: string;
	readonly decision: string;
	readonly scope: string;
	readonly decided_at: string;
}

interface PendingRequestRow {
	readonly request_json: string;
	readonly project_id: string;
	readonly abandoned_turn_id: string | null;
}

const scopeForDecision = (
	decision: PermissionDecision,
): "session" | "folder" =>
	decision._tag === "AlwaysAllow" ? "folder" : "session";

const decodeSavedDecision = Schema.decodeUnknownEffect(SavedDecision);
const decodePermissionDecision = Schema.decodeUnknownEffect(PermissionDecision);
const decodePermissionRequest = Schema.decodeUnknownEffect(
	Schema.fromJsonString(PermissionRequest),
);

const rowToSavedDecision = (
	row: DecisionRow,
): Effect.Effect<SavedDecision, never> =>
	decodeSavedDecision({
		requestId: row.request_id,
		sessionId: row.session_id,
		projectId: row.project_id,
		kind: JSON.parse(row.kind_json),
		decision: row.decision,
		scope: row.scope,
		decidedAt: row.decided_at,
	}).pipe(
		Effect.catch(() =>
			decodeSavedDecision({
				requestId: row.request_id,
				sessionId: row.session_id,
				projectId: row.project_id,
				kind: { _tag: "Other", tool: row.kind_tag, summary: row.kind_key },
				decision: "Deny",
				scope: "session",
				decidedAt: row.decided_at,
			}).pipe(Effect.orDie),
		),
	);

const kindKey = (kind: PermissionKind): string => {
	switch (kind._tag) {
		case "FileWrite":
			return kind.path;
		case "Bash":
			return kind.command;
		case "Network":
			return kind.url;
		case "Other":
			return `${kind.tool}:${kind.summary}`;
	}
};

const decisionTag = (
	decision: PermissionDecision,
): "AllowOnce" | "AllowForSession" | "Deny" | "AlwaysAllow" => decision._tag;

const nextRequestId = (): string => `pr_${crypto.randomUUID()}`;

export const PermissionServiceLive = Layer.effect(
	PermissionService,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const sessionDomain = yield* SessionDomain;
		const paths = yield* AppPaths;
		const pubsub = yield* PubSub.unbounded<PermissionRequestChange>();
		const pending = yield* Ref.make<ReadonlyMap<string, PendingEntry>>(
			new Map(),
		);
		const logPath = join(paths.userData, "logs", "permissions.log");

		const log = (event: string, fields: Record<string, unknown> = {}): void => {
			try {
				mkdirSync(dirname(logPath), { recursive: true });
				appendFileSync(
					logPath,
					`${JSON.stringify({
						ts: new Date().toISOString(),
						event,
						...fields,
					})}\n`,
				);
			} catch {}
		};

		const findExistingAllow = (
			sessionId: SessionId,
			projectId: FolderId,
			kind: PermissionKind,
		): Effect.Effect<boolean> =>
			sql<DecisionRow>`
        SELECT request_id, session_id, project_id, kind_tag, kind_key,
               kind_json, decision, scope, decided_at
        FROM permission_decisions
        WHERE kind_tag = ${kind._tag}
          AND kind_key = ${kindKey(kind)}
          AND (
            (session_id = ${sessionId} AND scope = 'session' AND decision = 'AllowForSession')
            OR
            (project_id = ${projectId} AND scope = 'folder' AND decision = 'AlwaysAllow')
          )
        LIMIT 1
      `.pipe(
				Effect.map((rows) => rows.length > 0),
				Effect.catch(() => Effect.succeed(false)),
			);

		const persistDecision = (
			request: PermissionRequest,
			projectId: FolderId,
			decision: PermissionDecision,
		): Effect.Effect<void> =>
			sql`
        INSERT OR REPLACE INTO permission_decisions
          (request_id, session_id, project_id, kind_tag, kind_key,
           kind_json, decision, scope, decided_at)
        VALUES
          (${request.id}, ${request.sessionId}, ${projectId},
           ${request.kind._tag}, ${kindKey(request.kind)},
           ${JSON.stringify(request.kind)},
           ${decisionTag(decision)}, ${scopeForDecision(decision)},
           ${new Date().toISOString()})
      `.pipe(
				Effect.asVoid,
				Effect.catch((cause) =>
					Effect.logWarning(
						`[PermissionService] persist decision failed: ${String(cause)}`,
					),
				),
			);

		const ownsRequest = (
			sessionId: SessionId,
			authority?: RequestOptions,
		): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				if (authority?.isCurrent !== undefined && !(yield* authority.isCurrent))
					return false;
				const owner = authority?.owner;
				if (owner === undefined) return true;
				const owns = yield* ownsInputRequest(sql, sessionId, owner).pipe(
					Effect.orDie,
				);
				return (
					owns &&
					(authority?.isCurrent === undefined || (yield* authority.isCurrent))
				);
			});

		const removePendingRequest = (requestId: string) =>
			Ref.update(pending, (current) => {
				const next = new Map(current);
				next.delete(requestId);
				return next;
			}).pipe(
				Effect.andThen(PubSub.publish(pubsub, { _tag: "remove", requestId })),
				Effect.asVoid,
			);

		type PermissionLifecycleCommand =
			| { readonly _tag: "PublishPermission"; readonly requestId: string }
			| { readonly _tag: "ExpirePermission"; readonly requestId: string }
			| {
					readonly _tag: "CompletePermission";
					readonly requestId: string;
					readonly decisionJson: string;
			  };

		const permissionReactor = new ReactorRunner<
			StoredEvent,
			PermissionLifecycleCommand,
			SqlConsumerStorageError
		>(
			makeSqlConsumerStorage(sql),
			(input) =>
				Effect.gen(function* () {
					const entries = yield* Ref.get(pending);
					const entry = entries.get(input.command.requestId);
					if (entry === undefined) return;
					if (input.command._tag === "PublishPermission") {
						const published = yield* PubSub.publish(pubsub, {
							_tag: "change",
							request: entry.request,
						});
						log("request.published", {
							requestId: entry.request.id,
							sessionId: entry.request.sessionId,
							published,
						});
						return;
					}

					if (input.command._tag === "ExpirePermission") {
						const request = PermissionRequest.make({
							...entry.request,
							recoveryState: "expired",
						});
						yield* Ref.update(pending, (current) =>
							new Map(current).set(request.id, { ...entry, request }),
						);
						yield* Deferred.succeed(entry.deferred, { _tag: "Deny" });
						yield* PubSub.publish(pubsub, { _tag: "change", request });
						return;
					}

					const decision = yield* decodePermissionDecision(
						JSON.parse(input.command.decisionJson),
					).pipe(Effect.orDie);
					yield* persistDecision(entry.request, entry.projectId, decision);
					yield* removePendingRequest(input.command.requestId);
					yield* Deferred.succeed(
						entry.deferred,
						(yield* ownsRequest(entry.request.sessionId, entry.authority))
							? decision
							: ({ _tag: "Deny" } as const),
					);
					log("decide.pending_removed", {
						requestId: input.command.requestId,
						sessionId: entry.request.sessionId,
						decision: decision._tag,
						projectId: entry.projectId,
					});
				}),
			{
				name: "permission-lifecycle",
				react: (record) => {
					if (record.event._tag === "PermissionRequested") {
						return Effect.succeed([
							{
								streamId: record.streamId,
								command: {
									_tag: "PublishPermission" as const,
									requestId: record.event.requestId,
								},
							},
						]);
					}
					if (record.event._tag === "PermissionExpired")
						return Effect.succeed([
							{
								streamId: record.streamId,
								command: {
									_tag: "ExpirePermission" as const,
									requestId: record.event.requestId,
								},
							},
						]);

					if (record.event._tag === "PermissionResolved") {
						return Effect.succeed([
							{
								streamId: record.streamId,
								command: {
									_tag: "CompletePermission" as const,
									requestId: record.event.requestId,
									decisionJson:
										record.event.decisionJson ??
										JSON.stringify({ _tag: record.event.decision }),
								},
							},
						]);
					}
					return Effect.succeed([]);
				},
			},
		);
		const permissionReactorLock = yield* Semaphore.make(1);
		const runPermissionReactor = permissionReactorLock.withPermits(1)(
			permissionReactor.catchUp().pipe(Effect.asVoid, Effect.orDie),
		);

		const expireRequest = (entry: PendingEntry) =>
			sessionDomain
				.dispatch({
					commandId: `permission:expire:${entry.request.id}`,
					streamId: entry.request.sessionId,
					command: {
						_tag: "ExpirePermission",
						requestId: entry.request.id,
						expiredAt: Date.now(),
					},
				})
				.pipe(
					Effect.catchTag("SessionDeletedConflict", () =>
						removePendingRequest(entry.request.id).pipe(
							Effect.andThen(
								Deferred.succeed(entry.deferred, { _tag: "Deny" }),
							),
						),
					),
					Effect.andThen(runPermissionReactor),
					Effect.orDie,
				);
		const refreshAnswerability = Effect.gen(function* () {
			const entries = [...(yield* Ref.get(pending)).values()];
			if (entries.length === 0) return;
			const liveSessions = yield* sql<{
				id: string;
			}>`SELECT id FROM sessions WHERE id IN ${sql.in([...new Set(entries.map((entry) => entry.request.sessionId))])}`.pipe(
				Effect.orDie,
			);
			const existing = new Set(liveSessions.map((session) => session.id));
			for (const entry of entries) {
				if (!existing.has(entry.request.sessionId)) {
					yield* removePendingRequest(entry.request.id);
					yield* Deferred.succeed(entry.deferred, { _tag: "Deny" });
					continue;
				}
				if (
					entry.request.recoveryState !== "expired" &&
					!(yield* ownsRequest(entry.request.sessionId, entry.authority))
				)
					yield* expireRequest(entry);
			}
		});

		const unresolved = yield* sql<PendingRequestRow>`
      SELECT json_extract(requested.payload_json, '$.payloadJson') AS request_json,
             sessions.project_id,
             CASE WHEN active_turn.id IS NOT NULL AND (
               json_extract(requested.payload_json, '$.turnId') = active_turn.id
               OR (
                 json_extract(requested.payload_json, '$.turnId') =
                   json_extract(requested.payload_json, '$.requestId')
                 AND NOT EXISTS (
                   SELECT 1 FROM events AS later
                   WHERE later.stream_kind = 'session' AND later.stream_id = requested.stream_id
                     AND later.type = 'TurnStarted' AND later.sequence > requested.sequence
                 )
               )
             ) THEN active_turn.id ELSE NULL END AS abandoned_turn_id
      FROM events AS requested
      JOIN sessions ON sessions.id = requested.stream_id
      LEFT JOIN session_turns AS active_turn ON active_turn.session_id = sessions.id
        AND active_turn.status IN ('starting', 'running')
      WHERE requested.stream_kind = 'session'
        AND requested.type = 'PermissionRequested'
        AND json_valid(requested.payload_json)
        AND NOT EXISTS (
          SELECT 1 FROM events AS resolved
          WHERE resolved.stream_kind = 'session'
            AND resolved.stream_id = requested.stream_id
            AND resolved.type = 'PermissionResolved'
            AND json_extract(resolved.payload_json, '$.requestId') =
                json_extract(requested.payload_json, '$.requestId')
        )
      ORDER BY requested.sequence
    `;
		for (const row of unresolved) {
			const recovered = yield* decodePermissionRequest(row.request_json).pipe(
				Effect.orDie,
			);
			const deferred = yield* Deferred.make<PermissionDecision>();
			yield* Ref.update(pending, (current) => {
				const next = new Map(current);
				next.set(recovered.id, {
					request: PermissionRequest.make({
						...recovered,
						recoveryState: "expired",
					}),
					deferred,
					projectId: row.project_id as FolderId,
				});
				return next;
			});
			yield* sessionDomain
				.dispatch({
					commandId: `permission:expire:${recovered.id}`,
					streamId: recovered.sessionId,
					command: {
						_tag: "ExpirePermission",
						requestId: recovered.id,
						expiredAt: Date.now(),
					},
				})
				.pipe(Effect.orDie);
			log("request.recovered", {
				requestId: recovered.id,
				sessionId: recovered.sessionId,
				projectId: row.project_id,
			});
			if (row.abandoned_turn_id !== null) {
				yield* sessionDomain
					.dispatch({
						commandId: `permission:expired-turn:${recovered.sessionId}:${row.abandoned_turn_id}`,
						streamId: recovered.sessionId,
						command: {
							_tag: "SettleTurn",
							turnId: row.abandoned_turn_id,
							outcome: "interrupted",
							settledAt: Date.now(),
						},
					})
					.pipe(Effect.orDie);
			}
		}
		yield* runPermissionReactor;

		yield* Effect.forever(
			Effect.sleep("1 second").pipe(
				Effect.andThen(refreshAnswerability),
				Effect.catchCause(() =>
					Effect.logError(
						"[PermissionService] approval answerability refresh failed",
					),
				),
			),
		).pipe(Effect.forkScoped);

		const request: PermissionServiceShape["request"] = (
			sessionId,
			kind,
			options,
		) =>
			Effect.gen(function* () {
				if (!(yield* ownsRequest(sessionId, options)))
					return { _tag: "Deny" } as const;
				if (options.forcePrompt !== true) {
					const allowed = yield* findExistingAllow(
						sessionId,
						options.projectId,
						kind,
					);
					if (allowed) {
						if (!(yield* ownsRequest(sessionId, options)))
							return { _tag: "Deny" } as const;
						log("request.auto_allowed", {
							sessionId,
							projectId: options.projectId,
							kindTag: kind._tag,
							kindKey: kindKey(kind),
						});
						return { _tag: "AllowOnce" } as PermissionDecision;
					}
				}

				const id = nextRequestId();
				const req = PermissionRequest.make({
					id,
					sessionId,
					kind,
					requestedAt: new Date(),
					forcePrompt: options.forcePrompt === true,
				});
				const deferred = yield* Deferred.make<PermissionDecision>();
				const [owner] = yield* sql<{ readonly current_turn_id: string | null }>`
					SELECT id AS current_turn_id FROM session_turns WHERE session_id = ${sessionId} AND status IN ('starting', 'running')
				`.pipe(Effect.orDie);

				const admitted = yield* permissionReactorLock
					.withPermits(1)(
						Effect.gen(function* () {
							const committed = yield* sessionDomain
								.dispatch({
									commandId: `permission:request:${id}`,
									expectedProviderSessionId: options.owner?.providerSessionId,
									expectedAttempt:
										options.owner?.attempt === undefined
											? undefined
											: {
													...options.owner.attempt,
													requireUninterrupted: true,
												},
									streamId: sessionId,
									command: {
										_tag: "RequestPermission",
										inputOwner: options?.owner,
										requestId: id,
										turnId:
											options.owner?.attempt?.turnId ??
											owner?.current_turn_id ??
											id,
										payloadJson: JSON.stringify(req),
										requestedAt: req.requestedAt.getTime(),
									},
								})
								.pipe(
									Effect.as(true),
									Effect.catchTag(
										[
											"AttemptOwnershipConflict",
											"ProviderSessionOwnershipConflict",
										],
										() => Effect.succeed(false),
									),
									Effect.orDie,
								);
							if (!committed) return false;

							yield* Ref.update(pending, (m) => {
								const next = new Map(m);
								next.set(id, {
									request: req,
									deferred,
									projectId: options.projectId,
									authority: options,
								});
								log("request.pending_added", {
									requestId: id,
									sessionId,
									projectId: options.projectId,
									kindTag: kind._tag,
									kindKey: kindKey(kind),
									forcePrompt: req.forcePrompt,
									pendingCount: next.size,
								});
								return next;
							});
							yield* permissionReactor.catchUp().pipe(Effect.orDie);
							return true;
						}),
					)
					.pipe(Effect.uninterruptible);
				if (!admitted) return { _tag: "Deny" } as const;

				const decision = yield* Deferred.await(deferred);
				log("request.resolved", {
					requestId: id,
					sessionId,
					decision: decision._tag,
				});
				return (yield* ownsRequest(sessionId, options))
					? decision
					: ({ _tag: "Deny" } as const);
			});

		const decide: PermissionServiceShape["decide"] = (requestId, decision) =>
			Effect.gen(function* () {
				yield* refreshAnswerability;
				const map = yield* Ref.get(pending);
				const entry = map.get(requestId);
				if (entry === undefined) {
					const decided = yield* sql<{ readonly request_id: string }>`
						SELECT request_id FROM permission_decisions
						WHERE request_id = ${requestId}
						LIMIT 1
					`.pipe(Effect.orDie);
					if (decided.length > 0) {
						log("decide.replayed", {
							requestId,
							decision: decision._tag,
						});
						return;
					}
					log("decide.not_found", {
						requestId,
						decision: decision._tag,
						pendingCount: map.size,
					});
					return yield* Effect.fail(
						new PermissionRequestNotFoundError({ requestId }),
					);
				}
				if (
					entry.request.recoveryState === "expired" &&
					decision._tag !== "Deny"
				) {
					return yield* Effect.fail(
						new PermissionRequestExpiredError({ requestId }),
					);
				}
				yield* sessionDomain
					.dispatch({
						commandId: `permission:resolve:${requestId}`,
						expectedProviderSessionId:
							decision._tag === "Deny"
								? undefined
								: entry.authority?.owner?.providerSessionId,
						expectedAttempt:
							decision._tag === "Deny" ||
							entry.authority?.owner?.attempt === undefined
								? undefined
								: {
										...entry.authority.owner.attempt,
										requireUninterrupted: true,
									},
						streamId: entry.request.sessionId,
						command: {
							_tag: "ResolvePermission",
							requestId,
							decision: decision._tag,
							decisionJson: JSON.stringify(decision),
							resolvedAt: (yield* DateTime.nowAsDate).getTime(),
						},
					})
					.pipe(
						Effect.catchTag(
							["AttemptOwnershipConflict", "ProviderSessionOwnershipConflict"],
							() =>
								expireRequest(entry).pipe(
									Effect.andThen(
										Effect.fail(
											new PermissionRequestExpiredError({ requestId }),
										),
									),
								),
						),
						Effect.catchTag("PermissionNotPending", () =>
							Effect.fail(new PermissionRequestExpiredError({ requestId })),
						),
						Effect.catch((error) =>
							error._tag === "PermissionRequestExpiredError"
								? Effect.fail(error)
								: Effect.die(error),
						),
					);
				yield* runPermissionReactor;
			});

		const listPending: PermissionServiceShape["listPending"] = (sessionId) =>
			Effect.gen(function* () {
				yield* refreshAnswerability;
				const map = yield* Ref.get(pending);
				const out: PermissionRequest[] = [];
				for (const entry of map.values()) {
					if (entry.request.sessionId === sessionId) {
						out.push(entry.request);
					}
				}
				log("list_pending", {
					sessionId,
					count: out.length,
					requestIds: out.map((req) => req.id),
				});
				return out;
			});

		const requests: PermissionServiceShape["requests"] = () =>
			Stream.unwrap(
				Effect.gen(function* () {
					const dequeue = yield* PubSub.subscribe(pubsub);
					yield* refreshAnswerability;
					const map = yield* Ref.get(pending);
					const current = Array.from(map.values()).map(
						(entry) => entry.request,
					);
					log("stream.subscribe", {
						replayCount: current.length,
						requestIds: current.map((req) => req.id),
					});
					return Stream.concat(
						Stream.succeed({ _tag: "snapshot" as const, requests: current }),
						Stream.fromSubscription(dequeue),
					);
				}),
			);

		const listDecisions: PermissionServiceShape["listDecisions"] = (filter) =>
			Effect.gen(function* () {
				const rows = yield* (
					filter.projectId !== undefined
						? sql<DecisionRow>`
              SELECT request_id, session_id, project_id, kind_tag, kind_key,
                     kind_json, decision, scope, decided_at
              FROM permission_decisions
              WHERE project_id = ${filter.projectId}
              ORDER BY decided_at DESC
            `
						: sql<DecisionRow>`
              SELECT request_id, session_id, project_id, kind_tag, kind_key,
                     kind_json, decision, scope, decided_at
              FROM permission_decisions
              ORDER BY decided_at DESC
            `
				).pipe(Effect.catch(() => Effect.succeed([] as DecisionRow[])));
				const out: SavedDecision[] = [];
				for (const row of rows) {
					out.push(yield* rowToSavedDecision(row));
				}
				return out;
			});

		const revokeDecision: PermissionServiceShape["revokeDecision"] = (
			requestId,
		) =>
			sql`
        DELETE FROM permission_decisions WHERE request_id = ${requestId}
      `.pipe(
				Effect.asVoid,
				Effect.catch((cause) =>
					Effect.logWarning(
						`[PermissionService] revoke failed: ${String(cause)}`,
					),
				),
			);

		return {
			request,
			decide,
			listPending,
			requests,
			listDecisions,
			revokeDecision,
		} as const;
	}),
);
