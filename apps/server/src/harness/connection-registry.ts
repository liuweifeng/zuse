import type { ModelRegistration, ModelVault } from "./connection-types.ts";
export class ModelAuthError extends Error {
	constructor(readonly code: string) {
		super(`Model sign-in failed (${code}).`);
	}
}
export class ConnectionRegistry {
	constructor(protected readonly vault: ModelVault) {}
	protected readonly pending = new Map<string, () => void>();
	protected replacePending(id: string, cancel: () => void) {
		this.pending.get(id)?.();
		this.pending.set(id, cancel);
	}
	protected finishPending(id: string, cancel: () => void) {
		if (this.pending.get(id) === cancel) this.pending.delete(id);
	}
	close(): void {
		for (const cancel of this.pending.values()) cancel();
		this.pending.clear();
	}
	protected credentialWith(
		id: string,
		authorized: (value: ModelRegistration) => boolean,
		refresh: (
			value: ModelRegistration & { refreshToken: string },
		) => Promise<ModelRegistration>,
	): Promise<{ connectionId: string; accessToken: string }> {
		return this.vault.lock(id, async () => {
			const value = await this.vault.read(id);
			if (!value?.accessToken || !value.refreshToken || !authorized(value))
				throw new ModelAuthError("reauthorization_required");
			const now = Date.now();
			if ((value.earliestRefreshAt ?? 0) > now && (value.expiresAt ?? 0) <= now)
				throw new ModelAuthError("refresh_not_yet_available");
			if (
				(value.expiresAt ?? 0) > now + 60_000 ||
				(value.earliestRefreshAt ?? 0) > now
			)
				return { connectionId: id, accessToken: value.accessToken };
			const updated = await refresh({
				...value,
				refreshToken: value.refreshToken,
			});

			await this.vault.write(updated);
			if (!updated.accessToken || !authorized(updated))
				throw new ModelAuthError("reauthorization_required");
			return { connectionId: id, accessToken: updated.accessToken };
		});
	}
	protected async disconnectWith(
		id: string,
		revoke: (
			value: ModelRegistration & { refreshToken: string },
		) => Promise<boolean>,
	) {
		this.pending.get(id)?.();
		return this.vault.lock(id, async () => {
			const current = await this.vault.read(id);
			if (!current) return { revoked: true };
			const {
				accessToken: _access,
				refreshToken,
				idToken: _id,
				expiresAt: _expires,
				earliestRefreshAt: _earliest,
				...registration
			} = current;
			await this.vault.write({
				...registration,
				authorizationGeneration: (current.authorizationGeneration ?? 0) + 1,
			});
			if (!refreshToken) return { revoked: true };
			try {
				return { revoked: await revoke({ ...current, refreshToken }) };
			} catch {
				return { revoked: false };
			}
		});
	}

	async acknowledgePlan(id: string): Promise<void> {
		await this.vault.lock(id, async () => {
			const value = await this.vault.read(id);
			if (!value) throw new ModelAuthError("unknown_registration");
			await this.vault.write({ ...value, planNoticeSeen: true });
		});
	}

	async rename(id: string, name: string): Promise<void> {
		if (!name.trim() || name.length > 200)
			throw new ModelAuthError("invalid_name");
		await this.vault.lock(id, async () => {
			const value = await this.vault.read(id);
			if (!value) throw new ModelAuthError("unknown_registration");
			await this.vault.write({ ...value, name: name.trim() });
		});
	}
	async preferred(id: string): Promise<void> {
		await this.vault.lock("preferred", async () => {
			const connections = await this.vault.list();
			if (!connections.some((value) => value.id === id))
				throw new ModelAuthError("unknown_registration");
			for (const registration of connections)
				await this.vault.lock(registration.id, async () => {
					const current = await this.vault.read(registration.id);
					if (current)
						await this.vault.write({
							...current,
							preferred: current.id === id,
						});
				});
		});
	}
}

/** Shared bounded form transport; provider adapters validate their own token schemas. */
export function postOAuthForm(
	fetcher: typeof fetch,
	url: string,
	body: URLSearchParams,
	timeoutMs: number,
	signal?: AbortSignal,
) {
	return fetcher(url, {
		method: "POST",
		redirect: "error",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body,
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs),
	});
}
