import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import type { ResourceActivation } from "@zuse/client-runtime/environment-runtime";
import {
	type EnvironmentRef,
	makeResourceKey,
	type ResourceKey,
} from "@zuse/client-runtime/resource-ref";
import {
	emptyResourceView,
	type ResourceView,
} from "@zuse/client-runtime/resource-state";
import type { ResolvedModelCatalog } from "@zuse/contracts";
import { Cause, Duration, Effect, Fiber, Schedule, Stream } from "effect";
import { useMemo } from "react";
import type { MemoizeClient } from "./rpc-client.ts";
import { registerRendererResourceDriver } from "./session-timeline-client-bus.ts";
import { useClientBusResource } from "./use-client-bus-resource.ts";

export type ModelCatalogStreamData = Readonly<{
	catalog: ResolvedModelCatalog;
}>;
type ModelCatalogStreamKey = ResourceKey<ModelCatalogStreamData>;

const RETRY_MAX_DELAY_MS = 30_000;

const keyFor = (ref: EnvironmentRef): ModelCatalogStreamKey =>
	makeResourceKey("model-catalog", ref);

const refFrom = (key: ResourceKey<unknown>): EnvironmentRef | null =>
	key.kind === "model-catalog"
		? { environmentId: key.ref.environmentId }
		: null;

const makeDriver = (): ResourceDriver<
	MemoizeClient,
	ModelCatalogStreamData
> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			const ref = refFrom(context.key);
			if (ref === null) return;
			active = true;
			const epoch = `model-catalog:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;

			const updates = context.client["model.catalog.stream"]({}).pipe(
				Stream.retry(
					Schedule.exponential("1 second").pipe(
						Schedule.modifyDelay(({ duration }) =>
							Effect.succeed(
								Duration.millis(
									Math.min(Duration.toMillis(duration), RETRY_MAX_DELAY_MS),
								),
							),
						),
					),
				),
			);
			const program = Stream.runForEach(updates, (catalog) =>
				Effect.sync(() => {
					if (!active || !context.isCurrent()) return;
					version += 1;
					context.emit({
						data: { catalog },
						cursor: { epoch, version },
						resetEpoch: version === 1,
						sync: "live",
					});
				}),
			).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (active && !Cause.hasInterruptsOnly(cause)) {
							context.emit({ sync: "failed" });
						}
					}),
				),
			);
			fiber = Effect.runFork(program);
		},
		stop: () => {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

registerRendererResourceDriver("model-catalog", (key) =>
	refFrom(key) === null
		? null
		: (makeDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const EMPTY = emptyResourceView<ModelCatalogStreamData>();

/**
 * Server-pushed resolved catalog for an environment: the current value on
 * subscribe, then every change (remote document fetched, live inventory
 * refreshed). Defaults to `sync` so it rides an existing connection without
 * waking paused compute.
 */
export const useModelCatalogStream = (
	ref: EnvironmentRef | null,
	activation: ResourceActivation = "sync",
): ResourceView<ModelCatalogStreamData> => {
	const key = useMemo(
		() => (ref === null ? null : keyFor(ref)),
		[ref?.environmentId],
	);
	return useClientBusResource(key, EMPTY, activation);
};
