import type { NativeAccountProvider, ProviderAccount } from "@zuse/contracts";
import { Effect } from "effect";
import { useCallback, useEffect } from "react";

import { createAtomStore } from "../state/atom-store.ts";
import { formatError } from "./format-error.ts";
import { refreshProviderMetadata } from "./refresh-provider-metadata.ts";
import { runRuntimeOperation } from "./runtime-operation-client.ts";

export const isNativeAccountProvider = (
	providerId: string,
): providerId is NativeAccountProvider =>
	providerId === "claude" || providerId === "codex";

export type ProviderAccountsSnapshot = {
	readonly loaded: boolean;
	readonly available: boolean;
	readonly accounts: readonly ProviderAccount[];
	/** The chat's bound account (null = default login); undefined when unknown or unbound. */
	readonly sessionAccountId?: string | null;
	readonly error: string | null;
};

const EMPTY: ProviderAccountsSnapshot = {
	loaded: false,
	available: false,
	accounts: [],
	error: null,
};

const store = createAtomStore<{
	byKey: Record<string, ProviderAccountsSnapshot>;
}>(() => ({ byKey: {} }));

const keyFor = (
	environmentId: string,
	providerId: NativeAccountProvider,
	sessionId?: string,
) => JSON.stringify([environmentId, providerId, sessionId ?? null]);

const patch = (key: string, next: Partial<ProviderAccountsSnapshot>) =>
	store.setState((state) => ({
		byKey: {
			...state.byKey,
			[key]: { ...(state.byKey[key] ?? EMPTY), ...next },
		},
	}));

const load = async (
	environmentId: string,
	providerId: NativeAccountProvider,
	sessionId?: string,
) => {
	const key = keyFor(environmentId, providerId, sessionId);
	try {
		const result = await runRuntimeOperation(environmentId, (client) =>
			client["provider.accounts.list"]({
				providerId,
				...(sessionId === undefined ? {} : { sessionId }),
			}),
		);
		patch(key, {
			loaded: true,
			available: result.available,
			accounts: result.accounts,
			sessionAccountId: result.sessionAccountId,
			error: null,
		});
	} catch (cause) {
		patch(key, { loaded: true, error: formatError(cause) });
	}
};

/** Refresh every loaded view of this computer's accounts for one provider. */
const reloadProvider = (
	environmentId: string,
	providerId: NativeAccountProvider,
) =>
	Promise.all(
		Object.keys(store.getState().byKey).flatMap((key) => {
			const [env, provider, sessionId] = JSON.parse(key) as [
				string,
				string,
				string | null,
			];
			return env === environmentId && provider === providerId
				? [load(environmentId, providerId, sessionId ?? undefined)]
				: [];
		}),
	);

/**
 * Accounts for one provider on one computer, shared by Settings and the
 * composer. Pass `sessionId` to also learn which account that chat uses.
 */
export function useProviderAccounts(
	environmentId: string,
	providerId: NativeAccountProvider,
	options?: { readonly sessionId?: string; readonly enabled?: boolean },
) {
	const sessionId = options?.sessionId;
	const enabled = options?.enabled ?? true;
	const key = keyFor(environmentId, providerId, sessionId);
	const snapshot = store((state) => state.byKey[key] ?? EMPTY);
	const reload = useCallback(
		() => load(environmentId, providerId, sessionId),
		[environmentId, providerId, sessionId],
	);
	useEffect(() => {
		if (enabled) void reload();
	}, [enabled, reload]);
	return { ...snapshot, reload };
}

export type ProviderAccountOperation =
	| { readonly kind: "save"; readonly name: string; readonly id?: string }
	| { readonly kind: "preferred"; readonly id: string | null }
	| { readonly kind: "remove"; readonly id: string }
	| {
			readonly kind: "switchSession";
			readonly sessionId: string;
			readonly id: string | null;
	  };

/**
 * Run one account change and refresh the account lists. Only changes that
 * alter which login the provider probes (default selection, removal) refresh
 * provider metadata, and that refresh runs in the background: it can spawn
 * every CLI and must never hold the account UI.
 */
export async function runProviderAccountOperation(
	environmentId: string,
	providerId: NativeAccountProvider,
	operation: ProviderAccountOperation,
): Promise<ProviderAccount | null> {
	const saved = await runRuntimeOperation(
		environmentId,
		(client): Effect.Effect<ProviderAccount | null, unknown> => {
			switch (operation.kind) {
				case "save":
					return client["provider.accounts.save"]({
						providerId,
						name: operation.name,
						...(operation.id === undefined ? {} : { id: operation.id }),
					});
				case "preferred":
					return client["provider.accounts.preferred"]({
						providerId,
						id: operation.id,
					}).pipe(Effect.as(null));
				case "remove":
					return client["provider.accounts.remove"]({
						providerId,
						id: operation.id,
					}).pipe(Effect.as(null));
				case "switchSession":
					return client["provider.accounts.switchSession"]({
						providerId,
						sessionId: operation.sessionId,
						id: operation.id,
					}).pipe(Effect.as(null));
			}
		},
	);
	await reloadProvider(environmentId, providerId);
	if (operation.kind === "preferred" || operation.kind === "remove")
		void refreshProviderMetadata(environmentId);
	return saved;
}

/** Next unused "Account N" label, so adding an account needs no typing. */
export const suggestAccountName = (
	accounts: readonly ProviderAccount[],
	template: (index: number) => string,
): string => {
	const taken = new Set(accounts.map((account) => account.name.trim()));
	for (let index = accounts.length + 2; ; index += 1) {
		const name = template(index);
		if (!taken.has(name)) return name;
	}
};
