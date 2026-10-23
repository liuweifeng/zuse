import {
	ApiPaths,
	PublicUsageProfile,
	UsageProfileInput,
} from "@zuse/contracts";
import { validUsageProfileSnapshot } from "@zuse/utils/usage-profile";
import { Clock, Effect, Schema } from "effect";
import { requireWorkos } from "./auth.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { decodeBody, json } from "./http.ts";
import { ApiStore } from "./store.ts";

const privateJson = (body: unknown, status = 200) => {
	const response = json(body, status);
	response.headers.set("cache-control", "no-store");
	response.headers.set("x-robots-tag", "noindex");
	return response;
};

export const routeUsageProfileRequest = Effect.fn("routeUsageProfileRequest")(
	function* (request: Request) {
		const path = new URL(request.url).pathname;
		const publicMatch =
			/^\/v1\/public\/usage-profiles\/([a-z0-9-]{3,32})$/u.exec(path);
		if (path !== ApiPaths.usageProfile && !publicMatch) return null;
		const store = yield* ApiStore;
		if (publicMatch) {
			if (request.method !== "GET")
				return privateJson({ error: "usage_profile_not_found" }, 404);
			const profile = yield* store.findPublicUsageProfile(publicMatch[1] ?? "");
			if (!profile)
				return privateJson({ error: "usage_profile_not_found" }, 404);
			return privateJson(Schema.decodeUnknownSync(PublicUsageProfile)(profile));
		}
		const principal = yield* requireWorkos(request);
		const accountId = principal.accountId;
		if (request.method === "DELETE") {
			yield* store.unpublishUsageProfile(accountId);
		}
		if (request.method === "PUT") {
			const input = yield* decodeBody(UsageProfileInput, request, 64 * 1024);
			const now = yield* Clock.currentTimeMillis;
			if (!input.displayName.trim() || !validUsageProfileSnapshot(input, now))
				return yield* badRequest("invalid_usage_profile");
			const current = yield* store.getUsageProfile(accountId);
			const profile = {
				...input,
				displayName: input.displayName.trim(),
				publishedAt: current?.profile.publishedAt ?? now,
				updatedAt: now,
			};
			const saved = yield* store.saveUsageProfile({
				accountId,
				profile,
				published: true,
			});
			if (!saved) return yield* conflict("usage_profile_handle_unavailable");
		} else if (request.method !== "GET" && request.method !== "DELETE") {
			return yield* notFound("usage_profile_not_found");
		}
		const record = yield* store.getUsageProfile(accountId);
		return privateJson({
			profile: record?.profile ?? null,
			published: record?.published ?? false,
		});
	},
);
