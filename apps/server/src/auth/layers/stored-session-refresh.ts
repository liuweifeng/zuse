import { Effect } from "effect";

import { AuthTokenError, type SessionStoreError } from "../errors.ts";
import type { SessionStoreShape } from "../services/session-store.ts";
import { refreshSession, type SessionBundle } from "./workos.ts";

export interface StoredSessionRefreshOptions {
	readonly clientId: string;
	readonly seed: SessionBundle;
	readonly refreshSkewMs: number;
}

/**
 * The single cross-process refresh transaction for desktop and `zuse serve`.
 * WorkOS rotates refresh tokens on use, so every consumer must re-read under
 * the same file lock, persist the replacement before releasing it, and clear
 * state only when WorkOS returns the terminal `invalid_grant` code.
 */
export const refreshStoredSession = (
	store: SessionStoreShape,
	options: StoredSessionRefreshOptions,
): Effect.Effect<SessionBundle, AuthTokenError | SessionStoreError> =>
	store.withLock(
		Effect.gen(function* () {
			const current = yield* store.read();
			if (current === null) {
				return yield* Effect.fail(
					new AuthTokenError({
						reason: "Signed out during refresh.",
					}),
				);
			}
			if (current.refreshToken !== options.seed.refreshToken) return current;
			if (current.expiresAt - Date.now() > options.refreshSkewMs)
				return current;

			const attemptedRefreshToken = current.refreshToken;
			const refreshed = yield* refreshSession(
				options.clientId,
				attemptedRefreshToken,
			).pipe(Effect.result);
			if (refreshed._tag === "Success") {
				return yield* store.write(refreshed.success);
			}
			if (refreshed.failure.code !== "invalid_grant") {
				return yield* Effect.fail(refreshed.failure);
			}

			const winner = yield* store.read();
			if (winner !== null && winner.refreshToken !== attemptedRefreshToken) {
				return winner;
			}
			yield* store.clear();
			return yield* Effect.fail(refreshed.failure);
		}),
	);
