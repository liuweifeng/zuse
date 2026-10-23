import type { SessionTimelineProjection } from "@zuse/contracts";
import type { ClientBus } from "./client-bus.ts";
import { makeResourceKey, type SessionRef } from "./resource-ref.ts";
import {
	deriveSessionPresentation,
	isSessionRuntimeBusy,
	type SessionRuntimeState,
} from "./session-presentation.ts";

/**
 * Keep only in-flight sessions live when their chat view is unmounted. Idle
 * transcripts remain cached; connect never wakes a sleeping remote runtime.
 */
export function retainSessionActivity<Client>(options: {
	bus: ClientBus<Client>;
	ref: SessionRef;
	catalogRuntime: () => SessionRuntimeState;
	subscribeCatalog: (listener: () => void) => () => void;
}): () => void {
	const key = makeResourceKey<SessionTimelineProjection>(
		"session-timeline",
		options.ref,
	);
	const lease = options.bus.retain(key, { activation: "cache-only" });
	let activation: "cache-only" | "connect" = "cache-only";
	let catalogRuntime = options.catalogRuntime();
	let catalogNeedsSync = isSessionRuntimeBusy(catalogRuntime);
	const reconcile = () => {
		const view = options.bus.snapshot(key);
		const presentation = deriveSessionPresentation({ view });
		const active =
			presentation.busy ||
			presentation.attention === "question" ||
			presentation.interactions.some(
				({ interaction }) =>
					interaction._tag === "Permission" &&
					interaction.request.recoveryState !== "expired",
			);

		if (view.sync === "live" && view.data !== null && !active)
			catalogNeedsSync = false;
		const next = active || catalogNeedsSync ? "connect" : "cache-only";
		if (next === activation) return;

		activation = next;
		lease.activate(next);
	};
	const unsubscribeView = options.bus.subscribe(key, reconcile);
	const unsubscribeCatalog = options.subscribeCatalog(() => {
		const next = options.catalogRuntime();
		if (next === catalogRuntime) return;
		catalogRuntime = next;
		catalogNeedsSync = isSessionRuntimeBusy(next);
		reconcile();
	});
	reconcile();
	return () => {
		unsubscribeView();
		unsubscribeCatalog();
		lease.release();
	};
}
