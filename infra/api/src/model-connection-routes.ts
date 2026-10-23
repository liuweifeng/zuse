import { Clock, Effect, Option, Schema } from "effect";
import { requireEnvironmentCredential, requireWorkos } from "./auth.ts";
import { requireRuntime } from "./cloud-workspace-routes.ts";
import { badRequest, serviceUnavailable } from "./errors.ts";
import { decodeBody, json } from "./http.ts";
import { ModelConnectionStore } from "./model-connection-store.ts";

const Command = Schema.Struct({
	provider: Schema.Literals(["chatgpt", "supergrok"]),
	action: Schema.Literals(["acquire", "release", "read", "list", "write"]),
	token: Schema.String,
	kind: Schema.optional(Schema.Literals(["active", "pending"])),
	id: Schema.optional(Schema.String),
	value: Schema.optional(Schema.NullOr(Schema.String)),
});
/** Backend-only credential transport: no renderer RPC, no cache or token logging. */
export const routeModelConnectionRequest = (request: Request) =>
	Effect.gen(function* () {
		if (new URL(request.url).pathname !== "/v1/model-connections/storage")
			return null;
		if (request.method !== "POST")
			return yield* Effect.fail(badRequest("invalid_method"));

		if (request.headers.has("origin") || request.headers.has("sec-fetch-site"))
			return yield* Effect.fail(badRequest("backend_transport_required"));
		const environment = request.headers.get("x-zuse-environment-id");
		const workspaceId = request.headers.get("x-zuse-workspace-id");
		const principal = workspaceId
			? yield* requireRuntime(
					request,
					workspaceId,
					yield* Clock.currentTimeMillis,
				)
			: environment
				? yield* requireEnvironmentCredential(request, environment)
				: yield* requireWorkos(request);
		const storage = yield* Effect.serviceOption(ModelConnectionStore);
		if (Option.isNone(storage))
			return yield* Effect.fail(
				serviceUnavailable("connection_storage_unavailable"),
			);
		const body = yield* decodeBody(Command, request, 65536);
		if (
			!/^[a-zA-Z0-9-]{16,128}$/.test(body.token) ||
			(body.id !== undefined && (body.id.length > 256 || !body.id))
		)
			return yield* Effect.fail(badRequest("invalid_request"));
		if ((workspaceId || environment) && body.provider !== "supergrok")
			return yield* Effect.fail(badRequest("hosted_chatgpt_unavailable"));
		if (
			((body.action === "list" ||
				body.action === "read" ||
				body.action === "write") &&
				!body.kind) ||
			((body.action === "read" || body.action === "write") && !body.id) ||
			(body.action === "write" && body.value === undefined)
		)
			return yield* Effect.fail(badRequest("invalid_request"));
		const account = principal.accountId;
		const value = yield* Effect.tryPromise({
			try: async () => {
				const store = storage.value;
				switch (body.action) {
					case "acquire":
						return store.acquire(account, body.provider, body.token);
					case "release":
						await store.release(account, body.provider, body.token);
						return null;
					case "list":
						if (!body.kind) throw new Error();
						return store.list(account, body.provider, body.token, body.kind);
					case "read":
						if (!body.kind || !body.id) throw new Error();
						return store.read(
							account,
							body.provider,
							body.token,
							body.kind,
							body.id,
						);
					case "write":
						if (!body.kind || !body.id || body.value === undefined)
							throw new Error();
						await store.write(
							account,
							body.provider,
							body.token,
							body.kind,
							body.id,
							body.value,
						);
						return null;
				}
			},
			catch: () => serviceUnavailable("connection_storage_unavailable"),
		});
		const response = json({ value });
		response.headers.set("cache-control", "no-store");
		return response;
	});
