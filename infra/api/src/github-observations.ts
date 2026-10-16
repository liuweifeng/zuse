import type { GitHubObservation, GitHubObserveRequest } from "@zuse/contracts";
import {
	credentialFingerprint,
	GitHubClient,
	GitHubFailure,
} from "@zuse/git/github-client";
import { emptyPr, GitHubObservations } from "@zuse/git/github-observations";
import { Effect } from "effect";
import { githubUserApiCredential } from "./cloud-github-user.ts";
import { badRequest, serviceUnavailable } from "./errors.ts";

// Store completed data only: worker requests must not share another request's I/O.
const snapshots = new Map<
	string,
	{ value: GitHubObservation; expiresAt: number; bytes: number }
>();

/** Account-authenticated reads never need a sandbox, runtime ticket, or installation bot token. */
export const observeGithub = Effect.fn("observeGithub")(function* (
	accountId: string,
	ownerId: string,
	input: GitHubObserveRequest,
) {
	if (input.target.host !== "github.com")
		return yield* badRequest("unsupported_github_host");
	const authorization = yield* githubUserApiCredential(
		accountId,
		`github.com/${input.target.owner}/${input.target.repo}`,
		ownerId,
	).pipe(Effect.result);
	if (authorization._tag === "Failure") {
		const code = authorization.failure.code;
		const kind =
			code === "github_user_repository_access_required"
				? "access"
				: code === "github_user_reconnect_required" ||
						code === "github_token_expiry_invalid"
					? "authentication"
					: "offline";
		return {
			pr: {
				...emptyPr(input.target.branch, kind),
				observationError:
					kind === "access"
						? "Your GitHub connection does not have access to this repository."
						: kind === "authentication"
							? "Reconnect GitHub in settings to restore access."
							: "GitHub access is temporarily unavailable. Retrying automatically.",
			},
			details: null,
		};
	}
	const credential = authorization.success;
	if (!credential)
		return {
			pr: {
				...emptyPr(input.target.branch, "authentication"),
				observationError: "Connect your GitHub account in settings.",
			},
			details: null,
		};
	// Reauthorize before cache lookup; never reuse another user's permissions.
	const key = JSON.stringify([
		accountId,
		ownerId,
		credentialFingerprint("github.com", credential.token),
		input.target,
		input.details ?? false,
	]);
	const previous = snapshots.get(key);
	if (!input.force && previous && previous.expiresAt > Date.now())
		return previous.value;
	for (const [id, entry] of snapshots)
		if (entry.expiresAt <= Date.now()) snapshots.delete(id);
	const client = new GitHubClient({
		resolveCredential: async () => ({
			token: credential.token,
			expiresAt: credential.expiresAtMs,
		}),
	});
	const reader = new GitHubObservations(client);
	const result = yield* Effect.tryPromise({
		try: (signal) =>
			reader.observe(
				input.target,
				{ ...input.target, cwd: "" },
				signal,
				input.details,
				input.force,
			),
		catch: (error) =>
			serviceUnavailable(
				error instanceof GitHubFailure
					? `github_${error.kind}`
					: "github_unavailable",
			),
	}).pipe(Effect.ensuring(Effect.sync(() => client.close())));
	if (!result.pr.stale) {
		const bytes = JSON.stringify(result).length * 2;
		if (bytes <= 512_000) {
			let retained = [...snapshots.values()].reduce(
				(total, item) => total + item.bytes,
				0,
			);
			while (snapshots.size >= 256 || retained + bytes > 8_000_000) {
				const oldest = snapshots.keys().next().value;
				if (oldest === undefined) break;
				retained -= snapshots.get(oldest)?.bytes ?? 0;
				snapshots.delete(oldest);
			}
			snapshots.set(key, {
				value: result,
				expiresAt: Date.now() + 15_000,
				bytes,
			});
		}
	}

	return result;
});
