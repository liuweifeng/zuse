import type { DurableObjectLocationHint } from "@cloudflare/workers-types";
import {
	CloudAuthProvider,
	ProviderGrantRefreshReason,
	SealedCodexGrant,
	SealedProviderGrant,
} from "@zuse/contracts";
import { measureCloudStage } from "@zuse/utils/cloud-timing";
import { Context, Effect, Schema } from "effect";
import { ApiError } from "./errors.ts";

export const AuthorityGrantRequest = Schema.Struct({
	accountId: Schema.String,
	workspaceId: Schema.String,
	runtimeGeneration: Schema.Number,
	providerId: CloudAuthProvider,
	bindProviderId: Schema.Boolean,
	recipientPublicJwk: Schema.String,
	recipientKeyThumbprint: Schema.String,
	requestId: Schema.String,
	reason: ProviderGrantRefreshReason,
	previousProviderAccountId: Schema.optional(Schema.String),
});
export type AuthorityGrantRequest = typeof AuthorityGrantRequest.Type;
export type AuthorityGrant = SealedCodexGrant | SealedProviderGrant;
export type AuthorityPreparation = "ready" | "absent" | "stale";

export interface CloudAccountExecutor {
	readonly startWorkspace?: (
		accountId: string,
		workspaceId: string,
	) => Effect.Effect<boolean | null, ApiError>;
	readonly grant: (
		input: AuthorityGrantRequest,
	) => Effect.Effect<AuthorityGrant | null, ApiError>;
	readonly prepare: (
		accountId: string,
	) => Effect.Effect<AuthorityPreparation | null, ApiError>;
}

/** Affinity is optional. SQL and the guest still own every credential fence. */
export const CloudAccountExecution = Context.Reference<
	CloudAccountExecutor | undefined
>("CloudAccountExecution", { defaultValue: () => undefined });

export const AuthorityOperation = Schema.Union([
	Schema.Struct({ op: Schema.Literal("grant"), input: AuthorityGrantRequest }),
	Schema.Struct({ op: Schema.Literal("prepare"), accountId: Schema.String }),
]);
export type AuthorityOperation = typeof AuthorityOperation.Type;
export const AccountOperation = Schema.Union([
	AuthorityOperation,
	Schema.Struct({
		op: Schema.Literal("start-workspace"),
		accountId: Schema.String,
		workspaceId: Schema.String,
	}),
]);
export type AccountOperation = typeof AccountOperation.Type;
const RemoteFailure = Schema.Struct({
	error: Schema.String,
	status: Schema.Number,
});
const Preparation = Schema.Literals(["ready", "absent", "stale"]);

export interface CloudAccountExecutorNamespace {
	readonly idFromName: (name: string) => unknown;
	readonly get: (
		id: unknown,
		options?: { locationHint?: DurableObjectLocationHint },
	) => {
		readonly fetch: (request: Request) => Promise<Response>;
	};
}

/** Only transport/protocol failures fall back; credential errors remain final. */
export const makeCloudAccountExecutor = (
	namespace: CloudAccountExecutorNamespace,
	locationHint?: DurableObjectLocationHint,
): CloudAccountExecutor => {
	const call = Effect.fn("cloudAccountExecutor.call")(function* <A>(
		accountId: string,
		operation: AccountOperation,
		decode: (value: unknown) => A,
	) {
		const received = yield* Effect.tryPromise(async (signal) => {
			const started = performance.now();

			const name =
				locationHint === undefined ? accountId : `${locationHint}:${accountId}`;
			const response = await namespace
				.get(namespace.idFromName(name), { locationHint })
				.fetch(
					new Request("https://cloud-account.internal/execute", {
						method: "POST",
						signal,
						body: JSON.stringify(operation),
					}),
				);
			if (operation.op !== "prepare") {
				const serverMs = Number(
					response.headers.get("x-zuse-executor-duration-ms"),
				);
				const roundTripMs = performance.now() - started;
				console.info("[cloud-timing]", {
					workspaceId:
						operation.op === "grant"
							? operation.input.workspaceId
							: operation.workspaceId,
					stage:
						operation.op === "grant"
							? "auth.executor-transport"
							: "startup.executor-transport",
					atMs: Date.now(),
					roundTripMs,
					...(Number.isFinite(serverMs) && serverMs > 0
						? { serverMs, overheadMs: Math.max(0, roundTripMs - serverMs) }
						: {}),
				});
			}
			if (response.status === 502)
				throw new Error("account executor unavailable");
			const body: unknown = await response.json();
			return response.ok
				? ({ value: decode(body) } as const)
				: ({ failure: Schema.decodeUnknownSync(RemoteFailure)(body) } as const);
		}).pipe(
			Effect.timeout(
				operation.op === "grant"
					? "2 seconds"
					: operation.op === "start-workspace"
						? "11 seconds"
						: "8 seconds",
			),
			Effect.catch(() => Effect.succeed(null)),
		);
		if (received === null) {
			console.info("[cloud-timing]", {
				...(operation.op === "grant"
					? { workspaceId: operation.input.workspaceId }
					: operation.op === "start-workspace"
						? { workspaceId: operation.workspaceId }
						: {}),
				stage:
					operation.op === "start-workspace"
						? "startup.executor-fallback"
						: "auth.executor-fallback",
				operation: operation.op,
				atMs: Date.now(),
			});
			return null;
		}
		if (received.failure !== undefined)
			return yield* Effect.fail(
				new ApiError({
					code: received.failure.error,
					status: received.failure.status,
				}),
			);
		return received.value;
	});
	return {
		startWorkspace: (accountId, workspaceId) =>
			call(
				accountId,
				{ op: "start-workspace", accountId, workspaceId },
				Schema.decodeUnknownSync(Schema.Boolean),
			).pipe(measureCloudStage({ workspaceId }, "startup.account-executor")),
		grant: (input) =>
			call(
				input.accountId,
				{ op: "grant", input },
				Schema.decodeUnknownSync(
					input.bindProviderId ? SealedProviderGrant : SealedCodexGrant,
				),
			).pipe(
				measureCloudStage({ workspaceId: input.workspaceId }, "auth.executor"),
			),
		prepare: (accountId) =>
			call(
				accountId,
				{ op: "prepare", accountId },
				Schema.decodeUnknownSync(Preparation),
			),
	};
};

/** No local credential state: eviction merely makes the provider cache cold. */
export class CloudAccountExecutorTask {
	constructor(
		private readonly execute: (
			operation: AccountOperation,
		) => Promise<Response>,
	) {}

	async fetch(request: Request): Promise<Response> {
		if (
			request.method !== "POST" ||
			new URL(request.url).pathname !== "/execute"
		)
			return new Response(null, { status: 404 });
		let operation: AccountOperation;
		try {
			operation = Schema.decodeUnknownSync(AccountOperation)(
				await request.json(),
			);
		} catch {
			return Response.json(
				{ error: "invalid_authority_operation", status: 400 },
				{ status: 400 },
			);
		}
		try {
			const started = performance.now();
			const response = await this.execute(operation);
			response.headers.set(
				"x-zuse-executor-duration-ms",
				String(performance.now() - started),
			);
			return response;
		} catch {
			return new Response(null, { status: 502 });
		}
	}
}
