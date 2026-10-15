import { SessionAlreadyStartedError } from "@zuse/contracts";
import { Effect, Predicate, Schema } from "effect";

const engineOnlyMethods = new Set([
	"schedule.create",
	"schedule.list",
	"schedule.update",
	"schedule.delete",
	"schedule.trigger",
	"secrets.request",
	"secrets.list",
	"secrets.respond",
	"session.attempts.list",
	"session.checkpoints.list",
	"session.checkpoints.preview",
	"session.checkpoints.restore",
	"session.checkpoints.retry",
	"session.mergeBack",
	"session.contextLinks",
	"session.forkConstructions",
	"session.retryFork",
	"session.cancelFork",
	"session.wait",
	"session.sendAndWait",
]);

const postProtocolFiveMethods = new Set([
	"attachments.uploadChunk",
	"cloud.image.delete",
	"cloud.providerConnections.disconnect",
	"cloud.providerConnections.list",
	"cloud.providerConnections.save",
	"cloud.settings.get",
	"cloud.settings.update",
	"cloud.sharing.defaults.get",
	"cloud.sharing.defaults.update",
	"cloud.sharing.get",
	"cloud.sharing.update",
	"cloud.snapshot.import",
	"cloud.workspaces.update",
	"environments.remove",
	"machines.prepaidBalance",
	"machines.prepaidCheckout",
	"modelConnections.acknowledgePlan",
	"modelConnections.connect",
	"modelConnections.connections",
	"modelConnections.disconnect",
	"modelConnections.preferred",
	"modelConnections.rename",
	"organizations.capabilities",
	"organizations.create",
	"organizations.domainAdd",
	"organizations.domainRemove",
	"organizations.domainRestore",
	"organizations.domains",
	"organizations.get",
	"organizations.githubAuthorize",
	"organizations.githubConnection",
	"organizations.githubPolicy",
	"organizations.githubRestore",
	"organizations.githubSettings",
	"organizations.invite",
	"organizations.list",
	"organizations.removeMember",
	"organizations.revokeInvite",
	"organizations.setRole",
	"plugins.request",
	"provider.accounts.list",
	"provider.accounts.preferred",
	"provider.accounts.remove",
	"provider.accounts.save",
	"provider.acp.authenticate",
	"provider.acp.catalog",
	"provider.acp.duplicate",
	"provider.acp.install",
	"provider.acp.list",
	"provider.acp.remove",
	"provider.acp.save",
	"provider.acp.test",
	"skill.listGlobal",
	"skill.setEnabled",
]);

/** Capability table for methods absent from the supported historical contracts. */
export const supportsRuntimeRpc = (
	method: string,
	protocolVersion: number | undefined,
): boolean => {
	if (protocolVersion === undefined) return false;
	if (protocolVersion < 6 && postProtocolFiveMethods.has(method)) return false;
	return protocolVersion >= 7 || !engineOnlyMethods.has(method);
};

/** Legacy forks ignore commandId, so a lost reply cannot be retried safely. */
export const supportsIdempotentSessionFork = (
	protocolVersion: number | undefined,
): boolean => protocolVersion !== undefined && protocolVersion >= 7;

export class UnsupportedRuntimeFeatureError extends Error {
	readonly _tag = "UnsupportedRuntimeFeatureError";
	constructor(
		readonly method: string,
		readonly protocolVersion: number,
	) {
		super(
			"This feature needs a newer workspace runtime. You can continue using this chat without updating.",
		);
		this.name = "UnsupportedRuntimeFeatureError";
	}
}

/**
 * Guard missing RPCs before transmission: old servers cannot decode them and
 * otherwise leave the caller waiting for a reply. Supported methods retain the
 * original effect/stream and all transport cancellation semantics.
 */
export const withRuntimeRpcCompatibility = <Client extends object>(
	client: Client,
	protocolVersion: number,
): Client => {
	if (protocolVersion >= 7) return client;
	return new Proxy(client, {
		get(target, property, receiver) {
			const method = Reflect.get(target, property, receiver);
			if (typeof property !== "string" || typeof method !== "function")
				return method;
			return (...args: unknown[]) => {
				const input = args[0];
				const nativeChildFork =
					property === "session.fork" &&
					Predicate.isObject(input) &&
					input.nativeChildStepId !== undefined;
				if (!supportsRuntimeRpc(property, protocolVersion) || nativeChildFork) {
					return Effect.fail(
						new UnsupportedRuntimeFeatureError(property, protocolVersion),
					);
				}
				const result: unknown = Reflect.apply(method, target, args);
				if (property === "session.setProvider" && Effect.isEffect(result)) {
					return result.pipe(
						Effect.catch((error) =>
							Effect.fail(
								Schema.is(SessionAlreadyStartedError)(error)
									? new Error(
											"This runtime can change models within the current provider. Start a new chat or update the workspace runtime to switch providers.",
										)
									: error,
							),
						),
					);
				}
				return result;
			};
		},
	});
};
