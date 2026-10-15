import type {
	AcpCatalogEntry,
	AcpDefinition,
	AcpProviderId,
} from "@zuse/contracts";
import "@zuse/i18n/english/settings";
import { message } from "@zuse/i18n";
import { Effect } from "effect";
import { toastManager } from "../components/ui/toast.tsx";
import { formatError } from "../lib/format-error.ts";
import { providerDisplayName } from "../lib/provider-labels.ts";
import { refreshProviderMetadata } from "../lib/refresh-provider-metadata.ts";
import type { MemoizeClient } from "../lib/rpc-client.ts";
import { runtimeOperationClient } from "../lib/runtime-operation-client.ts";
import { StreamOperationOwner } from "../lib/stream-operation.ts";
import { createAtomStore } from "../state/atom-store.ts";

interface HostAgents {
	authUrl?: string | null;
	terminal?: Extract<
		typeof import("@zuse/contracts").AcpAuthenticationEvent.Type,
		{ _tag: "terminal" }
	>;
	definitions: readonly AcpDefinition[];
	catalog: readonly AcpCatalogEntry[];
	catalogLoading: boolean;

	testing: readonly AcpProviderId[];
	busy: string | null;
	signingIn: boolean;
	error: string | null;
}
export const EMPTY_ACP_HOST: HostAgents = {
	definitions: [],
	catalog: [],
	catalogLoading: false,
	testing: [],
	busy: null,
	signingIn: false,
	error: null,
};
export const useAcpAgentsStore = createAtomStore<{
	hosts: Record<string, HostAgents>;
}>(() => ({ hosts: {} }));
const update = (host: string, patch: Partial<HostAgents>) =>
	useAcpAgentsStore.setState((state) => ({
		hosts: {
			...state.hosts,
			[host]: { ...(state.hosts[host] ?? EMPTY_ACP_HOST), ...patch },
		},
	}));
export const loadAcpAgents = async (host: string) => {
	try {
		const client = await runtimeOperationClient(host);
		const definitions = await Effect.runPromise(client["provider.acp.list"]());
		update(host, { definitions });
	} catch (error) {
		update(host, { error: formatError(error) });
	}
};
/** Operations belong to the host store, not the settings component's lifetime. */
export const runAcpOperation = async <A>(
	host: string,
	label: string,
	operation: (client: MemoizeClient) => Effect.Effect<A, unknown>,
) => {
	if (useAcpAgentsStore.getState().hosts[host]?.busy) return;
	update(host, { busy: label, error: null });
	try {
		const client = await runtimeOperationClient(host);
		const result = await Effect.runPromise(operation(client));
		await loadAcpAgents(host);

		void refreshProviderMetadata(host);
		return result;
	} catch (error) {
		update(host, { error: formatError(error) });
	} finally {
		update(host, { busy: null });
	}
};
const hostState = (host: string) =>
	useAcpAgentsStore.getState().hosts[host] ?? EMPTY_ACP_HOST;

export const testAcpAgent = async (host: string, id: AcpProviderId) => {
	if (hostState(host).testing.includes(id)) return;
	update(host, { testing: [...hostState(host).testing, id], error: null });
	try {
		const client = await runtimeOperationClient(host);
		await Effect.runPromise(client["provider.acp.test"]({ id }));
		await loadAcpAgents(host);
		void refreshProviderMetadata(host);
	} catch (error) {
		update(host, { error: formatError(error) });
	} finally {
		update(host, {
			testing: hostState(host).testing.filter((item) => item !== id),
		});
	}
};

/** Read-only, so it does not take the host's operation lock. */
export const loadAcpCatalog = async (host: string) => {
	if (useAcpAgentsStore.getState().hosts[host]?.catalogLoading) return;
	update(host, { catalogLoading: true, error: null });
	try {
		const client = await runtimeOperationClient(host);
		const catalog = await Effect.runPromise(client["provider.acp.catalog"]());
		update(host, { catalog });
	} catch (error) {
		update(host, { error: formatError(error) });
	} finally {
		update(host, { catalogLoading: false });
	}
};

const signInOwners = new Map<string, StreamOperationOwner>();

/** Stops a pending sign-in; the server closes the agent process with the stream. */
export const cancelAcpSignIn = (host: string) => {
	signInOwners.get(host)?.cancel();
	signInOwners.delete(host);
	update(host, {
		terminal: undefined,
		authUrl: null,
		busy: null,
		signingIn: false,
	});
};

export const authenticateAcpAgent = async (
	host: string,
	id: AcpProviderId,
	methodId: string,
) => {
	if (useAcpAgentsStore.getState().hosts[host]?.busy) return;
	update(host, {
		busy: message("settings:acp_agents_sign_in_waiting"),
		signingIn: true,
		error: null,
		authUrl: null,
	});
	const owner = new StreamOperationOwner();
	signInOwners.set(host, owner);
	await owner.run(
		async () =>
			(await runtimeOperationClient(host))["provider.acp.authenticate"]({
				id,
				methodId,
			}),
		async (event) => {
			if (event._tag === "url") update(host, { authUrl: event.url });
			if (event._tag === "terminal") update(host, { terminal: event });
			if (event._tag === "done") {
				update(host, { terminal: undefined, authUrl: null });
				if (!event.ok)
					update(host, {
						error:
							event.reason ?? message("settings:acp_agents_sign_in_failed"),
					});
				await loadAcpAgents(host);
				void refreshProviderMetadata(host);
				if (event.ok) {
					toastManager.add({
						type: "success",
						title: message("settings:acp_agents_signed_in", {
							name: providerDisplayName(id),
						}),
						description: message("settings:acp_agents_close_browser_tab"),
					});
				}
			}
		},
		(error) => update(host, { error: formatError(error) }),
	);

	if (signInOwners.get(host) !== owner) return;
	signInOwners.delete(host);
	update(host, {
		busy: null,
		signingIn: false,
		terminal: undefined,
		authUrl: null,
	});
};
