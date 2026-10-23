import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import {
	makeResourceKey,
	type ResourceKey,
} from "@zuse/client-runtime/resource-ref";
import { emptyResourceView } from "@zuse/client-runtime/resource-state";
import {
	EnvironmentId,
	type Master,
	type MasterSnapshot,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useMemo } from "react";
import { isRpcClientTransportError, type MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";
import { useClientBusResource } from "./use-client-bus-resource.ts";

type MasterResourceData = MasterSnapshot | readonly Master[];
const makeMasterDriver = (): ResourceDriver<MemoizeClient, unknown> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	return {
		start(context) {
			const ref = context.key.ref;
			const source: Stream.Stream<MasterResourceData, unknown> =
				"masterId" in ref
					? context.client["masters.watch"]({ masterId: ref.masterId })
					: context.client["masters.directory"]({});
			const epoch = `masters:${crypto.randomUUID()}`;
			let version = 0;
			fiber = Effect.runFork(
				Stream.runForEach(source, (data) =>
					Effect.sync(() => {
						if (context.isCurrent())
							context.emit({
								data,
								cursor: { epoch, version: ++version },
								resetEpoch: context.cursor?.epoch !== epoch,
								sync: "live",
							});
					}),
				).pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							if (Cause.hasInterruptsOnly(cause) || !context.isCurrent())
								return;
							context.emit({ sync: "failed" });
							if (isRpcClientTransportError(Cause.squash(cause)))
								getRendererClientBus().reportConnectionFault(
									ref.environmentId,
									{ phase: "failed", message: String(Cause.squash(cause)) },
									context.generation,
								);
						}),
					),
				),
			);
		},
		stop() {
			const running = fiber;
			fiber = null;
			if (running) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};
for (const kind of ["master-summary", "masters-directory"] as const)
	registerRendererResourceDriver(kind, () => makeMasterDriver());
const EMPTY_MASTER = emptyResourceView<MasterSnapshot>();
const EMPTY_DIRECTORY = emptyResourceView<readonly Master[]>();
export const useMasterSnapshot = (
	environmentId: string,
	masterId: string | null,
) => {
	const key = useMemo<ResourceKey<MasterSnapshot> | null>(
		() =>
			masterId
				? makeResourceKey("master-summary", {
						environmentId: EnvironmentId.make(environmentId),
						masterId,
					})
				: null,
		[environmentId, masterId],
	);
	return useClientBusResource(key, EMPTY_MASTER, "connect");
};
export const useMasterDirectory = (environmentId: string) => {
	const key = useMemo<ResourceKey<readonly Master[]>>(
		() =>
			makeResourceKey("masters-directory", {
				environmentId: EnvironmentId.make(environmentId),
			}),
		[environmentId],
	);
	return useClientBusResource(key, EMPTY_DIRECTORY, "connect");
};
