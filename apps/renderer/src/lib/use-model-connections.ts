import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useAuth } from "../hooks/use-auth.ts";
import { ModelConnectionController } from "./model-connections.ts";
import { openExternal } from "./platform-capabilities.ts";
import { refreshProviderMetadata } from "./refresh-provider-metadata.ts";
import { runtimeOperationClient } from "./runtime-operation-client.ts";

const owners = new Map<
	string,
	{
		controller: ModelConnectionController;
		views: number;
		timer?: ReturnType<typeof setTimeout>;
		release: () => void;
	}
>();
function ownerFor(environmentId: string, accountId: string) {
	const key = JSON.stringify([environmentId, accountId]);
	const existing = owners.get(key);
	if (existing) return existing;
	const controller = new ModelConnectionController(
		() => runtimeOperationClient(environmentId),
		openExternal,
		() => refreshProviderMetadata(environmentId),
	);
	const owner = {
		controller,
		views: 0,
		timer: undefined as ReturnType<typeof setTimeout> | undefined,
		release: () => {},
	};
	const check = () => {
		if (owner.timer) clearTimeout(owner.timer);
		owner.timer = undefined;
		if (owner.views || controller.snapshot().busy) return;
		owner.timer = setTimeout(() => {
			unsubscribe();
			controller.dispose();
			owners.delete(key);
		}, 60_000);
	};
	const unsubscribe = controller.subscribe(check);
	owner.release = check;
	owners.set(key, owner);
	check();
	return owner;
}
export function useModelConnections(environmentId: string) {
	const { user } = useAuth();
	const accountId = user?.id ?? "signed-out";
	const owner = useMemo(
		() => ownerFor(environmentId, accountId),
		[environmentId, accountId],
	);
	const { controller } = owner;
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.snapshot,
		controller.snapshot,
	);
	useEffect(() => {
		owner.views++;
		if (owner.timer) clearTimeout(owner.timer);
		void controller.load(false);
		return () => {
			owner.views--;
			owner.release();
		};
	}, [controller, owner]);
	return { state, controller };
}
